
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { testService } from '../services/testService.ts';
import { __redisTestUtils } from '../services/redisService.ts';

describe('TestService', () => {
    beforeEach(() => {
        __redisTestUtils.resetMock();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        __redisTestUtils.resetMock();
    });

    it('should list test sets (empty -> default)', async () => {
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

        await testService.createOrUpdateTestSet({ ...mockSet, createdAt: '', updatedAt: '' });

        const runner = vi.fn().mockResolvedValue({ text: 'res', meta: {} });

        const run = await testService.startTestRun('ts1', runner);

        expect(run.id).toBeDefined();
        expect(run.testSetId).toBe('ts1');

        // Wait briefly for async loop (optional, but good to check if runner called)
        await new Promise(r => setTimeout(r, 10));

        expect(runner).toHaveBeenCalledWith('Prompt 1');
    });
});
