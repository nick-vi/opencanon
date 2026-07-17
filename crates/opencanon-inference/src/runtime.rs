use std::mem::ManuallyDrop;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::Once;

use hf_hub::api::sync::Api;
use llama_cpp_2::context::params::{LlamaContextParams, LlamaPoolingType};
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::{send_logs_to_tracing, LogOptions};

use crate::error::{InferenceError, Result};

const GGUF_INFERENCE_LOGS_ENV: &str = "OPENCANON_GGUF_INFERENCE_LOGS";
static LLAMA_LOGGING: Once = Once::new();

#[derive(Debug, Clone)]
pub struct NativeRuntimeOptions {
    pub n_gpu_layers: u32,
    pub n_threads: i32,
    pub n_ctx: u32,
    pub n_batch: u32,
    pub n_ubatch: u32,
    pub n_seq_max: u32,
    pub embeddings: bool,
    pub pooling_type: Option<LlamaPoolingType>,
}

impl Default for NativeRuntimeOptions {
    fn default() -> Self {
        Self {
            n_gpu_layers: u32::MAX,
            n_threads: 8,
            n_ctx: 2048,
            n_batch: 2048,
            n_ubatch: 512,
            n_seq_max: 16,
            embeddings: false,
            pooling_type: None,
        }
    }
}

pub struct NativeModelRuntime {
    context: ManuallyDrop<LlamaContext<'static>>,
    model: ManuallyDrop<Box<LlamaModel>>,
    backend: ManuallyDrop<Box<LlamaBackend>>,
    options: NativeRuntimeOptions,
}

impl NativeModelRuntime {
    pub fn load(model_path: impl Into<PathBuf>, options: NativeRuntimeOptions) -> Result<Self> {
        validate_options(&options)?;
        configure_llama_logging();
        let model_path = model_path.into();
        let backend = Box::new(LlamaBackend::init().map_err(|error| {
            InferenceError::model_loading(format!("Failed to initialize llama.cpp: {error}"))
        })?);
        tracing::info!(
            gpu_offload = backend.supports_gpu_offload(),
            mmap = backend.supports_mmap(),
            "llama.cpp backend initialized"
        );

        let model_params = LlamaModelParams::default().with_n_gpu_layers(options.n_gpu_layers);
        let model = Box::new(
            LlamaModel::load_from_file(&backend, &model_path, &model_params).map_err(|error| {
                InferenceError::model_loading(format!("Failed to load model: {error}"))
            })?,
        );

        let mut context_params = LlamaContextParams::default()
            .with_n_ctx(Some(NonZeroU32::new(options.n_ctx).ok_or_else(|| {
                InferenceError::config("Context length must be positive.")
            })?))
            .with_n_batch(options.n_batch)
            .with_n_ubatch(options.n_ubatch)
            .with_n_seq_max(options.n_seq_max)
            .with_n_threads(options.n_threads)
            .with_n_threads_batch(options.n_threads);
        if options.embeddings {
            context_params = context_params.with_embeddings(true).with_kv_unified(true);
        }
        if let Some(pooling_type) = options.pooling_type {
            context_params = context_params.with_pooling_type(pooling_type);
        }

        let context: LlamaContext<'static> =
            unsafe {
                std::mem::transmute(model.new_context(&backend, context_params).map_err(
                    |error| {
                        InferenceError::model_loading(format!("Failed to create context: {error}"))
                    },
                )?)
            };

        Ok(Self {
            context: ManuallyDrop::new(context),
            model: ManuallyDrop::new(model),
            backend: ManuallyDrop::new(backend),
            options,
        })
    }

    pub fn context(&mut self) -> &mut LlamaContext<'static> {
        &mut self.context
    }

    pub fn model(&self) -> &LlamaModel {
        &self.model
    }

    pub fn options(&self) -> &NativeRuntimeOptions {
        &self.options
    }
}

fn validate_options(options: &NativeRuntimeOptions) -> Result<()> {
    if options.n_threads <= 0
        || options.n_ctx == 0
        || options.n_batch == 0
        || options.n_ubatch == 0
        || options.n_seq_max == 0
    {
        return Err(InferenceError::config(
            "Inference threads, context, batch, micro-batch, and sequence limits must be positive.",
        ));
    }
    if options.n_batch > options.n_ctx {
        return Err(InferenceError::config(
            "Inference batch tokens cannot exceed context tokens.",
        ));
    }
    if options.n_ubatch > options.n_batch {
        return Err(InferenceError::config(
            "Inference micro-batch tokens cannot exceed batch tokens.",
        ));
    }
    Ok(())
}

impl Drop for NativeModelRuntime {
    fn drop(&mut self) {
        unsafe {
            ManuallyDrop::drop(&mut self.context);
            ManuallyDrop::drop(&mut self.model);
            ManuallyDrop::drop(&mut self.backend);
        }
    }
}

unsafe impl Send for NativeModelRuntime {}

fn configure_llama_logging() {
    LLAMA_LOGGING.call_once(|| {
        let enabled = std::env::var(GGUF_INFERENCE_LOGS_ENV)
            .ok()
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "on" | "trace" | "debug"
                )
            })
            .unwrap_or(false);
        send_logs_to_tracing(LogOptions::default().with_logs_enabled(enabled));
    });
}

pub fn ensure_hf_model(repo: &str, filename: &str, show_progress: bool) -> Result<PathBuf> {
    let api = Api::new().map_err(|error| {
        InferenceError::model_loading(format!("HuggingFace API error: {error}"))
    })?;
    if show_progress {
        tracing::info!(
            repo,
            file = filename,
            "Downloading model if missing from cache"
        );
    }
    api.model(repo.to_string())
        .get(filename)
        .map_err(|error| InferenceError::model_loading(format!("Model download failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_options_reject_invalid_batch_relationships() {
        let options = NativeRuntimeOptions {
            n_seq_max: 0,
            ..NativeRuntimeOptions::default()
        };
        assert!(validate_options(&options).is_err());

        let options = NativeRuntimeOptions {
            n_ctx: 256,
            ..NativeRuntimeOptions::default()
        };
        assert!(validate_options(&options).is_err());

        let options = NativeRuntimeOptions {
            n_ubatch: 2049,
            ..NativeRuntimeOptions::default()
        };
        assert!(validate_options(&options).is_err());
    }
}
