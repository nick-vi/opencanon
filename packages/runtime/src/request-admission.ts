import { ApiRoute, diagnosticCodes, diagnosticsFailure, json } from "./routes.ts";
import { isAuthorizedRuntimeRequest } from "./auth.ts";

export type RuntimeRequestAdmissionResult =
  | { ok: true; release(): void }
  | { ok: false; response: Response };

export type RuntimeRequestAdmission = {
  admit(request: Request): RuntimeRequestAdmissionResult;
};

export const FullSnapshotRequestCapacity = 1;

/** Bounds heavyweight response bodies across every local transport. The lease is
 * released by the transport only after the response body has been delivered. */
export function createRuntimeRequestAdmission(
  options: { authToken?: string; capacity?: number } = {},
): RuntimeRequestAdmission {
  const capacity = options.capacity ?? FullSnapshotRequestCapacity;
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new Error("Runtime request capacity must be a positive integer.");
  }

  let activeFullSnapshots = 0;
  return {
    admit(request) {
      const url = new URL(request.url);
      if (url.pathname !== ApiRoute.Snapshot || (options.authToken && !isAuthorizedRuntimeRequest(request, url, options.authToken))) {
        return { ok: true, release() {} };
      }
      if (activeFullSnapshots >= capacity) {
        return {
          ok: false,
          response: json(
            diagnosticsFailure(
              [
                {
                  code: diagnosticCodes.requestCapacityExceeded,
                  message: "The full project snapshot is already being delivered.",
                  action: "Wait for the active snapshot request to finish, or use a bounded project, canon, context, or state route.",
                },
              ],
              diagnosticCodes.requestCapacityExceeded,
            ),
            429,
          ),
        };
      }

      activeFullSnapshots += 1;
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          activeFullSnapshots -= 1;
        },
      };
    },
  };
}
