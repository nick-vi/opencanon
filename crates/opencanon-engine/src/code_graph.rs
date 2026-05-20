use std::collections::HashSet;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, Class, Declaration, ExportAllDeclaration, ExportDefaultDeclaration,
    ExportDefaultDeclarationKind, ExportNamedDeclaration, Expression, Function, ImportDeclaration,
    ImportDeclarationSpecifier, ModuleExportName, Program, VariableDeclaration, VariableDeclarator,
};
use oxc_parser::Parser;
use oxc_span::{SourceType, Span};
use serde::{Deserialize, Serialize};

pub(crate) trait CodeExtractor {
    fn extract(&self, input: CodeExtractionInput<'_>) -> CodeExtractionResult;
}

pub(crate) struct OxcExtractor;

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

struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(text: &str) -> Self {
        let mut starts = vec![0];
        for (index, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                starts.push(index + 1);
            }
        }
        Self { starts }
    }

    fn line_column(&self, offset: usize) -> (u32, u32) {
        let line_index = self
            .starts
            .partition_point(|start| *start <= offset)
            .saturating_sub(1);
        let line = (line_index as u32) + 1;
        let column = (offset.saturating_sub(self.starts[line_index]) as u32) + 1;
        (line, column)
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
        if !language_is_supported(input.language) {
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
        collector.visit_program(&parse_result.program);

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

struct GraphCollector<'a> {
    path: &'a str,
    text: &'a str,
    line_index: &'a LineIndex,
    nodes: Vec<ExtractedNode>,
    unresolved: Vec<ExtractedUnresolved>,
    seen_names: HashSet<(u32, u32, String, String)>,
}

impl<'a> GraphCollector<'a> {
    fn visit_program<'src>(&mut self, program: &Program<'src>) {
        for statement in program.body.iter() {
            match statement {
                oxc_ast::ast::Statement::FunctionDeclaration(function) => {
                    self.push_function(function, false);
                }
                oxc_ast::ast::Statement::ClassDeclaration(class) => {
                    self.push_class(class, false);
                }
                oxc_ast::ast::Statement::VariableDeclaration(declaration) => {
                    self.push_variable_declaration(declaration, false);
                }
                oxc_ast::ast::Statement::TSTypeAliasDeclaration(declaration) => {
                    let span = declaration.id.span;
                    self.push_node(
                        "type",
                        declaration.id.name.as_str(),
                        false,
                        None,
                        declaration.span,
                        span,
                    );
                }
                oxc_ast::ast::Statement::TSInterfaceDeclaration(declaration) => {
                    let span = declaration.id.span;
                    self.push_node(
                        "interface",
                        declaration.id.name.as_str(),
                        false,
                        None,
                        declaration.span,
                        span,
                    );
                }
                oxc_ast::ast::Statement::TSEnumDeclaration(declaration) => {
                    let span = declaration.id.span;
                    self.push_node(
                        "enum",
                        declaration.id.name.as_str(),
                        false,
                        None,
                        declaration.span,
                        span,
                    );
                }
                oxc_ast::ast::Statement::ImportDeclaration(declaration) => {
                    self.push_import(declaration);
                }
                oxc_ast::ast::Statement::ExportNamedDeclaration(export) => {
                    self.push_export_named(export);
                }
                oxc_ast::ast::Statement::ExportDefaultDeclaration(export) => {
                    self.push_export_default(export);
                }
                oxc_ast::ast::Statement::ExportAllDeclaration(export) => {
                    self.push_export_all(export);
                }
                _ => {}
            }
        }
    }

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
