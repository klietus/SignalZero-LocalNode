import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { settingsService } from '../services/settingsService.ts';
import { vectorService, __vectorTestUtils } from '../services/vectorService.ts';

const collectionMock = {
    id: 'col-uuid',
    upsert: vi.fn(),
    query: vi.fn(),
    delete: vi.fn()
};

const getOrCreateCollectionMock = vi.fn(async () => collectionMock);
const heartbeatMock = vi.fn(async () => 'ok');
const deleteCollectionMock = vi.fn(async () => undefined);

vi.mock('chromadb', () => ({
    __esModule: true,
    ChromaClient: vi.fn(() => ({
        getOrCreateCollection: getOrCreateCollectionMock,
        heartbeat: heartbeatMock,
        deleteCollection: deleteCollectionMock
    }))
}));

describe('VectorService', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        collectionMock.upsert.mockReset();
        collectionMock.query.mockReset();
        collectionMock.delete.mockReset();
        getOrCreateCollectionMock.mockClear();
        heartbeatMock.mockClear();
        deleteCollectionMock.mockClear();
        __vectorTestUtils.resetCache();
    });

    afterEach(() => {
        __vectorTestUtils.resetCache();
    });

    it('should index symbol to external ChromaDB', async () => {
        vi.spyOn(settingsService, 'getVectorSettings').mockReturnValue({
            useExternal: true,
            chromaUrl: 'http://mock-chroma',
            collectionName: 'test-col'
        });

        collectionMock.upsert.mockResolvedValueOnce(undefined);

        const symbol: any = {
            id: 'test-sym-ext',
            name: 'Test External',
            symbol_domain: 'test',
            triad: 'test',
            role: 'test'
        };

        const result = await vectorService.indexSymbol(symbol);
        expect(result).toBe(true);

        expect(getOrCreateCollectionMock).toHaveBeenCalledWith({ name: 'test-col' });
        expect(collectionMock.upsert).toHaveBeenCalledTimes(1);
        const upsertPayload = collectionMock.upsert.mock.calls[0][0];
        expect(upsertPayload.documents).toBeDefined();
        expect(upsertPayload.ids).toEqual(['test-sym-ext']);
    });

    it('should handle search with external provider using query_texts', async () => {
        vi.spyOn(settingsService, 'getVectorSettings').mockReturnValue({
            useExternal: true,
            chromaUrl: 'http://mock-chroma',
            collectionName: 'test-col'
        });

        collectionMock.query.mockResolvedValueOnce({
            ids: [['res-1']],
            metadatas: [[{ name: 'Result 1' }]],
            documents: [['doc content']],
            distances: [[0.1]]
        });

        const results = await vectorService.search('query');
        expect(results).toHaveLength(1);
        expect(results[0].id).toBe('res-1');
        expect(results[0].score).toBeCloseTo(0.9);

        expect(collectionMock.query).toHaveBeenCalledWith({
            queryTexts: ['query'],
            nResults: 5,
            include: ['metadatas', 'documents', 'distances']
        });
    });

    it('should delete symbol externally', async () => {
        vi.spyOn(settingsService, 'getVectorSettings').mockReturnValue({
            useExternal: true,
            chromaUrl: 'http://mock-chroma',
            collectionName: 'test-col'
        });

        collectionMock.delete.mockResolvedValueOnce(undefined);

        const success = await vectorService.deleteSymbol('del-me');
        expect(success).toBe(true);
        expect(collectionMock.delete).toHaveBeenCalledWith({ ids: ['del-me'] });
    });
});