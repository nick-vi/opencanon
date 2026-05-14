import { AlertCircle, AlertTriangle, ArrowRight, CheckCircle2, FileText, GitBranch, Info, ListTree, SearchCode, Wand2 } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { InlineState, SeverityTag } from "./components/ui.tsx";
import type { Finding, Snapshot, ValidatorSummary } from "./types.ts";

type Props = {
  snapshot?: Snapshot;
  isLoading: boolean;
  error?: Error;
  onJumpToFinding: (finding: Finding) => void;
  onOpenStudio: () => void;
};

const ValidatorClassName = {
  ValidatorEmpty: "validatorEmpty",
} as const;

const FindingSeverityIcon = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

export function ValidatorPanel({ snapshot, isLoading, error, onJumpToFinding, onOpenStudio }: Props) {
  const validators = snapshot?.validators ?? [];
  const findings = snapshot?.findings ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(validators[0]?.id ?? null);
  const selectedValidator = validators.find((validator) => validator.id === selectedId) ?? validators[0];
  const selectedFindings = selectedValidator ? findings.filter((finding) => finding.validatorId === selectedValidator.id) : [];

  if (isLoading) return <InlineState>Loading validators...</InlineState>;
  if (error) return <InlineState tone="error">{error.message}</InlineState>;
  if (validators.length === 0) return <InlineState>No validators loaded.</InlineState>;

  return (
    <div className="validatorPanel">
      <div className="validatorPanelSummary">
        <span>{validators.length} rules</span>
        <span>{findings.length} findings</span>
        <button type="button" className="validatorStudioLink" onClick={onOpenStudio}>
          <Wand2 size={12} />
          <span>Studio</span>
        </button>
      </div>
      <ValidatorList validators={validators} findings={findings} selectedId={selectedValidator?.id ?? null} onSelect={setSelectedId} />
      <ValidatorDetail validator={selectedValidator} findings={selectedFindings} onJumpToFinding={onJumpToFinding} />
    </div>
  );
}

function ValidatorList({
  validators,
  findings,
  selectedId,
  onSelect,
}: {
  validators: ValidatorSummary[];
  findings: Finding[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="validatorPanelList" aria-label="Validator list">
      {validators.map((validator) => {
        const count = findings.filter((finding) => finding.validatorId === validator.id).length;
        const active = validator.id === selectedId;
        return (
          <button type="button" key={validator.id} className={`validatorRow ${active ? "active" : ""}`} onClick={() => onSelect(validator.id)}>
            <div className="validatorRowMain">
              <div className="validatorRowHead">
                <span className="validatorId">{validator.id}</span>
                <SeverityTag severity={validator.severity} />
              </div>
              <div className="validatorSummary">{validator.summary ?? "No summary provided."}</div>
              <div className="validatorMeta">
                <span>{validator.scope}</span>
                <span>{validator.topics.join(", ")}</span>
              </div>
            </div>
            <span className={`validatorFindingCount ${count > 0 ? "hasFindings" : ""}`}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}

function ValidatorDetail({ validator, findings, onJumpToFinding }: { validator?: ValidatorSummary; findings: Finding[]; onJumpToFinding: (finding: Finding) => void }) {
  const docs = useMemo(() => [...new Set([...(validator?.docs ?? []), ...findings.flatMap((finding) => finding.docs ?? [])])], [findings, validator?.docs]);
  if (!validator) return <InlineState>Select a validator.</InlineState>;

  return (
    <div className="validatorDetail">
      <div className="validatorDetailHeader">
        <div>
          <div className="validatorDetailTitle">{validator.id}</div>
          <div className="validatorDetailSummary">{validator.summary ?? "No summary provided."}</div>
        </div>
        <SeverityTag severity={validator.severity} />
      </div>

      <div className="validatorFacts">
        <FactBlock icon={<SearchCode size={14} />} label="Scope" values={[validator.scope]} />
        <FactBlock icon={<GitBranch size={14} />} label="Topics" values={validator.topics} />
        <FactBlock icon={<CheckCircle2 size={14} />} label="Facts" values={validator.facts.length > 0 ? validator.facts : ["none"]} />
      </div>

      <DetailSection title="Applies">
        <AppliesList appliesScopes={validator.appliesScopes} />
      </DetailSection>

      <DetailSection title="Canon">
        <ReferenceList icon={<FileText size={13} />} empty="No decision ids attached." values={validator.decisionIds} />
        <ReferenceList icon={<ArrowRight size={13} />} empty="No docs attached." values={docs} />
      </DetailSection>

      <DetailSection title="Visuals">
        <ReferenceList
          icon={<ListTree size={13} />}
          empty="No visual rule tree registered."
          values={validator.visuals.map((visual) => visual.title ?? visual.kind)}
        />
      </DetailSection>

      <DetailSection title={`Findings (${findings.length})`}>
        <FindingList findings={findings} onJumpToFinding={onJumpToFinding} />
      </DetailSection>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="validatorSection">
      <div className="validatorSectionTitle">{title}</div>
      {children}
    </section>
  );
}

function FactBlock({ icon, label, values }: { icon: ReactNode; label: string; values: string[] }) {
  return (
    <div className="validatorFact">
      <div className="validatorFactLabel">
        {icon}
        <span>{label}</span>
      </div>
      <div className="validatorFactValue">{values.join(", ")}</div>
    </div>
  );
}

function AppliesList({ appliesScopes }: { appliesScopes: string[][] }) {
  if (appliesScopes.length === 0) return <div className={ValidatorClassName.ValidatorEmpty}>Applies to the full project.</div>;
  return (
    <div className="appliesList">
      {appliesScopes.map((scope, index) => (
        <div className="appliesGroup" key={`${index}-${scope.join("|")}`}>
          <span className="scopeBadge">scope {index + 1}</span>
          <div>{scope.join(", ")}</div>
        </div>
      ))}
    </div>
  );
}

function ReferenceList({ icon, empty, values }: { icon: ReactNode; empty: string; values: string[] }) {
  if (values.length === 0) return <div className={ValidatorClassName.ValidatorEmpty}>{empty}</div>;
  return (
    <div className="referenceList">
      {values.map((value) => (
        <div className="referenceItem" key={value}>
          {icon}
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}

function FindingList({ findings, onJumpToFinding }: { findings: Finding[]; onJumpToFinding: (finding: Finding) => void }) {
  if (findings.length === 0) return <div className={ValidatorClassName.ValidatorEmpty}>No findings for this validator.</div>;
  return (
    <div className="validatorFindings">
      {findings.map((finding) => {
        const Icon = FindingSeverityIcon[finding.severity];
        return (
          <button type="button" className="validatorFinding" key={finding.id} onClick={() => onJumpToFinding(finding)}>
            <Icon size={14} className="findingIcon" aria-hidden="true" />
            <div className="validatorFindingBody">
              <div className="findingLoc">
                {finding.file ?? "project"}
                {finding.line ? `:${finding.line}` : ""}
              </div>
              <div className="findingMessage">{finding.message}</div>
            </div>
            <ArrowRight size={13} />
          </button>
        );
      })}
    </div>
  );
}
