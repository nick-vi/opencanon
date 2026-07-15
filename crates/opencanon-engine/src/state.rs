use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::json::{napi_error, sqlite_error};

struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial",
        sql: include_str!("migrations/001_initial.sql"),
    },
    Migration {
        version: 2,
        name: "code_graph",
        sql: include_str!("migrations/002_code_graph.sql"),
    },
    Migration {
        version: 3,
        name: "product_model",
        sql: include_str!("migrations/003_product_model.sql"),
    },
    Migration {
        version: 4,
        name: "observability",
        sql: include_str!("migrations/004_observability.sql"),
    },
    Migration {
        version: 5,
        name: "knowledge_index",
        sql: include_str!("migrations/005_knowledge_index.sql"),
    },
    Migration {
        version: 6,
        name: "knowledge_hybrid",
        sql: include_str!("migrations/006_knowledge_hybrid.sql"),
    },
    Migration {
        version: 7,
        name: "knowledge_nodes",
        sql: include_str!("migrations/007_knowledge_nodes.sql"),
    },
    Migration {
        version: 8,
        name: "job_events",
        sql: include_str!("migrations/008_job_events.sql"),
    },
    Migration {
        version: 9,
        name: "canon_event_links",
        sql: include_str!("migrations/009_canon_event_links.sql"),
    },
    Migration {
        version: 10,
        name: "job_retention",
        sql: include_str!("migrations/010_job_retention.sql"),
    },
    Migration {
        version: 11,
        name: "change_check_executor",
        sql: include_str!("migrations/011_change_check_executor.sql"),
    },
    Migration {
        version: 12,
        name: "separate_code_graph",
        sql: include_str!("migrations/012_separate_code_graph.sql"),
    },
];

pub(crate) fn schema_version() -> u32 {
    MIGRATIONS
        .last()
        .map(|migration| migration.version)
        .unwrap_or(0)
}

pub(crate) fn migrate_state(conn: &Connection) -> napi::Result<Vec<u32>> {
    conn.execute_batch(
        "create table if not exists migrations (
          version integer primary key,
          name text not null,
          applied_at text not null
        );",
    )
    .map_err(|error| sqlite_error("Could not initialize migration table", error))?;
    let current_version: u32 = conn
        .query_row(
            "select coalesce(max(version), 0) from migrations",
            [],
            |row| row.get::<_, u32>(0),
        )
        .map_err(|error| sqlite_error("Could not read schema version", error))?;
    let supported_version = schema_version();
    if current_version > supported_version {
        return Err(napi_error(
            "sqlite-schema-mismatch",
            &format!(
                "Project state schema {current_version} is newer than this engine supports ({supported_version}). Run opencanon state reset --confirm to clear generated state or switch to a matching OpenCanon runtime."
            ),
        ));
    }

    let mut applied = Vec::new();
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| migration.version > current_version)
    {
        let tx = conn
            .unchecked_transaction()
            .map_err(|error| sqlite_error("Could not start migration transaction", error))?;
        tx.execute_batch(migration.sql)
            .map_err(|error| sqlite_error("Could not apply migration", error))?;
        tx.execute(
            "insert into migrations(version, name, applied_at) values (?1, ?2, ?3)",
            params![migration.version, migration.name, timestamp()],
        )
        .map_err(|error| sqlite_error("Could not record migration", error))?;
        tx.commit()
            .map_err(|error| sqlite_error("Could not commit migration", error))?;
        applied.push(migration.version);
    }
    repair_product_model_projection_schema(conn)?;
    repair_knowledge_index_schema(conn)?;
    Ok(applied)
}

fn repair_product_model_projection_schema(conn: &Connection) -> napi::Result<()> {
    if !table_exists(conn, "product_model_snapshots")? {
        return Ok(());
    }
    let columns = table_columns(conn, "product_model_snapshots")?;
    let has_current_shape = [
        "root_dir",
        "graph_hash",
        "definitions_hash",
        "area_count",
        "spec_count",
        "change_count",
        "convention_count",
        "impact_surface_count",
        "validator_count",
        "node_count",
        "edge_count",
        "diagnostic_count",
        "payload",
        "indexed_at",
    ]
    .iter()
    .all(|column| columns.contains(*column));
    if has_current_shape {
        return Ok(());
    }

    conn.execute_batch(
        "drop table if exists product_model_diagnostics;
         drop table if exists product_model_edges;
         drop table if exists product_model_nodes;
         drop table if exists product_model_snapshots;",
    )
    .map_err(|error| {
        sqlite_error(
            "Could not reset stale product model projection schema",
            error,
        )
    })?;
    conn.execute_batch(include_str!("migrations/003_product_model.sql"))
        .map_err(|error| {
            sqlite_error("Could not recreate product model projection schema", error)
        })?;
    Ok(())
}

fn repair_knowledge_index_schema(conn: &Connection) -> napi::Result<()> {
    if !table_exists(conn, "knowledge_snapshots")? {
        recreate_knowledge_index_schema(conn)?;
        return Ok(());
    }
    let snapshot_columns = table_columns(conn, "knowledge_snapshots")?;
    let chunk_columns = if table_exists(conn, "knowledge_chunks")? {
        table_columns(conn, "knowledge_chunks")?
    } else {
        std::collections::HashSet::new()
    };
    let has_current_shape = snapshot_columns.contains("chunk_tree_hash")
        && chunk_columns.contains("text")
        && table_exists(conn, "knowledge_chunks_fts")?
        && table_exists(conn, "knowledge_nodes")?;
    if !has_current_shape {
        recreate_knowledge_index_schema(conn)?;
        return Ok(());
    }

    let stale_payloads: i64 = conn
        .query_row(
            "select count(*) from knowledge_snapshots where json_extract(payload, '$.chunkTreeHash') is null",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("Could not inspect Project Knowledge payloads", error))?;
    if stale_payloads > 0 {
        clear_knowledge_index_state(conn, "Could not clear stale Project Knowledge state")?;
        return Ok(());
    }

    let unsupported_providers: i64 = conn
        .query_row(
            "select count(*) from knowledge_snapshots
             where coalesce(json_extract(payload, '$.provider.kind'), '') not in ('native', 'remote')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("Could not inspect Project Knowledge providers", error))?;
    if unsupported_providers > 0 {
        clear_knowledge_index_state(conn, "Could not clear unsupported Project Knowledge state")?;
    }
    Ok(())
}

fn recreate_knowledge_index_schema(conn: &Connection) -> napi::Result<()> {
    conn.execute_batch(
        "drop table if exists knowledge_nodes;
         drop table if exists knowledge_chunks_fts;
         drop table if exists knowledge_chunks;
         drop table if exists knowledge_snapshots;
         drop table if exists semantic_chunks_fts;
         drop table if exists semantic_chunks;
         drop table if exists semantic_index_snapshots;",
    )
    .map_err(|error| sqlite_error("Could not reset Project Knowledge schema", error))?;
    conn.execute_batch(include_str!("migrations/005_knowledge_index.sql"))
        .map_err(|error| sqlite_error("Could not recreate Project Knowledge schema", error))?;
    conn.execute_batch(include_str!("migrations/006_knowledge_hybrid.sql"))
        .map_err(|error| {
            sqlite_error("Could not recreate Project Knowledge hybrid schema", error)
        })?;
    conn.execute_batch(include_str!("migrations/007_knowledge_nodes.sql"))
        .map_err(|error| sqlite_error("Could not recreate Project Knowledge node schema", error))?;
    Ok(())
}

fn clear_knowledge_index_state(conn: &Connection, message: &str) -> napi::Result<()> {
    conn.execute_batch(
        "delete from knowledge_nodes;
         delete from knowledge_chunks_fts;
         delete from knowledge_chunks;
         delete from knowledge_snapshots;",
    )
    .map_err(|error| sqlite_error(message, error))?;
    Ok(())
}

fn table_exists(conn: &Connection, table: &str) -> napi::Result<bool> {
    conn.query_row(
        "select 1 from sqlite_master where type = 'table' and name = ?1",
        params![table],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(|error| sqlite_error("Could not inspect project state schema", error))
}

fn table_columns(
    conn: &Connection,
    table: &str,
) -> napi::Result<std::collections::HashSet<String>> {
    let mut statement = conn
        .prepare(&format!("pragma table_info({table})"))
        .map_err(|error| sqlite_error("Could not inspect project state columns", error))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| sqlite_error("Could not inspect project state columns", error))?;
    let mut columns = std::collections::HashSet::new();
    for row in rows {
        columns.insert(
            row.map_err(|error| sqlite_error("Could not decode project state column", error))?,
        );
    }
    Ok(columns)
}

pub(crate) fn read_existing_file_hashes(
    conn: &Connection,
) -> napi::Result<std::collections::HashMap<String, String>> {
    let mut statement = conn
        .prepare("select path, content_hash from files")
        .map_err(|error| sqlite_error("Could not prepare file state read", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| sqlite_error("Could not read file state", error))?;
    let mut output = std::collections::HashMap::new();
    for row in rows {
        let (path, hash) =
            row.map_err(|error| sqlite_error("Could not decode file state", error))?;
        output.insert(path, hash);
    }
    Ok(output)
}

pub(crate) fn mark_watch_state_stale(state_path: &str, root_dir: &str, reason: Option<&str>) {
    let Ok(conn) = Connection::open(state_path) else {
        return;
    };
    // Wait on a contended lock rather than failing immediately with SQLITE_BUSY (this
    // runs on the watcher thread alongside the main connection).
    let _ = conn.busy_timeout(std::time::Duration::from_secs(5));
    let existing_hash = conn
        .query_row(
            "select inventory_hash from watch_state where root_dir = ?1",
            params![root_dir],
            |row| row.get::<_, String>(0),
        )
        .unwrap_or_default();
    let _ = conn.execute(
        "insert into watch_state(root_dir, inventory_hash, stale, reason, updated_at) values (?1, ?2, 1, ?3, ?4)
         on conflict(root_dir) do update set stale = 1, reason = excluded.reason, updated_at = excluded.updated_at",
        params![root_dir, existing_hash, reason.unwrap_or("Watcher requires a full reindex."), timestamp()],
    );
}

pub(crate) fn read_watch_state_status(
    conn: &Connection,
    root_dir: &str,
) -> napi::Result<(bool, Option<String>)> {
    conn.query_row(
        "select stale, reason from watch_state where root_dir = ?1",
        params![root_dir],
        |row| Ok((row.get::<_, bool>(0)?, row.get::<_, Option<String>>(1)?)),
    )
    .optional()
    .map(|state| state.unwrap_or((false, None)))
    .map_err(|error| sqlite_error("Could not read watch state", error))
}

pub(crate) fn timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}
