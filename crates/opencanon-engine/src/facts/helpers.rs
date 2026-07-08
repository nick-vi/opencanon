use std::path::Path;

use oxc_ast::ast::{
    Argument, BindingPattern, CallExpression, Expression, ImportDeclaration,
    ImportDeclarationSpecifier, ModuleExportName, NumericLiteral, PropertyKey, StringLiteral,
    TSLiteral, TSType, VariableDeclarationKind, VariableDeclarator,
};
use oxc_span::{GetSpan, SourceType, Span};
use oxc_syntax::operator::{BinaryOperator, UnaryOperator};
use serde_json::json;

use crate::contracts::ObjectPropertyFact;

pub(super) fn source_type_for_file(file: &str, language: &str) -> Result<SourceType, String> {
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

pub(super) fn binding_name(binding: &BindingPattern) -> Option<(Span, String)> {
    match binding {
        BindingPattern::BindingIdentifier(identifier) => {
            Some((identifier.span, identifier.name.to_string()))
        }
        _ => None,
    }
}

pub(super) fn module_export_name(name: &ModuleExportName) -> String {
    match name {
        ModuleExportName::IdentifierName(identifier) => identifier.name.to_string(),
        ModuleExportName::IdentifierReference(identifier) => identifier.name.to_string(),
        ModuleExportName::StringLiteral(literal) => literal.value.to_string(),
    }
}

pub(super) fn property_key_name(key: &PropertyKey, text: &str) -> Option<(Span, String)> {
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

pub(super) fn argument_call_expression<'argument, 'source>(
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

pub(super) fn compact_source(source: &str) -> String {
    source.chars().filter(|ch| !ch.is_whitespace()).collect()
}

pub(super) fn call_name(callee: &str) -> String {
    callee
        .rsplit(['.', '#'])
        .next()
        .unwrap_or(callee)
        .trim_start_matches('?')
        .to_string()
}

pub(super) fn call_receiver(callee: &str) -> Option<String> {
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

pub(super) fn is_dotted_identifier_chain(value: &str) -> bool {
    value.split('.').all(is_identifier_like)
}

pub(super) fn is_identifier_like(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '#' || first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
}

pub(super) fn export_variable_kind(kind: VariableDeclarationKind) -> &'static str {
    match kind {
        VariableDeclarationKind::Const => "const",
        VariableDeclarationKind::Let => "let",
        VariableDeclarationKind::Var => "var",
        VariableDeclarationKind::Using | VariableDeclarationKind::AwaitUsing => "const",
    }
}

pub(super) fn declaration_literal_value(expression: &Expression, text: &str) -> (String, String) {
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

pub(super) fn parse_object_properties(text: &str, first_line: usize) -> Vec<ObjectPropertyFact> {
    text.lines()
        .enumerate()
        .filter_map(|(index, line)| parse_object_property_line(line, first_line + index))
        .collect()
}

pub(super) fn source_lines(text: &str) -> Vec<String> {
    text.split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
        .collect()
}

pub(super) fn find_initializer_end_index(lines: &[String], start_index: usize) -> usize {
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

pub(super) fn parse_object_property_line(
    line: &str,
    line_number: usize,
) -> Option<ObjectPropertyFact> {
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

pub(super) fn parse_object_property_key(raw_key: &str) -> Option<(String, bool)> {
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

pub(super) fn declaration_text_value(raw_value: &str) -> (String, String) {
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

pub(super) fn quoted_text_value(raw_value: &str) -> Option<String> {
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

pub(super) fn is_declaration_identifier(value: &str) -> bool {
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first == '_' || first == '$' || first.is_ascii_alphabetic()) {
        return false;
    }
    chars.all(|ch| ch == '_' || ch == '$' || ch.is_ascii_alphanumeric())
}

pub(super) fn satisfies_type_source(source: &str) -> Option<String> {
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

pub(super) fn import_specifiers(import: &ImportDeclaration) -> Vec<String> {
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

pub(super) fn const_object_declaration_name(
    declarator: &VariableDeclarator,
    text: &str,
) -> Option<String> {
    if declarator.kind != VariableDeclarationKind::Const {
        return None;
    }
    let (_, name) = binding_name(&declarator.id)?;
    let init = declarator.init.as_ref()?;
    let source = init.span().source_text(text).trim_start();
    (source.starts_with('{') && has_as_const(source)).then_some(name)
}

pub(super) fn has_as_const(source: &str) -> bool {
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

pub(super) fn is_regex_word_boundary(bytes: &[u8], start: usize, end: usize) -> bool {
    !start
        .checked_sub(1)
        .and_then(|index| bytes.get(index))
        .is_some_and(|byte| is_regex_word_byte(*byte))
        && !bytes.get(end).is_some_and(|byte| is_regex_word_byte(*byte))
}

pub(super) fn is_regex_word_byte(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphanumeric()
}

pub(super) fn is_literal_declaration_type(ty: &TSType, text: &str) -> bool {
    match ty {
        TSType::TSLiteralType(literal) => is_supported_ts_literal(&literal.literal, text),
        TSType::TSUnionType(union) => union
            .types
            .iter()
            .all(|member| is_literal_type_member(member, text)),
        _ => false,
    }
}

pub(super) fn is_literal_type_member(ty: &TSType, text: &str) -> bool {
    match ty {
        TSType::TSLiteralType(literal) => is_supported_ts_literal(&literal.literal, text),
        _ => false,
    }
}

pub(super) fn is_supported_ts_literal(literal: &TSLiteral, text: &str) -> bool {
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

pub(super) fn raw_string_literal_value(literal: &StringLiteral, text: &str) -> String {
    let raw = literal.span.source_text(text);
    if raw.len() >= 2 && (raw.starts_with('"') || raw.starts_with('\'')) {
        raw[1..raw.len() - 1].to_string()
    } else {
        literal.value.to_string()
    }
}

pub(super) fn literal_source<'a>(literal: &'a NumericLiteral, text: &'a str) -> &'a str {
    literal.span.source_text(text)
}

pub(super) fn regex_decimal_literal_value(source: &str) -> Option<String> {
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

pub(super) fn is_comparison_operator(operator: BinaryOperator) -> bool {
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

pub(super) fn is_test_title_call(call: &CallExpression, text: &str) -> bool {
    matches!(
        call_name(&compact_source(call.callee.span().source_text(text))).as_str(),
        "it" | "test" | "describe"
    )
}

pub(super) fn argument_starts_with_string(argument: &Argument, text: &str) -> bool {
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
