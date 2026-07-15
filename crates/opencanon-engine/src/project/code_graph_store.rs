use std::collections::{HashMap, HashSet};
use std::fs;

use rusqlite::params;
use serde_json::json;

use crate::code_graph::{
    compute_node_id, compute_unresolved_id, language_is_supported, CodeExtractionInput,
    CodeExtractor, ExtractedNode, ExtractedUnresolved, OxcExtractor, PythonExtractor,
};
use crate::constants::{EXTRACTOR_VERSION, PARSER_VERSION};
use crate::contracts::{
    IndexCodeGraphRequest, SearchGraphEdgesRequest, SearchReferencesRequest, SearchSymbolsRequest,
};
use crate::json::{decode, encode, napi_error, sqlite_error};
use crate::state::timestamp;

use super::code_graph_resolver::resolve_exact_code_edges;
use super::json_fields::root_path;
use super::EngineProjectHandle;

#[allow(clippy::too_many_arguments)]
pub(super) fn insert_code_node(
    tx: &rusqlite::Transaction<'_>,
    path: &str,
    language: &str,
    content_hash: &str,
    extractor_version: &str,
    indexed_at: &str,
    node: &ExtractedNode,
) -> napi::Result<()> {
    let id = compute_node_id(
        path,
        language,
        &node.kind,
        &node.qualified_name,
        node.range.start_byte,
        &node.disambiguator,
    );
    tx.execute(
        "insert into code_nodes(id, path, language, kind, name, qualified_name, exported, signature,
            start_line, start_column, end_line, end_column, start_byte, end_byte,
            content_hash, extractor_version, indexed_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
         on conflict(id) do update set path = excluded.path, language = excluded.language,
            kind = excluded.kind, name = excluded.name, qualified_name = excluded.qualified_name,
            exported = excluded.exported, signature = excluded.signature,
            start_line = excluded.start_line, start_column = excluded.start_column,
            end_line = excluded.end_line, end_column = excluded.end_column,
            start_byte = excluded.start_byte, end_byte = excluded.end_byte,
            content_hash = excluded.content_hash, extractor_version = excluded.extractor_version,
            indexed_at = excluded.indexed_at",
        params![
            id,
            path,
            language,
            node.kind,
            node.name,
            node.qualified_name,
            if node.exported { 1 } else { 0 },
            node.signature,
            node.range.start_line as i64,
            node.range.start_column as i64,
            node.range.end_line as i64,
            node.range.end_column as i64,
            node.range.start_byte as i64,
            node.range.end_byte as i64,
            content_hash,
            extractor_version,
            indexed_at,
        ],
    )
    .map_err(|error| sqlite_error("Could not insert code node", error))?;
    Ok(())
}

pub(super) fn code_symbol_json(
    row: &rusqlite::Row<'_>,
    offset: usize,
) -> rusqlite::Result<serde_json::Value> {
    Ok(json!({
      "id": row.get::<_, String>(offset)?,
      "path": row.get::<_, String>(offset + 1)?,
      "language": row.get::<_, String>(offset + 2)?,
      "kind": row.get::<_, String>(offset + 3)?,
      "name": row.get::<_, String>(offset + 4)?,
      "qualifiedName": row.get::<_, String>(offset + 5)?,
      "exported": row.get::<_, i64>(offset + 6)? != 0,
      "signature": row.get::<_, Option<String>>(offset + 7)?,
      "range": {
        "start": {
          "line": row.get::<_, i64>(offset + 8)?,
          "column": row.get::<_, i64>(offset + 9)?,
          "byte": row.get::<_, i64>(offset + 10)?,
        },
        "end": {
          "line": row.get::<_, i64>(offset + 11)?,
          "column": row.get::<_, i64>(offset + 12)?,
          "byte": row.get::<_, i64>(offset + 13)?,
        },
      },
      "score": null,
    }))
}

#[allow(clippy::too_many_arguments)]
pub(super) fn insert_unresolved_reference(
    tx: &rusqlite::Transaction<'_>,
    path: &str,
    language: &str,
    content_hash: &str,
    extractor_version: &str,
    indexed_at: &str,
    unresolved: &ExtractedUnresolved,
) -> napi::Result<()> {
    let id = compute_unresolved_id(
        path,
        &unresolved.reference_kind,
        &unresolved.reference_name,
        unresolved.source.as_deref(),
        unresolved.range.start_byte,
    );
    tx.execute(
        "insert into unresolved_references(id, from_node_id, path, language, reference_name, reference_kind,
            source, start_line, start_column, end_line, end_column, start_byte, end_byte,
            candidates, provenance, confidence, content_hash, extractor_version, indexed_at)
         values (?1, null, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, '[]', ?13, ?14, ?15, ?16, ?17)
         on conflict(id) do update set path = excluded.path, language = excluded.language,
            reference_name = excluded.reference_name, reference_kind = excluded.reference_kind,
            source = excluded.source, start_line = excluded.start_line, start_column = excluded.start_column,
            end_line = excluded.end_line, end_column = excluded.end_column,
            start_byte = excluded.start_byte, end_byte = excluded.end_byte,
            provenance = excluded.provenance, confidence = excluded.confidence,
            content_hash = excluded.content_hash, extractor_version = excluded.extractor_version,
            indexed_at = excluded.indexed_at",
        params![
            id,
            path,
            language,
            unresolved.reference_name,
            unresolved.reference_kind,
            unresolved.source,
            unresolved.range.start_line as i64,
            unresolved.range.start_column as i64,
            unresolved.range.end_line as i64,
            unresolved.range.end_column as i64,
            unresolved.range.start_byte as i64,
            unresolved.range.end_byte as i64,
            unresolved.provenance,
            unresolved.confidence,
            content_hash,
            extractor_version,
            indexed_at,
        ],
    )
    .map_err(|error| sqlite_error("Could not insert unresolved reference", error))?;
    Ok(())
}

pub(super) fn fts_match_query(value: &str) -> String {
    let mut tokens = Vec::new();
    for raw in value.split(|character: char| !character.is_alphanumeric() && character != '_') {
        let token = raw.trim();
        if token.is_empty() {
            continue;
        }
        tokens.push(format!("{token}*"));
    }
    if tokens.is_empty() {
        return String::new();
    }
    tokens.join(" ")
}

#[cfg(test)]
pub(super) fn index_code_graph_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let mut conn = handle
        .graph_conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Code graph state lock is poisoned."))?;
    index_code_graph_with_connection(&handle.root_dir, &mut conn, request)
}

pub(super) fn index_code_graph_with_connection(
    root_dir: &str,
    conn: &mut rusqlite::Connection,
    request: String,
) -> napi::Result<String> {
    let request: IndexCodeGraphRequest = decode(&request)?;
    let parser_version = if request.parser_version.trim().is_empty() {
        PARSER_VERSION.to_string()
    } else {
        request.parser_version
    };
    let extractor_version = if request.extractor_version.trim().is_empty() {
        EXTRACTOR_VERSION.to_string()
    } else {
        request.extractor_version
    };
    let indexed_at = timestamp();
    let oxc_extractor = OxcExtractor;
    let python_extractor = PythonExtractor;
    let existing = existing_code_extractions(conn)?;
    let requested_paths = request
        .files
        .iter()
        .map(|file| file.path.as_str())
        .collect::<HashSet<_>>();
    let mut deleted = existing
        .keys()
        .filter(|path| !requested_paths.contains(path.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    deleted.sort();
    let changed_files = request
        .files
        .iter()
        .filter(|file| {
            existing.get(&file.path).is_none_or(|entry| {
                entry.content_hash != file.content_hash
                    || entry.parser_version != parser_version
                    || entry.extractor_version != extractor_version
            })
        })
        .collect::<Vec<_>>();

    if changed_files.is_empty() && deleted.is_empty() {
        return encode(&json!({
          "indexed": [],
          "deleted": [],
          "diagnostics": [],
          "parserVersion": parser_version,
          "extractorVersion": extractor_version,
        }));
    }

    let mut diagnostics = Vec::new();
    let tx = conn
        .transaction()
        .map_err(|error| sqlite_error("Could not start graph index transaction", error))?;

    for path in deleted.iter() {
        tx.execute("delete from files where path = ?1", params![path])
            .map_err(|error| sqlite_error("Could not delete graph file state", error))?;
    }

    let mut indexed = Vec::new();
    for file in changed_files {
        // Stream extraction into the transaction one file at a time. A cold
        // project index must not retain every parsed graph in memory at once.
        let text = match file.content.as_deref() {
            Some(content) => content.to_string(),
            None => match fs::read_to_string(root_path(root_dir, &file.path)) {
                Ok(text) => text,
                Err(error) => {
                    diagnostics.push(json!({
                      "path": file.path,
                      "code": "read-failed",
                      "message": format!("Could not read {}: {error}", file.path),
                      "severity": "error",
                    }));
                    continue;
                }
            },
        };
        let extraction_input = CodeExtractionInput {
            path: &file.path,
            language: &file.language,
            text: &text,
            content_hash: &file.content_hash,
            extractor_version: &extractor_version,
        };
        let result = if !language_is_supported(&file.language) {
            oxc_extractor.extract(extraction_input)
        } else {
            match file.language.as_str() {
                "python" => python_extractor.extract(extraction_input),
                _ => oxc_extractor.extract(extraction_input),
            }
        };
        tx.execute(
            "insert into files(path) values (?1) on conflict(path) do nothing",
            params![file.path],
        )
        .map_err(|error| sqlite_error("Could not record graph file state", error))?;
        tx.execute("delete from code_edges where path = ?1", params![file.path])
            .map_err(|error| sqlite_error("Could not clear prior code edges", error))?;
        tx.execute("delete from code_nodes where path = ?1", params![file.path])
            .map_err(|error| sqlite_error("Could not clear prior code nodes", error))?;
        tx.execute(
            "delete from unresolved_references where path = ?1",
            params![file.path],
        )
        .map_err(|error| sqlite_error("Could not clear prior unresolved references", error))?;

        for node in result.nodes.iter() {
            insert_code_node(
                &tx,
                &file.path,
                &file.language,
                &file.content_hash,
                &extractor_version,
                &indexed_at,
                node,
            )?;
        }
        for unresolved in result.unresolved.iter() {
            insert_unresolved_reference(
                &tx,
                &file.path,
                &file.language,
                &file.content_hash,
                &extractor_version,
                &indexed_at,
                unresolved,
            )?;
        }

        let diagnostics_json = serde_json::to_string(&result.diagnostics)
            .map_err(|error| napi_error("invalid-engine-payload", &error.to_string()))?;
        tx.execute(
                "insert into code_extractions(path, content_hash, parser_version, extractor_version, extracted_at, diagnostics)
                 values (?1, ?2, ?3, ?4, ?5, ?6)
                 on conflict(path) do update set content_hash = excluded.content_hash, parser_version = excluded.parser_version,
                 extractor_version = excluded.extractor_version, extracted_at = excluded.extracted_at, diagnostics = excluded.diagnostics",
                params![file.path, file.content_hash, parser_version, extractor_version, indexed_at, diagnostics_json],
            )
            .map_err(|error| sqlite_error("Could not record code extraction", error))?;

        indexed.push(json!({
          "path": file.path,
          "nodes": result.nodes.len(),
          "unresolved": result.unresolved.len(),
          "supported": result.supported,
        }));
        for diagnostic in result.diagnostics.iter() {
            diagnostics.push(json!({
              "path": file.path,
              "code": diagnostic.code,
              "message": diagnostic.message,
              "severity": diagnostic.severity,
            }));
        }
    }
    if !indexed.is_empty() || !deleted.is_empty() {
        tx.execute("delete from code_edges", [])
            .map_err(|error| sqlite_error("Could not clear resolved code edges", error))?;
        resolve_exact_code_edges(&tx, root_dir)?;
    }

    tx.commit()
        .map_err(|error| sqlite_error("Could not commit graph index transaction", error))?;

    encode(&json!({
      "indexed": indexed,
      "deleted": deleted,
      "diagnostics": diagnostics,
      "parserVersion": parser_version,
      "extractorVersion": extractor_version,
    }))
}

struct ExistingCodeExtraction {
    content_hash: String,
    parser_version: String,
    extractor_version: String,
}

fn existing_code_extractions(
    conn: &rusqlite::Connection,
) -> napi::Result<HashMap<String, ExistingCodeExtraction>> {
    let mut statement = conn
        .prepare(
            "select path, content_hash, parser_version, extractor_version from code_extractions",
        )
        .map_err(|error| sqlite_error("Could not read existing code extractions", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                ExistingCodeExtraction {
                    content_hash: row.get(1)?,
                    parser_version: row.get(2)?,
                    extractor_version: row.get(3)?,
                },
            ))
        })
        .map_err(|error| sqlite_error("Could not query existing code extractions", error))?;
    let mut existing = HashMap::new();
    for row in rows {
        let (path, extraction) =
            row.map_err(|error| sqlite_error("Could not decode existing code extraction", error))?;
        existing.insert(path, extraction);
    }
    Ok(existing)
}

pub(super) fn search_symbols_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: SearchSymbolsRequest = decode(&request)?;
    let limit = request.limit.unwrap_or(50).clamp(1, 500) as i64;
    let conn = handle
        .graph_conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Code graph state lock is poisoned."))?;

    let trimmed_query = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(fts_match_query)
        .filter(|value| !value.is_empty());

    let mut sql = String::new();
    let mut bind: Vec<rusqlite::types::Value> = Vec::new();
    if let Some(query) = trimmed_query {
        sql.push_str(
                "select n.id, n.path, n.language, n.kind, n.name, n.qualified_name, n.exported, n.signature,\n                       n.start_line, n.start_column, n.start_byte, n.end_line, n.end_column, n.end_byte,\n                       fts.rank as score\n                from code_node_search_fts fts\n                join code_nodes n on n.rowid = fts.rowid\n                where code_node_search_fts MATCH ?1",
            );
        bind.push(query.into());
        let mut next = 2;
        if let Some(path) = request.path.as_deref() {
            sql.push_str(&format!(" and n.path = ?{next}"));
            bind.push(path.to_string().into());
            next += 1;
        }
        if let Some(kind) = request.kind.as_deref() {
            sql.push_str(&format!(" and n.kind = ?{next}"));
            bind.push(kind.to_string().into());
            next += 1;
        }
        sql.push_str(&format!(
            " order by score, n.path, n.start_line limit ?{next}"
        ));
        bind.push(limit.into());
    } else {
        sql.push_str(
                "select n.id, n.path, n.language, n.kind, n.name, n.qualified_name, n.exported, n.signature,\n                       n.start_line, n.start_column, n.start_byte, n.end_line, n.end_column, n.end_byte,\n                       null as score\n                from code_nodes n where 1 = 1",
            );
        let mut next = 1;
        if let Some(path) = request.path.as_deref() {
            sql.push_str(&format!(" and n.path = ?{next}"));
            bind.push(path.to_string().into());
            next += 1;
        }
        if let Some(kind) = request.kind.as_deref() {
            sql.push_str(&format!(" and n.kind = ?{next}"));
            bind.push(kind.to_string().into());
            next += 1;
        }
        sql.push_str(&format!(" order by n.path, n.start_line limit ?{next}"));
        bind.push(limit.into());
    }

    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| sqlite_error("Could not prepare symbol search", error))?;
    let params = rusqlite::params_from_iter(bind);
    let rows = statement
        .query_map(params, |row| {
            Ok(json!({
              "id": row.get::<_, String>(0)?,
              "path": row.get::<_, String>(1)?,
              "language": row.get::<_, String>(2)?,
              "kind": row.get::<_, String>(3)?,
              "name": row.get::<_, String>(4)?,
              "qualifiedName": row.get::<_, String>(5)?,
              "exported": row.get::<_, i64>(6)? != 0,
              "signature": row.get::<_, Option<String>>(7)?,
              "range": {
                "start": {
                  "line": row.get::<_, i64>(8)?,
                  "column": row.get::<_, i64>(9)?,
                  "byte": row.get::<_, i64>(10)?,
                },
                "end": {
                  "line": row.get::<_, i64>(11)?,
                  "column": row.get::<_, i64>(12)?,
                  "byte": row.get::<_, i64>(13)?,
                },
              },
              "score": row.get::<_, Option<f64>>(14)?,
            }))
        })
        .map_err(|error| sqlite_error("Could not run symbol search", error))?;

    let mut symbols = Vec::new();
    for row in rows {
        symbols.push(row.map_err(|error| sqlite_error("Could not decode symbol row", error))?);
    }
    encode(&json!({ "symbols": symbols }))
}

pub(super) fn search_references_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: SearchReferencesRequest = decode(&request)?;
    let limit = request.limit.unwrap_or(100).clamp(1, 1000) as i64;
    let conn = handle
        .graph_conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Code graph state lock is poisoned."))?;

    let mut sql = String::from(
        "select id, path, language, reference_name, reference_kind, source,
                    start_line, start_column, start_byte, end_line, end_column, end_byte,
                    provenance, confidence
             from unresolved_references where 1 = 1",
    );
    let mut bind: Vec<rusqlite::types::Value> = Vec::new();
    let mut next = 1;
    if let Some(query) = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        sql.push_str(&format!(" and reference_name = ?{next}"));
        bind.push(query.to_string().into());
        next += 1;
    }
    if let Some(path) = request.path.as_deref() {
        sql.push_str(&format!(" and path = ?{next}"));
        bind.push(path.to_string().into());
        next += 1;
    }
    if let Some(source) = request.source.as_deref() {
        sql.push_str(&format!(" and source = ?{next}"));
        bind.push(source.to_string().into());
        next += 1;
    }
    if let Some(kind) = request.kind.as_deref() {
        sql.push_str(&format!(" and reference_kind = ?{next}"));
        bind.push(kind.to_string().into());
        next += 1;
    }
    sql.push_str(&format!(
        " order by path, start_line, start_column limit ?{next}"
    ));
    bind.push(limit.into());

    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| sqlite_error("Could not prepare reference search", error))?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(bind), |row| {
            Ok(json!({
              "id": row.get::<_, String>(0)?,
              "path": row.get::<_, String>(1)?,
              "language": row.get::<_, String>(2)?,
              "name": row.get::<_, String>(3)?,
              "kind": row.get::<_, String>(4)?,
              "source": row.get::<_, Option<String>>(5)?,
              "range": {
                "start": {
                  "line": row.get::<_, i64>(6)?,
                  "column": row.get::<_, i64>(7)?,
                  "byte": row.get::<_, i64>(8)?,
                },
                "end": {
                  "line": row.get::<_, i64>(9)?,
                  "column": row.get::<_, i64>(10)?,
                  "byte": row.get::<_, i64>(11)?,
                },
              },
              "provenance": row.get::<_, String>(12)?,
              "confidence": row.get::<_, String>(13)?,
            }))
        })
        .map_err(|error| sqlite_error("Could not run reference search", error))?;

    let mut references = Vec::new();
    for row in rows {
        references
            .push(row.map_err(|error| sqlite_error("Could not decode reference row", error))?);
    }
    encode(&json!({ "references": references }))
}

pub(super) fn search_graph_edges_json(
    handle: &EngineProjectHandle,
    request: String,
) -> napi::Result<String> {
    let request: SearchGraphEdgesRequest = decode(&request)?;
    let limit = request.limit.unwrap_or(100).clamp(1, 1000) as i64;
    let direction = request.direction.as_deref().unwrap_or("both");
    if !matches!(direction, "incoming" | "outgoing" | "both") {
        return Err(napi_error(
            "invalid-engine-payload",
            "Graph edge direction must be incoming, outgoing, or both.",
        ));
    }
    let conn = handle
        .graph_conn
        .lock()
        .map_err(|_| napi_error("sqlite-error", "Code graph state lock is poisoned."))?;

    let mut sql = String::from(
            "select e.id, e.kind, e.provenance, e.confidence, e.path, e.start_line, e.start_column, e.start_byte,
                    source.id, source.path, source.language, source.kind, source.name, source.qualified_name,
                    source.exported, source.signature, source.start_line, source.start_column, source.start_byte,
                    source.end_line, source.end_column, source.end_byte,
                    target.id, target.path, target.language, target.kind, target.name, target.qualified_name,
                    target.exported, target.signature, target.start_line, target.start_column, target.start_byte,
                    target.end_line, target.end_column, target.end_byte
             from code_edges e
             join code_nodes source on source.id = e.source_id
             join code_nodes target on target.id = e.target_id
             where 1 = 1",
        );
    let mut bind: Vec<rusqlite::types::Value> = Vec::new();
    let mut next = 1;
    if let Some(kind) = request.kind.as_deref() {
        sql.push_str(&format!(" and e.kind = ?{next}"));
        bind.push(kind.to_string().into());
        next += 1;
    }
    if let Some(path) = request.path.as_deref() {
        sql.push_str(&format!(" and e.path = ?{next}"));
        bind.push(path.to_string().into());
        next += 1;
    }
    if let Some(symbol_id) = request.symbol_id.as_deref() {
        match direction {
            "incoming" => sql.push_str(&format!(" and e.target_id = ?{next}")),
            "outgoing" => sql.push_str(&format!(" and e.source_id = ?{next}")),
            _ => sql.push_str(&format!(
                " and (e.source_id = ?{next} or e.target_id = ?{next})"
            )),
        }
        bind.push(symbol_id.to_string().into());
        next += 1;
    }
    if let Some(query) = request
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        match direction {
            "incoming" => sql.push_str(&format!(" and target.name = ?{next}")),
            "outgoing" => sql.push_str(&format!(" and source.name = ?{next}")),
            _ => sql.push_str(&format!(
                " and (source.name = ?{next} or target.name = ?{next})"
            )),
        }
        bind.push(query.to_string().into());
        next += 1;
    }
    sql.push_str(&format!(
        " order by e.path, e.start_line, e.start_column limit ?{next}"
    ));
    bind.push(limit.into());

    let mut statement = conn
        .prepare(&sql)
        .map_err(|error| sqlite_error("Could not prepare graph edge search", error))?;
    let rows = statement
        .query_map(rusqlite::params_from_iter(bind), |row| {
            Ok(json!({
              "id": row.get::<_, String>(0)?,
              "kind": row.get::<_, String>(1)?,
              "provenance": row.get::<_, String>(2)?,
              "confidence": row.get::<_, String>(3)?,
              "path": row.get::<_, String>(4)?,
              "range": {
                "start": {
                  "line": row.get::<_, Option<i64>>(5)?.unwrap_or(1),
                  "column": row.get::<_, Option<i64>>(6)?.unwrap_or(1),
                  "byte": row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                }
              },
              "source": code_symbol_json(row, 8)?,
              "target": code_symbol_json(row, 22)?,
            }))
        })
        .map_err(|error| sqlite_error("Could not run graph edge search", error))?;

    let mut edges = Vec::new();
    for row in rows {
        edges.push(row.map_err(|error| sqlite_error("Could not decode graph edge row", error))?);
    }
    encode(&json!({ "edges": edges }))
}
