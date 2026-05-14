import { useQuery } from "@tanstack/react-query";
import {
  Code2,
  Eye,
  EyeOff,
  FileSearch,
  Files,
  FileText,
  FolderClosed,
  FolderOpen,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  SearchX,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { fetchFile, fetchFindings, fetchGitDiff, fetchGitHistory } from "./api.ts";
import { CodeViewer } from "./CodeViewer.tsx";
import { EmptyState, InlineState, PaneBody, PaneButton, PaneHeader, PaneSubtitle, PaneTitle, SegmentedButton, SegmentedControl } from "./components/ui.tsx";
import { FileTree } from "./FileTree.tsx";
import { Inspector, InspectorTab, type InspectorTab as InspectorTabValue } from "./Inspector.tsx";
import type { Finding, Snapshot, TreeScope } from "./types.ts";
import { basename, clamp, commitKey, dirname, formatBytes, shouldIgnoreShortcut, useStoredBoolean, useStoredNumber, useStoredValue } from "./workbench-utils.ts";
import { VscodeEntryIcon } from "./VscodeEntryIcon.tsx";
import { VscodeEntryKind } from "./vscodeIcons.ts";

type Props = {
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  onOpenStudio: () => void;
  snapshot?: Snapshot;
  snapshotIsLoading: boolean;
  snapshotError?: Error;
};

const MarkdownPreview = lazy(async () => {
  const module = await import("./MarkdownPreview.tsx");
  return { default: module.MarkdownPreview };
});

const DiffViewer = lazy(async () => {
  const module = await import("./DiffViewer.tsx");
  return { default: module.DiffViewer };
});

const ViewerMode = {
  Preview: "preview",
  Source: "source",
} as const;
type ViewerMode = (typeof ViewerMode)[keyof typeof ViewerMode];

const ContentMode = {
  Current: "current",
  Diff: "diff",
} as const;
type ContentMode = (typeof ContentMode)[keyof typeof ContentMode];

const TreeScopeFilter = {
  All: "all",
  Canon: "canon",
} as const;

const TreeView = {
  Files: "files",
  Search: "search",
} as const;
type TreeView = (typeof TreeView)[keyof typeof TreeView];

const WorkbenchDomEvent = {
  Keydown: "keydown",
} as const;

const WorkbenchShortcut = {
  CollapseTree: "C",
  ClearSearch: "Escape",
  ExpandTree: "E",
  FilesView: "f",
  Findings: "1",
  FocusSearch: "/",
  History: "2",
  SearchView: "s",
  Validators: "3",
  ToggleFiles: "[",
  ToggleInspector: "]",
  ToggleMarkdownMode: "m",
} as const;

const WorkbenchStorageKey = {
  InspectorOpen: "opencanon.ui.inspectorOpen",
  InspectorWidth: "opencanon.ui.inspectorWidth",
  ShowDotEntries: "opencanon.ui.showDotEntries",
  TreeOpen: "opencanon.ui.treeOpen",
  TreeScope: "opencanon.ui.treeScope",
  TreeView: "opencanon.ui.treeView",
  TreeWidth: "opencanon.ui.treeWidth",
} as const;

const PaneSize = {
  InspectorDefault: 360,
  InspectorMax: 620,
  InspectorMin: 280,
  TreeDefault: 280,
  TreeMax: 520,
  TreeMin: 220,
} as const;

export function Workbench({
  selectedFile,
  onSelectFile,
  onOpenStudio,
  snapshot,
  snapshotIsLoading,
  snapshotError,
}: Props) {
  const [treeOpen, setTreeOpen] = useStoredBoolean(WorkbenchStorageKey.TreeOpen, true);
  const [inspectorOpen, setInspectorOpen] = useStoredBoolean(WorkbenchStorageKey.InspectorOpen, true);
  const [treeWidth, setTreeWidth] = useStoredNumber(WorkbenchStorageKey.TreeWidth, PaneSize.TreeDefault);
  const [inspectorWidth, setInspectorWidth] = useStoredNumber(WorkbenchStorageKey.InspectorWidth, PaneSize.InspectorDefault);
  const [inspectorTab, setInspectorTab] = useState<InspectorTabValue>(InspectorTab.Findings);
  const [contentMode, setContentMode] = useState<ContentMode>(ContentMode.Current);
  const [markdownMode, setMarkdownMode] = useState<ViewerMode>(ViewerMode.Preview);
  const [focusedLine, setFocusedLine] = useState<number | null>(null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [treeQuery, setTreeQuery] = useState("");
  const [treeView, setTreeView] = useStoredTreeView(WorkbenchStorageKey.TreeView, TreeView.Files);
  const [treeScope, setTreeScope] = useStoredTreeScope(WorkbenchStorageKey.TreeScope, TreeScopeFilter.All);
  const [showDotEntries, setShowDotEntries] = useStoredBoolean(WorkbenchStorageKey.ShowDotEntries, true);
  const [treeExpandSignal, setTreeExpandSignal] = useState(0);
  const [treeCollapseSignal, setTreeCollapseSignal] = useState(0);
  const treeSearchInputRef = useRef<HTMLInputElement | null>(null);
  const fileQuery = useQuery({
    queryKey: ["fs.file", selectedFile],
    queryFn: () => fetchFile(selectedFile as string),
    enabled: Boolean(selectedFile),
    retry: false,
  });
  const findingsQuery = useQuery({
    queryKey: ["findings.file", selectedFile],
    queryFn: () => fetchFindings(selectedFile as string),
    enabled: Boolean(selectedFile),
  });
  const historyQuery = useQuery({
    queryKey: ["git.history", selectedFile],
    queryFn: () => fetchGitHistory(selectedFile as string, 12),
    enabled: Boolean(selectedFile),
  });
  const selectedHistory = historyQuery.data?.histories.find((history) => history.file === selectedFile);
  const diffQuery = useQuery({
    queryKey: ["git.diff", selectedFile, selectedCommit],
    queryFn: () => fetchGitDiff(selectedFile as string, selectedCommit as string),
    enabled: Boolean(selectedFile && selectedCommit && contentMode === ContentMode.Diff),
    retry: false,
  });
  const isMarkdown = fileQuery.data?.language === "markdown";
  const findings = findingsQuery.data ?? [];
  const selectedFacts = useMemo(() => snapshot?.facts.find((file) => file.path === selectedFile), [selectedFile, snapshot]);
  const selectedImportEdges = useMemo(() => snapshot?.graph.importEdges.filter((edge) => edge.from === selectedFile) ?? [], [selectedFile, snapshot]);

  function handleSelectFile(path: string): void {
    setFocusedLine(null);
    onSelectFile(path);
  }

  function handleContentModeChange(mode: ContentMode): void {
    setContentMode(mode);
    if (mode === ContentMode.Diff) {
      setInspectorOpen(true);
      setInspectorTab(InspectorTab.History);
    }
  }

  function handleInspectorTabChange(tab: InspectorTabValue): void {
    setInspectorTab(tab);
    if (tab === InspectorTab.History) setContentMode(ContentMode.Diff);
  }

  function handleJumpToFinding(finding: Finding): void {
    if (finding.line) setFocusedLine(finding.line);
    if (finding.file && finding.file !== selectedFile) onSelectFile(finding.file);
  }

  function handleSelectCommit(commit: string): void {
    setSelectedCommit(commit);
    setContentMode(ContentMode.Diff);
  }

  function focusTreeSearch(view: TreeView = treeView): void {
    setTreeOpen(true);
    setTreeView(view);
    window.requestAnimationFrame(() => treeSearchInputRef.current?.focus());
  }

  useEffect(() => {
    setSelectedCommit(null);
    setContentMode(ContentMode.Current);
  }, [selectedFile]);

  useEffect(() => {
    const commits = selectedHistory?.commits ?? [];
    const firstCommit = commits[0];
    if (!firstCommit) return;
    const selectedExists = selectedCommit ? commits.some((commit) => commitKey(commit) === selectedCommit) : false;
    if (!selectedExists) setSelectedCommit(commitKey(firstCommit));
  }, [selectedHistory, selectedCommit]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (shouldIgnoreShortcut(event)) return;

      const key = event.key.toLowerCase();
      if (event.key === WorkbenchShortcut.ClearSearch && treeQuery) {
        event.preventDefault();
        setTreeQuery("");
        return;
      }
      if (key === WorkbenchShortcut.ToggleFiles) {
        event.preventDefault();
        setTreeOpen((open) => !open);
        return;
      }
      if (key === WorkbenchShortcut.ToggleInspector) {
        event.preventDefault();
        setInspectorOpen((open) => !open);
        return;
      }
      if (event.key === WorkbenchShortcut.FocusSearch) {
        event.preventDefault();
        focusTreeSearch(TreeView.Search);
        return;
      }
      if (key === WorkbenchShortcut.FilesView) {
        event.preventDefault();
        setTreeOpen(true);
        setTreeView(TreeView.Files);
        return;
      }
      if (key === WorkbenchShortcut.SearchView) {
        event.preventDefault();
        focusTreeSearch(TreeView.Search);
        return;
      }
      if (event.shiftKey && key === WorkbenchShortcut.ExpandTree.toLowerCase()) {
        event.preventDefault();
        setTreeOpen(true);
        setTreeView(TreeView.Files);
        setTreeExpandSignal((signal) => signal + 1);
        return;
      }
      if (event.shiftKey && key === WorkbenchShortcut.CollapseTree.toLowerCase()) {
        event.preventDefault();
        setTreeOpen(true);
        setTreeView(TreeView.Files);
        setTreeCollapseSignal((signal) => signal + 1);
        return;
      }
      if (key === WorkbenchShortcut.Findings) {
        event.preventDefault();
        setInspectorOpen(true);
        handleInspectorTabChange(InspectorTab.Findings);
        return;
      }
      if (key === WorkbenchShortcut.History) {
        event.preventDefault();
        setInspectorOpen(true);
        handleInspectorTabChange(InspectorTab.History);
        return;
      }
      if (key === WorkbenchShortcut.Validators) {
        event.preventDefault();
        setInspectorOpen(true);
        handleInspectorTabChange(InspectorTab.Validators);
        return;
      }
      if (key === WorkbenchShortcut.ToggleMarkdownMode && isMarkdown && contentMode === ContentMode.Current) {
        event.preventDefault();
        setMarkdownMode((mode) => (mode === ViewerMode.Preview ? ViewerMode.Source : ViewerMode.Preview));
      }
    };

    window.addEventListener(WorkbenchDomEvent.Keydown, handleKeyDown);
    return () => window.removeEventListener(WorkbenchDomEvent.Keydown, handleKeyDown);
  }, [contentMode, isMarkdown, treeQuery, treeView]);

  const workbenchStyle = {
    "--inspector-width": `${clamp(inspectorWidth, PaneSize.InspectorMin, PaneSize.InspectorMax)}px`,
    "--tree-width": `${clamp(treeWidth, PaneSize.TreeMin, PaneSize.TreeMax)}px`,
  } as CSSProperties;

  return (
    <div className={`workbench ${treeOpen ? "" : "treeCollapsed"} ${inspectorOpen ? "" : "inspectorCollapsed"}`} style={workbenchStyle}>
      {treeOpen ? (
        <section className="treePane" aria-label="File tree">
          <PaneHeader>
            <PaneTitle>Files</PaneTitle>
            <PaneButton
              onClick={() => setTreeOpen(false)}
              aria-keyshortcuts="["
              aria-label="Collapse files"
              title="Collapse files ([)"
            >
              <PanelLeftClose size={14} />
            </PaneButton>
          </PaneHeader>
          <TreeControls
            view={treeView}
            query={treeQuery}
            scope={treeScope}
            showDotEntries={showDotEntries}
            inputRef={treeSearchInputRef}
            onViewChange={setTreeView}
            onQueryChange={setTreeQuery}
            onScopeChange={setTreeScope}
            onShowDotEntriesChange={setShowDotEntries}
            onExpandAll={() => setTreeExpandSignal((signal) => signal + 1)}
            onCollapseAll={() => setTreeCollapseSignal((signal) => signal + 1)}
          />
          <PaneBody scroll>
            {treeView === TreeView.Files ? (
              <FileTree
                selectedFile={selectedFile}
                onSelectFile={handleSelectFile}
                query={treeQuery}
                scope={treeScope}
                showDotEntries={showDotEntries}
                expandSignal={treeExpandSignal}
                collapseSignal={treeCollapseSignal}
              />
            ) : (
              <SearchPanel snapshot={snapshot} query={treeQuery} showDotEntries={showDotEntries} selectedFile={selectedFile} onSelectFile={handleSelectFile} />
            )}
          </PaneBody>
          <PaneResizeHandle
            side="left"
            value={treeWidth}
            min={PaneSize.TreeMin}
            max={PaneSize.TreeMax}
            label="Resize files pane"
            onChange={setTreeWidth}
          />
        </section>
      ) : (
        <CollapsedPane side="left" label="Files" shortcut={WorkbenchShortcut.ToggleFiles} onOpen={() => setTreeOpen(true)} />
      )}
      <section className="codePane" aria-label="Code viewer">
        <PaneHeader>
          <FileText size={13} />
          <PaneTitle>{selectedFile ?? "No file selected"}</PaneTitle>
          {fileQuery.data ? (
            <PaneSubtitle>
              {contentMode === ContentMode.Diff ? "git diff" : fileQuery.data.language} / {formatBytes(fileQuery.data.bytes)}
              {findings.length > 0 ? ` / ${findings.length} findings` : ""}
            </PaneSubtitle>
          ) : null}
          <div className="paneHeaderActions">
            {selectedFile ? <ContentModeControl mode={contentMode} hasDiff={Boolean(selectedCommit)} onChange={handleContentModeChange} /> : null}
            {isMarkdown && contentMode === ContentMode.Current ? <MarkdownModeControl mode={markdownMode} onChange={setMarkdownMode} /> : null}
          </div>
        </PaneHeader>
        <PaneBody>
          {!selectedFile ? (
            <EmptyState icon={<FileText size={20} />} title="No file selected">Select a file from the tree.</EmptyState>
          ) : contentMode === ContentMode.Diff ? (
            <Suspense fallback={<InlineState>Loading diff viewer...</InlineState>}>
              <DiffViewer
                language={fileQuery.data.language}
                selectedCommit={selectedCommit}
                gitDiff={diffQuery.data}
                isLoading={diffQuery.isLoading}
                error={diffQuery.error as Error | undefined}
              />
            </Suspense>
          ) : fileQuery.isLoading ? (
            <InlineState>Loading file...</InlineState>
          ) : fileQuery.isError ? (
            <InlineState tone="error">{(fileQuery.error as Error).message}</InlineState>
          ) : fileQuery.data && isMarkdown && markdownMode === ViewerMode.Preview ? (
            <Suspense fallback={<InlineState>Loading preview...</InlineState>}>
              <MarkdownPreview content={fileQuery.data.content} />
            </Suspense>
          ) : fileQuery.data ? (
            <CodeViewer
              content={fileQuery.data.content}
              language={fileQuery.data.language}
              findings={findings}
              focusedLine={focusedLine}
              fileFacts={selectedFacts}
              importEdges={selectedImportEdges}
            />
          ) : null}
        </PaneBody>
      </section>
      {inspectorOpen ? (
        <Inspector
          selectedFile={selectedFile}
          findings={findings}
          findingsIsLoading={findingsQuery.isLoading}
          gitHistory={historyQuery.data}
          historyIsLoading={historyQuery.isLoading}
          historyError={historyQuery.error as Error | undefined}
          selectedCommit={selectedCommit}
          snapshot={snapshot}
          snapshotIsLoading={snapshotIsLoading}
          snapshotError={snapshotError}
          activeTab={inspectorTab}
          onTabChange={handleInspectorTabChange}
          onJumpToFinding={handleJumpToFinding}
          onOpenStudio={onOpenStudio}
          onSelectCommit={handleSelectCommit}
          onCollapse={() => setInspectorOpen(false)}
          resizeHandle={
            <PaneResizeHandle
              side="right"
              value={inspectorWidth}
              min={PaneSize.InspectorMin}
              max={PaneSize.InspectorMax}
              label="Resize inspector pane"
              onChange={setInspectorWidth}
            />
          }
        />
      ) : (
        <CollapsedPane side="right" label="Inspector" shortcut={WorkbenchShortcut.ToggleInspector} onOpen={() => setInspectorOpen(true)} />
      )}
    </div>
  );
}

function TreeControls({
  view,
  query,
  scope,
  showDotEntries,
  inputRef,
  onViewChange,
  onQueryChange,
  onScopeChange,
  onShowDotEntriesChange,
  onExpandAll,
  onCollapseAll,
}: {
  view: TreeView;
  query: string;
  scope: TreeScope;
  showDotEntries: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onViewChange: (view: TreeView) => void;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: TreeScope) => void;
  onShowDotEntriesChange: (show: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}) {
  const searchLabel = view === TreeView.Files ? "Filter files" : "Search files";
  return (
    <div className="treeControls">
      <div className="treeViewRow">
        <SegmentedControl label="Files pane view" className="treeViewTabs">
          <SegmentedButton
            active={view === TreeView.Files}
            onClick={() => onViewChange(TreeView.Files)}
            aria-keyshortcuts={WorkbenchShortcut.FilesView}
            title="Files (f)"
          >
            <Files size={13} />
            <span>Files</span>
          </SegmentedButton>
          <SegmentedButton
            active={view === TreeView.Search}
            onClick={() => onViewChange(TreeView.Search)}
            aria-keyshortcuts={WorkbenchShortcut.SearchView}
            title="Search (s)"
          >
            <FileSearch size={13} />
            <span>Search</span>
          </SegmentedButton>
        </SegmentedControl>
        <div className="treeToolGroup" aria-label="Tree actions">
          {view === TreeView.Files ? (
            <>
              <button type="button" className="treeToolButton" onClick={onCollapseAll} aria-keyshortcuts="Shift+C" aria-label="Collapse all" title="Collapse all (Shift+C)">
                <FolderClosed size={13} />
              </button>
              <button type="button" className="treeToolButton" onClick={onExpandAll} aria-keyshortcuts="Shift+E" aria-label="Expand all" title="Expand all (Shift+E)">
                <FolderOpen size={13} />
              </button>
            </>
          ) : null}
          <button
            type="button"
            className={`treeToolButton ${showDotEntries ? "active" : ""}`}
            onClick={() => onShowDotEntriesChange(!showDotEntries)}
            aria-pressed={showDotEntries}
            aria-label={showDotEntries ? "Hide dot entries" : "Show dot entries"}
            title={showDotEntries ? "Hide dot entries" : "Show dot entries"}
          >
            {showDotEntries ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        </div>
      </div>
      <div className="treeControlRow">
        <label className="treeSearch">
          <Search size={13} />
          <input ref={inputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={searchLabel} aria-label={searchLabel} />
        </label>
        {query ? (
          <button type="button" className="treeToolButton" onClick={() => onQueryChange("")} aria-label="Clear search" title="Clear search (Esc)">
            <SearchX size={13} />
          </button>
        ) : null}
        {view === TreeView.Files ? (
          <SegmentedControl label="File tree scope" className="treeScopeControl">
            <SegmentedButton
              active={scope === TreeScopeFilter.All}
              onClick={() => onScopeChange(TreeScopeFilter.All)}
              title="Show Git-visible files"
            >
              All
            </SegmentedButton>
            <SegmentedButton
              active={scope === TreeScopeFilter.Canon}
              onClick={() => onScopeChange(TreeScopeFilter.Canon)}
              title="Show OpenCanon indexed files"
            >
              Canon
            </SegmentedButton>
          </SegmentedControl>
        ) : null}
      </div>
      {view === TreeView.Files ? <TreeStatusKey /> : null}
    </div>
  );
}

function SearchPanel({
  snapshot,
  query,
  showDotEntries,
  selectedFile,
  onSelectFile,
}: {
  snapshot?: Snapshot;
  query: string;
  showDotEntries: boolean;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
}) {
  const findingsByFile = useMemo(() => {
    const counts = new Map<string, number>();
    for (const finding of snapshot?.findings ?? []) {
      if (!finding.file) continue;
      counts.set(finding.file, (counts.get(finding.file) ?? 0) + 1);
    }
    return counts;
  }, [snapshot]);
  const results = useMemo(() => {
    const files = showDotEntries ? (snapshot?.files ?? []) : (snapshot?.files ?? []).filter((file) => !file.split("/").some((segment) => segment.startsWith(".")));
    const needle = query.trim().toLowerCase();
    const matched = needle ? files.filter((file) => file.toLowerCase().includes(needle)) : files;
    return matched.slice(0, 80);
  }, [query, showDotEntries, snapshot]);

  if (!snapshot) return <InlineState>Loading search...</InlineState>;
  if (results.length === 0) return <InlineState>{query.trim() ? "No matches." : "No files indexed."}</InlineState>;

  return (
    <div className="searchResults" role="listbox" aria-label="Search results">
      {results.map((file) => {
        const findingCount = findingsByFile.get(file) ?? 0;
        return (
          <button
            type="button"
            key={file}
            className={`searchResultRow ${selectedFile === file ? "selected" : ""}`}
            onClick={() => onSelectFile(file)}
            role="option"
            aria-selected={selectedFile === file}
            title={file}
          >
            <VscodeEntryIcon pathValue={file} kind={VscodeEntryKind.File} className="searchResultIcon" />
            <span className="searchResultMain">
              <span className="searchResultName">{basename(file)}</span>
              <span className="searchResultPath">{dirname(file)}</span>
            </span>
            {findingCount > 0 ? <span className="findingBadge" aria-label={`${findingCount} findings`}>{findingCount}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

function TreeStatusKey() {
  return (
    <details className="treeStatusKey" aria-label="File tree status key">
      <summary>Key</summary>
      <div className="treeStatusKeyItems">
        <span><i className="treeKeySwatch treeKeyCanon" />canon indexed</span>
        <span><i className="treeKeySwatch treeKeyOutside" />outside canon</span>
        <span><i className="treeKeyBadge" />findings</span>
        <span><i className="treeKeySwatch treeKeyDot" />dot entry</span>
      </div>
    </details>
  );
}

function PaneResizeHandle({
  side,
  value,
  min,
  max,
  label,
  onChange,
}: {
  side: "left" | "right";
  value: number;
  min: number;
  max: number;
  label: string;
  onChange: (value: number) => void;
}) {
  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startValue = value;

    function handlePointerMove(moveEvent: PointerEvent): void {
      const delta = moveEvent.clientX - startX;
      onChange(clamp(side === "left" ? startValue + delta : startValue - delta, min, max));
    }

    function handlePointerUp(): void {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }

  return (
    <button
      type="button"
      className={`paneResizeHandle paneResize-${side}`}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={min}
      aria-valuenow={value}
      onPointerDown={handlePointerDown}
      role="separator"
      title={label}
    />
  );
}

function ContentModeControl({
  mode,
  hasDiff,
  onChange,
}: {
  mode: ContentMode;
  hasDiff: boolean;
  onChange: (mode: ContentMode) => void;
}) {
  return (
    <SegmentedControl label="Center pane mode">
      <SegmentedButton active={mode === ContentMode.Current} onClick={() => onChange(ContentMode.Current)} title="Current file">
        <FileText size={13} />
        <span>Current</span>
      </SegmentedButton>
      <SegmentedButton
        active={mode === ContentMode.Diff}
        onClick={() => onChange(ContentMode.Diff)}
        disabled={!hasDiff}
        title={hasDiff ? "Selected commit diff" : "No commit selected"}
      >
        <Code2 size={13} />
        <span>Diff</span>
      </SegmentedButton>
    </SegmentedControl>
  );
}

function MarkdownModeControl({ mode, onChange }: { mode: ViewerMode; onChange: (mode: ViewerMode) => void }) {
  return (
    <SegmentedControl label="Markdown view mode">
      <SegmentedButton
        active={mode === ViewerMode.Preview}
        onClick={() => onChange(ViewerMode.Preview)}
        aria-keyshortcuts={WorkbenchShortcut.ToggleMarkdownMode}
        title="Preview (m)"
      >
        <Eye size={13} />
        <span>Preview</span>
      </SegmentedButton>
      <SegmentedButton
        active={mode === ViewerMode.Source}
        onClick={() => onChange(ViewerMode.Source)}
        aria-keyshortcuts={WorkbenchShortcut.ToggleMarkdownMode}
        title="Source (m)"
      >
        <Code2 size={13} />
        <span>Source</span>
      </SegmentedButton>
    </SegmentedControl>
  );
}

function useStoredTreeScope(key: string, fallback: TreeScope): [TreeScope, (value: TreeScope | ((current: TreeScope) => TreeScope)) => void] {
  return useStoredValue(key, fallback, (value) => (value === TreeScopeFilter.Canon ? TreeScopeFilter.Canon : TreeScopeFilter.All));
}

function useStoredTreeView(key: string, fallback: TreeView): [TreeView, (value: TreeView | ((current: TreeView) => TreeView)) => void] {
  return useStoredValue(key, fallback, (value) => (value === TreeView.Search ? TreeView.Search : TreeView.Files));
}

function CollapsedPane({ side, label, shortcut, onOpen }: { side: "left" | "right"; label: string; shortcut: string; onOpen: () => void }) {
  const Icon = side === "left" ? PanelLeftOpen : PanelRightOpen;
  const title = `Open ${label.toLowerCase()} (${shortcut})`;
  return (
    <button
      type="button"
      className={`collapsedPane collapsed-${side}`}
      onClick={onOpen}
      aria-keyshortcuts={shortcut}
      aria-label={`Open ${label.toLowerCase()}`}
      title={title}
    >
      <Icon size={14} />
      <span>{label}</span>
    </button>
  );
}
