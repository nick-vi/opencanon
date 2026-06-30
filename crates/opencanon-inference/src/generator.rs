use std::sync::Arc;

use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::AddBos;
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::data_array::LlamaTokenDataArray;
use parking_lot::Mutex;

use crate::error::{InferenceError, Result};
use crate::models::{GeneratorModel, DEFAULT_GENERATOR_MODEL, GENERATOR_MODELS};
use crate::runtime::{ensure_hf_model, NativeModelRuntime, NativeRuntimeOptions};

#[derive(Debug, Clone)]
pub struct GeneratorConfig {
    pub model: &'static GeneratorModel,
    pub n_gpu_layers: u32,
    pub n_threads: i32,
    pub n_ctx: u32,
    pub show_download_progress: bool,
}

impl Default for GeneratorConfig {
    fn default() -> Self {
        Self {
            model: DEFAULT_GENERATOR_MODEL,
            n_gpu_layers: u32::MAX,
            n_threads: 8,
            n_ctx: 2048,
            show_download_progress: true,
        }
    }
}

impl GeneratorConfig {
    pub fn cpu_only(mut self) -> Self {
        self.n_gpu_layers = 0;
        self
    }

    pub fn with_model(mut self, model_id: &str) -> Result<Self> {
        self.model = GeneratorModel::find(model_id).ok_or_else(|| {
            InferenceError::config(format!(
                "Unknown generator model: {model_id}. Available: {:?}",
                GENERATOR_MODELS
                    .iter()
                    .map(|model| model.id)
                    .collect::<Vec<_>>()
            ))
        })?;
        Ok(self)
    }
}

#[derive(Debug, Clone)]
pub struct GenerateOptions {
    pub max_tokens: usize,
    pub temperature: f32,
    pub top_p: f32,
    pub seed: u32,
}

impl Default for GenerateOptions {
    fn default() -> Self {
        Self {
            max_tokens: 100,
            temperature: 0.7,
            top_p: 0.9,
            seed: 42,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(content: impl Into<String>) -> Self {
        Self {
            role: "system".to_string(),
            content: content.into(),
        }
    }

    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: "user".to_string(),
            content: content.into(),
        }
    }

    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: "assistant".to_string(),
            content: content.into(),
        }
    }
}

#[derive(Clone)]
pub struct Generator {
    runtime: Arc<Mutex<NativeModelRuntime>>,
    model_spec: &'static GeneratorModel,
    config: GeneratorConfig,
}

impl Generator {
    pub fn new(config: GeneratorConfig) -> Result<Self> {
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
                n_ctx: config.n_ctx,
                embeddings: false,
                pooling_type: None,
            },
        )?;
        tracing::info!(model = config.model.id, "Generator model loaded");
        Ok(Self {
            runtime: Arc::new(Mutex::new(runtime)),
            model_spec: config.model,
            config,
        })
    }

    pub fn from_model_id(model_id: &str) -> Result<Self> {
        Self::new(GeneratorConfig::default().with_model(model_id)?)
    }

    pub fn default_model() -> Result<Self> {
        Self::new(GeneratorConfig::default())
    }

    pub fn model_id(&self) -> &'static str {
        self.model_spec.id
    }

    pub fn model_spec(&self) -> &'static GeneratorModel {
        self.model_spec
    }

    pub fn config(&self) -> &GeneratorConfig {
        &self.config
    }

    pub fn generate(&self, prompt: &str, options: Option<GenerateOptions>) -> Result<String> {
        let options = options.unwrap_or_default();
        let mut runtime = self.runtime.lock();
        let prompt_tokens = runtime
            .model()
            .str_to_token(prompt, AddBos::Always)
            .map_err(|error| {
                InferenceError::tokenization(format!("Tokenization failed: {error}"))
            })?;

        runtime.context().clear_kv_cache();
        let mut batch = LlamaBatch::new(runtime.context().n_ctx() as usize, 1);
        for (index, token) in prompt_tokens.iter().enumerate() {
            batch
                .add(*token, index as i32, &[0], index == prompt_tokens.len() - 1)
                .map_err(|error| InferenceError::inference(format!("Batch add failed: {error}")))?;
        }
        runtime
            .context()
            .decode(&mut batch)
            .map_err(|error| InferenceError::inference(format!("Decode failed: {error}")))?;

        let eos_token = runtime.model().token_eos();
        let im_end_tokens = runtime
            .model()
            .str_to_token("<|im_end|>", AddBos::Never)
            .unwrap_or_default();
        let sampler = LlamaSampler::chain_simple([
            LlamaSampler::temp(options.temperature),
            LlamaSampler::top_p(options.top_p, 1),
            LlamaSampler::dist(options.seed),
        ]);
        let mut generated_tokens = Vec::new();

        for index in 0..options.max_tokens {
            let logits = runtime.context().candidates_ith(batch.n_tokens() - 1);
            let mut candidates = LlamaTokenDataArray::from_iter(logits, false);
            candidates.apply_sampler(&sampler);
            let token = candidates
                .selected_token()
                .ok_or_else(|| InferenceError::inference("No token selected."))?;
            if token == eos_token || im_end_tokens.contains(&token) {
                break;
            }
            generated_tokens.push(token);

            batch.clear();
            batch
                .add(token, (prompt_tokens.len() + index) as i32, &[0], true)
                .map_err(|error| InferenceError::inference(format!("Batch add failed: {error}")))?;
            runtime
                .context()
                .decode(&mut batch)
                .map_err(|error| InferenceError::inference(format!("Decode failed: {error}")))?;
        }

        let mut output = String::new();
        let mut decoder = encoding_rs::UTF_8.new_decoder();
        for token in generated_tokens {
            let piece = runtime
                .model()
                .token_to_piece(token, &mut decoder, true, None)
                .map_err(|error| {
                    InferenceError::inference(format!("Token decode failed: {error}"))
                })?;
            output.push_str(&piece);
        }
        Ok(output)
    }

    pub fn chat(
        &self,
        messages: &[ChatMessage],
        options: Option<GenerateOptions>,
    ) -> Result<String> {
        self.generate(&self.format_chat(messages), options)
    }

    pub fn clear_cache(&self) {
        self.runtime.lock().context().clear_kv_cache();
    }

    pub fn format_chat(&self, messages: &[ChatMessage]) -> String {
        let mut prompt = String::new();
        for message in messages {
            prompt.push_str("<|im_start|>");
            prompt.push_str(&message.role);
            prompt.push('\n');
            prompt.push_str(&message.content);
            prompt.push_str("<|im_end|>\n");
        }
        prompt.push_str("<|im_start|>assistant\n");
        prompt
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_to_small_generator_model() {
        let config = GeneratorConfig::default();
        assert_eq!(config.model.id, "qwen-coder-0.5b");
        assert_eq!(config.n_gpu_layers, u32::MAX);
    }

    #[test]
    fn generation_options_are_bounded_defaults() {
        let options = GenerateOptions::default();
        assert_eq!(options.max_tokens, 100);
        assert_eq!(options.temperature, 0.7);
    }

    #[test]
    fn chat_message_builders_set_roles() {
        assert_eq!(ChatMessage::system("s").role, "system");
        assert_eq!(ChatMessage::user("u").role, "user");
        assert_eq!(ChatMessage::assistant("a").role, "assistant");
    }
}
