use napi_derive::napi;
use opencanon_inference::{Embedder, EmbedderConfig, InferenceError};
use serde::{Deserialize, Serialize};

use crate::json::{decode, encode, napi_error};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenInferenceRuntimeRequest {
    model_id: String,
    n_gpu_layers: u32,
    n_threads: i32,
    n_ctx: u32,
    n_batch: u32,
    n_ubatch: u32,
    n_seq_max: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InferenceTextsRequest {
    task: String,
    texts: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InferenceRuntimeDescription<'a> {
    model_id: &'a str,
    dimensions: usize,
    maximum_input_tokens: usize,
    context_tokens: u32,
    batch_tokens: u32,
    micro_batch_tokens: u32,
    maximum_sequences: u32,
    threads: i32,
    gpu_layers: u32,
}

#[napi]
pub struct InferenceRuntimeHandle {
    embedder: Embedder,
}

impl InferenceRuntimeHandle {
    pub(crate) fn open(request: String) -> napi::Result<Self> {
        let request: OpenInferenceRuntimeRequest = decode(&request)?;
        validate_runtime_request(&request)?;
        let mut config = EmbedderConfig::default()
            .with_model(request.model_id.trim())
            .map_err(inference_error)?;
        config.n_gpu_layers = request.n_gpu_layers;
        config.n_threads = request.n_threads;
        config.n_ctx = Some(request.n_ctx);
        config.n_batch = request.n_batch;
        config.n_ubatch = request.n_ubatch;
        config.n_seq_max = request.n_seq_max;
        config.show_download_progress = true;
        let embedder = Embedder::new(config).map_err(inference_error)?;
        Ok(Self { embedder })
    }

    fn description(&self) -> InferenceRuntimeDescription<'_> {
        let config = self.embedder.config();
        InferenceRuntimeDescription {
            model_id: self.embedder.model_id(),
            dimensions: self.embedder.dimensions(),
            maximum_input_tokens: self.embedder.maximum_input_tokens(),
            context_tokens: config.n_ctx.unwrap_or(config.model.max_context as u32),
            batch_tokens: config.n_batch,
            micro_batch_tokens: config.n_ubatch,
            maximum_sequences: config.n_seq_max,
            threads: config.n_threads,
            gpu_layers: config.n_gpu_layers,
        }
    }
}

#[napi]
impl InferenceRuntimeHandle {
    #[napi(js_name = "describeJson")]
    pub fn describe_json(&self) -> napi::Result<String> {
        encode(&self.description())
    }

    #[napi(js_name = "countTokensJson")]
    pub fn count_tokens_json(&self, request: String) -> napi::Result<String> {
        let request = validated_texts_request(request)?;
        validate_sequence_count(request.texts.len(), self.embedder.config().n_seq_max)?;
        let token_counts = request
            .texts
            .iter()
            .map(|text| match request.task.as_str() {
                "document" => self.embedder.count_document_tokens(text),
                "query" => self.embedder.count_query_tokens(text),
                _ => unreachable!("inference task was validated"),
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(inference_error)?;
        encode(&serde_json::json!({
            "model": self.description(),
            "tokenCounts": token_counts,
        }))
    }

    #[napi(js_name = "embedJson")]
    pub fn embed_json(&self, request: String) -> napi::Result<String> {
        let request = validated_texts_request(request)?;
        validate_sequence_count(request.texts.len(), self.embedder.config().n_seq_max)?;
        let text_refs = request.texts.iter().map(String::as_str).collect::<Vec<_>>();
        let token_counts = request
            .texts
            .iter()
            .map(|text| match request.task.as_str() {
                "document" => self.embedder.count_document_tokens(text),
                "query" => self.embedder.count_query_tokens(text),
                _ => unreachable!("inference task was validated"),
            })
            .collect::<Result<Vec<_>, _>>()
            .map_err(inference_error)?;
        let vectors = match request.task.as_str() {
            "document" => self.embedder.embed_batch(&text_refs),
            "query" => self.embedder.embed_query_batch(&text_refs),
            _ => unreachable!("inference task was validated"),
        }
        .map_err(inference_error)?;
        encode(&serde_json::json!({
            "model": self.description(),
            "tokenCounts": token_counts,
            "vectors": vectors,
        }))
    }
}

fn validate_runtime_request(request: &OpenInferenceRuntimeRequest) -> napi::Result<()> {
    if request.model_id.trim().is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Inference model id is required.",
        ));
    }
    if request.n_threads <= 0
        || request.n_ctx == 0
        || request.n_batch == 0
        || request.n_ubatch == 0
        || request.n_seq_max == 0
    {
        return Err(napi_error(
            "invalid-engine-payload",
            "Inference threads, context, batch, micro-batch, and sequence values must be positive.",
        ));
    }
    if request.n_batch > request.n_ctx {
        return Err(napi_error(
            "invalid-engine-payload",
            "Inference batch tokens cannot exceed context tokens.",
        ));
    }
    if request.n_ubatch > request.n_batch {
        return Err(napi_error(
            "invalid-engine-payload",
            "Inference micro-batch tokens cannot exceed batch tokens.",
        ));
    }
    Ok(())
}

fn validated_texts_request(request: String) -> napi::Result<InferenceTextsRequest> {
    let request: InferenceTextsRequest = decode(&request)?;
    if request.task != "document" && request.task != "query" {
        return Err(napi_error(
            "invalid-engine-payload",
            "Inference task must be document or query.",
        ));
    }
    if request.texts.is_empty() {
        return Err(napi_error(
            "invalid-engine-payload",
            "Inference request must contain at least one text.",
        ));
    }
    if let Some(index) = request.texts.iter().position(|text| text.trim().is_empty()) {
        return Err(napi_error(
            "invalid-engine-payload",
            &format!("Inference text at index {index} is empty."),
        ));
    }
    Ok(request)
}

fn validate_sequence_count(actual: usize, maximum: u32) -> napi::Result<()> {
    if actual <= maximum as usize {
        return Ok(());
    }
    Err(napi_error(
        "invalid-engine-payload",
        &format!("Inference request contains {actual} texts; at most {maximum} are permitted."),
    ))
}

fn inference_error(error: InferenceError) -> napi::Error {
    napi_error("inference-error", &error.to_string())
}
