use std::sync::Arc;

use llama_cpp_2::context::params::LlamaPoolingType;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::AddBos;
use parking_lot::Mutex;

use crate::error::{InferenceError, Result};
use crate::models::{EmbeddingModel, DEFAULT_EMBEDDING_MODEL, EMBEDDING_MODELS};
use crate::runtime::{ensure_hf_model, NativeModelRuntime, NativeRuntimeOptions};

#[derive(Debug, Clone)]
pub struct EmbedderConfig {
    pub model: &'static EmbeddingModel,
    pub n_gpu_layers: u32,
    pub n_threads: i32,
    pub n_ctx: Option<u32>,
    pub show_download_progress: bool,
}

impl Default for EmbedderConfig {
    fn default() -> Self {
        Self {
            model: DEFAULT_EMBEDDING_MODEL,
            n_gpu_layers: u32::MAX,
            n_threads: 8,
            n_ctx: None,
            show_download_progress: true,
        }
    }
}

impl EmbedderConfig {
    pub fn cpu_only(mut self) -> Self {
        self.n_gpu_layers = 0;
        self
    }

    pub fn with_gpu(mut self, n_layers: u32) -> Self {
        self.n_gpu_layers = n_layers;
        self
    }

    pub fn with_model(mut self, model_id: &str) -> Result<Self> {
        self.model = EmbeddingModel::find(model_id).ok_or_else(|| {
            InferenceError::config(format!(
                "Unknown embedding model: {model_id}. Available: {:?}",
                EMBEDDING_MODELS
                    .iter()
                    .map(|model| model.id)
                    .collect::<Vec<_>>()
            ))
        })?;
        Ok(self)
    }
}

#[derive(Clone)]
pub struct Embedder {
    runtime: Arc<Mutex<NativeModelRuntime>>,
    model_spec: &'static EmbeddingModel,
    config: EmbedderConfig,
}

impl Embedder {
    pub fn new(config: EmbedderConfig) -> Result<Self> {
        let model_path = ensure_hf_model(
            config.model.repo,
            config.model.filename,
            config.show_download_progress,
        )?;
        let runtime = NativeModelRuntime::load(
            model_path,
            NativeRuntimeOptions {
                n_gpu_layers: config.n_gpu_layers,
                n_threads: config.n_threads,
                n_ctx: config.n_ctx.unwrap_or(config.model.max_context as u32),
                embeddings: true,
                pooling_type: Some(LlamaPoolingType::Last),
            },
        )?;
        tracing::info!(
            model = config.model.id,
            dimensions = config.model.dimensions,
            "Embedding model loaded"
        );
        Ok(Self {
            runtime: Arc::new(Mutex::new(runtime)),
            model_spec: config.model,
            config,
        })
    }

    pub fn from_model_id(model_id: &str) -> Result<Self> {
        Self::new(EmbedderConfig::default().with_model(model_id)?)
    }

    pub fn default_model() -> Result<Self> {
        Self::new(EmbedderConfig::default())
    }

    pub fn dimensions(&self) -> usize {
        self.model_spec.dimensions
    }

    pub fn model_id(&self) -> &'static str {
        self.model_spec.id
    }

    pub fn model_spec(&self) -> &'static EmbeddingModel {
        self.model_spec
    }

    pub fn config(&self) -> &EmbedderConfig {
        &self.config
    }

    pub fn embed(&self, text: &str) -> Result<Vec<f32>> {
        self.embed_raw(&self.add_document_prefix(text))
    }

    pub fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        self.embed_raw(&self.add_query_prefix(text))
    }

    pub fn embed_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        texts.iter().map(|text| self.embed(text)).collect()
    }

    pub fn embed_query_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        texts.iter().map(|text| self.embed_query(text)).collect()
    }

    fn embed_raw(&self, text: &str) -> Result<Vec<f32>> {
        let mut runtime = self.runtime.lock();
        let mut tokens = runtime
            .model()
            .str_to_token(text, AddBos::Always)
            .map_err(|error| {
                InferenceError::tokenization(format!("Tokenization failed: {error}"))
            })?;
        let batch_capacity =
            embedding_batch_capacity(runtime.context().n_ctx(), runtime.context().n_batch());
        let max_tokens = embedding_token_limit(batch_capacity);
        if tokens.len() > max_tokens {
            tokens.truncate(max_tokens);
        }

        runtime.context().clear_kv_cache();
        let mut batch = LlamaBatch::new(batch_capacity, 1);
        batch.add_sequence(&tokens, 0, true).map_err(|error| {
            InferenceError::inference(format!("Batch creation failed: {error}"))
        })?;

        runtime
            .context()
            .decode(&mut batch)
            .map_err(|error| InferenceError::inference(format!("Decode failed: {error}")))?;
        let embedding = runtime.context().embeddings_seq_ith(0).map_err(|error| {
            InferenceError::inference(format!("Failed to get embedding: {error}"))
        })?;
        Ok(normalize(embedding))
    }

    fn add_document_prefix(&self, text: &str) -> String {
        let prefix = self.model_spec.document_prefix();
        if prefix.is_empty() {
            text.to_string()
        } else {
            format!("{prefix}{text}")
        }
    }

    fn add_query_prefix(&self, text: &str) -> String {
        format!("{}{}", self.model_spec.query_prefix(), text)
    }
}

fn embedding_batch_capacity(n_ctx: u32, n_batch: u32) -> usize {
    usize::max(1, usize::min(n_ctx as usize, n_batch as usize))
}

fn embedding_token_limit(batch_capacity: usize) -> usize {
    usize::max(1, batch_capacity.saturating_sub(16))
}

fn normalize(values: &[f32]) -> Vec<f32> {
    let magnitude = values.iter().map(|value| value * value).sum::<f32>().sqrt();
    if magnitude > 0.0 {
        values.iter().map(|value| value / magnitude).collect()
    } else {
        values.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_code_embedding_model() {
        let config = EmbedderConfig::default();
        assert_eq!(config.model.id, "jina-code-v2");
        assert_eq!(config.n_gpu_layers, u32::MAX);
    }

    #[test]
    fn config_can_be_cpu_only() {
        let config = EmbedderConfig::default().cpu_only();
        assert_eq!(config.n_gpu_layers, 0);
    }

    #[test]
    fn config_selects_known_model() {
        let config = EmbedderConfig::default().with_model("qwen3-embed").unwrap();
        assert_eq!(config.model.id, "qwen3-embed");
    }

    #[test]
    fn normalization_returns_unit_vectors() {
        let output = normalize(&[3.0, 4.0]);
        let magnitude = output.iter().map(|value| value * value).sum::<f32>().sqrt();
        assert!((magnitude - 1.0).abs() < 1e-6);
    }

    #[test]
    fn embedding_token_limit_respects_llama_batch_capacity() {
        assert_eq!(embedding_batch_capacity(8192, 2048), 2048);
        assert_eq!(embedding_token_limit(2048), 2032);
        assert_eq!(embedding_token_limit(8), 1);
    }
}
