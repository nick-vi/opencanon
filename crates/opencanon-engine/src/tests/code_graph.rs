use std::fs;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::support::*;

#[test]
fn indexes_code_graph_for_typescript_files() {
    let root = test_root("graph-extract");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/billing.ts"),
        "import { logger } from \"./log\";\nimport defaultFormatter from \"./format\";\nfunction helper(): number { return 1; }\nexport function createInvoice(): number { logger.info(defaultFormatter()); return helper(); }\nexport class InvoiceService {}\nexport const FLAG = 1;\nexport interface Invoice { id: string }\nexport type Amount = number;\n",
    )
    .unwrap();
    fs::write(root.join("src/log.ts"), "export function logger() {}\n").unwrap();
    fs::write(
        root.join("src/format.ts"),
        "export default function format() { return 1; }\n",
    )
    .unwrap();

    let project = open_test_project(&root);
    let _ = project
        .scan_and_diff_json(
            json!({ "files": ["src/billing.ts", "src/log.ts", "src/format.ts"] }).to_string(),
        )
        .unwrap();
    let indexed = project
        .index_code_graph_json(
            json!({
                "files": [{
                    "path": "src/billing.ts",
                    "contentHash": "hash",
                    "language": "typescript"
                }, {
                    "path": "src/log.ts",
                    "contentHash": "hash-log",
                    "language": "typescript"
                }, {
                    "path": "src/format.ts",
                    "contentHash": "hash-format",
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
    assert_eq!(invoice["range"]["start"]["line"], 4);
    assert_eq!(invoice["range"]["start"]["column"], 17);
    assert!(invoice["id"].as_str().unwrap().len() >= 32);

    let references = project
        .search_references_json(json!({ "query": "logger" }).to_string())
        .unwrap();
    let references: Value = serde_json::from_str(&references).unwrap();
    assert_eq!(references["references"][0]["name"], "logger");
    assert_eq!(references["references"][0]["kind"], "import-named");
    assert_eq!(references["references"][0]["source"], "./log");
    assert!(references["references"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reference| reference["kind"] == "identifier"));

    let edges = project
        .search_graph_edges_json(
            json!({ "query": "helper", "direction": "incoming", "kind": "call" }).to_string(),
        )
        .unwrap();
    let edges: Value = serde_json::from_str(&edges).unwrap();
    assert!(edges["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(
            |edge| edge["source"]["name"] == "createInvoice" && edge["target"]["name"] == "helper"
        ));

    let import_edges = project
        .search_graph_edges_json(
            json!({ "query": "logger", "direction": "incoming", "kind": "identifier" }).to_string(),
        )
        .unwrap();
    let import_edges: Value = serde_json::from_str(&import_edges).unwrap();
    assert!(import_edges["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["source"]["name"] == "createInvoice"
            && edge["target"]["path"] == "src/log.ts"));

    let default_edges = project
        .search_graph_edges_json(
            json!({ "query": "format", "direction": "incoming", "kind": "call" }).to_string(),
        )
        .unwrap();
    let default_edges: Value = serde_json::from_str(&default_edges).unwrap();
    assert!(default_edges["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["source"]["name"] == "createInvoice"
            && edge["target"]["path"] == "src/format.ts"));
}

#[test]
fn indexes_code_graph_for_python_files() {
    let root = test_root("python-graph-extract");
    fs::create_dir_all(root.join("pkg")).unwrap();
    fs::write(root.join("pkg/__init__.py"), "# package marker\n").unwrap();
    fs::write(
        root.join("pkg/mod.py"),
        [
            "class Service:",
            "    def method(self):",
            "        return f()",
            "",
            "def f():",
            "    return 1",
            "",
            "def g():",
            "    return 2",
            "",
            "async def load():",
            "    return g()",
            "",
            "def outer():",
            "    def nested():",
            "        return f()",
            "    return nested()",
            "",
        ]
        .join("\n"),
    )
    .unwrap();
    fs::write(
        root.join("pkg/consumer.py"),
        [
            "from .mod import f",
            "import pkg.mod",
            "from . import missing",
            "",
            "def run():",
            "    f()",
            "    pkg.mod.g()",
            "    missing.touch()",
            "",
        ]
        .join("\n"),
    )
    .unwrap();

    let project = open_test_project(&root);
    project
        .scan_and_diff_json(
            json!({ "files": ["pkg/__init__.py", "pkg/mod.py", "pkg/consumer.py"] }).to_string(),
        )
        .unwrap();
    let indexed = project
        .index_code_graph_json(
            json!({
                "files": [{
                    "path": "pkg/__init__.py",
                    "contentHash": "hash-init",
                    "language": "python"
                }, {
                    "path": "pkg/mod.py",
                    "contentHash": "hash-mod",
                    "language": "python"
                }, {
                    "path": "pkg/consumer.py",
                    "contentHash": "hash-consumer",
                    "language": "python"
                }],
                "parserVersion": "test-parser",
                "extractorVersion": "test-extractor"
            })
            .to_string(),
        )
        .unwrap();
    let indexed: Value = serde_json::from_str(&indexed).unwrap();
    assert_eq!(indexed["indexed"][1]["path"], "pkg/mod.py");
    assert!(indexed["indexed"][1]["nodes"].as_u64().unwrap() >= 6);
    assert_eq!(indexed["indexed"][2]["supported"], true);

    let service_symbols = project
        .search_symbols_json(json!({ "query": "Service" }).to_string())
        .unwrap();
    let service_symbols: Value = serde_json::from_str(&service_symbols).unwrap();
    assert!(service_symbols["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .any(|symbol| symbol["kind"] == "class"
            && symbol["path"] == "pkg/mod.py"
            && symbol["exported"] == true));

    let nested_symbols = project
        .search_symbols_json(json!({ "query": "nested" }).to_string())
        .unwrap();
    let nested_symbols: Value = serde_json::from_str(&nested_symbols).unwrap();
    assert!(nested_symbols["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .any(|symbol| symbol["kind"] == "function" && symbol["path"] == "pkg/mod.py"));

    let method_symbols = project
        .search_symbols_json(json!({ "query": "method" }).to_string())
        .unwrap();
    let method_symbols: Value = serde_json::from_str(&method_symbols).unwrap();
    assert!(method_symbols["symbols"]
        .as_array()
        .unwrap()
        .iter()
        .any(|symbol| symbol["kind"] == "method" && symbol["path"] == "pkg/mod.py"));

    let relative_edges = project
        .search_graph_edges_json(
            json!({ "query": "f", "direction": "incoming", "kind": "call" }).to_string(),
        )
        .unwrap();
    let relative_edges: Value = serde_json::from_str(&relative_edges).unwrap();
    assert!(relative_edges["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["source"]["name"] == "run"
            && edge["target"]["name"] == "f"
            && edge["target"]["path"] == "pkg/mod.py"));

    let absolute_edges = project
        .search_graph_edges_json(
            json!({ "query": "g", "direction": "incoming", "kind": "call" }).to_string(),
        )
        .unwrap();
    let absolute_edges: Value = serde_json::from_str(&absolute_edges).unwrap();
    assert!(absolute_edges["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["source"]["name"] == "run"
            && edge["target"]["name"] == "g"
            && edge["target"]["path"] == "pkg/mod.py"));

    let missing_import = project
        .search_references_json(
            json!({ "query": "missing", "path": "pkg/consumer.py", "kind": "import-named" })
                .to_string(),
        )
        .unwrap();
    let missing_import: Value = serde_json::from_str(&missing_import).unwrap();
    assert_eq!(missing_import["references"][0]["source"], ".missing");

    let missing_edges = project
        .search_graph_edges_json(
            json!({ "query": "touch", "direction": "incoming", "kind": "call" }).to_string(),
        )
        .unwrap();
    let missing_edges: Value = serde_json::from_str(&missing_edges).unwrap();
    assert!(missing_edges["edges"].as_array().unwrap().is_empty());
}

#[test]
fn resolves_alias_and_workspace_import_graph_edges() {
    let root = test_root("graph-alias-workspace");
    fs::create_dir_all(root.join("src/core")).unwrap();
    fs::create_dir_all(root.join("packages/tools/src")).unwrap();
    fs::write(
        root.join("package.json"),
        r#"{"name":"root","workspaces":["packages/*"]}"#,
    )
    .unwrap();
    fs::write(
        root.join("tsconfig.json"),
        "{\n  // comments are valid in tsconfig files\n  \"compilerOptions\": { \"baseUrl\": \".\", \"paths\": { \"@core/*\": [\"src/core/*\"] } }\n}\n",
    )
    .unwrap();
    fs::write(
        root.join("packages/tools/package.json"),
        r#"{"name":"@scope/tools"}"#,
    )
    .unwrap();
    fs::write(
        root.join("src/core/log.ts"),
        "export function writeLog() { return true; }\n",
    )
    .unwrap();
    fs::write(
        root.join("packages/tools/src/index.ts"),
        "export function formatTool() { return true; }\n",
    )
    .unwrap();
    fs::write(
        root.join("src/app.ts"),
        "import { writeLog } from '@core/log';\nimport { formatTool } from '@scope/tools';\nexport function runApp() {\n  writeLog();\n  formatTool();\n}\n",
    )
    .unwrap();

    let project = open_test_project(&root);
    project
        .scan_and_diff_json(
            json!({ "files": ["src/app.ts", "src/core/log.ts", "packages/tools/src/index.ts", "package.json", "tsconfig.json", "packages/tools/package.json"] }).to_string(),
        )
        .unwrap();
    project
        .index_code_graph_json(
            json!({
                "files": [{
                    "path": "src/app.ts",
                    "contentHash": "hash-app",
                    "language": "typescript"
                }, {
                    "path": "src/core/log.ts",
                    "contentHash": "hash-log",
                    "language": "typescript"
                }, {
                    "path": "packages/tools/src/index.ts",
                    "contentHash": "hash-tools",
                    "language": "typescript"
                }],
                "parserVersion": "test-parser",
                "extractorVersion": "test-extractor"
            })
            .to_string(),
        )
        .unwrap();

    let alias_edges = project
        .search_graph_edges_json(
            json!({ "query": "writeLog", "direction": "incoming", "kind": "call" }).to_string(),
        )
        .unwrap();
    let alias_edges: Value = serde_json::from_str(&alias_edges).unwrap();
    assert!(alias_edges["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["source"]["name"] == "runApp"
            && edge["target"]["path"] == "src/core/log.ts"));

    let workspace_edges = project
        .search_graph_edges_json(
            json!({ "query": "formatTool", "direction": "incoming", "kind": "call" }).to_string(),
        )
        .unwrap();
    let workspace_edges: Value = serde_json::from_str(&workspace_edges).unwrap();
    assert!(workspace_edges["edges"]
        .as_array()
        .unwrap()
        .iter()
        .any(|edge| edge["source"]["name"] == "runApp"
            && edge["target"]["path"] == "packages/tools/src/index.ts"));
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
