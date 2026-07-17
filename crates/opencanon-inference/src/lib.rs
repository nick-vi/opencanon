//! Native GGUF model runtime for OpenCanon.
//!
//! This crate keeps the native llama.cpp runtime in one place. Embeddings and
//! generation are separate API modules, but both load models through the shared
//! runtime shell so device, cache, and model lifecycle behavior cannot drift.

pub mod embedder;
pub mod error;
pub mod models;
pub mod runtime;

pub use embedder::{Embedder, EmbedderConfig};
pub use error::{InferenceError, Result};
pub use models::{EmbeddingModel, ModelFamily, DEFAULT_EMBEDDING_MODEL, EMBEDDING_MODELS};
pub use runtime::{NativeModelRuntime, NativeRuntimeOptions};
