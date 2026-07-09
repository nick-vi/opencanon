import { createHash } from "node:crypto";

export const SemanticIndexVersion = "semantic-index-v2";
export const SemanticChunkerVersion = "opencanon-fact-semantic-chunker-v1";
export const SemanticEmbeddingProducerVersion = "opencanon-semantic-producer-v1";
export const DefaultSemanticIndexId = "project";

const SemanticHashAlgorithm = "sha256";
const HashEncoding = "hex";
const PreviewMaxLength = 240;

export type SemanticHashInput = string | number | boolean | null | undefined | SemanticHashInput[] | { readonly [key: string]: SemanticHashInput };

export function semanticStableHash(value: SemanticHashInput): string {
  return createHash(SemanticHashAlgorithm).update(stableStringify(value)).digest(HashEncoding);
}

export function semanticTextHash(text: string): string {
  return createHash(SemanticHashAlgorithm).update(text).digest(HashEncoding);
}

export function semanticEmbeddingConfigHash(value: SemanticHashInput): string {
  return semanticStableHash({
    version: SemanticIndexVersion,
    value,
  });
}

export function semanticEmbeddingIdentityHash(value: {
  providerId: string;
  modelId: string;
  modelDigest?: string | undefined;
  dimensions: number;
  configHash: string;
  chunkerVersion: string;
  producerVersion: string;
}): string {
  return semanticStableHash(value);
}

export function semanticEmbeddingRecordHash(value: {
  chunkHash: string;
  providerId: string;
  modelId: string;
  modelDigest?: string | undefined;
  dimensions: number;
  configHash: string;
  chunkerVersion: string;
  producerVersion: string;
}): string {
  return semanticStableHash(value);
}

export function createSemanticChunkId(input: { path: string; chunkHash: string; startByte: number; endByte: number; key?: string | undefined; ordinal?: number | undefined }): string {
  const hash = semanticStableHash({
    path: input.path,
    key: input.key ?? input.ordinal ?? 0,
    chunkHash: input.chunkHash,
    startByte: input.startByte,
    endByte: input.endByte,
  }).slice(0, 32);
  return `chunk:${hash}`;
}

export function semanticChunkTreeHash(
  chunks: Array<{
    metadata: {
      id: string;
      path: string;
      chunkHash: string;
      embeddingHash: string;
      range: { start: { byte: number }; end: { byte: number } };
    };
  }>,
): string {
  return semanticStableHash(
    chunks
      .map((chunk) => ({
        id: chunk.metadata.id,
        path: chunk.metadata.path,
        chunkHash: chunk.metadata.chunkHash,
        embeddingHash: chunk.metadata.embeddingHash,
        startByte: chunk.metadata.range.start.byte,
        endByte: chunk.metadata.range.end.byte,
      }))
      .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id)),
  );
}

export function semanticPreview(text: string, maxLength = PreviewMaxLength): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

export function estimateSemanticTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.max(1, Math.ceil(trimmed.split(/\s+/u).length * 1.35));
}

function stableStringify(value: SemanticHashInput): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}
