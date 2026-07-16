use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde_json::json;

use super::canon_event_store::write_canon_event;
use super::code_graph_connection::with_staged_code_graph_generation;
use super::product_model_store::write_product_model_projection;
use super::protocol_event_store::append_protocol_event;
use super::EngineProjectHandle;
use crate::contracts::PublishProjectStateRequest;
use crate::json::{decode, encode, napi_error, sqlite_error};

const SQLITE_BUSY_TIMEOUT_SECS: u64 = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ProjectPublicationRecord {
    pub(super) revision: u64,
    pub(super) active_code_graph_generation: String,
    pub(super) published_at: String,
}

pub(super) fn initialize_project_publication(
    connection: &Connection,
    active_code_graph_generation: &str,
) -> napi::Result<ProjectPublicationRecord> {
    connection
        .execute(
            "insert into project_publication(singleton, revision, active_code_graph_generation, published_at)
             values (1, 1, ?1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
            params![active_code_graph_generation],
        )
        .map_err(|error| sqlite_error("Could not initialize Project State publication", error))?;
    read_project_publication(connection)?.ok_or_else(|| {
        napi_error(
            "state-missing",
            "Project State publication was not initialized.",
        )
    })
}

pub(super) fn read_project_publication(
    connection: &Connection,
) -> napi::Result<Option<ProjectPublicationRecord>> {
    let row = connection
        .query_row(
            "select revision, active_code_graph_generation, published_at
             from project_publication where singleton = 1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| sqlite_error("Could not read Project State publication", error))?;
    row.map(|(revision, active_code_graph_generation, published_at)| {
        let revision = u64::try_from(revision).map_err(|_| {
            napi_error(
                "state-invalid",
                "Project State publication revision must be positive.",
            )
        })?;
        Ok(ProjectPublicationRecord {
            revision,
            active_code_graph_generation,
            published_at,
        })
    })
    .transpose()
}

pub(super) fn read_project_publication_at_path(
    state_path: &str,
) -> napi::Result<ProjectPublicationRecord> {
    let connection = Connection::open(state_path)
        .map_err(|error| sqlite_error("Could not open Project State publication", error))?;
    connection
        .busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECS))
        .map_err(|error| sqlite_error("Could not set Project State publication timeout", error))?;
    read_project_publication(&connection)?.ok_or_else(|| {
        napi_error(
            "state-missing",
            "Project State publication has not been initialized.",
        )
    })
}

pub(super) fn read_project_publication_json(project: &EngineProjectHandle) -> napi::Result<String> {
    let connection = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let publication = read_project_publication(&connection)?.ok_or_else(|| {
        napi_error(
            "state-missing",
            "Project State publication has not been initialized.",
        )
    })?;
    encode(&publication)
}

pub(super) fn publish_project_state_json(
    project: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    if project.state_path != project.code_graph_state_path {
        return Err(napi_error(
            "state-invalid",
            "Only the serving Project State owner can publish Project State.",
        ));
    }
    let request: PublishProjectStateRequest = decode(&request)?;
    if request.code_graph_generation.is_some() != request.product_model.is_some() {
        return Err(napi_error(
            "invalid-engine-payload",
            "A Project State publication must include both the code graph generation and product model, or neither.",
        ));
    }
    let event_revision = request
        .protocol_event
        .get("revision")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                "Project publication protocol event is missing revision.",
            )
        })?;
    if event_revision != request.revision {
        return Err(napi_error(
            "invalid-engine-payload",
            "Project publication revision must match its protocol event revision.",
        ));
    }
    let published_at = request
        .protocol_event
        .get("timestamp")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            napi_error(
                "invalid-engine-payload",
                "Project publication protocol event is missing timestamp.",
            )
        })?
        .to_string();
    match request.code_graph_generation.clone() {
        Some(generation) => with_staged_code_graph_generation(
            &project.code_graph_state_path,
            &generation,
            |next_graph| commit_project_state(project, request, published_at, Some(next_graph)),
        ),
        None => commit_project_state(project, request, published_at, None),
    }
}

fn commit_project_state(
    project: &EngineProjectHandle,
    request: PublishProjectStateRequest,
    published_at: String,
    next_graph: Option<rusqlite::Connection>,
) -> napi::Result<String> {
    let mut graph_guard = if next_graph.is_some() {
        Some(
            project
                .graph_conn
                .lock()
                .map_err(|_| napi_error("sqlite-error", "Code graph state lock is poisoned."))?,
        )
    } else {
        None
    };
    let mut connection = project
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| sqlite_error("Could not start Project State publication", error))?;
    let current = read_project_publication(&transaction)?.ok_or_else(|| {
        napi_error(
            "state-missing",
            "Project State publication has not been initialized.",
        )
    })?;
    if request.revision <= current.revision {
        return Err(napi_error(
            "state-invalid",
            &format!(
                "Project State publication revision must be greater than {}; received {}.",
                current.revision, request.revision
            ),
        ));
    }

    if let Some(product_model) = request.product_model.as_ref() {
        write_product_model_projection(&transaction, &project.root_dir, product_model)?;
    }
    if let Some(canon_event) = request.canon_event.as_ref() {
        write_canon_event(&transaction, canon_event)?;
    }
    let event = append_protocol_event(
        &transaction,
        request.protocol_event,
        request.max_protocol_event_count,
        &request.retain_protocol_events_after,
    )?;
    let active_code_graph_generation = request
        .code_graph_generation
        .unwrap_or(current.active_code_graph_generation);
    transaction
        .execute(
            "update project_publication
             set revision = ?1, active_code_graph_generation = ?2, published_at = ?3
             where singleton = 1",
            params![
                i64::try_from(request.revision).map_err(|_| {
                    napi_error(
                        "invalid-engine-payload",
                        "Project publication revision exceeds SQLite integer range.",
                    )
                })?,
                active_code_graph_generation,
                published_at
            ],
        )
        .map_err(|error| sqlite_error("Could not record Project State publication", error))?;
    transaction
        .commit()
        .map_err(|error| sqlite_error("Could not commit Project State publication", error))?;

    if let (Some(guard), Some(connection)) = (graph_guard.as_mut(), next_graph) {
        **guard = connection;
    }
    let publication = ProjectPublicationRecord {
        revision: request.revision,
        active_code_graph_generation,
        published_at,
    };
    encode(&json!({ "publication": publication, "event": event }))
}
