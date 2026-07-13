import { randomUUID } from "node:crypto";
import { defaultRuntimeNamespace, runtimeNamespaceForRegistry, validateRuntimeNamespace } from "./service-namespace.ts";

const RuntimeProcessEnv = {
  LeaseId: "OPENCANON_RUNTIME_LEASE_ID",
  RegistryPath: "OPENCANON_SERVICE_REGISTRY_PATH",
  PipeEndpoint: "OPENCANON_RUNTIME_PIPE_ENDPOINT",
  RuntimeNamespace: "OPENCANON_RUNTIME_NAMESPACE",
} as const;

export function readRuntimeProcessEnvironment(environment: NodeJS.ProcessEnv = process.env): {
  leaseId: string;
  registryPath?: string;
  pipeEndpoint?: string;
  runtimeNamespace: string;
} {
  const registryPath = environment[RuntimeProcessEnv.RegistryPath]?.trim() || undefined;
  const configuredNamespace = environment[RuntimeProcessEnv.RuntimeNamespace]?.trim();
  return {
    leaseId: environment[RuntimeProcessEnv.LeaseId]?.trim() || randomUUID(),
    ...(registryPath ? { registryPath } : {}),
    ...(environment[RuntimeProcessEnv.PipeEndpoint]?.trim()
      ? { pipeEndpoint: environment[RuntimeProcessEnv.PipeEndpoint]!.trim() }
      : {}),
    runtimeNamespace: configuredNamespace
      ? validateRuntimeNamespace(configuredNamespace)
      : registryPath
        ? runtimeNamespaceForRegistry(registryPath)
        : defaultRuntimeNamespace(),
  };
}
