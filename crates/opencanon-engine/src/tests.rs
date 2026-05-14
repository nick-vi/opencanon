use std::fs;
use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::*;
use crate::contracts::ResolvedProjectSettings;
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
fn extracts_basic_typescript_facts() {
    let root = test_root("facts");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        "import { find } from \"./dal\";\n// current intent\nexport function loadCompany() {\n  return find(\"active\");\n}\n",
    )
    .unwrap();

    let project = open_test_project(&root);
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "src/company.ts",
                    "contentHash": "hash",
                    "language": "typescript"
                }],
                "facts": ["imports", "exports", "symbols", "calls", "literals", "comments"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let facts = &parsed["files"][0];

    assert_eq!(facts["imports"][0]["source"], "./dal");
    assert_eq!(facts["exports"][0]["name"], "loadCompany");
    assert_eq!(facts["symbols"].as_array().unwrap().len(), 1);
    assert_eq!(facts["symbols"][0]["exported"], true);
    assert_eq!(facts["comments"][0]["text"], "current intent");
    assert_eq!(facts["literals"][0]["value"], "active");
}

#[test]
fn extracts_export_kinds_that_match_contract() {
    let root = test_root("export-kinds");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        "export const value = 1;\nexport let mutable = 2;\nexport var mutableVar = 3;\nexport { value as renamed };\n",
    )
    .unwrap();

    let project = open_test_project(&root);
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "src/company.ts",
                    "contentHash": "hash",
                    "language": "typescript"
                }],
                "facts": ["exports"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let kinds = parsed["files"][0]["exports"]
        .as_array()
        .unwrap()
        .iter()
        .map(|export| export["kind"].as_str().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(kinds, vec!["const", "let", "var", "unknown"]);
}

#[test]
fn extracts_literals_without_reclassifying_string_contents() {
    let root = test_root("literals");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        "export const code = \"123\";\nexport const enabledText = \"true\";\nexport const count = 123;\nexport const enabled = true;\n",
    )
    .unwrap();

    let project = open_test_project(&root);
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "src/company.ts",
                    "contentHash": "hash",
                    "language": "typescript"
                }],
                "facts": ["literals"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let literals = parsed["files"][0]["literals"].as_array().unwrap();
    let string_literals = literals
        .iter()
        .filter(|literal| literal["valueKind"] == "string")
        .collect::<Vec<_>>();
    let number_literals = literals
        .iter()
        .filter(|literal| literal["valueKind"] == "number")
        .collect::<Vec<_>>();
    let boolean_literals = literals
        .iter()
        .filter(|literal| literal["valueKind"] == "boolean")
        .collect::<Vec<_>>();

    assert_eq!(string_literals.len(), 2);
    assert_eq!(number_literals.len(), 1);
    assert_eq!(boolean_literals.len(), 1);
    assert_eq!(string_literals[0]["value"], "123");
    assert_eq!(string_literals[1]["value"], "true");
}

#[test]
fn reports_unsupported_fact_languages() {
    let root = test_root("unsupported-language");
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::write(root.join("docs/notes.md"), "# Notes\n").unwrap();

    let project = open_test_project(&root);
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "docs/notes.md",
                    "contentHash": "hash",
                    "language": "markdown"
                }],
                "facts": ["imports"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();

    assert_eq!(
        parsed["files"][0]["diagnostics"][0]["code"],
        "unsupported-language-facts"
    );
    assert_eq!(parsed["files"][0]["diagnostics"][0]["severity"], "error");
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
    let state_path = root.join(".opencanon/state.sqlite");

    let project = open_project_json(
        json!({
            "rootDir": root,
            "statePath": state_path,
            "settings": {
                "docsDir": "docs/opencanon",
                "decisionsPath": "docs/opencanon/decisions.json",
                "validatorsPath": ".agents/skills/opencanon/validators/index.ts",
                "fixturesDir": ".agents/skills/opencanon/fixtures",
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
fn rejects_state_tables_without_migration_record() {
    let root = test_root("strict-migrations");
    let state_path = root.join(".opencanon/state.sqlite");
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
        normalize_watcher_path(&root, &filter, &root.join(".opencanon/state.sqlite")),
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

fn test_root(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("opencanon-engine-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    root
}

fn open_test_project(root: &std::path::Path) -> EngineProjectHandle {
    open_project_json(
        json!({
            "rootDir": root,
            "statePath": root.join(".opencanon/state.sqlite"),
            "settings": test_settings()
        })
        .to_string(),
    )
    .unwrap()
}

fn test_settings() -> ResolvedProjectSettings {
    ResolvedProjectSettings {
        docs_dir: "docs/opencanon".to_string(),
        decisions_path: "docs/opencanon/decisions.json".to_string(),
        validators_path: ".agents/skills/opencanon/validators/index.ts".to_string(),
        fixtures_dir: ".agents/skills/opencanon/fixtures".to_string(),
        project_file_patterns: vec!["src/**/*.ts".to_string(), "tests/**/*.ts".to_string()],
        ignore: vec!["coverage/**".to_string(), ".opencanon/**".to_string()],
        max_files: 20_000,
        max_file_size_kb: 512,
        file_discovery: "filesystem".to_string(),
        config_hash: "hash".to_string(),
    }
}
