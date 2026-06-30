use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, CallExpression, Class, Declaration, ExportAllDeclaration,
    ExportDefaultDeclaration, ExportDefaultDeclarationKind, ExportNamedDeclaration, Expression,
    Function, IdentifierReference, ImportDeclaration, ImportDeclarationSpecifier, ModuleExportName,
    TSEnumDeclaration, TSInterfaceDeclaration, TSTypeAliasDeclaration, VariableDeclaration,
    VariableDeclarator,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::scope::ScopeFlags;
use rustpython_parser::ast::{
    self as py_ast, Expr as PyExpr, ExprContext, Ranged, Stmt as PyStmt, Visitor as PythonVisitor,
};
use rustpython_parser::{parse, Mode};
use serde::{Deserialize, Serialize};

pub(crate) trait CodeExtractor {
    fn extract(&self, input: CodeExtractionInput<'_>) -> CodeExtractionResult;
}

pub(crate) struct OxcExtractor;
pub(crate) struct PythonExtractor;

#[derive(Debug)]
pub(crate) struct CodeExtractionInput<'a> {
    pub path: &'a str,
    pub language: &'a str,
    pub text: &'a str,
    #[allow(dead_code)]
    pub content_hash: &'a str,
    #[allow(dead_code)]
    pub extractor_version: &'a str,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct CodeExtractionResult {
    pub nodes: Vec<ExtractedNode>,
    pub unresolved: Vec<ExtractedUnresolved>,
    pub diagnostics: Vec<CodeDiagnostic>,
    pub supported: bool,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct CodeDiagnostic {
    pub code: String,
    pub message: String,
    pub severity: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct Range {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub start_byte: u32,
    pub end_byte: u32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ExtractedNode {
    pub kind: String,
    pub name: String,
    pub qualified_name: String,
    pub exported: bool,
    pub signature: Option<String>,
    pub range: Range,
    pub disambiguator: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub(crate) struct ExtractedUnresolved {
    pub reference_name: String,
    pub reference_kind: String,
    pub source: Option<String>,
    pub range: Range,
    pub provenance: String,
    pub confidence: String,
}

pub(crate) fn language_is_supported(language: &str) -> bool {
    oxc_language_is_supported(language) || language == "python"
}

fn oxc_language_is_supported(language: &str) -> bool {
    matches!(language, "typescript" | "tsx" | "javascript" | "jsx")
}

pub(crate) fn compute_node_id(
    path: &str,
    language: &str,
    kind: &str,
    qualified_name: &str,
    start_byte: u32,
    disambiguator: &str,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"node:v1\0");
    hasher.update(path.as_bytes());
    hasher.update(b"\0");
    hasher.update(language.as_bytes());
    hasher.update(b"\0");
    hasher.update(kind.as_bytes());
    hasher.update(b"\0");
    hasher.update(qualified_name.as_bytes());
    hasher.update(b"\0");
    hasher.update(start_byte.to_le_bytes().as_slice());
    hasher.update(b"\0");
    hasher.update(disambiguator.as_bytes());
    hasher.finalize().to_hex().to_string()
}

pub(crate) fn compute_unresolved_id(
    path: &str,
    reference_kind: &str,
    reference_name: &str,
    source: Option<&str>,
    start_byte: u32,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"unresolved:v1\0");
    hasher.update(path.as_bytes());
    hasher.update(b"\0");
    hasher.update(reference_kind.as_bytes());
    hasher.update(b"\0");
    hasher.update(reference_name.as_bytes());
    hasher.update(b"\0");
    hasher.update(source.unwrap_or("").as_bytes());
    hasher.update(b"\0");
    hasher.update(start_byte.to_le_bytes().as_slice());
    hasher.finalize().to_hex().to_string()
}

pub(crate) fn compute_edge_id(
    source_id: &str,
    target_id: &str,
    kind: &str,
    path: &str,
    start_byte: i64,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"edge:v1\0");
    hasher.update(source_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(target_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(kind.as_bytes());
    hasher.update(b"\0");
    hasher.update(path.as_bytes());
    hasher.update(b"\0");
    hasher.update(start_byte.to_le_bytes().as_slice());
    hasher.finalize().to_hex().to_string()
}

struct LineIndex<'source> {
    text: &'source str,
    starts: Vec<usize>,
}

impl<'source> LineIndex<'source> {
    fn new(text: &'source str) -> Self {
        let mut starts = vec![0];
        for (index, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                starts.push(index + 1);
            }
        }
        Self { text, starts }
    }

    fn line_column(&self, offset: usize) -> (u32, u32) {
        let line_index = self
            .starts
            .partition_point(|start| *start <= offset)
            .saturating_sub(1);
        let line = (line_index as u32) + 1;
        // UTF-16 column to match facts.rs and the Python graph path (every other coordinate
        // the engine emits is UTF-16); a raw byte column is wrong on non-ASCII lines.
        let column = self.utf16_column(self.starts[line_index], offset) as u32;
        (line, column)
    }

    fn utf16_column(&self, line_start: usize, offset: usize) -> usize {
        let offset = offset.min(self.text.len());
        self.text[line_start..]
            .char_indices()
            .take_while(|(relative_offset, _)| line_start + *relative_offset < offset)
            .map(|(_, character)| character.len_utf16())
            .sum::<usize>()
            + 1
    }

    fn range(&self, span: Span) -> Range {
        let (start_line, start_column) = self.line_column(span.start as usize);
        let (end_line, end_column) = self.line_column(span.end as usize);
        Range {
            start_line,
            start_column,
            end_line,
            end_column,
            start_byte: span.start,
            end_byte: span.end,
        }
    }
}

impl CodeExtractor for OxcExtractor {
    fn extract(&self, input: CodeExtractionInput<'_>) -> CodeExtractionResult {
        if !oxc_language_is_supported(input.language) {
            return CodeExtractionResult {
                nodes: Vec::new(),
                unresolved: Vec::new(),
                diagnostics: vec![CodeDiagnostic {
                    code: "unsupported-language-graph".to_string(),
                    message: format!(
                        "Code graph extraction skipped for {}: unsupported language {}.",
                        input.path, input.language
                    ),
                    severity: "info".to_string(),
                }],
                supported: false,
            };
        }

        let source_type = match SourceType::from_path(input.path) {
            Ok(value) => value,
            Err(error) => {
                return CodeExtractionResult {
                    nodes: Vec::new(),
                    unresolved: Vec::new(),
                    diagnostics: vec![CodeDiagnostic {
                        code: "unsupported-language-graph".to_string(),
                        message: format!(
                            "Could not infer source type for {}: {}",
                            input.path, error
                        ),
                        severity: "error".to_string(),
                    }],
                    supported: false,
                };
            }
        };

        if crate::facts::exceeds_nesting_depth(input.text) {
            return CodeExtractionResult {
                nodes: Vec::new(),
                unresolved: Vec::new(),
                diagnostics: vec![CodeDiagnostic {
                    code: "input-too-deeply-nested".to_string(),
                    message: format!(
                        "Source nests brackets deeper than {}; skipping code-graph extraction.",
                        crate::facts::MAX_NESTING_DEPTH
                    ),
                    severity: "error".to_string(),
                }],
                supported: true,
            };
        }

        let allocator = Allocator::default();
        let parse_result = Parser::new(&allocator, input.text, source_type).parse();
        let mut diagnostics: Vec<CodeDiagnostic> = parse_result
            .errors
            .iter()
            .map(|error| CodeDiagnostic {
                code: "parse-error".to_string(),
                message: format!("{error:?}"),
                severity: "error".to_string(),
            })
            .collect();

        let line_index = LineIndex::new(input.text);
        let mut collector = GraphCollector {
            path: input.path,
            text: input.text,
            line_index: &line_index,
            nodes: Vec::new(),
            unresolved: Vec::new(),
            seen_names: HashSet::new(),
        };
        Visit::visit_program(&mut collector, &parse_result.program);

        if collector.nodes.is_empty() && collector.unresolved.is_empty() && diagnostics.is_empty() {
            diagnostics.push(CodeDiagnostic {
                code: "no-graph-nodes".to_string(),
                message: format!("No graph nodes extracted from {}.", input.path),
                severity: "info".to_string(),
            });
        }

        CodeExtractionResult {
            nodes: collector.nodes,
            unresolved: collector.unresolved,
            diagnostics,
            supported: true,
        }
    }
}

impl CodeExtractor for PythonExtractor {
    fn extract(&self, input: CodeExtractionInput<'_>) -> CodeExtractionResult {
        if input.language != "python" {
            return CodeExtractionResult {
                nodes: Vec::new(),
                unresolved: Vec::new(),
                diagnostics: vec![CodeDiagnostic {
                    code: "unsupported-language-graph".to_string(),
                    message: format!(
                        "Code graph extraction skipped for {}: unsupported language {}.",
                        input.path, input.language
                    ),
                    severity: "info".to_string(),
                }],
                supported: false,
            };
        }

        if crate::facts::exceeds_nesting_depth(input.text) {
            return CodeExtractionResult {
                nodes: Vec::new(),
                unresolved: Vec::new(),
                diagnostics: vec![CodeDiagnostic {
                    code: "input-too-deeply-nested".to_string(),
                    message: format!(
                        "Source nests brackets deeper than {}; skipping code-graph extraction.",
                        crate::facts::MAX_NESTING_DEPTH
                    ),
                    severity: "error".to_string(),
                }],
                supported: true,
            };
        }

        let module = match parse(input.text, Mode::Module, input.path) {
            Ok(module) => module,
            Err(error) => {
                return CodeExtractionResult {
                    nodes: Vec::new(),
                    unresolved: Vec::new(),
                    diagnostics: vec![CodeDiagnostic {
                        code: "parse-error".to_string(),
                        message: format!("{error:?}"),
                        severity: "error".to_string(),
                    }],
                    supported: true,
                };
            }
        };

        let line_index = PythonGraphLineIndex::new(input.text);
        let mut collector = PythonGraphCollector {
            path: input.path,
            text: input.text,
            line_index: &line_index,
            nodes: Vec::new(),
            unresolved: Vec::new(),
            seen_names: HashSet::new(),
            class_body_depth: 0,
            imported_modules: Vec::new(),
        };
        if let py_ast::Mod::Module(module) = module {
            for statement in module.body {
                collector.visit_stmt(statement);
            }
        }

        let mut diagnostics = Vec::new();
        if collector.nodes.is_empty() && collector.unresolved.is_empty() {
            diagnostics.push(CodeDiagnostic {
                code: "no-graph-nodes".to_string(),
                message: format!("No graph nodes extracted from {}.", input.path),
                severity: "info".to_string(),
            });
        }

        CodeExtractionResult {
            nodes: collector.nodes,
            unresolved: collector.unresolved,
            diagnostics,
            supported: true,
        }
    }
}

struct PythonGraphLineIndex<'source> {
    text: &'source str,
    newlines: Vec<usize>,
}

impl<'source> PythonGraphLineIndex<'source> {
    fn new(text: &'source str) -> Self {
        Self {
            text,
            newlines: text
                .bytes()
                .enumerate()
                .filter_map(|(index, byte)| (byte == b'\n').then_some(index))
                .collect(),
        }
    }

    fn position(&self, offset: usize) -> (u32, u32) {
        let line = self.newlines.partition_point(|newline| *newline <= offset) + 1;
        let line_start = if line <= 1 {
            0
        } else {
            self.newlines[line - 2] + 1
        };
        (line as u32, self.utf16_column(line_start, offset) as u32)
    }

    fn utf16_column(&self, line_start: usize, offset: usize) -> usize {
        let offset = offset.min(self.text.len());
        self.text[line_start..]
            .char_indices()
            .take_while(|(relative_offset, _)| line_start + *relative_offset < offset)
            .map(|(_, character)| character.len_utf16())
            .sum::<usize>()
            + 1
    }

    fn range_offsets(&self, start: usize, end: usize) -> Range {
        let (start_line, start_column) = self.position(start);
        let (end_line, end_column) = self.position(end);
        Range {
            start_line,
            start_column,
            end_line,
            end_column,
            start_byte: start as u32,
            end_byte: end as u32,
        }
    }

    fn range<T: Ranged>(&self, node: &T) -> Range {
        self.range_offsets(node.start().to_usize(), node.end().to_usize())
    }
}

struct PythonImportedModule {
    visible_prefix: String,
    module: String,
}

struct PythonGraphCollector<'a, 'source> {
    path: &'a str,
    text: &'source str,
    line_index: &'a PythonGraphLineIndex<'source>,
    nodes: Vec<ExtractedNode>,
    unresolved: Vec<ExtractedUnresolved>,
    seen_names: HashSet<(u32, u32, String, String)>,
    class_body_depth: usize,
    imported_modules: Vec<PythonImportedModule>,
}

impl PythonGraphCollector<'_, '_> {
    fn push_definition_node<T: Ranged>(
        &mut self,
        node: &T,
        name: &py_ast::Identifier,
        kind: &str,
        signature: Option<String>,
        keyword: &str,
    ) {
        let name = name.to_string();
        let (start, end) = find_python_identifier_after_keyword(
            self.text,
            node.start().to_usize(),
            node.end().to_usize(),
            keyword,
            &name,
        )
        .unwrap_or((
            node.start().to_usize(),
            node.start().to_usize() + name.len(),
        ));
        let key = (start as u32, end as u32, kind.to_string(), name.clone());
        if !self.seen_names.insert(key) {
            return;
        }
        let qualified_name = format!("{}::{name}", self.path);
        self.nodes.push(ExtractedNode {
            kind: kind.to_string(),
            exported: !name.starts_with('_'),
            name: name.clone(),
            qualified_name,
            signature,
            range: self.line_index.range_offsets(start, end),
            disambiguator: format!("{start}-{end}"),
        });
    }

    fn push_import_module(&mut self, alias: &py_ast::Alias) {
        let module = alias.name.to_string();
        let local = alias
            .asname
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| {
                module
                    .split('.')
                    .next()
                    .unwrap_or(module.as_str())
                    .to_string()
            });
        let visible_prefix = alias
            .asname
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| module.clone());
        self.imported_modules.push(PythonImportedModule {
            visible_prefix,
            module: module.clone(),
        });
        self.unresolved.push(ExtractedUnresolved {
            reference_name: local,
            reference_kind: "import-module".to_string(),
            source: Some(module),
            range: self.line_index.range(alias),
            provenance: "rustpython".to_string(),
            confidence: "syntactic".to_string(),
        });
    }

    fn push_import_from(&mut self, node: py_ast::StmtImportFrom) {
        let base_source = python_import_from_source(node.level.as_ref(), node.module.as_ref());
        for alias in node.names {
            let local = alias
                .asname
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| alias.name.to_string());
            let source = if node.module.is_none() {
                join_python_module_source(&base_source, alias.name.as_ref())
            } else {
                base_source.clone()
            };
            if node.module.is_none() && alias.name.as_str() != "*" {
                self.imported_modules.push(PythonImportedModule {
                    visible_prefix: local.clone(),
                    module: source.clone(),
                });
            }
            self.unresolved.push(ExtractedUnresolved {
                reference_name: local,
                reference_kind: "import-named".to_string(),
                source: Some(source),
                range: self.line_index.range(&alias),
                provenance: "rustpython".to_string(),
                confidence: "syntactic".to_string(),
            });
        }
    }

    fn push_reference<T: Ranged>(
        &mut self,
        name: String,
        kind: &str,
        source: Option<String>,
        node: &T,
        confidence: &str,
    ) {
        if name.is_empty() {
            return;
        }
        self.unresolved.push(ExtractedUnresolved {
            reference_name: name,
            reference_kind: kind.to_string(),
            source,
            range: self.line_index.range(node),
            provenance: "rustpython".to_string(),
            confidence: confidence.to_string(),
        });
    }

    fn push_call(&mut self, call: &py_ast::ExprCall) {
        let Some(callee) = python_dotted_callee(&call.func) else {
            return;
        };
        let Some(name) = callee.rsplit('.').next().filter(|name| !name.is_empty()) else {
            return;
        };
        let source = self.imported_source_for_callee(&callee);
        self.push_reference(
            name.to_string(),
            "call",
            source,
            call.func.as_ref(),
            "syntactic",
        );
    }

    fn imported_source_for_callee(&self, callee: &str) -> Option<String> {
        self.imported_modules
            .iter()
            .filter(|imported| {
                callee
                    .strip_prefix(&format!("{}.", imported.visible_prefix))
                    .is_some_and(|suffix| !suffix.contains('.'))
            })
            .max_by_key(|imported| imported.visible_prefix.len())
            .map(|imported| imported.module.clone())
    }

    fn visit_function_body(
        &mut self,
        args: py_ast::Arguments,
        decorator_list: Vec<PyExpr>,
        returns: Option<Box<PyExpr>>,
        type_params: Vec<py_ast::TypeParam>,
        body: Vec<PyStmt>,
    ) {
        let previous_class_body_depth = self.class_body_depth;
        self.class_body_depth = 0;

        for decorator in decorator_list {
            self.visit_expr(decorator);
        }
        self.visit_arguments(args);
        if let Some(value) = returns {
            self.visit_expr(*value);
        }
        for type_param in type_params {
            self.visit_type_param(type_param);
        }
        for statement in body {
            self.visit_stmt(statement);
        }

        self.class_body_depth = previous_class_body_depth;
    }
}

impl PythonVisitor for PythonGraphCollector<'_, '_> {
    fn visit_stmt_import(&mut self, node: py_ast::StmtImport) {
        for alias in node.names.iter() {
            self.push_import_module(alias);
        }
    }

    fn visit_stmt_import_from(&mut self, node: py_ast::StmtImportFrom) {
        self.push_import_from(node);
    }

    fn visit_stmt_function_def(&mut self, node: py_ast::StmtFunctionDef) {
        let kind = if self.class_body_depth > 0 {
            "method"
        } else {
            "function"
        };
        let signature = python_signature_text(
            self.text,
            node.start().to_usize(),
            node.end().to_usize(),
            node.body
                .first()
                .map(|statement| statement.start().to_usize()),
        );
        self.push_definition_node(&node, &node.name, kind, Some(signature), "def");
        self.visit_function_body(
            *node.args,
            node.decorator_list,
            node.returns,
            node.type_params,
            node.body,
        );
    }

    fn visit_stmt_async_function_def(&mut self, node: py_ast::StmtAsyncFunctionDef) {
        let kind = if self.class_body_depth > 0 {
            "method"
        } else {
            "function"
        };
        let signature = python_signature_text(
            self.text,
            node.start().to_usize(),
            node.end().to_usize(),
            node.body
                .first()
                .map(|statement| statement.start().to_usize()),
        );
        self.push_definition_node(&node, &node.name, kind, Some(signature), "def");
        self.visit_function_body(
            *node.args,
            node.decorator_list,
            node.returns,
            node.type_params,
            node.body,
        );
    }

    fn visit_stmt_class_def(&mut self, node: py_ast::StmtClassDef) {
        let signature = python_signature_text(
            self.text,
            node.start().to_usize(),
            node.end().to_usize(),
            node.body
                .first()
                .map(|statement| statement.start().to_usize()),
        );
        self.push_definition_node(&node, &node.name, "class", Some(signature), "class");

        for decorator in node.decorator_list {
            self.visit_expr(decorator);
        }
        for base in node.bases {
            self.visit_expr(base);
        }
        for keyword in node.keywords {
            self.visit_keyword(keyword);
        }
        for type_param in node.type_params {
            self.visit_type_param(type_param);
        }

        self.class_body_depth += 1;
        for statement in node.body {
            self.visit_stmt(statement);
        }
        self.class_body_depth = self.class_body_depth.saturating_sub(1);
    }

    fn visit_expr_call(&mut self, node: py_ast::ExprCall) {
        self.push_call(&node);
        self.generic_visit_expr_call(node);
    }

    fn visit_expr_name(&mut self, node: py_ast::ExprName) {
        if matches!(&node.ctx, ExprContext::Load) {
            self.push_reference(node.id.to_string(), "identifier", None, &node, "syntactic");
        }
        self.generic_visit_expr_name(node);
    }
}

struct GraphCollector<'a> {
    path: &'a str,
    text: &'a str,
    line_index: &'a LineIndex<'a>,
    nodes: Vec<ExtractedNode>,
    unresolved: Vec<ExtractedUnresolved>,
    seen_names: HashSet<(u32, u32, String, String)>,
}

impl<'a> GraphCollector<'a> {
    fn push_function(&mut self, function: &Function, exported: bool) {
        let Some(id) = &function.id else { return };
        let signature = signature_text(
            self.text,
            function.span,
            function.body.as_ref().map(|body| body.span.start),
        );
        self.push_node(
            "function",
            id.name.as_str(),
            exported,
            Some(signature),
            function.span,
            id.span,
        );
    }

    fn push_class(&mut self, class: &Class, exported: bool) {
        let Some(id) = &class.id else { return };
        let signature = signature_text(self.text, class.span, Some(class.body.span.start));
        self.push_node(
            "class",
            id.name.as_str(),
            exported,
            Some(signature),
            class.span,
            id.span,
        );
    }

    fn push_variable_declaration(&mut self, declaration: &VariableDeclaration, exported: bool) {
        for declarator in declaration.declarations.iter() {
            self.push_variable_declarator(declarator, exported);
        }
    }

    fn push_variable_declarator(&mut self, declarator: &VariableDeclarator, exported: bool) {
        let Some((span, name)) = binding_name(&declarator.id) else {
            return;
        };
        self.push_node("variable", &name, exported, None, declarator.span, span);
    }

    fn push_import(&mut self, import: &ImportDeclaration) {
        let source = import.source.value.to_string();
        let range = self.line_index.range(import.span);
        if let Some(specifiers) = &import.specifiers {
            for specifier in specifiers.iter() {
                let (name, span, kind) = match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(spec) => {
                        (spec.local.name.to_string(), spec.local.span, "import-named")
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(spec) => (
                        spec.local.name.to_string(),
                        spec.local.span,
                        "import-default",
                    ),
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(spec) => (
                        spec.local.name.to_string(),
                        spec.local.span,
                        "import-namespace",
                    ),
                };
                self.unresolved.push(ExtractedUnresolved {
                    reference_name: name,
                    reference_kind: kind.to_string(),
                    source: Some(source.clone()),
                    range: self.line_index.range(span),
                    provenance: "oxc".to_string(),
                    confidence: "syntactic".to_string(),
                });
            }
        } else {
            self.unresolved.push(ExtractedUnresolved {
                reference_name: source.clone(),
                reference_kind: "import-side-effect".to_string(),
                source: Some(source.clone()),
                range,
                provenance: "oxc".to_string(),
                confidence: "syntactic".to_string(),
            });
        }
    }

    fn push_export_named<'src>(&mut self, export: &ExportNamedDeclaration<'src>) {
        if let Some(source) = &export.source {
            let source_value = source.value.to_string();
            for specifier in export.specifiers.iter() {
                let name = module_export_name_string(&specifier.exported);
                self.unresolved.push(ExtractedUnresolved {
                    reference_name: name,
                    reference_kind: "export-re-export".to_string(),
                    source: Some(source_value.clone()),
                    range: self.line_index.range(specifier.span),
                    provenance: "oxc".to_string(),
                    confidence: "syntactic".to_string(),
                });
            }
            return;
        }
        if let Some(declaration) = &export.declaration {
            self.push_declaration_exported(declaration);
            return;
        }
        for specifier in export.specifiers.iter() {
            let name = module_export_name_string(&specifier.local);
            self.unresolved.push(ExtractedUnresolved {
                reference_name: name,
                reference_kind: "export-named".to_string(),
                source: None,
                range: self.line_index.range(specifier.span),
                provenance: "oxc".to_string(),
                confidence: "syntactic".to_string(),
            });
        }
    }

    fn push_declaration_exported<'src>(&mut self, declaration: &Declaration<'src>) {
        match declaration {
            Declaration::FunctionDeclaration(function) => self.push_function(function, true),
            Declaration::ClassDeclaration(class) => self.push_class(class, true),
            Declaration::VariableDeclaration(declaration) => {
                self.push_variable_declaration(declaration, true)
            }
            Declaration::TSTypeAliasDeclaration(declaration) => {
                let span = declaration.id.span;
                self.push_node(
                    "type",
                    declaration.id.name.as_str(),
                    true,
                    None,
                    declaration.span,
                    span,
                );
            }
            Declaration::TSInterfaceDeclaration(declaration) => {
                let span = declaration.id.span;
                self.push_node(
                    "interface",
                    declaration.id.name.as_str(),
                    true,
                    None,
                    declaration.span,
                    span,
                );
            }
            Declaration::TSEnumDeclaration(declaration) => {
                let span = declaration.id.span;
                self.push_node(
                    "enum",
                    declaration.id.name.as_str(),
                    true,
                    None,
                    declaration.span,
                    span,
                );
            }
            _ => {}
        }
    }

    fn push_export_default<'src>(&mut self, export: &ExportDefaultDeclaration<'src>) {
        match &export.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                if function.id.is_some() {
                    self.push_function(function, true);
                } else {
                    let signature = signature_text(
                        self.text,
                        function.span,
                        function.body.as_ref().map(|body| body.span.start),
                    );
                    self.push_node(
                        "function",
                        "default",
                        true,
                        Some(signature),
                        function.span,
                        function.span,
                    );
                }
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                if class.id.is_some() {
                    self.push_class(class, true);
                } else {
                    self.push_node("class", "default", true, None, class.span, class.span);
                }
            }
            ExportDefaultDeclarationKind::TSInterfaceDeclaration(declaration) => {
                let span = declaration.id.span;
                self.push_node(
                    "interface",
                    declaration.id.name.as_str(),
                    true,
                    None,
                    declaration.span,
                    span,
                );
            }
            kind if kind.is_expression() => {
                let expression = kind.to_expression();
                let (node_kind, name) = match expression {
                    Expression::Identifier(identifier) => ("variable", identifier.name.to_string()),
                    Expression::ArrowFunctionExpression(_) | Expression::FunctionExpression(_) => {
                        ("function", "default".to_string())
                    }
                    Expression::ClassExpression(_) => ("class", "default".to_string()),
                    _ => ("export-default", "default".to_string()),
                };
                self.push_node(node_kind, &name, true, None, export.span, export.span);
            }
            _ => {}
        }
    }

    fn push_export_all(&mut self, export: &ExportAllDeclaration) {
        let source = export.source.value.to_string();
        let name = export
            .exported
            .as_ref()
            .map(module_export_name_string)
            .unwrap_or_else(|| "*".to_string());
        self.unresolved.push(ExtractedUnresolved {
            reference_name: name,
            reference_kind: "export-all".to_string(),
            source: Some(source),
            range: self.line_index.range(export.span),
            provenance: "oxc".to_string(),
            confidence: "syntactic".to_string(),
        });
    }

    fn push_node(
        &mut self,
        kind: &str,
        name: &str,
        exported: bool,
        signature: Option<String>,
        _outer: Span,
        identifier: Span,
    ) {
        let key = (
            identifier.start,
            identifier.end,
            kind.to_string(),
            name.to_string(),
        );
        if !self.seen_names.insert(key) {
            return;
        }
        let range = self.line_index.range(identifier);
        let qualified_name = format!("{}::{name}", self.path);
        self.nodes.push(ExtractedNode {
            kind: kind.to_string(),
            name: name.to_string(),
            qualified_name,
            exported,
            signature,
            range,
            disambiguator: format!("{}-{}", identifier.start, identifier.end),
        });
    }

    fn push_reference(
        &mut self,
        name: String,
        kind: &str,
        source: Option<String>,
        span: Span,
        confidence: &str,
    ) {
        if name.is_empty() {
            return;
        }
        self.unresolved.push(ExtractedUnresolved {
            reference_name: name,
            reference_kind: kind.to_string(),
            source,
            range: self.line_index.range(span),
            provenance: "oxc".to_string(),
            confidence: confidence.to_string(),
        });
    }
}

impl<'source> Visit<'source> for GraphCollector<'_> {
    fn visit_import_declaration(&mut self, import: &ImportDeclaration<'source>) {
        self.push_import(import);
        walk::walk_import_declaration(self, import);
    }

    fn visit_export_named_declaration(&mut self, export: &ExportNamedDeclaration<'source>) {
        self.push_export_named(export);
        walk::walk_export_named_declaration(self, export);
    }

    fn visit_export_default_declaration(&mut self, export: &ExportDefaultDeclaration<'source>) {
        self.push_export_default(export);
        walk::walk_export_default_declaration(self, export);
    }

    fn visit_export_all_declaration(&mut self, export: &ExportAllDeclaration<'source>) {
        self.push_export_all(export);
        walk::walk_export_all_declaration(self, export);
    }

    fn visit_function(&mut self, function: &Function<'source>, flags: ScopeFlags) {
        self.push_function(function, false);
        walk::walk_function(self, function, flags);
    }

    fn visit_class(&mut self, class: &Class<'source>) {
        self.push_class(class, false);
        walk::walk_class(self, class);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'source>) {
        self.push_variable_declarator(declarator, false);
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_ts_type_alias_declaration(&mut self, declaration: &TSTypeAliasDeclaration<'source>) {
        self.push_node(
            "type",
            declaration.id.name.as_str(),
            false,
            None,
            declaration.span,
            declaration.id.span,
        );
        walk::walk_ts_type_alias_declaration(self, declaration);
    }

    fn visit_ts_interface_declaration(&mut self, declaration: &TSInterfaceDeclaration<'source>) {
        self.push_node(
            "interface",
            declaration.id.name.as_str(),
            false,
            None,
            declaration.span,
            declaration.id.span,
        );
        walk::walk_ts_interface_declaration(self, declaration);
    }

    fn visit_ts_enum_declaration(&mut self, declaration: &TSEnumDeclaration<'source>) {
        self.push_node(
            "enum",
            declaration.id.name.as_str(),
            false,
            None,
            declaration.span,
            declaration.id.span,
        );
        walk::walk_ts_enum_declaration(self, declaration);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'source>) {
        let callee = call.callee.span().source_text(self.text).trim().to_string();
        let name = callee
            .rsplit(['.', '#'])
            .next()
            .unwrap_or(&callee)
            .trim()
            .to_string();
        self.push_reference(name, "call", None, call.callee.span(), "syntactic");
        walk::walk_call_expression(self, call);
    }

    fn visit_identifier_reference(&mut self, identifier: &IdentifierReference<'source>) {
        self.push_reference(
            identifier.name.to_string(),
            "identifier",
            None,
            identifier.span,
            "syntactic",
        );
        walk::walk_identifier_reference(self, identifier);
    }
}

fn binding_name(binding: &BindingPattern) -> Option<(Span, String)> {
    match binding {
        BindingPattern::BindingIdentifier(identifier) => {
            Some((identifier.span, identifier.name.to_string()))
        }
        _ => None,
    }
}

fn module_export_name_string(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

fn signature_text(text: &str, outer: Span, body_start: Option<u32>) -> String {
    let end = body_start.unwrap_or(outer.end);
    let end = end.min(outer.end);
    let start = outer.start as usize;
    let end = end as usize;
    text.get(start..end).unwrap_or("").trim().replace('\n', " ")
}

fn python_import_from_source(
    level: Option<&py_ast::Int>,
    module: Option<&py_ast::Identifier>,
) -> String {
    let relative_prefix = level
        .map(py_ast::Int::to_usize)
        .map(|level| ".".repeat(level))
        .unwrap_or_default();
    match module {
        Some(module) => format!("{relative_prefix}{module}"),
        None => relative_prefix,
    }
}

fn join_python_module_source(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        return name.to_string();
    }
    if prefix.ends_with('.') {
        format!("{prefix}{name}")
    } else {
        format!("{prefix}.{name}")
    }
}

fn python_dotted_callee(expr: &PyExpr) -> Option<String> {
    match expr {
        PyExpr::Name(name) => Some(name.id.to_string()),
        PyExpr::Attribute(attribute) => {
            let receiver = python_dotted_callee(&attribute.value)?;
            Some(format!("{receiver}.{}", attribute.attr))
        }
        _ => None,
    }
}

fn python_signature_text(
    text: &str,
    start: usize,
    end: usize,
    body_start: Option<usize>,
) -> String {
    let end = body_start.unwrap_or(end).min(end);
    text.get(start..end).unwrap_or("").trim().replace('\n', " ")
}

fn find_python_identifier_after_keyword(
    text: &str,
    start: usize,
    end: usize,
    keyword: &str,
    name: &str,
) -> Option<(usize, usize)> {
    let segment = text.get(start..end)?;
    let keyword_offset = segment.find(keyword)?;
    let search_start = start + keyword_offset + keyword.len();
    find_identifier_between(text, search_start, end, name)
}

fn find_identifier_between(
    text: &str,
    start: usize,
    end: usize,
    name: &str,
) -> Option<(usize, usize)> {
    let segment = text.get(start..end)?;
    let mut relative_start = 0;
    while let Some(found) = segment.get(relative_start..)?.find(name) {
        let absolute_start = start + relative_start + found;
        let absolute_end = absolute_start + name.len();
        if is_identifier_boundary(text, absolute_start, absolute_end) {
            return Some((absolute_start, absolute_end));
        }
        relative_start += found + name.len();
    }
    None
}

fn is_identifier_boundary(text: &str, start: usize, end: usize) -> bool {
    let before = text
        .get(..start)
        .and_then(|prefix| prefix.chars().next_back());
    let after = text.get(end..).and_then(|suffix| suffix.chars().next());
    !before.is_some_and(is_python_identifier_char) && !after.is_some_and(is_python_identifier_char)
}

fn is_python_identifier_char(character: char) -> bool {
    character == '_' || character.is_alphanumeric()
}
