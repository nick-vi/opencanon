import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, FlaskConical, Minus, Play, Plus, RotateCcw, Save, Trash2, Wand2, XCircle } from "lucide-react";
import {
  fetchStudioFactories,
  fetchStudioValidators,
  postStudioApply,
  postStudioPreview,
  postStudioRunFixtures,
} from "./api.ts";
import {
  cx,
  InlineState,
  PaneBody,
  PaneButton,
  PaneHeader,
  PaneSubtitle,
  PaneTitle,
  SeverityTag,
} from "./components/ui.tsx";
import type {
  StudioFactoryDescriptor,
  StudioFieldDescriptor,
  StudioFixtureRun,
  StudioFixtureSet,
  StudioPreview,
  StudioRequest,
  StudioValidatorSummary,
} from "./types.ts";

import {
  StudioClassName,
  StudioFieldKind,
  StudioFixtureCase,
  StudioLinePresets,
  StudioOption,
  StudioQueryKey,
  StudioSeverity,
  StudioSeverityMeta,
  type StudioForm,
  type StudioOption as StudioOptionValueValue,
} from "./validator-studio-constants.ts";
import { copyFixtures, fieldLines, formFromDefaults, groupedStudioFields, regexDiagnostic, requestFromState, toKebabCase } from "./validator-studio-utils.ts";

type Props = {
  onBack: () => void;
};

export function ValidatorStudio({ onBack }: Props) {
  const queryClient = useQueryClient();
  const factoriesQuery = useQuery({ queryKey: [StudioQueryKey.Factories], queryFn: fetchStudioFactories });
  const validatorsQuery = useQuery({ queryKey: [StudioQueryKey.Validators], queryFn: fetchStudioValidators });
  const factories = factoriesQuery.data ?? [];
  const validators = validatorsQuery.data ?? [];
  const [selectedFactoryId, setSelectedFactoryId] = useState<string | null>(null);
  const selectedFactory = useMemo(
    () => factories.find((factory) => factory.id === selectedFactoryId) ?? factories[0],
    [factories, selectedFactoryId],
  );
  const [form, setForm] = useState<StudioForm>({});
  const [fixtures, setFixtures] = useState<StudioFixtureSet>({ valid: [], invalid: [] });
  const [preview, setPreview] = useState<StudioPreview | null>(null);
  const [run, setRun] = useState<StudioFixtureRun | null>(null);

  const previewMutation = useMutation({
    mutationFn: postStudioPreview,
    onSuccess: setPreview,
  });
  const runMutation = useMutation({
    mutationFn: postStudioRunFixtures,
    onSuccess: setRun,
  });
  const applyMutation = useMutation({
    mutationFn: postStudioApply,
    onSuccess(result) {
      setPreview(result.preview);
      setRun(result.run);
      void queryClient.invalidateQueries({ queryKey: [StudioQueryKey.Validators] });
      void queryClient.invalidateQueries({ queryKey: [StudioQueryKey.Snapshot] });
    },
  });

  useEffect(() => {
    if (!selectedFactoryId && factories[0]) setSelectedFactoryId(factories[0].id);
  }, [factories, selectedFactoryId]);

  useEffect(() => {
    if (!selectedFactory) return;
    setForm(formFromDefaults(selectedFactory));
    setFixtures(copyFixtures(selectedFactory.fixtures));
    setPreview(null);
    setRun(null);
  }, [selectedFactory]);

  const request = selectedFactory ? requestFromState(selectedFactory, form, fixtures) : null;
  const canApply = Boolean(request && run?.passed && !applyMutation.isPending);

  function updateField(key: string, value: string | boolean): void {
    setForm((current) => ({ ...current, [key]: value }));
    setPreview(null);
    setRun(null);
  }

  function updateFixture(fixtureCase: keyof StudioFixtureSet, key: "path" | "content", value: string): void {
    setFixtures((current) => ({
      ...current,
      [fixtureCase]: [{ ...(current[fixtureCase][0] ?? { path: "", content: "" }), [key]: value }],
    }));
    setRun(null);
  }

  function resetFixtures(): void {
    if (!selectedFactory) return;
    setFixtures(copyFixtures(selectedFactory.fixtures));
    setRun(null);
  }

  return (
    <section className="studioView" aria-label="Validator Studio">
      <PaneHeader>
        <PaneButton inline onClick={onBack} title="Back to workbench" aria-label="Back to workbench">
          <ArrowLeft size={13} />
        </PaneButton>
        <Wand2 size={13} className="paneIcon" aria-hidden="true" />
        <PaneTitle>Validator Studio</PaneTitle>
        <PaneSubtitle>validator fixtures</PaneSubtitle>
      </PaneHeader>
      <PaneBody className="studioBody">
        {factoriesQuery.isLoading ? <InlineState>Loading validator factories...</InlineState> : null}
        {factoriesQuery.isError ? <InlineState tone="error">{(factoriesQuery.error as Error).message}</InlineState> : null}
        {selectedFactory && request ? (
          <div className="studioGrid">
            <StudioSidebar
              factories={factories}
              validators={validators}
              selectedFactoryId={selectedFactory.id}
              onSelectFactory={setSelectedFactoryId}
              validatorsError={validatorsQuery.error as Error | undefined}
            />
            <StudioEditor
              factory={selectedFactory}
              form={form}
              fixtures={fixtures}
              onFieldChange={updateField}
              onFixtureChange={updateFixture}
              onResetFixtures={resetFixtures}
            />
            <StudioOutput
              request={request}
              preview={preview}
              run={run}
              previewError={previewMutation.error as Error | null}
              runError={runMutation.error as Error | null}
              applyError={applyMutation.error as Error | null}
              isPreviewing={previewMutation.isPending}
              isRunning={runMutation.isPending}
              isApplying={applyMutation.isPending}
              canApply={canApply}
              onPreview={() => previewMutation.mutate(request)}
              onRun={() => runMutation.mutate(request)}
              onApply={() => applyMutation.mutate(request)}
            />
          </div>
        ) : null}
      </PaneBody>
    </section>
  );
}

function StudioSidebar({
  factories,
  validators,
  selectedFactoryId,
  validatorsError,
  onSelectFactory,
}: {
  factories: StudioFactoryDescriptor[];
  validators: StudioValidatorSummary[];
  selectedFactoryId: string;
  validatorsError?: Error;
  onSelectFactory: (id: string) => void;
}) {
  return (
    <aside className="studioSidebar">
      <div className="studioPanelHead">
        <span>Factories</span>
        <span>{factories.length}</span>
      </div>
      <div className="studioFactoryList">
        {factories.map((factory) => (
          <button
            type="button"
            key={factory.id}
            className={cx("studioFactoryRow", factory.id === selectedFactoryId && StudioClassName.Active)}
            onClick={() => onSelectFactory(factory.id)}
          >
            <strong>{factory.label}</strong>
            <span>{factory.summary}</span>
          </button>
        ))}
      </div>
      <div className="studioPanelHead studioPanelHeadSecondary">
        <span>Loaded validators</span>
        <span>{validators.length}</span>
      </div>
      {validatorsError ? <InlineState tone="error">{validatorsError.message}</InlineState> : null}
      <div className="studioValidatorList">
        {validators.map((validator) => (
          <div className="studioValidatorRow" key={validator.id}>
            <div>
              <span className="validatorId">{validator.id}</span>
              <small>{validator.sourcePath ?? "source not mapped"}</small>
            </div>
            <SeverityTag severity={validator.severity as "error" | "warning" | "info"} />
          </div>
        ))}
      </div>
    </aside>
  );
}

function StudioEditor({
  factory,
  form,
  fixtures,
  onFieldChange,
  onFixtureChange,
  onResetFixtures,
}: {
  factory: StudioFactoryDescriptor;
  form: StudioForm;
  fixtures: StudioFixtureSet;
  onFieldChange: (key: string, value: string | boolean) => void;
  onFixtureChange: (fixtureCase: keyof StudioFixtureSet, key: "path" | "content", value: string) => void;
  onResetFixtures: () => void;
}) {
  const fieldGroups = groupedStudioFields(factory.fields);

  return (
    <main className="studioEditorPane">
      <section className={StudioClassName.Section}>
        <div className={StudioClassName.SectionHead}>
          <h2>{factory.label}</h2>
          <span>{factory.summary}</span>
        </div>
        <div className="studioFormGroups">
          {fieldGroups.map((group) => (
            <div className="studioFieldGroup" key={group.id}>
              <div className="studioFieldGroupHead">{group.label}</div>
              {group.fields.map((field) => (
                <StudioField key={field.key} field={field} value={form[field.key]} onChange={(value) => onFieldChange(field.key, value)} />
              ))}
            </div>
          ))}
        </div>
      </section>
      <section className={StudioClassName.Section}>
        <div className={StudioClassName.SectionHead}>
          <h2>Fixtures</h2>
          <span>valid should pass, invalid should report</span>
          <button type="button" className="studioSectionCommand" onClick={onResetFixtures}>
            <RotateCcw size={12} />
            <span>Reset</span>
          </button>
        </div>
        <div className="studioFixtureGrid">
          <FixtureEditor
            title="Valid"
            fixtureCase={StudioFixtureCase.Valid}
            file={fixtures.valid[0] ?? { path: "", content: "" }}
            onChange={onFixtureChange}
          />
          <FixtureEditor
            title="Invalid"
            fixtureCase={StudioFixtureCase.Invalid}
            file={fixtures.invalid[0] ?? { path: "", content: "" }}
            onChange={onFixtureChange}
          />
        </div>
      </section>
    </main>
  );
}

function StudioField({ field, value, onChange }: { field: StudioFieldDescriptor; value: string | boolean | undefined; onChange: (value: string | boolean) => void }) {
  const fieldKey = field.key as StudioOptionValue;
  if (field.kind === StudioFieldKind.Boolean) {
    return <BooleanField field={field} value={Boolean(value)} onChange={onChange} />;
  }
  if (fieldKey === StudioOption.Severity && field.kind === StudioFieldKind.Select) {
    return <SeverityField field={field} value={String(value ?? "")} onChange={onChange} />;
  }
  if (field.kind === StudioFieldKind.Textarea || field.kind === StudioFieldKind.Lines || field.kind === StudioFieldKind.RegexLines) {
    if (field.kind === StudioFieldKind.Textarea) return <TextareaField field={field} value={String(value ?? "")} onChange={onChange} />;
    return <LineListField field={field} value={String(value ?? "")} onChange={onChange} />;
  }
  if (field.kind === StudioFieldKind.Number) {
    return <NumberField field={field} value={String(value ?? "")} onChange={onChange} />;
  }
  if (fieldKey === StudioOption.Id) {
    return <ValidatorIdField field={field} value={String(value ?? "")} onChange={onChange} />;
  }
  if (field.kind === StudioFieldKind.Select) return <SelectField field={field} value={String(value ?? "")} onChange={onChange} />;
  return <TextField field={field} value={String(value ?? "")} onChange={onChange} />;
}

function FieldCaption({ field, meta }: { field: StudioFieldDescriptor; meta?: string }) {
  return (
    <div className="studioFieldCaption">
      <span>
        {field.label}
        {field.required ? <b aria-label="required">*</b> : null}
      </span>
      {meta ? <small>{meta}</small> : null}
    </div>
  );
}

function TextField({ field, value, onChange }: { field: StudioFieldDescriptor; value: string; onChange: (value: string) => void }) {
  return (
    <label className={StudioClassName.Field}>
      <FieldCaption field={field} />
      <input
        type="text"
        value={value}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function ValidatorIdField({ field, value, onChange }: { field: StudioFieldDescriptor; value: string; onChange: (value: string) => void }) {
  const formatted = toKebabCase(value);
  const isValid = value.length === 0 || /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value);

  return (
    <div className={cx(StudioClassName.Field, StudioClassName.FieldWide, !isValid && "studioFieldInvalid")}>
      <FieldCaption field={field} meta="kebab-case" />
      <div className="studioIdControl">
        <input value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />
        <button type="button" disabled={!value || formatted === value} onClick={() => onChange(formatted)}>
          Format
        </button>
      </div>
      <div className="studioFieldFoot">
        <span>validators/{value || "validator-id"}.ts</span>
        {!isValid ? <strong>Use lowercase words separated by hyphens.</strong> : null}
      </div>
    </div>
  );
}

function SelectField({ field, value, onChange }: { field: StudioFieldDescriptor; value: string; onChange: (value: string) => void }) {
  return (
    <label className={StudioClassName.Field}>
      <FieldCaption field={field} />
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {(field.options ?? []).map((option) => (
          <option value={option} key={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function SeverityField({ field, value, onChange }: { field: StudioFieldDescriptor; value: string; onChange: (value: string) => void }) {
  return (
    <div className={StudioClassName.Field}>
      <FieldCaption field={field} />
      <div className="studioSeverityPicker" role="radiogroup" aria-label={field.label}>
        {(field.options ?? [StudioSeverity.Warning, StudioSeverity.Error]).map((option) => {
          const severity = option as StudioSeverity;
          const meta = StudioSeverityMeta[severity] ?? { label: option, detail: "custom" };
          return (
            <button
              type="button"
              key={option}
              role="radio"
              aria-checked={value === option}
              className={cx("studioSeverityOption", `studioSeverity-${option}`, value === option && StudioClassName.Active)}
              onClick={() => onChange(option)}
            >
              <span className="studioSeverityMark" aria-hidden="true" />
              <span>
                <strong>{meta.label}</strong>
                <small>{meta.detail}</small>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NumberField({ field, value, onChange }: { field: StudioFieldDescriptor; value: string; onChange: (value: string) => void }) {
  const numericValue = Number(value);
  const stableValue = Number.isFinite(numericValue) ? numericValue : 0;

  function step(delta: number): void {
    onChange(String(Math.max(0, stableValue + delta)));
  }

  return (
    <div className={StudioClassName.Field}>
      <FieldCaption field={field} />
      <div className="studioNumberControl">
        <button type="button" onClick={() => step(-1)} aria-label={`Decrease ${field.label}`}>
          <Minus size={12} />
        </button>
        <input min={0} step={1} type="number" value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />
        <button type="button" onClick={() => step(1)} aria-label={`Increase ${field.label}`}>
          <Plus size={12} />
        </button>
      </div>
    </div>
  );
}

function BooleanField({ field, value, onChange }: { field: StudioFieldDescriptor; value: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className={cx(StudioClassName.Field, StudioClassName.FieldWide)}>
      <button type="button" className={cx("studioToggle", value && StudioClassName.Active)} aria-pressed={value} onClick={() => onChange(!value)}>
        <span className="studioToggleTrack" aria-hidden="true">
          <span />
        </span>
        <span>{field.label}</span>
      </button>
    </div>
  );
}

function TextareaField({ field, value, onChange }: { field: StudioFieldDescriptor; value: string; onChange: (value: string) => void }) {
  return (
    <label className={cx(StudioClassName.Field, StudioClassName.FieldWide)}>
      <FieldCaption field={field} />
      <textarea rows={field.key === StudioOption.Message ? 3 : 4} value={value} placeholder={field.placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function LineListField({ field, value, onChange }: { field: StudioFieldDescriptor; value: string; onChange: (value: string) => void }) {
  const isRegex = field.kind === StudioFieldKind.RegexLines;
  const lines = fieldLines(value);
  const errors = isRegex
    ? lines
        .map((line) => regexDiagnostic(line.trim()))
        .filter((item): item is string => Boolean(item))
    : [];
  const presets = StudioLinePresets[field.key as StudioOptionValue] ?? [];

  function commitLines(nextLines: string[]): void {
    onChange(nextLines.join("\n"));
  }

  function setLine(index: number, nextValue: string): void {
    commitLines(lines.map((line, lineIndex) => (lineIndex === index ? nextValue : line)));
  }

  function addLine(nextValue = ""): void {
    const trimmedLines = lines.map((line) => line.trim()).filter(Boolean);
    if (nextValue && trimmedLines.includes(nextValue)) return;
    commitLines(nextValue ? [...trimmedLines, nextValue] : [...lines, ""]);
  }

  function removeLine(index: number): void {
    const nextLines = lines.filter((_line, lineIndex) => lineIndex !== index);
    commitLines(nextLines.length > 0 ? nextLines : [""]);
  }

  return (
    <div className={cx(StudioClassName.Field, StudioClassName.FieldWide)}>
      <FieldCaption field={field} meta={isRegex ? "regex list" : "one per row"} />
      <div className="studioLineList">
        {lines.map((line, index) => {
          const error = isRegex ? regexDiagnostic(line.trim()) : null;
          return (
            <div className={cx("studioLineRow", isRegex && "studioRegexLineRow", error && "invalid")} key={`${field.key}-${index}`}>
              {isRegex ? <span className="studioLineFence">/</span> : null}
              <input
                value={line}
                placeholder={index === 0 ? field.placeholder : undefined}
                onChange={(event) => setLine(index, event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addLine();
                  }
                }}
              />
              {isRegex ? <span className="studioLineFence">/</span> : null}
              <button type="button" onClick={() => removeLine(index)} aria-label={`Remove ${field.label} row`}>
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="studioLineActions">
        <button type="button" onClick={() => addLine()}>
          <Plus size={12} />
          <span>Add row</span>
        </button>
        {presets.map((preset) => (
          <button type="button" key={preset} disabled={lines.map((line) => line.trim()).includes(preset)} onClick={() => addLine(preset)}>
            {preset}
          </button>
        ))}
      </div>
      {errors.length > 0 ? <div className="studioFieldError">{errors[0]}</div> : null}
    </div>
  );
}

function FixtureEditor({
  title,
  fixtureCase,
  file,
  onChange,
}: {
  title: string;
  fixtureCase: keyof StudioFixtureSet;
  file: { path: string; content: string };
  onChange: (fixtureCase: keyof StudioFixtureSet, key: "path" | "content", value: string) => void;
}) {
  return (
    <div className={cx("studioFixtureEditor", fixtureCase === StudioFixtureCase.Valid ? StudioClassName.FixtureValid : StudioClassName.FixtureInvalid)}>
      <div className="studioFixtureHead">
        <FlaskConical size={13} />
        <span>{title}</span>
      </div>
      <label className="studioFixtureField">
        <span>Path</span>
        <input value={file.path} onChange={(event) => onChange(fixtureCase, "path", event.target.value)} aria-label={`${title} fixture path`} />
      </label>
      <label className="studioFixtureField studioFixtureContentField">
        <span>Content</span>
        <textarea rows={10} value={file.content} onChange={(event) => onChange(fixtureCase, "content", event.target.value)} aria-label={`${title} fixture content`} />
      </label>
    </div>
  );
}

function StudioOutput({
  request,
  preview,
  run,
  previewError,
  runError,
  applyError,
  isPreviewing,
  isRunning,
  isApplying,
  canApply,
  onPreview,
  onRun,
  onApply,
}: {
  request: StudioRequest;
  preview: StudioPreview | null;
  run: StudioFixtureRun | null;
  previewError: Error | null;
  runError: Error | null;
  applyError: Error | null;
  isPreviewing: boolean;
  isRunning: boolean;
  isApplying: boolean;
  canApply: boolean;
  onPreview: () => void;
  onRun: () => void;
  onApply: () => void;
}) {
  return (
    <aside className="studioOutputPane">
      <div className="studioActions">
        <PaneButton inline className="settingsSaveButton" disabled={isPreviewing} onClick={onPreview}>
          <Wand2 size={13} />
          <span>{isPreviewing ? "Previewing" : "Preview"}</span>
        </PaneButton>
        <PaneButton inline className="settingsSaveButton" disabled={isRunning} onClick={onRun}>
          <Play size={13} />
          <span>{isRunning ? "Running" : "Run"}</span>
        </PaneButton>
        <PaneButton inline className="settingsSaveButton studioApplyButton" disabled={!canApply || isApplying} onClick={onApply}>
          <Save size={13} />
          <span>{isApplying ? "Applying" : "Apply"}</span>
        </PaneButton>
      </div>
      {previewError ? <InlineState tone="error">{previewError.message}</InlineState> : null}
      {runError ? <InlineState tone="error">{runError.message}</InlineState> : null}
      {applyError ? <InlineState tone="error">{applyError.message}</InlineState> : null}
      <section className={StudioClassName.Section}>
        <div className={StudioClassName.SectionHead}>
          <h2>Run Gate</h2>
          <span>{request.factoryId}</span>
        </div>
        <GateState run={run} />
        {run ? <RunResult run={run} /> : <InlineState padded={false}>Run fixtures before applying.</InlineState>}
      </section>
      <section className={cx(StudioClassName.Section, "studioPreviewSection")}>
        <div className={StudioClassName.SectionHead}>
          <h2>Preview</h2>
          <span>{preview?.validatorPath ?? "not generated"}</span>
        </div>
        <pre className="studioSourcePreview">{preview?.source ?? "Preview the validator source before applying."}</pre>
      </section>
    </aside>
  );
}

function GateState({ run }: { run: StudioFixtureRun | null }) {
  if (!run) {
    return (
      <div className="studioGateState">
        <FlaskConical size={13} />
        <span>Awaiting fixture run</span>
      </div>
    );
  }
  const Icon = run.passed ? CheckCircle2 : XCircle;
  return (
    <div className={cx("studioGateState", run.passed ? StudioClassName.ResultPassed : StudioClassName.ResultFailed)}>
      <Icon size={13} />
      <span>{run.passed ? "Ready to apply" : "Needs fixture changes"}</span>
    </div>
  );
}

function RunResult({ run }: { run: StudioFixtureRun }) {
  return (
    <div className="studioRunResults">
      {run.cases.map((item) => {
        const Icon = item.passed ? CheckCircle2 : XCircle;
        return (
          <div className={cx("studioRunCase", item.passed ? StudioClassName.ResultPassed : StudioClassName.ResultFailed)} key={item.case}>
            <Icon size={14} />
            <div>
              <strong>{item.case}</strong>
              <span>{item.findings.length} findings</span>
              {item.details.map((detail) => (
                <small key={detail}>{detail}</small>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
