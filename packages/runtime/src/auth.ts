import { randomBytes, timingSafeEqual } from "node:crypto";

const BearerPrefix = "Bearer ";
const RuntimeAuthCookie = "opencanon_runtime_token";

export function createRuntimeAuthToken(): string {
  return randomBytes(32).toString("hex");
}

export function runtimeAuthHeaders(authToken: string): Record<string, string> {
  return { authorization: `${BearerPrefix}${authToken}` };
}

export function runtimeAuthCookieHeader(authToken: string, secure: boolean): string {
  return [`${RuntimeAuthCookie}=${encodeURIComponent(authToken)}`, "Path=/", "HttpOnly", "SameSite=Strict", secure ? "Secure" : ""].filter(Boolean).join("; ");
}

export function usableRuntimeAuthToken(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token ? token : undefined;
}

export function isAuthorizedRuntimeRequest(request: Request, url: URL, authToken: string, options: { allowQueryToken?: boolean } = {}): boolean {
  if (!usableRuntimeAuthToken(authToken)) return false;
  const authorization = request.headers.get("authorization");
  if (authorization?.startsWith(BearerPrefix) && constantTimeEquals(authorization.slice(BearerPrefix.length), authToken)) return true;
  const cookieToken = runtimeAuthCookieToken(request);
  if (cookieToken && constantTimeEquals(cookieToken, authToken)) return true;
  if (!options.allowQueryToken) return false;
  const queryToken = url.searchParams.get("token");
  return queryToken !== null && constantTimeEquals(queryToken, authToken);
}

export function assertSafeRuntimeHost(host: string, allowRemote?: boolean): void {
  if (allowRemote || isLoopbackHost(host)) return;
  throw new Error(`Refusing to bind OpenCanon runtime to ${host}. Use --allow-remote only on trusted networks.`);
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

function runtimeAuthCookieToken(request: Request): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...valueParts] = part.trim().split("=");
    if (name !== RuntimeAuthCookie) continue;
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
