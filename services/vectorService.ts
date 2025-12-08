import { SymbolDef, VectorSearchResult } from '../types.ts';
import { settingsService } from './settingsService.ts';

export const vectorService = {
    
    async healthCheck(): Promise<boolean> {
        const config = settingsService.getVectorSettings();
        const baseUrl = config.chromaUrl;
        try {
            const res = await fetch(`${baseUrl}/api/v2/heartbeat`);
            return res.ok;
        } catch (e) {
            return false;
        }
    },

    // --- Core Operations ---

    async getOrCreateCollection(): Promise<string | null> {
        const config = settingsService.getVectorSettings();
        
        // Always enforce external URL usage now
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
            const data = await res.json() as any;
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

        const config = settingsService.getVectorSettings();
        const baseUrl = config.chromaUrl;
        const collectionId = await this.getOrCreateCollection();
        if (!collectionId) return false;

        try {
            // UPDATED: API v2
            // We do NOT send embeddings; ChromaDB (server) will generate them via its default EF
            const payload = {
                ids: [symbol.id],
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
        const config = settingsService.getVectorSettings();
        const baseUrl = config.chromaUrl;
        const collectionId = await this.getOrCreateCollection();
        if (!collectionId) return [];

        try {
            console.log(`[VectorService] Querying Chroma: ${baseUrl} (Collection: ${collectionId})`);
            // UPDATED: API v2
            // Send query_texts (let ChromaDB generate embedding)
            const res = await fetch(`${baseUrl}/api/v2/collections/${collectionId}/query`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query_texts: [query],
                    n_results: nResults,
                    include: ["metadatas", "documents", "distances"]
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                console.error(`[VectorService] Query failed: ${res.status}`, errText);
                return [];
            }

            const data = await res.json() as any;
            
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
