use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::constants::SCHEMA_VERSION;
use crate::json::{napi_error, sqlite_error};

struct Migration {
    version: u32,
    name: &'static str,
    sql: &'static str,
}

const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "initial",
    sql: include_str!("migrations/001_initial.sql"),
}];

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
    if current_version > SCHEMA_VERSION {
        return Err(napi_error(
            "sqlite-schema-mismatch",
            &format!(
                "Project state schema {current_version} is newer than this engine supports ({SCHEMA_VERSION}). Run opencanon db reset --confirm to clear generated state or switch to a matching OpenCanon runtime."
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
    Ok(applied)
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
