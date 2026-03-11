import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { symbolCacheService } from '../services/symbolCacheService.ts';
import { contextWindowService } from '../services/contextWindowService.ts';
import { domainService } from '../services/domainService.ts';
import { traceService } from '../services/traceService.ts';
import { contextService } from '../services/contextService.js';
import { redisService } from '../services/redisService.js';
import { SymbolDef } from '../types.js';

vi.mock('../services/redisService.js');
vi.mock('../services/contextService.js');

const MOCK_SYMBOL: SymbolDef = {
    id: 'S1',
    name: 'Sym 1',
    kind: 'pattern',
    triad: 'A,B,C',
    macro: 'Macro 1',
    role: 'Role 1',
    symbol_domain: 'dom1',
    symbol_tag: 'tag1',
    failure_mode: 'none',
    activation_conditions: [],
    linked_patterns: [],
    facets: { function: 'f1' } as any,
    created_at: '2026-03-10T00:00:00Z',
    updated_at: '2026-03-10T00:00:00Z'
};

const GLOBAL_REDIS_DATA: Record<string, string> = {};

describe('SymbolCache Tests', () => {

    beforeEach(() => {
        // Reset global redis data before each test
        for (const key in GLOBAL_REDIS_DATA) delete GLOBAL_REDIS_DATA[key];
        
        vi.mocked(redisService.request).mockImplementation(async (args: any[]) => {
            const cmd = args[0];
            const key = args[1];
            if (cmd === 'GET') return GLOBAL_REDIS_DATA[key] || null;
            if (cmd === 'SET') {
                GLOBAL_REDIS_DATA[key] = args[2];
                return 'OK';
            }
            if (cmd === 'DEL') {
                const count = (args as string[]).slice(1).filter(k => GLOBAL_REDIS_DATA[k]).length;
                (args as string[]).slice(1).forEach(k => delete GLOBAL_REDIS_DATA[k]);
                return count;
            }
            if (cmd === 'SADD' || cmd === 'EXISTS' || cmd === 'EXPIRE') return 1;
            return null;
        });
    });

    describe('SymbolCacheService', () => {
        it('should upsert and retrieve symbols', async () => {
            await symbolCacheService.upsertSymbol('sess-1', MOCK_SYMBOL);
            const symbols = await symbolCacheService.getSymbols('sess-1');
            expect(symbols).toHaveLength(1);
            expect(symbols[0].id).toBe('S1');
        });

        it('should increment turns and evict after 5 turns', async () => {
            await symbolCacheService.upsertSymbol('sess-1', MOCK_SYMBOL);
            
            // Turn 1
            await symbolCacheService.incrementTurns('sess-1');
            let symbols = await symbolCacheService.getSymbols('sess-1');
            expect(symbols).toHaveLength(1);

            // Turn 2, 3, 4
            await symbolCacheService.incrementTurns('sess-1');
            await symbolCacheService.incrementTurns('sess-1');
            await symbolCacheService.incrementTurns('sess-1');
            symbols = await symbolCacheService.getSymbols('sess-1');
            expect(symbols).toHaveLength(1);

            // Turn 5 -> Evict
            await symbolCacheService.incrementTurns('sess-1');
            symbols = await symbolCacheService.getSymbols('sess-1');
            expect(symbols).toHaveLength(0);
        });

        it('should reset turn count when touched', async () => {
            await symbolCacheService.upsertSymbol('sess-1', MOCK_SYMBOL);
            await symbolCacheService.incrementTurns('sess-1');
            await symbolCacheService.incrementTurns('sess-1');
            
            // Should have turnCount 2 now
            await symbolCacheService.touchSymbol('sess-1', 'S1');
            
            // Increment 3 more times (total 5 since start, but 3 since touch)
            await symbolCacheService.incrementTurns('sess-1');
            await symbolCacheService.incrementTurns('sess-1');
            await symbolCacheService.incrementTurns('sess-1');
            
            const symbols = await symbolCacheService.getSymbols('sess-1');
            expect(symbols).toHaveLength(1); // Should still be there because touch reset it
        });

        it('should sort symbols by turn count ASC', async () => {
            const s1 = { ...MOCK_SYMBOL, id: 'S1' };
            const s2 = { ...MOCK_SYMBOL, id: 'S2' };
            
            await symbolCacheService.upsertSymbol('sess-1', s1);
            await symbolCacheService.incrementTurns('sess-1');
            await symbolCacheService.upsertSymbol('sess-1', s2);
            
            const symbols = await symbolCacheService.getSymbols('sess-1');
            expect(symbols[0].id).toBe('S2'); // turnCount 0
            expect(symbols[1].id).toBe('S1'); // turnCount 1
        });

        it('should clear cache when clearCache is called', async () => {
            await symbolCacheService.upsertSymbol('sess-1', MOCK_SYMBOL);
            await symbolCacheService.clearCache('sess-1');
            const symbols = await symbolCacheService.getSymbols('sess-1');
            expect(symbols).toHaveLength(0);
        });
    });

    describe('Integration: ContextWindowService with Cache', () => {
        beforeEach(() => {
            vi.mocked(contextService.getSession).mockResolvedValue({ id: 'sess-1', type: 'conversation' } as any);
            vi.mocked(contextService.getUnfilteredHistory).mockResolvedValue([]);
            vi.spyOn(domainService, 'getMetadata').mockResolvedValue([]);
            vi.spyOn(domainService, 'findById').mockResolvedValue(null);
            vi.spyOn(domainService, 'get').mockResolvedValue({ enabled: true, symbols: [] } as any);
        });

        it('should inject [SYMBOL CACHE] into dynamic context', async () => {
            await symbolCacheService.upsertSymbol('sess-1', MOCK_SYMBOL);
            
            const window = await contextWindowService.constructContextWindow('sess-1', 'Prompt');
            const dynamicState = window.find(m => m.content?.includes('[DYNAMIC_STATE]'))?.content || '';
            
            expect(dynamicState).toContain('[SYMBOL CACHE]');
            expect(dynamicState).toContain('| S1 | Sym 1 |');
        });
    });

    describe('Integration: DomainService Search with Cache Filtering', () => {
        beforeEach(() => {
            vi.spyOn(domainService, 'listDomains').mockResolvedValue(['root']);
            vi.spyOn(domainService, 'get').mockResolvedValue({ enabled: true, symbols: [] } as any);
        });

        it('should filter out cached symbols from search results', async () => {
            const { vectorService } = await import('../services/vectorService.js');
            vi.mock('../services/vectorService.js');
            vi.mocked(vectorService.search).mockResolvedValue([
                { id: 'S1', score: 0.9, metadata: {}, document: '' },
                { id: 'S2', score: 0.8, metadata: {}, document: '' }
            ]);

            await symbolCacheService.upsertSymbol('sess-1', { id: 'S1' } as any);
            
            const results = await domainService.search('query', 10, { contextSessionId: 'sess-1' });
            
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('S2');
        });
    });
});
