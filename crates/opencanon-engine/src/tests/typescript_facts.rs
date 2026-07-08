use std::fs;

use serde_json::{json, Value};

use super::support::*;

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
