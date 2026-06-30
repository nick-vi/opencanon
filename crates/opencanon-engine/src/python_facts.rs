use std::collections::HashSet;

use rustpython_parser::ast::{self, Expr, Ranged, Stmt, Visitor};
use rustpython_parser::{parse, Mode};

use crate::contracts::{
    CallArgumentFact, CallFact, FactDiagnostic, FactFileRequest, FileFacts, ImportFact, SymbolFact,
};

pub(crate) struct PythonExtractor;

impl PythonExtractor {
    pub(crate) fn extract(
        file: &FactFileRequest,
        text: &str,
        requested: &HashSet<String>,
        parser_version: &str,
    ) -> FileFacts {
        let mut facts = FileFacts {
            path: file.path.clone(),
            content_hash: file.content_hash.clone(),
            language: file.language.clone(),
            parser: "rustpython".to_string(),
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

        if crate::facts::exceeds_nesting_depth(text) {
            facts.diagnostics.push(FactDiagnostic {
                code: "input-too-deeply-nested".to_string(),
                message: format!(
                    "Source nests brackets deeper than {}; skipping fact extraction.",
                    crate::facts::MAX_NESTING_DEPTH
                ),
                severity: "error".to_string(),
            });
            return facts;
        }

        let module = match parse(text, Mode::Module, &file.path) {
            Ok(module) => module,
            Err(error) => {
                facts.diagnostics.push(FactDiagnostic {
                    code: "parse-error".to_string(),
                    message: format!("{error:?}"),
                    severity: "error".to_string(),
                });
                return facts;
            }
        };

        let line_index = PythonLineIndex::new(text);
        if let ast::Mod::Module(module) = module {
            let mut visitor = PythonFactVisitor {
                requested,
                line_index: &line_index,
                class_body_depth: 0,
                try_body_depth: 0,
                facts: &mut facts,
            };
            for statement in module.body {
                visitor.visit_stmt(statement);
            }
        }

        facts
            .imports
            .sort_by_key(|fact| (fact.line, fact.column.unwrap_or(0), fact.source.clone()));
        facts
            .symbols
            .sort_by_key(|fact| (fact.line, fact.column.unwrap_or(0), fact.name.clone()));
        facts
            .calls
            .sort_by_key(|fact| (fact.line, fact.column, fact.callee.clone()));

        facts
    }
}

struct PythonLineIndex<'source> {
    text: &'source str,
    newlines: Vec<usize>,
}

impl<'source> PythonLineIndex<'source> {
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

    fn line(&self, offset: usize) -> usize {
        offset_to_line(&self.newlines, offset)
    }

    fn position(&self, offset: usize) -> (usize, usize) {
        let line = self.line(offset);
        let line_start = if line <= 1 {
            0
        } else {
            self.newlines[line - 2] + 1
        };
        (line, self.utf16_column(line_start, offset))
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

fn offset_to_line(newlines: &[usize], offset: usize) -> usize {
    newlines.partition_point(|newline| *newline <= offset) + 1
}

struct PythonFactVisitor<'facts, 'source> {
    requested: &'facts HashSet<String>,
    line_index: &'facts PythonLineIndex<'source>,
    class_body_depth: usize,
    try_body_depth: usize,
    facts: &'facts mut FileFacts,
}

impl PythonFactVisitor<'_, '_> {
    fn wants(&self, fact: &str) -> bool {
        self.requested.contains(fact)
    }

    fn position<T: Ranged>(&self, node: &T) -> (usize, usize) {
        self.line_index.position(node.start().to_usize())
    }

    fn end_line<T: Ranged>(&self, node: &T) -> usize {
        self.line_index.line(node.end().to_usize())
    }

    fn push_import(&mut self, line: usize, column: usize, source: String, specifiers: Vec<String>) {
        if !self.wants("imports") {
            return;
        }
        self.facts.imports.push(ImportFact {
            line,
            column: Some(column),
            source,
            specifiers,
            kind: "import".to_string(),
            resolution: "unresolved".to_string(),
        });
    }

    fn push_symbol<T: Ranged>(
        &mut self,
        node: &T,
        name: &ast::Identifier,
        kind: &str,
        params: Option<Vec<String>>,
    ) {
        if !self.wants("symbols") {
            return;
        }
        let (line, column) = self.position(node);
        self.facts.symbols.push(SymbolFact {
            line,
            column: Some(column),
            end_line: Some(self.end_line(node)),
            name: name.to_string(),
            kind: kind.to_string(),
            exported: !name.as_str().starts_with('_'),
            params,
        });
    }

    fn push_call(&mut self, call: &ast::ExprCall) {
        if !self.wants("calls") {
            return;
        }
        let Some(callee) = dotted_callee(&call.func) else {
            return;
        };
        let Some(name) = callee.rsplit('.').next().filter(|name| !name.is_empty()) else {
            return;
        };
        let receiver = call_receiver(&callee);
        let (line, column) = self.line_index.position(call.func.start().to_usize());
        let argument_calls = call.args.iter().filter_map(call_argument_fact).collect();
        self.facts.calls.push(CallFact {
            line,
            column,
            name: name.to_string(),
            receiver,
            callee,
            try_depth: self.try_body_depth,
            argument_calls,
        });
    }

    fn visit_function_body(
        &mut self,
        args: ast::Arguments,
        decorator_list: Vec<Expr>,
        returns: Option<Box<Expr>>,
        type_params: Vec<ast::TypeParam>,
        body: Vec<Stmt>,
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

impl Visitor for PythonFactVisitor<'_, '_> {
    fn visit_stmt_import(&mut self, node: ast::StmtImport) {
        let (line, column) = self.position(&node);
        for alias in node.names {
            self.push_import(
                line,
                column,
                alias.name.to_string(),
                vec![alias_specifier(&alias)],
            );
        }
    }

    fn visit_stmt_import_from(&mut self, node: ast::StmtImportFrom) {
        let (line, column) = self.position(&node);
        let source = import_from_source(node.level.as_ref(), node.module.as_ref());
        let specifiers = node.names.iter().map(alias_specifier).collect();
        self.push_import(line, column, source, specifiers);
    }

    fn visit_stmt_function_def(&mut self, node: ast::StmtFunctionDef) {
        let kind = if self.class_body_depth > 0 {
            "method"
        } else {
            "function"
        };
        self.push_symbol(&node, &node.name, kind, Some(argument_names(&node.args)));
        self.visit_function_body(
            *node.args,
            node.decorator_list,
            node.returns,
            node.type_params,
            node.body,
        );
    }

    fn visit_stmt_async_function_def(&mut self, node: ast::StmtAsyncFunctionDef) {
        let kind = if self.class_body_depth > 0 {
            "method"
        } else {
            "function"
        };
        self.push_symbol(&node, &node.name, kind, Some(argument_names(&node.args)));
        self.visit_function_body(
            *node.args,
            node.decorator_list,
            node.returns,
            node.type_params,
            node.body,
        );
    }

    fn visit_stmt_class_def(&mut self, node: ast::StmtClassDef) {
        self.push_symbol(&node, &node.name, "class", None);

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

    fn visit_expr_call(&mut self, node: ast::ExprCall) {
        self.push_call(&node);
        self.generic_visit_expr_call(node);
    }

    fn visit_stmt_try(&mut self, node: ast::StmtTry) {
        // Only the try body is the protected region; handlers/else/finally
        // run at the restored outer depth, matching the TS extractor.
        let ast::StmtTry {
            body,
            handlers,
            orelse,
            finalbody,
            ..
        } = node;

        let previous_try_body_depth = self.try_body_depth;
        self.try_body_depth += 1;
        for statement in body {
            self.visit_stmt(statement);
        }
        self.try_body_depth = previous_try_body_depth;

        for handler in handlers {
            self.visit_excepthandler(handler);
        }
        for statement in orelse {
            self.visit_stmt(statement);
        }
        for statement in finalbody {
            self.visit_stmt(statement);
        }
    }

    fn visit_stmt_try_star(&mut self, node: ast::StmtTryStar) {
        // See visit_stmt_try: only the protected body increases try depth.
        let ast::StmtTryStar {
            body,
            handlers,
            orelse,
            finalbody,
            ..
        } = node;

        let previous_try_body_depth = self.try_body_depth;
        self.try_body_depth += 1;
        for statement in body {
            self.visit_stmt(statement);
        }
        self.try_body_depth = previous_try_body_depth;

        for handler in handlers {
            self.visit_excepthandler(handler);
        }
        for statement in orelse {
            self.visit_stmt(statement);
        }
        for statement in finalbody {
            self.visit_stmt(statement);
        }
    }

    fn visit_arguments(&mut self, node: ast::Arguments) {
        for arg in node.posonlyargs {
            self.visit_arg_with_default(arg);
        }
        for arg in node.args {
            self.visit_arg_with_default(arg);
        }
        if let Some(arg) = node.vararg {
            self.visit_arg(*arg);
        }
        for arg in node.kwonlyargs {
            self.visit_arg_with_default(arg);
        }
        if let Some(arg) = node.kwarg {
            self.visit_arg(*arg);
        }
    }

    fn visit_arg(&mut self, node: ast::Arg) {
        if let Some(annotation) = node.annotation {
            self.visit_expr(*annotation);
        }
    }

    fn visit_keyword(&mut self, node: ast::Keyword) {
        self.visit_expr(node.value);
    }

    fn visit_withitem(&mut self, node: ast::WithItem) {
        self.visit_expr(node.context_expr);
        if let Some(value) = node.optional_vars {
            self.visit_expr(*value);
        }
    }

    fn visit_match_case(&mut self, node: ast::MatchCase) {
        self.visit_pattern(node.pattern);
        if let Some(guard) = node.guard {
            self.visit_expr(*guard);
        }
        for statement in node.body {
            self.visit_stmt(statement);
        }
    }

    fn visit_comprehension(&mut self, node: ast::Comprehension) {
        self.visit_expr(node.target);
        self.visit_expr(node.iter);
        for condition in node.ifs {
            self.visit_expr(condition);
        }
    }
}

impl PythonFactVisitor<'_, '_> {
    fn visit_arg_with_default(&mut self, arg: ast::ArgWithDefault) {
        self.visit_arg(arg.def);
        if let Some(default) = arg.default {
            self.visit_expr(*default);
        }
    }
}

fn alias_specifier(alias: &ast::Alias) -> String {
    match &alias.asname {
        Some(asname) => format!("{} as {asname}", alias.name),
        None => alias.name.to_string(),
    }
}

fn import_from_source(level: Option<&ast::Int>, module: Option<&ast::Identifier>) -> String {
    let relative_prefix = level
        .map(ast::Int::to_usize)
        .map(|level| ".".repeat(level))
        .unwrap_or_default();
    match module {
        Some(module) => format!("{relative_prefix}{module}"),
        None => relative_prefix,
    }
}

fn argument_names(args: &ast::Arguments) -> Vec<String> {
    let mut names = Vec::new();
    names.extend(args.posonlyargs.iter().map(|arg| arg.def.arg.to_string()));
    names.extend(args.args.iter().map(|arg| arg.def.arg.to_string()));
    if let Some(arg) = &args.vararg {
        names.push(arg.arg.to_string());
    }
    names.extend(args.kwonlyargs.iter().map(|arg| arg.def.arg.to_string()));
    if let Some(arg) = &args.kwarg {
        names.push(arg.arg.to_string());
    }
    names
}

fn dotted_callee(expr: &Expr) -> Option<String> {
    match expr {
        Expr::Name(name) => Some(name.id.to_string()),
        Expr::Attribute(attribute) => {
            let receiver = dotted_callee(&attribute.value)?;
            Some(format!("{receiver}.{}", attribute.attr))
        }
        _ => None,
    }
}

fn call_argument_fact(expr: &Expr) -> Option<CallArgumentFact> {
    let (call, awaited) = argument_call_expression(expr)?;
    let callee = dotted_callee(&call.func)?;
    let name = callee.rsplit('.').next().filter(|name| !name.is_empty())?;
    let name = name.to_string();

    Some(CallArgumentFact {
        callee,
        name,
        awaited,
    })
}

fn argument_call_expression(expr: &Expr) -> Option<(&ast::ExprCall, bool)> {
    match expr {
        Expr::Call(call) => Some((call, false)),
        Expr::Await(await_expr) => match await_expr.value.as_ref() {
            Expr::Call(call) => Some((call, true)),
            _ => None,
        },
        Expr::Starred(starred) => argument_call_expression(&starred.value),
        _ => None,
    }
}

fn call_receiver(callee: &str) -> Option<String> {
    callee
        .rsplit_once('.')
        .map(|(receiver, _)| receiver.to_string())
        .filter(|receiver| !receiver.is_empty())
}
