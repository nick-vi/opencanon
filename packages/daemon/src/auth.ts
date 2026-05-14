import { randomBytes, timingSafeEqual } from "node:crypto";

const BearerPrefix = "Bearer ";
const DaemonAuthCookie = "opencanon_daemon_token";

export function createDaemonAuthToken(): string {
  return randomBytes(32).toString("hex");
}

export function daemonAuthHeaders(authToken: string): Record<string, string> {
  return { authorization: `${BearerPrefix}${authToken}` };
}

export function daemonAuthCookieHeader(authToken: string, secure: boolean): string {
  return [`${DaemonAuthCookie}=${encodeURIComponent(authToken)}`, "Path=/", "HttpOnly", "SameSite=Strict", secure ? "Secure" : ""].filter(Boolean).join("; ");
}

export function usableDaemonAuthToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token ? token : undefined;
}

export function isAuthorizedDaemonRequest(request: Request, url: URL, authToken: string, options: { allowQueryToken?: boolean } = {}): boolean {
  if (!usableDaemonAuthToken(authToken)) return false;
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith(BearerPrefix) && constantTimeEquals(authorization.slice(BearerPrefix.length), authToken)) return true;
  const cookieToken = daemonAuthCookieToken(request);
  if (cookieToken && constantTimeEquals(cookieToken, authToken)) return true;
  if (!options.allowQueryToken) return false;
  const queryToken = url.searchParams.get("token");
  return queryToken !== null && constantTimeEquals(queryToken, authToken);
}

export function assertSafeDaemonHost(host: string, allowRemote?: boolean): void {
  if (allowRemote || isLoopbackHost(host)) return;
  throw new Error(`Refusing to bind OpenCanon daemon to ${host}. Use --allow-remote only on trusted networks.`);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function daemonAuthCookieToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== DaemonAuthCookie) continue;
    const value = valueParts.join("=");
    try {
      return value ? decodeURIComponent(value) : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}
