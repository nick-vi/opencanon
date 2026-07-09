export const SemanticEmbeddingProviderKind = {
  Native: "native",
} as const;
export type SemanticEmbeddingProviderKind = (typeof SemanticEmbeddingProviderKind)[keyof typeof SemanticEmbeddingProviderKind];

export type SemanticEmbeddingConfig = {
  mode: SemanticEmbeddingProviderKind;
  modelId: SemanticEmbeddingModelId;
  nGpuLayers?: number;
  nThreads?: number;
  nCtx?: number;
  showDownloadProgress: boolean;
};

export type SemanticEmbeddingModelDefinition = {
  id: string;
  providerKind: SemanticEmbeddingProviderKind;
  displayName: string;
  dimensions: number;
  contextLength: number;
  distance: "cosine";
  config: Record<string, string | number | boolean>;
};

export const SemanticEmbeddingModelId = {
  JinaCodeV2: "jina-code-v2",
  JinaCodeV2Large: "jina-code-v2-large",
  Qwen3Embed: "qwen3-embed",
} as const;
export type SemanticEmbeddingModelId = (typeof SemanticEmbeddingModelId)[keyof typeof SemanticEmbeddingModelId];

export const SemanticEmbeddingModels = {
  [SemanticEmbeddingModelId.JinaCodeV2]: {
    id: SemanticEmbeddingModelId.JinaCodeV2,
    providerKind: SemanticEmbeddingProviderKind.Native,
    displayName: "Jina Code v2",
    dimensions: 896,
    contextLength: 8192,
    distance: "cosine",
    config: {
      filename: "jina-code-embeddings-0.5b-IQ4_XS.gguf",
      isCodeModel: true,
      repoId: "jinaai/jina-code-embeddings-0.5b-GGUF",
    },
  },
  [SemanticEmbeddingModelId.JinaCodeV2Large]: {
    id: SemanticEmbeddingModelId.JinaCodeV2Large,
    providerKind: SemanticEmbeddingProviderKind.Native,
    displayName: "Jina Code v2 Large",
    dimensions: 1536,
    contextLength: 8192,
    distance: "cosine",
    config: {
      filename: "jina-code-embeddings-1.5b-IQ4_XS.gguf",
      isCodeModel: true,
      repoId: "jinaai/jina-code-embeddings-1.5b-GGUF",
    },
  },
  [SemanticEmbeddingModelId.Qwen3Embed]: {
    id: SemanticEmbeddingModelId.Qwen3Embed,
    providerKind: SemanticEmbeddingProviderKind.Native,
    displayName: "Qwen3 Embed",
    dimensions: 1024,
    contextLength: 8192,
    distance: "cosine",
    config: {
      filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      isCodeModel: false,
      repoId: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    },
  },
} as const satisfies Record<SemanticEmbeddingModelId, SemanticEmbeddingModelDefinition>;

export const DefaultSemanticEmbeddingModelId = SemanticEmbeddingModelId.JinaCodeV2;
export const DefaultNativeSemanticEmbeddingModelId = SemanticEmbeddingModelId.JinaCodeV2;

export const DefaultSemanticEmbeddingConfig = {
  mode: SemanticEmbeddingProviderKind.Native,
  modelId: DefaultSemanticEmbeddingModelId,
  showDownloadProgress: true,
} as const satisfies SemanticEmbeddingConfig;

export function semanticEmbeddingModel(id: SemanticEmbeddingModelId = DefaultSemanticEmbeddingModelId): SemanticEmbeddingModelDefinition {
  return SemanticEmbeddingModels[id];
}

export function semanticEmbeddingModelIds(): SemanticEmbeddingModelId[] {
  return Object.keys(SemanticEmbeddingModels) as SemanticEmbeddingModelId[];
}
