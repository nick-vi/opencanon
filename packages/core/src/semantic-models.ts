export const SemanticEmbeddingProviderKind = {
  Gguf: "gguf",
} as const;
export type SemanticEmbeddingProviderKind = (typeof SemanticEmbeddingProviderKind)[keyof typeof SemanticEmbeddingProviderKind];

export type SemanticEmbeddingConfig = {
  provider: SemanticEmbeddingProviderKind;
  modelId: SemanticEmbeddingModelId;
};

export type SemanticEmbeddingModelConfig = {
  chunkProfileId: string;
  documentPrefix: string;
  filename: string;
  isCodeModel: boolean;
  maximumInputTokens: number;
  pooling: "last";
  queryPrefix: string;
  repoId: string;
};

export type SemanticEmbeddingModelDefinition = {
  id: string;
  providerKind: SemanticEmbeddingProviderKind;
  displayName: string;
  dimensions: number;
  contextLength: number;
  distance: "cosine";
  config: SemanticEmbeddingModelConfig;
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
    providerKind: SemanticEmbeddingProviderKind.Gguf,
    displayName: "Jina Code v2",
    dimensions: 896,
    contextLength: 8192,
    distance: "cosine",
    config: {
      chunkProfileId: "code-512-v1",
      documentPrefix: "Candidate code snippet:\n",
      filename: "jina-code-embeddings-0.5b-IQ4_XS.gguf",
      isCodeModel: true,
      maximumInputTokens: 512,
      pooling: "last",
      queryPrefix: "Find the most relevant code snippet given the following query:\n",
      repoId: "jinaai/jina-code-embeddings-0.5b-GGUF",
    },
  },
  [SemanticEmbeddingModelId.JinaCodeV2Large]: {
    id: SemanticEmbeddingModelId.JinaCodeV2Large,
    providerKind: SemanticEmbeddingProviderKind.Gguf,
    displayName: "Jina Code v2 Large",
    dimensions: 1536,
    contextLength: 8192,
    distance: "cosine",
    config: {
      chunkProfileId: "code-512-v1",
      documentPrefix: "Candidate code snippet:\n",
      filename: "jina-code-embeddings-1.5b-IQ4_XS.gguf",
      isCodeModel: true,
      maximumInputTokens: 512,
      pooling: "last",
      queryPrefix: "Find the most relevant code snippet given the following query:\n",
      repoId: "jinaai/jina-code-embeddings-1.5b-GGUF",
    },
  },
  [SemanticEmbeddingModelId.Qwen3Embed]: {
    id: SemanticEmbeddingModelId.Qwen3Embed,
    providerKind: SemanticEmbeddingProviderKind.Gguf,
    displayName: "Qwen3 Embed",
    dimensions: 1024,
    contextLength: 8192,
    distance: "cosine",
    config: {
      chunkProfileId: "general-512-v1",
      documentPrefix: "",
      filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
      isCodeModel: false,
      maximumInputTokens: 512,
      pooling: "last",
      queryPrefix: "Instruct: Given a code search query, retrieve relevant code snippets that match the query\nQuery:",
      repoId: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    },
  },
} as const satisfies Record<SemanticEmbeddingModelId, SemanticEmbeddingModelDefinition>;

export const DefaultSemanticEmbeddingModelId = SemanticEmbeddingModelId.JinaCodeV2;
export const DefaultGgufSemanticEmbeddingModelId = SemanticEmbeddingModelId.JinaCodeV2;

export const DefaultSemanticEmbeddingConfig = {
  provider: SemanticEmbeddingProviderKind.Gguf,
  modelId: DefaultSemanticEmbeddingModelId,
} as const satisfies SemanticEmbeddingConfig;

export function semanticEmbeddingModel(id: SemanticEmbeddingModelId = DefaultSemanticEmbeddingModelId): SemanticEmbeddingModelDefinition {
  return SemanticEmbeddingModels[id];
}

export function semanticEmbeddingModelIds(): SemanticEmbeddingModelId[] {
  return Object.keys(SemanticEmbeddingModels) as SemanticEmbeddingModelId[];
}
