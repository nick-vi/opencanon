import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveInsideRoot } from "@opencanon/core";
import { daemonAuthCookieHeader, isAuthorizedDaemonRequest } from "./auth.ts";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const uiTextEncoding = "utf8";
const UiTokenParam = "token";

export function serveUiAsset(request: Request, url: URL, authToken: string, remoteUiRequiresToken: boolean): Response {
  const dist = resolveUiDist();
  if (!existsSync(dist)) {
    return new Response("OpenCanon UI is not built or bundled. Run bun run build:skill.", {
      status: 503,
    });
  }
  const requested = url.pathname === "/" ? "index.html" : decodePathname(url.pathname.slice(1));
  if (requested === null) return new Response("Invalid asset path.", { status: 400 });
  const resolved = resolveInsideRoot(dist, requested);
  if (!resolved.ok) return new Response("Invalid asset path.", { status: 400 });
  const file = resolved.absolutePath;
  if (!existsSync(file) || !statSync(file).isFile()) return new Response("Asset not found.", { status: 404 });
  const isIndex = path.basename(file) === "index.html";
  const authorized = isAuthorizedDaemonRequest(request, url, authToken, { allowQueryToken: isIndex });
  if (remoteUiRequiresToken && !authorized) return new Response("Daemon authorization is required.", { status: 401 });

  if (isIndex) {
    if (url.searchParams.has(UiTokenParam)) {
      if (!authorized) {
        return new Response("Daemon authorization is required.", { status: 401 });
      }
      return redirectWithoutToken(url, authToken);
    }
    return new Response(readFileSync(file, uiTextEncoding), {
      headers: {
        "cache-control": "no-store, private",
        "content-type": "text/html; charset=utf-8",
        "set-cookie": daemonAuthCookieHeader(authToken, url.protocol === "https:"),
      },
    });
  }

  const response = new Response(Bun.file(file));
  response.headers.set("cache-control", "private, max-age=31536000, immutable");
  response.headers.set("cross-origin-resource-policy", "same-origin");
  return response;
}

function redirectWithoutToken(url: URL, authToken: string): Response {
  const clean = new URL(url);
  clean.searchParams.delete(UiTokenParam);
  const location = `${clean.pathname}${clean.search}${clean.hash}`;
  return new Response(null, {
    status: 302,
    headers: {
      "cache-control": "no-store, private",
      location,
      "set-cookie": daemonAuthCookieHeader(authToken, url.protocol === "https:"),
    },
  });
}

function decodePathname(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function resolveUiDist(): string {
  const candidates = [
    path.resolve(packageDir, "..", "ui", "dist"),
    path.resolve(packageDir, "runtime", "ui"),
    path.resolve(fileURLToPath(new URL(".", import.meta.url)), "ui"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
