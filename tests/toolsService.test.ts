
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createToolExecutor } from '../services/toolsService.ts';
import { domainService } from '../services/domainService.ts';
import { testService } from '../services/testService.ts';
import { traceService } from '../services/traceService.ts';

const VALID_SYMBOL = {
    id: 's1',
    name: 'S1',
    kind: 'pattern',
    triad: 'T1',
    macro: 'M1',
    role: 'R1',
    symbol_domain: 'dom',
    symbol_tag: 'tag',
    failure_mode: 'fail',
    activation_conditions: [],
    linked_patterns: [],
    facets: {
        function: 'f',
        topology: 't',
        commit: 'c',
        gate: [],
        substrate: ['text'],
        temporal: 'now',
        invariants: []
    }
};

describe('ToolsService', () => {
    let toolExecutor: any;

    beforeEach(() => {
        vi.spyOn(domainService, 'hasDomain').mockResolvedValue(true);
        vi.spyOn(domainService, 'getSymbols').mockResolvedValue([]);
        vi.spyOn(domainService, 'listDomains').mockResolvedValue(['root', 'dom']);
        vi.spyOn(domainService, 'findById').mockResolvedValue(null);
        vi.spyOn(domainService, 'bulkUpsert').mockResolvedValue(undefined as any);
        vi.spyOn(domainService, 'deleteSymbols').mockResolvedValue(undefined);
        vi.spyOn(domainService, 'search').mockResolvedValue([]);
        vi.spyOn(domainService, 'getMetadata').mockResolvedValue([]);
        vi.spyOn(domainService, 'processRefactorOperation').mockResolvedValue({ count: 1, renamedIds: [] });

        vi.spyOn(testService, 'addTest').mockResolvedValue(undefined);
        vi.spyOn(testService, 'listTestSets').mockResolvedValue([] as any);
        vi.spyOn(testService, 'listTestRuns').mockResolvedValue([] as any);
        vi.spyOn(testService, 'getTestRun').mockResolvedValue({ id: 'r1', testSetName: 'TS1', summary: { total: 1, completed: 1, passed: 1, failed: 0 }, results: [] } as any);
        vi.spyOn(traceService, 'addTrace').mockResolvedValue(undefined as any);

        toolExecutor = createToolExecutor(() => 'mock-api-key');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('find_symbols routes semantic search to domainService.search with metadata filter', async () => {
        vi.mocked(domainService.hasDomain).mockResolvedValue(true);

        await toolExecutor('find_symbols', {
            queries: [{
                query: 'test vector',
                symbol_domains: ['root', 'diagnostics'],
                limit: 3,
                metadata_filter: { symbol_tag: 'protocol' }
            }]
        });

        expect(domainService.search).toHaveBeenCalledWith('test vector', 3, expect.objectContaining({
            metadata_filter: { symbol_tag: 'protocol' },
            domains: ['root', 'diagnostics']
        }));
    });

    it('upsert_symbols calls domainService.bulkUpsert for adds', async () => {
        const sym = { ...VALID_SYMBOL, id: 's1', symbol_domain: 'dom' };
        await toolExecutor('upsert_symbols', { symbols: [{ symbol_data: sym }] });
        expect(domainService.bulkUpsert).toHaveBeenCalledWith('dom', [sym], expect.anything());
    });

    it('upsert_symbols routes renames to processRefactorOperation', async () => {
        const sym = { ...VALID_SYMBOL, id: 'new', symbol_domain: 'dom' };
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

        const res = await toolExecutor('find_symbols', { queries: [{ symbol_tag: 'alpha', limit: 1 }] });

        expect(domainService.search).not.toHaveBeenCalled();
        expect(domainService.getSymbols).toHaveBeenCalledWith('root');
        expect(res.symbols.map((s: any) => s.id)).toEqual(['s1']);
        expect(res.count).toBe(1);
    });

    it('list_domains exposes readOnly flag in response', async () => {
        vi.mocked(domainService.getMetadata).mockResolvedValue([
            { id: 'd1', name: 'Domain 1', readOnly: true, description: '', invariants: [] } as any,
        ]);

        const res = await toolExecutor('list_domains', {});

        expect(res.domains[0].readOnly).toBe(true);
    });

    it('list_test_runs calls testService.listTestRuns', async () => {
        await toolExecutor('list_test_runs', {});
        expect(testService.listTestRuns).toHaveBeenCalled();
    });

    it('list_test_failures calls testService.getTestRun', async () => {
        await toolExecutor('list_test_failures', { run_id: 'r1' });
        expect(testService.getTestRun).toHaveBeenCalledWith('r1');
    });

    it('log_trace calls traceService.addTrace', async () => {
        const trace = { id: 't1' };
        await toolExecutor('log_trace', { trace });
        expect(traceService.addTrace).toHaveBeenCalled();
    });

    it('upsert_symbols handles updates via processRefactorOperation', async () => {
        const updates = [{ old_id: 'o1', symbol_data: { ...VALID_SYMBOL, id: 'n1', symbol_domain: 'root' } }];
        await toolExecutor('upsert_symbols', { symbols: updates });
        expect(domainService.processRefactorOperation).toHaveBeenCalledWith(updates);
    });
});
