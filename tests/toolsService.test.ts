
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
        vi.spyOn(domainService, 'listDomains').mockResolvedValue(['root']);
        vi.spyOn(domainService, 'findById').mockResolvedValue(null);
        vi.spyOn(domainService, 'bulkUpsert').mockResolvedValue(undefined as any);
        vi.spyOn(domainService, 'deleteSymbols').mockResolvedValue(undefined);
        vi.spyOn(domainService, 'search').mockResolvedValue([]);
        vi.spyOn(domainService, 'getMetadata').mockResolvedValue([]);
        vi.spyOn(domainService, 'processRefactorOperation').mockResolvedValue({ count: 1, renamedIds: [] });
        vi.spyOn(domainService, 'compressSymbols').mockResolvedValue({ newId: 'new', removedIds: ['old'] });

        vi.spyOn(testService, 'addTest').mockResolvedValue(undefined);
        vi.spyOn(testService, 'listTestSets').mockResolvedValue([] as any);
        vi.spyOn(traceService, 'addTrace').mockReturnValue(undefined);

        toolExecutor = createToolExecutor(() => 'mock-api-key');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('find_symbols routes semantic search to domainService.search with metadata filter', async () => {
        vi.mocked(domainService.hasDomain).mockResolvedValue(true);

        await toolExecutor('find_symbols', {
            query: 'test vector',
            symbol_domains: ['root', 'diagnostics'],
            limit: 3,
            metadata_filter: { symbol_tag: 'protocol' }
        });

        expect(domainService.search).toHaveBeenCalledWith('test vector', 3, {
            time_gte: undefined,
            time_between: undefined,
            metadata_filter: { symbol_tag: 'protocol', symbol_domain: ['root', 'diagnostics'] },
            domains: ['root', 'diagnostics']
        });
    });

    it('upsert_symbols calls domainService.bulkUpsert for adds', async () => {
        const sym = { id: 's1', symbol_domain: 'dom' };
        await toolExecutor('upsert_symbols', { symbols: [{ symbol_data: sym }] });
        expect(domainService.bulkUpsert).toHaveBeenCalledWith('dom', [sym]);
    });

    it('upsert_symbols routes renames to processRefactorOperation', async () => {
        const sym = { id: 'new', symbol_domain: 'dom' };
        await toolExecutor('upsert_symbols', { symbols: [{ old_id: 'old', symbol_data: sym }] });
        expect(domainService.processRefactorOperation).toHaveBeenCalledWith([{ old_id: 'old', symbol_data: sym }]);
    });

    it('delete_symbols calls domainService.deleteSymbols', async () => {
        // Needs to find symbol to infer domain
        vi.mocked(domainService.findById).mockResolvedValue({ id: 's1', symbol_domain: 'dom' } as any);

        await toolExecutor('delete_symbols', { symbol_ids: ['s1'] });
        expect(domainService.deleteSymbols).toHaveBeenCalledWith('dom', ['s1'], true);
    });

    it('find_symbols supports structured filtering when no semantic query is provided', async () => {
        vi.mocked(domainService.getSymbols).mockResolvedValue([
            { id: 's1', symbol_tag: 'alpha', symbol_domain: 'root' } as any,
            { id: 's2', symbol_tag: 'beta', symbol_domain: 'root' } as any,
        ]);

        const res = await toolExecutor('find_symbols', { symbol_tag: 'alpha', limit: 1 });

        expect(domainService.search).not.toHaveBeenCalled();
        expect(domainService.getSymbols).toHaveBeenCalledWith('root');
        expect(res.symbols.map((s: any) => s.id)).toEqual(['s1']);
        expect(res.count).toBe(1);
    });

    it('add_test_case calls testService.addTest', async () => {
        await toolExecutor('add_test_case', { name: 'Case', prompt: 'Do something', testSetId: 'ts1', expectedActivations: [] });
        expect(testService.addTest).toHaveBeenCalledWith('ts1', 'Do something', [], 'Case');
    });

    it('list_test_sets calls testService.listTestSets', async () => {
        await toolExecutor('list_test_sets', {});
        expect(testService.listTestSets).toHaveBeenCalled();
    });

    it('log_trace calls traceService.addTrace', async () => {
        const trace = { id: 't1' };
        await toolExecutor('log_trace', { trace });
        expect(traceService.addTrace).toHaveBeenCalledWith(trace);
    });

    it('upsert_symbols handles updates via processRefactorOperation', async () => {
        const updates = [{ old_id: 'o1', symbol_data: { id: 'n1', symbol_domain: 'root' } }];
        await toolExecutor('upsert_symbols', { symbols: updates });
        expect(domainService.processRefactorOperation).toHaveBeenCalledWith(updates);
    });

    it('compress_symbols calls domainService.compressSymbols', async () => {
        await toolExecutor('compress_symbols', { new_symbol: {}, old_ids: [] });
        expect(domainService.compressSymbols).toHaveBeenCalled();
    });
});
