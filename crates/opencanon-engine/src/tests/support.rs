use std::fs;

use serde_json::{json, Value};

use crate::contracts::ResolvedProjectSettings;
use crate::{open_project_json, EngineProjectHandle};

pub(super) fn extract_svelte_facts(
    name: &str,
    path: &str,
    source: &str,
    requested: &[&str],
) -> Value {
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

pub(super) fn fact_named<'a>(facts: &'a [Value], name: &str) -> &'a Value {
    fact_by(facts, "name", name)
}

pub(super) fn fact_by<'a>(facts: &'a [Value], key: &str, value: &str) -> &'a Value {
    facts
        .iter()
        .find(|fact| fact[key] == value)
        .unwrap_or_else(|| panic!("missing fact with {key}={value}"))
}

pub(super) fn symbol_names(symbols: &[Value]) -> Vec<String> {
    symbols
        .iter()
        .map(|symbol| symbol["name"].as_str().unwrap().to_string())
        .collect()
}

pub(super) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

pub(super) fn test_root(name: &str) -> std::path::PathBuf {
    let root = std::env::temp_dir().join(format!("opencanon-engine-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    root
}

pub(super) fn open_test_project(root: &std::path::Path) -> EngineProjectHandle {
    open_project_json(
        json!({
            "rootDir": root,
            "statePath": root.join(".opencanon/state/test/state.sqlite"),
            "settings": test_settings()
        })
        .to_string(),
    )
    .unwrap()
}

pub(super) fn test_settings() -> ResolvedProjectSettings {
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
