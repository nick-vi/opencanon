use std::collections::HashSet;
use std::path::Path;

use oxc_allocator::Allocator;
use oxc_ast::ast::{
    Argument, ArrayExpression, BinaryExpression, BindingPattern, BooleanLiteral, CallExpression,
    Class, ClassType, Comment, Declaration, ExportAllDeclaration, ExportDefaultDeclaration,
    ExportDefaultDeclarationKind, ExportNamedDeclaration, Expression, FormalParameters, Function,
    FunctionType, ImportDeclaration, ImportDeclarationSpecifier, MethodDefinition,
    ModuleExportName, NewExpression, NumericLiteral, ObjectProperty, PropertyKey, StringLiteral,
    TSEnumDeclaration, TSInterfaceDeclaration, TSLiteral, TSType, TSTypeAliasDeclaration,
    TSUnionType, TryStatement, UnaryExpression, VariableDeclaration, VariableDeclarationKind,
    VariableDeclarator,
};
use oxc_ast_visit::{walk, Visit};
use oxc_parser::Parser;
use oxc_semantic::SemanticBuilder;
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::operator::{BinaryOperator, UnaryOperator};
use oxc_syntax::scope::ScopeFlags;
use serde_json::json;

use crate::contracts::{
    CallArgumentFact, CallFact, CommentFact, DeclarationFact, EnumMemberFact, ExportFact,
    FactDiagnostic, FactFileRequest, FileFacts, ImportFact, InitializerFact, LiteralFact,
    ObjectPropertyFact, SymbolFact,
};
use crate::python_facts::PythonExtractor;
use crate::svelte_facts::SvelteExtractor;

/// Maximum `()[]{}` nesting depth accepted for AST extraction. Real source never
/// approaches this; pathologically nested input drives unbounded recursion in the parser
/// and visitors → a native stack overflow (an uncatchable abort that kills the runtime).
pub(crate) const MAX_NESTING_DEPTH: usize = 1000;

/// Cheap pre-parse guard: true if `text` nests brackets deeper than [`MAX_NESTING_DEPTH`].
/// Conservative (counts brackets inside strings/comments too), but the limit is far above
/// any real code, so a false positive only skips a hostile file rather than crashing.
pub(crate) fn exceeds_nesting_depth(text: &str) -> bool {
    let mut depth: usize = 0;
    for byte in text.bytes() {
        match byte {
            b'(' | b'[' | b'{' => {
                depth += 1;
                if depth > MAX_NESTING_DEPTH {
                    return true;
                }
            }
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    false
}

pub(crate) fn scan_file_facts(
    file: &FactFileRequest,
    text: &str,
    requested: &HashSet<String>,
    parser_version: &str,
) -> FileFacts {
    if file.language == "svelte"
        || Path::new(&file.path)
            .extension()
            .is_some_and(|ext| ext == "svelte")
    {
        return SvelteExtractor::extract(file, text, requested, parser_version);
    }

    if file.language == "python"
        && Path::new(&file.path)
            .extension()
            .is_some_and(|ext| ext == "py")
    {
        return PythonExtractor::extract(file, text, requested, parser_version);
    }

    scan_oxc_file_facts(file, text, requested, parser_version)
}

pub(crate) fn scan_oxc_file_facts(
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
        declarations: Vec::new(),
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

    if exceeds_nesting_depth(text) {
        facts.diagnostics.push(FactDiagnostic {
            code: "input-too-deeply-nested".to_string(),
            message: format!(
                "Source nests brackets deeper than {MAX_NESTING_DEPTH}; skipping fact extraction."
            ),
            severity: "error".to_string(),
        });
        return facts;
    }

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
            push_comment_facts(&mut facts, &line_index, text, comment);
        }
    }

    let mut collector = OxcFactCollector {
        text,
        requested,
        line_index: &line_index,
        module_source_spans: HashSet::new(),
        emitted_symbols: HashSet::new(),
        emitted_declarations: HashSet::new(),
        literal_roles: Vec::new(),
        declaration_source_stack: Vec::new(),
        property_key_depth: 0,
        try_body_depth: 0,
        facts: &mut facts,
    };
    collector.visit_program(&parse_result.program);

    facts
}

fn push_comment_facts(
    facts: &mut FileFacts,
    line_index: &LineIndex,
    text: &str,
    comment: &Comment,
) {
    let (line, column) = line_index.position(comment.span);
    let content = comment.content_span().source_text(text);

    if comment.is_line() {
        let body = content.trim();
        if !body.is_empty() {
            facts.comments.push(CommentFact {
                line,
                column,
                text: body.to_string(),
                kind: "line".to_string(),
            });
        }
        return;
    }

    for (offset, raw_line) in content.split('\n').enumerate() {
        let body = raw_line.trim();
        if body.is_empty() {
            continue;
        }
        facts.comments.push(CommentFact {
            line: line + offset,
            column: if offset == 0 { column } else { 1 },
            text: body.to_string(),
            kind: "block".to_string(),
        });
    }
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

    fn position(&self, span: Span) -> (usize, usize) {
        let offset = span.start as usize;
        let line_index = self
            .starts
            .partition_point(|start| *start <= offset)
            .saturating_sub(1);
        let line_start = self.starts[line_index];
        (line_index + 1, self.utf16_column(line_start, offset))
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
}

struct OxcFactCollector<'facts, 'source> {
    text: &'source str,
    requested: &'facts HashSet<String>,
    line_index: &'facts LineIndex<'source>,
    module_source_spans: HashSet<(u32, u32)>,
    emitted_symbols: HashSet<(u32, u32, String)>,
    emitted_declarations: HashSet<(u32, u32, String)>,
    literal_roles: Vec<LiteralRole>,
    declaration_source_stack: Vec<String>,
    property_key_depth: usize,
    try_body_depth: usize,
    facts: &'facts mut FileFacts,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LiteralRole {
    Comparison,
    Argument,
    ObjectProperty,
    ArrayItem,
    TypeUnion,
    ConstObject,
    TestTitle,
}

impl LiteralRole {
    fn as_str(self) -> &'static str {
        match self {
            Self::Comparison => "comparison",
            Self::Argument => "argument",
            Self::ObjectProperty => "object-property",
            Self::ArrayItem => "array-item",
            Self::TypeUnion => "type-union",
            Self::ConstObject => "const-object",
            Self::TestTitle => "test-title",
        }
    }
}

impl<'source> OxcFactCollector<'_, 'source> {
    fn wants(&self, fact: &str) -> bool {
        self.requested.contains(fact)
    }

    fn position(&self, span: Span) -> (usize, usize) {
        self.line_index.position(span)
    }

    fn end_line(&self, span: Span) -> usize {
        let end = if span.end > span.start {
            span.end.saturating_sub(1)
        } else {
            span.start
        };
        self.position(Span::new(end, end)).0
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
        self.push_export_with_details(span, name, kind, None, None, false);
    }

    fn push_export_with_details(
        &mut self,
        span: Span,
        name: String,
        kind: &str,
        source: Option<String>,
        imported_name: Option<String>,
        type_only: bool,
    ) {
        if !self.wants("exports") {
            return;
        }
        let (line, _) = self.position(span);
        self.facts.exports.push(ExportFact {
            line,
            name,
            kind: kind.to_string(),
            source,
            imported_name,
            type_only: type_only.then_some(true),
        });
    }

    fn push_symbol(
        &mut self,
        name_span: Span,
        declaration_span: Span,
        name: String,
        kind: &str,
        exported: bool,
        params: Option<Vec<String>>,
    ) {
        if !self.wants("symbols") {
            return;
        }
        if !self
            .emitted_symbols
            .insert((name_span.start, name_span.end, name.clone()))
        {
            return;
        }
        let (line, column) = self.position(name_span);
        let end_line = self.end_line(declaration_span);
        self.facts.symbols.push(SymbolFact {
            line,
            column: Some(column),
            end_line: Some(end_line),
            name,
            kind: kind.to_string(),
            exported,
            params,
        });
    }

    fn push_declaration(
        &mut self,
        name_span: Span,
        declaration_span: Span,
        name: String,
        kind: &str,
        exported: bool,
    ) -> bool {
        if !self.wants("declarations") {
            return false;
        }
        if !self
            .emitted_declarations
            .insert((name_span.start, name_span.end, name.clone()))
        {
            return false;
        }
        let (line, _) = self.position(declaration_span);
        let end_line = self.end_line(declaration_span);
        self.facts.declarations.push(DeclarationFact {
            line,
            end_line,
            name,
            kind: kind.to_string(),
            exported,
            text: declaration_span.source_text(self.text).trim().to_string(),
            const_enum: None,
            members: Vec::new(),
            declaration_kind: None,
            initializer: None,
            r#async: None,
        });
        true
    }

    fn push_function_declaration(&mut self, function: &Function<'source>, exported: bool) {
        if function.r#type != FunctionType::FunctionDeclaration {
            return;
        }
        let Some(id) = &function.id else {
            return;
        };
        if self.push_declaration(
            id.span,
            function.span,
            id.name.to_string(),
            "function",
            exported,
        ) {
            let declaration = self
                .facts
                .declarations
                .last_mut()
                .expect("function declaration was just pushed");
            declaration.r#async = Some(function.r#async);
        }
    }

    fn push_class_declaration(&mut self, class: &Class<'source>, exported: bool) {
        if class.r#type != ClassType::ClassDeclaration {
            return;
        }
        if let Some(id) = &class.id {
            self.push_declaration(id.span, class.span, id.name.to_string(), "class", exported);
        }
    }

    fn push_type_declaration(
        &mut self,
        declaration: &TSTypeAliasDeclaration<'source>,
        exported: bool,
    ) {
        self.push_declaration(
            declaration.id.span,
            declaration.span,
            declaration.id.name.to_string(),
            "type",
            exported,
        );
    }

    fn push_interface_declaration(
        &mut self,
        declaration: &TSInterfaceDeclaration<'source>,
        exported: bool,
    ) {
        self.push_declaration(
            declaration.id.span,
            declaration.span,
            declaration.id.name.to_string(),
            "interface",
            exported,
        );
    }

    fn push_enum_declaration(&mut self, declaration: &TSEnumDeclaration<'source>, exported: bool) {
        if !self.wants("declarations") {
            return;
        }
        if !self.emitted_declarations.insert((
            declaration.id.span.start,
            declaration.id.span.end,
            declaration.id.name.to_string(),
        )) {
            return;
        }
        let (line, _) = self.position(declaration.span);
        let end_line = self.end_line(declaration.span);
        let members = declaration
            .body
            .members
            .iter()
            .map(|member| {
                let (line, _) = self.position(member.span);
                let (value, value_kind) = member
                    .initializer
                    .as_ref()
                    .map(|initializer| {
                        let (value, value_kind) = declaration_literal_value(initializer, self.text);
                        (Some(value), value_kind)
                    })
                    .unwrap_or_else(|| (None, "unknown".to_string()));
                EnumMemberFact {
                    line,
                    name: member.id.static_name().to_string(),
                    value,
                    value_kind,
                }
            })
            .collect();
        self.facts.declarations.push(DeclarationFact {
            line,
            end_line,
            name: declaration.id.name.to_string(),
            kind: "enum".to_string(),
            exported,
            text: declaration.span.source_text(self.text).trim().to_string(),
            const_enum: Some(declaration.r#const),
            members,
            declaration_kind: None,
            initializer: None,
            r#async: None,
        });
    }

    fn push_variable_declarations(
        &mut self,
        declaration: &VariableDeclaration<'source>,
        exported: bool,
    ) {
        if !self.wants("declarations") {
            return;
        }
        for declarator in declaration.declarations.iter() {
            let Some((name_span, name)) = binding_name(&declarator.id) else {
                continue;
            };
            let Some(init) = &declarator.init else {
                continue;
            };
            if !self
                .emitted_declarations
                .insert((name_span.start, name_span.end, name.clone()))
            {
                continue;
            }
            let (line, _) = self.position(declaration.span);
            let (end_line, declaration_text) =
                self.variable_declaration_text(declaration.span, init);
            self.facts.declarations.push(DeclarationFact {
                line,
                end_line,
                name,
                kind: "variable".to_string(),
                exported,
                text: declaration_text.clone(),
                const_enum: None,
                members: Vec::new(),
                declaration_kind: Some(export_variable_kind(declaration.kind).to_string()),
                initializer: Some(self.initializer_fact(init, &declaration_text, line)),
                r#async: None,
            });
        }
    }

    fn variable_declaration_text(
        &self,
        declaration_span: Span,
        init: &Expression<'source>,
    ) -> (usize, String) {
        let (line, _) = self.position(declaration_span);
        let lines = source_lines(self.text);
        let start_index = line.saturating_sub(1);
        let source = init.span().source_text(self.text);
        if !source.trim_start().starts_with('{') {
            return (
                line,
                lines
                    .get(start_index)
                    .map(|line| line.trim().to_string())
                    .unwrap_or_else(|| declaration_span.source_text(self.text).trim().to_string()),
            );
        }
        let end_index = find_initializer_end_index(&lines, start_index);
        (
            end_index + 1,
            lines
                .get(start_index..=end_index)
                .unwrap_or_default()
                .join("\n"),
        )
    }

    fn initializer_fact(
        &self,
        init: &Expression<'source>,
        declaration_text: &str,
        declaration_line: usize,
    ) -> InitializerFact {
        let initializer_text = declaration_text
            .split_once('=')
            .map(|(_, text)| text)
            .unwrap_or_else(|| init.span().source_text(self.text));
        let trimmed = initializer_text.trim_start();
        let kind = if trimmed.starts_with('{') {
            "object"
        } else if trimmed.starts_with('[') {
            "array"
        } else if initializer_text.contains('(') {
            "call"
        } else {
            "unknown"
        };
        InitializerFact {
            kind: kind.to_string(),
            as_const: has_as_const(initializer_text),
            satisfies: satisfies_type_source(initializer_text),
            properties: if kind == "object" {
                parse_object_properties(declaration_text, declaration_line)
            } else {
                Vec::new()
            },
        }
    }

    fn push_function_symbol(&mut self, function: &Function<'source>, exported: bool) {
        if let Some(id) = &function.id {
            self.push_symbol(
                id.span,
                function.span,
                id.name.to_string(),
                "function",
                exported,
                Some(self.params(&function.params)),
            );
        }
    }

    fn push_class_symbol(&mut self, class: &Class<'source>, exported: bool) {
        if let Some(id) = &class.id {
            self.push_symbol(
                id.span,
                class.span,
                id.name.to_string(),
                "class",
                exported,
                None,
            );
        }
    }

    fn push_variable_declarator_symbol(
        &mut self,
        declarator: &VariableDeclarator<'source>,
        exported: bool,
    ) {
        let Some((span, name)) = binding_name(&declarator.id) else {
            return;
        };
        let (kind, params) = self.variable_symbol_kind_and_params(declarator);
        self.push_symbol(span, declarator.span, name, kind, exported, params);
    }

    fn variable_symbol_kind_and_params(
        &self,
        declarator: &VariableDeclarator<'source>,
    ) -> (&'static str, Option<Vec<String>>) {
        match declarator.init.as_ref() {
            Some(Expression::ArrowFunctionExpression(function)) => {
                ("function", Some(self.params(&function.params)))
            }
            Some(Expression::FunctionExpression(function)) => {
                ("function", Some(self.params(&function.params)))
            }
            _ => ("variable", None),
        }
    }

    fn params(&self, params: &FormalParameters<'source>) -> Vec<String> {
        params
            .items
            .iter()
            .map(|param| param.span.source_text(self.text).trim().to_string())
            .chain(
                params
                    .rest
                    .iter()
                    .map(|rest| rest.span.source_text(self.text).trim().to_string()),
            )
            .filter(|param| !param.is_empty())
            .collect()
    }

    fn push_declaration_export(&mut self, declaration: &Declaration<'source>) {
        match declaration {
            Declaration::FunctionDeclaration(function) => {
                if let Some(id) = &function.id {
                    self.push_export(id.span, id.name.to_string(), "function");
                    self.push_function_symbol(function, true);
                    self.push_function_declaration(function, true);
                }
            }
            Declaration::ClassDeclaration(class) => {
                if let Some(id) = &class.id {
                    self.push_export(id.span, id.name.to_string(), "class");
                    self.push_class_symbol(class, true);
                    self.push_class_declaration(class, true);
                }
            }
            Declaration::VariableDeclaration(declaration) => {
                let export_kind = export_variable_kind(declaration.kind);
                for declarator in declaration.declarations.iter() {
                    if let Some((span, name)) = binding_name(&declarator.id) {
                        self.push_export(span, name.clone(), export_kind);
                        self.push_variable_declarator_symbol(declarator, true);
                    }
                }
                self.push_variable_declarations(declaration, true);
            }
            Declaration::TSTypeAliasDeclaration(declaration) => {
                self.push_export(declaration.id.span, declaration.id.name.to_string(), "type");
                self.push_symbol(
                    declaration.id.span,
                    declaration.span,
                    declaration.id.name.to_string(),
                    "type",
                    true,
                    None,
                );
                self.push_type_declaration(declaration, true);
            }
            Declaration::TSInterfaceDeclaration(declaration) => {
                self.push_export(
                    declaration.id.span,
                    declaration.id.name.to_string(),
                    "interface",
                );
                self.push_symbol(
                    declaration.id.span,
                    declaration.span,
                    declaration.id.name.to_string(),
                    "interface",
                    true,
                    None,
                );
                self.push_interface_declaration(declaration, true);
            }
            Declaration::TSEnumDeclaration(declaration) => {
                self.push_export(declaration.id.span, declaration.id.name.to_string(), "enum");
                self.push_symbol(
                    declaration.id.span,
                    declaration.span,
                    declaration.id.name.to_string(),
                    "enum",
                    true,
                    None,
                );
                self.push_enum_declaration(declaration, true);
            }
            Declaration::TSModuleDeclaration(_)
            | Declaration::TSGlobalDeclaration(_)
            | Declaration::TSImportEqualsDeclaration(_) => {}
        }
    }

    fn push_role(&mut self, role: LiteralRole) {
        self.literal_roles.push(role);
    }

    fn pop_role(&mut self) {
        self.literal_roles.pop();
    }

    fn current_literal_context(&self) -> &'static str {
        for role in [
            LiteralRole::ConstObject,
            LiteralRole::TestTitle,
            LiteralRole::TypeUnion,
            LiteralRole::ObjectProperty,
            LiteralRole::ArrayItem,
            LiteralRole::Comparison,
            LiteralRole::Argument,
        ] {
            if self.literal_roles.contains(&role) {
                return role.as_str();
            }
        }
        "unknown"
    }

    fn current_declaration_source_id(&self) -> Option<String> {
        if self.property_key_depth > 0 {
            return None;
        }
        self.declaration_source_stack.last().cloned()
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
            context: self.current_literal_context().to_string(),
            declaration_source_id: self.current_declaration_source_id(),
        });
    }

    fn call_fact(&self, call: &CallExpression<'source>) -> Option<CallFact> {
        let callee = compact_source(call.callee.span().source_text(self.text));
        let name = call_name(&callee);
        if name.is_empty() {
            return None;
        }
        let receiver = call_receiver(&callee);
        let (line, column) = self.position(call.callee.span());
        let argument_calls = call
            .arguments
            .iter()
            .filter_map(|argument| self.call_argument_fact(argument))
            .collect();
        Some(CallFact {
            line,
            column,
            name,
            receiver,
            callee,
            try_depth: self.try_body_depth,
            argument_calls,
        })
    }

    fn call_argument_fact(&self, argument: &Argument<'source>) -> Option<CallArgumentFact> {
        let (call, awaited) = argument_call_expression(argument)?;
        let callee = compact_source(call.callee.span().source_text(self.text));
        let name = call_name(&callee);
        if name.is_empty() {
            return None;
        }
        Some(CallArgumentFact {
            callee,
            name,
            awaited,
        })
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
            let source_value = source.value.to_string();
            let specifiers = export
                .specifiers
                .iter()
                .map(|specifier| module_export_name(&specifier.exported))
                .collect::<Vec<_>>();
            self.push_import(export.span, source, specifiers, "export");
            for specifier in export.specifiers.iter() {
                self.push_export_with_details(
                    specifier.span,
                    module_export_name(&specifier.exported),
                    "reexport",
                    Some(source_value.clone()),
                    Some(module_export_name(&specifier.local)),
                    export.export_kind.is_type() || specifier.export_kind.is_type(),
                );
            }
        }
        if let Some(declaration) = &export.declaration {
            self.push_declaration_export(declaration);
        }
        if export.source.is_none() {
            for specifier in export.specifiers.iter() {
                self.push_export_with_details(
                    specifier.span,
                    module_export_name(&specifier.exported),
                    "reexport",
                    None,
                    None,
                    export.export_kind.is_type() || specifier.export_kind.is_type(),
                );
            }
        }
        walk::walk_export_named_declaration(self, export);
    }

    fn visit_export_default_declaration(&mut self, export: &ExportDefaultDeclaration<'source>) {
        let kind = match &export.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(function) => {
                if function.id.is_some() {
                    self.push_function_symbol(function, true);
                } else {
                    self.push_symbol(
                        export.span,
                        function.span,
                        "default".to_string(),
                        "function",
                        true,
                        Some(self.params(&function.params)),
                    );
                }
                "function"
            }
            ExportDefaultDeclarationKind::ClassDeclaration(class) => {
                if class.id.is_some() {
                    self.push_class_symbol(class, true);
                } else {
                    self.push_symbol(
                        export.span,
                        class.span,
                        "default".to_string(),
                        "class",
                        true,
                        None,
                    );
                }
                "class"
            }
            ExportDefaultDeclarationKind::TSInterfaceDeclaration(declaration) => {
                self.push_symbol(
                    declaration.id.span,
                    declaration.span,
                    declaration.id.name.to_string(),
                    "interface",
                    true,
                    None,
                );
                "interface"
            }
            _ => "default",
        };
        self.push_export(export.span, "default".to_string(), kind);
        walk::walk_export_default_declaration(self, export);
    }

    fn visit_export_all_declaration(&mut self, export: &ExportAllDeclaration<'source>) {
        self.ignore_module_source(export.source.span);
        let source_value = export.source.value.to_string();
        let specifiers = export
            .exported
            .as_ref()
            .map(module_export_name)
            .into_iter()
            .collect::<Vec<_>>();
        self.push_import(export.span, &export.source, specifiers, "export");
        let type_only = export.export_kind.is_type();
        if let Some(exported) = &export.exported {
            self.push_export_with_details(
                export.span,
                module_export_name(exported),
                "reexport",
                Some(source_value),
                None,
                type_only,
            );
        } else {
            self.push_export_with_details(
                export.span,
                "*".to_string(),
                "star-reexport",
                Some(source_value),
                None,
                type_only,
            );
        }
        walk::walk_export_all_declaration(self, export);
    }

    fn visit_function(&mut self, function: &Function<'source>, flags: ScopeFlags) {
        self.push_function_symbol(function, false);
        self.push_function_declaration(function, false);
        walk::walk_function(self, function, flags);
    }

    fn visit_class(&mut self, class: &Class<'source>) {
        self.push_class_symbol(class, false);
        self.push_class_declaration(class, false);
        walk::walk_class(self, class);
    }

    fn visit_variable_declaration(&mut self, declaration: &VariableDeclaration<'source>) {
        self.push_variable_declarations(declaration, false);
        walk::walk_variable_declaration(self, declaration);
    }

    fn visit_variable_declarator(&mut self, declarator: &VariableDeclarator<'source>) {
        self.push_variable_declarator_symbol(declarator, false);
        self.visit_binding_pattern(&declarator.id);
        if let Some(type_annotation) = &declarator.type_annotation {
            self.visit_ts_type_annotation(type_annotation);
        }
        if let Some(init) = &declarator.init {
            if let Some(name) = const_object_declaration_name(declarator, self.text) {
                self.declaration_source_stack.push(name);
                self.push_role(LiteralRole::ConstObject);
                self.visit_expression(init);
                self.pop_role();
                self.declaration_source_stack.pop();
            } else {
                self.visit_expression(init);
            }
        }
    }

    fn visit_method_definition(&mut self, method: &MethodDefinition<'source>) {
        if let Some((span, name)) = property_key_name(&method.key, self.text) {
            self.push_symbol(
                span,
                method.span,
                name,
                "method",
                false,
                Some(self.params(&method.value.params)),
            );
        }
        walk::walk_method_definition(self, method);
    }

    fn visit_ts_type_alias_declaration(&mut self, declaration: &TSTypeAliasDeclaration<'source>) {
        self.push_symbol(
            declaration.id.span,
            declaration.span,
            declaration.id.name.to_string(),
            "type",
            false,
            None,
        );
        self.push_type_declaration(declaration, false);
        self.visit_binding_identifier(&declaration.id);
        if let Some(type_parameters) = &declaration.type_parameters {
            self.visit_ts_type_parameter_declaration(type_parameters);
        }
        if is_literal_declaration_type(&declaration.type_annotation, self.text) {
            self.declaration_source_stack
                .push(declaration.id.name.to_string());
            self.visit_ts_type(&declaration.type_annotation);
            self.declaration_source_stack.pop();
        } else {
            self.visit_ts_type(&declaration.type_annotation);
        }
    }

    fn visit_ts_interface_declaration(&mut self, declaration: &TSInterfaceDeclaration<'source>) {
        self.push_symbol(
            declaration.id.span,
            declaration.span,
            declaration.id.name.to_string(),
            "interface",
            false,
            None,
        );
        self.push_interface_declaration(declaration, false);
        walk::walk_ts_interface_declaration(self, declaration);
    }

    fn visit_ts_enum_declaration(&mut self, declaration: &TSEnumDeclaration<'source>) {
        self.push_symbol(
            declaration.id.span,
            declaration.span,
            declaration.id.name.to_string(),
            "enum",
            false,
            None,
        );
        self.push_enum_declaration(declaration, false);
        walk::walk_ts_enum_declaration(self, declaration);
    }

    fn visit_call_expression(&mut self, call: &CallExpression<'source>) {
        if self.wants("calls") {
            if let Some(fact) = self.call_fact(call) {
                self.facts.calls.push(fact);
            }
        }
        self.visit_expression(&call.callee);
        if let Some(type_arguments) = &call.type_arguments {
            self.visit_ts_type_parameter_instantiation(type_arguments);
        }
        let is_test_call = is_test_title_call(call, self.text);
        for (index, argument) in call.arguments.iter().enumerate() {
            let role =
                if index == 0 && is_test_call && argument_starts_with_string(argument, self.text) {
                    LiteralRole::TestTitle
                } else {
                    LiteralRole::Argument
                };
            self.push_role(role);
            self.visit_argument(argument);
            self.pop_role();
        }
    }

    fn visit_new_expression(&mut self, expression: &NewExpression<'source>) {
        self.visit_expression(&expression.callee);
        if let Some(type_arguments) = &expression.type_arguments {
            self.visit_ts_type_parameter_instantiation(type_arguments);
        }
        for argument in expression.arguments.iter() {
            self.push_role(LiteralRole::Argument);
            self.visit_argument(argument);
            self.pop_role();
        }
    }

    fn visit_array_expression(&mut self, expression: &ArrayExpression<'source>) {
        for element in expression.elements.iter() {
            self.push_role(LiteralRole::ArrayItem);
            self.visit_array_expression_element(element);
            self.pop_role();
        }
    }

    fn visit_object_property(&mut self, property: &ObjectProperty<'source>) {
        self.property_key_depth += 1;
        self.visit_property_key(&property.key);
        self.property_key_depth -= 1;

        self.push_role(LiteralRole::ObjectProperty);
        self.visit_expression(&property.value);
        self.pop_role();
    }

    fn visit_binary_expression(&mut self, expression: &BinaryExpression<'source>) {
        if is_comparison_operator(expression.operator) {
            self.push_role(LiteralRole::Comparison);
            self.visit_expression(&expression.left);
            self.visit_expression(&expression.right);
            self.pop_role();
        } else {
            self.visit_expression(&expression.left);
            self.visit_expression(&expression.right);
        }
    }

    fn visit_ts_union_type(&mut self, union: &TSUnionType<'source>) {
        for ty in union.types.iter() {
            if is_literal_type_member(ty, self.text) {
                self.push_role(LiteralRole::TypeUnion);
                self.visit_ts_type(ty);
                self.pop_role();
            } else {
                self.visit_ts_type(ty);
            }
        }
    }

    fn visit_unary_expression(&mut self, expression: &UnaryExpression<'source>) {
        if expression.operator == UnaryOperator::UnaryNegation {
            if let Expression::NumericLiteral(literal) = &expression.argument {
                if let Some(value) =
                    regex_decimal_literal_value(expression.span.source_text(self.text))
                {
                    self.push_literal(expression.span, value, "number");
                    return;
                }
                if regex_decimal_literal_value(literal_source(literal, self.text)).is_none() {
                    return;
                }
            }
        }
        walk::walk_unary_expression(self, expression);
    }

    fn visit_try_statement(&mut self, statement: &TryStatement<'source>) {
        self.try_body_depth += 1;
        self.visit_block_statement(&statement.block);
        self.try_body_depth -= 1;
        if let Some(handler) = &statement.handler {
            self.visit_catch_clause(handler);
        }
        if let Some(finalizer) = &statement.finalizer {
            self.visit_block_statement(finalizer);
        }
    }

    fn visit_string_literal(&mut self, literal: &StringLiteral<'source>) {
        self.push_literal(
            literal.span,
            raw_string_literal_value(literal, self.text),
            "string",
        );
        walk::walk_string_literal(self, literal);
    }

    fn visit_numeric_literal(&mut self, literal: &NumericLiteral<'source>) {
        if let Some(value) = regex_decimal_literal_value(literal_source(literal, self.text)) {
            self.push_literal(literal.span, value, "number");
        }
        walk::walk_numeric_literal(self, literal);
    }

    fn visit_boolean_literal(&mut self, literal: &BooleanLiteral) {
        self.push_literal(literal.span, literal.value.to_string(), "boolean");
        walk::walk_boolean_literal(self, literal);
    }
}

fn source_type_for_file(file: &str, language: &str) -> Result<SourceType, String> {
    if language == "python" && Path::new(file).extension().is_some_and(|ext| ext == "py") {
        return Err(format!(
            "Python files are extracted by rustpython, not Oxc, got {language} for {file}."
        ));
    }
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

fn property_key_name(key: &PropertyKey, text: &str) -> Option<(Span, String)> {
    match key {
        PropertyKey::StaticIdentifier(identifier) => {
            Some((identifier.span, identifier.name.to_string()))
        }
        PropertyKey::PrivateIdentifier(identifier) => Some((
            identifier.span,
            identifier.span.source_text(text).to_string(),
        )),
        PropertyKey::StringLiteral(literal) => Some((literal.span, literal.value.to_string())),
        PropertyKey::NumericLiteral(literal) => {
            let name = literal
                .raw
                .as_ref()
                .map(ToString::to_string)
                .unwrap_or_else(|| literal.value.to_string());
            Some((literal.span, name))
        }
        _ => {
            let name = key.span().source_text(text).trim().to_string();
            (!name.is_empty()).then_some((key.span(), name))
        }
    }
}

fn argument_call_expression<'argument, 'source>(
    argument: &'argument Argument<'source>,
) -> Option<(&'argument CallExpression<'source>, bool)> {
    match argument {
        Argument::CallExpression(call) => Some((&**call, false)),
        Argument::AwaitExpression(await_expression) => match &await_expression.argument {
            Expression::CallExpression(call) => Some((&**call, true)),
            _ => None,
        },
        _ => None,
    }
}

fn compact_source(source: &str) -> String {
    source.chars().filter(|ch| !ch.is_whitespace()).collect()
}

fn call_name(callee: &str) -> String {
    callee
        .rsplit(['.', '#'])
        .next()
        .unwrap_or(callee)
        .trim_start_matches('?')
        .to_string()
}

fn call_receiver(callee: &str) -> Option<String> {
    let delimiter = match (callee.rfind('.'), callee.rfind('#')) {
        (Some(dot), Some(hash)) => Some(dot.max(hash)),
        (Some(dot), None) => Some(dot),
        (None, Some(hash)) => Some(hash),
        (None, None) => None,
    }?;
    let receiver = callee[..delimiter]
        .trim_end_matches('.')
        .trim_end_matches('?');
    if receiver.is_empty() || !is_dotted_identifier_chain(receiver) {
        return None;
    }
    Some(receiver.to_string())
}

fn is_dotted_identifier_chain(value: &str) -> bool {
    value.split('.').all(is_identifier_like)
}

fn is_identifier_like(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '#' || first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
}

fn export_variable_kind(kind: VariableDeclarationKind) -> &'static str {
    match kind {
        VariableDeclarationKind::Const => "const",
        VariableDeclarationKind::Let => "let",
        VariableDeclarationKind::Var => "var",
        VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing => "const",
    }
}

fn declaration_literal_value(expression: &Expression, text: &str) -> (String, String) {
    match expression {
        Expression::StringLiteral(literal) => (
            raw_string_literal_value(literal, text),
            "string".to_string(),
        ),
        Expression::NumericLiteral(literal) => {
            regex_decimal_literal_value(literal_source(literal, text))
                .map(|value| (value, "number".to_string()))
                .unwrap_or_else(|| {
                    (
                        expression.span().source_text(text).trim().to_string(),
                        "unknown".to_string(),
                    )
                })
        }
        Expression::BooleanLiteral(literal) => (literal.value.to_string(), "boolean".to_string()),
        Expression::UnaryExpression(unary) if unary.operator == UnaryOperator::UnaryNegation => {
            if matches!(&unary.argument, Expression::NumericLiteral(_)) {
                regex_decimal_literal_value(unary.span.source_text(text))
                    .map(|value| (value, "number".to_string()))
                    .unwrap_or_else(|| {
                        (
                            expression.span().source_text(text).trim().to_string(),
                            "unknown".to_string(),
                        )
                    })
            } else {
                (
                    expression.span().source_text(text).trim().to_string(),
                    "unknown".to_string(),
                )
            }
        }
        _ => (
            expression.span().source_text(text).trim().to_string(),
            "unknown".to_string(),
        ),
    }
}

fn parse_object_properties(text: &str, first_line: usize) -> Vec<ObjectPropertyFact> {
    text.lines()
        .enumerate()
        .filter_map(|(index, line)| parse_object_property_line(line, first_line + index))
        .collect()
}

fn source_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect()
}

fn find_initializer_end_index(lines: &[String], start_index: usize) -> usize {
    let mut depth = 0isize;
    for (index, line) in lines.iter().enumerate().skip(start_index) {
        for char in line.chars() {
            if char == '{' {
                depth += 1;
            }
            if char == '}' {
                depth -= 1;
            }
        }
        if depth == 0 && index > start_index {
            return index;
        }
    }
    start_index
}

fn parse_object_property_line(line: &str, line_number: usize) -> Option<ObjectPropertyFact> {
    let trimmed = line.trim();
    let colon = trimmed.find(':')?;
    let raw_key = trimmed[..colon].trim();
    let mut raw_value = trimmed[colon + 1..].trim();
    if raw_value.is_empty() {
        return None;
    }
    if raw_value.ends_with(',') {
        raw_value = raw_value[..raw_value.len() - 1].trim_end();
    }
    if raw_value.is_empty() || raw_value.contains(',') {
        return None;
    }
    let (key, quoted) = parse_object_property_key(raw_key)?;
    let (value, value_kind) = declaration_text_value(raw_value);
    Some(ObjectPropertyFact {
        line: line_number,
        key,
        quoted,
        value,
        value_kind,
    })
}

fn parse_object_property_key(raw_key: &str) -> Option<(String, bool)> {
    if is_declaration_identifier(raw_key) {
        return Some((raw_key.to_string(), false));
    }
    let mut chars = raw_key.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    if !raw_key.ends_with(quote) || raw_key.len() < 2 {
        return None;
    }
    let inner = &raw_key[1..raw_key.len() - 1];
    (!inner.contains(quote)).then(|| (inner.to_string(), true))
}

fn declaration_text_value(raw_value: &str) -> (String, String) {
    if let Some(value) = quoted_text_value(raw_value) {
        return (value, "string".to_string());
    }
    if regex_decimal_literal_value(raw_value).is_some() {
        return (raw_value.to_string(), "number".to_string());
    }
    if matches!(raw_value, "true" | "false") {
        return (raw_value.to_string(), "boolean".to_string());
    }
    (raw_value.to_string(), "unknown".to_string())
}

fn quoted_text_value(raw_value: &str) -> Option<String> {
    let mut chars = raw_value.chars();
    let quote = chars.next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    if !raw_value.ends_with(quote) || raw_value.len() < 3 {
        return None;
    }
    let inner = &raw_value[1..raw_value.len() - 1];
    (!inner.is_empty() && !inner.contains(quote)).then(|| inner.to_string())
}

fn is_declaration_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
}

fn satisfies_type_source(source: &str) -> Option<String> {
    let bytes = source.as_bytes();
    let mut index = 0;
    while index + 9 <= bytes.len() {
        let relative = source[index..].find("satisfies")?;
        let start = index + relative;
        let end = start + "satisfies".len();
        if is_regex_word_boundary(bytes, start, end) {
            let value = source[end..].trim();
            if value.is_empty() || value.contains(';') {
                return None;
            }
            return Some(value.to_string());
        }
        index = end;
    }
    None
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

fn const_object_declaration_name(declarator: &VariableDeclarator, text: &str) -> Option<String> {
    if declarator.kind != VariableDeclarationKind::Const {
        return None;
    }
    let (_, name) = binding_name(&declarator.id)?;
    let init = declarator.init.as_ref()?;
    let source = init.span().source_text(text).trim_start();
    (source.starts_with('{') && has_as_const(source)).then_some(name)
}

fn has_as_const(source: &str) -> bool {
    let bytes = source.as_bytes();
    let mut index = 0;
    while index + 2 <= bytes.len() {
        let Some(relative) = source[index..].find("as") else {
            return false;
        };
        let start = index + relative;
        let after_as = start + 2;
        if is_regex_word_boundary(bytes, start, after_as) {
            let mut cursor = after_as;
            let mut saw_whitespace = false;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                saw_whitespace = true;
                cursor += 1;
            }
            let after_const = cursor + 5;
            if saw_whitespace
                && after_const <= bytes.len()
                && &source[cursor..after_const] == "const"
                && is_regex_word_boundary(bytes, cursor, after_const)
            {
                return true;
            }
        }
        index = after_as;
    }
    false
}

fn is_regex_word_boundary(bytes: &[u8], start: usize, end: usize) -> bool {
    !start
        .checked_sub(1)
        .and_then(|index| bytes.get(index))
        .is_some_and(|byte| is_regex_word_byte(*byte))
        && !bytes.get(end).is_some_and(|byte| is_regex_word_byte(*byte))
}

fn is_regex_word_byte(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphanumeric()
}

fn is_literal_declaration_type(ty: &TSType, text: &str) -> bool {
    match ty {
        TSType::TSLiteralType(literal) => is_supported_ts_literal(&literal.literal, text),
        TSType::TSUnionType(union) => union
            .types
            .iter()
            .all(|member| is_literal_type_member(member, text)),
        _ => false,
    }
}

fn is_literal_type_member(ty: &TSType, text: &str) -> bool {
    match ty {
        TSType::TSLiteralType(literal) => is_supported_ts_literal(&literal.literal, text),
        _ => false,
    }
}

fn is_supported_ts_literal(literal: &TSLiteral, text: &str) -> bool {
    match literal {
        TSLiteral::BooleanLiteral(_) | TSLiteral::StringLiteral(_) => true,
        TSLiteral::NumericLiteral(literal) => {
            regex_decimal_literal_value(literal_source(literal, text)).is_some()
        }
        TSLiteral::UnaryExpression(expression) => {
            expression.operator == UnaryOperator::UnaryNegation
                && matches!(&expression.argument, Expression::NumericLiteral(_))
                && regex_decimal_literal_value(expression.span.source_text(text)).is_some()
        }
        _ => false,
    }
}

fn raw_string_literal_value(literal: &StringLiteral, text: &str) -> String {
    let raw = literal.span.source_text(text);
    if raw.len() >= 2 && (raw.starts_with('"') || raw.starts_with('\'')) {
        raw[1..raw.len() - 1].to_string()
    } else {
        literal.value.to_string()
    }
}

fn literal_source<'a>(literal: &'a NumericLiteral, text: &'a str) -> &'a str {
    literal.span.source_text(text)
}

fn regex_decimal_literal_value(source: &str) -> Option<String> {
    let source = source.trim();
    if source.is_empty() || source.starts_with('+') || source.starts_with('.') {
        return None;
    }
    let (sign, body) = source
        .strip_prefix('-')
        .map_or(("", source), |rest| ("-", rest));
    if body.is_empty() || body.starts_with('.') {
        return None;
    }
    let body = body.strip_suffix('.').unwrap_or(body);
    let mut parts = body.split('.');
    let whole = parts.next().unwrap_or_default();
    let fraction = parts.next();
    if parts.next().is_some() || whole.is_empty() || !whole.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    if let Some(fraction) = fraction {
        if fraction.is_empty() || !fraction.chars().all(|ch| ch.is_ascii_digit()) {
            return None;
        }
    }
    Some(format!("{sign}{body}"))
}

fn is_comparison_operator(operator: BinaryOperator) -> bool {
    matches!(
        operator,
        BinaryOperator::Equality
            | BinaryOperator::Inequality
            | BinaryOperator::StrictEquality
            | BinaryOperator::StrictInequality
            | BinaryOperator::LessThan
            | BinaryOperator::LessEqualThan
            | BinaryOperator::GreaterThan
            | BinaryOperator::GreaterEqualThan
    )
}

fn is_test_title_call(call: &CallExpression, text: &str) -> bool {
    matches!(
        call_name(&compact_source(call.callee.span().source_text(text))).as_str(),
        "it" | "test" | "describe"
    )
}

fn argument_starts_with_string(argument: &Argument, text: &str) -> bool {
    let source = argument.span().source_text(text).trim_start();
    source.starts_with('"') || source.starts_with('\'')
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
