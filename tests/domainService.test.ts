
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { domainService } from '../services/domainService.ts';
import { vectorService } from '../services/vectorService.ts';
import { __redisTestUtils, redisService } from '../services/redisService.ts';

describe('DomainService', () => {
    beforeEach(() => {
        __redisTestUtils.resetMock();

        // Mock vector service to avoid side effects
        vi.spyOn(vectorService, 'indexSymbol').mockResolvedValue(true);
        vi.spyOn(vectorService, 'deleteSymbol').mockResolvedValue(true);
        vi.spyOn(vectorService, 'search').mockResolvedValue([]);
        vi.spyOn(vectorService, 'resetCollection').mockResolvedValue(true);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        __redisTestUtils.resetMock();
    });

    it('should list domains', async () => {
        await redisService.request(['SADD', 'sz:domains', 'domain-a', 'domain-b']);

        const domains = await domainService.listDomains();
        expect(domains).toEqual(['domain-a', 'domain-b']);
    });

    it('should check if domain exists', async () => {
        await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify({ id: 'test-domain', symbols: [] })]);

        const exists = await domainService.hasDomain('test-domain');
        expect(exists).toBe(true);
    });

    it('should migrate legacy string links to structured SymbolLink objects', async () => {
        const legacySymbol = {
            id: 'legacy-1',
            name: 'Legacy',
            linked_patterns: ['sym-a', 'sym-b']
        };
        const mockDomain = {
            id: 'mig-domain',
            symbols: [legacySymbol]
        };

        // Trigger migration by calling a method that uses parseDomain/migrateSymbols
        await redisService.request(['SET', 'sz:domain:mig-domain', JSON.stringify(mockDomain)]);
        const symbols = await domainService.getSymbols('mig-domain');
        
        expect(symbols[0].linked_patterns[0]).toEqual({ id: 'sym-a', link_type: 'relates_to', bidirectional: false });
        expect(symbols[0].linked_patterns[1]).toEqual({ id: 'sym-b', link_type: 'relates_to', bidirectional: false });
    });

    it('should upsert a symbol with structured links', async () => {
        await domainService.createDomain('new-domain');
        const symbol: any = { 
            id: 'sym-1', 
            name: 'Symbol 1',
            linked_patterns: [{ id: 'other-1', link_type: 'depends_on', bidirectional: true }]
        };
        await domainService.upsertSymbol('new-domain', symbol, { bypassValidation: true });

        const stored = await redisService.request(['GET', 'sz:domain:new-domain']);
        const domain = JSON.parse(stored);
        expect(domain.symbols[0].linked_patterns[0].id).toBe('other-1');
        expect(domain.symbols[0].linked_patterns[0].link_type).toBe('depends_on');
    });

    it('should create back-links for bidirectional links', async () => {
        await domainService.createDomain('test-dom');
        const symA: any = { id: 'SYM-A', name: 'Alpha', linked_patterns: [], symbol_domain: 'test-dom' };
        const symB: any = { 
            id: 'SYM-B', 
            name: 'Beta', 
            symbol_domain: 'test-dom',
            linked_patterns: [{ id: 'SYM-A', link_type: 'relates_to', bidirectional: true }] 
        };

        await domainService.upsertSymbol('test-dom', symA, { bypassValidation: true });
        await domainService.upsertSymbol('test-dom', symB, { bypassValidation: true });

        const updatedA = await domainService.findById('SYM-A');
        expect(updatedA?.linked_patterns).toContainEqual({ id: 'SYM-B', link_type: 'relates_to', bidirectional: true });
    });

    it('should delete a symbol and perform cascade cleanup on structured links', async () => {
         const mockDomain = {
            id: 'test-domain',
            symbols: [
                { id: 's1' }, 
                { id: 's2', linked_patterns: [{ id: 's1', link_type: 'relates_to', bidirectional: false }] }
            ]
        };

        await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(mockDomain)]);

        await domainService.deleteSymbol('test-domain', 's1');

        const updated = await redisService.request(['GET', 'sz:domain:test-domain']);
        const domainObj = JSON.parse(updated);
        expect(domainObj.symbols).toHaveLength(1);
        expect(domainObj.symbols[0].id).toBe('s2');
        expect(domainObj.symbols[0].linked_patterns).toHaveLength(0);
    });
});
