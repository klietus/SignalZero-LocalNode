import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { vectorService } from '../services/vectorService.ts';
import { settingsService } from '../services/settingsService.ts';

describe('VectorService', () => {
    const fetchMock = vi.fn();
    
    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        vi.resetAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('should index symbol to external ChromaDB', async () => {
        vi.spyOn(settingsService, 'getVectorSettings').mockReturnValue({
            useExternal: true, // Always true now effectively
            chromaUrl: 'http://mock-chroma',
            collectionName: 'test-col'
        });

        // Mock getOrCreateCollection response
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'col-uuid' })
        });

        // Mock upsert response
        fetchMock.mockResolvedValueOnce({
            ok: true
        });

        const symbol: any = {
            id: 'test-sym-ext',
            name: 'Test External',
            symbol_domain: 'test',
            triad: 'test',
            role: 'test'
        };

        const result = await vectorService.indexSymbol(symbol);
        expect(result).toBe(true);
        
        // Verify fetch calls
        expect(fetchMock).toHaveBeenCalledTimes(2);
        // First call: get collection
        expect(fetchMock.mock.calls[0][0]).toContain('/api/v2/collections');
        // Second call: upsert
        expect(fetchMock.mock.calls[1][0]).toContain('/api/v2/collections/col-uuid/upsert');
        
        // Verify payload does NOT contain embeddings, but DOES contain documents
        const upsertBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(upsertBody).toHaveProperty('documents');
        expect(upsertBody).not.toHaveProperty('embeddings');
        expect(upsertBody.ids).toEqual(['test-sym-ext']);
    });

    it('should handle search with external provider using query_texts', async () => {
        vi.spyOn(settingsService, 'getVectorSettings').mockReturnValue({
            useExternal: true,
            chromaUrl: 'http://mock-chroma',
            collectionName: 'test-col'
        });

         // Mock getOrCreateCollection response
         fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'col-uuid' })
        });

        // Mock query response
        fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                ids: [['res-1']],
                metadatas: [[{ name: 'Result 1' }]],
                documents: [['doc content']],
                distances: [[0.1]]
            })
        });

        const results = await vectorService.search('query');
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('res-1');
        expect(results[0].score).toBeCloseTo(0.9);

        // Verify query payload uses query_texts
        const queryBody = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(queryBody).toHaveProperty('query_texts');
        expect(queryBody.query_texts).toEqual(['query']);
        expect(queryBody).not.toHaveProperty('query_embeddings');
    });

    it('should delete symbol externally', async () => {
        vi.spyOn(settingsService, 'getVectorSettings').mockReturnValue({
            useExternal: true,
            chromaUrl: 'http://mock-chroma',
            collectionName: 'test-col'
        });

         // Mock getOrCreateCollection response
         fetchMock.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ id: 'col-uuid' })
        });

        // Mock delete response
        fetchMock.mockResolvedValueOnce({
            ok: true
        });
        
        // Delete
        const success = await vectorService.deleteSymbol('del-me');
        expect(success).toBe(true);
        
        expect(fetchMock.mock.calls[1][0]).toContain('/delete');
    });
});