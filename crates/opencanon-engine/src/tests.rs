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

#[test]
fn indexes_code_graph_for_typescript_files() {
    let root = test_root("graph-extract");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/billing.ts"),
        "import { logger } from \"./log\";\nexport function createInvoice(): number { return 1; }\nexport class InvoiceService {}\nexport const FLAG = 1;\nexport interface Invoice { id: string }\nexport type Amount = number;\n",
    )
    .unwrap();

    let project = open_test_project(&root);
    let _ = project
        .scan_and_diff_json(json!({ "files": ["src/billing.ts"] }).to_string())
        .unwrap();
    let indexed = project
        .index_code_graph_json(
            json!({
                "files": [{
                    "path": "src/billing.ts",
                    "contentHash": "hash",
                    "language": "typescript"
                }],
                "parserVersion": "test-parser",
                "extractorVersion": "test-extractor"
            })
            .to_string(),
        )
        .unwrap();
    let indexed: Value = serde_json::from_str(&indexed).unwrap();
    assert_eq!(indexed["indexed"][0]["path"], "src/billing.ts");
    assert!(indexed["indexed"][0]["nodes"].as_u64().unwrap() >= 5);

    let symbols = project
        .search_symbols_json(json!({ "query": "createInvoice" }).to_string())
        .unwrap();
    let symbols: Value = serde_json::from_str(&symbols).unwrap();
    let names: Vec<&str> = symbols["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|symbol| symbol["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"createInvoice"));
    let invoice = symbols["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .find(|symbol| symbol["name"] == "createInvoice")
        .unwrap();
    assert_eq!(invoice["kind"], "function");
    assert_eq!(invoice["exported"], true);
    assert_eq!(invoice["range"]["start"]["line"], 2);
    assert!(invoice["id"].as_str().unwrap().len() >= 32);

    let references = project
        .search_references_json(json!({ "query": "logger" }).to_string())
        .unwrap();
    let references: Value = serde_json::from_str(&references).unwrap();
    assert_eq!(references["references"][0]["name"], "logger");
    assert_eq!(references["references"][0]["kind"], "import-named");
    assert_eq!(references["references"][0]["source"], "./log");
}

#[test]
fn replaces_code_nodes_when_files_change() {
    let root = test_root("graph-replace");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/a.ts"), "export function before() {}\n").unwrap();
    let project = open_test_project(&root);
    project
        .scan_and_diff_json(json!({ "files": ["src/a.ts"] }).to_string())
        .unwrap();
    project
        .index_code_graph_json(
            json!({
                "files": [{ "path": "src/a.ts", "contentHash": "h1", "language": "typescript" }],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();

    fs::write(root.join("src/a.ts"), "export function after() {}\n").unwrap();
    project
        .scan_and_diff_json(json!({ "files": ["src/a.ts"] }).to_string())
        .unwrap();
    project
        .index_code_graph_json(
            json!({
                "files": [{ "path": "src/a.ts", "contentHash": "h2", "language": "typescript" }],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();

    let before = project
        .search_symbols_json(json!({ "query": "before" }).to_string())
        .unwrap();
    let before: Value = serde_json::from_str(&before).unwrap();
    assert!(before["symbols"].as_array().unwrap().is_empty());

    let after = project
        .search_symbols_json(json!({ "query": "after" }).to_string())
        .unwrap();
    let after: Value = serde_json::from_str(&after).unwrap();
    assert_eq!(after["symbols"][0]["name"], "after");
}

#[test]
fn deleting_files_cascades_graph_rows() {
    let root = test_root("graph-delete");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/keep.ts"), "export const KEEP = 1;\n").unwrap();
    fs::write(root.join("src/drop.ts"), "export function dropMe() {}\n").unwrap();
    let project = open_test_project(&root);
    project
        .scan_and_diff_json(json!({ "files": ["src/keep.ts", "src/drop.ts"] }).to_string())
        .unwrap();
    project
        .index_code_graph_json(
            json!({
                "files": [
                    { "path": "src/keep.ts", "contentHash": "h", "language": "typescript" },
                    { "path": "src/drop.ts", "contentHash": "h", "language": "typescript" }
                ],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();

    fs::remove_file(root.join("src/drop.ts")).unwrap();
    project
        .scan_and_diff_json(json!({ "files": ["src/keep.ts"] }).to_string())
        .unwrap();

    let symbols = project
        .search_symbols_json(json!({ "query": "dropMe" }).to_string())
        .unwrap();
    let parsed: Value = serde_json::from_str(&symbols).unwrap();
    assert!(parsed["symbols"].as_array().unwrap().is_empty());

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    let unresolved_count: i64 = conn
        .query_row(
            "select count(*) from unresolved_references where path = 'src/drop.ts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    let extraction_count: i64 = conn
        .query_row(
            "select count(*) from code_extractions where path = 'src/drop.ts'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(unresolved_count, 0);
    assert_eq!(extraction_count, 0);
}

#[test]
fn default_export_bound_names_are_searchable() {
    let root = test_root("graph-default-export");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/entry.ts"),
        "function createInvoice() {}\nexport default createInvoice;\n",
    )
    .unwrap();
    let project = open_test_project(&root);
    project
        .scan_and_diff_json(json!({ "files": ["src/entry.ts"] }).to_string())
        .unwrap();
    project
        .index_code_graph_json(
            json!({
                "files": [{ "path": "src/entry.ts", "contentHash": "h", "language": "typescript" }],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();

    let symbols = project
        .search_symbols_json(json!({ "query": "createInvoice" }).to_string())
        .unwrap();
    let parsed: Value = serde_json::from_str(&symbols).unwrap();
    let names: Vec<&str> = parsed["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .map(|symbol| symbol["name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"createInvoice"));
}

#[test]
fn anonymous_default_function_exports_are_classified_as_functions() {
    let root = test_root("graph-default-expression");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/entry.ts"), "export default () => 1;\n").unwrap();
    let project = open_test_project(&root);
    project
        .scan_and_diff_json(json!({ "files": ["src/entry.ts"] }).to_string())
        .unwrap();
    project
        .index_code_graph_json(
            json!({
                "files": [{ "path": "src/entry.ts", "contentHash": "h", "language": "typescript" }],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();

    let symbols = project
        .search_symbols_json(json!({ "query": "default" }).to_string())
        .unwrap();
    let parsed: Value = serde_json::from_str(&symbols).unwrap();
    assert_eq!(parsed["symbols"][0]["kind"], "function");
}

#[test]
fn graph_index_reports_read_failures_per_file() {
    let root = test_root("graph-read-failed");
    let project = open_test_project(&root);
    let output = project
        .index_code_graph_json(
            json!({
                "files": [{ "path": "src/missing.ts", "contentHash": "h", "language": "typescript" }],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    assert!(parsed["indexed"].as_array().unwrap().is_empty());
    assert_eq!(parsed["diagnostics"][0]["code"], "read-failed");
}

#[test]
fn ignores_unsupported_languages_for_graph_extraction() {
    let root = test_root("graph-unsupported");
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::write(root.join("docs/notes.md"), "# notes\n").unwrap();
    let project = open_test_project(&root);
    project
        .scan_and_diff_json(json!({ "files": ["docs/notes.md"] }).to_string())
        .unwrap();
    let output = project
        .index_code_graph_json(
            json!({
                "files": [{ "path": "docs/notes.md", "contentHash": "h", "language": "markdown" }],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["indexed"][0]["nodes"], 0);
    assert_eq!(parsed["indexed"][0]["supported"], false);
    assert_eq!(
        parsed["diagnostics"][0]["code"],
        "unsupported-language-graph"
    );
}

#[test]
fn node_ids_are_stable_across_unrelated_file_changes() {
    let root = test_root("graph-stable-ids");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(root.join("src/a.ts"), "export function alpha() {}\n").unwrap();
    fs::write(root.join("src/b.ts"), "export function beta() {}\n").unwrap();
    let project = open_test_project(&root);
    project
        .scan_and_diff_json(json!({ "files": ["src/a.ts", "src/b.ts"] }).to_string())
        .unwrap();
    project
        .index_code_graph_json(
            json!({
                "files": [
                    { "path": "src/a.ts", "contentHash": "h", "language": "typescript" },
                    { "path": "src/b.ts", "contentHash": "h", "language": "typescript" }
                ],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();
    let first = project
        .search_symbols_json(json!({ "query": "alpha" }).to_string())
        .unwrap();
    let first: Value = serde_json::from_str(&first).unwrap();
    let alpha_id = first["symbols"][0]["id"].as_str().unwrap().to_string();

    fs::write(
        root.join("src/b.ts"),
        "export function beta() { return 42; }\n",
    )
    .unwrap();
    project
        .scan_and_diff_json(json!({ "files": ["src/a.ts", "src/b.ts"] }).to_string())
        .unwrap();
    project
        .index_code_graph_json(
            json!({
                "files": [
                    { "path": "src/b.ts", "contentHash": "h2", "language": "typescript" }
                ],
                "parserVersion": "test",
                "extractorVersion": "test"
            })
            .to_string(),
        )
        .unwrap();
    let second = project
        .search_symbols_json(json!({ "query": "alpha" }).to_string())
        .unwrap();
    let second: Value = serde_json::from_str(&second).unwrap();
    let alpha_id_second = second["symbols"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(alpha_id, alpha_id_second);
}

#[test]
fn migration_002_applies_and_creates_graph_tables() {
    let root = test_root("graph-migration");
    let project = open_test_project(&root);
    let status = project.status_json().unwrap();
    let parsed: Value = serde_json::from_str(&status).unwrap();
    let migrations = parsed["migrationsApplied"].as_array().unwrap();
    assert!(migrations.iter().any(|version| version.as_u64() == Some(2)));
    assert_eq!(parsed["schemaVersion"].as_u64(), Some(2));
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
