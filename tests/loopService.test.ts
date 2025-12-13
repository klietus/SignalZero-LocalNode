import { describe, it, expect, beforeEach } from 'vitest';
import { loopService } from '../services/loopService.ts';
import { __redisTestUtils, redisService } from '../services/redisService.ts';
import { LoopExecutionLog } from '../types.ts';

beforeEach(() => {
    __redisTestUtils.resetMock();
});

describe('loopService', () => {
    it('validates cron schedules', () => {
        expect(() => loopService.validateSchedule('* * * * *')).not.toThrow();
        expect(() => loopService.validateSchedule('invalid cron')).toThrow();
    });

    it('upserts and lists loops', async () => {
        await loopService.upsertLoop('loop-1', '* * * * *', 'test prompt', true);
        const loops = await loopService.listLoops();
        expect(loops).toHaveLength(1);
        expect(loops[0].id).toBe('loop-1');
        expect(loops[0].enabled).toBe(true);
    });

    it('returns execution logs filtered by loop id', async () => {
        const now = new Date().toISOString();
        const execution: LoopExecutionLog = {
            id: 'exec-1',
            loopId: 'loop-logs',
            startedAt: now,
            finishedAt: now,
            status: 'completed',
            traceCount: 0,
            responsePreview: 'ok'
        };

        await redisService.request(['ZADD', 'sz:loops:executions', Date.parse(now), execution.id]);
        await redisService.request(['SET', `sz:loops:execution:${execution.id}`, JSON.stringify(execution)]);

        const logs = await loopService.getExecutionLogs('loop-logs');
        expect(logs).toHaveLength(1);
        expect(logs[0].loopId).toBe('loop-logs');
    });
});
