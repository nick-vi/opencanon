import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import {
  InferenceBackendKind,
  MaximumInferenceBatchSequences,
  MaximumInferenceRequestBytes,
  InferenceProviderKind,
  type InferenceExecutionPolicy,
  type InferenceExecutionProfile,
} from "@opencanon/service-contracts";
import { PlatformName } from "./service-types.ts";

const RuntimeArchitecture = {
  Arm64: "arm64",
} as const;

export type MachineInferenceConfiguration = {
  profile: InferenceExecutionProfile;
  policy: InferenceExecutionPolicy;
  source: "default" | "file";
  path: string;
};

export function inferencePolicyPath(registryPath: string): string {
  return path.join(path.dirname(registryPath), "inference-policy.json");
}

export function loadMachineInferenceConfiguration(registryPath: string): MachineInferenceConfiguration {
  const file = inferencePolicyPath(registryPath);
  if (!existsSync(file)) return { ...defaultMachineInferenceConfiguration(), source: "default", path: file };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Could not read machine inference policy ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseMachineInferenceConfiguration(value);
  return { ...parsed, source: "file", path: file };
}

export function defaultMachineInferenceConfiguration(): Pick<MachineInferenceConfiguration, "profile" | "policy"> {
  const metal = process.platform === PlatformName.Darwin && process.arch === RuntimeArchitecture.Arm64;
  const profile: InferenceExecutionProfile = {
    id: metal ? "metal-balanced-v1" : "cpu-balanced-v1",
    provider: InferenceProviderKind.Gguf,
    backend: metal ? InferenceBackendKind.Metal : InferenceBackendKind.Cpu,
    contextTokens: 2048,
    batchTokens: 2048,
    microBatchTokens: 512,
    maximumSequences: MaximumInferenceBatchSequences,
    threads: Math.max(1, Math.min(8, availableParallelism())),
    gpuLayers: metal ? 4_294_967_295 : 0,
  };
  return {
    profile,
    policy: {
      version: 1,
      profileId: profile.id,
      maximumRequestBytes: MaximumInferenceRequestBytes,
      maximumQueueRequests: 64,
      maximumQueueBytes: 8 * 1024 * 1024,
      maximumRequestTokens: 65_536,
      maximumConcurrentOperations: 1,
      maximumResidentModels: 1,
      idleEvictionMs: 60_000,
      requestTimeoutMs: 5 * 60_000,
      hostStartupTimeoutMs: 5 * 60_000,
    },
  };
}

export function parseMachineInferenceConfiguration(value: unknown): Pick<MachineInferenceConfiguration, "profile" | "policy"> {
  if (!isRecord(value) || !isRecord(value.profile) || !isRecord(value.policy)) {
    throw new Error("Machine inference policy must contain profile and policy objects.");
  }
  const profileRecord = value.profile;
  const policyRecord = value.policy;
  const profile: InferenceExecutionProfile = {
    id: requiredString(profileRecord.id, "profile.id"),
    provider: literal(profileRecord.provider, InferenceProviderKind.Gguf, "profile.provider"),
    backend: enumValue(profileRecord.backend, Object.values(InferenceBackendKind), "profile.backend"),
    contextTokens: positiveInteger(profileRecord.contextTokens, "profile.contextTokens"),
    batchTokens: positiveInteger(profileRecord.batchTokens, "profile.batchTokens"),
    microBatchTokens: positiveInteger(profileRecord.microBatchTokens, "profile.microBatchTokens"),
    maximumSequences: literal(profileRecord.maximumSequences, MaximumInferenceBatchSequences, "profile.maximumSequences"),
    threads: positiveInteger(profileRecord.threads, "profile.threads"),
    gpuLayers: nonNegativeInteger(profileRecord.gpuLayers, "profile.gpuLayers"),
  };
  const policy: InferenceExecutionPolicy = {
    version: literal(policyRecord.version, 1, "policy.version"),
    profileId: requiredString(policyRecord.profileId, "policy.profileId"),
    maximumRequestBytes: positiveInteger(policyRecord.maximumRequestBytes, "policy.maximumRequestBytes"),
    maximumQueueRequests: positiveInteger(policyRecord.maximumQueueRequests, "policy.maximumQueueRequests"),
    maximumQueueBytes: positiveInteger(policyRecord.maximumQueueBytes, "policy.maximumQueueBytes"),
    maximumRequestTokens: positiveInteger(policyRecord.maximumRequestTokens, "policy.maximumRequestTokens"),
    maximumConcurrentOperations: literal(policyRecord.maximumConcurrentOperations, 1, "policy.maximumConcurrentOperations"),
    maximumResidentModels: literal(policyRecord.maximumResidentModels, 1, "policy.maximumResidentModels"),
    idleEvictionMs: positiveInteger(policyRecord.idleEvictionMs, "policy.idleEvictionMs"),
    requestTimeoutMs: positiveInteger(policyRecord.requestTimeoutMs, "policy.requestTimeoutMs"),
    hostStartupTimeoutMs: positiveInteger(policyRecord.hostStartupTimeoutMs, "policy.hostStartupTimeoutMs"),
  };
  if (profile.batchTokens > profile.contextTokens) throw new Error("profile.batchTokens cannot exceed profile.contextTokens.");
  if (profile.microBatchTokens > profile.batchTokens) throw new Error("profile.microBatchTokens cannot exceed profile.batchTokens.");
  if (policy.profileId !== profile.id) throw new Error("policy.profileId must match profile.id.");
  if (policy.maximumRequestBytes > policy.maximumQueueBytes) throw new Error("policy.maximumRequestBytes cannot exceed policy.maximumQueueBytes.");
  if (policy.maximumRequestBytes > MaximumInferenceRequestBytes) {
    throw new Error(`policy.maximumRequestBytes cannot exceed the local transport limit of ${MaximumInferenceRequestBytes}.`);
  }
  return { profile, policy };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string.`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function literal<T extends string | number>(value: unknown, expected: T, name: string): T {
  if (value !== expected) throw new Error(`${name} must be ${String(expected)}.`);
  return expected;
}

function enumValue<T extends string>(value: unknown, expected: readonly T[], name: string): T {
  if (typeof value !== "string" || !expected.includes(value as T)) throw new Error(`${name} must be one of ${expected.join(", ")}.`);
  return value as T;
}
