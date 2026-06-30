use thiserror::Error;

pub type Result<T> = std::result::Result<T, InferenceError>;

#[derive(Error, Debug)]
pub enum InferenceError {
    #[error("configuration error: {0}")]
    Config(String),

    #[error("inference error: {0}")]
    Inference(String),

    #[error("model loading error: {0}")]
    ModelLoading(String),

    #[error("tokenization error: {0}")]
    Tokenization(String),

    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    #[error("HuggingFace Hub error: {0}")]
    HfHub(#[from] hf_hub::api::sync::ApiError),
}

impl InferenceError {
    pub fn config(message: impl Into<String>) -> Self {
        Self::Config(message.into())
    }

    pub fn inference(message: impl Into<String>) -> Self {
        Self::Inference(message.into())
    }

    pub fn model_loading(message: impl Into<String>) -> Self {
        Self::ModelLoading(message.into())
    }

    pub fn tokenization(message: impl Into<String>) -> Self {
        Self::Tokenization(message.into())
    }
}
