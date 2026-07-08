import type { CanonEvent } from "@opencanon/core";
import type { RuntimeSnapshot } from "./snapshot.ts";

export function buildContextPacket(input: {
  rootDir: string;
  mode: string;
  snapshot: RuntimeSnapshot;
  doctorStatus: string;
  files: string[];
  changeIds: string[];
  events: CanonEvent[];
  limit: number;
}) {
  const generatedAt = new Date().toISOString();
  const semanticIndex = input.snapshot.state.semanticIndex ?? input.snapshot.semanticIndex;
  const scopedIds = scopedDefinitionIds(input.snapshot, input.files);
  const areas = sortedById(input.snapshot.areas)
    .filter((item) => scopedIds.areas.size === 0 || scopedIds.areas.has(item.id))
    .slice(0, input.limit);
  const specs = sortedById(input.snapshot.specs)
    .filter((item) => scopedIds.specs.size === 0 || scopedIds.specs.has(item.id))
    .slice(0, input.limit);
  const changes = sortedById(input.snapshot.changes)
    .filter((item) => scopedIds.changes.size === 0 || scopedIds.changes.has(item.id))
    .filter((item) => input.changeIds.length === 0 || input.changeIds.includes(item.id))
    .slice(0, input.limit);
  const conventions = sortedById(input.snapshot.conventions)
    .filter((item) => scopedIds.conventions.size === 0 || scopedIds.conventions.has(item.id))
    .slice(0, input.limit);
  const findings = [...input.snapshot.findings]
    .filter((finding) => input.files.length === 0 || (finding.file ? input.files.includes(finding.file) : false))
    .sort((left, right) => (left.file ?? "").localeCompare(right.file ?? "") || (left.line ?? 0) - (right.line ?? 0) || left.id.localeCompare(right.id))
    .slice(0, input.limit);
  const events = input.events
    .filter((event) => input.changeIds.length === 0 || event.changeIds.some((id) => input.changeIds.includes(id)))
    .slice(0, input.limit);
  const checkCount = changes.reduce((total, change) => total + change.checks.length, 0);
  const readyTasks = changes.flatMap((change) => change.tasks.filter((task) => task.ready).map((task) => ({ change, task })));
  const xml = [
    `<opencanon-context schema="opencanon.context-packet.v1" mode="${xmlAttr(input.mode)}" generated-at="${xmlAttr(generatedAt)}">`,
    `  <project root="${xmlAttr(input.rootDir)}" health="${xmlAttr(input.snapshot.health.status)}" doctor="${xmlAttr(input.doctorStatus)}" />`,
    `  <filters limit="${input.limit}">`,
    ...input.files.map((file) => `    <file path="${xmlAttr(file)}" />`),
    ...input.changeIds.map((id) => `    <change id="${xmlAttr(id)}" />`),
    `  </filters>`,
    `  <search-index status="${xmlAttr(semanticIndex?.status ?? "unknown")}" chunks="${semanticIndex?.chunkCount ?? 0}" stale="${semanticIndex?.staleChunkCount ?? 0}" embedded="${semanticIndex?.embeddingStats?.embeddedChunks ?? 0}" reused="${semanticIndex?.embeddingStats?.reusedChunks ?? 0}" model="${xmlAttr(semanticIndex?.provider.modelId ?? "unknown")}" />`,
    `  <definitions areas="${areas.length}" specs="${specs.length}" changes="${changes.length}" conventions="${conventions.length}" />`,
    `  <areas>`,
    ...areas.map((item) => `    <area id="${xmlAttr(item.id)}" title="${xmlAttr(item.title)}" checks="${item.checks.length}">${xmlText(item.summary)}</area>`),
    `  </areas>`,
    `  <specs>`,
    ...specs.map((item) => `    <spec id="${xmlAttr(item.id)}" title="${xmlAttr(item.title)}" rules="${item.ruleCount}" scenarios="${item.scenarioCount}">${xmlText(item.summary)}</spec>`),
    `  </specs>`,
  `  <changes>`,
    ...changes.map((item) => [
      `    <item id="${xmlAttr(item.id)}" title="${xmlAttr(item.title)}" column="${xmlAttr(item.boardColumn)}" checks="${item.checks.length}">`,
      `      <intent problem="${xmlAttr(item.intent.problem)}" outcome="${xmlAttr(item.intent.outcome)}" />`,
      item.tasks.length > 0 ? `      <tasks ready="${item.readyTaskCount}" blocked="${item.blockedTaskCount}">` : undefined,
      ...item.tasks.map((task) => [
        `        <task id="${xmlAttr(task.id)}" title="${xmlAttr(task.title)}" status="${xmlAttr(task.status)}" ready="${task.ready ? "true" : "false"}" checks="${task.checks.length}">`,
        ...task.files.map((file) => `          <file path="${xmlAttr(file)}" />`),
        ...task.surfaces.map((surfaceId) => `          <surface id="${xmlAttr(surfaceId)}" />`),
        ...task.updates.areas.map((id) => `          <updates kind="area" id="${xmlAttr(id)}" />`),
        ...task.updates.specs.map((id) => `          <updates kind="spec" id="${xmlAttr(id)}" />`),
        ...task.updates.conventions.map((id) => `          <updates kind="convention" id="${xmlAttr(id)}" />`),
        ...task.updates.surfaces.map((id) => `          <updates kind="surface" id="${xmlAttr(id)}" />`),
        ...task.dependsOn.map((id) => `          <depends-on task="${xmlAttr(id)}" />`),
        ...task.blockedReasons.map((reason) => `          <blocked-reason>${xmlText(reason)}</blocked-reason>`),
        `        </task>`,
      ].join("\n")),
      item.tasks.length > 0 ? `      </tasks>` : undefined,
      item.lastEvent ? `      <latest-event type="${xmlAttr(item.lastEvent.type)}" at="${xmlAttr(item.lastEvent.timestamp)}">${xmlText(item.lastEvent.summary)}</latest-event>` : undefined,
      `    </item>`,
    ].filter(Boolean).join("\n")),
    `  </changes>`,
    `  <ready-work>`,
    ...readyTasks.map(({ change, task }) => [
      `    <task change="${xmlAttr(change.id)}" id="${xmlAttr(task.id)}" title="${xmlAttr(task.title)}" checks="${task.checks.length}">`,
      ...task.files.map((file) => `      <file path="${xmlAttr(file)}" />`),
      ...task.surfaces.map((surfaceId) => `      <surface id="${xmlAttr(surfaceId)}" />`),
      ...task.checks.map((checkId) => `      <check id="${xmlAttr(checkId)}" />`),
      `      <summary>${xmlText(task.detail ?? task.title)}</summary>`,
      `    </task>`,
    ].join("\n")),
    `  </ready-work>`,
    `  <conventions>`,
    ...conventions.map((item) => `    <convention id="${xmlAttr(item.id)}" title="${xmlAttr(item.title)}" runtime="${xmlAttr(item.runtime)}" render="${xmlAttr(item.render)}">${xmlText(item.rule)}</convention>`),
    `  </conventions>`,
    `  <findings>`,
    ...findings.map((item) => `    <finding id="${xmlAttr(item.id)}" severity="${xmlAttr(item.severity)}" file="${xmlAttr(item.file ?? "project")}" line="${item.line ?? 0}">${xmlText(item.message)}</finding>`),
    `  </findings>`,
    `  <events>`,
    ...events.map((item) => `    <event id="${xmlAttr(item.id)}" type="${xmlAttr(item.type)}" at="${xmlAttr(item.timestamp)}">${xmlText(item.summary)}</event>`),
    `  </events>`,
    `</opencanon-context>`,
  ].join("\n");
  return {
    schema: "opencanon.context-packet.v1" as const,
    mode: input.mode,
    generatedAt,
    rootDir: input.rootDir,
    filters: {
      files: input.files,
      changeIds: input.changeIds,
      limit: input.limit,
    },
    xml,
    facts: {
      files: input.files.length || input.snapshot.files.length,
      conventions: conventions.length,
      areas: areas.length,
      specs: specs.length,
      changes: changes.length,
      checks: checkCount,
      readyTasks: readyTasks.length,
      findings: findings.length,
      doctorStatus: input.doctorStatus,
      semanticIndexStatus: semanticIndex?.status ?? "unknown",
      semanticIndexEmbeddedChunks: semanticIndex?.embeddingStats?.embeddedChunks ?? 0,
      semanticIndexReusedChunks: semanticIndex?.embeddingStats?.reusedChunks ?? 0,
    },
  };
}

function scopedDefinitionIds(snapshot: RuntimeSnapshot, files: string[]) {
  const areas = new Set<string>();
  const specs = new Set<string>();
  const changes = new Set<string>();
  const conventions = new Set<string>();
  for (const file of files) {
    const coverage = snapshot.definitionGraph.fileCoverage[file];
    if (!coverage) continue;
    coverage.areas.forEach((id) => areas.add(id));
    coverage.specs.forEach((id) => specs.add(id));
    coverage.changes.forEach((id) => changes.add(id));
    coverage.conventions.forEach((id) => conventions.add(id));
  }
  return { areas, specs, changes, conventions };
}

function sortedById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, "&quot;");
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

