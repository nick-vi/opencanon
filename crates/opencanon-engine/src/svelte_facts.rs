use std::collections::HashSet;

use crate::contracts::{FactFileRequest, FileFacts};
use crate::facts::scan_oxc_file_facts;

pub(crate) struct SvelteExtractor;

impl SvelteExtractor {
    pub(crate) fn extract(
        file: &FactFileRequest,
        text: &str,
        requested: &HashSet<String>,
        parser_version: &str,
    ) -> FileFacts {
        let mut facts = empty_svelte_facts(file, parser_version);
        if requested.is_empty() {
            return facts;
        }

        for (index, block) in parse_svelte_script_blocks(text).into_iter().enumerate() {
            let virtual_path = format!(
                "{}::{}{}.{}",
                file.path,
                block.context.as_str(),
                index,
                block.extension.as_str()
            );
            let virtual_file = FactFileRequest {
                path: virtual_path,
                content_hash: file.content_hash.clone(),
                language: block.extension.language().to_string(),
                content: None,
            };
            let mut script_facts =
                scan_oxc_file_facts(&virtual_file, block.text, requested, parser_version);
            offset_file_facts(&mut script_facts, block.line_offset, block.column_offset);
            append_file_facts(&mut facts, script_facts);
        }

        facts
    }
}

#[derive(Clone, Copy)]
struct SvelteScriptBlock<'source> {
    text: &'source str,
    line_offset: usize,
    column_offset: usize,
    context: ScriptContext,
    extension: ScriptExtension,
}

#[derive(Clone, Copy)]
enum ScriptContext {
    Module,
    Instance,
}

impl ScriptContext {
    fn as_str(self) -> &'static str {
        match self {
            Self::Module => "module",
            Self::Instance => "instance",
        }
    }
}

#[derive(Clone, Copy)]
enum ScriptExtension {
    Ts,
    Js,
}

impl ScriptExtension {
    fn as_str(self) -> &'static str {
        match self {
            Self::Ts => "ts",
            Self::Js => "js",
        }
    }

    fn language(self) -> &'static str {
        match self {
            Self::Ts => "typescript",
            Self::Js => "javascript",
        }
    }
}

struct ParsedTag {
    name: String,
    close_index: usize,
    attributes_start: usize,
    attributes_end: usize,
    closing: bool,
    self_closing: bool,
}

struct ClosingTag {
    start: usize,
    end: usize,
}

fn empty_svelte_facts(file: &FactFileRequest, parser_version: &str) -> FileFacts {
    FileFacts {
        path: file.path.clone(),
        content_hash: file.content_hash.clone(),
        language: "svelte".to_string(),
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
    }
}

fn parse_svelte_script_blocks(text: &str) -> Vec<SvelteScriptBlock<'_>> {
    let mut blocks = Vec::new();
    let mut element_stack = Vec::new();
    let mut svelte_block_depth = 0;
    let mut index = 0;

    while index < text.len() {
        if starts_with_at(text, index, "<!--") {
            index = skip_html_comment(text, index);
            continue;
        }

        match byte_at(text, index) {
            Some(b'{') => {
                if is_svelte_block_tag(text, index) {
                    svelte_block_depth = update_svelte_block_depth(text, index, svelte_block_depth);
                    index = skip_svelte_block_tag(text, index);
                } else {
                    index = skip_svelte_expression(text, index);
                }
            }
            Some(b'<') => {
                let Some(tag) = parse_tag(text, index) else {
                    index += 1;
                    continue;
                };

                if tag.closing {
                    pop_element_stack(&mut element_stack, &tag.name);
                    index = tag.close_index + 1;
                    continue;
                }

                if tag.name == "script"
                    && element_stack.is_empty()
                    && svelte_block_depth == 0
                    && !tag.self_closing
                {
                    let Some(closing_tag) = find_closing_tag(text, tag.close_index + 1, "script")
                    else {
                        break;
                    };

                    let body_start = tag.close_index + 1;
                    let body = &text[body_start..closing_tag.start];
                    let attributes = &text[tag.attributes_start..tag.attributes_end];
                    let script_attributes = read_script_attributes(attributes);
                    let (line_offset, column_offset) = offset_at(text, body_start);
                    blocks.push(SvelteScriptBlock {
                        text: body,
                        line_offset,
                        column_offset,
                        context: script_attributes.context,
                        extension: script_attributes.extension,
                    });

                    index = closing_tag.end;
                    continue;
                }

                if is_raw_text_tag(&tag.name) && !tag.self_closing {
                    index = find_closing_tag(text, tag.close_index + 1, &tag.name)
                        .map_or(text.len(), |closing_tag| closing_tag.end);
                    continue;
                }

                if !tag.self_closing && !is_void_tag(&tag.name) {
                    element_stack.push(tag.name);
                }
                index = tag.close_index + 1;
            }
            Some(_) => {
                index += 1;
            }
            None => break,
        }
    }

    blocks
}

#[cfg(test)]
pub(crate) struct SvelteScriptBlockSnapshot<'source> {
    pub(crate) text: &'source str,
    pub(crate) line_offset: usize,
    pub(crate) column_offset: usize,
    pub(crate) context: &'static str,
    pub(crate) extension: &'static str,
}

#[cfg(test)]
pub(crate) fn parse_svelte_script_block_snapshots(
    text: &str,
) -> Vec<SvelteScriptBlockSnapshot<'_>> {
    parse_svelte_script_blocks(text)
        .into_iter()
        .map(|block| SvelteScriptBlockSnapshot {
            text: block.text,
            line_offset: block.line_offset,
            column_offset: block.column_offset,
            context: block.context.as_str(),
            extension: block.extension.as_str(),
        })
        .collect()
}

fn skip_html_comment(text: &str, start: usize) -> usize {
    text[start + 4..]
        .find("-->")
        .map_or(text.len(), |relative| start + 4 + relative + 3)
}

fn update_svelte_block_depth(text: &str, start: usize, current: usize) -> usize {
    match byte_at(text, start + 1) {
        Some(b'#') => current + 1,
        Some(b'/') => current.saturating_sub(1),
        _ => current,
    }
}

fn parse_tag(text: &str, start: usize) -> Option<ParsedTag> {
    if byte_at(text, start) != Some(b'<') || starts_with_at(text, start, "<!--") {
        return None;
    }

    let mut index = start + 1;
    let closing = byte_at(text, index) == Some(b'/');
    if closing {
        index += 1;
    }
    if index >= text.len() || matches!(byte_at(text, index), Some(b'!' | b'?')) {
        return parse_special_tag(text, index);
    }

    let name_start = index;
    while index < text.len() && !is_tag_name_terminator(byte_at(text, index)) {
        index += 1;
    }
    if index == name_start {
        return None;
    }

    let name = text[name_start..index].to_ascii_lowercase();
    let attributes_start = index;
    let close_index = find_tag_close(text, index)?;
    let attributes_end = trim_self_closing_slash(text, attributes_start, close_index);

    Some(ParsedTag {
        name,
        close_index,
        attributes_start,
        attributes_end,
        closing,
        self_closing: !closing && attributes_end < close_index,
    })
}

fn parse_special_tag(text: &str, index: usize) -> Option<ParsedTag> {
    let close_index = find_tag_close(text, index)?;
    Some(ParsedTag {
        name: String::new(),
        close_index,
        attributes_start: index,
        attributes_end: close_index,
        closing: false,
        self_closing: true,
    })
}

fn find_tag_close(text: &str, start: usize) -> Option<usize> {
    let mut index = start;
    while index < text.len() {
        match byte_at(text, index) {
            Some(quote @ (b'"' | b'\'')) => {
                index = skip_quoted_markup(text, index, quote);
            }
            Some(b'{') => {
                index = if is_svelte_block_tag(text, index) {
                    skip_svelte_block_tag(text, index)
                } else {
                    skip_svelte_expression(text, index)
                };
            }
            Some(b'>') => return Some(index),
            Some(_) => index += 1,
            None => return None,
        }
    }
    None
}

fn trim_self_closing_slash(text: &str, attributes_start: usize, close_index: usize) -> usize {
    let mut index = close_index;
    while index > attributes_start {
        index -= 1;
        if is_whitespace(byte_at(text, index)) {
            continue;
        }
        return if byte_at(text, index) == Some(b'/') {
            index
        } else {
            close_index
        };
    }
    close_index
}

fn skip_quoted_markup(text: &str, start: usize, quote: u8) -> usize {
    let mut index = start + 1;
    while index < text.len() {
        if byte_at(text, index) == Some(quote) {
            return index + 1;
        }
        index += 1;
    }
    text.len()
}

fn is_svelte_block_tag(text: &str, start: usize) -> bool {
    matches!(byte_at(text, start + 1), Some(b'#' | b'/' | b':'))
}

fn skip_svelte_block_tag(text: &str, start: usize) -> usize {
    let mut depth = 1;
    let mut index = start + 1;

    while index < text.len() {
        match byte_at(text, index) {
            Some(quote @ (b'"' | b'\'' | b'`')) => {
                index = skip_quoted_javascript(text, index, quote);
            }
            Some(b'{') => {
                depth += 1;
                index += 1;
            }
            Some(b'}') => {
                depth -= 1;
                index += 1;
                if depth == 0 {
                    return index;
                }
            }
            Some(_) => index += 1,
            None => break,
        }
    }

    text.len()
}

fn skip_svelte_expression(text: &str, start: usize) -> usize {
    let mut depth = 1;
    let mut index = start + 1;

    while index < text.len() {
        match byte_at(text, index) {
            Some(quote @ (b'"' | b'\'')) => {
                index = skip_quoted_javascript(text, index, quote);
            }
            Some(b'`') => {
                index = skip_template_literal(text, index);
            }
            Some(b'/') if byte_at(text, index + 1) == Some(b'/') => {
                index = skip_line_comment(text, index);
            }
            Some(b'/') if byte_at(text, index + 1) == Some(b'*') => {
                index = skip_block_comment(text, index);
            }
            Some(b'/') if starts_regex_literal(text, index) => {
                index = skip_regex_literal(text, index);
            }
            Some(b'{') => {
                depth += 1;
                index += 1;
            }
            Some(b'}') => {
                depth -= 1;
                index += 1;
                if depth == 0 {
                    return index;
                }
            }
            Some(_) => index += 1,
            None => break,
        }
    }

    text.len()
}

fn skip_quoted_javascript(text: &str, start: usize, quote: u8) -> usize {
    let mut index = start + 1;
    while index < text.len() {
        match byte_at(text, index) {
            Some(b'\\') => index += 2,
            Some(current) if current == quote => return index + 1,
            Some(_) => index += 1,
            None => break,
        }
    }
    text.len()
}

fn skip_template_literal(text: &str, start: usize) -> usize {
    let mut index = start + 1;
    while index < text.len() {
        match byte_at(text, index) {
            Some(b'\\') => index += 2,
            Some(b'`') => return index + 1,
            Some(b'$') if byte_at(text, index + 1) == Some(b'{') => {
                index = skip_svelte_expression(text, index + 1);
            }
            Some(_) => index += 1,
            None => break,
        }
    }
    text.len()
}

fn skip_line_comment(text: &str, start: usize) -> usize {
    text[start + 2..]
        .find('\n')
        .map_or(text.len(), |relative| start + 2 + relative + 1)
}

fn skip_block_comment(text: &str, start: usize) -> usize {
    text[start + 2..]
        .find("*/")
        .map_or(text.len(), |relative| start + 2 + relative + 2)
}

/// Keywords after which a `/` begins a regex literal, not a division. Without these a
/// regex such as `return /<\/script>/` is scanned as division and can truncate the
/// surrounding `<script>` block.
const REGEX_PRECEDING_KEYWORDS: &[&str] = &[
    "return",
    "typeof",
    "instanceof",
    "in",
    "of",
    "new",
    "delete",
    "void",
    "do",
    "else",
    "yield",
    "await",
    "case",
    "throw",
];

fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$'
}

fn starts_regex_literal(text: &str, slash_index: usize) -> bool {
    let mut index = slash_index;
    while index > 0 {
        index -= 1;
        let Some(byte) = byte_at(text, index) else {
            return true;
        };
        if is_whitespace(Some(byte)) {
            continue;
        }
        if is_identifier_byte(byte) {
            // Preceded by an identifier: a value name means division, but a keyword like
            // `return`/`typeof` means a regex follows. Read the word back to disambiguate.
            let end = index + 1;
            let mut start = index;
            while start > 0 && byte_at(text, start - 1).is_some_and(is_identifier_byte) {
                start -= 1;
            }
            return REGEX_PRECEDING_KEYWORDS.contains(&&text[start..end]);
        }
        return b"([{=,:;!&|?+-*~%^<>".contains(&byte);
    }
    true
}

fn skip_regex_literal(text: &str, start: usize) -> usize {
    let mut index = start + 1;
    let mut in_character_class = false;

    while index < text.len() {
        match byte_at(text, index) {
            Some(b'\\') => index += 2,
            Some(b'[') => {
                in_character_class = true;
                index += 1;
            }
            Some(b']') => {
                in_character_class = false;
                index += 1;
            }
            Some(b'/') if !in_character_class => {
                index += 1;
                while matches!(byte_at(text, index), Some(b'a'..=b'z' | b'A'..=b'Z')) {
                    index += 1;
                }
                return index;
            }
            Some(_) => index += 1,
            None => break,
        }
    }

    text.len()
}

fn find_closing_tag(text: &str, start: usize, tag_name: &str) -> Option<ClosingTag> {
    let needle = format!("</{tag_name}");
    let lower_text = text.to_ascii_lowercase();
    let mut index = lower_text[start..]
        .find(&needle)
        .map(|relative| start + relative);

    while let Some(candidate) = index {
        let mut cursor = candidate + needle.len();
        let next = byte_at(text, cursor);
        if next.is_some_and(|byte| !is_whitespace(Some(byte)) && byte != b'>') {
            index = lower_text[candidate + 1..]
                .find(&needle)
                .map(|relative| candidate + 1 + relative);
            continue;
        }
        while is_whitespace(byte_at(text, cursor)) {
            cursor += 1;
        }
        if byte_at(text, cursor) == Some(b'>') {
            return Some(ClosingTag {
                start: candidate,
                end: cursor + 1,
            });
        }
        index = lower_text[candidate + 1..]
            .find(&needle)
            .map(|relative| candidate + 1 + relative);
    }

    None
}

struct ScriptAttributes {
    context: ScriptContext,
    extension: ScriptExtension,
}

fn read_script_attributes(attributes: &str) -> ScriptAttributes {
    let mut context = ScriptContext::Instance;
    let mut extension = ScriptExtension::Js;
    let mut index = 0;

    while index < attributes.len() {
        while index < attributes.len()
            && (is_whitespace(byte_at(attributes, index))
                || byte_at(attributes, index) == Some(b'/'))
        {
            index += 1;
        }

        let name_start = index;
        while index < attributes.len() && !is_attribute_name_terminator(byte_at(attributes, index))
        {
            index += 1;
        }
        if index == name_start {
            index += 1;
            continue;
        }

        let name = attributes[name_start..index].to_ascii_lowercase();
        while index < attributes.len() && is_whitespace(byte_at(attributes, index)) {
            index += 1;
        }

        let mut value = None;
        if byte_at(attributes, index) == Some(b'=') {
            index += 1;
            while index < attributes.len() && is_whitespace(byte_at(attributes, index)) {
                index += 1;
            }

            match byte_at(attributes, index) {
                Some(quote @ (b'"' | b'\'')) => {
                    let value_start = index + 1;
                    index = skip_quoted_markup(attributes, index, quote);
                    let value_end = if index > value_start
                        && byte_at(attributes, index.saturating_sub(1)) == Some(quote)
                    {
                        index - 1
                    } else {
                        index
                    };
                    value = Some(&attributes[value_start..value_end]);
                }
                Some(b'{') => {
                    let value_start = index;
                    index = skip_svelte_expression(attributes, index);
                    value = Some(&attributes[value_start..index]);
                }
                Some(_) => {
                    let value_start = index;
                    while index < attributes.len()
                        && !is_unquoted_attribute_value_terminator(byte_at(attributes, index))
                    {
                        index += 1;
                    }
                    value = Some(&attributes[value_start..index]);
                }
                None => {}
            }
        }

        let normalized = value.map(|raw| raw.trim().to_ascii_lowercase());
        if name == "context" && normalized.as_deref() == Some("module") {
            context = ScriptContext::Module;
        }
        if name == "module" {
            context = ScriptContext::Module;
        }
        if name == "lang" && matches!(normalized.as_deref(), Some("ts" | "typescript")) {
            extension = ScriptExtension::Ts;
        }
    }

    ScriptAttributes { context, extension }
}

fn pop_element_stack(stack: &mut Vec<String>, name: &str) {
    if let Some(index) = stack.iter().rposition(|tag| tag == name) {
        stack.truncate(index);
    }
}

fn offset_at(text: &str, offset: usize) -> (usize, usize) {
    let before = &text[..offset];
    let line_offset = before.bytes().filter(|byte| *byte == b'\n').count();
    let line_start = before.rfind('\n').map_or(0, |index| index + 1);
    let column_offset = text[line_start..offset].encode_utf16().count();
    (line_offset, column_offset)
}

fn offset_file_facts(facts: &mut FileFacts, line_delta: usize, column_delta: usize) {
    for import in &mut facts.imports {
        if import.line == 1 {
            if let Some(column) = &mut import.column {
                *column += column_delta;
            }
        }
        import.line += line_delta;
    }

    for export in &mut facts.exports {
        export.line += line_delta;
    }

    for symbol in &mut facts.symbols {
        if symbol.line == 1 {
            if let Some(column) = &mut symbol.column {
                *column += column_delta;
            }
        }
        symbol.line += line_delta;
        if let Some(end_line) = &mut symbol.end_line {
            *end_line += line_delta;
        }
    }

    for declaration in &mut facts.declarations {
        declaration.line += line_delta;
        declaration.end_line += line_delta;
        for member in &mut declaration.members {
            member.line += line_delta;
        }
        if let Some(initializer) = &mut declaration.initializer {
            for property in &mut initializer.properties {
                property.line += line_delta;
            }
        }
    }

    for call in &mut facts.calls {
        if call.line == 1 {
            call.column += column_delta;
        }
        call.line += line_delta;
    }

    for literal in &mut facts.literals {
        if literal.line == 1 {
            literal.column += column_delta;
        }
        literal.line += line_delta;
    }

    for comment in &mut facts.comments {
        if comment.line == 1 {
            comment.column += column_delta;
        }
        comment.line += line_delta;
    }
}

fn append_file_facts(target: &mut FileFacts, mut source: FileFacts) {
    target.imports.append(&mut source.imports);
    target.exports.append(&mut source.exports);
    target.symbols.append(&mut source.symbols);
    target.declarations.append(&mut source.declarations);
    target.calls.append(&mut source.calls);
    target.literals.append(&mut source.literals);
    target.comments.append(&mut source.comments);
    target.diagnostics.append(&mut source.diagnostics);
}

fn is_tag_name_terminator(byte: Option<u8>) -> bool {
    byte.is_none_or(|byte| is_whitespace(Some(byte)) || matches!(byte, b'/' | b'>'))
}

fn is_attribute_name_terminator(byte: Option<u8>) -> bool {
    byte.is_none_or(|byte| is_whitespace(Some(byte)) || matches!(byte, b'=' | b'/' | b'>'))
}

fn is_unquoted_attribute_value_terminator(byte: Option<u8>) -> bool {
    byte.is_none_or(|byte| is_whitespace(Some(byte)) || matches!(byte, b'/' | b'>'))
}

fn is_whitespace(byte: Option<u8>) -> bool {
    matches!(byte, Some(b' ' | b'\t' | b'\n' | b'\r' | 0x0c | 0x0b))
}

fn is_raw_text_tag(name: &str) -> bool {
    matches!(name, "style" | "textarea" | "title")
}

fn is_void_tag(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn byte_at(text: &str, index: usize) -> Option<u8> {
    text.as_bytes().get(index).copied()
}

fn starts_with_at(text: &str, start: usize, needle: &str) -> bool {
    text.as_bytes()
        .get(start..)
        .is_some_and(|remaining| remaining.starts_with(needle.as_bytes()))
}

#[cfg(test)]
mod regex_literal_tests {
    use super::starts_regex_literal;

    fn allows_regex(text: &str) -> bool {
        let slash = text.find('/').expect("test input needs a '/'");
        starts_regex_literal(text, slash)
    }

    #[test]
    fn keyword_before_slash_is_a_regex() {
        // The bug: these were scanned as division, desyncing block/expression boundaries.
        assert!(allows_regex("return /re/"));
        assert!(allows_regex("typeof /re/"));
        assert!(allows_regex("case /re/"));
        assert!(allows_regex("yield /re/"));
        assert!(allows_regex("a in /re/"));
    }

    #[test]
    fn value_before_slash_is_division() {
        assert!(!allows_regex("x /2"));
        assert!(!allows_regex("count /2"));
        assert!(!allows_regex("foo_bar /2"));
        // punctuation still allows a regex
        assert!(allows_regex("( /re/"));
        assert!(allows_regex("= /re/"));
    }
}
