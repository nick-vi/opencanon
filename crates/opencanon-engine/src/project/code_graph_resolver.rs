use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use rusqlite::params;

use crate::code_graph::compute_edge_id;
use crate::json::sqlite_error;

pub(super) fn resolve_exact_code_edges(
    tx: &rusqlite::Transaction<'_>,
    root_dir: &str,
) -> napi::Result<()> {
    let nodes = load_resolver_nodes(tx)?;
    let references = load_resolver_references(tx)?;
    let mut nodes_by_file_name: HashMap<(String, String), Vec<ResolverNode>> = HashMap::new();
    let mut exported_by_file_name: HashMap<(String, String), Vec<ResolverNode>> = HashMap::new();
    let mut nodes_by_name: HashMap<String, Vec<ResolverNode>> = HashMap::new();
    for node in nodes.iter().cloned() {
        nodes_by_file_name
            .entry((node.path.clone(), node.name.clone()))
            .or_default()
            .push(node.clone());
        nodes_by_name
            .entry(node.name.clone())
            .or_default()
            .push(node.clone());
        if node.exported {
            exported_by_file_name
                .entry((node.path.clone(), node.name.clone()))
                .or_default()
                .push(node);
        }
    }
    let imports_by_file_name = references
        .iter()
        .filter(|reference| {
            matches!(
                reference.kind.as_str(),
                "import-named" | "import-default" | "import-namespace" | "import-module"
            )
        })
        .fold(
            HashMap::<(String, String), Vec<ResolverReference>>::new(),
            |mut map, reference| {
                map.entry((reference.path.clone(), reference.name.clone()))
                    .or_default()
                    .push(reference.clone());
                map
            },
        );
    let indexed_paths = nodes
        .iter()
        .map(|node| node.path.clone())
        .collect::<HashSet<_>>();
    let module_resolver = ModuleResolver::new(root_dir, &indexed_paths);

    for reference in references
        .iter()
        .filter(|reference| matches!(reference.kind.as_str(), "call" | "identifier"))
    {
        let Some(source) = nearest_source_node(&nodes, &reference.path, reference.start_byte)
        else {
            continue;
        };
        let target = resolve_reference_target(
            reference,
            &nodes_by_file_name,
            &exported_by_file_name,
            &nodes_by_name,
            &imports_by_file_name,
            &module_resolver,
        );
        let Some(target) = target else { continue };
        if source.id == target.id {
            continue;
        }
        insert_code_edge(tx, &source.id, &target.id, &reference.kind, reference)?;
    }
    Ok(())
}

#[derive(Clone)]
struct ResolverNode {
    id: String,
    path: String,
    name: String,
    exported: bool,
    start_byte: i64,
}

#[derive(Clone)]
struct ResolverReference {
    path: String,
    language: String,
    name: String,
    kind: String,
    source: Option<String>,
    start_line: i64,
    start_column: i64,
    start_byte: i64,
    provenance: String,
}

fn load_resolver_nodes(tx: &rusqlite::Transaction<'_>) -> napi::Result<Vec<ResolverNode>> {
    let mut statement = tx
        .prepare(
            "select id, path, name, exported, start_byte from code_nodes order by path, start_byte",
        )
        .map_err(|error| sqlite_error("Could not prepare graph node resolver", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ResolverNode {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                exported: row.get::<_, i64>(3)? != 0,
                start_byte: row.get(4)?,
            })
        })
        .map_err(|error| sqlite_error("Could not load graph resolver nodes", error))?;
    let mut nodes = Vec::new();
    for row in rows {
        nodes.push(
            row.map_err(|error| sqlite_error("Could not decode graph resolver node", error))?,
        );
    }
    Ok(nodes)
}

fn load_resolver_references(
    tx: &rusqlite::Transaction<'_>,
) -> napi::Result<Vec<ResolverReference>> {
    let mut statement = tx
        .prepare(
            "select path, language, reference_name, reference_kind, source, start_line, start_column, start_byte, provenance
             from unresolved_references order by path, start_byte",
        )
        .map_err(|error| sqlite_error("Could not prepare graph reference resolver", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(ResolverReference {
                path: row.get(0)?,
                language: row.get(1)?,
                name: row.get(2)?,
                kind: row.get(3)?,
                source: row.get(4)?,
                start_line: row.get(5)?,
                start_column: row.get(6)?,
                start_byte: row.get(7)?,
                provenance: row.get(8)?,
            })
        })
        .map_err(|error| sqlite_error("Could not load graph resolver references", error))?;
    let mut references = Vec::new();
    for row in rows {
        references.push(
            row.map_err(|error| sqlite_error("Could not decode graph resolver reference", error))?,
        );
    }
    Ok(references)
}

fn nearest_source_node(nodes: &[ResolverNode], path: &str, byte: i64) -> Option<ResolverNode> {
    nodes
        .iter()
        .filter(|node| node.path == path && node.start_byte <= byte)
        .max_by_key(|node| node.start_byte)
        .cloned()
}

fn resolve_reference_target(
    reference: &ResolverReference,
    nodes_by_file_name: &HashMap<(String, String), Vec<ResolverNode>>,
    exported_by_file_name: &HashMap<(String, String), Vec<ResolverNode>>,
    nodes_by_name: &HashMap<String, Vec<ResolverNode>>,
    imports_by_file_name: &HashMap<(String, String), Vec<ResolverReference>>,
    module_resolver: &ModuleResolver,
) -> Option<ResolverNode> {
    if reference.language == "python" && reference.source.is_some() {
        return resolve_python_sourced_reference(reference, exported_by_file_name, module_resolver);
    }
    if let Some(same_file) =
        nodes_by_file_name.get(&(reference.path.clone(), reference.name.clone()))
    {
        if same_file.len() == 1 {
            return same_file.first().cloned();
        }
    }
    if let Some(imports) =
        imports_by_file_name.get(&(reference.path.clone(), reference.name.clone()))
    {
        let mut targets = Vec::new();
        for import in imports {
            let Some(source_path) = import.source.as_deref().and_then(|source| {
                module_resolver.resolve_for_language(&reference.path, source, &import.language)
            }) else {
                continue;
            };
            match import.kind.as_str() {
                "import-named" => targets.extend(
                    exported_by_file_name
                        .get(&(source_path, import.name.clone()))
                        .cloned()
                        .unwrap_or_default(),
                ),
                "import-default" => {
                    let explicit_default = exported_by_file_name
                        .get(&(source_path.clone(), "default".to_string()))
                        .cloned()
                        .unwrap_or_default();
                    if explicit_default.is_empty() {
                        let exported = exported_nodes_for_path(exported_by_file_name, &source_path);
                        if exported.len() == 1 {
                            targets.extend(exported);
                        }
                    } else {
                        targets.extend(explicit_default);
                    }
                }
                _ => {}
            }
        }
        if targets.len() == 1 {
            return targets.first().cloned();
        }
    }
    let project_matches = nodes_by_name.get(&reference.name)?;
    if project_matches.len() == 1 {
        return project_matches.first().cloned();
    }
    None
}

fn resolve_python_sourced_reference(
    reference: &ResolverReference,
    exported_by_file_name: &HashMap<(String, String), Vec<ResolverNode>>,
    module_resolver: &ModuleResolver,
) -> Option<ResolverNode> {
    let source = reference.source.as_deref()?;
    let source_path = module_resolver.resolve_python(&reference.path, source)?;
    let targets = exported_by_file_name
        .get(&(source_path.clone(), reference.name.clone()))
        .cloned()
        .unwrap_or_default();
    if targets.len() == 1 {
        return targets.first().cloned();
    }
    if reference.kind == "import-module" {
        let exported = exported_nodes_for_path(exported_by_file_name, &source_path);
        if exported.len() == 1 {
            return exported.first().cloned();
        }
    }
    None
}

fn exported_nodes_for_path(
    exported_by_file_name: &HashMap<(String, String), Vec<ResolverNode>>,
    path: &str,
) -> Vec<ResolverNode> {
    exported_by_file_name
        .iter()
        .filter(|((file, _), _)| file == path)
        .flat_map(|(_, nodes)| nodes.clone())
        .collect()
}

struct ModuleResolver {
    root_dir: String,
    indexed_paths: HashSet<String>,
    aliases: Vec<TsAlias>,
    workspaces: Vec<WorkspacePackage>,
}

struct TsAlias {
    config_root: String,
    base_dir: String,
    pattern: String,
    targets: Vec<String>,
}

struct WorkspacePackage {
    name: String,
    root: String,
}

impl ModuleResolver {
    fn new(root_dir: &str, indexed_paths: &HashSet<String>) -> Self {
        Self {
            root_dir: root_dir.to_string(),
            indexed_paths: indexed_paths.clone(),
            aliases: read_ts_aliases(root_dir),
            workspaces: read_workspace_packages(root_dir),
        }
    }

    fn resolve_for_language(
        &self,
        from_path: &str,
        source: &str,
        language: &str,
    ) -> Option<String> {
        if language == "python" {
            return self.resolve_python(from_path, source);
        }
        self.resolve(from_path, source)
    }

    fn resolve(&self, from_path: &str, source: &str) -> Option<String> {
        if source.starts_with('.') {
            return resolve_relative_module_path(from_path, source, &self.indexed_paths);
        }
        self.resolve_alias(from_path, source)
            .or_else(|| self.resolve_workspace(source))
    }

    fn resolve_alias(&self, from_path: &str, source: &str) -> Option<String> {
        let mut aliases = self
            .aliases
            .iter()
            .filter(|alias| {
                alias.config_root.is_empty()
                    || from_path == alias.config_root
                    || from_path.starts_with(&format!("{}/", alias.config_root))
            })
            .collect::<Vec<_>>();
        aliases.sort_by_key(|alias| std::cmp::Reverse(alias.config_root.len()));

        for alias in aliases {
            let Some(wildcard) = match_alias_pattern(&alias.pattern, source) else {
                continue;
            };
            for target in alias.targets.iter() {
                let target_path = target.replace('*', &wildcard);
                let base = normalize_relative_path(&Path::new(&alias.base_dir).join(target_path));
                if let Some(resolved) = resolve_candidate_path(&base, &self.indexed_paths) {
                    return Some(resolved);
                }
            }
        }
        None
    }

    fn resolve_workspace(&self, source: &str) -> Option<String> {
        let mut packages = self.workspaces.iter().collect::<Vec<_>>();
        packages.sort_by_key(|package| std::cmp::Reverse(package.name.len()));
        let package = packages.into_iter().find(|package| {
            source == package.name || source.starts_with(&format!("{}/", package.name))
        })?;
        let subpath = if source == package.name {
            ""
        } else {
            &source[package.name.len() + 1..]
        };
        let bases = if subpath.is_empty() {
            vec![
                format!("{}/src/index", package.root),
                format!("{}/index", package.root),
            ]
        } else {
            vec![
                format!("{}/{}", package.root, subpath),
                format!("{}/src/{}", package.root, subpath),
            ]
        };
        bases
            .iter()
            .find_map(|base| resolve_candidate_path(base, &self.indexed_paths))
    }

    fn resolve_python(&self, from_path: &str, source: &str) -> Option<String> {
        if source.starts_with('.') {
            return resolve_python_relative_module_path(from_path, source, &self.indexed_paths);
        }
        self.resolve_python_absolute_module_path(from_path, source)
    }

    fn resolve_python_absolute_module_path(&self, from_path: &str, source: &str) -> Option<String> {
        let module_path = source.replace('.', "/");
        self.python_search_roots(from_path)
            .into_iter()
            .find_map(|root| {
                let base = if root.is_empty() {
                    module_path.clone()
                } else {
                    format!("{root}/{module_path}")
                };
                resolve_python_candidate_path(&base, &self.indexed_paths)
            })
    }

    fn python_search_roots(&self, from_path: &str) -> Vec<String> {
        let mut roots = vec![String::new()];
        let mut current = Path::new(from_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_default();
        while !current.as_os_str().is_empty() {
            let current_string = normalize_relative_path(&current);
            if self.python_directory_has_init(&current_string) {
                let root = current
                    .parent()
                    .map(normalize_relative_path)
                    .unwrap_or_default();
                roots.push(root);
            }
            current = current.parent().map(Path::to_path_buf).unwrap_or_default();
        }
        roots.sort_by_key(|root| root.len());
        roots.dedup();
        roots
    }

    fn python_directory_has_init(&self, directory: &str) -> bool {
        let init_path = if directory.is_empty() {
            "__init__.py".to_string()
        } else {
            format!("{directory}/__init__.py")
        };
        self.indexed_paths.contains(&init_path)
            || Path::new(&self.root_dir).join(init_path).exists()
    }
}

fn resolve_relative_module_path(
    from_path: &str,
    source: &str,
    indexed_paths: &HashSet<String>,
) -> Option<String> {
    if !source.starts_with('.') {
        return None;
    }
    let base = Path::new(from_path)
        .parent()
        .unwrap_or_else(|| Path::new(""));
    let joined = base.join(source);
    let normalized = normalize_relative_path(&joined);
    let candidates = [
        normalized.clone(),
        format!("{normalized}.ts"),
        format!("{normalized}.tsx"),
        format!("{normalized}.js"),
        format!("{normalized}.jsx"),
        format!("{normalized}/index.ts"),
        format!("{normalized}/index.tsx"),
        format!("{normalized}/index.js"),
        format!("{normalized}/index.jsx"),
    ];
    candidates
        .into_iter()
        .find(|candidate| indexed_paths.contains(candidate))
}

fn resolve_candidate_path(base: &str, indexed_paths: &HashSet<String>) -> Option<String> {
    let candidates = [
        base.to_string(),
        format!("{base}.ts"),
        format!("{base}.tsx"),
        format!("{base}.js"),
        format!("{base}.jsx"),
        format!("{base}/index.ts"),
        format!("{base}/index.tsx"),
        format!("{base}/index.js"),
        format!("{base}/index.jsx"),
    ];
    candidates
        .into_iter()
        .find(|candidate| indexed_paths.contains(candidate))
}

fn resolve_python_relative_module_path(
    from_path: &str,
    source: &str,
    indexed_paths: &HashSet<String>,
) -> Option<String> {
    let level = source
        .chars()
        .take_while(|character| *character == '.')
        .count();
    if level == 0 {
        return None;
    }
    let module = source[level..].replace('.', "/");
    let mut base = Path::new(from_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    for _ in 1..level {
        base = base.parent().map(Path::to_path_buf).unwrap_or_default();
    }
    let joined = if module.is_empty() {
        base
    } else {
        base.join(module)
    };
    let normalized = normalize_relative_path(&joined);
    resolve_python_candidate_path(&normalized, indexed_paths)
}

fn resolve_python_candidate_path(base: &str, indexed_paths: &HashSet<String>) -> Option<String> {
    let candidates = [format!("{base}.py"), format!("{base}/__init__.py")];
    candidates
        .into_iter()
        .find(|candidate| indexed_paths.contains(candidate))
}

fn normalize_relative_path(path: &Path) -> String {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::Normal(value) => {
                parts.push(value.to_string_lossy().to_string());
            }
            _ => {}
        }
    }
    parts.join("/")
}

fn read_ts_aliases(root_dir: &str) -> Vec<TsAlias> {
    find_config_files(root_dir, |name| {
        name.starts_with("tsconfig") && name.ends_with(".json")
    })
    .iter()
    .flat_map(|file| {
        let config = read_json(root_dir, file);
        let Some(paths) = config
            .get("compilerOptions")
            .and_then(|value| value.get("paths"))
            .and_then(|value| value.as_object())
        else {
            return Vec::new();
        };
        let config_root =
            normalize_relative_path(Path::new(file).parent().unwrap_or_else(|| Path::new("")));
        let normalized_root = if config_root == "." {
            String::new()
        } else {
            config_root
        };
        let base_url = config
            .get("compilerOptions")
            .and_then(|value| value.get("baseUrl"))
            .and_then(|value| value.as_str())
            .unwrap_or(".");
        let base_dir = normalize_relative_path(&Path::new(&normalized_root).join(base_url));

        paths
            .iter()
            .filter_map(|(pattern, value)| {
                let targets = value
                    .as_array()?
                    .iter()
                    .filter_map(|item| item.as_str().map(str::to_string))
                    .collect::<Vec<_>>();
                if targets.is_empty() {
                    return None;
                }
                Some(TsAlias {
                    config_root: normalized_root.clone(),
                    base_dir: base_dir.clone(),
                    pattern: pattern.clone(),
                    targets,
                })
            })
            .collect::<Vec<_>>()
    })
    .collect()
}

fn read_workspace_packages(root_dir: &str) -> Vec<WorkspacePackage> {
    find_config_files(root_dir, |name| name == "package.json")
        .iter()
        .filter_map(|file| {
            let json = read_json(root_dir, file);
            let name = json.get("name").and_then(|value| value.as_str())?;
            let root =
                normalize_relative_path(Path::new(file).parent().unwrap_or_else(|| Path::new("")));
            Some(WorkspacePackage {
                name: name.to_string(),
                root,
            })
        })
        .collect()
}

fn find_config_files(root_dir: &str, matches_name: fn(&str) -> bool) -> Vec<String> {
    let mut output = Vec::new();
    collect_config_files(
        Path::new(root_dir),
        Path::new(""),
        matches_name,
        &mut output,
    );
    output.sort();
    output
}

fn collect_config_files(
    root_dir: &Path,
    relative_dir: &Path,
    matches_name: fn(&str) -> bool,
    output: &mut Vec<String>,
) {
    let absolute_dir = root_dir.join(relative_dir);
    let Ok(entries) = fs::read_dir(absolute_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(
            name.as_str(),
            "node_modules" | ".git" | ".opencanon" | "dist" | "build" | "coverage"
        ) {
            continue;
        }
        let relative_path = relative_dir.join(&name);
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_config_files(root_dir, &relative_path, matches_name, output);
        } else if file_type.is_file() && matches_name(&name) {
            output.push(normalize_relative_path(&relative_path));
        }
    }
}

fn read_json(root_dir: &str, file: &str) -> serde_json::Value {
    let path = Path::new(root_dir).join(file);
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&strip_json_comments(&text)).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn strip_json_comments(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;

    while let Some(char) = chars.next() {
        if in_string {
            output.push(char);
            if escaped {
                escaped = false;
            } else if char == '\\' {
                escaped = true;
            } else if char == '"' {
                in_string = false;
            }
            continue;
        }

        if char == '"' {
            in_string = true;
            output.push(char);
            continue;
        }

        if char == '/' {
            match chars.peek().copied() {
                Some('/') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if next == '\n' {
                            output.push('\n');
                            break;
                        }
                    }
                    continue;
                }
                Some('*') => {
                    chars.next();
                    let mut previous = '\0';
                    for next in chars.by_ref() {
                        if next == '\n' {
                            output.push('\n');
                        }
                        if previous == '*' && next == '/' {
                            break;
                        }
                        previous = next;
                    }
                    continue;
                }
                _ => {}
            }
        }

        output.push(char);
    }

    output
}

fn match_alias_pattern(pattern: &str, source: &str) -> Option<String> {
    if !pattern.contains('*') {
        return (pattern == source).then(String::new);
    }
    let mut parts = pattern.splitn(2, '*');
    let prefix = parts.next().unwrap_or("");
    let suffix = parts.next().unwrap_or("");
    if !source.starts_with(prefix) || !source.ends_with(suffix) {
        return None;
    }
    // prefix and suffix can overlap for a short source (e.g. pattern "ab*ab", source "ab"):
    // both starts_with and ends_with hold, but prefix.len()+suffix.len() > source.len(), so
    // the slice below would have start > end and panic. Reject that case.
    if source.len() < prefix.len() + suffix.len() {
        return None;
    }
    Some(source[prefix.len()..source.len() - suffix.len()].to_string())
}

fn insert_code_edge(
    tx: &rusqlite::Transaction<'_>,
    source_id: &str,
    target_id: &str,
    kind: &str,
    reference: &ResolverReference,
) -> napi::Result<()> {
    let id = compute_edge_id(
        source_id,
        target_id,
        kind,
        &reference.path,
        reference.start_byte,
    );
    tx.execute(
        "insert into code_edges(id, source_id, target_id, kind, provenance, confidence, path, start_line, start_column, start_byte, metadata)
         values (?1, ?2, ?3, ?4, ?5, 'exact', ?6, ?7, ?8, ?9, '{}')
         on conflict(id) do update set source_id = excluded.source_id, target_id = excluded.target_id,
           kind = excluded.kind, provenance = excluded.provenance, confidence = excluded.confidence,
           path = excluded.path, start_line = excluded.start_line, start_column = excluded.start_column,
           start_byte = excluded.start_byte, metadata = excluded.metadata",
        params![id, source_id, target_id, kind, reference.provenance, reference.path, reference.start_line, reference.start_column, reference.start_byte],
    )
    .map_err(|error| sqlite_error("Could not insert code edge", error))?;
    Ok(())
}
