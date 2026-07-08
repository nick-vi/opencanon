use serde_json::{json, Value};

use super::support::*;

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
