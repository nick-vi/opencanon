use serde_json::{json, Value};

use super::support::{open_test_project, test_root, test_settings};
use crate::open_project_json;

fn protocol_event(revision: u64, summary: &str) -> Value {
    json!({
        "protocolVersion": 1,
        "timestamp": format!("2026-07-16T14:00:{revision:02}.000Z"),
        "revision": revision,
        "domain": "project",
        "type": "published",
        "summary": summary,
        "ids": []
    })
}

fn canon_event(id: &str) -> Value {
    json!({
        "id": id,
        "type": "indexed",
        "timestamp": "2026-07-16T14:00:02.000Z",
        "files": [],
        "changeIds": [],
        "taskIds": [],
        "checkIds": [],
        "conventionIds": [],
        "validatorIds": [],
        "findingIds": [],
        "summary": "Published Project State."
    })
}

fn product_model(graph_hash: &str, symbol_id: &str) -> Value {
    json!({
        "indexedAt": "2026-07-16T14:00:02.000Z",
        "graphHash": graph_hash,
        "definitionsHash": "definitions",
        "counts": {
            "areas": 0,
            "specs": 0,
            "changes": 0,
            "conventions": 0,
            "impactSurfaces": 0,
            "validators": 0,
            "nodes": 1,
            "edges": 0,
            "diagnostics": 0
        },
        "areas": [],
        "specs": [],
        "changes": [],
        "conventions": [],
        "impactSurfaces": [],
        "validators": [],
        "definitionGraph": {
            "nodes": [{ "id": symbol_id, "kind": "symbol", "label": symbol_id }],
            "edges": [],
            "diagnostics": [],
            "fileCoverage": {},
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
    })
}

fn stage_graph(project: &crate::EngineProjectHandle, generation: &str, symbol: &str) {
    project
        .stage_code_graph_json_sync(
            json!({
                "generation": generation,
                "files": [{
                    "path": "src/index.ts",
                    "contentHash": generation,
                    "language": "typescript",
                    "content": format!("export const {symbol} = 1;")
                }],
                "parserVersion": "publication-test",
                "extractorVersion": "publication-test"
            })
            .to_string(),
        )
        .unwrap();
}

fn publish(
    project: &crate::EngineProjectHandle,
    revision: u64,
    generation: Option<&str>,
    product_model: Option<Value>,
    canon_event: Option<Value>,
) -> napi::Result<Value> {
    let result = project.publish_project_state_json(
        json!({
            "revision": revision,
            "codeGraphGeneration": generation,
            "productModel": product_model,
            "canonEvent": canon_event,
            "protocolEvent": protocol_event(revision, "Published Project State."),
            "maxProtocolEventCount": 100,
            "retainProtocolEventsAfter": "2026-07-01T00:00:00.000Z"
        })
        .to_string(),
    )?;
    Ok(serde_json::from_str(&result).unwrap())
}

#[test]
fn publication_commits_projection_events_revision_and_graph_visibility_together() {
    let root = test_root("project-publication-commit");
    let project = open_test_project(&root);
    let initial: Value =
        serde_json::from_str(&project.read_project_publication_json().unwrap()).unwrap();
    assert_eq!(initial["revision"], 1);

    stage_graph(&project, "generation-two", "publishedSymbol");
    let result = publish(
        &project,
        2,
        Some("generation-two"),
        Some(product_model("graph-two", "published-symbol")),
        Some(canon_event("indexed-two")),
    )
    .unwrap();
    assert_eq!(result["publication"]["revision"], 2);
    assert_eq!(
        result["publication"]["activeCodeGraphGeneration"],
        "generation-two"
    );
    assert_eq!(result["event"]["sequence"], 1);
    assert!(project
        .search_symbols_json(json!({ "query": "publishedSymbol" }).to_string())
        .unwrap()
        .contains("publishedSymbol"));
    let events: Value = serde_json::from_str(
        &project
            .list_protocol_events_json(json!({ "afterSequence": 0, "limit": 10 }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(events["events"].as_array().unwrap().len(), 1);
    drop(project);

    let reopened = open_test_project(&root);
    let persisted: Value =
        serde_json::from_str(&reopened.read_project_publication_json().unwrap()).unwrap();
    assert_eq!(persisted["revision"], 2);
    assert!(reopened
        .search_symbols_json(json!({ "query": "publishedSymbol" }).to_string())
        .unwrap()
        .contains("publishedSymbol"));

    let unchanged = publish(&reopened, 3, None, None, None).unwrap();
    assert_eq!(unchanged["publication"]["revision"], 3);
    assert_eq!(
        unchanged["publication"]["activeCodeGraphGeneration"],
        "generation-two"
    );
}

#[test]
fn failed_publication_rolls_back_every_durable_output_and_preserves_active_graph() {
    let root = test_root("project-publication-rollback");
    let project = open_test_project(&root);
    stage_graph(&project, "accepted", "acceptedSymbol");
    publish(
        &project,
        2,
        Some("accepted"),
        Some(product_model("accepted-graph", "accepted-symbol")),
        Some(canon_event("accepted-event")),
    )
    .unwrap();
    stage_graph(&project, "rejected", "rejectedSymbol");

    let error = publish(
        &project,
        3,
        Some("rejected"),
        Some(product_model("rejected-graph", "rejected-symbol")),
        Some(json!({ "type": "indexed", "timestamp": "2026-07-16T14:00:03.000Z" })),
    )
    .unwrap_err();
    assert!(error.to_string().contains("Canon event is missing id"));

    let publication: Value =
        serde_json::from_str(&project.read_project_publication_json().unwrap()).unwrap();
    assert_eq!(publication["revision"], 2);
    assert_eq!(publication["activeCodeGraphGeneration"], "accepted");
    assert!(project
        .search_symbols_json(json!({ "query": "acceptedSymbol" }).to_string())
        .unwrap()
        .contains("acceptedSymbol"));
    assert!(!project
        .search_symbols_json(json!({ "query": "rejectedSymbol" }).to_string())
        .unwrap()
        .contains("rejectedSymbol"));
    let projection: Value =
        serde_json::from_str(&project.read_product_model_projection_json().unwrap()).unwrap();
    assert_eq!(projection["projection"]["graphHash"], "accepted-graph");
    let events: Value = serde_json::from_str(
        &project
            .list_protocol_events_json(json!({ "afterSequence": 0, "limit": 10 }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(events["events"].as_array().unwrap().len(), 1);
}

#[test]
fn publication_rejects_non_monotonic_revision_without_writes() {
    let root = test_root("project-publication-revision");
    let project = open_test_project(&root);
    let accepted = publish(&project, 4, None, None, None).unwrap();
    assert_eq!(accepted["publication"]["revision"], 4);
    let error = publish(&project, 4, None, None, None).unwrap_err();
    assert!(error
        .to_string()
        .contains("Project State publication revision must be greater than 4; received 4"));
    let publication: Value =
        serde_json::from_str(&project.read_project_publication_json().unwrap()).unwrap();
    assert_eq!(publication["revision"], 4);
    let events: Value = serde_json::from_str(
        &project
            .list_protocol_events_json(json!({ "afterSequence": 0, "limit": 10 }).to_string())
            .unwrap(),
    )
    .unwrap();
    assert_eq!(events["events"].as_array().unwrap().len(), 1);
}

#[test]
fn analysis_state_stages_into_the_serving_graph_owner_without_publication_authority() {
    let root = test_root("project-publication-owner");
    let serving_state_path = root.join(".opencanon/state/test/state.sqlite");
    let analysis_state_path = root.join(".opencanon/state/test/analysis.sqlite");
    let serving = open_test_project(&root);
    let analysis = open_project_json(
        json!({
            "rootDir": root,
            "statePath": analysis_state_path,
            "codeGraphStatePath": serving_state_path,
            "settings": test_settings()
        })
        .to_string(),
    )
    .unwrap();

    stage_graph(&analysis, "worker-generation", "workerSymbol");
    publish(
        &serving,
        2,
        Some("worker-generation"),
        Some(product_model("worker-graph", "worker-symbol")),
        None,
    )
    .unwrap();
    assert!(serving
        .search_symbols_json(json!({ "query": "workerSymbol" }).to_string())
        .unwrap()
        .contains("workerSymbol"));

    let error = publish(&analysis, 2, None, None, None).unwrap_err();
    assert!(error
        .to_string()
        .contains("Only the serving Project State owner can publish Project State"));
}
