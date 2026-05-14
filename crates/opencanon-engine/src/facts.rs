use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    BindingPattern, BooleanLiteral, CallExpression, Class, Declaration, ExportAllDeclaration,
    ExportDefaultDeclaration, ExportDefaultDeclarationKind, ExportNamedDeclaration, Function,
    ImportDeclaration, ImportDeclarationSpecifier, ModuleExportName, NumericLiteral, StringLiteral,
    VariableDeclarationKind, VariableDeclarator,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::scope::ScopeFlags;
use serde_json::json;

use crate::contracts::{
    CallFact, CommentFact, ExportFact, FactDiagnostic, FactFileRequest, FileFacts, ImportFact,
    LiteralFact, SymbolFact,
};

pub(crate) fn scan_file_facts(
    file: &FactFileRequest,
    text: &str,
    requested: &HashSet<String>,
    parser_version: &str,
) -> FileFacts {
    let mut facts = FileFacts {
        path: file.path.clone(),
        content_hash: file.content_hash.clone(),
        language: file.language.clone(),
        parser: "oxc".to_string(),
        parser_version: parser_version.to_string(),
        imports: Vec::new(),
        exports: Vec::new(),
        symbols: Vec::new(),
        calls: Vec::new(),
        literals: Vec::new(),
        comments: Vec::new(),
        diagnostics: Vec::new(),
    };

    if requested.is_empty() {
        return facts;
    }

    let source_type = match source_type_for_file(&file.path, &file.language) {
        Ok(source_type) => source_type,
        Err(message) => {
            facts.diagnostics.push(FactDiagnostic {
                code: "unsupported-language-facts".to_string(),
                message,
                severity: "error".to_string(),
            });
            return facts;
        }
    };

    let allocator = Allocator::default();
    let parse_result = Parser::new(&allocator, text, source_type).parse();
    for error in parse_result.errors {
        facts.diagnostics.push(FactDiagnostic {
            code: "parse-error".to_string(),
            message: format!("{error:?}"),
            severity: "error".to_string(),
        });
    }
    let semantic_result = SemanticBuilder::new()
        .with_check_syntax_error(true)
        .build(&parse_result.program);
    for error in semantic_result.errors {
        facts.diagnostics.push(FactDiagnostic {
            code: "semantic-error".to_string(),
            message: format!("{error:?}"),
            severity: "error".to_string(),
        });
    }

    let line_index = LineIndex::new(text);
    if requested.contains("comments") {
        for comment in parse_result.program.comments.iter() {
            let (line, column) = line_index.position(comment.content_span());
            facts.comments.push(CommentFact {
                line,
                column,
                text: comment.content_span().source_text(text).trim().to_string(),
                kind: if comment.is_line() { "line" } else { "block" }.to_string(),
            });
        }
    }

    let mut collector = OxcFactCollector {
        text,
        requested,
        line_index: &line_index,
        module_source_spans: HashSet::new(),
        emitted_symbols: HashSet::new(),
        facts: &mut facts,
    };
    collector.visit_program(&parse_result.program);

    facts
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

    fn position(&self, span: Span) -> (usize, usize) {
        let offset = span.start as usize;
        let line_index = self
            .starts
            .partition_point(|start| *start <= offset)
            .saturating_sub(1);
        (
            line_index + 1,
            offset.saturating_sub(self.starts[line_index]) + 1,
        )
    }
}

struct OxcFactCollector<'facts, 'source> {
    text: &'source str,
    requested: &'facts HashSet<String>,
    line_index: &'facts LineIndex,
    module_source_spans: HashSet<(u32, u32)>,
    emitted_symbols: HashSet<(u32, u32, String)>,
    facts: &'facts mut FileFacts,
}

impl<'source> OxcFactCollector<'_, 'source> {
    fn wants(&self, fact: &str) -> bool {
        self.requested.contains(fact)
    }

    fn position(&self, span: Span) -> (usize, usize) {
        self.line_index.position(span)
    }

    fn ignore_module_source(&mut self, span: Span) {
        self.module_source_spans.insert((span.start, span.end));
    }

    fn is_ignored_module_source(&self, span: Span) -> bool {
        self.module_source_spans.contains(&(span.start, span.end))
    }

    fn push_import(
        &mut self,
        span: Span,
        source: &StringLiteral<'source>,
        specifiers: Vec<String>,
        kind: &str,
    ) {
        if !self.wants("imports") {
            return;
        }
        let (line, column) = self.position(span);
        self.facts.imports.push(ImportFact {
            line,
            column: Some(column),
            source: source.value.to_string(),
            specifiers,
            kind: kind.to_string(),
            resolution: "unresolved".to_string(),
        });
    }

    fn push_export(&mut self, span: Span, name: String, kind: &str) {
        if !self.wants("exports") {
            return;
        }
        let (line, _) = self.position(span);
        self.facts.exports.push(ExportFact {
            line,
            name,
            kind: kind.to_string(),
        });
    }

    fn push_symbol(&mut self, span: Span, name: String, kind: &str, exported: bool) {
        if !self.wants("symbols") {
            return;
        }
        if !self
            .emitted_symbols
            .insert((span.start, span.end, name.clone()))
        {
            return;
        }
        let (line, _) = self.position(span);
        self.facts.symbols.push(SymbolFact {
            line,
            name,
            kind: kind.to_string(),
            exported,
        });
    }

    fn push_declaration_export(&mut self, declaration: &Declaration<'source>) {
        match declaration {
            Declaration::FunctionDeclaration(function) => {
                if let Some(id) = &function.id {
                    self.push_export(id.span, id.name.to_string(), "function");
                    self.push_symbol(id.span, id.name.to_string(), "function", true);
                }
            }
            Declaration::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    self.push_export(id.span, id.name.to_string(), "class");
                    self.push_symbol(id.span, id.name.to_string(), "class", true);
                }
            }
            Declaration::VariableDeclaration(declaration) => {
                let export_kind = export_variable_kind(declaration.kind);
                for declarator in declaration.declarations.iter() {
                    if let Some((span, name)) = binding_name(&declarator.id) {
                        self.push_export(span, name.clone(), export_kind);
                        self.push_symbol(span, name, "variable", true);
                    }
                }
            }
            Declaration::TSTypeAliasDeclaration(declaration) => {
                self.push_export(declaration.id.span, declaration.id.name.to_string(), "type");
                self.push_symbol(
                    declaration.id.span,
                    declaration.id.name.to_string(),
                    "type",
                    true,
                );
            }
            Declaration::TSInterfaceDeclaration(declaration) => {
                self.push_export(
                    declaration.id.span,
                    declaration.id.name.to_string(),
                    "interface",
                );
                self.push_symbol(
                    declaration.id.span,
                    declaration.id.name.to_string(),
                    "interface",
                    true,
                );
            }
            Declaration::TSEnumDeclaration(declaration) => {
                self.push_export(declaration.id.span, declaration.id.name.to_string(), "enum");
                self.push_symbol(
                    declaration.id.span,
                    declaration.id.name.to_string(),
                    "enum",
                    true,
                );
            }
            Declaration::TSModuleDeclaration(_)
            | Declaration::TSGlobalDeclaration(_)
            | Declaration::TSImportEqualsDeclaration(_) => {}
        }
    }

    fn push_literal(&mut self, span: Span, value: String, value_kind: &str) {
        if !self.wants("literals") || self.is_ignored_module_source(span) {
            return;
        }
        let (line, column) = self.position(span);
        self.facts.literals.push(LiteralFact {
            line,
            column,
            value,
            value_kind: value_kind.to_string(),
            context: literal_context(self.text, span),
        });
    }
}

impl<'source> Visit<'source> for OxcFactCollector<'_, 'source> {
    fn visit_import_declaration(&mut self, import: &ImportDeclaration<'source>) {
        self.ignore_module_source(import.source.span);
        let specifiers = import_specifiers(import);
        self.push_import(import.span, &import.source, specifiers, "import");
        walk::walk_import_declaration(self, import);
    }

    fn visit_export_named_declaration(&mut self, export: &ExportNamedDeclaration<'source>) {
        if let Some(source) = &export.source {
            self.ignore_module_source(source.span);
            let specifiers = export
                .specifiers
                .iter()
                .map(|specifier| module_export_name(&specifier.exported))
                .collect::<Vec<_>>();
            self.push_import(export.span, source, specifiers, "export");
        }
        if let Some(declaration) = &export.declaration {
            self.push_declaration_export(declaration);
        }
        for specifier in export.specifiers.iter() {
            self.push_export(
                specifier.span,
                module_export_name(&specifier.exported),
                "unknown",
            );
        }
        walk::walk_export_named_declaration(self, export);
    }

    fn visit_export_default_declaration(&mut self, export: &ExportDefaultDeclaration<'source>) {
        let kind = match &export.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                if let Some(id) = &function.id {
                    self.push_symbol(id.span, id.name.to_string(), "function", true);
                }
                "function"
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    self.push_symbol(id.span, id.name.to_string(), "class", true);
                }
                "class"
            }
            ExportDefaultDeclarationKind::TSInterfaceDeclaration(_) => "interface",
            _ => "default",
        };
        self.push_export(export.span, "default".to_string(), kind);
        walk::walk_export_default_declaration(self, export);
    }

    fn visit_export_all_declaration(&mut self, export: &ExportAllDeclaration<'source>) {
        self.ignore_module_source(export.source.span);
        let specifiers = export
            .exported
            .as_ref()
            .map(module_export_name)
            .into_iter()
            .collect::<Vec<_>>();
        self.push_import(export.span, &export.source, specifiers, "export");
        walk::walk_export_all_declaration(self, export);
    }

    fn visit_function(&mut self, function: &Function<'source>, flags: ScopeFlags) {
        if let Some(id) = &function.id {
            self.push_symbol(id.span, id.name.to_string(), "function", false);
        }
        walk::walk_function(self, function, flags);
    }

    fn visit_class(&mut self, class: &Class<'source>) {
        if let Some(id) = &class.id {
            self.push_symbol(id.span, id.name.to_string(), "class", false);
        }
        walk::walk_class(self, class);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'source>) {
        if let Some((span, name)) = binding_name(&declarator.id) {
            self.push_symbol(span, name, "variable", false);
        }
        walk::walk_variable_declarator(self, declarator);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'source>) {
        if self.wants("calls") {
            let callee = call.callee.span().source_text(self.text).to_string();
            let name = callee
                .rsplit(['.', '#'])
                .next()
                .unwrap_or(&callee)
                .trim()
                .to_string();
            if !name.is_empty() {
                let (line, _) = self.position(call.callee.span());
                self.facts.calls.push(CallFact { line, name, callee });
            }
        }
        walk::walk_call_expression(self, call);
    }

    fn visit_string_literal(&mut self, literal: &StringLiteral<'source>) {
        self.push_literal(literal.span, literal.value.to_string(), "string");
        walk::walk_string_literal(self, literal);
    }

    fn visit_numeric_literal(&mut self, literal: &NumericLiteral<'source>) {
        let value = literal
            .raw
            .as_ref()
            .map(ToString::to_string)
            .unwrap_or_else(|| literal.value.to_string());
        self.push_literal(literal.span, value, "number");
        walk::walk_numeric_literal(self, literal);
    }

    fn visit_boolean_literal(&mut self, literal: &BooleanLiteral) {
        self.push_literal(literal.span, literal.value.to_string(), "boolean");
        walk::walk_boolean_literal(self, literal);
    }
}

fn source_type_for_file(file: &str, language: &str) -> Result<SourceType, String> {
    if !matches!(language, "typescript" | "tsx" | "javascript" | "jsx") {
        return Err(format!("Engine Oxc fact extraction only supports JavaScript and TypeScript files, got {language} for {file}."));
    }
    SourceType::from_path(file)
        .map_err(|error| format!("Could not infer Oxc source type for {file}: {error}"))
}

fn binding_name(binding: &BindingPattern) -> Option<(Span, String)> {
    match binding {
        BindingPattern::BindingIdentifier(identifier) => {
            Some((identifier.span, identifier.name.to_string()))
        }
        _ => None,
    }
}

fn module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

fn export_variable_kind(kind: VariableDeclarationKind) -> &'static str {
    match kind {
        VariableDeclarationKind::Const => "const",
        VariableDeclarationKind::Let => "let",
        VariableDeclarationKind::Var => "var",
        VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing => "unknown",
    }
}

fn import_specifiers(import: &ImportDeclaration) -> Vec<String> {
    import
        .specifiers
        .as_ref()
        .map(|specifiers| {
            specifiers
                .iter()
                .map(|specifier| match specifier {
                    ImportDeclarationSpecifier::ImportSpecifier(specifier) => {
                        specifier.local.name.to_string()
                    }
                    ImportDeclarationSpecifier::ImportDefaultSpecifier(specifier) => {
                        specifier.local.name.to_string()
                    }
                    ImportDeclarationSpecifier::ImportNamespaceSpecifier(specifier) => {
                        specifier.local.name.to_string()
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn literal_context(text: &str, span: Span) -> String {
    let start = span.start as usize;
    let line_start = text[..start]
        .rfind('\n')
        .map(|index| index + 1)
        .unwrap_or(0);
    let line_end = text[start..]
        .find('\n')
        .map(|index| start + index)
        .unwrap_or(text.len());
    let line = &text[line_start..line_end];
    if line.contains("===") || line.contains("!==") {
        return "comparison".to_string();
    }
    if line.contains(':') {
        return "object-property".to_string();
    }
    if line.contains('(') {
        return "argument".to_string();
    }
    "unknown".to_string()
}

pub(crate) fn package_nodes(package_manifests: &[String]) -> Vec<serde_json::Value> {
    package_manifests
        .iter()
        .map(|manifest| {
            let root = Path::new(manifest)
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_string_lossy()
                .to_string();
            let name = if root.is_empty() {
                "<root>".to_string()
            } else {
                root.clone()
            };
            let kind = if root.is_empty() {
                "root"
            } else if root.starts_with("apps/") {
                "app"
            } else if root.starts_with("packages/") {
                "package"
            } else {
                "workspace"
            };
            json!({
              "name": name,
              "root": root,
              "kind": kind,
              "dependencies": {},
            })
        })
        .collect()
}
