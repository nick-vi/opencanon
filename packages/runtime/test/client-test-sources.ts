import path from "node:path";
import { pathToFileURL } from "node:url";

const RuntimeWatcherPropagationTimeoutMs = 30_000;

export function doctorRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  const coreUrl = pathToFileURL(path.join(process.cwd(), "packages/core/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { createPaths } from ${JSON.stringify(coreUrl)};
    import { runtimeAuthHeaders, startOpenCanonRuntime, openProjectStore } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const unauthorized = await fetch(server.url + "/api/doctor");
      assert.equal(unauthorized.status, 401);

      const headers = runtimeAuthHeaders(server.authToken);
      const beforeState = await fetch(server.url + "/api/state", { headers }).then((response) => response.json());
      const beforeProducers = await fetch(server.url + "/api/producers", { headers }).then((response) => response.json());
      assert.equal(beforeProducers.data.data.producers.find((producer) => producer.language === "typescript")?.kind, "idle");

      const response = await fetch(server.url + "/api/doctor", { headers });
      const text = await response.text();
      assert(response.status >= 200 && response.status < 300, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true);
      assert(["pass", "warn", "fail"].includes(body.data.data.status));
      assert(body.data.data.checks.some((check) => check.id === "config"));
      assert(body.data.data.checks.some((check) => check.id === "context-files"));

      const afterState = await fetch(server.url + "/api/state", { headers }).then((next) => next.json());
      const afterProducers = await fetch(server.url + "/api/producers", { headers }).then((next) => next.json());
      assert.deepEqual(afterState.data.data.lifecycle.revision, beforeState.data.data.lifecycle.revision, "Doctor must not advance project revisions");
      assert.deepEqual(afterProducers.data.data.producers, beforeProducers.data.data.producers, "Doctor must not change producer state");
    } finally {
      await server.stop();
    }

    const store = openProjectStore({ rootDir, paths: createPaths(rootDir) });
    try {
      const records = store.listObservabilityRecords({ limit: 100 });
      assert(records.spans.some((span) => span.name === "runtime.request" && span.attributes.path === "/api/doctor"));
      assert(records.spans.some((span) => span.name === "doctor.report"));
    } finally {
      store.close();
    }
  `;
}

export function runtimeSummaryRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const unauthorized = await fetch(server.url + "/api/project/summary");
      assert.equal(unauthorized.status, 401);

      const response = await fetch(server.url + "/api/project/summary", { headers: runtimeAuthHeaders(server.authToken) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      assert.equal(body.data.protocolVersion, 1);
      assert.equal(body.data.revision, body.data.data.lifecycle.revision.published);
      assert.equal(body.data.data.rootDir, rootDir);
      assert.equal(body.data.data.lifecycle.settled, body.data.data.lifecycle.revision.observed === body.data.data.lifecycle.revision.published);
      assert(["ready", "indexing"].includes(body.data.data.health.status));
      assert.equal(typeof body.data.data.health.validatorGraph.dependencyCount, "number");
      assert.equal("dependencyFiles" in body.data.data.health.validatorGraph, false);
      assert.equal("entrypoint" in body.data.data.health.validatorGraph, false);
      assert.equal(typeof body.data.data.files, "number");
      assert.equal(typeof body.data.data.findings, "number");
      assert.equal(typeof body.data.data.staleFiles, "number");
      assert.equal(typeof body.data.data.semanticIndex.status, "string");
      assert.equal(typeof body.data.data.productModel.nodes, "number");
      assert.equal("files" in body.data.data && Array.isArray(body.data.data.files), false);
      assert.equal("definitionGraph" in body.data.data, false);
    } finally {
      await server.stop();
    }
  `;
}

export function codeGraphRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = runtimeAuthHeaders(server.authToken);
    async function get(path) {
      const response = await fetch(server.url + path, { headers });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data.data;
    }
    try {
      const analysisDeadline = Date.now() + 30000;
      while (Date.now() < analysisDeadline) {
        const state = await get("/api/state");
        if (state.lifecycle.settled && state.files > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const symbols = await get("/api/code/symbols?query=loadCompany&limit=10");
      assert.equal(typeof symbols.sourceFiles, "number");
      assert(symbols.symbols.some((symbol) => symbol.name === "loadCompany" && symbol.path === "src/company.ts"));

      const references = await get("/api/code/symbols?query=normalizeCompany&references=1&limit=10");
      assert(references.references.some((reference) => reference.name === "normalizeCompany" && reference.path === "src/company.ts"));

      const graph = await get("/api/code/graph?query=normalizeCompany&kind=call&direction=incoming&limit=10");
      assert(graph.edges.some((edge) => edge.source.name === "loadCompany" && edge.target.name === "normalizeCompany"));
    } finally {
      await server.stop();
    }
  `;
}

export function projectContextRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = runtimeAuthHeaders(server.authToken);
    async function get(path) {
      const response = await fetch(server.url + path, { headers });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data.data;
    }
    async function post(path) {
      const response = await fetch(server.url + path, { method: "POST", headers });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data;
    }
    try {
      const initialStatus = await get("/api/context/status");
      assert.equal(initialStatus.index.status, "missing");
      const staleSearchResponse = await fetch(server.url + "/api/context/search?query=invoice%20search%20term&limit=5", { headers });
      const staleSearchText = await staleSearchResponse.text();
      assert.equal(staleSearchResponse.status, 409, staleSearchText);
      const staleSearchBody = JSON.parse(staleSearchText);
      assert.equal(staleSearchBody.ok, false, staleSearchText);
      assert.equal(staleSearchBody.error.diagnostics[0].code, "semantic-index-not-ready");

      const compactResponse = await fetch(server.url + "/api/index", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({}),
      });
      const compactText = await compactResponse.text();
      assert.equal(compactResponse.status, 200, compactText);
      const compactBody = JSON.parse(compactText);
      assert.equal(compactBody.ok, true, compactText);
      assert.equal(typeof compactBody.data.semanticIndex.status, "string");
      assert.equal(compactBody.data.semanticIndex.provider.kind, "native");
      assert.equal("state" in compactBody.data, false);
      assert.equal("files" in compactBody.data, false);

      const status = await get("/api/context/status");
      assert.equal(status.index.status, "ready");
      const summary = await get("/api/project/summary");
      assert.equal(summary.files, 2);

      const search = await get("/api/context/search?query=invoice%20search%20term&limit=5");
      assert.equal(search.results[0].file, "src/company.ts");
      assert(search.results[0].definitions.length >= 0);
      const definitionSearch = await get("/api/context/search?query=Billing%20Context&limit=5");
      assert(definitionSearch.results.some((item) => item.file === "src/company.ts"));

      const ask = await get("/api/context/ask?query=where%20is%20invoice%20search%20term");
      assert.equal(ask.deterministic, true);
      assert(ask.evidence.some((item) => item.file === "src/company.ts"));

      const chunks = await get("/api/context/chunks?path=src/company.ts");
      assert(chunks.chunks.some((chunk) => chunk.path === "src/company.ts"));
      const definitionChunks = await get("/api/context/chunks?definition=billing-context");
      assert(definitionChunks.chunks.some((chunk) => chunk.path === "src/company.ts"));
      const missingDefinitionChunks = await get("/api/context/chunks?definition=missing-context");
      assert.equal(missingDefinitionChunks.chunks.length, 0);

      const coverage = await get("/api/context/coverage");
      assert(coverage.totals.files >= 1);
      assert(coverage.files.some((file) => file.file === "src/company.ts"));

      const backlinks = await get("/api/context/backlinks?query=src/company.ts");
      assert(backlinks.files.some((file) => file.file === "src/company.ts"));
      const definitionBacklinks = await get("/api/context/backlinks?query=billing-context");
      assert(definitionBacklinks.links.some((link) => link.kind === "area" && link.id === "billing-context"));
    } finally {
      await server.stop();
    }
  `;
}

export function canonRelatedChangeRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const response = await fetch(server.url + "/api/canon/related?file=src/company.ts", { headers: runtimeAuthHeaders(server.authToken) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true);
      assert.deepEqual(body.data.data.areas.map((item) => item.id), ["company-area"]);
      assert.deepEqual(body.data.data.changes.map((item) => item.id), ["company-change"]);

      const postResponse = await fetch(server.url + "/api/canon/related", {
        method: "POST",
        headers: { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" },
        body: JSON.stringify({ files: ["src/company.ts"] }),
      });
      const postText = await postResponse.text();
      assert.equal(postResponse.status, 200, postText);
      const postBody = JSON.parse(postText);
      assert.equal(postBody.ok, true);
      assert.deepEqual(postBody.data.data.areas.map((item) => item.id), ["company-area"]);
      assert.deepEqual(postBody.data.data.changes.map((item) => item.id), ["company-change"]);
    } finally {
      await server.stop();
    }
  `;
}

export function activityRoutesCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = {
      ...runtimeAuthHeaders(server.authToken),
      "content-type": "application/json",
      "idempotency-key": "activity-change-started",
    };
    try {
      const started = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers,
        body: JSON.stringify({
          id: "activity-change-started",
          changeId: "activity-change",
          type: "change-started",
          summary: "Started <activity & change>.",
          actor: "test",
          files: ["src/company.ts"],
        }),
      });
      assert.equal(started.status, 200, await started.text());

      const observability = await fetch(server.url + "/api/observability?limit=100", { headers: runtimeAuthHeaders(server.authToken) });
      const observabilityText = await observability.text();
      assert.equal(observability.status, 200, observabilityText);
      const observabilityBody = JSON.parse(observabilityText);
      assert.equal(observabilityBody.ok, true);
      assert(observabilityBody.data.data.spans.some((span) => span.name === "runtime.request" && span.attributes.path === "/api/changes/events"));

      const traceId = observabilityBody.data.data.spans[0]?.traceId;
      if (traceId) {
        const filtered = await fetch(server.url + "/api/observability?traceId=" + encodeURIComponent(traceId), { headers: runtimeAuthHeaders(server.authToken) });
        const filteredBody = await filtered.json();
        assert.equal(filteredBody.ok, true);
        assert(filteredBody.data.data.spans.every((span) => span.traceId === traceId));
      }

      const packet = await fetch(server.url + "/api/context/packet?file=src/company.ts&changeId=activity-change&mode=review&limit=10", { headers: runtimeAuthHeaders(server.authToken) });
      const packetText = await packet.text();
      assert.equal(packet.status, 200, packetText);
      const packetBody = JSON.parse(packetText);
      assert.equal(packetBody.ok, true);
      assert.equal(packetBody.data.data.schema, "opencanon.context-packet.v1");
      assert.equal(packetBody.data.data.mode, "review");
      assert.deepEqual(packetBody.data.data.filters.files, ["src/company.ts"]);
      assert.deepEqual(packetBody.data.data.filters.changeIds, ["activity-change"]);
      assert(packetBody.data.data.xml.includes('<changes>'));
      assert(packetBody.data.data.xml.includes('activity-change'));
      assert(packetBody.data.data.xml.includes('Started &lt;activity &amp; change&gt;.'));
      assert(packetBody.data.data.xml.includes('embedded="'));
      assert(packetBody.data.data.xml.includes('reused="'));
      assert.equal(packetBody.data.data.facts.changes, 1);
      assert.equal(packetBody.data.data.facts.checks, 1);
      assert.equal(typeof packetBody.data.data.facts.semanticIndexEmbeddedChunks, "number");
      assert.equal(typeof packetBody.data.data.facts.semanticIndexReusedChunks, "number");

      const unsafe = await fetch(server.url + "/api/context/packet?file=../escape.ts", { headers: runtimeAuthHeaders(server.authToken) });
      assert.equal(unsafe.status, 400);

      const unknownChange = await fetch(server.url + "/api/context/packet?changeId=missing-change", { headers: runtimeAuthHeaders(server.authToken) });
      assert.equal(unknownChange.status, 404);
    } finally {
      await server.stop();
    }
  `;
}

export function changeTaskRoutesCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { mkdirSync } from "node:fs";
    import path from "node:path";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    mkdirSync(path.join(rootDir, ".opencanon"), { recursive: true });
    process.env.OPENCANON_WORKTREE_DB = path.join(rootDir, ".opencanon", "worktrees-test.sqlite");
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };
    async function get(path) {
      const response = await fetch(server.url + path, { headers: runtimeAuthHeaders(server.authToken) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data.data;
    }
    async function post(path, body) {
      const activityId = path === "/api/changes/events" ? body.id ?? crypto.randomUUID() : undefined;
      const response = await fetch(server.url + path, {
        method: "POST",
        headers: { ...headers, ...(activityId ? { "idempotency-key": activityId } : {}) },
        body: JSON.stringify(activityId ? { ...body, id: activityId } : body),
      });
      const text = await response.text();
      assert(response.status >= 200 && response.status < 300, text);
      const parsed = JSON.parse(text);
      assert.equal(parsed.ok, true, text);
      return parsed.data;
    }
    async function waitForRun(runId) {
      let jobCursor = 0;
      let protocolCursor = 0;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const snapshot = await get("/api/changes/check-runs?runId=" + encodeURIComponent(runId) + "&after=" + jobCursor);
        for (const event of snapshot.events) {
          jobCursor = Math.max(jobCursor, event.sequence);
          if (["passed", "failed", "cancelled"].includes(event.type)) return event.run;
        }
        if (["passed", "failed", "cancelled"].includes(snapshot.run.status) && jobCursor >= snapshot.latestSequence) return snapshot.run;

        const response = await fetch(
          server.url + "/api/events/stream?operationId=" + encodeURIComponent(runId) + "&afterSequence=" + protocolCursor,
          { headers: runtimeAuthHeaders(server.authToken) },
        );
        assert.equal(response.status, 200);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let woke = false;
        try {
          while (!woke) {
            const read = await reader.read();
            if (read.done) break;
            buffer += decoder.decode(read.value, { stream: true });
            while (buffer.includes("\\n\\n")) {
              const boundary = buffer.indexOf("\\n\\n");
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const data = frame.split("\\n").find((line) => line.startsWith("data:"))?.slice(5).trimStart();
              if (!data) continue;
              const event = JSON.parse(data);
              protocolCursor = Math.max(protocolCursor, event.sequence);
              woke = event.operationId === runId;
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      throw new Error("Timed out waiting for Change check completion.");
    }

    try {
      const initialReady = await get("/api/changes/ready");
      assert.deepEqual(initialReady.ready.map((item) => item.taskId), ["model"]);
      assert.deepEqual(initialReady.ready[0].surfaces, ["company-workflow"]);
      assert(initialReady.ready[0].suggestedCommands.some((command) => command.includes("opencanon changes claim task-change --task model")));
      assert.deepEqual(initialReady.blocked.map((item) => item.taskId), ["cli"]);
      assert(initialReady.blocked[0].blockedReasons.some((reason) => reason.includes("waits for model")));

      const claimed = await post("/api/changes/events", {
        changeId: "task-change",
        taskId: "model",
        type: "task-claimed",
        summary: "Claimed model task.",
        actor: "test",
      });
      assert.equal(claimed.event.taskIds[0], "model");
      assert.equal(claimed.event.type, "task-claimed");

      const started = await post("/api/changes/events", {
        changeId: "task-change",
        taskId: "model",
        type: "task-started",
        summary: "Started model task from the claimed worktree.",
      });
      assert.equal(started.event.type, "task-started");
      assert.equal(started.event.actor, "test");

      const duplicateClaim = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "duplicate-claim" },
        body: JSON.stringify({
          id: "duplicate-claim",
          changeId: "task-change",
          taskId: "model",
          type: "task-claimed",
          summary: "Other agent tried to claim model task.",
          actor: "other",
        }),
      });
      const duplicateText = await duplicateClaim.text();
      assert.equal(duplicateClaim.status, 409, duplicateText);
      assert.match(duplicateText, /already claimed by test/);

      const worktrees = await get("/api/worktrees");
      assert.deepEqual(worktrees.leases.filter((lease) => lease.status === "active").map((lease) => lease.taskId), ["model"]);

      const startedChanges = await get("/api/changes");
      const startedChange = startedChanges.find((item) => item.id === "task-change");
      assert.equal(startedChange.tasks.find((task) => task.id === "model").status, "running");
      assert.deepEqual(startedChange.tasks.find((task) => task.id === "model").surfaces, ["company-workflow"]);
      assert.equal(startedChange.readyTaskCount, 0);

      const earlyClose = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "early-close" },
        body: JSON.stringify({
          id: "early-close",
          changeId: "task-change",
          type: "change-closed",
          summary: "Tried to close unfinished Change.",
          actor: "test",
        }),
      });
      const earlyCloseText = await earlyClose.text();
      assert.equal(earlyClose.status, 409, earlyCloseText);
      assert.match(earlyCloseText, /All tasks must be closed before close/);

      const modelCheck = await post("/api/changes/check-runs", {
        changeId: "task-change",
        taskId: "model",
        all: true,
        actor: "test",
      });
      assert.equal((await waitForRun(modelCheck.runs[0].id)).status, "passed");
      await post("/api/changes/events", {
        changeId: "task-change",
        taskId: "model",
        type: "task-review",
        summary: "Reviewed model task.",
        actor: "test",
      });

      await post("/api/changes/events", {
        changeId: "task-change",
        taskId: "model",
        type: "task-closed",
        summary: "Closed model task.",
        actor: "test",
      });
      const modelClosedChanges = await get("/api/changes");
      const modelClosedChange = modelClosedChanges.find((item) => item.id === "task-change");
      assert.equal(modelClosedChange.lastEvent.type, "task-closed");
      assert.equal(modelClosedChange.boardColumn, "ready");
      const nextReady = await get("/api/changes/ready");
      assert.deepEqual(nextReady.ready.map((item) => item.taskId), ["cli"]);
      assert.equal(nextReady.blocked.length, 0);
      const releasedWorktrees = await get("/api/worktrees");
      assert.equal(releasedWorktrees.leases.filter((lease) => lease.status === "active").length, 0);

      const check = await post("/api/changes/check-runs", {
        changeId: "task-change",
        taskId: "cli",
        all: true,
        actor: "test",
      });
      assert.equal(check.runs.length, 1);
      assert.equal(check.runs[0].taskId, "cli");
      const checked = await waitForRun(check.runs[0].id);
      assert.equal(checked.status, "passed");

      const cliEvents = await get("/api/changes/events?changeId=task-change&taskId=cli");
      assert(cliEvents.every((event) => event.taskIds.includes("cli")));
      assert(cliEvents.some((event) => event.type === "task-check-passed"));

      const packet = await get("/api/context/packet?changeId=task-change&limit=10");
      assert(packet.xml.includes("<ready-work>"));
      assert(packet.xml.includes("task-change"));
      assert(packet.xml.includes('surface id="company-workflow"'));
      assert.equal(typeof packet.facts.readyTasks, "number");
    } finally {
      await server.stop();
    }
  `;
}

export function completeReadyHistoryCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  const coreUrl = pathToFileURL(path.join(process.cwd(), "packages/core/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { CanonEventSchema, createPaths } from ${JSON.stringify(coreUrl)};
    import { openProjectStore, runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const store = openProjectStore({ rootDir, paths: createPaths(rootDir) });
    const event = (id, type, changeId, timestamp, taskId) => CanonEventSchema.parse({
      id,
      type,
      timestamp,
      actor: "test",
      files: [],
      changeIds: [changeId],
      taskIds: taskId ? [taskId] : [],
      checkIds: [],
      conventionIds: [],
      validatorIds: [],
      findingIds: [],
      summary: id,
    });
    try {
      const lifecycle = [
        ["closed-claim", "task-claimed", "finish"],
        ["closed-start", "task-started", "finish"],
        ["closed-review-task", "task-review", "finish"],
        ["closed-task", "task-closed", "finish"],
        ["closed-review-change", "change-review", undefined],
        ["closed-change", "change-closed", undefined],
      ];
      for (let index = 0; index < lifecycle.length; index += 1) {
        const [id, type, taskId] = lifecycle[index];
        store.writeEvent(event(id, type, "closed-change", new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString(), taskId));
      }
      for (let index = 0; index < 600; index += 1) {
        store.writeEvent(event("unrelated-" + String(index).padStart(4, "0"), "updated", "unrelated-change", new Date(Date.UTC(2026, 1, 1, 0, 0, 0, index)).toISOString()));
      }
    } finally {
      store.close();
    }

    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = runtimeAuthHeaders(server.authToken);
    async function get(path) {
      const response = await fetch(server.url + path, { headers });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const body = JSON.parse(text);
      assert.equal(body.ok, true, text);
      return body.data.data;
    }
    try {
      const queue = await get("/api/changes/ready");
      assert(!queue.ready.some((item) => item.changeId === "closed-change"));
      assert(!queue.blocked.some((item) => item.changeId === "closed-change"));
      assert(queue.ready.some((item) => item.changeId === "unrelated-change"));

      const changes = await get("/api/changes");
      const closed = changes.find((change) => change.id === "closed-change");
      assert.equal(closed.boardColumn, "closed");
      assert.equal(closed.tasks[0].status, "closed");
    } finally {
      await server.stop();
    }
  `;
}

export function worktreeCoordinationStreamCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { mkdirSync, realpathSync } from "node:fs";
    import path from "node:path";
    import { claimTaskLease, runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    mkdirSync(path.join(rootDir, ".opencanon"), { recursive: true });
    process.env.OPENCANON_WORKTREE_DB = path.join(rootDir, ".opencanon", "worktrees-stream.sqlite");
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const seenEvents = [];
    try {
      const stream = await fetch(server.url + "/api/events/stream", { headers: runtimeAuthHeaders(server.authToken) });
      assert.equal(stream.status, 200, "expected authorized runtime stream");
      assert(stream.body, "expected runtime stream body");
      const reader = stream.body.getReader();
      const updatePromise = waitForRuntimeEvent(reader, (event) => {
        return event.domain === "activity" && event.ids.includes("stream-change");
      });

      const claim = claimTaskLease({
        rootDir,
        changeId: "stream-change",
        taskId: "model",
        agentId: "agent-a",
        worktreePath: rootDir,
        branch: "stream-change-model",
        ttlMs: 60000,
      });
      assert.equal(claim.ok, true, JSON.stringify(claim));

      await updatePromise.catch(async (error) => {
        const changesResponse = await fetch(server.url + "/api/changes", { headers: runtimeAuthHeaders(server.authToken) });
        const changesBody = await changesResponse.json();
        const eventResponse = await fetch(server.url + "/api/events?limit=10", { headers: runtimeAuthHeaders(server.authToken) });
        const eventBody = await eventResponse.json();
        const task = changesBody.data?.data?.find((item) => item.id === "stream-change")?.tasks?.find((item) => item.id === "model");
        const summaries = (eventBody.data?.data?.events ?? []).map((item) => item.summary).join(" | ");
        throw new Error(error.message + " Route task: " + (task?.status ?? "-") + ":" + (task?.lease?.agentId ?? "-") + ". Runtime events: " + summaries);
      });
      const worktreesResponse = await fetch(server.url + "/api/worktrees", { headers: runtimeAuthHeaders(server.authToken) });
      const worktreesBody = await worktreesResponse.json();
      const activeLease = worktreesBody.data.data.leases.find((lease) => lease.changeId === "stream-change" && lease.taskId === "model" && lease.status === "active");
      assert.equal(activeLease.agentId, "agent-a");
      const changes = await waitForClaimedChangesRoute();
      const change = changes.find((item) => item.id === "stream-change");
      const task = change.tasks.find((item) => item.id === "model");
      assert.equal(change.readyTaskCount, 0);
      assert.equal(task.lease.worktreePath, realpathSync(rootDir));
      assert.equal(task.lease.status, "active");
      await reader.cancel();
    } finally {
      await server.stop();
    }

    async function waitForRuntimeEvent(reader, predicate) {
      const decoder = new TextDecoder();
      const deadline = Date.now() + 30000;
      let buffer = "";
      let pendingRead;
      while (Date.now() < deadline) {
        pendingRead ??= reader.read();
        const read = await Promise.race([pendingRead, delay(250).then(() => null)]);
        if (read === null) continue;
        pendingRead = undefined;
        if (read.done) break;
        buffer += decoder.decode(read.value, { stream: true });
        while (true) {
          const frameEnd = buffer.indexOf("\\n\\n");
          if (frameEnd < 0) break;
          const frame = buffer.slice(0, frameEnd);
          buffer = buffer.slice(frameEnd + 2);
          const parsed = parseSseFrame(frame);
          if (parsed) seenEvents.push(parsed.domain + ":" + parsed.type + ":" + parsed.summary);
          if (parsed && predicate(parsed)) return parsed;
        }
      }
      throw new Error("Timed out waiting for active-work stream update. Seen: " + seenEvents.join(" | "));
    }

    async function waitForClaimedChangesRoute() {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const response = await fetch(server.url + "/api/changes", { headers: runtimeAuthHeaders(server.authToken) });
        const body = await response.json();
        const change = body.data?.data?.find((item) => item.id === "stream-change");
        const task = change?.tasks?.find((item) => item.id === "model");
        if (task?.status === "claimed" && task?.lease?.agentId === "agent-a") return body.data.data;
        await delay(250);
      }
      throw new Error("Timed out waiting for active-work Changes projection.");
    }

    function parseSseFrame(frame) {
      let eventName = "message";
      let data = "";
      for (const line of frame.split(/\\r?\\n/)) {
        if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
        if (line.startsWith("data:")) data += line.slice("data:".length).trimStart();
      }
      if (!eventName || !data) return undefined;
      return JSON.parse(data);
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
  `;
}

export function canonHistoryRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const headers = runtimeAuthHeaders(server.authToken);
      const cases = [
        { kind: "convention", id: "route-rule", file: "conventions/index.ts", doc: "docs/route-rule.md" },
        { kind: "area", id: "route-area", file: "opencanon/areas/index.ts", doc: "docs/route-area.md" },
        { kind: "change", id: "route-change", file: "opencanon/changes/index.ts", doc: "docs/route-change.md" },
      ];
      for (const item of cases) {
        const response = await fetch(server.url + "/api/canon/history?kind=" + item.kind + "&id=" + item.id, { headers });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const body = JSON.parse(text);
        assert.equal(body.ok, true);
        assert.equal(body.data.data.target.kind, item.kind);
        assert.equal(body.data.data.target.id, item.id);
        assert(body.data.data.target.files.includes(item.file), item.file + " missing from " + JSON.stringify(body.data.data.target.files));
        assert(body.data.data.target.files.includes(item.doc), item.doc + " missing from " + JSON.stringify(body.data.data.target.files));
      }
    } finally {
      await server.stop();
    }
  `;
}

export function changeEventsRouteCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const changesPath = path.join(rootDir, "opencanon/changes/index.ts");
    const originalChanges = readFileSync(changesPath, "utf8");
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };
    try {
      const projectedChangesResponse = await fetch(server.url + "/api/changes", { headers });
      const changesText = await projectedChangesResponse.text();
      assert.equal(projectedChangesResponse.status, 200, changesText);
      const changesBody = JSON.parse(changesText);
      assert.equal(changesBody.data.data[0].id, "route-change");
      assert.equal(changesBody.data.data[0].boardColumn, "planned");

      // Activity is evaluated against the last accepted catalog. An invalid
      // in-progress source revision must not force a route-local Canon reload.
      writeFileSync(changesPath, "export default [\\n", "utf8");

      const recordResponse = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "route-change-started-idempotent" },
        body: JSON.stringify({
          id: "route-change-started-idempotent",
          changeId: "route-change",
          type: "change-started",
          summary: "Started route change.",
          actor: "test",
          files: ["src/company.ts"],
        }),
      });
      const recordText = await recordResponse.text();
      assert.equal(recordResponse.status, 200, recordText);
      const recordBody = JSON.parse(recordText);
      assert.equal(recordBody.data.event.changeIds[0], "route-change");
      assert.equal(recordBody.data.event.type, "change-started");
      assert.equal(recordBody.data.event.id, "route-change-started-idempotent");
      writeFileSync(changesPath, originalChanges, "utf8");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await fetch(server.url + "/api/state", { headers }).then((response) => response.json());
        if (state.data?.data?.lifecycle?.settled) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      const retryResponse = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "route-change-started-idempotent" },
        body: JSON.stringify({
          id: "route-change-started-idempotent",
          changeId: "route-change",
          type: "change-started",
          summary: "Started route change.",
          actor: "test",
          files: ["src/company.ts"],
        }),
      });
      const retryText = await retryResponse.text();
      assert.equal(retryResponse.status, 200, retryText);

      const conflictingRetryResponse = await fetch(server.url + "/api/changes/events", {
        method: "POST",
        headers: { ...headers, "idempotency-key": "route-change-started-idempotent" },
        body: JSON.stringify({
          id: "route-change-started-idempotent",
          changeId: "route-change",
          type: "change-started",
          summary: "Different request content.",
          actor: "test",
          files: ["src/company.ts"],
        }),
      });
      assert.equal(conflictingRetryResponse.status, 409, await conflictingRetryResponse.text());

      const eventsResponse = await fetch(server.url + "/api/changes/events?changeId=route-change", { headers });
      const eventsText = await eventsResponse.text();
      assert.equal(eventsResponse.status, 200, eventsText);
      const eventsBody = JSON.parse(eventsText);
      assert.equal(eventsBody.data.data[0].summary, "Started route change.");
      assert.equal(eventsBody.data.data.filter((event) => event.id === "route-change-started-idempotent").length, 1);

      const updatedChangesResponse = await fetch(server.url + "/api/changes", { headers });
      const updatedChangesText = await updatedChangesResponse.text();
      assert.equal(updatedChangesResponse.status, 200, updatedChangesText);
      const updatedChangesBody = JSON.parse(updatedChangesText);
      const change = updatedChangesBody.data.data.find((item) => item.id === "route-change");
      assert.equal(change.boardColumn, "running");
      assert.equal(change.lastEvent.type, "change-started");
    } finally {
      writeFileSync(changesPath, originalChanges, "utf8");
      await server.stop();
    }
  `;
}

export function validateTraversalCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      const headers = { ...runtimeAuthHeaders(server.authToken), "content-type": "application/json" };

      for (const escaping of ["../escape.ts", "/etc/passwd"]) {
        const response = await fetch(server.url + "/api/validate", {
          method: "POST",
          headers,
          body: JSON.stringify({ files: [escaping] }),
        });
        assert.equal(response.status, 400, "escaping path " + escaping + " must be a 400, not a read");
        const body = await response.json();
        assert.equal(body.ok, false);
      }

      // A whole-project run (empty files) still succeeds — the guard only fires on supplied paths.
      const ok = await fetch(server.url + "/api/validate", {
        method: "POST",
        headers,
        body: JSON.stringify({ files: [] }),
      });
      assert.equal(ok.status, 200, await ok.text());
    } finally {
      await server.stop();
    }
  `;
}


export function runtimeProjectTypesCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import path from "node:path";
    import { startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const generatedProject = path.join(rootDir, ".opencanon/generated/authoring/project.ts");
    const generatedAliases = path.join(rootDir, ".opencanon/generated/authoring/aliases.d.ts");
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      assert(readFileSync(generatedProject, "utf8").includes('DEMO_APP: "demo-app"'));
      assert(readFileSync(generatedAliases, "utf8").includes('declare module "left-pad"'));
      writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module", name: "demo-next", dependencies: { zod: "^4.0.0" } }, null, 2));
      await waitForFileText(generatedProject, (source) => source.includes('DEMO_NEXT: "demo-next"'));
      writeFileSync(path.join(rootDir, "fixtures/demo/valid.ts"), [
        'import { defineFixture } from "@opencanon/core/testing";',
        'import slugify from "slugify";',
        "",
        "void slugify;",
        "export default defineFixture({});",
        "",
      ].join("\\n"));
      await waitForFileText(generatedAliases, (source) => source.includes('declare module "slugify"'));
    } finally {
      await server.stop();
    }

    async function waitForFileText(file, predicate) {
      const deadline = Date.now() + ${RuntimeWatcherPropagationTimeoutMs};
      while (Date.now() < deadline) {
        if (existsSync(file) && predicate(readFileSync(file, "utf8"))) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Timed out waiting for generated file update: " + file);
    }
  `;
}

export function runtimeValidatorReloadCheckSource(): string {
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import assert from "node:assert/strict";
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    import { runtimeAuthHeaders, startOpenCanonRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const server = await startOpenCanonRuntime({ cwd: rootDir, port: 0 });
    try {
      assert.deepEqual(await getValidatorIds(server.url, server.authToken), ["first-rule"]);
      writeFileSync(path.join(rootDir, "validator-helpers/rules.ts"), ${JSON.stringify(validatorHelperSource(["first-rule", "second-rule"]))});
      const requestStartedAt = Date.now();
      const duringRefresh = await getValidatorIds(server.url, server.authToken);
      assert(Date.now() - requestStartedAt < 1000, "Validator query waited for project analysis.");
      assert(
        JSON.stringify(duringRefresh) === JSON.stringify(["first-rule"]) ||
          JSON.stringify(duringRefresh) === JSON.stringify(["first-rule", "second-rule"]),
      );
      await waitForValidatorIds(server.url, server.authToken, ["first-rule", "second-rule"]);
      writeFileSync(path.join(rootDir, "conventions/rules.ts"), "export default { id: 1 };\\n");
      assert.deepEqual(await getValidatorIds(server.url, server.authToken), ["first-rule", "second-rule"]);
    } finally {
      await server.stop();
    }

    async function getValidatorIds(url, authToken) {
      const response = await fetch(url + "/api/validators?limit=500", { headers: runtimeAuthHeaders(authToken) });
      if (response.status !== 200) throw new Error(await response.text());
      const body = await response.json();
      return body.data.data.validators.map((validator) => validator.id);
    }

    async function waitForValidatorIds(url, authToken, expected) {
      const deadline = Date.now() + ${RuntimeWatcherPropagationTimeoutMs};
      while (Date.now() < deadline) {
        const actual = await getValidatorIds(url, authToken);
        if (JSON.stringify(actual) === JSON.stringify(expected)) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Timed out waiting for validator graph publication.");
    }
  `;
}

export function validatorHelperSource(ids: string[]): string {
  return `export const validatorIds = ${JSON.stringify(ids)};\n`;
}

export function ephemeralRuntimeClientCheckSource(): string {
  const runtimeClientUrl = pathToFileURL(path.join(process.cwd(), "packages/cli/src/runtime-client.ts")).href;
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import { existsSync } from "node:fs";
    import path from "node:path";
    import { withRuntimeClient } from ${JSON.stringify(runtimeClientUrl)};
    import { inspectProjectRuntime, projectRuntimePath, projectRuntimeStatePath, readRuntimeRegistry, readServiceEntry, runtimeNamespaceForRegistry, serviceRegistryPath } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    if (await inspectProjectRuntime(rootDir)) throw new Error("expected no runtime before request");
    const result = await withRuntimeClient(rootDir, async (client) => {
      let stateBeforeRelated;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        stateBeforeRelated = await client.query("project.state");
        if (stateBeforeRelated.lifecycle.settled) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!stateBeforeRelated?.lifecycle.settled) throw new Error("initial project analysis did not settle");
      const related = await client.query("canon.related.read", { query: { file: "src/company.ts" } });
      const stateAfterRelated = await client.query("project.state");
      const summary = await client.query("project.summary");
      return { summaryRootDir: summary.rootDir, related, stateBeforeRelated, stateAfterRelated };
    });
    console.log(JSON.stringify({
      summaryRootDir: result.summaryRootDir,
      relatedConventionIds: result.related.conventions.map((convention) => convention.id),
      relatedValidatorIds: result.related.validators.map((validator) => validator.id),
      lifecycleBeforeRelated: result.stateBeforeRelated.lifecycle,
      lifecycleAfterRelated: result.stateAfterRelated.lifecycle,
      registered: Boolean(await inspectProjectRuntime(rootDir)),
      projectRuntimeFile: existsSync(projectRuntimePath(rootDir)),
      projectState: existsSync(projectRuntimeStatePath(rootDir, runtimeNamespaceForRegistry(serviceRegistryPath()))),
      registryRoots: readRuntimeRegistry().map((entry) => entry.rootDir),
      service: Boolean(readServiceEntry()),
    }));
  `;
}

export function runtimeClientRepairCheckSource(): string {
  const runtimeClientUrl = pathToFileURL(path.join(process.cwd(), "packages/cli/src/runtime-client.ts")).href;
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import { withRuntimeClient } from ${JSON.stringify(runtimeClientUrl)};
    import { inspectProjectRuntime, stopProjectRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const output = await withRuntimeClient(rootDir, async (client) => {
      const first = await client.query("project.summary");
      const before = await inspectProjectRuntime(rootDir);
      if (!before) throw new Error("expected registered runtime before repair");
      await stopProjectRuntime(rootDir);
      const second = await client.query("project.summary");
      const after = await inspectProjectRuntime(rootDir);
      if (!after) throw new Error("expected registered runtime after repair");
      return {
        firstRootDir: first.rootDir,
        secondRootDir: second.rootDir,
        beforePid: before.entry.pid,
        afterPid: after.entry.pid,
      };
    });
    console.log(JSON.stringify(output));
  `;
}

export function runtimeClientPipeRepairCheckSource(): string {
  const runtimeClientUrl = pathToFileURL(path.join(process.cwd(), "packages/cli/src/runtime-client.ts")).href;
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import { rmSync } from "node:fs";
    import { withRuntimeClient } from ${JSON.stringify(runtimeClientUrl)};
    import { inspectProjectRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const output = await withRuntimeClient(rootDir, async (client) => {
      const first = await client.query("project.summary");
      const before = await inspectProjectRuntime(rootDir);
      if (!before) throw new Error("expected registered runtime before pipe repair");
      rmSync(before.entry.pipeEndpoint, { force: true });
      const second = await client.query("project.summary");
      const after = await inspectProjectRuntime(rootDir);
      if (!after) throw new Error("expected registered runtime after pipe repair");
      return {
        firstRootDir: first.rootDir,
        secondRootDir: second.rootDir,
        beforePid: before.entry.pid,
        afterPid: after.entry.pid,
      };
    });
    console.log(JSON.stringify(output));
  `;
}

export function runtimeClientStreamRepairCheckSource(): string {
  const runtimeClientUrl = pathToFileURL(path.join(process.cwd(), "packages/cli/src/runtime-client.ts")).href;
  const runtimeUrl = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/index.ts")).href;
  return `
    import { withRuntimeClient } from ${JSON.stringify(runtimeClientUrl)};
    import { inspectProjectRuntime, stopProjectRuntime } from ${JSON.stringify(runtimeUrl)};

    const rootDir = process.argv[1];
    const output = await withRuntimeClient(rootDir, async (client) => {
      await client.query("project.summary");
      const before = await inspectProjectRuntime(rootDir);
      if (!before) throw new Error("expected registered runtime before stream repair");
      await stopProjectRuntime(rootDir);
      const controller = new AbortController();
      let connected = false;
      try {
        await client.stream("events.stream", undefined, {
          signal: controller.signal,
          onChunk(chunk) {
            connected ||= chunk.includes(": connected");
            if (connected) controller.abort();
          },
        });
      } catch (error) {
        if (!connected) throw error;
      }
      const after = await inspectProjectRuntime(rootDir);
      if (!after) throw new Error("expected registered runtime after stream repair");
      return { beforePid: before.entry.pid, afterPid: after.entry.pid, connected };
    });
    console.log(JSON.stringify(output));
  `;
}
