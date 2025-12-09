
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createToolExecutor } from '../services/toolsService.ts';
import { domainService } from '../services/domainService.ts';
import { testService } from '../services/testService.ts';
import { traceService } from '../services/traceService.ts';

describe('ToolsService', () => {
    let toolExecutor: any;

    beforeEach(() => {
        vi.spyOn(domainService, 'hasDomain').mockResolvedValue(true);
        vi.spyOn(domainService, 'getSymbols').mockResolvedValue([]);
        vi.spyOn(domainService, 'query').mockResolvedValue({ items: [], total: 0, source: 'redis_cache' });
        vi.spyOn(domainService, 'findById').mockResolvedValue(null);
        vi.spyOn(domainService, 'upsertSymbol').mockResolvedValue(undefined);
        vi.spyOn(domainService, 'deleteSymbol').mockResolvedValue(undefined);
        vi.spyOn(domainService, 'search').mockResolvedValue([]);
        vi.spyOn(domainService, 'getMetadata').mockResolvedValue([]);
        vi.spyOn(domainService, 'processRefactorOperation').mockResolvedValue({ count: 1, renamedIds: [] });
        vi.spyOn(domainService, 'compressSymbols').mockResolvedValue({ newId: 'new', removedIds: ['old'] });

        vi.spyOn(testService, 'addTest').mockResolvedValue(undefined);
        vi.spyOn(traceService, 'addTrace').mockReturnValue(undefined);

        toolExecutor = createToolExecutor(() => 'mock-api-key');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('query_symbols calls domainService.query', async () => {
        await toolExecutor('query_symbols', { symbol_domain: 'root', limit: 10 });
        expect(domainService.query).toHaveBeenCalledWith('root', undefined, 10, undefined);
    });

    it('get_symbol_by_id calls domainService.findById', async () => {
        vi.mocked(domainService.findById).mockResolvedValue({ id: 's1' } as any);
        const res = await toolExecutor('get_symbol_by_id', { id: 's1' });
        expect(domainService.findById).toHaveBeenCalledWith('s1');
        expect(res).toEqual({ id: 's1' });
    });

    it('save_symbol calls domainService.upsertSymbol', async () => {
        const sym = { id: 's1', symbol_domain: 'dom' };
        await toolExecutor('save_symbol', { symbol_id: 's1', symbol_data: sym });
        expect(domainService.upsertSymbol).toHaveBeenCalledWith('dom', sym);
    });

    it('delete_symbol calls domainService.deleteSymbol', async () => {
        // Needs to find symbol to infer domain
        vi.mocked(domainService.findById).mockResolvedValue({ id: 's1', symbol_domain: 'dom' } as any);
        
        await toolExecutor('delete_symbol', { symbol_id: 's1' });
        expect(domainService.deleteSymbol).toHaveBeenCalledWith('dom', 's1', true);
    });

    it('search_symbols_vector calls domainService.search', async () => {
        await toolExecutor('search_symbols_vector', { query: 'test' });
        expect(domainService.search).toHaveBeenCalledWith('test', 5);
    });

    it('add_test_case calls testService.addTest', async () => {
        await toolExecutor('add_test_case', { prompt: 'Do something', testSetId: 'ts1', expectedActivations: [] });
        expect(testService.addTest).toHaveBeenCalledWith('ts1', 'Do something', []);
    });

    it('log_trace calls traceService.addTrace', async () => {
        const trace = { id: 't1' };
        await toolExecutor('log_trace', { trace });
        expect(traceService.addTrace).toHaveBeenCalledWith(trace);
    });

    it('bulk_update_symbols calls domainService.processRefactorOperation', async () => {
        const updates = [{ old_id: 'o1', symbol_data: { id: 'n1' } }];
        await toolExecutor('bulk_update_symbols', { updates });
        expect(domainService.processRefactorOperation).toHaveBeenCalledWith(updates);
    });

    it('compress_symbols calls domainService.compressSymbols', async () => {
        await toolExecutor('compress_symbols', { new_symbol: {}, old_ids: [] });
        expect(domainService.compressSymbols).toHaveBeenCalled();
    });
});
