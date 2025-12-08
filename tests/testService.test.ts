
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { testService } from '../services/testService.ts';
import { settingsService } from '../services/settingsService.ts';

describe('TestService', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.stubGlobal('fetch', fetchMock);
        vi.spyOn(settingsService, 'getRedisSettings').mockReturnValue({
            redisUrl: 'http://mock-redis',
            redisToken: 'token'
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('should list test sets (empty -> default)', async () => {
        // SMEMBERS -> empty
        fetchMock.mockResolvedValueOnce({
             json: async () => ({ result: [] })
        });
        // SADD
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: 1 })
       });
       // SET
       fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: 'OK' })
       });

        const sets = await testService.listTestSets();
        expect(sets).toHaveLength(1);
        expect(sets[0].id).toBe('default');
    });

    it('should create a test run', async () => {
        const mockSet = {
            id: 'ts1',
            name: 'Test Set 1',
            tests: ['Prompt 1']
        };

        // getTestSet -> GET
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: JSON.stringify(mockSet) })
        });

        // SADD run
        fetchMock.mockResolvedValueOnce({
            json: async () => ({ result: 1 })
        });
        // SET run
        fetchMock.mockResolvedValueOnce({
             json: async () => ({ result: 'OK' })
        });
        // Run loop updates (SET) ... ignored for this test since async
        fetchMock.mockResolvedValue({
             json: async () => ({ result: 'OK' })
        });

        const runner = vi.fn().mockResolvedValue({ text: 'res', meta: {} });
        
        const run = await testService.startTestRun('ts1', runner);
        
        expect(run.id).toBeDefined();
        expect(run.testSetId).toBe('ts1');
        
        // Wait briefly for async loop (optional, but good to check if runner called)
        await new Promise(r => setTimeout(r, 10));
        
        expect(runner).toHaveBeenCalledWith('Prompt 1');
    });
});
