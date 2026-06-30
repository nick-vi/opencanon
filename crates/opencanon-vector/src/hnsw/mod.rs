//! HNSW (Hierarchical Navigable Small World) index implementation
//!
//! A multi-layer graph structure for approximate nearest neighbor search.
//! Higher layers have fewer nodes and longer-range connections (coarse search),
//! while lower layers have all nodes with short-range connections (fine search).

mod build;
mod index;
mod persist;
mod search;

pub use index::{HnswConfig, HnswIndex};
pub use search::search_with_trace;
