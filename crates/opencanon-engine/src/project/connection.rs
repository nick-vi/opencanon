use std::thread;
use std::time::Duration;

use rusqlite::{params, Connection};

use crate::contracts::ResolvedProjectSettings;
use crate::json::{napi_error, sqlite_error};
use crate::state::migrate_state;

const SQLITE_OPEN_ATTEMPTS: usize = 4;
const SQLITE_OPEN_RETRY_DELAY_MS: u64 = 250;
const SQLITE_BUSY_TIMEOUT_SECS: u64 = 10;

pub(super) fn open_project_connection(
    state_path: &str,
    settings: &ResolvedProjectSettings,
) -> napi::Result<(Connection, Vec<u32>)> {
    let mut last_busy_message: Option<String> = None;
    for attempt in 0..SQLITE_OPEN_ATTEMPTS {
        match try_open_project_connection(state_path, settings) {
            Ok(result) => return Ok(result),
            Err(error)
                if sqlite_error_is_busy_or_locked(&error) && attempt + 1 < SQLITE_OPEN_ATTEMPTS =>
            {
                last_busy_message = Some(error.to_string());
                thread::sleep(Duration::from_millis(SQLITE_OPEN_RETRY_DELAY_MS));
            }
            Err(error) => return Err(error),
        }
    }

    Err(napi_error(
        "sqlite-error",
        &format!(
            "Could not initialize project state database after waiting for SQLite locks to clear: {}",
            last_busy_message.unwrap_or_else(|| "unknown SQLite lock".to_string())
        ),
    ))
}

fn try_open_project_connection(
    state_path: &str,
    settings: &ResolvedProjectSettings,
) -> napi::Result<(Connection, Vec<u32>)> {
    let conn = Connection::open(state_path)
        .map_err(|error| sqlite_error("Could not open project state database", error))?;
    conn.busy_timeout(Duration::from_secs(SQLITE_BUSY_TIMEOUT_SECS))
        .map_err(|error| sqlite_error("Could not set SQLite busy timeout", error))?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| sqlite_error("Could not enable SQLite WAL mode", error))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| sqlite_error("Could not set SQLite synchronous mode", error))?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| sqlite_error("Could not enable SQLite foreign keys", error))?;
    let migrations_applied = migrate_state(&conn)?;
    conn.execute(
        "insert into meta(key, value) values (?1, ?2)
         on conflict(key) do update set value = excluded.value",
        params![
            "projectSettings",
            serde_json::to_string(settings).unwrap_or_default()
        ],
    )
    .map_err(|error| sqlite_error("Could not persist project settings", error))?;
    Ok((conn, migrations_applied))
}

fn sqlite_error_is_busy_or_locked(error: &napi::Error) -> bool {
    let message = error.to_string().to_ascii_lowercase();
    message.contains("database is locked")
        || message.contains("database is busy")
        || message.contains("sqlite_busy")
        || message.contains("sqlite_locked")
}
