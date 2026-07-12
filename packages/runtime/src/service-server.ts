import { RuntimeProjectSummarySchema, createOpenCanonProblem, OpenCanonProblemCode, OpenCanonProblemSource } from "@opencanon/core";
import { assertSafeRuntimeHost, createRuntimeAuthToken, isAuthorizedRuntimeRequest, usableRuntimeAuthToken } from "./auth.ts";
import { localPipeEndpoint, localProtocolEndpointFromEntry, localProtocolTransport, requestLocalJson, serveLocalProtocolPipe } from "./local-protocol.ts";
import { formatHttpBaseUrl } from "./runtime.ts";
import { ApiRoute } from "./routes.ts";
import { discoverOpenCanonProject } from "./service-discovery.ts";
import { openCanonRuntimeVersion, createProcessLeaseId } from "./service-identity.ts";
import { buildServiceOverview, invokeServiceAction } from "./service-overview.ts";
import { reconcileProjectRuntimes } from "./service-reconcile.ts";
import { setupOpenCanonProject } from "./service-process.ts";
import {
  booleanBodyValue,
  numberBodyValue,
  optionalPortBodyValue,
  projectNotFoundProblem,
  proxyRuntimeEventStream,
  readServiceJsonObject,
  recentProjectsBodyValue,
  runtimeUnavailableProblem,
  serveService,
  serviceDiagnostic,
  serviceJson,
  serviceProblem,
  serviceRequestMethod,
  stringArrayBodyValue,
  stringBodyValue,
  stringRecordBodyValue,
} from "./service-http.ts";
import { startProjectRuntime } from "./service-start.ts";
import { serviceRegistryPath } from "./service-storage.ts";
import { stopProjectRuntime } from "./service-control.ts";
import {
  LocalControlProtocolVersion,
  ProcessLifecycleScope,
  ServiceApiRoute,
  ServiceEnv,
  defaultServicePort,
  maxServiceRequestBodyBytes,
  type ServiceHealth,
  type ServiceServer,
  type StartProjectRuntimeResult,
} from "./service-types.ts";

const ServiceReconcileIntervalMs = 30_000;

export async function startServiceServer(options: {
  host?: string;
  port?: number;
  registryPath?: string;
  authToken?: string;
  leaseId?: string;
  allowRemote?: boolean;
  reconcileIntervalMs?: number | false;
} = {}): Promise<ServiceServer> {
  const host = options.host ?? "127.0.0.1";
  assertSafeRuntimeHost(host, options.allowRemote);
  const authToken = usableRuntimeAuthToken(options.authToken) ?? usableRuntimeAuthToken(process.env[ServiceEnv.AuthToken]) ?? createRuntimeAuthToken();
  const registryPath = options.registryPath ?? process.env[ServiceEnv.RegistryPath] ?? serviceRegistryPath();
  const pipeEndpoint = process.env[ServiceEnv.PipeEndpoint] ?? localPipeEndpoint({ scope: "service", key: registryPath });
  const leaseId = options.leaseId?.trim() || process.env[ServiceEnv.LeaseId]?.trim() || createProcessLeaseId();
  const serviceHealth: ServiceHealth = {
    status: "ready",
    protocolVersion: LocalControlProtocolVersion,
    runtimeVersion: openCanonRuntimeVersion(),
    process: {
      kind: ProcessLifecycleScope.Service,
      pid: process.pid,
      leaseId,
    },
  };
  const routeRequest = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return new Response("OpenCanon local service exposes /api/* only.", { status: 404 });
    }

    if (!isAuthorizedRuntimeRequest(request, url, authToken)) {
      return serviceJson(
        serviceProblem(
          createOpenCanonProblem({
            code: OpenCanonProblemCode.Unauthorized,
            title: "OpenCanon service request is unauthorized",
            detail: "OpenCanon service request is unauthorized.",
            source: OpenCanonProblemSource.Service,
            retryable: false,
            status: 401,
          }),
        ),
        401,
      );
    }

    if (url.pathname === ServiceApiRoute.Health) {
      return serviceJson({ ok: true, data: serviceHealth });
    }

    if (url.pathname === ServiceApiRoute.Overview && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      return serviceJson({
        ok: true,
        data: await buildServiceOverview({
          discoveryRoots: stringArrayBodyValue(body.body.discoveryRoots),
          recentProjects: recentProjectsBodyValue(body.body.recentProjects),
          currentRootDir: stringBodyValue(body.body.currentRootDir),
          registryPath,
        }),
      });
    }

    if (url.pathname === ServiceApiRoute.ActionInvoke && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const id = stringBodyValue(body.body.id);
      if (!id) return serviceJson(serviceDiagnostic("service-malformed-request", "id is required."), 400);
      return serviceJson({
        ok: true,
        data: await invokeServiceAction({
          id,
          rootDir: stringBodyValue(body.body.rootDir),
          registryPath,
        }),
      });
    }

    if (url.pathname === ServiceApiRoute.SetupProject && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const rootDir = stringBodyValue(body.body.rootDir);
      if (!rootDir) return serviceJson(serviceDiagnostic("service-malformed-request", "rootDir is required."), 400);
      return serviceJson({ ok: true, data: await setupOpenCanonProject(rootDir) });
    }

    if (url.pathname === ServiceApiRoute.EnsureProject && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const rootDir = stringBodyValue(body.body.rootDir);
      const project = rootDir ? discoverOpenCanonProject(rootDir) : undefined;
      if (!project) {
        return serviceJson(serviceProblem(projectNotFoundProblem({ rootDir: rootDir || undefined, status: 400 })), 400);
      }
      const port = optionalPortBodyValue(body.body.port);
      if (!port.ok) return serviceJson(serviceDiagnostic("service-malformed-request", "port must be an integer from 1 to 65535."), 400);
      let started: StartProjectRuntimeResult;
      try {
        started = await startProjectRuntime({
          cwd: project.rootDir,
          host: stringBodyValue(body.body.host),
          port: port.value,
          registryPath,
          allowRemote: booleanBodyValue(body.body.allowRemote),
          idleTimeoutMs: numberBodyValue(body.body.idleTimeoutMs),
        });
      } catch (error) {
        return runtimeUnavailableResponse(project.rootDir, error);
      }
      return serviceJson({ ok: true, data: { project: started } });
    }

    if (url.pathname === ServiceApiRoute.Request && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const rootDir = stringBodyValue(body.body.rootDir);
      const apiPath = stringBodyValue(body.body.path);
      if (!rootDir) return serviceJson(serviceDiagnostic("service-malformed-request", "rootDir is required."), 400);
      if (!apiPath?.startsWith("/api/")) return serviceJson(serviceDiagnostic("service-malformed-request", "path must be a project API path."), 400);
      const project = discoverOpenCanonProject(rootDir);
      if (!project) return serviceJson(serviceProblem(projectNotFoundProblem({ rootDir, status: 400 })), 400);
      let started: StartProjectRuntimeResult;
      try {
        started = await startProjectRuntime({ cwd: project.rootDir, registryPath });
      } catch (error) {
        return runtimeUnavailableResponse(project.rootDir, error);
      }
      const proxied = await localProtocolTransport.request(localProtocolEndpointFromEntry(started.entry), {
        method: serviceRequestMethod(body.body.method),
        path: apiPath,
        headers: stringRecordBodyValue(body.body.headers),
        body: body.body.body,
      });
      return serviceJson({ ok: true, data: { status: proxied.status, body: proxied.body } });
    }

    if (url.pathname === ServiceApiRoute.EventsStream && request.method === "GET") {
      const rootDir = url.searchParams.get("rootDir")?.trim() ?? "";
      const project = rootDir ? discoverOpenCanonProject(rootDir) : undefined;
      if (!project) return serviceJson(serviceProblem(projectNotFoundProblem({ rootDir: rootDir || undefined, status: 400 })), 400);
      let started: StartProjectRuntimeResult;
      try {
        started = await startProjectRuntime({ cwd: project.rootDir, registryPath });
      } catch (error) {
        return runtimeUnavailableResponse(project.rootDir, error);
      }
      return proxyRuntimeEventStream(started.entry);
    }

    if (url.pathname === ServiceApiRoute.Summary && request.method === "GET") {
      const rootDir = url.searchParams.get("rootDir")?.trim() ?? "";
      const project = rootDir ? discoverOpenCanonProject(rootDir) : undefined;
      if (!project) return serviceJson(serviceProblem(projectNotFoundProblem({ rootDir: rootDir || undefined, status: 400 })), 400);
      let started: StartProjectRuntimeResult;
      try {
        started = await startProjectRuntime({ cwd: project.rootDir, registryPath });
      } catch (error) {
        return runtimeUnavailableResponse(project.rootDir, error);
      }
      const summaryPayload = await requestLocalJson<unknown>(localProtocolEndpointFromEntry(started.entry), {
        method: "GET",
        path: ApiRoute.ProjectSummary,
      });
      const summary = RuntimeProjectSummarySchema.safeParse(summaryPayload);
      if (!summary.success) return serviceJson(serviceDiagnostic("invalid-runtime-response", "Project runtime returned an invalid summary payload."), 502);
      return serviceJson({ ok: true, data: summary.data });
    }

    if (url.pathname === ServiceApiRoute.StopProject && request.method === "POST") {
      const body = await readServiceJsonObject(request);
      if (!body.ok) return serviceJson(serviceDiagnostic("service-malformed-request", body.message), 400);
      const rootDir = stringBodyValue(body.body.rootDir);
      if (!rootDir) return serviceJson(serviceDiagnostic("service-malformed-request", "rootDir is required."), 400);
      return serviceJson({ ok: true, data: { project: await stopProjectRuntime(rootDir, registryPath) } });
    }

    return serviceJson(serviceDiagnostic("service-route-not-found", `Unknown OpenCanon service route: ${url.pathname}.`), 404);
  };
  const server = await serveService({ host, port: options.port ?? defaultServicePort, routeRequest });
  let pipeServer: Awaited<ReturnType<typeof serveLocalProtocolPipe>>;
  try {
    pipeServer = await serveLocalProtocolPipe({
      endpoint: pipeEndpoint,
      routeRequest,
      host: "opencanon.service",
      maxFrameBytes: maxServiceRequestBodyBytes,
    });
  } catch (error) {
    await server.stop(true).catch(() => undefined);
    throw error;
  }
  let stopped = false;
  let reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  const reconcileIntervalMs = options.reconcileIntervalMs === false ? undefined : options.reconcileIntervalMs ?? ServiceReconcileIntervalMs;
  const scheduleReconcile = () => {
    if (stopped || reconcileIntervalMs === undefined) return;
    reconcileTimer = setTimeout(() => {
      void reconcileProjectRuntimes({ registryPath }).catch(() => undefined).finally(scheduleReconcile);
    }, reconcileIntervalMs);
  };
  scheduleReconcile();
  return {
    url: formatHttpBaseUrl(host, server.port),
    pipeEndpoint: pipeServer.endpoint,
    port: server.port,
    authToken,
    leaseId,
    async stop() {
      stopped = true;
      if (reconcileTimer) clearTimeout(reconcileTimer);
      await Promise.all([server.stop(true), pipeServer.stop(true)]);
    },
  };
}

function runtimeUnavailableResponse(rootDir: string, error: unknown): Response {
  const problem = runtimeUnavailableProblem(rootDir, error);
  return serviceJson(serviceProblem(problem), problem.status ?? 500);
}
