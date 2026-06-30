use std::fs;
use std::path::Path;
use std::thread;
use std::time::Duration;

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
    assert_eq!(facts["comments"][0]["column"], 1);
    assert_eq!(facts["literals"][0]["value"], "active");
}

#[test]
fn extracts_typescript_facts_from_request_content() {
    let root = test_root("facts-from-content");
    let project = open_test_project(&root);
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "virtual/company.ts",
                    "contentHash": "virtual-hash",
                    "language": "typescript",
                    "content": "import { find } from \"./dal\";\nexport const value = find(\"active\");\n"
                }],
                "facts": ["imports", "exports", "calls", "literals"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let facts = &parsed["files"][0];

    assert_eq!(parsed["diagnostics"], json!([]));
    assert_eq!(facts["path"], "virtual/company.ts");
    assert_eq!(facts["contentHash"], "virtual-hash");
    assert_eq!(facts["imports"][0]["source"], "./dal");
    assert_eq!(facts["exports"][0]["name"], "value");
    assert_eq!(facts["calls"][0]["callee"], "find");
    assert_eq!(facts["literals"][0]["value"], "active");
}

#[test]
fn extracts_empty_svelte_facts_when_no_script_block() {
    let parsed = extract_svelte_facts(
        "svelte-no-script",
        "src/OnlyMarkup.svelte",
        "<p>only markup</p>",
        &["symbols"],
    );
    let facts = &parsed["files"][0];

    assert_eq!(parsed["diagnostics"], json!([]));
    assert_eq!(facts["path"], "src/OnlyMarkup.svelte");
    assert_eq!(facts["language"], "svelte");
    assert_eq!(facts["parser"], "oxc");
    assert_eq!(facts["parserVersion"], "test-parser");
    assert_eq!(facts["symbols"], json!([]));
    assert_eq!(facts["diagnostics"], json!([]));
}

#[test]
fn extracts_svelte_module_and_instance_script_facts_with_host_offsets() {
    let module_tag = r#"<script context="module" lang="ts">"#;
    let instance_tag = r#"<script lang="ts">"#;
    let source = [
        format!(
            "{module_tag}import {{ boot }} from \"./boot\"; export const A = boot(\"ready\");</script>"
        ),
        "<p>markup</p>".to_string(),
        instance_tag.to_string(),
        "  const Status = {".to_string(),
        "    ACTIVE: \"active\",".to_string(),
        "  } as const;".to_string(),
        "</script>".to_string(),
    ]
    .join("\n");
    let content_hash = blake3::hash(source.as_bytes()).to_hex().to_string();
    let parsed = extract_svelte_facts(
        "svelte-module-instance",
        "src/Comp.svelte",
        &source,
        &[
            "imports",
            "exports",
            "symbols",
            "declarations",
            "calls",
            "literals",
        ],
    );
    let facts = &parsed["files"][0];

    assert_eq!(facts["path"], "src/Comp.svelte");
    assert_eq!(facts["contentHash"], content_hash);
    assert_eq!(facts["language"], "svelte");
    assert_eq!(facts["diagnostics"], json!([]));

    let imports = facts["imports"].as_array().unwrap();
    assert_eq!(imports[0]["source"], "./boot");
    assert_eq!(
        imports[0]["column"].as_u64().unwrap(),
        (utf16_len(module_tag) + 1) as u64
    );

    let exports = facts["exports"].as_array().unwrap();
    let export_a = fact_named(exports, "A");
    assert_eq!(export_a["line"], 1);

    let symbols = facts["symbols"].as_array().unwrap();
    let symbol_a = fact_named(symbols, "A");
    assert_eq!(symbol_a["line"], 1);
    assert_eq!(symbol_a["exported"], true);
    assert_eq!(
        symbol_a["column"].as_u64().unwrap(),
        (utf16_len(module_tag) + utf16_len(r#"import { boot } from "./boot"; export const "#) + 1)
            as u64
    );

    let status = fact_named(symbols, "Status");
    assert_eq!(status["line"], 4);
    assert_eq!(status["column"], 9);

    let declarations = facts["declarations"].as_array().unwrap();
    let status_declaration = fact_named(declarations, "Status");
    assert_eq!(status_declaration["line"], 4);
    assert_eq!(status_declaration["endLine"], 6);
    assert_eq!(
        status_declaration["initializer"]["properties"],
        json!([
            { "line": 5, "key": "ACTIVE", "quoted": false, "value": "active", "valueKind": "string" }
        ])
    );

    let calls = facts["calls"].as_array().unwrap();
    let boot = fact_by(calls, "callee", "boot");
    assert_eq!(boot["line"], 1);
    assert_eq!(
        boot["column"].as_u64().unwrap(),
        (utf16_len(module_tag)
            + utf16_len(r#"import { boot } from "./boot"; export const A = "#)
            + 1) as u64
    );

    let literals = facts["literals"].as_array().unwrap();
    let ready = fact_by(literals, "value", "ready");
    assert_eq!(ready["line"], 1);
    assert_eq!(
        ready["column"].as_u64().unwrap(),
        (utf16_len(module_tag)
            + utf16_len(r#"import { boot } from "./boot"; export const A = boot("#)
            + 1) as u64
    );
    let active = fact_by(literals, "value", "active");
    assert_eq!(active["line"], 5);
    assert_eq!(active["column"], 13);
}

#[test]
fn recognizes_svelte_bare_module_script_and_lang() {
    let source = r#"<script module lang="ts">export interface Props { value: string }</script>"#;
    let blocks = crate::svelte_facts::parse_svelte_script_block_snapshots(source);

    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].text, "export interface Props { value: string }");
    assert_eq!(blocks[0].line_offset, 0);
    assert_eq!(blocks[0].context, "module");
    assert_eq!(blocks[0].extension, "ts");
    assert_eq!(
        blocks[0].column_offset,
        utf16_len(r#"<script module lang="ts">"#)
    );

    let parsed = extract_svelte_facts(
        "svelte-bare-module",
        "src/M.svelte",
        source,
        &["declarations"],
    );
    let declarations = parsed["files"][0]["declarations"].as_array().unwrap();
    let props = fact_named(declarations, "Props");
    assert_eq!(props["kind"], "interface");
    assert_eq!(props["exported"], true);
    assert_eq!(props["line"], 1);
}

#[test]
fn keeps_svelte_script_tag_open_until_after_quoted_generics() {
    let source = r#"<script lang="ts" generics="T extends Promise<string>">const v: T | undefined = undefined;</script>"#;
    let blocks = crate::svelte_facts::parse_svelte_script_block_snapshots(source);

    assert_eq!(blocks.len(), 1);
    assert_eq!(blocks[0].text, "const v: T | undefined = undefined;");

    let parsed = extract_svelte_facts(
        "svelte-generics-attribute",
        "src/Generics.svelte",
        source,
        &["symbols"],
    );
    let facts = &parsed["files"][0];
    let symbols = facts["symbols"].as_array().unwrap();
    let symbol = fact_named(symbols, "v");

    assert_eq!(facts["diagnostics"], json!([]));
    assert_eq!(symbol["line"], 1);
}

#[test]
fn skips_non_top_level_svelte_script_text() {
    let source = [
        "<!-- <script>const commented = 1;</script> -->",
        r#"<div title="<script>const attr = 1;</script>">markup</div>"#,
        r#"{"<script>const expr = 1;</script>"}"#,
        r#"{{ outer: { inner: 1 } }.outer.inner ? "" : "<script>const nested = 1;</script>"}"#,
        r#"<style>.banner::before { content: "<script>const raw = 1;</script>"; }</style>"#,
        r#"<div><script>const child = 1;</script></div>"#,
        r#"<input><script lang="ts">const live = 1;</script>"#,
    ]
    .join("\n");
    let parsed = extract_svelte_facts(
        "svelte-skip-non-top-level",
        "src/Skip.svelte",
        &source,
        &["symbols"],
    );
    let facts = &parsed["files"][0];
    let symbols = facts["symbols"].as_array().unwrap();

    assert_eq!(symbol_names(symbols), vec!["live"]);
    let live = fact_named(symbols, "live");
    assert_eq!(live["line"], 7);
}

#[test]
fn offsets_svelte_facts_across_crlf_line_endings() {
    let source = [
        "<p>x</p>",
        r#"<script lang="ts">"#,
        "  const y = 1;",
        "</script>",
    ]
    .join("\r\n");
    let parsed = extract_svelte_facts("svelte-crlf", "src/R.svelte", &source, &["symbols"]);
    let symbols = parsed["files"][0]["symbols"].as_array().unwrap();
    let y = fact_named(symbols, "y");

    assert_eq!(y["line"], 3);
    assert_eq!(y["column"], 9);
}

#[test]
fn handles_svelte_block_tags_when_locating_top_level_scripts() {
    let cases = [
        (
            "closing tag before script",
            "{/if}<script>const a=1;</script>",
            true,
        ),
        (
            "full if block",
            "{#if c}<span>x</span>{/if}\n<script>const a=1;</script>",
            true,
        ),
        (
            "full each block",
            "{#each items as i}<li>{i}</li>{/each}<script>const a=1;</script>",
            true,
        ),
        (
            "else continuation",
            "{#if c}<span>x</span>{:else}<span>y</span>{/if}<script>const a=1;</script>",
            true,
        ),
        (
            "await block",
            "{#await promise}<span>wait</span>{:then value}<span>{value}</span>{/await}<script>const a=1;</script>",
            true,
        ),
        (
            "regex in block tag and expression",
            "{#if /x/.test(s)}<span>x</span>{/if}{ /abc/.test(v) }<script>const a=1;</script>",
            true,
        ),
        (
            "script inside closed block",
            "{#if c}<script>const hidden=1;</script>{/if}",
            false,
        ),
        (
            "script inside unclosed block",
            "{#if c}<script>const hidden=1;</script>",
            false,
        ),
    ];

    for (case, source, should_find_script) in cases {
        let parsed = extract_svelte_facts(
            &format!("svelte-block-tags-{}", case.replace(' ', "-")),
            "src/Block.svelte",
            source,
            &["symbols"],
        );
        let symbols = parsed["files"][0]["symbols"].as_array().unwrap();
        let names = symbol_names(symbols);

        assert_eq!(
            names.iter().any(|name| name == "a"),
            should_find_script,
            "{case}"
        );
        assert!(
            !names.iter().any(|name| name == "hidden"),
            "{case} should not extract hidden script"
        );
    }
}

#[test]
fn emits_typescript_columns_as_utf16_code_units() {
    let root = test_root("typescript-utf16-columns");
    let project = open_test_project(&root);
    let source = "const café = identity(x);\n";
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "virtual/company.ts",
                    "contentHash": "virtual-hash",
                    "language": "typescript",
                    "content": source
                }],
                "facts": ["calls"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let calls = parsed["files"][0]["calls"].as_array().unwrap();
    let call = calls
        .iter()
        .find(|call| call["callee"] == "identity")
        .expect("missing identity call");
    let utf16_column = "const café = ".encode_utf16().count() + 1;
    let byte_column = "const café = ".len() + 1;

    assert_eq!(utf16_column, 14);
    assert_eq!(byte_column, 15);
    assert_eq!(call["line"], 1);
    assert_eq!(call["column"].as_u64().unwrap(), utf16_column as u64);
    assert_ne!(call["column"].as_u64().unwrap(), byte_column as u64);
}

#[test]
fn extracts_comments_with_parse_comments_convention() {
    let root = test_root("comment-convention");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        "const x = 1; /* first\n * second\n */\n  // third\nconst y = /* inline */ 1;\n",
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
                "facts": ["comments"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let comments = &parsed["files"][0]["comments"];

    assert_eq!(
        comments,
        &json!([
            { "line": 1, "column": 14, "text": "first", "kind": "block" },
            { "line": 2, "column": 1, "text": "* second", "kind": "block" },
            { "line": 4, "column": 3, "text": "third", "kind": "line" },
            { "line": 5, "column": 11, "text": "inline", "kind": "block" }
        ])
    );
}

#[test]
fn extracts_call_fields_for_try_depth_and_argument_calls() {
    let root = test_root("call-fields");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        "async function loadConfig(path: string) {\n  try {\n    JSON.parse(await fs.promises.readFile(path));\n    try {\n      JSON.parse(readFileSync(path));\n    } catch {\n      JSON.parse(readFileSync(path));\n    } finally {\n      JSON.parse(readFileSync(path));\n    }\n  } catch {\n    JSON.parse(readFileSync(path));\n  } finally {\n    JSON.parse(readFileSync(path));\n  }\n  JSON.parse(readFileSync(path));\n}\n",
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
                "facts": ["calls"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let calls = parsed["files"][0]["calls"].as_array().unwrap();
    let json_parse_calls = calls
        .iter()
        .filter(|call| call["callee"] == "JSON.parse")
        .collect::<Vec<_>>();

    assert_eq!(json_parse_calls.len(), 7);
    assert_eq!(
        json_parse_calls
            .iter()
            .map(|call| call["tryDepth"].as_u64().unwrap())
            .collect::<Vec<_>>(),
        vec![1, 2, 1, 1, 0, 0, 0]
    );
    assert_eq!(json_parse_calls[0]["line"], 3);
    assert_eq!(json_parse_calls[0]["column"], 5);
    assert_eq!(json_parse_calls[0]["name"], "parse");
    assert_eq!(json_parse_calls[0]["receiver"], "JSON");
    assert_eq!(
        json_parse_calls[0]["argumentCalls"],
        json!([{ "callee": "fs.promises.readFile", "name": "readFile", "awaited": true }])
    );
    assert_eq!(
        json_parse_calls[1]["argumentCalls"],
        json!([{ "callee": "readFileSync", "name": "readFileSync", "awaited": false }])
    );
}

#[test]
fn extracts_export_kinds_that_match_contract() {
    let root = test_root("export-kinds");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        "export const value = 1;\nexport let mutable = 2;\nexport var mutableVar = 3;\nexport { value as renamed };\nexport { value as reexported } from \"./values\";\nexport type { Foo } from \"./types\";\nexport { type Bar as Baz } from \"./types\";\nexport * from \"./all\";\nexport * as tools from \"./tools\";\n",
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
    let exports = parsed["files"][0]["exports"].as_array().unwrap();
    let kinds = exports
        .iter()
        .map(|export| export["kind"].as_str().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(
        kinds,
        vec![
            "const",
            "let",
            "var",
            "reexport",
            "reexport",
            "reexport",
            "reexport",
            "star-reexport",
            "reexport"
        ]
    );
    assert_eq!(exports[4]["name"], "reexported");
    assert_eq!(exports[4]["source"], "./values");
    assert_eq!(exports[4]["importedName"], "value");
    assert_eq!(exports[5]["typeOnly"], true);
    assert_eq!(exports[6]["typeOnly"], true);
    assert_eq!(exports[7]["name"], "*");
    assert_eq!(exports[7]["source"], "./all");
    assert_eq!(exports[8]["name"], "tools");
    assert_eq!(exports[8]["source"], "./tools");
    assert!(exports.iter().all(|export| export["kind"] != "unknown"));
}

#[test]
fn extracts_typescript_symbol_kinds_and_params() {
    let root = test_root("symbol-kinds");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        "export type Status = \"active\" | \"inactive\";\ninterface Internal {}\nexport interface External {}\nenum Direction { Up }\nexport class Service {\n  load(id: string) { return id; }\n  private reset() {}\n}\nconst value = 1;\nexport const make = (id: string, options?: Options) => id;\nlet run = function (input: string) { return input; };\n",
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
                "facts": ["symbols"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let symbols = parsed["files"][0]["symbols"].as_array().unwrap();
    let symbol = |name: &str| {
        symbols
            .iter()
            .find(|symbol| symbol["name"] == name)
            .unwrap_or_else(|| panic!("missing symbol {name}"))
    };

    assert_eq!(symbol("Status")["kind"], "type");
    assert_eq!(symbol("Status")["exported"], true);
    assert_eq!(symbol("Internal")["kind"], "interface");
    assert_eq!(symbol("Internal")["exported"], false);
    assert_eq!(symbol("External")["kind"], "interface");
    assert_eq!(symbol("Direction")["kind"], "enum");
    assert_eq!(symbol("Service")["kind"], "class");
    assert_eq!(symbol("Service")["exported"], true);
    assert_eq!(symbol("load")["kind"], "method");
    assert_eq!(symbol("load")["params"], json!(["id: string"]));
    assert_eq!(symbol("reset")["kind"], "method");
    assert_eq!(symbol("value")["kind"], "variable");
    assert_eq!(symbol("make")["kind"], "function");
    assert_eq!(symbol("make")["exported"], true);
    assert_eq!(
        symbol("make")["params"],
        json!(["id: string", "options?: Options"])
    );
    assert_eq!(symbol("run")["kind"], "function");
    assert_eq!(symbol("run")["params"], json!(["input: string"]));
    assert!(symbols.iter().all(|symbol| symbol["kind"] != "unknown"));
    assert!(symbols
        .iter()
        .all(|symbol| symbol["endLine"].as_u64().is_some()));
}

#[test]
fn extracts_typescript_declaration_details() {
    let root = test_root("declaration-details");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        [
            "export const enum CompanyStatus {",
            "  ACTIVE = \"active\",",
            "  ARCHIVED = \"archived\",",
            "  COUNT = 1,",
            "  COMPUTED = statusValue,",
            "}",
            "export const CompanyStatusValue = {",
            "  ACTIVE: \"active\",",
            "  ARCHIVED: \"archived\",",
            "  COUNT: 1,",
            "  ENABLED: true,",
            "} as const satisfies Record<string, string>",
            "export type Mode = \"on\" | \"off\";",
            "export async function loadCompany(id: string) { return id; }",
            "export class CompanyService {}",
            "export interface CompanyContract {}",
            "",
        ]
        .join("\n"),
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
                "facts": ["declarations"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let declarations = parsed["files"][0]["declarations"].as_array().unwrap();
    let declaration = |name: &str| {
        declarations
            .iter()
            .find(|declaration| declaration["name"] == name)
            .unwrap_or_else(|| panic!("missing declaration {name}"))
    };

    let enum_declaration = declaration("CompanyStatus");
    assert_eq!(enum_declaration["kind"], "enum");
    assert_eq!(enum_declaration["exported"], true);
    assert_eq!(enum_declaration["constEnum"], true);
    assert_eq!(
        enum_declaration["members"],
        json!([
            { "line": 2, "name": "ACTIVE", "value": "active", "valueKind": "string" },
            { "line": 3, "name": "ARCHIVED", "value": "archived", "valueKind": "string" },
            { "line": 4, "name": "COUNT", "value": "1", "valueKind": "number" },
            { "line": 5, "name": "COMPUTED", "value": "statusValue", "valueKind": "unknown" }
        ])
    );

    let const_object = declaration("CompanyStatusValue");
    assert_eq!(const_object["kind"], "variable");
    assert_eq!(const_object["declarationKind"], "const");
    assert_eq!(const_object["initializer"]["kind"], "object");
    assert_eq!(const_object["initializer"]["asConst"], true);
    assert_eq!(
        const_object["initializer"]["satisfies"],
        "Record<string, string>"
    );
    assert_eq!(
        const_object["initializer"]["properties"],
        json!([
            { "line": 8, "key": "ACTIVE", "quoted": false, "value": "active", "valueKind": "string" },
            { "line": 9, "key": "ARCHIVED", "quoted": false, "value": "archived", "valueKind": "string" },
            { "line": 10, "key": "COUNT", "quoted": false, "value": "1", "valueKind": "number" },
            { "line": 11, "key": "ENABLED", "quoted": false, "value": "true", "valueKind": "boolean" }
        ])
    );

    assert_eq!(declaration("Mode")["kind"], "type");
    assert_eq!(declaration("loadCompany")["async"], true);
    assert_eq!(declaration("CompanyService")["kind"], "class");
    assert_eq!(declaration("CompanyContract")["kind"], "interface");
}

#[test]
fn extracts_python_facts_with_rustpython() {
    let root = test_root("python-facts");
    let project = open_test_project(&root);
    let source = [
        "import os",
        "from .tools import load as load_tool, helper",
        "",
        "class Service:",
        "    def method(self, value):",
        "        return os.path.join(str(value), helper())",
        "",
        "async def fetch(client, path):",
        "    def nested(item):",
        "        return load_tool(item)",
        "    return client.get(path)",
        "",
    ]
    .join("\n");
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "pkg/service.py",
                    "contentHash": "hash",
                    "language": "python",
                    "content": source
                }],
                "facts": ["imports", "symbols", "calls"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let facts = &parsed["files"][0];
    let symbols = facts["symbols"].as_array().unwrap();
    let symbol = |name: &str| {
        symbols
            .iter()
            .find(|symbol| symbol["name"] == name)
            .unwrap_or_else(|| panic!("missing python symbol {name}"))
    };

    assert_eq!(facts["parser"], "rustpython");
    assert_eq!(facts["imports"][0]["source"], "os");
    assert_eq!(facts["imports"][0]["specifiers"], json!(["os"]));
    assert_eq!(facts["imports"][1]["source"], ".tools");
    assert_eq!(
        facts["imports"][1]["specifiers"],
        json!(["load as load_tool", "helper"])
    );
    assert_eq!(symbol("Service")["kind"], "class");
    assert_eq!(symbol("Service")["line"], 4);
    assert_eq!(symbol("method")["kind"], "method");
    assert_eq!(symbol("method")["params"], json!(["self", "value"]));
    assert_eq!(symbol("fetch")["kind"], "function");
    assert_eq!(symbol("fetch")["params"], json!(["client", "path"]));
    assert_eq!(symbol("nested")["kind"], "function");

    let callees = facts["calls"]
        .as_array()
        .unwrap()
        .iter()
        .map(|call| call["callee"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        callees,
        vec!["os.path.join", "str", "helper", "load_tool", "client.get"]
    );
    assert_eq!(facts["calls"][0]["name"], "join");
    assert_eq!(facts["calls"][0]["receiver"], "os.path");
    assert_eq!(facts["calls"][0]["line"], 6);
}

#[test]
fn emits_python_columns_as_utf16_code_units() {
    let root = test_root("python-utf16-columns");
    let project = open_test_project(&root);
    let source = "café = identity(x)\n";
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "pkg/service.py",
                    "contentHash": "hash",
                    "language": "python",
                    "content": source
                }],
                "facts": ["calls"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let calls = parsed["files"][0]["calls"].as_array().unwrap();
    let call = calls
        .iter()
        .find(|call| call["callee"] == "identity")
        .expect("missing identity call");
    let utf16_column = "café = ".encode_utf16().count() + 1;
    let byte_column = "café = ".len() + 1;

    assert_eq!(utf16_column, 8);
    assert_eq!(byte_column, 9);
    assert_eq!(call["line"], 1);
    assert_eq!(call["column"].as_u64().unwrap(), utf16_column as u64);
    assert_ne!(call["column"].as_u64().unwrap(), byte_column as u64);
}

#[test]
fn extracts_python_call_try_depth_and_argument_calls() {
    let root = test_root("python-call-fields");
    let project = open_test_project(&root);
    let source = [
        "async def load(path):",
        "    try:",
        "        outer(inner(), await client.coro(), *spread_call())",
        "        try:",
        "            guarded(read_file(path))",
        "        except Exception:",
        "            handled(cleanup())",
        "        else:",
        "            success(done())",
        "        finally:",
        "            finalizer(close())",
        "    except Exception:",
        "        outside(handler_call())",
        "    finally:",
        "        complete(final_call())",
        "    after(no_try())",
        "",
    ]
    .join("\n");
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": "pkg/service.py",
                    "contentHash": "hash",
                    "language": "python",
                    "content": source
                }],
                "facts": ["calls"],
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    let calls = parsed["files"][0]["calls"].as_array().unwrap();
    let call = |callee: &str, line: u64| {
        calls
            .iter()
            .find(|call| call["callee"] == callee && call["line"] == line)
            .unwrap_or_else(|| panic!("missing python call {callee} on line {line}"))
    };

    assert_eq!(call("outer", 3)["tryDepth"], 1);
    assert_eq!(
        call("outer", 3)["argumentCalls"],
        json!([
            { "callee": "inner", "name": "inner", "awaited": false },
            { "callee": "client.coro", "name": "coro", "awaited": true },
            { "callee": "spread_call", "name": "spread_call", "awaited": false }
        ])
    );
    assert_eq!(call("guarded", 5)["tryDepth"], 2);
    assert_eq!(
        call("guarded", 5)["argumentCalls"],
        json!([{ "callee": "read_file", "name": "read_file", "awaited": false }])
    );
    assert_eq!(call("handled", 7)["tryDepth"], 1);
    assert_eq!(call("success", 9)["tryDepth"], 1);
    assert_eq!(call("finalizer", 11)["tryDepth"], 1);
    assert_eq!(call("outside", 13)["tryDepth"], 0);
    assert_eq!(call("complete", 15)["tryDepth"], 0);
    assert_eq!(call("after", 16)["tryDepth"], 0);
}

#[test]
fn extracts_literals_without_reclassifying_string_contents() {
    let root = test_root("literals");
    fs::create_dir_all(root.join("src")).unwrap();
    fs::write(
        root.join("src/company.ts"),
        [
            "export const CompanyStatus = {",
            "  ACTIVE: \"active\",",
            "  ARCHIVED: \"archived\",",
            "  NEGATIVE: -1,",
            "  ENABLED: true,",
            "} as const;",
            "export type Mode = \"on\" | \"off\";",
            "export const code = \"123\";",
            "export const enabledText = \"true\";",
            "export const count = 123;",
            "export const escaped = \"line\\n\";",
            "export function pick(value: string) {",
            "  it(\"loads active status\", () => {});",
            "  return value === \"active\" ? fn(\"argument\", [\"array-item\"]) : { status: \"object-value\" };",
            "}",
            "",
        ]
        .join("\n"),
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
    let literal = |value: &str, context: &str| {
        literals
            .iter()
            .find(|literal| literal["value"] == value && literal["context"] == context)
            .unwrap_or_else(|| panic!("missing literal {value} with context {context}"))
    };

    assert_eq!(string_literals.len(), 12);
    assert_eq!(number_literals.len(), 2);
    assert_eq!(boolean_literals.len(), 1);
    assert_eq!(literal("123", "unknown")["valueKind"], "string");
    assert_eq!(literal("true", "unknown")["valueKind"], "string");
    assert_eq!(literal("line\\n", "unknown")["valueKind"], "string");
    assert_eq!(literal("-1", "const-object")["valueKind"], "number");
    assert_eq!(
        literal("active", "const-object")["declarationSourceId"],
        "CompanyStatus"
    );
    assert_eq!(literal("on", "type-union")["declarationSourceId"], "Mode");
    assert_eq!(
        literal("active", "comparison")["declarationSourceId"],
        Value::Null
    );
    assert_eq!(literal("argument", "argument")["valueKind"], "string");
    assert_eq!(literal("array-item", "array-item")["valueKind"], "string");
    assert_eq!(
        literal("object-value", "object-property")["valueKind"],
        "string"
    );
    assert_eq!(
        literal("loads active status", "test-title")["valueKind"],
        "string"
    );
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
    let state_path = root.join(".opencanon/state.sqlite");
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

#[test]
fn migration_004_applies_and_creates_observability_tables() {
    let root = test_root("graph-migration");
    let project = open_test_project(&root);
    let status = project.status_json().unwrap();
    let parsed: Value = serde_json::from_str(&status).unwrap();
    let migrations = parsed["migrationsApplied"].as_array().unwrap();
    assert!(migrations.iter().any(|version| version.as_u64() == Some(3)));
    assert!(migrations.iter().any(|version| version.as_u64() == Some(4)));
    assert!(migrations.iter().any(|version| version.as_u64() == Some(5)));
    assert!(migrations.iter().any(|version| version.as_u64() == Some(6)));
    assert_eq!(parsed["schemaVersion"].as_u64(), Some(6));
}

#[test]
fn observability_records_round_trip_and_filter_by_trace() {
    let root = test_root("observability-records");
    let project = open_test_project(&root);

    project
        .write_observability_records_json(
            json!({
                "traces": [{
                    "id": "1234567890abcdef1234567890abcdef",
                    "name": "doctor.run",
                    "status": "ok",
                    "recording": true,
                    "sampled": true,
                    "startedAt": "2026-06-06T00:00:00.000Z",
                    "endedAt": "2026-06-06T00:00:00.010Z",
                    "durationMs": 10,
                    "attributes": { "command": "doctor" },
                    "traceFlags": "01"
                }],
                "spans": [{
                    "id": "1234567890abcdef",
                    "traceId": "1234567890abcdef1234567890abcdef",
                    "name": "doctor.check",
                    "kind": "task",
                    "otelKind": "INTERNAL",
                    "status": "ok",
                    "recording": true,
                    "sampled": true,
                    "startedAt": "2026-06-06T00:00:00.001Z",
                    "endedAt": "2026-06-06T00:00:00.009Z",
                    "durationMs": 8,
                    "traceParent": "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
                    "traceFlags": "01",
                    "attributes": { "check": "state" },
                    "output": { "findings": 0 }
                }],
                "events": [{
                    "id": "event_1",
                    "traceId": "1234567890abcdef1234567890abcdef",
                    "spanId": "1234567890abcdef",
                    "name": "doctor.check.completed",
                    "occurredAt": "2026-06-06T00:00:00.008Z",
                    "traceFlags": "01",
                    "sampled": true,
                    "attributes": { "status": "pass" }
                }]
            })
            .to_string(),
        )
        .unwrap();

    let output = project
        .list_observability_records_json(
            json!({
                "traceId": "1234567890abcdef1234567890abcdef",
                "limit": 10
            })
            .to_string(),
        )
        .unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["traces"][0]["name"], "doctor.run");
    assert_eq!(parsed["spans"][0]["output"]["findings"], 0);
    assert_eq!(parsed["events"][0]["name"], "doctor.check.completed");

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    let span_count: i64 = conn
        .query_row(
            "select count(*) from observability_spans where root_dir = ?1",
            [root.to_string_lossy().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(span_count, 1);

    let invalid = project.write_observability_records_json(
        json!({
            "spans": [{
                "id": "1234567890abcdef",
                "traceId": "1234567890abcdef1234567890abcdef",
                "name": "invalid",
                "kind": "task",
                "otelKind": "INTERNAL",
                "status": "ok",
                "recording": true,
                "sampled": true,
                "startedAt": "2026-06-06T00:00:00.001Z",
                "traceParent": "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1234567890abcdef-01",
                "traceFlags": "01",
                "attributes": {}
            }]
        })
        .to_string(),
    );
    assert!(invalid
        .unwrap_err()
        .to_string()
        .contains("invalid-observability-record"));
}

#[test]
fn semantic_index_round_trips_metadata_and_searches_vectors() {
    let root = test_root("semantic-index");
    let project = open_test_project(&root);

    project
        .write_semantic_index_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v1",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-local-hash",
                        "kind": "local",
                        "modelId": "opencanon-local-hash-2",
                        "dimensions": 2,
                        "distance": "cosine",
                        "configHash": "config"
                    },
                    "chunkerVersion": "chunker",
                    "producerVersion": "producer",
                    "sourceInventoryHash": "inventory",
                    "chunkTreeHash": "chunk-tree-one",
                    "identityHash": "identity",
                    "chunkCount": 2,
                    "vectorCount": 2,
                    "staleChunkCount": 0,
                    "embeddingStats": {
                        "totalChunks": 2,
                        "embeddedChunks": 2,
                        "reusedChunks": 0
                    },
                    "indexedAt": "2026-06-06T00:00:00.000Z",
                    "diagnostics": []
                },
                "chunks": [
                    {
                        "metadata": {
                            "id": "chunk:one",
                            "path": "src/company.ts",
                            "contentHash": "content-one",
                            "chunkHash": "chunk-one",
                            "embeddingHash": "embedding-one",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 10, "byte": 10 }
                            },
                            "tokenEstimate": 2,
                            "preview": "active company"
                        },
                        "text": "active company billing loader",
                        "vector": [1.0, 0.0]
                    },
                    {
                        "metadata": {
                            "id": "chunk:two",
                            "path": "src/other.ts",
                            "contentHash": "content-two",
                            "chunkHash": "chunk-two",
                            "embeddingHash": "embedding-two",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 10, "byte": 10 }
                            },
                            "tokenEstimate": 2,
                            "preview": "other record"
                        },
                        "text": "other record",
                        "vector": [0.0, 1.0]
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();

    let status = project
        .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
        .unwrap();
    let status: Value = serde_json::from_str(&status).unwrap();
    assert_eq!(status["index"]["chunkCount"], 2);
    assert_eq!(status["index"]["embeddingStats"]["embeddedChunks"], 2);
    assert_eq!(status["index"]["embeddingStats"]["reusedChunks"], 0);
    assert_eq!(
        status["index"]["provider"]["modelId"],
        "opencanon-local-hash-2"
    );

    let search = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "query": "active company",
                "vector": [1.0, 0.0],
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let search: Value = serde_json::from_str(&search).unwrap();
    assert_eq!(search["results"][0]["chunk"]["path"], "src/company.ts");
    assert_eq!(search["results"][0]["scores"]["lexical"], 1.0);

    let lexical = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "query": "billing loader",
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let lexical: Value = serde_json::from_str(&lexical).unwrap();
    assert_eq!(lexical["results"][0]["chunk"]["path"], "src/company.ts");

    let filtered = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "vector": [1.0, 0.0],
                "paths": ["src/other.ts"],
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let filtered: Value = serde_json::from_str(&filtered).unwrap();
    assert_eq!(filtered["results"][0]["chunk"]["path"], "src/other.ts");

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    let chunk_count: i64 = conn
        .query_row("select count(*) from semantic_chunks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(chunk_count, 2);

    let reuse_request = json!({
        "index": {
            "id": "project",
            "version": "semantic-index-v1",
            "status": "ready",
            "provider": {
                "id": "opencanon-local-hash",
                "kind": "local",
                "modelId": "opencanon-local-hash-2",
                "dimensions": 2,
                "distance": "cosine",
                "configHash": "config"
            },
            "chunkerVersion": "chunker",
            "producerVersion": "producer",
            "sourceInventoryHash": "inventory-reused",
            "chunkTreeHash": "chunk-tree-reused",
            "identityHash": "identity",
            "chunkCount": 2,
            "vectorCount": 2,
            "staleChunkCount": 0,
            "embeddingStats": {
                "totalChunks": 2,
                "embeddedChunks": 0,
                "reusedChunks": 2
            },
            "indexedAt": "2026-06-06T00:00:00.500Z",
            "diagnostics": []
        },
        "chunks": [
            {
                "metadata": {
                    "id": "chunk:one",
                    "path": "src/company.ts",
                    "contentHash": "content-one",
                    "chunkHash": "chunk-one",
                    "embeddingHash": "embedding-one",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 10, "byte": 10 }
                    },
                    "tokenEstimate": 2,
                    "preview": "active company"
                },
                "text": "active company billing loader",
                "vector": []
            },
            {
                "metadata": {
                    "id": "chunk:two",
                    "path": "src/other.ts",
                    "contentHash": "content-two",
                    "chunkHash": "chunk-two",
                    "embeddingHash": "embedding-two",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 10, "byte": 10 }
                    },
                    "tokenEstimate": 2,
                    "preview": "other record"
                },
                "text": "other record",
                "vector": []
            }
        ]
    });
    project
        .write_semantic_index_json(reuse_request.to_string())
        .unwrap();
    let reused_search = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "vector": [1.0, 0.0],
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let reused_search: Value = serde_json::from_str(&reused_search).unwrap();
    assert_eq!(
        reused_search["results"][0]["chunk"]["path"],
        "src/company.ts"
    );
    let reused_status = project
        .read_semantic_index_status_json(json!({ "indexId": "project" }).to_string())
        .unwrap();
    let reused_status: Value = serde_json::from_str(&reused_status).unwrap();
    assert_eq!(
        reused_status["index"]["embeddingStats"]["embeddedChunks"],
        0
    );
    assert_eq!(reused_status["index"]["embeddingStats"]["reusedChunks"], 2);

    let mut invalid_reuse = reuse_request.clone();
    invalid_reuse["chunks"][0]["metadata"]["embeddingHash"] = json!("embedding-one-updated");
    invalid_reuse["index"]["sourceInventoryHash"] = json!("inventory-invalid");
    invalid_reuse["index"]["indexedAt"] = json!("2026-06-06T00:00:00.750Z");
    let invalid_error = project
        .write_semantic_index_json(invalid_reuse.to_string())
        .unwrap_err();
    assert!(invalid_error
        .to_string()
        .contains("cannot reuse a missing or changed vector"));

    project
        .write_semantic_index_json(
            json!({
                "index": {
                    "id": "project",
                    "version": "semantic-index-v1",
                    "status": "ready",
                    "provider": {
                        "id": "opencanon-local-hash",
                        "kind": "local",
                        "modelId": "opencanon-local-hash-2",
                        "dimensions": 2,
                        "distance": "cosine",
                        "configHash": "config"
                    },
                    "chunkerVersion": "chunker",
                    "producerVersion": "producer",
                    "sourceInventoryHash": "inventory-two",
                    "chunkTreeHash": "chunk-tree-two",
                    "identityHash": "identity",
                    "chunkCount": 1,
                    "vectorCount": 1,
                    "staleChunkCount": 0,
                    "indexedAt": "2026-06-06T00:00:01.000Z",
                    "diagnostics": []
                },
                "chunks": [
                    {
                        "metadata": {
                            "id": "chunk:two",
                            "path": "src/other.ts",
                            "contentHash": "content-two",
                            "chunkHash": "chunk-two",
                            "embeddingHash": "embedding-two",
                            "kind": "file",
                            "language": "typescript",
                            "ordinal": 0,
                            "range": {
                                "start": { "line": 1, "column": 1, "byte": 0 },
                                "end": { "line": 1, "column": 10, "byte": 10 }
                            },
                            "tokenEstimate": 2,
                            "preview": "other record"
                        },
                        "text": "other record",
                        "vector": [0.0, 1.0]
                    }
                ]
            })
            .to_string(),
        )
        .unwrap();

    let chunk_count: i64 = conn
        .query_row("select count(*) from semantic_chunks", [], |row| row.get(0))
        .unwrap();
    assert_eq!(chunk_count, 1);

    let invalid = project.search_semantic_index_json(
        json!({
            "indexId": "project",
            "vector": [1.0, 0.0, 0.0],
            "limit": 1
        })
        .to_string(),
    );
    assert!(invalid
        .unwrap_err()
        .to_string()
        .contains("dimension mismatch"));
}

#[test]
fn semantic_index_recovers_when_vector_store_has_stale_duplicate_id() {
    let root = test_root("semantic-index-stale-vector-id");
    let project = open_test_project(&root);
    let request = json!({
        "index": {
            "id": "project",
            "version": "semantic-index-v1",
            "status": "ready",
            "provider": {
                "id": "opencanon-local-hash",
                "kind": "local",
                "modelId": "opencanon-local-hash-2",
                "dimensions": 2,
                "distance": "cosine",
                "configHash": "config"
            },
            "chunkerVersion": "chunker",
            "producerVersion": "producer",
            "sourceInventoryHash": "inventory",
            "chunkTreeHash": "chunk-tree",
            "identityHash": "identity",
            "chunkCount": 1,
            "vectorCount": 1,
            "staleChunkCount": 0,
            "embeddingStats": {
                "totalChunks": 1,
                "embeddedChunks": 1,
                "reusedChunks": 0
            },
            "indexedAt": "2026-06-06T00:00:00.000Z",
            "diagnostics": []
        },
        "chunks": [
            {
                "metadata": {
                    "id": "chunk:stale",
                    "path": "src/company.ts",
                    "contentHash": "content-one",
                    "chunkHash": "chunk-one",
                    "embeddingHash": "embedding-one",
                    "kind": "file",
                    "language": "typescript",
                    "ordinal": 0,
                    "range": {
                        "start": { "line": 1, "column": 1, "byte": 0 },
                        "end": { "line": 1, "column": 10, "byte": 10 }
                    },
                    "tokenEstimate": 2,
                    "preview": "active company"
                },
                "text": "active company billing loader",
                "vector": [1.0, 0.0]
            }
        ]
    });

    project
        .write_semantic_index_json(request.to_string())
        .unwrap();

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    conn.execute("delete from semantic_chunks where id = 'chunk:stale'", [])
        .unwrap();
    conn.execute(
        "delete from semantic_chunks_fts where id = 'chunk:stale'",
        [],
    )
    .unwrap();

    project
        .write_semantic_index_json(request.to_string())
        .unwrap();

    let search = project
        .search_semantic_index_json(
            json!({
                "indexId": "project",
                "query": "active company",
                "vector": [1.0, 0.0],
                "limit": 1
            })
            .to_string(),
        )
        .unwrap();
    let search: Value = serde_json::from_str(&search).unwrap();
    assert_eq!(search["results"][0]["chunk"]["id"], "chunk:stale");
}

#[test]
fn semantic_embedding_rejects_invalid_requests_before_loading_model() {
    let root = test_root("semantic-embedding-invalid");
    let project = open_test_project(&root);

    let missing_texts = project.embed_semantic_texts_json(
        json!({
            "modelId": "jina-code-v2",
            "task": "document",
            "texts": []
        })
        .to_string(),
    );
    assert!(missing_texts
        .unwrap_err()
        .to_string()
        .contains("at least one text"));

    let invalid_task = project.embed_semantic_texts_json(
        json!({
            "modelId": "jina-code-v2",
            "task": "other",
            "texts": ["company"]
        })
        .to_string(),
    );
    assert!(invalid_task
        .unwrap_err()
        .to_string()
        .contains("document or query"));
}

#[test]
fn generation_rejects_invalid_requests_before_loading_model() {
    let root = test_root("generation-invalid");
    let project = open_test_project(&root);

    let missing_prompt = project.generate_text_json(
        json!({
            "modelId": "qwen-coder-0.5b",
            "prompt": "",
            "showDownloadProgress": false
        })
        .to_string(),
    );
    assert!(missing_prompt
        .unwrap_err()
        .to_string()
        .contains("prompt is required"));

    let invalid_temperature = project.generate_text_json(
        json!({
            "modelId": "qwen-coder-0.5b",
            "prompt": "Plan the change.",
            "temperature": 3,
            "showDownloadProgress": false
        })
        .to_string(),
    );
    assert!(invalid_temperature
        .unwrap_err()
        .to_string()
        .contains("temperature"));
}

#[test]
fn stale_product_model_projection_schema_is_recreated() {
    let root = test_root("stale-product-model-projection");
    let state_path = root.join(".opencanon/state.sqlite");
    {
        let project = open_test_project(&root);
        drop(project);
    }
    let conn = Connection::open(&state_path).unwrap();
    conn.execute_batch(
        "drop table product_model_diagnostics;
        drop table product_model_edges;
        drop table product_model_nodes;
        drop table product_model_snapshots;
        create table product_model_snapshots (
          root_dir text primary key,
          graph_hash text not null,
          definitions_hash text not null,
          area_count integer not null default 0,
          change_count integer not null default 0,
          convention_count integer not null default 0,
          impact_surface_count integer not null default 0,
          validator_count integer not null default 0,
          node_count integer not null default 0,
          edge_count integer not null default 0,
          diagnostic_count integer not null default 0,
          payload text not null,
          indexed_at text not null
        );
        create table product_model_nodes (
          root_dir text not null,
          id text not null,
          kind text not null,
          label text not null,
          payload text not null,
          indexed_at text not null,
          primary key(root_dir, id)
        );
        create table product_model_edges (
          root_dir text not null,
          id text not null,
          from_node_id text not null,
          to_node_id text not null,
          kind text not null,
          label text,
          payload text not null,
          indexed_at text not null,
          primary key(root_dir, id)
        );
        create table product_model_diagnostics (
          root_dir text not null,
          id text not null,
          severity text not null,
          code text not null,
          from_node_id text,
          to_node_id text,
          message text not null,
          payload text not null,
          indexed_at text not null,
          primary key(root_dir, id)
        );",
    )
    .unwrap();
    drop(conn);

    let project = open_project_json(
        json!({
            "rootDir": root,
            "statePath": state_path,
            "settings": test_settings()
        })
        .to_string(),
    )
    .unwrap();

    project
        .write_product_model_projection_json(
            json!({
                "projection": {
                    "indexedAt": "2026-06-06T00:00:00.000Z",
                    "graphHash": "graph-hash",
                    "definitionsHash": "definitions-hash",
                    "counts": {
                        "areas": 0,
                        "specs": 1,
                        "changes": 0,
                        "conventions": 0,
                        "impactSurfaces": 0,
                        "validators": 0,
                        "nodes": 0,
                        "edges": 0,
                        "diagnostics": 0
                    },
                    "definitionGraph": {
                        "nodes": [],
                        "edges": [],
                        "diagnostics": [],
                        "backlinks": {
                            "areaToSurfaces": {},
                            "specToSurfaces": {},
                            "changeToSurfaces": {},
                            "surfaceToAreas": {},
                            "surfaceToSpecs": {},
                            "surfaceToChanges": {},
                            "surfaceToConventions": {}
                        }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
}

#[test]
fn product_model_projection_round_trips_and_indexes_rows() {
    let root = test_root("product-model-projection");
    let project = open_test_project(&root);

    project
        .write_product_model_projection_json(
            json!({
                "projection": {
                    "indexedAt": "2026-06-06T00:00:00.000Z",
                    "graphHash": "graph-hash",
                    "definitionsHash": "definitions-hash",
                    "counts": {
                        "areas": 1,
                        "specs": 1,
                        "changes": 1,
                        "conventions": 1,
                        "impactSurfaces": 1,
                        "validators": 1,
                        "nodes": 2,
                        "edges": 1,
                        "diagnostics": 1
                    },
                    "areas": [{ "id": "desktop-health" }],
                    "specs": [{ "id": "desktop-health-spec" }],
                    "changes": [{ "id": "area-change-model" }],
                    "conventions": [{ "id": "service-db-boundary" }],
                    "impactSurfaces": [{ "id": "company-read-model" }],
                    "validators": [{ "id": "no-route-dal-import" }],
                    "definitionGraph": {
                        "nodes": [
                            { "id": "area:desktop-health", "kind": "area", "label": "Desktop Health" },
                            { "id": "impact-surface:company-read-model", "kind": "impact-surface", "label": "Company Read Model" }
                        ],
                        "edges": [
                            {
                                "from": "area:desktop-health",
                                "to": "impact-surface:company-read-model",
                                "kind": "touches",
                                "label": "derived"
                            }
                        ],
                        "diagnostics": [
                            {
                                "severity": "warning",
                                "code": "area-implicit-impact-surface",
                                "message": "Area owns files in an impact surface.",
                                "from": "area:desktop-health",
                                "to": "impact-surface:company-read-model"
                            }
                        ],
                        "backlinks": {
                            "areaToSurfaces": { "desktop-health": ["company-read-model"] },
                            "specToSurfaces": { "desktop-health-spec": ["company-read-model"] },
                            "changeToSurfaces": {},
                            "surfaceToAreas": { "company-read-model": ["desktop-health"] },
                            "surfaceToSpecs": { "company-read-model": ["desktop-health-spec"] },
                            "surfaceToChanges": {},
                            "surfaceToConventions": {}
                        }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();

    let output = project.read_product_model_projection_json().unwrap();
    let parsed: Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["projection"]["graphHash"], "graph-hash");
    assert_eq!(
        parsed["projection"]["definitionGraph"]["edges"][0]["kind"],
        "touches"
    );

    let conn = Connection::open(root.join(".opencanon/state.sqlite")).unwrap();
    let node_count: i64 = conn
        .query_row(
            "select count(*) from product_model_nodes where root_dir = ?1",
            [root.to_string_lossy().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    let edge_count: i64 = conn
        .query_row(
            "select count(*) from product_model_edges where root_dir = ?1",
            [root.to_string_lossy().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    let diagnostic_count: i64 = conn
        .query_row(
            "select count(*) from product_model_diagnostics where root_dir = ?1",
            [root.to_string_lossy().to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(node_count, 2);
    assert_eq!(edge_count, 1);
    assert_eq!(diagnostic_count, 1);
}

fn extract_svelte_facts(name: &str, path: &str, source: &str, requested: &[&str]) -> Value {
    let root = test_root(name);
    let project = open_test_project(&root);
    let content_hash = blake3::hash(source.as_bytes()).to_hex().to_string();
    let output = project
        .extract_facts_json(
            json!({
                "files": [{
                    "path": path,
                    "contentHash": content_hash,
                    "language": "svelte",
                    "content": source
                }],
                "facts": requested,
                "parserVersion": "test-parser"
            })
            .to_string(),
        )
        .unwrap();

    serde_json::from_str(&output).unwrap()
}

fn fact_named<'a>(facts: &'a [Value], name: &str) -> &'a Value {
    fact_by(facts, "name", name)
}

fn fact_by<'a>(facts: &'a [Value], key: &str, value: &str) -> &'a Value {
    facts
        .iter()
        .find(|fact| fact[key] == value)
        .unwrap_or_else(|| panic!("missing fact with {key}={value}"))
}

fn symbol_names(symbols: &[Value]) -> Vec<String> {
    symbols
        .iter()
        .map(|symbol| symbol["name"].as_str().unwrap().to_string())
        .collect()
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
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
        fixtures_dir: "opencanon/fixtures".to_string(),
        project_file_patterns: vec!["src/**/*.ts".to_string(), "tests/**/*.ts".to_string()],
        ignore: vec!["coverage/**".to_string(), ".opencanon/**".to_string()],
        max_files: 20_000,
        max_file_size_kb: 512,
        file_discovery: "filesystem".to_string(),
        config_hash: "hash".to_string(),
    }
}
