use std::fs;
use std::path::Path;
use std::thread;
use std::time::Duration;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::support::*;
use crate::open_project_json;
use crate::watcher::{build_watcher_filter, normalize_watcher_path};

#[test]
fn hashes_files_with_blake3() {
    let root = test_root("hashes");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        "export const value = \"active\";\n",
    )
    .unwrap();

    let project = open_test_project(&root);
    let output = project
        .scan_and_diff_json(json!({ "files": ["src/company.ts"] }).to_string())
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();

    assert_eq!(parsed["files"][0]["path"], "src/company.ts");
    assert!(parsed["files"][0]["contentHash"].as_str().unwrap().len() > 20);
}

#[test]
fn builds_graph_package_nodes_for_root_and_workspace_manifests() {
    let root = test_root("package-graph");
    let project = open_test_project(&root);
    let output = project
        .build_repo_graph_json(
            json!({
                "facts": [],
                "packageManifests": [
                    "package.json",
                    "apps/web/package.json",
                    "packages/core/package.json",
                    "tools/lint/package.json"
                ]
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let packages = parsed["graph"]["packages"].as_array().unwrap();

    assert_eq!(packages[0]["name"], "<root>");
    assert_eq!(packages[0]["root"], "");
    assert_eq!(packages[0]["kind"], "root");
    assert_eq!(packages[1]["kind"], "app");
    assert_eq!(packages[2]["kind"], "package");
    assert_eq!(packages[3]["kind"], "workspace");
}

#[test]
fn opens_project_state_and_scans_file_diff() {
    let root = test_root("project-state");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/company.ts"), "export const value = 1;\n").unwrap();
    let state_path = root.join(".opencanon/state/test/state.sqlite");

    let project = open_project_json(
        json!({
            "rootDir": root,
            "statePath": state_path,
            "settings": {
                "docsDir": "docs/opencanon",
                "conventionsPath": "opencanon/conventions/index.ts",
                "areasPath": "opencanon/areas/index.ts",
                "specsPath": "opencanon/specs/index.ts",
                "changesPath": "opencanon/changes/index.ts",
                "fixturesDir": "opencanon/fixtures",
                "projectFilePatterns": ["src/**/*.ts"],
                "ignore": [".opencanon/**"],
                "maxFiles": 20000,
                "maxFileSizeKb": 512,
                "fileDiscovery": "filesystem",
                "configHash": "hash"
            }
        })
        .to_string(),
    )
    .unwrap();

    let first = project
        .scan_and_diff_json(json!({ "files": ["src/company.ts"] }).to_string())
        .unwrap();
    let first: Value = serde_json::from_str(&first).unwrap();
    assert_eq!(first["changedFiles"][0], "src/company.ts");
    assert_eq!(first["deletedFiles"].as_array().unwrap().len(), 0);

    let second = project
        .scan_and_diff_json(json!({ "files": ["src/company.ts"] }).to_string())
        .unwrap();
    let second: Value = serde_json::from_str(&second).unwrap();
    assert_eq!(second["unchangedFiles"][0], "src/company.ts");
    assert_eq!(second["changedFiles"].as_array().unwrap().len(), 0);
}

#[test]
fn opens_project_state_after_transient_sqlite_write_lock() {
    let root = test_root("project-state-transient-lock");
    let state_path = root.join(".opencanon/state/test/state.sqlite");
    fs::create_dir_all(state_path.parent().unwrap()).unwrap();
    let lock_conn = Connection::open(&state_path).unwrap();
    lock_conn.execute_batch("begin immediate;").unwrap();

    let open_root = root.clone();
    let open_state_path = state_path.clone();
    let handle = thread::spawn(move || {
        open_project_json(
            json!({
                "rootDir": open_root,
                "statePath": open_state_path,
                "settings": test_settings()
            })
            .to_string(),
        )
    });

    thread::sleep(Duration::from_millis(100));
    lock_conn.execute_batch("commit;").unwrap();

    let project = handle.join().unwrap().unwrap();
    let status: Value = serde_json::from_str(&project.status_json().unwrap()).unwrap();
    assert_eq!(status["rootDir"].as_str().unwrap(), root.to_string_lossy());
}

#[test]
fn rejects_state_tables_without_migration_record() {
    let root = test_root("strict-migrations");
    let state_path = root.join(".opencanon/state/test/state.sqlite");
    fs::create_dir_all(state_path.parent().unwrap()).unwrap();
    let conn = Connection::open(&state_path).unwrap();
    conn.execute_batch("create table meta (key text primary key, value text not null);")
        .unwrap();
    drop(conn);

    let result = open_project_json(
        json!({
            "rootDir": root,
            "statePath": state_path,
            "settings": test_settings()
        })
        .to_string(),
    );
    let Err(error) = result else {
        panic!("expected strict migration failure");
    };
    let message = error.to_string();

    assert!(message.contains("Could not apply migration"));
    assert!(message.contains("table meta already exists"));
}

#[test]
fn watcher_path_filter_normalizes_project_files_and_ignores_generated_paths() {
    let root = test_root("watcher-filter");
    let settings = test_settings();
    let filter = build_watcher_filter(&settings).unwrap();

    assert_eq!(
        normalize_watcher_path(&root, &filter, &root.join("src/company.ts")),
        Some("src/company.ts".to_string())
    );
    assert_eq!(
        normalize_watcher_path(&root, &filter, Path::new("tests/company.test.ts")),
        Some("tests/company.test.ts".to_string())
    );
    assert_eq!(
        normalize_watcher_path(&root, &filter, &root.join(".opencanon/state/test/state.sqlite")),
        None
    );
    assert_eq!(
        normalize_watcher_path(&root, &filter, &root.join("node_modules/pkg/index.js")),
        None
    );
    assert_eq!(
        normalize_watcher_path(&root, &filter, &root.join("coverage/report.json")),
        None
    );
}
