#[derive(Debug, Clone)]
pub struct EmbeddingModel {
    pub id: &'static str,
    pub repo: &'static str,
    pub filename: &'static str,
    pub dimensions: usize,
    pub max_context: usize,
    pub family: ModelFamily,
    pub description: &'static str,
}

#[derive(Debug, Clone)]
pub struct GeneratorModel {
    pub id: &'static str,
    pub repo: &'static str,
    pub filename: &'static str,
    pub max_context: usize,
    pub description: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFamily {
    JinaCode,
    Qwen3Embedding,
}

pub const JINA_CODE_V2_05B: EmbeddingModel = EmbeddingModel {
    id: "jina-code-v2",
    repo: "jinaai/jina-code-embeddings-0.5b-GGUF",
    filename: "jina-code-embeddings-0.5b-IQ4_XS.gguf",
    dimensions: 896,
    max_context: 8192,
    family: ModelFamily::JinaCode,
    description: "Code-optimized embeddings, fast inference",
};

pub const JINA_CODE_V2_15B: EmbeddingModel = EmbeddingModel {
    id: "jina-code-v2-large",
    repo: "jinaai/jina-code-embeddings-1.5b-GGUF",
    filename: "jina-code-embeddings-1.5b-IQ4_XS.gguf",
    dimensions: 1536,
    max_context: 8192,
    family: ModelFamily::JinaCode,
    description: "Code-optimized embeddings, highest quality",
};

pub const QWEN3_EMBEDDING_06B: EmbeddingModel = EmbeddingModel {
    id: "qwen3-embed",
    repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
    filename: "Qwen3-Embedding-0.6B-Q8_0.gguf",
    dimensions: 1024,
    max_context: 8192,
    family: ModelFamily::Qwen3Embedding,
    description: "General-purpose embeddings",
};

pub const EMBEDDING_MODELS: &[EmbeddingModel] =
    &[JINA_CODE_V2_05B, JINA_CODE_V2_15B, QWEN3_EMBEDDING_06B];
pub const DEFAULT_EMBEDDING_MODEL: &EmbeddingModel = &JINA_CODE_V2_05B;

pub const QWEN_CODER_05B: GeneratorModel = GeneratorModel {
    id: "qwen-coder-0.5b",
    repo: "Qwen/Qwen2.5-Coder-0.5B-Instruct-GGUF",
    filename: "qwen2.5-coder-0.5b-instruct-q8_0.gguf",
    max_context: 32768,
    description: "Fast code generation and query expansion",
};

pub const QWEN_CODER_15B: GeneratorModel = GeneratorModel {
    id: "qwen-coder-1.5b",
    repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    filename: "qwen2.5-coder-1.5b-instruct-q4_k_m.gguf",
    max_context: 32768,
    description: "Higher quality code generation",
};

pub const GENERATOR_MODELS: &[GeneratorModel] = &[QWEN_CODER_05B, QWEN_CODER_15B];
pub const DEFAULT_GENERATOR_MODEL: &GeneratorModel = &QWEN_CODER_05B;

impl EmbeddingModel {
    pub fn find(id: &str) -> Option<&'static EmbeddingModel> {
        let id_lower = id.to_lowercase();
        EMBEDDING_MODELS.iter().find(|model| {
            model.id == id_lower
                || model.repo.to_lowercase().contains(&id_lower)
                || id_lower.contains(model.id)
        })
    }

    pub fn query_prefix(&self) -> &'static str {
        match self.family {
            ModelFamily::JinaCode => {
                "Find the most relevant code snippet given the following query:\n"
            }
            ModelFamily::Qwen3Embedding => {
                "Instruct: Given a code search query, retrieve relevant code snippets that match the query\nQuery:"
            }
        }
    }

    pub fn document_prefix(&self) -> &'static str {
        match self.family {
            ModelFamily::JinaCode => "Candidate code snippet:\n",
            ModelFamily::Qwen3Embedding => "",
        }
    }
}

impl GeneratorModel {
    pub fn find(id: &str) -> Option<&'static GeneratorModel> {
        let id_lower = id.to_lowercase();
        GENERATOR_MODELS.iter().find(|model| {
            model.id == id_lower
                || model.repo.to_lowercase().contains(&id_lower)
                || id_lower.contains(model.id)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_embedding_models() {
        assert!(EmbeddingModel::find("jina-code-v2").is_some());
        assert!(EmbeddingModel::find("qwen3-embed").is_some());
        assert!(EmbeddingModel::find("missing").is_none());
    }

    #[test]
    fn finds_generator_models() {
        assert!(GeneratorModel::find("qwen-coder-0.5b").is_some());
        assert!(GeneratorModel::find("missing").is_none());
    }

    #[test]
    fn model_prefixes_are_task_specific() {
        assert!(JINA_CODE_V2_05B
            .query_prefix()
            .contains("relevant code snippet"));
        assert!(JINA_CODE_V2_05B.document_prefix().contains("Candidate"));
        assert!(QWEN3_EMBEDDING_06B.query_prefix().contains("Instruct"));
        assert_eq!(QWEN3_EMBEDDING_06B.document_prefix(), "");
    }
}
