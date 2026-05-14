import { bracketMatching, foldGutter, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { yaml } from "@codemirror/lang-yaml";
import { EditorState, type Extension } from "@codemirror/state";
import { highlightActiveLine, highlightActiveLineGutter, lineNumbers, EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const SyntaxColor = {
  Comment: "var(--syntax-comment)",
  Definition: "var(--syntax-definition)",
  Invalid: "var(--severity-error-fg)",
  Keyword: "var(--syntax-keyword)",
  Link: "var(--syntax-link)",
  Literal: "var(--syntax-literal)",
  Muted: "var(--syntax-muted)",
  Name: "var(--syntax-name)",
  Property: "var(--syntax-property)",
  String: "var(--syntax-string)",
  Type: "var(--syntax-type)",
} as const;

const EditorColor = {
  ActiveLine: "color-mix(in oklch, var(--accent) 8%, transparent)",
  ActiveLineGutter: "var(--bg-row-selected)",
  Background: "var(--bg)",
  Border: "var(--border)",
  Elevated: "var(--bg-elev)",
  Foreground: "var(--fg)",
  Muted: "var(--fg-muted)",
  Selection: "color-mix(in oklch, var(--accent) 30%, transparent) !important",
  Strong: "var(--fg-strong)",
} as const;

const codeHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: SyntaxColor.Comment, fontStyle: "italic" },
  {
    tag: [
      tags.keyword,
      tags.controlKeyword,
      tags.definitionKeyword,
      tags.moduleKeyword,
      tags.modifier,
      tags.operatorKeyword,
    ],
    color: SyntaxColor.Keyword,
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.escape], color: SyntaxColor.String },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: SyntaxColor.Literal },
  { tag: [tags.variableName, tags.name], color: SyntaxColor.Name },
  {
    tag: [
      tags.definition(tags.variableName),
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.labelName,
    ],
    color: SyntaxColor.Definition,
  },
  { tag: [tags.propertyName, tags.attributeName], color: SyntaxColor.Property },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace], color: SyntaxColor.Type },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: SyntaxColor.Muted },
  { tag: [tags.heading, tags.strong], color: SyntaxColor.Definition, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: [tags.link, tags.url], color: SyntaxColor.Link, textDecoration: "underline" },
  { tag: tags.invalid, color: SyntaxColor.Invalid },
]);

export function createReadOnlyCodeExtensions({ language, extensions = [] }: { language: string; extensions?: Extension[] }): Extension[] {
  const lang = languageExtension(language);
  return [
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    foldGutter(),
    bracketMatching(),
    indentOnInput(),
    syntaxHighlighting(codeHighlightStyle, { fallback: true }),
    ...extensions,
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
    EditorView.theme(
      {
        "&": {
          backgroundColor: EditorColor.Background,
          color: EditorColor.Foreground,
          height: "100%",
          fontSize: "var(--code-font-size)",
        },
        ".cm-content": { caretColor: EditorColor.Strong, padding: "8px 0 24px" },
        ".cm-scroller": { fontFamily: "var(--font-mono)", overflow: "auto" },
        ".cm-gutters": { backgroundColor: EditorColor.Elevated, borderRight: `1px solid ${EditorColor.Border}`, color: EditorColor.Muted },
        ".cm-line": { lineHeight: "var(--code-line-height)", padding: "0 14px" },
        ".cm-lineNumbers .cm-gutterElement": { color: EditorColor.Muted, padding: "0 10px 0 8px" },
        ".cm-activeLine": { backgroundColor: EditorColor.ActiveLine },
        ".cm-activeLineGutter": { backgroundColor: EditorColor.ActiveLineGutter, color: EditorColor.Strong },
        ".cm-foldGutter .cm-gutterElement": { color: EditorColor.Muted },
        ".cm-selectionBackground": { backgroundColor: EditorColor.Selection },
      },
      { dark: true },
    ),
    ...(lang ? [lang] : []),
  ];
}

function languageExtension(language: string): Extension | null {
  switch (language) {
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "typescript":
      return javascript({ typescript: true });
    case "jsx":
      return javascript({ jsx: true });
    case "javascript":
      return javascript();
    case "css":
      return css();
    case "html":
      return html();
    case "python":
      return python();
    case "rust":
      return rust();
    case "json":
      return json();
    case "markdown":
      return markdown();
    case "yaml":
      return yaml();
    default:
      return null;
  }
}
