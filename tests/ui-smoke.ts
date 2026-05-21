import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { daemonAuthHeaders, startOpenCanonDaemon } from "@opencanon/daemon";

const statePath = path.join(process.cwd(), ".opencanon", "state.sqlite");
const watchedFile = path.join(process.cwd(), "tests/unit/company.test.ts");
const linkedFile = path.join(process.cwd(), "tests/opencanon-outside-link.generated.txt");
const outsideDir = mkdtempSync(path.join(tmpdir(), "opencanon-ui-smoke-outside-"));
const outsideFile = path.join(outsideDir, "secret.txt");
for (const file of [statePath, `${statePath}-wal`, `${statePath}-shm`]) rmSync(file, { force: true });
rmSync(linkedFile, { force: true });
const watchedFileOriginal = readFileSync(watchedFile, "utf8");
writeFileSync(outsideFile, "secret\n");
symlinkSync(outsideFile, linkedFile);

const server = await startOpenCanonDaemon({
  cwd: process.cwd(),
  host: "127.0.0.1",
  port: 0,
});

const browser = await chromium.launch({ headless: true });

try {
  const healthResponse = await fetch(`${server.url}/api/health`);
  const healthBody = (await healthResponse.json()) as { ok: boolean; data?: { watcher?: { running: boolean } } };
  assert.equal(healthBody.data?.watcher?.running, true);
  const escapedRead = await fetch(`${server.url}/api/fs/file?path=${encodeURIComponent("tests/opencanon-outside-link.generated.txt")}`, {
    headers: daemonAuthHeaders(server.authToken),
  });
  assert.equal(escapedRead.status, 400);
  const validation = await postJson<{ findingCount: number; files: string[] }>(server.url, server.authToken, "/api/validate", {
    files: ["packages/daemon/src/server.ts"],
    validatorIds: ["no-native-enums"],
  });
  assert.deepEqual(validation.files, ["packages/daemon/src/server.ts"]);
  assert.equal(validation.findingCount, 0);

  const feedback = await postJson<{ host: string; files: string[]; diagnostics: string[] }>(server.url, server.authToken, "/api/feedback", {
    files: ["packages/daemon/src/server.ts"],
    host: "manual",
  });
  assert.equal(feedback.host, "manual");
  assert.deepEqual(feedback.files, ["packages/daemon/src/server.ts"]);
  assert.deepEqual(feedback.diagnostics, []);

  const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1 });
  await page.goto(server.url, { waitUntil: "domcontentloaded" });
  await page.locator(".workbench").waitFor({ timeout: 10_000 });
  assert.equal(await page.locator('link[rel="icon"][href="/opencanon-mark.svg"]').count(), 1);
  assert.equal(await page.locator(".topProjectIcon").count(), 0);
  await page.locator(".topBrand .openCanonMark").waitFor({ timeout: 5_000 });
  await page.locator(".statusBar", { hasText: "live: connected" }).waitFor({ timeout: 10_000 });
  const inspectorTabTexts = await page.locator(".inspectorTab").evaluateAll((nodes) => nodes.map((node) => (node.textContent ?? "").trim()));
  assert(inspectorTabTexts.length >= 3);
  assert(inspectorTabTexts.every((text) => /^\d+$/.test(text)), JSON.stringify(inspectorTabTexts));
  const columnBorders = await page.evaluate(() => {
    const codePane = document.querySelector(".codePane");
    const inspector = document.querySelector(".inspector");
    return {
      codePaneBorderRight: codePane ? getComputedStyle(codePane).borderRightWidth : null,
      inspectorBorderLeft: inspector ? getComputedStyle(inspector).borderLeftWidth : null,
    };
  });
  assert.deepEqual(columnBorders, { codePaneBorderRight: "1px", inspectorBorderLeft: "0px" });

  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: /Project settings/ }).click();
  await page.locator(".paneTitle", { hasText: "Project settings" }).waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "Back to workbench" }).click();
  await page.locator(".workbench").waitFor({ timeout: 5_000 });

  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: /Validator Studio/ }).click();
  await page.locator(".paneTitle", { hasText: "Validator Studio" }).waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "Preview" }).click();
  await page.locator(".studioSourcePreview", { hasText: "const validator" }).waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "Back to workbench" }).click();
  await page.locator(".workbench").waitFor({ timeout: 5_000 });

  await page.getByRole("button", { name: "Project menu" }).click();
  await page.getByRole("menuitem", { name: /Project switcher/ }).click();
  await page.locator(".paneTitle", { hasText: "Project switcher" }).waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "Back to workbench" }).click();
  await page.locator(".workbench").waitFor({ timeout: 5_000 });

  assert.equal(await page.locator(".treeStatusKey", { hasText: "canon" }).count(), 1);
  assert((await page.getByRole("button", { name: /\.agents/ }).count()) > 0);
  await page
    .locator('.treeRow [data-vscode-icon="folder_type_src.svg"] svg[viewBox="0 0 32 32"]')
    .first()
    .waitFor({ timeout: 5_000 });
  const folderIconBox = await page.locator('.treeRow [data-vscode-icon="folder_type_src.svg"] use').first().evaluate((node) => {
    const box = (node as SVGUseElement).getBBox();
    return { height: box.height, width: box.width };
  });
  assert(folderIconBox.width > 0 && folderIconBox.height > 0);
  const treeControlHeights = await page.evaluate(() =>
    [...document.querySelectorAll(".treeViewTabs, .treeToolButton, .treeSearch, .treeScopeControl")]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.offsetParent !== null)
      .map((node) => Math.round(node.getBoundingClientRect().height)),
  );
  assert(treeControlHeights.length >= 5);
  assert(Math.max(...treeControlHeights) - Math.min(...treeControlHeights) <= 1, JSON.stringify(treeControlHeights));

  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByLabel("Search files").fill("ui-vscode");
  await page.locator(".searchResultRow", { hasText: "ui-vscode-icons.test.ts" }).first().waitFor({ timeout: 5_000 });
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByLabel("Filter files").fill("");
  await page.getByRole("button", { name: "Expand all" }).click();
  await page.getByLabel("Filter files").fill(".agents/skills/opencanon/references");
  await page.locator('.treeRow-dir[title^=".agents/skills/opencanon/references"]').waitFor({ timeout: 5_000 });
  await page.getByLabel("Filter files").fill("");
  await page.getByRole("button", { name: "Collapse all" }).click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.treeRow-dir[title^=".agents/skills/opencanon/references"]').count(), 0);

  await page.getByRole("button", { name: /\.agents/ }).click();
  await page.locator('.treeRow-dir[title^=".agents/skills/opencanon/references"]').waitFor({ timeout: 5_000 });

  await page.getByRole("button", { name: "Canon", exact: true }).click();
  await page.waitForTimeout(250);
  assert((await page.getByRole("button", { name: /\.agents/ }).count()) > 0);

  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("button", { name: "Hide dot entries", exact: true }).click();
  await page.waitForTimeout(250);
  assert.equal(await page.getByRole("button", { name: /\.agents/ }).count(), 0);
  await page.getByRole("button", { name: "Show dot entries", exact: true }).click();

  const tooltipSmokeFile = "tests/ui-smoke.ts";
  await page.getByLabel("Filter files").fill(tooltipSmokeFile);
  await page.getByRole("button", { name: /ui-smoke\.ts/ }).click();
  await page.locator(".cm-editor").waitFor({ timeout: 5_000 });
  const factsReady = await pollSnapshot(
    server.url,
    server.authToken,
    (snapshot) => snapshot.facts?.some((file) => file.path === tooltipSmokeFile && file.imports?.some((importFact) => importFact.source === "@opencanon/daemon")) ?? false,
    10_000,
  );
  assert.equal(factsReady, true);
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.locator(".cm-line", { hasText: "@opencanon/daemon" }).first().waitFor({ timeout: 5_000 });
  const codeRenderMetrics = await page.locator(".cm-editor").evaluate((node) => {
    const editorStyle = getComputedStyle(node as HTMLElement);
    const line = node.querySelector(".cm-line");
    const lineStyle = line instanceof HTMLElement ? getComputedStyle(line) : editorStyle;
    return { fontSize: editorStyle.fontSize, lineHeight: lineStyle.lineHeight };
  });
  await page.locator('.treeRow.selected [data-vscode-icon="file_type_typescript.svg"]').waitFor({ timeout: 5_000 });

  const importLine = page.locator(".cm-line", { hasText: "@opencanon/daemon" }).first();
  const importBox = await importLine.boundingBox();
  assert(importBox);
  const tooltip = page.locator(".opencanonTooltip");
  const hoverOffsets = [Math.min(importBox.width - 24, 360), Math.min(importBox.width - 24, 220), 80];
  for (const [index, xOffset] of hoverOffsets.entries()) {
    await page.mouse.move(importBox.x + xOffset, importBox.y + importBox.height / 2);
    try {
      await tooltip.waitFor({ timeout: 5_000 });
      break;
    } catch (error) {
      if (index === hoverOffsets.length - 1) throw error;
    }
  }

  await page.getByLabel("Filter files").fill("README.md");
  await page.locator('.treeRow[title="README.md"]').click();
  await page.locator('.inspectorTab[aria-label="History"]').click();
  await page.locator(".historyList button").first().click();
  await page.locator(".diffRenderSurface").waitFor({ timeout: 8_000 });
  await page.locator("[data-diff-file-path='README.md']").waitFor({ timeout: 8_000 });
  await page.locator('[data-diff-file-path="README.md"] [data-diff-renderer="codemirror-split"]').waitFor({ timeout: 8_000 });
  await page.locator('[data-diff-file-path="README.md"] .cm-line').first().waitFor({ timeout: 8_000 });
  const diffControlText = await page.locator(".diffModeControl").evaluate((node) => (node.textContent ?? "").trim());
  assert.equal(diffControlText, "");
  const diffRenderMetrics = await page.locator('[data-diff-file-path="README.md"] .cm-editor').first().evaluate((node) => {
    const style = getComputedStyle(node as HTMLElement);
    const line = node.querySelector(".cm-line");
    const lineStyle = line instanceof HTMLElement ? getComputedStyle(line) : style;
    return { fontSize: style.fontSize, lineHeight: lineStyle.lineHeight };
  });
  assert(Math.abs(Number.parseFloat(codeRenderMetrics.fontSize) - Number.parseFloat(diffRenderMetrics.fontSize)) <= 0.5);
  assert(Math.abs(Number.parseFloat(codeRenderMetrics.lineHeight) - Number.parseFloat(diffRenderMetrics.lineHeight)) <= 0.5);
  await page.getByRole("button", { name: "Unified", exact: true }).click();
  await page.locator('[data-diff-file-path="README.md"] [data-diff-renderer="codemirror-unified"]').waitFor({ timeout: 8_000 });
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await page.locator('[data-diff-file-path="README.md"] [data-diff-renderer="codemirror-split"]').waitFor({ timeout: 8_000 });
  await page.getByRole("button", { name: "Current" }).click();
  await page.getByRole("button", { name: "Source" }).click();
  await page.locator(".cm-editor").waitFor({ timeout: 5_000 });
  await page.locator('.treeRow.selected [data-vscode-icon="file_type_markdown.svg"]').waitFor({ timeout: 5_000 });

  const streamReceived = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => {
          controller.abort();
          resolve(false);
        }, 5_000);
        void fetch("/api/events/stream", {
          signal: controller.signal,
        })
          .then(async (response) => {
            const reader = response.body?.getReader();
            if (!reader) return false;
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) return false;
              buffer += decoder.decode(value, { stream: true });
              const eventEnd = buffer.indexOf("\n\n");
              if (eventEnd === -1) continue;
              const event = buffer.slice(0, eventEnd);
              const data = event
                .split(/\r?\n/)
                .find((line) => line.startsWith("data:"))
                ?.slice("data:".length)
                .trim();
              if (!event.includes("event: snapshot") || !data) continue;
              const payload = JSON.parse(data) as { snapshot?: unknown };
              return Boolean(payload.snapshot);
            }
          })
          .then((ok) => {
            window.clearTimeout(timeout);
            controller.abort();
            resolve(Boolean(ok));
          })
          .catch(() => {
            window.clearTimeout(timeout);
            resolve(false);
          });
      }),
  );
  assert.equal(streamReceived, true);

  const beforeWatch = await getSnapshot(server.url, server.authToken);
  writeFileSync(watchedFile, `${watchedFileOriginal}\nexport const opencanonWatchSmoke = true;\n`);
  await postJson<PollSnapshot>(server.url, server.authToken, "/api/index", {});
  const reindexed = await pollSnapshot(
    server.url,
    server.authToken,
    (snapshot) => snapshot.graph.graphHash !== beforeWatch.graph.graphHash && snapshot.files.includes("tests/unit/company.test.ts"),
    20_000,
  );
  assert.equal(reindexed, true);

  await page.screenshot({ path: "tmp/ui-smoke.png", fullPage: false });
} finally {
  writeFileSync(watchedFile, watchedFileOriginal);
  rmSync(linkedFile, { force: true });
  rmSync(outsideDir, { recursive: true, force: true });
  await browser.close();
  await server.stop();
}

type PollSnapshot = {
  files: string[];
  graph: { graphHash: string };
  facts?: Array<{ path: string; imports?: Array<{ source: string }> }>;
};

async function getSnapshot(serverUrl: string, authToken: string): Promise<PollSnapshot> {
  const response = await fetch(`${serverUrl}/api/snapshot`, { headers: daemonAuthHeaders(authToken) });
  const body = (await response.json()) as { ok: boolean; data?: PollSnapshot };
  if (!body.ok || !body.data) throw new Error("Could not read daemon snapshot.");
  return body.data;
}

async function pollSnapshot(serverUrl: string, authToken: string, predicate: (snapshot: PollSnapshot) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getSnapshot(serverUrl, authToken);
    if (predicate(snapshot)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function postJson<T>(baseUrl: string, authToken: string, route: string, body: unknown): Promise<T> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { ...daemonAuthHeaders(authToken), "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as { ok: boolean; data?: T; diagnostics?: unknown[] };
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true, JSON.stringify(payload.diagnostics));
  return payload.data as T;
}
