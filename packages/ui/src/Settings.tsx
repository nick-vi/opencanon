import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, Save, SlidersHorizontal } from "lucide-react";
import { fetchProjectSettings, postProjectSettings } from "./api.ts";
import { cx, InlineState, PaneBody, PaneButton, PaneHeader, PaneSubtitle, PaneTitle } from "./components/ui.tsx";
import type { ProjectConfig, ProjectSettings } from "./types.ts";

const SettingsQueryKey = {
  FsTree: "fs.tree",
  Settings: "settings",
  Snapshot: "snapshot",
} as const;

const SettingsClassName = {
  Field: "settingsField",
  FieldFull: "settingsFieldFull",
  SaveButton: "settingsSaveButton",
  Spin: "spin",
} as const;

const SettingsField = {
  FileDiscovery: "fileDiscovery",
} as const;

const SettingsApiError = {
  MissingRoute: "Unknown daemon route: /api/settings",
} as const;

type SettingsForm = {
  docsDir: string;
  decisionsPath: string;
  validatorsPath: string;
  fixturesDir: string;
  impactSurfacesPath: string;
  proposedImpactNotesPath: string;
  baselinePath: string;
  commitApprovalsPath: string;
  commitApprovalsPersistent: boolean;
  cacheDir: string;
  projectFilePatterns: string;
  ignore: string;
  entrypoints: string;
  publicSurfaces: string;
  generated: string;
  externalTools: string;
  requiredPackageScripts: string;
  [SettingsField.FileDiscovery]: ProjectConfig["fileDiscovery"];
  maxFiles: string;
  maxFileSizeKb: string;
};

type Props = {
  onBack: () => void;
};

export function Settings({ onBack }: Props) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: [SettingsQueryKey.Settings], queryFn: fetchProjectSettings });
  const [form, setForm] = useState<SettingsForm | null>(null);
  const mutation = useMutation({
    mutationFn: postProjectSettings,
    onSuccess(settings) {
      setForm(settingsToForm(settings.effective));
      queryClient.setQueryData([SettingsQueryKey.Settings], settings);
      void queryClient.invalidateQueries({ queryKey: [SettingsQueryKey.Snapshot] });
      void queryClient.invalidateQueries({ queryKey: [SettingsQueryKey.FsTree] });
    },
  });

  useEffect(() => {
    if (query.data) setForm(settingsToForm(query.data.effective));
  }, [query.data]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form) return;
    mutation.mutate(formToConfig(form));
  };

  const settings = query.data;
  return (
    <form className="settingsView" aria-label="Project settings" onSubmit={handleSubmit}>
      <PaneHeader>
        <PaneButton inline onClick={onBack} title="Back to workbench" aria-label="Back to workbench">
          <ArrowLeft size={13} />
        </PaneButton>
        <SlidersHorizontal size={13} className="paneIcon" aria-hidden="true" />
        <PaneTitle>Project settings</PaneTitle>
        <PaneSubtitle>{settings?.configPath ?? "opencanon.config.json"}</PaneSubtitle>
        <span className="grow" />
        <PaneButton inline onClick={() => void query.refetch()} title="Reload settings" aria-label="Reload settings" disabled={query.isFetching}>
          <RefreshCw size={13} className={query.isFetching ? SettingsClassName.Spin : ""} />
        </PaneButton>
        <PaneButton inline className={SettingsClassName.SaveButton} type="submit" disabled={!form || mutation.isPending}>
          <Save size={13} />
          <span>{mutation.isPending ? "Saving" : "Save"}</span>
        </PaneButton>
      </PaneHeader>
      <PaneBody scroll className="settingsBody">
        {query.isLoading ? <InlineState>Loading settings...</InlineState> : null}
        {query.isError ? <InlineState tone="error">{settingsErrorMessage(query.error as Error)}</InlineState> : null}
        {mutation.isError ? <InlineState tone="error">{settingsErrorMessage(mutation.error as Error)}</InlineState> : null}
        {settings && settings.diagnostics.length > 0 ? (
          <InlineState tone="error" className="settingsDiagnostics">
            {settings.diagnostics.map((diagnostic) => (
              <div key={diagnostic}>{diagnostic}</div>
            ))}
          </InlineState>
        ) : null}
        {settings && form ? <SettingsEditor settings={settings} form={form} onChange={setForm} /> : null}
      </PaneBody>
    </form>
  );
}

function SettingsEditor({
  settings,
  form,
  onChange,
}: {
  settings: ProjectSettings;
  form: SettingsForm;
  onChange: (form: SettingsForm) => void;
}) {
  const setField = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]) => onChange({ ...form, [key]: value });
  return (
    <div className="settingsEditor">
      <div className="settingsMeta">
        <span className="mono">{settings.rootDir}</span>
        <span>{settings.hasConfig ? "config loaded" : "using defaults"}</span>
      </div>
      <section className="settingsSection">
        <div className="settingsSectionHead">
          <h2>Discovery</h2>
          <span>index scope, scan mode, size limits</span>
        </div>
        <div className="settingsGrid">
          <label className={SettingsClassName.Field}>
            <span>File discovery</span>
            <select
              value={form[SettingsField.FileDiscovery]}
              onChange={(event) => setField(SettingsField.FileDiscovery, event.target.value as ProjectConfig["fileDiscovery"])}
            >
              <option value="git">git</option>
              <option value="filesystem">filesystem</option>
            </select>
          </label>
          <label className={SettingsClassName.Field}>
            <span>Max files</span>
            <input type="number" min={0} value={form.maxFiles} onChange={(event) => setField("maxFiles", event.target.value)} />
          </label>
          <label className={SettingsClassName.Field}>
            <span>Max file size KB</span>
            <input type="number" min={0} value={form.maxFileSizeKb} onChange={(event) => setField("maxFileSizeKb", event.target.value)} />
          </label>
        </div>
        <div className="settingsGrid settingsGridWide">
          <label className={SettingsClassName.Field}>
            <span>Project file patterns</span>
            <textarea rows={5} value={form.projectFilePatterns} onChange={(event) => setField("projectFilePatterns", event.target.value)} />
          </label>
          <label className={SettingsClassName.Field}>
            <span>Ignore</span>
            <textarea rows={5} value={form.ignore} onChange={(event) => setField("ignore", event.target.value)} />
          </label>
        </div>
      </section>
      <section className="settingsSection">
        <div className="settingsSectionHead">
          <h2>Convention Sources</h2>
          <span>docs, decisions, validators, fixtures</span>
        </div>
        <div className="settingsGrid">
          <TextField label="Docs directory" value={form.docsDir} onChange={(value) => setField("docsDir", value)} />
          <TextField label="Decisions path" value={form.decisionsPath} onChange={(value) => setField("decisionsPath", value)} />
          <TextField label="Validators path" value={form.validatorsPath} onChange={(value) => setField("validatorsPath", value)} />
          <TextField label="Fixtures directory" value={form.fixturesDir} onChange={(value) => setField("fixturesDir", value)} />
          <TextField label="Impact surfaces path" value={form.impactSurfacesPath} onChange={(value) => setField("impactSurfacesPath", value)} />
          <TextField label="Proposed impact notes path" value={form.proposedImpactNotesPath} onChange={(value) => setField("proposedImpactNotesPath", value)} />
          <TextField label="Baseline path" value={form.baselinePath} onChange={(value) => setField("baselinePath", value)} />
          <TextField label="Commit approvals path" value={form.commitApprovalsPath} onChange={(value) => setField("commitApprovalsPath", value)} />
          <TextField label="Cache directory" value={form.cacheDir} onChange={(value) => setField("cacheDir", value)} />
          <label className={SettingsClassName.Field}>
            <span>Persistent commit approvals</span>
            <input type="checkbox" checked={form.commitApprovalsPersistent} onChange={(event) => setField("commitApprovalsPersistent", event.target.checked)} />
          </label>
        </div>
        <div className="settingsGrid">
          <label className={SettingsClassName.Field}>
            <span>Entrypoints</span>
            <textarea rows={3} value={form.entrypoints} onChange={(event) => setField("entrypoints", event.target.value)} />
          </label>
          <label className={SettingsClassName.Field}>
            <span>Public surfaces</span>
            <textarea rows={3} value={form.publicSurfaces} onChange={(event) => setField("publicSurfaces", event.target.value)} />
          </label>
          <label className={SettingsClassName.Field}>
            <span>Generated</span>
            <textarea rows={3} value={form.generated} onChange={(event) => setField("generated", event.target.value)} />
          </label>
        </div>
        <label className={cx(SettingsClassName.Field, SettingsClassName.FieldFull)}>
          <span>External tools JSON</span>
          <textarea rows={3} value={form.externalTools} onChange={(event) => setField("externalTools", event.target.value)} />
        </label>
        <label className={cx(SettingsClassName.Field, SettingsClassName.FieldFull)}>
          <span>Required package scripts</span>
          <textarea rows={3} value={form.requiredPackageScripts} onChange={(event) => setField("requiredPackageScripts", event.target.value)} />
        </label>
      </section>
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className={SettingsClassName.Field}>
      <span>{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function settingsToForm(config: ProjectConfig): SettingsForm {
  return {
    docsDir: config.docsDir,
    decisionsPath: config.decisionsPath,
    validatorsPath: config.validatorsPath,
    fixturesDir: config.fixturesDir,
    impactSurfacesPath: config.impactSurfacesPath,
    proposedImpactNotesPath: config.proposedImpactNotesPath,
    baselinePath: config.baselinePath,
    commitApprovalsPath: config.commitApprovalsPath,
    commitApprovalsPersistent: config.commitApprovalsPersistent,
    cacheDir: config.cacheDir,
    projectFilePatterns: config.projectFilePatterns.join("\n"),
    ignore: config.ignore.join("\n"),
    entrypoints: config.entrypoints.join("\n"),
    publicSurfaces: config.publicSurfaces.join("\n"),
    generated: config.generated.join("\n"),
    externalTools: JSON.stringify(config.externalTools, null, 2),
    requiredPackageScripts: config.requiredPackageScripts.join("\n"),
    [SettingsField.FileDiscovery]: config.fileDiscovery,
    maxFiles: String(config.maxFiles),
    maxFileSizeKb: String(config.maxFileSizeKb),
  };
}

function formToConfig(form: SettingsForm): ProjectConfig {
  return {
    docsDir: form.docsDir,
    decisionsPath: form.decisionsPath,
    validatorsPath: form.validatorsPath,
    fixturesDir: form.fixturesDir,
    impactSurfacesPath: form.impactSurfacesPath,
    proposedImpactNotesPath: form.proposedImpactNotesPath,
    baselinePath: form.baselinePath,
    commitApprovalsPath: form.commitApprovalsPath,
    commitApprovalsPersistent: form.commitApprovalsPersistent,
    cacheDir: form.cacheDir,
    projectFilePatterns: splitLines(form.projectFilePatterns),
    ignore: splitLines(form.ignore),
    entrypoints: splitLines(form.entrypoints),
    publicSurfaces: splitLines(form.publicSurfaces),
    generated: splitLines(form.generated),
    externalTools: parseExternalTools(form.externalTools),
    requiredPackageScripts: splitLines(form.requiredPackageScripts),
    fileDiscovery: form[SettingsField.FileDiscovery],
    maxFiles: Number(form.maxFiles),
    maxFileSizeKb: Number(form.maxFileSizeKb),
  };
}

function parseExternalTools(value: string): Record<string, string | string[]> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string | string[]>) : {};
  } catch {
    return {};
  }
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function settingsErrorMessage(error: Error): string {
  if (error.message.includes(SettingsApiError.MissingRoute)) {
    return "The running daemon does not expose project settings yet. Restart the OpenCanon daemon so the rebuilt runtime is serving this UI.";
  }
  return error.message;
}
