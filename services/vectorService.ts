import { ChromaClient, type Collection, type EmbeddingFunction } from 'chromadb';
import { embedTexts, resetEmbeddingCache } from './embeddingService.ts';
import { SymbolDef, VectorSearchResult } from '../types.ts';
import { settingsService } from './settingsService.ts';

let chromaClient: ChromaClient | null = null;
let cachedCollection: Collection | null = null;
let cachedCollectionName: string | null = null;
let cachedClientPath: string | null = null;
let cachedEmbeddingFn: EmbeddingFunction | null = null;

function resetCache() {
    chromaClient = null;
    cachedCollection = null;
    cachedCollectionName = null;
    cachedClientPath = null;
    cachedEmbeddingFn = null;
    resetEmbeddingCache();
}

function getClient(): ChromaClient {
    const { chromaUrl } = settingsService.getVectorSettings();
    if (!chromaClient || cachedClientPath !== chromaUrl) {
        chromaClient = new ChromaClient({ path: chromaUrl });
        cachedClientPath = chromaUrl;
        cachedCollection = null;
        cachedCollectionName = null;
    }
    return chromaClient;
}

function getEmbeddingFunction(): EmbeddingFunction {
    if (!cachedEmbeddingFn) {
        cachedEmbeddingFn = {
            async generate(texts: string[]): Promise<number[][]> {
                return embedTexts(texts);
            }
        };
    }

    return cachedEmbeddingFn!;
}

async function getCollectionInstance(): Promise<Collection | null> {
    const config = settingsService.getVectorSettings();
    const collectionName = config.collectionName;
    const embeddingFunction = getEmbeddingFunction();

    if (cachedCollection && cachedCollectionName === collectionName) {
        return cachedCollection;
    }

    try {
        const collection = await getClient().getOrCreateCollection({
            name: collectionName,
            embeddingFunction
        });
        cachedCollection = collection;
        cachedCollectionName = collectionName;
        console.log(`[VectorService] Connected to collection '${collectionName}' (${collection.id})`);
        return collection;
    } catch (e) {
        console.error(`[VectorService] Connection failed to ${config.chromaUrl} for collection ${collectionName}`, e);
        return null;
    }
}

export const vectorService = {

    async healthCheck(): Promise<boolean> {
        try {
            const heartbeat = await getClient().heartbeat();
            return typeof heartbeat === 'number' || typeof heartbeat === 'string';
        } catch (e) {
            return false;
        }
    },

    // --- Core Operations ---

    async getOrCreateCollection(): Promise<string | null> {
        const collection = await getCollectionInstance();
        return collection?.id ?? null;
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

        const collection = await getCollectionInstance();
        if (!collection) return false;

        try {
            const metadata = {
                id: symbol.id,
                name: symbol.name,
                triad: symbol.triad,
                symbol_domain: symbol.symbol_domain,
                domain: symbol.symbol_domain,
                symbol_tag: symbol.symbol_tag,
                kind: symbol.kind || 'pattern',
                macro: symbol.macro,
                role: symbol.role,
                failure_mode: symbol.failure_mode,
                linked_patterns: symbol.linked_patterns,
                facets: symbol.facets,
                lattice: symbol.lattice,
                persona: symbol.persona,
                created_at: symbol.created_at,
                updated_at: symbol.updated_at,
            };

            await collection.upsert({
                ids: [symbol.id],
                metadatas: [metadata],
                documents: [content]
            });

            console.log(`[VectorService:Chroma] Indexed ${symbol.id}`);
            return true;
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
        const collection = await getCollectionInstance();
        if (!collection) return false;

        try {
            await collection.delete({ ids: [symbolId] });
            return true;
        } catch (e) {
            console.error("[VectorService] Delete failed", e);
            return false;
        }
    },

    async search(query: string, nResults: number = 5, metadataFilter?: Record<string, any>): Promise<VectorSearchResult[]> {
        const collection = await getCollectionInstance();
        if (!collection) return [];

        try {
            const data = await collection.query({
                queryTexts: [query],
                nResults: nResults,
                include: ["metadatas", "documents", "distances"],
                where: metadataFilter && Object.keys(metadataFilter).length > 0 ? metadataFilter : undefined,
            });

            const ids = data.ids?.[0] || [];
            const metadatas = data.metadatas?.[0] || [];
            const documents = data.documents?.[0] || [];
            const distances = data.distances?.[0] || [];

            const results: VectorSearchResult[] = ids.map((id: string, idx: number) => ({
                id,
                metadata: metadatas[idx],
                document: documents[idx] || "",
                score: 1 - (distances[idx] || 0)
            }));

            return results;

        } catch (e) {
            console.error("[VectorService] Search failed", e);
            return [];
        }
    },

    async resetCollection(): Promise<boolean> {
        try {
            const config = settingsService.getVectorSettings();
            await getClient().deleteCollection({ name: config.collectionName });
            cachedCollection = null;
            cachedCollectionName = null;
            return true;
        } catch (e) {
            return false;
        }
    },

    async countCollection(): Promise<number> {
        const collection = await getCollectionInstance();
        if (!collection) return 0;

        try {
            const count = await collection.count();
            return typeof count === 'number' ? count : 0;
        } catch (e) {
            console.error("[VectorService] Failed to count collection", e);
            return 0;
        }
    }
};

export const __vectorTestUtils = {
    resetCache
};
