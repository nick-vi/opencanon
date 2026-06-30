//! Native GGUF model runtime for OpenCanon.
//!
//! This crate keeps the native llama.cpp runtime in one place. Embeddings and
//! generation are separate API modules, but both load models through the shared
//! runtime shell so device, cache, and model lifecycle behavior cannot drift.

pub mod embedder;
pub mod error;
pub mod generator;
pub mod models;
pub mod runtime;

pub use embedder::{Embedder, EmbedderConfig};
pub use error::{InferenceError, Result};
pub use generator::{ChatMessage, GenerateOptions, Generator, GeneratorConfig};
pub use models::{
    EmbeddingModel, GeneratorModel, ModelFamily, DEFAULT_EMBEDDING_MODEL, DEFAULT_GENERATOR_MODEL,
    EMBEDDING_MODELS, GENERATOR_MODELS,
};
pub use runtime::{NativeModelRuntime, NativeRuntimeOptions};
