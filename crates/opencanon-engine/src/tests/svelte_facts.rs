use serde_json::json;

use super::support::*;

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
