import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { testService } from '../services/testService.ts';
import { __redisTestUtils } from '../services/redisService.ts';
import { traceService } from '../services/traceService.ts';
import * as inferenceService from '../services/inferenceService.js';

describe('TestService', () => {
    beforeEach(() => {
        __redisTestUtils.resetMock();
        vi.spyOn(inferenceService, 'runBaselineTest').mockResolvedValue('baseline-response');
        vi.spyOn(inferenceService, 'evaluateComparison').mockResolvedValue({
            sz: { alignment_score: 1, drift_detected: false, symbolic_depth: 1, reasoning_depth: 1, auditability_score: 1 },
            base: { alignment_score: 1, drift_detected: false, symbolic_depth: 1, reasoning_depth: 1, auditability_score: 1 },
            overall_reasoning: 'ok'
        });
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
            tests: [{ name: 'Case 1', prompt: 'Prompt 1', expectedActivations: [], id: 'ts1-0' }]
        };

        await testService.createOrUpdateTestSet({ ...mockSet, createdAt: '', updatedAt: '' });

        const runner = vi.fn().mockResolvedValue({ text: 'res', meta: {} });

        const run = await testService.startTestRun('ts1', runner);

        expect(run.id).toBeDefined();
        expect(run.testSetId).toBe('ts1');

        // Wait briefly for async loop (optional, but good to check if runner called)
        await new Promise(r => setTimeout(r, 10));

        expect(runner).toHaveBeenCalledWith('Prompt 1', false);
    });

    it('should mark test as failed when expected activations are missing', async () => {
        const mockSet = {
            id: 'ts2',
            name: 'Test Set 2',
            tests: [{ name: 'Case 2', prompt: 'Prompt 2', expectedActivations: ['SYM-1'], id: 'ts2-0' }]
        };

        await testService.createOrUpdateTestSet({ ...mockSet, createdAt: '', updatedAt: '' });

        const runner = vi.fn().mockResolvedValue({ text: 'res', meta: {} });
        vi.spyOn(traceService, 'clear').mockReturnValue();
        vi.spyOn(traceService, 'getTraces').mockReturnValue([
            { activation_path: [{ symbol_id: 'OTHER', reason: '', link_type: '' }] } as any
        ]);

        const run = await testService.startTestRun('ts2', runner);
        await new Promise(r => setTimeout(r, 20));
        const storedRun = await testService.getTestRun(run.id);

        expect(storedRun?.results[0].status).toBe('failed');
        expect(storedRun?.results[0].missingActivations).toContain('SYM-1');
    });

    it('should include baseline comparison when requested', async () => {
        const mockSet = {
            id: 'ts3',
            name: 'Test Set 3',
            tests: [{ name: 'Case 3', prompt: 'Prompt 3', expectedActivations: [], id: 'ts3-0' }]
        };

        await testService.createOrUpdateTestSet({ ...mockSet, createdAt: '', updatedAt: '' });

        const runner = vi.fn().mockResolvedValue({ text: 'res', meta: {} });
        vi.spyOn(traceService, 'clear').mockReturnValue();
        vi.spyOn(traceService, 'getTraces').mockReturnValue([]);

        const run = await testService.startTestRun('ts3', runner, true);
        let storedRun = await testService.getTestRun(run.id);
        let guard = 0;
        while (storedRun?.status === 'running' && guard < 10) {
            await new Promise(r => setTimeout(r, 20));
            storedRun = await testService.getTestRun(run.id);
            guard++;
        }

        expect(inferenceService.runBaselineTest).toHaveBeenCalledWith('Prompt 3');
        expect(inferenceService.evaluateComparison).toHaveBeenCalled();
        expect(storedRun?.results[0].baselineResponse).toBe('baseline-response');
        expect(storedRun?.results[0].compareWithBaseModel).toBe(true);
    });
});
