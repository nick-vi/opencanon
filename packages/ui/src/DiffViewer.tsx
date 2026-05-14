import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { Columns2, Rows3, TextWrap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { InlineState, SegmentedButton, SegmentedControl } from "./components/ui.tsx";
import { createReadOnlyCodeExtensions } from "./editorExtensions.ts";
import type { GitDiffResponse } from "./types.ts";

const DiffRenderMode = {
  Split: "split",
  Unified: "unified",
} as const;
type DiffRenderMode = (typeof DiffRenderMode)[keyof typeof DiffRenderMode];

const DiffViewerClassName = {
  Empty: "mainDiffEmpty",
} as const;

const DiffConfig = {
  CollapseMargin: 4,
  CollapseMinSize: 14,
  ScanLimit: 15_000,
  TimeoutMs: 700,
} as const;

export function DiffViewer({
  language,
  selectedCommit,
  gitDiff,
  isLoading,
  error,
}: {
  language: string;
  selectedCommit: string | null;
  gitDiff?: GitDiffResponse;
  isLoading: boolean;
  error?: Error;
}) {
  const [renderMode, setRenderMode] = useState<DiffRenderMode>(DiffRenderMode.Split);
  const [wordWrap, setWordWrap] = useState(false);

  if (!selectedCommit) return <div className={DiffViewerClassName.Empty}>Select a commit in History to view this file's diff.</div>;
  if (isLoading) return <div className={DiffViewerClassName.Empty}>Loading diff...</div>;
  if (error) return <InlineState tone="error">{error.message}</InlineState>;

  const diagnostics = gitDiff?.diagnostics ?? [];
  if (diagnostics.length > 0) {
    return (
      <div className="mainDiff">
        {diagnostics.map((diagnostic) => (
          <div className="historyNotice" key={diagnostic}>
            {diagnostic}
          </div>
        ))}
      </div>
    );
  }

  if (!gitDiff) return <div className={DiffViewerClassName.Empty}>No content snapshot for this commit and file.</div>;

  return (
    <div className="mainDiff">
      <div className="mainDiffHeader">
        <div className="mainDiffActions">
          <SegmentedControl label="Diff controls" className="diffModeControl">
            <SegmentedButton
              active={renderMode === DiffRenderMode.Split}
              className="segmentedButtonIcon"
              onClick={() => setRenderMode(DiffRenderMode.Split)}
              aria-label="Split"
              title="Side-by-side diff"
            >
              <Columns2 size={13} />
            </SegmentedButton>
            <SegmentedButton
              active={renderMode === DiffRenderMode.Unified}
              className="segmentedButtonIcon"
              onClick={() => setRenderMode(DiffRenderMode.Unified)}
              aria-label="Unified"
              title="Unified diff"
            >
              <Rows3 size={13} />
            </SegmentedButton>
            <SegmentedButton
              active={wordWrap}
              className="segmentedButtonIcon"
              onClick={() => setWordWrap((value) => !value)}
              aria-label="Line wrap"
              title={wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
            >
              <TextWrap size={13} />
            </SegmentedButton>
          </SegmentedControl>
        </div>
      </div>
      <div className="diffRenderSurface" data-diff-file-path={gitDiff.file}>
        {renderMode === DiffRenderMode.Split ? (
          <SplitDiffView
            afterContent={gitDiff.afterContent}
            beforeContent={gitDiff.beforeContent}
            language={language}
            wordWrap={wordWrap}
          />
        ) : (
          <UnifiedDiffView
            afterContent={gitDiff.afterContent}
            beforeContent={gitDiff.beforeContent}
            language={language}
            wordWrap={wordWrap}
          />
        )}
      </div>
    </div>
  );
}

function SplitDiffView({
  afterContent,
  beforeContent,
  language,
  wordWrap,
}: {
  afterContent: string;
  beforeContent: string;
  language: string;
  wordWrap: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions = createDiffExtensions(language, wordWrap);
    const view = new MergeView({
      a: { doc: beforeContent, extensions },
      b: { doc: afterContent, extensions },
      parent: hostRef.current,
      collapseUnchanged: { margin: DiffConfig.CollapseMargin, minSize: DiffConfig.CollapseMinSize },
      diffConfig: { scanLimit: DiffConfig.ScanLimit, timeout: DiffConfig.TimeoutMs },
      highlightChanges: true,
      gutter: true,
    });
    return () => view.destroy();
  }, [afterContent, beforeContent, language, wordWrap]);

  return <div ref={hostRef} className="codeMirrorDiff codeMirrorDiffSplit" data-diff-renderer="codemirror-split" />;
}

function UnifiedDiffView({
  afterContent,
  beforeContent,
  language,
  wordWrap,
}: {
  afterContent: string;
  beforeContent: string;
  language: string;
  wordWrap: boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const extensions = createDiffExtensions(language, wordWrap, [
      unifiedMergeView({
        allowInlineDiffs: true,
        collapseUnchanged: { margin: DiffConfig.CollapseMargin, minSize: DiffConfig.CollapseMinSize },
        diffConfig: { scanLimit: DiffConfig.ScanLimit, timeout: DiffConfig.TimeoutMs },
        gutter: true,
        mergeControls: false,
        original: beforeContent,
      }),
    ]);
    const state = EditorState.create({ doc: afterContent, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    return () => view.destroy();
  }, [afterContent, beforeContent, language, wordWrap]);

  return <div ref={hostRef} className="codeMirrorDiff codeMirrorDiffUnified" data-diff-renderer="codemirror-unified" />;
}

function createDiffExtensions(language: string, wordWrap: boolean, extensions: Extension[] = []) {
  return createReadOnlyCodeExtensions({
    language,
    extensions: wordWrap ? [EditorView.lineWrapping, ...extensions] : extensions,
  });
}
