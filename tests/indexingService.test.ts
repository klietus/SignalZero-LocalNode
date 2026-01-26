import { describe, it, expect, beforeEach, vi } from 'vitest';
import { indexingService } from '../services/indexingService.ts';
import { domainService } from '../services/domainService.ts';
import { vectorService } from '../services/vectorService.ts';

vi.mock('../services/domainService');
vi.mock('../services/vectorService');
vi.mock('../services/loggerService');

describe('IndexingService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should reindex all symbols', async () => {
        const symbols: any[] = [
            { id: 's1', symbol_domain: 'd1' },
            { id: 's2', symbol_domain: 'd1' }
        ];
        vi.mocked(domainService.getAllSymbols).mockResolvedValue(symbols);
        vi.mocked(vectorService.resetCollection).mockResolvedValue(true);
        vi.mocked(vectorService.indexSymbol).mockResolvedValue(true);

        const result = await indexingService.reindexSymbols();
        
        expect(result.status).toBe('completed');
        expect(result.indexedCount).toBe(2);
        expect(vectorService.resetCollection).toHaveBeenCalled();
        expect(vectorService.indexSymbol).toHaveBeenCalledTimes(2);
    });

    it('should remove symbols that fail to index', async () => {
        const symbols: any[] = [{ id: 'fail', symbol_domain: 'd1' }];
        vi.mocked(domainService.getAllSymbols).mockResolvedValue(symbols);
        vi.mocked(vectorService.indexSymbol).mockResolvedValue(false);

        const result = await indexingService.reindexSymbols();
        
        expect(result.failedIds).toContain('fail');
        expect(domainService.deleteSymbol).toHaveBeenCalledWith('d1', 'fail', false);
    });

    it('should prevent concurrent reindexing', async () => {
        vi.mocked(domainService.getAllSymbols).mockImplementation(async () => {
            await new Promise(r => setTimeout(r, 50));
            return [];
        });

        const p1 = indexingService.reindexSymbols();
        const p2 = indexingService.reindexSymbols();
        
        const [r1, r2] = await Promise.all([p1, p2]);
        
        expect(r1.status).toBe('completed');
        expect(r2.status).toBe('already-running');
    });
});
