import { useEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, type DecorationSet, type Tooltip } from "@codemirror/view";
import { createReadOnlyCodeExtensions } from "./editorExtensions.ts";
import type { CodeFileFacts, ExportFact, Finding, ImportEdge, ImportFact, SymbolFact } from "./types.ts";

const FindingSeverityRank = {
  info: 0,
  warning: 1,
  error: 2,
} as const;

const FindingLineClass = {
  info: "cm-finding-info",
  warning: "cm-finding-warning",
  error: "cm-finding-error",
} as const;

const TooltipClassName = {
  Root: "opencanonTooltip",
  Section: "opencanonTooltipSection",
  Title: "opencanonTooltipTitle",
  Row: "opencanonTooltipRow",
  Label: "opencanonTooltipLabel",
  Value: "opencanonTooltipValue",
} as const;

const HtmlTag = {
  Div: "div",
  Section: "section",
  Span: "span",
} as const;

const TooltipText = {
  BoundaryClear: "clear",
  BoundaryFinding: "finding",
  Decisions: "decisions",
  Docs: "docs",
  Export: "export",
  Finding: "Finding",
  Fix: "fix",
  Import: "Import",
  Message: "message",
  Package: "package",
  Resolution: "resolution",
  Source: "source",
  Specifiers: "specifiers",
  Symbol: "Symbol",
  Target: "target",
} as const;

const TooltipTiming = {
  HoverMs: 90,
} as const;

type TooltipRow = {
  label: string;
  value: string;
};

type CodeTooltipSection = {
  title: string;
  rows: TooltipRow[];
};

type TextRange = {
  from: number;
  to: number;
};

type Severity = "error" | "warning" | "info";

export function CodeViewer({
  content,
  language,
  findings = [],
  focusedLine,
  fileFacts,
  importEdges = [],
}: {
  content: string;
  language: string;
  findings?: Finding[];
  focusedLine?: number | null;
  fileFacts?: CodeFileFacts;
  importEdges?: ImportEdge[];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions = createReadOnlyCodeExtensions({
      language,
      extensions: [
        EditorView.decorations.of(buildFindingDecorations(content, findings)),
        createCodeHoverTooltips({ findings, fileFacts, importEdges }),
      ],
    });
    const state = EditorState.create({ doc: content, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    scrollToLine(view, content, focusedLine);
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [content, language, findings, focusedLine, fileFacts, importEdges]);

  return <div ref={hostRef} className="codeViewer" />;
}

function createCodeHoverTooltips({
  findings,
  fileFacts,
  importEdges,
}: {
  findings: Finding[];
  fileFacts?: CodeFileFacts;
  importEdges: ImportEdge[];
}): Extension {
  return hoverTooltip(
    (view, position) => {
      const line = view.state.doc.lineAt(position);
      const lineNumber = line.number;
      const textOffset = position - line.from;
      const hoveredWord = wordAt(line.text, textOffset);
      const sections: CodeTooltipSection[] = [];
      let range: TextRange | null = null;

      const lineFindings = findings.filter((finding) => finding.line === lineNumber);
      if (lineFindings.length > 0) {
        sections.push(findingTooltipSection(lineFindings));
        range = { from: line.from, to: line.to };
      }

      const importFact = matchingImportFact(fileFacts?.imports ?? [], lineNumber, line.text);
      if (importFact) {
        const importRange = sourceRange(line, importFact.source);
        sections.push(importTooltipSection(importFact, importEdges, lineFindings));
        range ??= importRange;
      }

      const symbolFact = hoveredWord ? matchingSymbolFact(fileFacts?.symbols ?? [], lineNumber, hoveredWord.text) : null;
      if (symbolFact && hoveredWord) {
        sections.push(symbolTooltipSection(symbolFact, fileFacts?.exports ?? []));
        range ??= { from: line.from + hoveredWord.from, to: line.from + hoveredWord.to };
      }

      if (sections.length === 0 || !range) return null;
      return createTooltip(range, sections);
    },
    { hoverTime: TooltipTiming.HoverMs },
  );
}

function createTooltip(range: TextRange, sections: CodeTooltipSection[]): Tooltip {
  return {
    pos: range.from,
    end: Math.max(range.from + 1, range.to),
    above: true,
    create() {
      return { dom: renderTooltip(sections) };
    },
  };
}

function renderTooltip(sections: CodeTooltipSection[]): HTMLElement {
  const root = document.createElement(HtmlTag.Div);
  root.className = TooltipClassName.Root;

  for (const section of sections) {
    const sectionElement = document.createElement(HtmlTag.Section);
    sectionElement.className = TooltipClassName.Section;

    const title = document.createElement(HtmlTag.Div);
    title.className = TooltipClassName.Title;
    title.textContent = section.title;
    sectionElement.append(title);

    for (const row of section.rows) {
      const rowElement = document.createElement(HtmlTag.Div);
      rowElement.className = TooltipClassName.Row;

      const label = document.createElement(HtmlTag.Span);
      label.className = TooltipClassName.Label;
      label.textContent = row.label;

      const value = document.createElement(HtmlTag.Span);
      value.className = TooltipClassName.Value;
      value.textContent = row.value;

      rowElement.append(label, value);
      sectionElement.append(rowElement);
    }

    root.append(sectionElement);
  }

  return root;
}

function findingTooltipSection(findings: Finding[]): CodeTooltipSection {
  const first = findings[0];
  const rows: TooltipRow[] = [
    { label: findings.length === 1 ? severityOf(first) : "count", value: findings.length === 1 ? findingTitle(first) : String(findings.length) },
  ];

  if (findings.length === 1) {
    rows.push({ label: TooltipText.Message, value: first.message });
    if (first.decisionIds && first.decisionIds.length > 0) rows.push({ label: TooltipText.Decisions, value: first.decisionIds.join(", ") });
    if (first.docs && first.docs.length > 0) rows.push({ label: TooltipText.Docs, value: first.docs.join(", ") });
    if (first.fix) rows.push({ label: TooltipText.Fix, value: `${first.fix.type}: ${first.fix.description}` });
  } else {
    rows.push({ label: TooltipText.Message, value: findings.map(findingTitle).join(", ") });
  }

  return { title: TooltipText.Finding, rows };
}

function importTooltipSection(importFact: ImportFact, importEdges: ImportEdge[], findings: Finding[]): CodeTooltipSection {
  const edge = importEdges.find((candidate) => candidate.source === importFact.source);
  const target = edge?.to ?? importFact.resolvedPath ?? "unresolved";
  const boundary = findings.length > 0 ? `${TooltipText.BoundaryFinding}: ${findings.map(findingTitle).join(", ")}` : TooltipText.BoundaryClear;
  const rows: TooltipRow[] = [
    { label: TooltipText.Source, value: importFact.source },
    { label: TooltipText.Resolution, value: edge?.resolution ?? importFact.resolution },
    { label: TooltipText.Target, value: target },
    { label: "boundary", value: boundary },
  ];

  const packageName = edge?.toPackage ?? importFact.toPackage;
  if (packageName) rows.push({ label: TooltipText.Package, value: packageName });
  if (importFact.specifiers.length > 0) rows.push({ label: TooltipText.Specifiers, value: importFact.specifiers.join(", ") });

  return { title: TooltipText.Import, rows };
}

function symbolTooltipSection(symbol: SymbolFact, exports: ExportFact[]): CodeTooltipSection {
  const exportFact = exports.find((candidate) => candidate.name === symbol.name && candidate.line === symbol.line);
  const rows: TooltipRow[] = [
    { label: "name", value: symbol.name },
    { label: "kind", value: symbol.kind },
    { label: TooltipText.Export, value: symbol.exported ? exportFact?.kind ?? "yes" : "no" },
  ];

  return { title: TooltipText.Symbol, rows };
}

function findingTitle(finding: Finding): string {
  return finding.validatorId ?? finding.title ?? "finding";
}

function matchingImportFact(imports: ImportFact[], lineNumber: number, lineText: string): ImportFact | null {
  return imports.find((item) => item.line === lineNumber && lineText.includes(item.source)) ?? imports.find((item) => item.line === lineNumber) ?? null;
}

function matchingSymbolFact(symbols: SymbolFact[], lineNumber: number, word: string): SymbolFact | null {
  return symbols.find((symbol) => symbol.line === lineNumber && symbol.name === word) ?? null;
}

function sourceRange(line: { from: number; to: number; text: string }, source: string): TextRange {
  const sourceWithQuotes = [`"${source}"`, `'${source}'`, `\`${source}\``];
  for (const candidate of sourceWithQuotes) {
    const index = line.text.indexOf(candidate);
    if (index !== -1) return { from: line.from + index, to: line.from + index + candidate.length };
  }

  const sourceIndex = line.text.indexOf(source);
  if (sourceIndex !== -1) return { from: line.from + sourceIndex, to: line.from + sourceIndex + source.length };
  return { from: line.from, to: line.to };
}

function wordAt(line: string, offset: number): { text: string; from: number; to: number } | null {
  for (const match of line.matchAll(/[$A-Za-z_][\w$]*/g)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (offset >= from && offset <= to) return { text: match[0], from, to };
  }
  return null;
}

function buildFindingDecorations(content: string, findings: Finding[]): DecorationSet {
  const grouped = groupFindingsByLine(findings);
  const ranges = [...grouped.entries()].flatMap(([line, lineFindings]) => {
    const position = lineStartOffset(content, line);
    if (position === null) return [];
    const severity = highestSeverity(lineFindings);
    const title = formatFindingTitle(lineFindings);
    return [
      Decoration.line({
        attributes: {
          class: `cm-finding-line ${FindingLineClass[severity]}`,
          title,
        },
      }).range(position),
    ];
  });

  return Decoration.set(ranges, true);
}

function groupFindingsByLine(findings: Finding[]): Map<number, Finding[]> {
  const grouped = new Map<number, Finding[]>();
  for (const finding of findings) {
    if (!finding.line) continue;
    grouped.set(finding.line, [...(grouped.get(finding.line) ?? []), finding]);
  }
  return grouped;
}

function highestSeverity(findings: Finding[]): Severity {
  return findings.reduce<Severity>((current, finding) => (FindingSeverityRank[severityOf(finding)] > FindingSeverityRank[current] ? severityOf(finding) : current), "info");
}

function severityOf(finding: Finding): Severity {
  return finding.severity;
}

function formatFindingTitle(findings: Finding[]): string {
  if (findings.length === 1) {
    const [finding] = findings;
    return `${finding.validatorId ?? finding.title ?? "finding"}: ${finding.message}`;
  }
  return `${findings.length} findings: ${findings.map((finding) => finding.validatorId ?? finding.title ?? "finding").join(", ")}`;
}

function scrollToLine(view: EditorView, content: string, focusedLine?: number | null): void {
  const position = focusedLine ? lineStartOffset(content, focusedLine) : null;
  if (position === null) return;
  view.dispatch({ effects: EditorView.scrollIntoView(position, { y: "center" }) });
}

function lineStartOffset(content: string, line: number): number | null {
  if (!Number.isInteger(line) || line < 1) return null;
  if (line === 1) return 0;
  let position = 0;
  for (let current = 1; current < line; current += 1) {
    const next = content.indexOf("\n", position);
    if (next === -1) return null;
    position = next + 1;
  }
  return position;
}
