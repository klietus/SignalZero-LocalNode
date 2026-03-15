# PRD: Topology Service (Tensor-Based Link Discovery & Graph Compression)

## Objective
The **Topology Service** aims to optimize symbolic link discovery and graph maintenance within the SignalZero Kernel. By replacing heuristic co-occurrence matching with **Tensor Network (TN)** calculations, the system achieves "subconscious" background reasoning and automatic graph hygiene (compression/deduplication) without the high cost and latency of LLM inference.

## Background
Currently, the SignalZero graph evolves through:
1.  **Manual LLM Tool Calls:** `upsert_symbols` and `log_trace` creating explicit links.
2.  **Tentative Link Heuristics:** Pair-wise co-occurrence in trace paths (`tentativeLinkService`).

These methods are either expensive (LLM) or narrow-sighted (pair-wise). Tensor Networks allow the system to analyze the **global topology** of the symbol store simultaneously, predicting links based on structural patterns and identifying redundant nodes that can be compressed.

## Core Features

### 1. Tensor Representation of Symbolic State
*   **Adjacency Tensor ($\mathcal{X}$):** Construct a 3rd-order sparse tensor of shape `(N, N, K)`.
    *   `N`: Number of symbols in the store.
    *   `K`: Number of link types (e.g., `constrained_by`, `synthesized_from`, `triggers`).
*   **Weighting:** Link weights are initialized based on co-occurrence frequency, trace usage, and manual definitions.

### 2. Link Discovery via Low-Rank Approximation
*   **Latent Factor Analysis:** Use CP (CANDECOMP/PARAFAC) decomposition to factorize the adjacency tensor into low-rank components.
*   **Gap Filling (Link Prediction):** Reconstruct the tensor from factors. Cells that were zero in the original tensor but become non-zero in the reconstruction indicate highly probable missing links.
*   **Promotion:** Predicted links exceeding a confidence threshold (e.g., 0.85) are pushed to the `tentativeLinkService` for monitoring or "immortalization."

### 3. Symbolic Compression (Graph Hygiene)
*   **Redundancy Detection:** Calculate the cosine similarity between the latent factor vectors of symbols. Symbols with near-identical factor profiles are flagged as redundant.
*   **Automatic Merging:** Redundant symbols are merged into a single "Canonical Symbol" (Rank-1 approximation). The system updates all existing links to point to the new ID.
*   **Noise Truncation:** Use Singular Value Decomposition (SVD) to truncate weak connections, effectively "forgetting" low-signal drift and keeping the graph clean.

### 4. Background Orchestration
*   **Subconscious Thread:** The Topology Service runs as a periodic low-priority background job.
*   **Triggering:** Triggered every 60 minutes or when significant graph mutations occur (e.g., >50 new symbols).

### 5. Link Crystallization
*   **Hardening:** Stable tentative links (those persisting across multiple topology updates with high confidence) are automatically "hardened" into the permanent `linked_patterns` of the relevant symbols.

## Technical Architecture
*   **Linear Algebra Engine:** `tfjs-node` (TensorFlow.js) for optimized tensor operations and matrix multiplication.
*   **Integration:**
    *   **Input:** Reads symbols and links from `domainService`.
    *   **Output:** Updates symbols via `domainService` and primes `tentativeLinkService`.
    *   **Events:** Emits `TOPOLOGY_DISCOVERY` and `SYMBOL_COMPRESSION` events for frontend visualization.

## Success Metrics
*   **Reduced Inference Rounds:** Decrease the number of LLM-initiated `find_symbols` calls per turn by 20% due to primed cache.
*   **Graph Density:** Improvement in graph coherence through the discovery of non-obvious multi-hop links.
*   **Context Efficiency:** Reduce the number of redundant symbols loaded into the LLM context window.
