import { SymbolDef, VectorSearchResult } from '../types';
// @ts-ignore
import { pipeline } from '@xenova/transformers';
import { settingsService } from './settingsService';

// In-memory store for "Local" mode in Node.js
// In production, this should be Redis/File/DB
interface LocalVectorDoc {
    id: string;
    embedding: number[];
    metadata: any;
    document: string;
}

const memoryStore: Record<string, LocalVectorDoc> = {};

// Helper: Cosine Similarity
const cosineSimilarity = (vecA: number[], vecB: number[]): number => {
    let dotProduct = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;
    if (vecA.length !== vecB.length) return 0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        magnitudeA += vecA[i] * vecA[i];
        magnitudeB += vecB[i] * vecB[i];
    }
    magnitudeA = Math.sqrt(magnitudeA);
    magnitudeB = Math.sqrt(magnitudeB);
    if (magnitudeA === 0 || magnitudeB === 0) return 0;
    return dotProduct / (magnitudeA * magnitudeB);
};

// --- Local Embedding Pipeline ---
let embeddingPipeline: any = null;

const generateLocalEmbedding = async (text: string): Promise<number[]> => {
    try {
        if (!embeddingPipeline) {
            console.log("[VectorService] Initializing local embedding model (Xenova/all-MiniLM-L6-v2)...");
            // Use quantized version by default
            embeddingPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        }
        
        // Run inference
        const output = await embeddingPipeline(text, { pooling: 'mean', normalize: true });
        
        // Convert Tensor to Array
        return Array.from(output.data);
    } catch (e) {
        console.error("[VectorService] Local embedding generation failed", e);
        return [];
    }
};

export const vectorService = {
    
    // --- Core Operations ---

    async getOrCreateCollection(): Promise<string | null> {
        const config = settingsService.getVectorSettings();
        if (!config.useExternal) return "local";

        const baseUrl = config.chromaUrl;
        const collectionName = config.collectionName;
        
        try {
            // UPDATED: API v2
            const res = await fetch(`${baseUrl}/api/v2/collections`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: collectionName, get_or_create: true })
            });
            
            if (!res.ok) {
                const errText = await res.text();
                console.warn(`[VectorService] Failed to get/create collection: ${res.status} ${errText}`);
                console.warn(`[VectorService] Target URL: ${baseUrl}/api/v2/collections`);
                return null;
            }
            const data = await res.json();
            console.log(`[VectorService] Connected to collection '${collectionName}' (${data.id})`);
            return data.id; // Returns collection UUID
        } catch (e) {
            console.error(`[VectorService] Connection failed to ${baseUrl}/api/v2/collections`, e);
            return null;
        }
    },

    async indexSymbol(symbol: SymbolDef): Promise<boolean> {
        // Prepare Document Content (Rich Text Representation)
        const content = `
            Symbol: ${symbol.name} (${symbol.id})
            Triad: ${symbol.triad}
            Domain: ${symbol.symbol_domain}
            Kind: ${symbol.kind || 'pattern'}
            Role: ${symbol.role}
            Macro: ${symbol.macro || ''}
            Invariants: ${(symbol.facets?.invariants || []).join(', ')}
            Description: ${JSON.stringify(symbol.facets || {})}
            Lattice: ${symbol.kind === 'lattice' ? JSON.stringify(symbol.lattice) : 'N/A'}
            Persona: ${symbol.kind === 'persona' ? JSON.stringify(symbol.persona) : 'N/A'}
        `.trim().replace(/\s+/g, ' ');

        // Generate Embedding LOCALLY
        const embedding = await generateLocalEmbedding(content);
        if (embedding.length === 0) return false;

        const config = settingsService.getVectorSettings();

        // --- STRATEGY: LOCAL ---
        if (!config.useExternal) {
            try {
                memoryStore[symbol.id] = {
                    id: symbol.id,
                    embedding: embedding,
                    metadata: {
                        id: symbol.id,
                        name: symbol.name,
                        triad: symbol.triad,
                        domain: symbol.symbol_domain,
                        kind: symbol.kind || 'pattern'
                    },
                    document: content
                };
                console.log(`[VectorService:Local] Indexed ${symbol.id}`);
                return true;
            } catch (e) {
                console.error("[VectorService:Local] Index error", e);
                return false;
            }
        }

        // --- STRATEGY: EXTERNAL (ChromaDB) ---
        const baseUrl = config.chromaUrl;
        const collectionId = await this.getOrCreateCollection();
        if (!collectionId) return false;

        try {
            // UPDATED: API v2
            const payload = {
                ids: [symbol.id],
                embeddings: [embedding],
                metadatas: [{
                    id: symbol.id,
                    name: symbol.name,
                    triad: symbol.triad,
                    domain: symbol.symbol_domain,
                    kind: symbol.kind || 'pattern'
                }],
                documents: [content]
            };

            const res = await fetch(`${baseUrl}/api/v2/collections/${collectionId}/upsert`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                console.log(`[VectorService:Chroma] Indexed ${symbol.id}`);
                return true;
            } else {
                console.error(`[VectorService:Chroma] Index failed for ${symbol.id}`, await res.text());
                return false;
            }

        } catch (e) {
            console.error("[VectorService:Chroma] Indexing error", e);
            return false;
        }
    },

    async indexBatch(symbols: SymbolDef[]): Promise<number> {
        if (symbols.length === 0) return 0;
        console.group(`[VectorService] Batch Indexing ${symbols.length} symbols`);
        
        let successCount = 0;
        const CHUNK_SIZE = 5;
        
        for (let i = 0; i < symbols.length; i += CHUNK_SIZE) {
            const chunk = symbols.slice(i, i + CHUNK_SIZE);
            await Promise.all(chunk.map(async (sym) => {
                const success = await this.indexSymbol(sym);
                if (success) successCount++;
            }));
        }
        
        console.groupEnd();
        return successCount;
    },

    async deleteSymbol(symbolId: string): Promise<boolean> {
        const config = settingsService.getVectorSettings();

        // --- STRATEGY: LOCAL ---
        if (!config.useExternal) {
            if (memoryStore[symbolId]) {
                delete memoryStore[symbolId];
                return true;
            }
            return false;
        }

        // --- STRATEGY: EXTERNAL ---
        const baseUrl = config.chromaUrl;
        const collectionId = await this.getOrCreateCollection();
        if (!collectionId) return false;

        try {
            // UPDATED: API v2
            const res = await fetch(`${baseUrl}/api/v2/collections/${collectionId}/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ids: [symbolId] })
            });
            return res.ok;
        } catch (e) {
            console.error("[VectorService] Delete failed", e);
            return false;
        }
    },

    async search(query: string, nResults: number = 5): Promise<VectorSearchResult[]> {
        const queryEmbedding = await generateLocalEmbedding(query);
        if (queryEmbedding.length === 0) return [];

        const config = settingsService.getVectorSettings();

        // --- STRATEGY: LOCAL ---
        if (!config.useExternal) {
            const docs = Object.values(memoryStore);
            if (docs.length === 0) return [];

            // Brute force cosine similarity
            const scored = docs.map(doc => ({
                id: doc.id,
                score: cosineSimilarity(queryEmbedding, doc.embedding),
                metadata: doc.metadata,
                document: doc.document
            }));

            // Sort descending by score
            scored.sort((a, b) => b.score - a.score);

            return scored.slice(0, nResults);
        }

        // --- STRATEGY: EXTERNAL ---
        const baseUrl = config.chromaUrl;
        const collectionId = await this.getOrCreateCollection();
        if (!collectionId) return [];

        try {
            console.log(`[VectorService] Querying Chroma: ${baseUrl} (Collection: ${collectionId})`);
            // UPDATED: API v2
            const res = await fetch(`${baseUrl}/api/v2/collections/${collectionId}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query_embeddings: [queryEmbedding],
                    n_results: nResults,
                    include: ["metadatas", "documents", "distances"]
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                console.error(`[VectorService] Query failed: ${res.status}`, errText);
                return [];
            }

            const data = await res.json();
            
            const ids = data.ids[0] || [];
            const metadatas = data.metadatas[0] || [];
            const documents = data.documents[0] || [];
            const distances = data.distances[0] || [];

            const results: VectorSearchResult[] = ids.map((id: string, idx: number) => ({
                id,
                metadata: metadatas[idx],
                document: documents[idx],
                score: 1 - (distances[idx] || 0)
            }));

            return results;

        } catch (e) {
            console.error("[VectorService] Search failed", e);
            return [];
        }
    },

    async resetCollection(): Promise<boolean> {
        const config = settingsService.getVectorSettings();

        // --- STRATEGY: LOCAL ---
        if (!config.useExternal) {
            for (const key in memoryStore) delete memoryStore[key];
            return true;
        }

        // --- STRATEGY: EXTERNAL ---
        const baseUrl = config.chromaUrl;
        const collectionName = config.collectionName;
        try {
            await fetch(`${baseUrl}/api/v2/collections/${collectionName}`, { method: 'DELETE' });
            return true;
        } catch (e) {
            return false;
        }
    }
};