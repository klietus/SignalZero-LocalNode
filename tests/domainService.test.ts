
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { domainService } from '../services/domainService.ts';
import { settingsService } from '../services/settingsService.ts';
import { vectorService } from '../services/vectorService.ts';

describe('DomainService', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(settingsService, 'getRedisSettings').mockReturnValue({
            redisUrl: 'http://mock-redis',
            redisToken: 'mock-token'
        });

        // Mock vector service to avoid side effects
        vi.spyOn(vectorService, 'indexSymbol').mockResolvedValue(true);
        vi.spyOn(vectorService, 'deleteSymbol').mockResolvedValue(true);
        vi.spyOn(vectorService, 'search').mockResolvedValue([]);
        vi.spyOn(vectorService, 'resetCollection').mockResolvedValue(true);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('should list domains', async () => {
        // Mock SMEMBERS response
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: ['domain-a', 'domain-b'] })
        });

        const domains = await domainService.listDomains();
        expect(domains).toEqual(['domain-a', 'domain-b']);
        expect(fetchMock).toHaveBeenCalledWith('http://mock-redis', expect.anything());
    });

    it('should check if domain exists', async () => {
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: 1 })
        });

        const exists = await domainService.hasDomain('test-domain');
        expect(exists).toBe(true);
    });

    it('should upsert a symbol', async () => {
        // Mock GET domain (returns null first time -> create new)
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: null })
        });

        // Mock SADD (add domain to set)
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: 1 })
        });

        // Mock SET (save domain)
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: 'OK' })
        });

        const symbol: any = { id: 'sym-1', name: 'Symbol 1' };
        await domainService.upsertSymbol('new-domain', symbol);

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(vectorService.indexSymbol).toHaveBeenCalledWith(symbol);
    });

    it('should get symbols for a domain', async () => {
        const mockDomain = {
            id: 'test-domain',
            symbols: [{ id: 's1', name: 'S1' }]
        };

        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: JSON.stringify(mockDomain) })
        });

        const symbols = await domainService.getSymbols('test-domain');
        expect(symbols).toHaveLength(1);
        expect(symbols[0].id).toBe('s1');
    });

    it('should delete a symbol', async () => {
         const mockDomain = {
            id: 'test-domain',
            symbols: [{ id: 's1' }, { id: 's2' }]
        };

        // Mock GET domain
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: JSON.stringify(mockDomain) })
        });

        // Mock SET domain (after deletion)
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: 'OK' })
        });

        await domainService.deleteSymbol('test-domain', 's1');

        expect(vectorService.deleteSymbol).toHaveBeenCalledWith('s1');
        // Check that SET was called with updated domain
        const setCall = fetchMock.mock.calls[1];
        const body = JSON.parse(setCall[1].body);
        
        // Actually redisRequest sends ['SET', key, val]
        // body is array
        
        // Let's inspect the args passed to redisRequest logic via fetch
        // The fetch body is stringified array
        expect(body[0]).toBe('SET');
        const domainObj = JSON.parse(body[2]);
        expect(domainObj.symbols).toHaveLength(1);
        expect(domainObj.symbols[0].id).toBe('s2');
    });
});
