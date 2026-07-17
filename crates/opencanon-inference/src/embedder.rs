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
    pub n_batch: u32,
    pub n_ubatch: u32,
    pub n_seq_max: u32,
    pub show_download_progress: bool,
}

impl Default for EmbedderConfig {
    fn default() -> Self {
        Self {
            model: DEFAULT_EMBEDDING_MODEL,
            n_gpu_layers: u32::MAX,
            n_threads: 8,
            n_ctx: None,
            n_batch: 2048,
            n_ubatch: 512,
            n_seq_max: 16,
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
        validate_execution_capacity(&config)?;
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
                n_batch: config.n_batch,
                n_ubatch: config.n_ubatch,
                n_seq_max: config.n_seq_max,
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
        self.embed_prefixed_batch(texts, EmbeddingTask::Document)
    }

    pub fn embed_query_batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>> {
        self.embed_prefixed_batch(texts, EmbeddingTask::Query)
    }

    pub fn count_document_tokens(&self, text: &str) -> Result<usize> {
        self.count_prefixed_tokens(text, EmbeddingTask::Document)
    }

    pub fn count_query_tokens(&self, text: &str) -> Result<usize> {
        self.count_prefixed_tokens(text, EmbeddingTask::Query)
    }

    pub fn maximum_input_tokens(&self) -> usize {
        self.model_spec.maximum_input_tokens
    }

    fn count_prefixed_tokens(&self, text: &str, task: EmbeddingTask) -> Result<usize> {
        let prefixed = self.prefixed_text(text, task);
        let runtime = self.runtime.lock();
        Ok(tokenize(runtime.model(), &prefixed)?.len())
    }

    fn embed_prefixed_batch(&self, texts: &[&str], task: EmbeddingTask) -> Result<Vec<Vec<f32>>> {
        let prefixed = texts
            .iter()
            .map(|text| self.prefixed_text(text, task))
            .collect::<Vec<_>>();
        let mut runtime = self.runtime.lock();
        let tokenized = prefixed
            .iter()
            .enumerate()
            .map(|(index, text)| {
                let tokens = tokenize(runtime.model(), text)?;
                ensure_token_budget(
                    index,
                    tokens.len(),
                    embedding_batch_capacity(
                        runtime.context().n_ctx(),
                        runtime.context().n_batch(),
                        runtime.context().n_ubatch(),
                    ),
                )?;
                Ok(tokens)
            })
            .collect::<Result<Vec<_>>>()?;
        let batch_capacity = embedding_batch_capacity(
            runtime.context().n_ctx(),
            runtime.context().n_batch(),
            runtime.context().n_ubatch(),
        );
        let maximum_sequences = runtime.options().n_seq_max as usize;
        let mut vectors = Vec::with_capacity(tokenized.len());
        let mut start = 0;
        while start < tokenized.len() {
            let mut end = start;
            let mut tokens_in_batch = 0;
            while end < tokenized.len()
                && end - start < maximum_sequences
                && tokens_in_batch + tokenized[end].len() <= batch_capacity
            {
                tokens_in_batch += tokenized[end].len();
                end += 1;
            }
            runtime.context().clear_kv_cache();
            let mut batch = LlamaBatch::new(batch_capacity, (end - start) as i32);
            for (sequence_id, tokens) in tokenized[start..end].iter().enumerate() {
                batch
                    .add_sequence(tokens, sequence_id as i32, true)
                    .map_err(|error| {
                        InferenceError::inference(format!("Batch creation failed: {error}"))
                    })?;
            }
            runtime
                .context()
                .decode(&mut batch)
                .map_err(|error| InferenceError::inference(format!("Decode failed: {error}")))?;
            for sequence_id in 0..(end - start) {
                let embedding = runtime
                    .context()
                    .embeddings_seq_ith(sequence_id as i32)
                    .map_err(|error| {
                        InferenceError::inference(format!("Failed to get embedding: {error}"))
                    })?;
                vectors.push(normalize(embedding));
            }
            start = end;
        }
        Ok(vectors)
    }

    fn embed_raw(&self, text: &str) -> Result<Vec<f32>> {
        self.embed_prefixed_batch(&[text], EmbeddingTask::Raw)?
            .into_iter()
            .next()
            .ok_or_else(|| InferenceError::inference("Embedding returned no vector."))
    }

    fn prefixed_text(&self, text: &str, task: EmbeddingTask) -> String {
        match task {
            EmbeddingTask::Document => self.add_document_prefix(text),
            EmbeddingTask::Query => self.add_query_prefix(text),
            EmbeddingTask::Raw => text.to_string(),
        }
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

fn embedding_batch_capacity(n_ctx: u32, n_batch: u32, n_ubatch: u32) -> usize {
    // Embedding models use non-causal attention, so each decode call must fit
    // both the logical token buffer and the physical compute micro-batch.
    usize::max(
        1,
        usize::min(
            n_ctx as usize,
            usize::min(n_batch as usize, n_ubatch as usize),
        ),
    )
}

fn validate_execution_capacity(config: &EmbedderConfig) -> Result<()> {
    let context_tokens = config.n_ctx.unwrap_or(config.model.max_context as u32);
    if context_tokens as usize > config.model.max_context {
        return Err(InferenceError::config(format!(
            "Embedding model {} supports at most {} context tokens, but the execution profile requests {context_tokens}.",
            config.model.id, config.model.max_context
        )));
    }
    let execution_capacity =
        embedding_batch_capacity(context_tokens, config.n_batch, config.n_ubatch);
    if execution_capacity < config.model.maximum_input_tokens {
        return Err(InferenceError::config(format!(
            "Embedding model {} requires capacity for {} input tokens, but the execution profile permits {execution_capacity}.",
            config.model.id, config.model.maximum_input_tokens
        )));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum EmbeddingTask {
    Document,
    Query,
    Raw,
}

fn tokenize(
    model: &llama_cpp_2::model::LlamaModel,
    text: &str,
) -> Result<Vec<llama_cpp_2::token::LlamaToken>> {
    model
        .str_to_token(text, AddBos::Always)
        .map_err(|error| InferenceError::tokenization(format!("Tokenization failed: {error}")))
}

fn ensure_token_budget(index: usize, actual: usize, maximum: usize) -> Result<()> {
    if actual == 0 {
        return Err(InferenceError::tokenization(format!(
            "Embedding text at index {index} produced no tokens."
        )));
    }
    if actual <= maximum {
        return Ok(());
    }
    Err(InferenceError::tokenization(format!(
        "Embedding text at index {index} contains {actual} tokens after its task prefix; the selected model permits at most {maximum}. Split the text before embedding."
    )))
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
    fn embedding_batch_capacity_is_the_exact_input_limit() {
        assert_eq!(embedding_batch_capacity(8192, 2048, 512), 512);
        assert_eq!(embedding_batch_capacity(256, 2048, 512), 256);
        assert!(ensure_token_budget(0, 512, 512).is_ok());
        assert!(ensure_token_budget(0, 513, 512).is_err());
        assert!(ensure_token_budget(0, 0, 512).is_err());
    }

    #[test]
    fn execution_capacity_cannot_redefine_the_model_chunk_contract() {
        let config = EmbedderConfig {
            n_ubatch: 256,
            ..EmbedderConfig::default()
        };
        assert!(validate_execution_capacity(&config).is_err());

        let config = EmbedderConfig {
            n_ctx: Some(16_384),
            ..EmbedderConfig::default()
        };
        assert!(validate_execution_capacity(&config).is_err());
    }
}
