use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::Connection;

use crate::json::{napi_error, sqlite_error};

const CODE_GRAPH_SCHEMA_VERSION: i64 = 1;
const SQLITE_BUSY_TIMEOUT_SECS: u64 = 10;

pub(crate) fn code_graph_state_path(state_path: &str) -> PathBuf {
    Path::new(state_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("code-graph.sqlite")
}

pub(super) fn open_code_graph_connection(state_path: &str) -> napi::Result<Connection> {
    let graph_path = code_graph_state_path(state_path);
    if let Some(parent) = graph_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            napi_error(
                "state-path-unwritable",
                &format!("Could not create code graph state directory: {error}"),
            )
        })?;
    }
    let conn = configured_connection(&graph_path)?;
    let version = schema_version(&conn)?;
    let table_count: i64 = conn
        .query_row(
            "select count(*) from sqlite_master where type = 'table' and name not like 'sqlite_%'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| sqlite_error("Could not inspect code graph schema", error))?;
    if version == CODE_GRAPH_SCHEMA_VERSION {
        return Ok(conn);
    }
    if version == 0 && table_count == 0 {
        initialize_schema(&conn)?;
        return Ok(conn);
    }

    // Code graph state is a derived projection. Rebuild incompatible or
    // interrupted schemas instead of carrying migrations for disposable data.
    drop(conn);
    remove_database_files(&graph_path)?;
    let conn = configured_connection(&graph_path)?;
    initialize_schema(&conn)?;
    Ok(conn)
}

fn configured_connection(graph_path: &Path) -> napi::Result<Connection> {
    let conn = Connection::open(graph_path)
        .map_err(|error| sqlite_error("Could not open code graph database", error))?;
    conn.busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECS))
        .map_err(|error| sqlite_error("Could not set code graph busy timeout", error))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| sqlite_error("Could not enable code graph WAL mode", error))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| sqlite_error("Could not set code graph synchronous mode", error))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| sqlite_error("Could not enable code graph foreign keys", error))?;
    Ok(conn)
}

fn schema_version(conn: &Connection) -> napi::Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| sqlite_error("Could not read code graph schema version", error))
}

fn initialize_schema(conn: &Connection) -> napi::Result<()> {
    conn.execute_batch("create table files (path text primary key);")
        .map_err(|error| sqlite_error("Could not create code graph file inventory", error))?;
    conn.execute_batch(include_str!("../migrations/002_code_graph.sql"))
        .map_err(|error| sqlite_error("Could not create code graph schema", error))?;
    conn.pragma_update(None, "user_version", CODE_GRAPH_SCHEMA_VERSION)
        .map_err(|error| sqlite_error("Could not record code graph schema version", error))?;
    Ok(())
}

fn remove_database_files(graph_path: &Path) -> napi::Result<()> {
    for path in [
        graph_path.to_path_buf(),
        PathBuf::from(format!("{}-wal", graph_path.display())),
        PathBuf::from(format!("{}-shm", graph_path.display())),
    ] {
        match fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(napi_error(
                    "state-path-unwritable",
                    &format!(
                        "Could not replace derived code graph state {}: {error}",
                        path.display()
                    ),
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn incompatible_derived_schema_is_rebuilt() {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("opencanon-code-graph-schema-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        let state_path = root.join("state.sqlite");
        let graph_path = code_graph_state_path(state_path.to_str().unwrap());
        let conn = open_code_graph_connection(state_path.to_str().unwrap()).unwrap();
        conn.execute_batch("create table stale_projection(value text); pragma user_version = 99;")
            .unwrap();
        drop(conn);

        let rebuilt = open_code_graph_connection(state_path.to_str().unwrap()).unwrap();
        assert_eq!(schema_version(&rebuilt).unwrap(), CODE_GRAPH_SCHEMA_VERSION);
        let stale_exists: i64 = rebuilt
            .query_row(
                "select count(*) from sqlite_master where type = 'table' and name = 'stale_projection'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stale_exists, 0);
        assert!(graph_path.exists());
        drop(rebuilt);
        fs::remove_dir_all(root).unwrap();
    }
}
