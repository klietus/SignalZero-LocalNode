
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

    it('should upsert a symbol', async () => {
        await domainService.createDomain('new-domain');
        const symbol: any = { id: 'sym-1', name: 'Symbol 1' };
        await domainService.upsertSymbol('new-domain', symbol);

        expect(vectorService.indexSymbol).toHaveBeenCalledWith(expect.objectContaining({ id: 'sym-1', name: 'Symbol 1' }));
        const stored = await redisService.request(['GET', 'sz:domain:new-domain']);
        const domain = JSON.parse(stored);
        expect(domain.symbols).toHaveLength(1);
        expect(domain.symbols[0].id).toBe('sym-1');
    });

    it('should get symbols for a domain', async () => {
        const mockDomain = {
            id: 'test-domain',
            symbols: [{ id: 's1', name: 'S1' }]
        };

        await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(mockDomain)]);

        const symbols = await domainService.getSymbols('test-domain');
        expect(symbols).toHaveLength(1);
        expect(symbols[0].id).toBe('s1');
    });

    it('should delete a symbol', async () => {
         const mockDomain = {
            id: 'test-domain',
            symbols: [{ id: 's1' }, { id: 's2' }]
        };

        await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(mockDomain)]);

        await domainService.deleteSymbol('test-domain', 's1');

        expect(vectorService.deleteSymbol).toHaveBeenCalledWith('s1');
        const updated = await redisService.request(['GET', 'sz:domain:test-domain']);
        const domainObj = JSON.parse(updated);
        expect(domainObj.symbols).toHaveLength(1);
        expect(domainObj.symbols[0].id).toBe('s2');
    });
});
