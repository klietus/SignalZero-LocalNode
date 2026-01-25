import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testService } from '../services/testService.ts';
import { __redisTestUtils, redisService } from '../services/redisService.ts';
import { TestRun, TestResult } from '../types.js';

describe('TestService Metadata and Concurrency', () => {
    beforeEach(() => {
        __redisTestUtils.resetMock();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should correctly update counters using HINCRBY in updateRunProgress', async () => {
        const runId = 'RUN-123';
        const run: TestRun = {
            id: runId,
            testSetId: 'ts1',
            testSetName: 'TS1',
            status: 'running',
            compareWithBaseModel: false,
            startTime: new Date().toISOString(),
            summary: { total: 10, completed: 0, passed: 0, failed: 0 },
            results: []
        };

        // Initialize run metadata
        await testService.updateRunState(run);

        const result1: TestResult = {
            id: 'T1',
            name: 'Test 1',
            prompt: 'P1',
            status: 'completed',
            compareWithBaseModel: false
        };

        const result2: TestResult = {
            id: 'T2',
            name: 'Test 2',
            prompt: 'P2',
            status: 'failed',
            compareWithBaseModel: false
        };

        await testService.updateRunProgress(runId, result1);
        await testService.updateRunProgress(runId, result2);

        const updatedRun = await testService.getTestRun(runId);
        expect(updatedRun?.summary.completed).toBe(2);
        expect(updatedRun?.summary.passed).toBe(1);
        expect(updatedRun?.summary.failed).toBe(1);

        // Transition T2 from failed to completed (rerun success)
        const result2Success = { ...result2, status: 'completed' } as TestResult;
        await testService.updateRunProgress(runId, result2Success);

        const finalRun = await testService.getTestRun(runId);
        expect(finalRun?.summary.completed).toBe(2);
        expect(finalRun?.summary.passed).toBe(2);
        expect(finalRun?.summary.failed).toBe(0);
    });

    it('should handle concurrent updates to metadata (multithreaded simulation)', async () => {
        const runId = 'RUN-CONCURRENT';
        const totalTests = 50;
        const run: TestRun = {
            id: runId,
            testSetId: 'ts-concurrent',
            testSetName: 'Concurrent TS',
            status: 'running',
            compareWithBaseModel: false,
            startTime: new Date().toISOString(),
            summary: { total: totalTests, completed: 0, passed: 0, failed: 0 },
            results: []
        };

        await testService.updateRunState(run);

        // Simulate 50 concurrent updates
        const updates = Array.from({ length: totalTests }, (_, i) => {
            const status = i % 2 === 0 ? 'completed' : 'failed';
            const result: TestResult = {
                id: `T${i}`,
                name: `Test ${i}`,
                prompt: `P${i}`,
                status: status as 'completed' | 'failed',
                compareWithBaseModel: false
            };
            return testService.updateRunProgress(runId, result);
        });

        await Promise.all(updates);

        const finalRun = await testService.getTestRun(runId);
        expect(finalRun?.summary.completed).toBe(totalTests);
        expect(finalRun?.summary.passed).toBe(totalTests / 2);
        expect(finalRun?.summary.failed).toBe(totalTests / 2);

        // Verify Redis Hash directly
        const summaryRaw = await redisService.request(['HGETALL', `sz:test_run_summary:${runId}`]);
        const summary: any = {};
        for (let i = 0; i < summaryRaw.length; i += 2) {
            summary[summaryRaw[i]] = parseInt(summaryRaw[i+1], 10);
        }
        
        expect(summary.completed).toBe(totalTests);
        expect(summary.passed).toBe(totalTests / 2);
        expect(summary.failed).toBe(totalTests / 2);
    });

    it('should correctly handle transition from pending to running to completed', async () => {
        const runId = 'RUN-TRANSITION';
        const run: TestRun = {
            id: runId,
            testSetId: 'ts1',
            testSetName: 'TS1',
            status: 'running',
            compareWithBaseModel: false,
            startTime: new Date().toISOString(),
            summary: { total: 1, completed: 0, passed: 0, failed: 0 },
            results: []
        };
        await testService.updateRunState(run);

        const result: TestResult = {
            id: 'T1',
            name: 'Test 1',
            prompt: 'P1',
            status: 'pending',
            compareWithBaseModel: false
        };

        // 1. Pending -> Running (Should NOT increment completed)
        result.status = 'running';
        await testService.updateRunProgress(runId, result);
        let currentRun = await testService.getTestRun(runId);
        expect(currentRun?.summary.completed).toBe(0);

        // 2. Running -> Completed (Should increment completed and passed)
        result.status = 'completed';
        await testService.updateRunProgress(runId, result);
        currentRun = await testService.getTestRun(runId);
        expect(currentRun?.summary.completed).toBe(1);
        expect(currentRun?.summary.passed).toBe(1);

        // 3. Completed -> Failed (Should NOT increment completed, but update passed/failed)
        result.status = 'failed';
        await testService.updateRunProgress(runId, result);
        currentRun = await testService.getTestRun(runId);
        expect(currentRun?.summary.completed).toBe(1);
        expect(currentRun?.summary.passed).toBe(0);
        expect(currentRun?.summary.failed).toBe(1);
    });
});
