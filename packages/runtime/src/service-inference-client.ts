import { randomUUID } from "node:crypto";
import type {
  InferenceCountTokensResult,
  InferenceEmbedResult,
  InferencePriority,
  InferenceTaskKind,
} from "@opencanon/service-contracts";
import { localProtocolEndpointFromEntry, requestLocalJson } from "./local-protocol.ts";
import { readServiceEntry } from "./service-storage.ts";
import { ServiceApiRoute } from "./service-types.ts";

const ClientDeadlineMs = 10 * 60_000;

export type ServiceInferenceClient = {
  countTokens(input: InferenceClientRequest): Promise<InferenceCountTokensResult>;
  embed(input: InferenceClientRequest): Promise<InferenceEmbedResult>;
};

export type InferenceClientRequest = {
  rootDir: string;
  modelId: string;
  task: InferenceTaskKind;
  priority: InferencePriority;
  texts: string[];
  expectedModelDigest?: string;
  signal?: AbortSignal;
};

export function createServiceInferenceClient(registryPath: string | undefined): ServiceInferenceClient {
  return {
    countTokens(input) {
      return requestInference<InferenceCountTokensResult>(ServiceApiRoute.InferenceCountTokens, input);
    },
    embed(input) {
      return requestInference<InferenceEmbedResult>(ServiceApiRoute.InferenceEmbed, input);
    },
  };

  async function requestInference<T>(route: string, input: InferenceClientRequest): Promise<T> {
    if (!registryPath) throw new Error("Project Knowledge inference requires a project runtime managed by the OpenCanon service.");
    const service = readServiceEntry(registryPath);
    if (!service) throw new Error("OpenCanon service is not running; Project Knowledge inference is unavailable.");
    const endpoint = localProtocolEndpointFromEntry(service);
    const operationId = randomUUID();
    const body = {
      operationId,
      rootDir: input.rootDir,
      modelId: input.modelId,
      task: input.task,
      priority: input.priority,
      texts: input.texts,
      ...(input.expectedModelDigest ? { expectedModelDigest: input.expectedModelDigest } : {}),
      deadlineAt: new Date(Date.now() + ClientDeadlineMs).toISOString(),
    };
    const cancel = () => {
      void requestLocalJson(endpoint, {
        method: "POST",
        path: ServiceApiRoute.InferenceCancel,
        body: { operationId, rootDir: input.rootDir },
        timeoutMs: 2_000,
      }).catch(() => undefined);
    };
    input.signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await requestLocalJson<T>(endpoint, {
        method: "POST",
        path: route,
        body,
        signal: input.signal,
        timeoutMs: ClientDeadlineMs,
      });
    } finally {
      input.signal?.removeEventListener("abort", cancel);
    }
  }
}
