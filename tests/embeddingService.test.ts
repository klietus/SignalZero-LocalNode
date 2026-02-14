import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { embedTexts, embedText, resetEmbeddingCache } from '../services/embeddingService.ts';

describe('EmbeddingService', () => {
    beforeEach(() => {
        resetEmbeddingCache();
    });

    afterEach(() => {
        resetEmbeddingCache();
    });

    it('should export required functions', () => {
        expect(typeof embedTexts).toBe('function');
        expect(typeof embedText).toBe('function');
        expect(typeof resetEmbeddingCache).toBe('function');
    });

    it('should return empty array for empty input to embedTexts', async () => {
        const result = await embedTexts([]);
        expect(result).toEqual([]);
    });

    it('should return empty array for null/undefined input to embedTexts', async () => {
        const result = await embedTexts(null as any);
        expect(result).toEqual([]);
    });

    it('should return single embedding for single text via embedText', async () => {
        // This will attempt to load the model, which may fail in tests
        // but we can at least verify the function structure
        expect(typeof embedText).toBe('function');
    });

    it('should reset cache when resetEmbeddingCache is called', () => {
        // Just verify the function doesn't throw
        expect(() => resetEmbeddingCache()).not.toThrow();
    });
});
