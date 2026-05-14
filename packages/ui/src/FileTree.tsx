import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fetchTree } from "./api.ts";
import type { TreeEntry, TreeScope } from "./types.ts";
import { VscodeEntryIcon } from "./VscodeEntryIcon.tsx";
import { VscodeEntryKind } from "./vscodeIcons.ts";

const TreeRowDescription = {
  CanonDirectory: "OpenCanon canon: contains indexed files used for context and validation.",
  CanonFile: "OpenCanon canon: indexed for context and validation.",
} as const;

const TreeClassName = {
  DotEntry: "dotEntry",
  Finding: "hasFindings",
  Indexed: "indexed",
  Muted: "muted",
  Selected: "selected",
  Unindexed: "unindexed",
} as const;

const TreeEntryKind = {
  Directory: "dir",
} as const;

type Props = {
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  query: string;
  scope: TreeScope;
  showDotEntries: boolean;
  expandSignal: number;
  collapseSignal: number;
};

export function FileTree({ selectedFile, onSelectFile, query, scope, showDotEntries, expandSignal, collapseSignal }: Props) {
  const searchActive = query.trim().length > 0;
  return (
    <div className="fileTree" role="tree" aria-label="Project files">
      <TreeLevel
        dirPath=""
        depth={0}
        selectedFile={selectedFile}
        onSelectFile={onSelectFile}
        query={query}
        scope={scope}
        showDotEntries={showDotEntries}
        autoOpen={searchActive}
        expandSignal={expandSignal}
        collapseSignal={collapseSignal}
        startOpen
      />
    </div>
  );
}

type LevelProps = {
  dirPath: string;
  depth: number;
  selectedFile: string | null;
  onSelectFile: (path: string) => void;
  query: string;
  scope: TreeScope;
  showDotEntries: boolean;
  autoOpen: boolean;
  expandSignal: number;
  collapseSignal: number;
  startOpen?: boolean;
};

function TreeLevel({
  dirPath,
  depth,
  selectedFile,
  onSelectFile,
  query,
  scope,
  showDotEntries,
  autoOpen,
  expandSignal,
  collapseSignal,
  startOpen,
}: LevelProps) {
  const treeQuery = useQuery({
    queryKey: ["fs.tree", dirPath, scope, query, showDotEntries],
    queryFn: () => fetchTree({ dirPath, scope, query, showDotEntries }),
    enabled: startOpen ?? true,
  });

  if (treeQuery.isLoading) return <Indented depth={depth}><span className={TreeClassName.Muted}>Loading...</span></Indented>;
  if (treeQuery.isError) return <Indented depth={depth}><span className="severityError">{(treeQuery.error as Error).message}</span></Indented>;
  const entries = treeQuery.data?.entries ?? [];
  if (entries.length === 0) return <Indented depth={depth}><span className={TreeClassName.Muted}>{query.trim() ? "No matches" : "Empty"}</span></Indented>;

  return (
    <>
      {entries.map((entry) =>
        entry.kind === TreeEntryKind.Directory ? (
          <DirectoryRow
            key={entry.path}
            entry={entry}
            depth={depth}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            query={query}
            scope={scope}
            showDotEntries={showDotEntries}
            autoOpen={autoOpen}
            expandSignal={expandSignal}
            collapseSignal={collapseSignal}
          />
        ) : (
          <FileRow
            key={entry.path}
            entry={entry}
            depth={depth}
            selected={entry.path === selectedFile}
            onSelect={onSelectFile}
          />
        ),
      )}
    </>
  );
}

function DirectoryRow({
  entry,
  depth,
  selectedFile,
  onSelectFile,
  query,
  scope,
  showDotEntries,
  autoOpen,
  expandSignal,
  collapseSignal,
}: { entry: TreeEntry; depth: number; autoOpen: boolean } & Pick<
  Props,
  "selectedFile" | "onSelectFile" | "query" | "scope" | "showDotEntries" | "expandSignal" | "collapseSignal"
>) {
  const [open, setOpen] = useState(autoOpen || expandSignal > 0);
  const lastExpandSignal = useRef(expandSignal);
  const lastCollapseSignal = useRef(collapseSignal);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  useEffect(() => {
    if (expandSignal !== lastExpandSignal.current) {
      lastExpandSignal.current = expandSignal;
      if (expandSignal > 0) setOpen(true);
    }
  }, [expandSignal]);
  useEffect(() => {
    if (collapseSignal !== lastCollapseSignal.current) {
      lastCollapseSignal.current = collapseSignal;
      if (collapseSignal > 0) setOpen(false);
    }
  }, [collapseSignal]);

  return (
    <>
      <button
        type="button"
        className={treeRowClassName(entry)}
        style={{ paddingLeft: rowIndent(depth) }}
        onClick={toggle}
        aria-expanded={open}
        title={treeRowTitle(entry)}
      >
        {open ? <ChevronDown size={12} className="treeChevron" /> : <ChevronRight size={12} className="treeChevron" />}
        <TreeEntryIcon entry={entry} open={open} />
        <span className="treeName">{entry.name}</span>
        {entry.findingCount > 0 ? <span className="findingBadge" aria-label={`${entry.findingCount} findings`}>{entry.findingCount}</span> : null}
      </button>
      {open ? (
        <TreeLevel
          dirPath={entry.path}
          depth={depth + 1}
          selectedFile={selectedFile}
          onSelectFile={onSelectFile}
          query={query}
          scope={scope}
          showDotEntries={showDotEntries}
          autoOpen={autoOpen}
          expandSignal={expandSignal}
          collapseSignal={collapseSignal}
        />
      ) : null}
    </>
  );
}

function FileRow({
  entry,
  depth,
  selected,
  onSelect,
}: {
  entry: TreeEntry;
  depth: number;
  selected: boolean;
  onSelect: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className={treeRowClassName(entry, selected)}
      style={{ paddingLeft: rowIndent(depth) }}
      onClick={() => onSelect(entry.path)}
      aria-current={selected ? "true" : undefined}
      title={treeRowTitle(entry)}
    >
      <span className="treeChevron treeChevronPlaceholder" aria-hidden="true" />
      <TreeEntryIcon entry={entry} />
      <span className="treeName">{entry.name}</span>
      {entry.findingCount > 0 ? <span className="findingBadge" aria-label={`${entry.findingCount} findings`}>{entry.findingCount}</span> : null}
    </button>
  );
}

function TreeEntryIcon({ entry, open = false }: { entry: TreeEntry; open?: boolean }) {
  return (
    <VscodeEntryIcon
      pathValue={entry.kind === TreeEntryKind.Directory ? entry.name : entry.path || entry.name}
      kind={entry.kind === TreeEntryKind.Directory ? VscodeEntryKind.Directory : VscodeEntryKind.File}
      expanded={open}
      className="treeIcon"
    />
  );
}

function Indented({ depth, children }: { depth: number; children: ReactNode }) {
  return <div className="treeRow treeNote" style={{ paddingLeft: rowIndent(depth) + 16 }}>{children}</div>;
}

function rowIndent(depth: number) {
  return 10 + depth * 16;
}

function treeRowTitle(entry: TreeEntry): string {
  const details = [entry.path];
  if (entry.indexed) details.push(entry.kind === TreeEntryKind.Directory ? TreeRowDescription.CanonDirectory : TreeRowDescription.CanonFile);
  if (entry.findingCount > 0) details.push(`${entry.findingCount} ${entry.findingCount === 1 ? "finding" : "findings"}`);
  return details.join("\n");
}

function treeRowClassName(entry: TreeEntry, selected = false): string {
  return [
    "treeRow",
    `treeRow-${entry.kind}`,
    entry.indexed ? TreeClassName.Indexed : TreeClassName.Unindexed,
    selected ? TreeClassName.Selected : "",
    entry.findingCount > 0 ? TreeClassName.Finding : "",
    isDotEntry(entry.name) ? TreeClassName.DotEntry : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function isDotEntry(name: string): boolean {
  return name.startsWith(".");
}
