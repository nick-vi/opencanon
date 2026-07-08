use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::contracts::WriteProductModelProjectionRequest;
use crate::json::{decode, encode, napi_error, sqlite_error};

use super::json_fields::{
    json_array_field, json_int_field, json_object_field, json_optional_string_field,
    json_string_field, stable_projection_row_id,
};
use super::EngineProjectHandle;

pub(super) fn write_product_model_projection_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<()> {
    let request: WriteProductModelProjectionRequest = decode(&request)?;
    let projection = request.projection;
    let indexed_at = json_string_field(&projection, "indexedAt")?.to_string();
    let graph_hash = json_string_field(&projection, "graphHash")?.to_string();
    let definitions_hash = json_string_field(&projection, "definitionsHash")?.to_string();
    let counts = json_object_field(&projection, "counts")?;
    let definition_graph = json_object_field(&projection, "definitionGraph")?;
    let nodes = json_array_field(definition_graph, "nodes")?;
    let edges = json_array_field(definition_graph, "edges")?;
    let diagnostics = json_array_field(definition_graph, "diagnostics")?;
    let payload = serde_json::to_string(&projection)
        .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;

    let mut conn = handle
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let tx = conn
        .transaction()
        .map_err(|error| sqlite_error("Could not start product model transaction", error))?;
    tx.execute(
        "delete from product_model_snapshots where root_dir = ?1",
        params![handle.root_dir],
    )
    .map_err(|error| sqlite_error("Could not clear product model projection", error))?;
    tx.execute(
            "insert into product_model_snapshots(root_dir, graph_hash, definitions_hash,
               area_count, spec_count, change_count, convention_count, impact_surface_count, validator_count,
               node_count, edge_count, diagnostic_count, payload, indexed_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
            params![
                handle.root_dir,
                graph_hash,
                definitions_hash,
                json_int_field(counts, "areas")?,
                json_int_field(counts, "specs")?,
                json_int_field(counts, "changes")?,
                json_int_field(counts, "conventions")?,
                json_int_field(counts, "impactSurfaces")?,
                json_int_field(counts, "validators")?,
                json_int_field(counts, "nodes")?,
                json_int_field(counts, "edges")?,
                json_int_field(counts, "diagnostics")?,
                payload,
                indexed_at,
            ],
        )
        .map_err(|error| sqlite_error("Could not write product model projection", error))?;

    for node in nodes {
        let node_id = json_string_field(node, "id")?;
        let node_payload = serde_json::to_string(node)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        tx.execute(
            "insert into product_model_nodes(root_dir, id, kind, label, payload, indexed_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                handle.root_dir,
                node_id,
                json_string_field(node, "kind")?,
                json_string_field(node, "label")?,
                node_payload,
                indexed_at,
            ],
        )
        .map_err(|error| sqlite_error("Could not write product model node", error))?;
    }

    for edge in edges {
        let from = json_string_field(edge, "from")?;
        let to = json_string_field(edge, "to")?;
        let kind = json_string_field(edge, "kind")?;
        let label = json_optional_string_field(edge, "label");
        let edge_payload = serde_json::to_string(edge)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        let edge_id = stable_projection_row_id(&[from, kind, to, label.unwrap_or("")]);
        tx.execute(
                "insert into product_model_edges(root_dir, id, from_node_id, to_node_id, kind, label, payload, indexed_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![handle.root_dir, edge_id, from, to, kind, label, edge_payload, indexed_at],
            )
            .map_err(|error| sqlite_error("Could not write product model edge", error))?;
    }

    for diagnostic in diagnostics {
        let severity = json_string_field(diagnostic, "severity")?;
        let code = json_string_field(diagnostic, "code")?;
        let message = json_string_field(diagnostic, "message")?;
        let from = json_optional_string_field(diagnostic, "from");
        let to = json_optional_string_field(diagnostic, "to");
        let diagnostic_payload = serde_json::to_string(diagnostic)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        let diagnostic_id = stable_projection_row_id(&[
            severity,
            code,
            from.unwrap_or(""),
            to.unwrap_or(""),
            message,
        ]);
        tx.execute(
                "insert into product_model_diagnostics(root_dir, id, severity, code, from_node_id, to_node_id, message, payload, indexed_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    handle.root_dir,
                    diagnostic_id,
                    severity,
                    code,
                    from,
                    to,
                    message,
                    diagnostic_payload,
                    indexed_at,
                ],
            )
            .map_err(|error| sqlite_error("Could not write product model diagnostic", error))?;
    }

    tx.commit()
        .map_err(|error| sqlite_error("Could not commit product model transaction", error))?;
    Ok(())
}

pub(super) fn read_product_model_projection_json(
    handle: &EngineProjectHandle,
) -> napi::Result<String> {
    let conn = handle
        .conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Project state lock is poisoned."))?;
    let payload = conn
        .query_row(
            "select payload from product_model_snapshots where root_dir = ?1",
            params![handle.root_dir],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| sqlite_error("Could not read product model projection", error))?;
    let projection = match payload {
        Some(payload) => Some(
            serde_json::from_str::<Value>(&payload)
                .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?,
        ),
        None => None,
    };
    encode(&json!({ "projection": projection }))
}
