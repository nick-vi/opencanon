use rusqlite::Connection;
use serde_json::{json, Value};

use super::support::*;
use crate::open_project_json;

#[test]
fn stale_product_model_projection_schema_is_recreated() {
    let root = test_root("stale-product-model-projection");
    let state_path = root.join(".opencanon/state/test/state.sqlite");
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

    let conn = Connection::open(root.join(".opencanon/state/test/state.sqlite")).unwrap();
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
