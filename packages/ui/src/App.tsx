import { useCallback, useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderGit2, MoreHorizontal, RefreshCw, Server, SlidersHorizontal, Wand2 } from "lucide-react";
import { fetchSnapshot, openDaemonEventStream, postReindex } from "./api.ts";
import { IconButton, StatusTag } from "./components/ui.tsx";
import { OpenCanonMark } from "./OpenCanonMark.tsx";
import { Registry } from "./Registry.tsx";
import { Settings } from "./Settings.tsx";
import { ValidatorStudio } from "./ValidatorStudio.tsx";
import { Workbench } from "./Workbench.tsx";
import type { DaemonStreamEvent, ProjectSummary, Snapshot } from "./types.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

const viewKind = {
  registry: "registry",
  settings: "settings",
  studio: "studio",
  workbench: "workbench",
} as const;
type ViewKind = (typeof viewKind)[keyof typeof viewKind];

const AppClassName = {
  Grow: "grow",
  Spin: "spin",
} as const;

const AppStatus = {
  Error: "error",
  Failed: "failed",
  Loading: "loading",
  Ready: "ready",
  Running: "running",
} as const;

const DaemonStreamType = {
  Error: "error",
  Indexing: "indexing",
  Snapshot: "snapshot",
} as const;

const LiveStatus = {
  Connected: "connected",
  Connecting: "connecting",
  Error: "error",
  Updating: "updating",
} as const;
type LiveStatus = (typeof LiveStatus)[keyof typeof LiveStatus];

const QueryKey = {
  FindingsFile: "findings.file",
  FsFile: "fs.file",
  FsTree: "fs.tree",
  GitDiff: "git.diff",
  GitHistory: "git.history",
  Snapshot: "snapshot",
} as const;

const DomEventName = {
  Keydown: "keydown",
} as const;

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
    </QueryClientProvider>
  );
}

function Shell() {
  const [view, setView] = useState<ViewKind>(initialView());
  const [selectedFile, setSelectedFile] = useState<string | null>(initialFile());
  const [liveStatus, setLiveStatus] = useState<LiveStatus>(LiveStatus.Connecting);
  const queryClientLocal = useQueryClient();

  useEffect(() => {
    const handler = () => {
      setView(initialView());
      setSelectedFile(initialFile());
    };
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const updateUrl = useCallback((next: { view: ViewKind; file: string | null }) => {
    const params = new URLSearchParams();
    if (next.view !== viewKind.workbench) params.set("view", next.view);
    if (next.file) params.set("file", next.file);
    const query = params.toString();
    const target = `${window.location.pathname}${query ? `?${query}` : ""}`;
    window.history.pushState(null, "", target);
  }, []);

  const handleSelectFile = useCallback(
    (path: string) => {
      setSelectedFile(path);
      setView(viewKind.workbench);
      updateUrl({ view: viewKind.workbench, file: path });
    },
    [updateUrl],
  );

  const handleOpenProject = useCallback(
    (project: ProjectSummary) => {
      if (project.url && project.url !== window.location.origin) {
        window.location.assign(project.url);
        return;
      }
      setView(viewKind.workbench);
      updateUrl({ view: viewKind.workbench, file: selectedFile });
    },
    [selectedFile, updateUrl],
  );

  const handleSelectView = useCallback(
    (next: ViewKind) => {
      setView(next);
      updateUrl({ view: next, file: next === viewKind.workbench ? selectedFile : null });
    },
    [selectedFile, updateUrl],
  );

  useDaemonEventStream(queryClientLocal, setLiveStatus);

  const snapshotQuery = useQuery<Snapshot>({ queryKey: [QueryKey.Snapshot], queryFn: fetchSnapshot });

  return (
    <div className="appShell">
      <div className="main">
        <TopBar
          view={view}
          snapshot={snapshotQuery.data}
          isFetching={snapshotQuery.isFetching}
          error={snapshotQuery.error as Error | undefined}
          onRefresh={() => void snapshotQuery.refetch()}
          onSelectView={handleSelectView}
        />
        <div className="content">
          {view === viewKind.registry ? (
            <Registry onOpenProject={handleOpenProject} onBack={() => handleSelectView(viewKind.workbench)} />
          ) : view === viewKind.settings ? (
            <Settings onBack={() => handleSelectView(viewKind.workbench)} />
          ) : view === viewKind.studio ? (
            <ValidatorStudio onBack={() => handleSelectView(viewKind.workbench)} />
          ) : (
            <Workbench
              selectedFile={selectedFile}
              onSelectFile={handleSelectFile}
              onOpenStudio={() => handleSelectView(viewKind.studio)}
              snapshot={snapshotQuery.data}
              snapshotIsLoading={snapshotQuery.isLoading}
              snapshotError={snapshotQuery.error as Error | undefined}
            />
          )}
        </div>
        <StatusBar snapshot={snapshotQuery.data} liveStatus={liveStatus} />
      </div>
    </div>
  );
}

function useDaemonEventStream(queryClientLocal: QueryClient, setLiveStatus: (status: LiveStatus) => void): void {
  useEffect(() => {
    const source = openDaemonEventStream({
      onOpen: () => setLiveStatus(LiveStatus.Connected),
      onError: () => setLiveStatus(LiveStatus.Error),
      onEvent: (type, data) => {
        if (type === DaemonStreamType.Indexing) setLiveStatus(LiveStatus.Updating);
        if (type === DaemonStreamType.Error) setLiveStatus(LiveStatus.Error);
        if (type !== DaemonStreamType.Snapshot) return;
        const event = parseDaemonStreamEvent(data);
        if (event.snapshot) queryClientLocal.setQueryData([QueryKey.Snapshot], event.snapshot);
        void queryClientLocal.invalidateQueries({ queryKey: [QueryKey.FsTree] });
        void queryClientLocal.invalidateQueries({ queryKey: [QueryKey.FsFile] });
        void queryClientLocal.invalidateQueries({ queryKey: [QueryKey.FindingsFile] });
        void queryClientLocal.invalidateQueries({ queryKey: [QueryKey.GitDiff] });
        void queryClientLocal.invalidateQueries({ queryKey: [QueryKey.GitHistory] });
        setLiveStatus(LiveStatus.Connected);
      },
    });

    return () => source.close();
  }, [queryClientLocal, setLiveStatus]);
}

function parseDaemonStreamEvent(data: string): DaemonStreamEvent {
  return JSON.parse(data) as DaemonStreamEvent;
}

function TopBar({
  view,
  snapshot,
  isFetching,
  error,
  onRefresh,
  onSelectView,
}: {
  view: ViewKind;
  snapshot?: Snapshot;
  isFetching: boolean;
  error?: Error;
  onRefresh: () => void;
  onSelectView: (next: ViewKind) => void;
}) {
  const queryClientLocal = useQueryClient();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const status = snapshot?.health.status ?? (error ? AppStatus.Error : AppStatus.Loading);
  const rootDir = snapshot?.graph.rootDir ?? "";
  const projectName = rootDir ? rootDir.split("/").filter(Boolean).pop() || rootDir : "loading";
  const handleReindex = async () => {
    setMenuOpen(false);
    await postReindex();
    await queryClientLocal.invalidateQueries();
  };
  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) setMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener(DomEventName.Keydown, handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener(DomEventName.Keydown, handleKeyDown);
    };
  }, [menuOpen]);
  const selectMenuView = (next: ViewKind) => {
    setMenuOpen(false);
    onSelectView(next);
  };
  return (
    <header className="topBar">
      <div className="topIdentity">
        <span className="topBrand" aria-hidden="true">
          <OpenCanonMark size={24} />
        </span>
        <span className="topProject" title={rootDir || undefined}>{projectName}</span>
        {rootDir ? <span className="topRoot mono" title={rootDir}>{rootDir}</span> : null}
      </div>
      <div className="topState">
        <StatusTag status={statusKey(status)} label={status} />
      </div>
      <div className="topActions">
        <IconButton className="topCommand" square onClick={onRefresh} title="Refresh" aria-label="Refresh" disabled={isFetching}>
          <RefreshCw size={13} className={isFetching ? AppClassName.Spin : ""} />
        </IconButton>
        <div className="topMenuRoot" ref={menuRef}>
          <IconButton
            className="topCommand"
            square
            active={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            title="Project menu"
            aria-label="Project menu"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
          >
            <MoreHorizontal size={13} />
          </IconButton>
          {menuOpen ? (
            <div className="topMenuPanel" role="menu" aria-label="Project actions">
              {view !== viewKind.workbench ? (
                <button type="button" className="topMenuItem" role="menuitem" onClick={() => selectMenuView(viewKind.workbench)}>
                  <FolderGit2 size={14} />
                  <span>
                    <strong>Workbench</strong>
                    <small>Return to the current project</small>
                  </span>
                </button>
              ) : null}
              <button type="button" className="topMenuItem" role="menuitem" onClick={() => selectMenuView(viewKind.settings)}>
                <SlidersHorizontal size={14} />
                <span>
                  <strong>Project settings</strong>
                  <small>Edit opencanon.config.json</small>
                </span>
              </button>
              <button type="button" className="topMenuItem" role="menuitem" onClick={() => selectMenuView(viewKind.studio)}>
                <Wand2 size={14} />
                <span>
                  <strong>Validator Studio</strong>
                  <small>Create rules with fixtures</small>
                </span>
              </button>
              <button type="button" className="topMenuItem" role="menuitem" onClick={() => selectMenuView(viewKind.registry)}>
                <Server size={14} />
                <span>
                  <strong>Project switcher</strong>
                  <small>Open running daemon list</small>
                </span>
              </button>
              <button type="button" className="topMenuItem" role="menuitem" onClick={() => void handleReindex()}>
                <RefreshCw size={14} />
                <span>
                  <strong>Rebuild index</strong>
                  <small>Force a fresh daemon snapshot</small>
                </span>
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function StatusBar({ snapshot, liveStatus }: { snapshot?: Snapshot; liveStatus: LiveStatus }) {
  const validators = snapshot?.validators.length ?? 0;
  const impactSurfaces = snapshot?.impactSurfaces.length ?? 0;
  const cacheTotal = snapshot ? snapshot.state.cacheHits + snapshot.state.cacheMisses : 0;
  const cacheRate = snapshot && cacheTotal > 0 ? `${Math.round((snapshot.state.cacheHits / cacheTotal) * 100)}%` : "n/a";
  return (
    <footer className="statusBar">
      <span className={`statusLive live-${liveStatus}`}>live: {liveStatus}</span>
      <span>health: {snapshot?.health.status ?? "n/a"}</span>
      <span>canon files: {snapshot?.state.files ?? "n/a"}</span>
      <span>findings: {snapshot?.state.findings ?? "n/a"}</span>
      <span>impact: {impactSurfaces}</span>
      <span>cache: {cacheRate}</span>
      <span>validators: {validators}</span>
      <span className={AppClassName.Grow} />
      <span>started: {snapshot?.health.startedAt ? formatTime(snapshot.health.startedAt) : "n/a"}</span>
    </footer>
  );
}

function statusKey(status: string): string {
  if (status === AppStatus.Ready || status === AppStatus.Running) return AppStatus.Running;
  if (status === AppStatus.Failed || status === AppStatus.Error) return AppStatus.Error;
  if (status === AppStatus.Loading) return AppStatus.Loading;
  return status;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleTimeString();
}

function initialView(): ViewKind {
  const params = new URLSearchParams(window.location.search);
  const value = params.get("view");
  if (value === viewKind.settings) return viewKind.settings;
  if (value === viewKind.studio) return viewKind.studio;
  return value === viewKind.registry ? viewKind.registry : viewKind.workbench;
}

function initialFile(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get("file");
}
