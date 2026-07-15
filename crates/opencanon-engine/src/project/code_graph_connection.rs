use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;

use crate::json::{napi_error, sqlite_error};

const CODE_GRAPH_SCHEMA_VERSION: i64 = 1;
const SQLITE_BUSY_TIMEOUT_SECS: u64 = 10;
const ACTIVE_GENERATION_FILE: &str = "active";

pub(crate) fn code_graph_state_dir(state_path: &str) -> PathBuf {
    Path::new(state_path)
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("code-graph")
}

pub(super) fn open_code_graph_connection(state_path: &str) -> napi::Result<Connection> {
    let graph_dir = prepare_graph_dir(state_path)?;
    let generation = read_active_generation(&graph_dir)?.unwrap_or_else(new_initial_generation);
    let graph_path = generation_path(&graph_dir, &generation)?;
    let conn = open_or_initialize(&graph_path)?;
    write_active_generation(&graph_dir, &generation)?;
    cleanup_inactive_generations(&graph_dir, &generation)?;
    Ok(conn)
}

pub(super) fn open_staged_code_graph_connection(
    state_path: &str,
    generation: &str,
) -> napi::Result<Connection> {
    validate_generation(generation)?;
    let graph_dir = prepare_graph_dir(state_path)?;
    let active_generation =
        read_active_generation(&graph_dir)?.unwrap_or_else(new_initial_generation);
    let active_path = generation_path(&graph_dir, &active_generation)?;
    let active = open_or_initialize(&active_path)?;
    write_active_generation(&graph_dir, &active_generation)?;
    cleanup_inactive_generations(&graph_dir, &active_generation)?;

    let staged_path = generation_path(&graph_dir, generation)?;
    remove_database_files(&staged_path)?;
    active
        .backup("main", &staged_path, None)
        .map_err(|error| sqlite_error("Could not stage code graph generation", error))?;
    configured_connection(&staged_path)
}

pub(super) fn activate_code_graph_generation(
    state_path: &str,
    generation: &str,
) -> napi::Result<Connection> {
    validate_generation(generation)?;
    let graph_dir = prepare_graph_dir(state_path)?;
    let graph_path = generation_path(&graph_dir, generation)?;
    if !graph_path.is_file() {
        return Err(napi_error(
            "state-missing",
            &format!("Code graph generation {generation} does not exist."),
        ));
    }
    let conn = configured_connection(&graph_path)?;
    if schema_version(&conn)? != CODE_GRAPH_SCHEMA_VERSION {
        return Err(napi_error(
            "state-invalid",
            &format!("Code graph generation {generation} has an incompatible schema."),
        ));
    }
    write_active_generation(&graph_dir, generation)?;
    Ok(conn)
}

pub(super) fn cleanup_code_graph_generations(
    state_path: &str,
    active_generation: &str,
) -> napi::Result<()> {
    cleanup_inactive_generations(&code_graph_state_dir(state_path), active_generation)
}

fn prepare_graph_dir(state_path: &str) -> napi::Result<PathBuf> {
    let graph_dir = code_graph_state_dir(state_path);
    fs::create_dir_all(&graph_dir).map_err(|error| {
        napi_error(
            "state-path-unwritable",
            &format!("Could not create code graph state directory: {error}"),
        )
    })?;
    Ok(graph_dir)
}

fn generation_path(graph_dir: &Path, generation: &str) -> napi::Result<PathBuf> {
    validate_generation(generation)?;
    Ok(graph_dir.join(format!("{generation}.sqlite")))
}

fn validate_generation(generation: &str) -> napi::Result<()> {
    if !generation.is_empty()
        && generation
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Ok(());
    }
    Err(napi_error(
        "invalid-engine-payload",
        "Code graph generation must contain only ASCII letters, numbers, hyphens, or underscores.",
    ))
}

fn new_initial_generation() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("initial-{nanos}")
}

fn read_active_generation(graph_dir: &Path) -> napi::Result<Option<String>> {
    let pointer = graph_dir.join(ACTIVE_GENERATION_FILE);
    let value = match fs::read_to_string(&pointer) {
        Ok(value) => value.trim().to_string(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(napi_error(
                "state-unreadable",
                &format!("Could not read active code graph generation: {error}"),
            ));
        }
    };
    validate_generation(&value)?;
    Ok(Some(value))
}

fn write_active_generation(graph_dir: &Path, generation: &str) -> napi::Result<()> {
    let pointer = graph_dir.join(ACTIVE_GENERATION_FILE);
    let partial = graph_dir.join(format!(
        ".{ACTIVE_GENERATION_FILE}.{}.partial",
        std::process::id()
    ));
    fs::write(&partial, format!("{generation}\n")).map_err(|error| {
        napi_error(
            "state-path-unwritable",
            &format!("Could not write active code graph generation: {error}"),
        )
    })?;
    fs::rename(&partial, &pointer).map_err(|error| {
        napi_error(
            "state-path-unwritable",
            &format!("Could not activate code graph generation: {error}"),
        )
    })
}

fn open_or_initialize(graph_path: &Path) -> napi::Result<Connection> {
    let conn = configured_connection(graph_path)?;
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
    drop(conn);
    remove_database_files(graph_path)?;
    let conn = configured_connection(graph_path)?;
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

fn cleanup_inactive_generations(graph_dir: &Path, active_generation: &str) -> napi::Result<()> {
    let active_name = format!("{active_generation}.sqlite");
    let entries = fs::read_dir(graph_dir).map_err(|error| {
        napi_error(
            "state-unreadable",
            &format!("Could not inspect code graph generations: {error}"),
        )
    })?;
    for entry in entries {
        let entry = entry.map_err(|error| napi_error("state-unreadable", &error.to_string()))?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let is_database = name.ends_with(".sqlite")
            || name.ends_with(".sqlite-wal")
            || name.ends_with(".sqlite-shm");
        if !is_database || name.starts_with(&active_name) {
            continue;
        }
        match fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(napi_error(
                    "state-path-unwritable",
                    &format!("Could not remove inactive code graph generation: {error}"),
                ));
            }
        }
    }
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

    #[test]
    fn staged_generation_is_invisible_until_activation() {
        let root = std::env::temp_dir().join(format!(
            "opencanon-code-graph-generation-{}",
            new_initial_generation()
        ));
        fs::create_dir_all(&root).unwrap();
        let state_path = root.join("state.sqlite");
        let state = state_path.to_str().unwrap();
        let active = open_code_graph_connection(state).unwrap();
        active
            .execute("insert into files(path) values ('active.ts')", [])
            .unwrap();
        let staged = open_staged_code_graph_connection(state, "next").unwrap();
        staged
            .execute("insert into files(path) values ('next.ts')", [])
            .unwrap();
        drop(staged);
        assert_eq!(
            active
                .query_row("select count(*) from files", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(active);

        let activated = activate_code_graph_generation(state, "next").unwrap();
        assert_eq!(
            activated
                .query_row("select count(*) from files", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            2
        );
        drop(activated);
        fs::remove_dir_all(root).unwrap();
    }
}
