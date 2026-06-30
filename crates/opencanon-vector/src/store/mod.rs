//! Persistent vector storage with memory-mapped I/O

mod header;
pub mod idmap;
mod mmap;
mod quantized;

pub use header::{
    HnswHeader, IdMapHeader, VectorHeader, HNSW_MAGIC, HNSW_VERSION, IDMAP_MAGIC, IDMAP_VERSION,
    VECTOR_MAGIC, VECTOR_VERSION,
};
pub use idmap::IdMapData;
pub use mmap::MmapVectorStore;
pub use quantized::QuantizedVectorStore;
