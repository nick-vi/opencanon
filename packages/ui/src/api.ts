import type {
  ApiResponse,
  FileResponse,
  Finding,
  GitDiffResponse,
  GitHistoryResponse,
  ProjectConfig,
  ProjectSettings,
  ProjectSummary,
  Snapshot,
  StudioApplyResult,
  StudioFactoryDescriptor,
  StudioFixtureRun,
  StudioPreview,
  StudioRequest,
  StudioValidatorSummary,
  TreeResponse,
  TreeScope,
} from "./types.ts";

const HttpHeaderValue = {
  Json: "application/json; charset=utf-8",
} as const;

const DaemonStreamRetryMs = 2000;

export type DaemonEventStream = {
  close(): void;
};

export type DaemonEventStreamHandlers = {
  onOpen(): void;
  onError(): void;
  onEvent(type: string, data: string): void;
};

async function unwrap<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) {
    throw new Error(payload.diagnostics.map((d) => d.message).join("\n") || "Request failed.");
  }
  return payload.data;
}

export async function fetchSnapshot(): Promise<Snapshot> {
  return unwrap<Snapshot>(await apiFetch("/api/snapshot"));
}

export async function fetchRegistryProjects(): Promise<ProjectSummary[]> {
  return unwrap<ProjectSummary[]>(await apiFetch("/api/supervisor/projects"));
}

export async function fetchProjectSettings(): Promise<ProjectSettings> {
  return unwrap<ProjectSettings>(await apiFetch("/api/settings"));
}

export async function postProjectSettings(overrides: ProjectConfig): Promise<ProjectSettings> {
  return unwrap<ProjectSettings>(
    await apiFetch("/api/settings", {
      method: "POST",
      headers: { "content-type": HttpHeaderValue.Json },
      body: JSON.stringify({ overrides }),
    }),
  );
}

export async function fetchStudioFactories(): Promise<StudioFactoryDescriptor[]> {
  return unwrap<StudioFactoryDescriptor[]>(await apiFetch("/api/studio/factories"));
}

export async function fetchStudioValidators(): Promise<StudioValidatorSummary[]> {
  return unwrap<StudioValidatorSummary[]>(await apiFetch("/api/studio/validators"));
}

export async function postStudioPreview(request: StudioRequest): Promise<StudioPreview> {
  return postStudio<StudioPreview>("/api/studio/validators/preview", request);
}

export async function postStudioRunFixtures(request: StudioRequest): Promise<StudioFixtureRun> {
  return postStudio<StudioFixtureRun>("/api/studio/validators/run-fixtures", request);
}

export async function postStudioApply(request: StudioRequest): Promise<StudioApplyResult> {
  return postStudio<StudioApplyResult>("/api/studio/validators/apply", request);
}

export async function fetchTree({
  dirPath,
  query = "",
  scope = "all",
  showDotEntries = true,
}: {
  dirPath: string;
  query?: string;
  scope?: TreeScope;
  showDotEntries?: boolean;
}): Promise<TreeResponse> {
  const params = new URLSearchParams();
  params.set("path", dirPath);
  params.set("scope", scope);
  if (query.trim()) params.set("query", query.trim());
  if (!showDotEntries) params.set("dot", "0");
  const url = `/api/fs/tree?${params.toString()}`;
  return unwrap<TreeResponse>(await apiFetch(url));
}

export async function fetchFile(filePath: string): Promise<FileResponse> {
  const url = `/api/fs/file?path=${encodeURIComponent(filePath)}`;
  const response = await apiFetch(url);
  const payload = (await response.json()) as ApiResponse<FileResponse>;
  if (!payload.ok) {
    const message = payload.diagnostics.map((d) => d.message).join("\n");
    const error = new Error(message || "File request failed.");
    (error as Error & { status?: number }).status = response.status;
    throw error;
  }
  return payload.data;
}

export async function fetchFindings(filePath: string): Promise<Finding[]> {
  const url = `/api/findings?file=${encodeURIComponent(filePath)}`;
  return unwrap<Finding[]>(await apiFetch(url));
}

export async function fetchGitHistory(filePath: string, limit = 8): Promise<GitHistoryResponse> {
  const params = new URLSearchParams();
  params.append("file", filePath);
  params.set("limit", String(limit));
  return unwrap<GitHistoryResponse>(await apiFetch(`/api/git/history?${params.toString()}`));
}

export async function fetchGitDiff(filePath: string, commit: string): Promise<GitDiffResponse> {
  const params = new URLSearchParams();
  params.set("file", filePath);
  params.set("commit", commit);
  const data = await unwrap<unknown>(await apiFetch(`/api/git/diff?${params.toString()}`));
  if (!isGitDiffResponse(data)) throw new Error("Daemon returned an invalid diff payload. Restart the OpenCanon daemon.");
  return data;
}

export async function postReindex(): Promise<Snapshot> {
  return unwrap<Snapshot>(await apiFetch("/api/index", { method: "POST" }));
}

async function postStudio<T>(url: string, request: StudioRequest): Promise<T> {
  return unwrap<T>(
    await apiFetch(url, {
      method: "POST",
      headers: { "content-type": HttpHeaderValue.Json },
      body: JSON.stringify(request),
    }),
  );
}

function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(input, init);
}

export function openDaemonEventStream(handlers: DaemonEventStreamHandlers): DaemonEventStream {
  let closed = false;
  let retryTimer: number | undefined;
  let controller: AbortController | undefined;

  const connect = () => {
    controller = new AbortController();
    void readDaemonEventStream(controller.signal, handlers).then(
      () => {
        if (!closed) retryTimer = window.setTimeout(connect, DaemonStreamRetryMs);
      },
      () => {
        if (closed) return;
        handlers.onError();
        retryTimer = window.setTimeout(connect, DaemonStreamRetryMs);
      },
    );
  };

  connect();

  return {
    close() {
      closed = true;
      controller?.abort();
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    },
  };
}

async function readDaemonEventStream(signal: AbortSignal, handlers: DaemonEventStreamHandlers): Promise<void> {
  const response = await apiFetch("/api/events/stream", { signal });
  if (!response.ok || !response.body) throw new Error("Daemon event stream is unavailable.");
  handlers.onOpen();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const event = { type: "message", data: [] as string[] };
  let buffer = "";

  const dispatch = () => {
    if (event.data.length === 0) return;
    handlers.onEvent(event.type, event.data.join("\n"));
    event.type = "message";
    event.data = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) processDaemonEventLine(line, event, dispatch);
  }

  if (buffer.length > 0) processDaemonEventLine(buffer, event, dispatch);
  dispatch();
}

function processDaemonEventLine(line: string, event: { type: string; data: string[] }, dispatch: () => void): void {
  if (line === "") {
    dispatch();
    return;
  }
  if (line.startsWith("event:")) event.type = line.slice("event:".length).trim();
  if (line.startsWith("data:")) event.data.push(line.slice("data:".length).trimStart());
}

function isGitDiffResponse(value: unknown): value is GitDiffResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GitDiffResponse>;
  return (
    (typeof candidate.gitRoot === "string" || candidate.gitRoot === null) &&
    typeof candidate.file === "string" &&
    typeof candidate.commit === "string" &&
    typeof candidate.beforeContent === "string" &&
    typeof candidate.afterContent === "string" &&
    Array.isArray(candidate.diagnostics) &&
    candidate.diagnostics.every((diagnostic) => typeof diagnostic === "string")
  );
}
