import { AlertCircle, AlertTriangle, GitCommitHorizontal, History, Info, ListChecks, PanelRightClose } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { InlineState, PaneBody, PaneButton, PaneHeader, PaneTitle, SeverityTag } from "./components/ui.tsx";
import type { Finding, GitCommit, GitHistoryResponse, Snapshot } from "./types.ts";
import { ValidatorPanel } from "./ValidatorPanel.tsx";

type Props = {
  selectedFile: string | null;
  findings: Finding[];
  findingsIsLoading: boolean;
  gitHistory?: GitHistoryResponse;
  historyIsLoading: boolean;
  historyError?: Error;
  selectedCommit: string | null;
  snapshot?: Snapshot;
  snapshotIsLoading: boolean;
  snapshotError?: Error;
  activeTab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onJumpToFinding: (finding: Finding) => void;
  onOpenStudio: () => void;
  onSelectCommit: (commit: string) => void;
  onCollapse: () => void;
  resizeHandle?: ReactNode;
};

export const InspectorTab = {
  Findings: "findings",
  History: "history",
  Validators: "validators",
} as const;
export type InspectorTab = (typeof InspectorTab)[keyof typeof InspectorTab];

export function Inspector({
  selectedFile,
  findings,
  findingsIsLoading,
  gitHistory,
  historyIsLoading,
  historyError,
  selectedCommit,
  snapshot,
  snapshotIsLoading,
  snapshotError,
  activeTab,
  onTabChange,
  onJumpToFinding,
  onOpenStudio,
  onSelectCommit,
  onCollapse,
  resizeHandle,
}: Props) {
  const selectedHistory = useMemo(() => gitHistory?.histories.find((history) => history.file === selectedFile), [gitHistory, selectedFile]);
  const commitCount = selectedHistory?.commits.length ?? 0;
  const validatorCount = snapshot?.validators.length ?? 0;

  return (
    <aside className="inspector" aria-label="Inspector">
      {resizeHandle}
      <PaneHeader>
        <PaneTitle>Inspector</PaneTitle>
        <div className="inspectorTabs" role="tablist" aria-label="Inspector sections">
          <InspectorTabButton
            label="Findings"
            icon={<AlertTriangle size={13} />}
            active={activeTab === InspectorTab.Findings}
            count={findings.length}
            shortcut="1"
            onClick={() => onTabChange(InspectorTab.Findings)}
          />
          <InspectorTabButton
            label="History"
            icon={<History size={13} />}
            active={activeTab === InspectorTab.History}
            count={commitCount}
            shortcut="2"
            onClick={() => onTabChange(InspectorTab.History)}
          />
          <InspectorTabButton
            label="Rules"
            icon={<ListChecks size={13} />}
            active={activeTab === InspectorTab.Validators}
            count={validatorCount}
            shortcut="3"
            onClick={() => onTabChange(InspectorTab.Validators)}
          />
        </div>
        <PaneButton
          inline
          onClick={onCollapse}
          aria-keyshortcuts="]"
          aria-label="Collapse inspector"
          title="Collapse inspector (])"
        >
          <PanelRightClose size={14} />
        </PaneButton>
      </PaneHeader>
      <PaneBody className="inspectorBody">
        {activeTab === InspectorTab.Findings ? (
          <FindingsTab findings={findings} isLoading={findingsIsLoading} selectedFile={selectedFile} onJumpToFinding={onJumpToFinding} />
        ) : activeTab === InspectorTab.History ? (
          <HistoryTab
            selectedFile={selectedFile}
            gitHistory={gitHistory}
            selectedHistory={selectedHistory}
            selectedCommit={selectedCommit}
            isLoading={historyIsLoading}
            error={historyError}
            onSelectCommit={onSelectCommit}
          />
        ) : (
          <ValidatorPanel snapshot={snapshot} isLoading={snapshotIsLoading} error={snapshotError} onJumpToFinding={onJumpToFinding} onOpenStudio={onOpenStudio} />
        )}
      </PaneBody>
    </aside>
  );
}

function InspectorTabButton({
  label,
  icon,
  active,
  count,
  shortcut,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  active: boolean;
  count: number;
  shortcut: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`inspectorTab ${active ? "active" : ""}`}
      role="tab"
      aria-label={label}
      aria-keyshortcuts={shortcut}
      aria-selected={active}
      onClick={onClick}
      title={`${label} (${shortcut})`}
    >
      {icon}
      <span className={`inspectorTabCount ${count > 0 ? "hasCount" : ""}`}>{count}</span>
    </button>
  );
}

function FindingsTab({
  selectedFile,
  findings,
  isLoading,
  onJumpToFinding,
}: {
  selectedFile: string | null;
  findings: Finding[];
  isLoading: boolean;
  onJumpToFinding: (finding: Finding) => void;
}) {
  if (isLoading) return <InlineState>Loading findings...</InlineState>;
  if (findings.length === 0) {
    return <InlineState>{selectedFile ? "No findings on this file." : "Select a file to inspect findings."}</InlineState>;
  }
  return (
    <>
      {findings.map((finding) => (
        <FindingRow key={finding.id} finding={finding} onJumpToFinding={onJumpToFinding} />
      ))}
    </>
  );
}

function HistoryTab({
  selectedFile,
  gitHistory,
  selectedHistory,
  selectedCommit,
  isLoading,
  error,
  onSelectCommit,
}: {
  selectedFile: string | null;
  gitHistory?: GitHistoryResponse;
  selectedHistory?: GitHistoryResponse["histories"][number];
  selectedCommit: string | null;
  isLoading: boolean;
  error?: Error;
  onSelectCommit: (commit: string) => void;
}) {
  if (!selectedFile) return <InlineState>Select a file to inspect history.</InlineState>;
  if (isLoading) return <InlineState>Loading history...</InlineState>;
  if (error) return <InlineState tone="error">{error.message}</InlineState>;

  const diagnostics = [...(gitHistory?.diagnostics ?? []), ...(selectedHistory?.diagnostics ?? [])];
  if (diagnostics.length > 0) {
    return (
      <div className="historyList">
        {diagnostics.map((diagnostic) => (
          <div className="historyNotice" key={diagnostic}>
            {diagnostic}
          </div>
        ))}
      </div>
    );
  }

  const commits = selectedHistory?.commits ?? [];
  if (commits.length === 0) return <InlineState>No tracked history for this file.</InlineState>;

  return (
    <div className="historyList">
      <div className="historySummary">
        <span>{commits.length} commits</span>
        <span>{gitHistory?.gitRoot ?? "no git root"}</span>
      </div>
      <div className="historyCommits">
        {commits.map((commit) => {
          const key = commitKey(commit);
          return (
            <button
              type="button"
              className={`historyRow ${selectedCommit === key ? "active" : ""}`}
              key={`${commit.hash}-${commit.date}-${commit.subject}`}
              onClick={() => onSelectCommit(key)}
              aria-pressed={selectedCommit === key}
            >
              <GitCommitHorizontal size={14} className="historyIcon" aria-hidden="true" />
              <div className="historyMain">
                <div className="historyMeta">
                  <span className="commitHash" title={commit.fullHash}>
                    {commit.hash}
                  </span>
                  <time className="commitDate" dateTime={commit.date}>
                    {commit.date}
                  </time>
                  <span className="commitAuthor">{commit.author}</span>
                </div>
                <div className="commitSubject">{commit.subject || "No commit subject"}</div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function commitKey(commit: GitCommit): string {
  return commit.fullHash || commit.hash;
}

function FindingRow({ finding, onJumpToFinding }: { finding: Finding; onJumpToFinding: (finding: Finding) => void }) {
  const Icon = finding.severity === "error" ? AlertCircle : finding.severity === "warning" ? AlertTriangle : Info;
  return (
    <button type="button" className={`findingRow severity-${finding.severity}`} onClick={() => onJumpToFinding(finding)}>
      <Icon size={14} className="findingIcon" aria-hidden="true" />
      <div className="findingMain">
        <div className="findingHead">
          <span className="findingValidator">{finding.validatorId ?? finding.title ?? "validator"}</span>
          <span className="findingLoc">
            {finding.file ?? ""}
            {finding.line ? `:${finding.line}` : ""}
          </span>
        </div>
        <div className="findingMessage">{finding.message}</div>
        {finding.decisionIds && finding.decisionIds.length > 0 ? <div className="findingFix">Decisions: {finding.decisionIds.join(", ")}</div> : null}
        {finding.fix ? (
          <div className="findingFix">
            Fix ({finding.fix.type}): {finding.fix.description}
          </div>
        ) : null}
      </div>
      <SeverityTag severity={finding.severity} />
    </button>
  );
}
