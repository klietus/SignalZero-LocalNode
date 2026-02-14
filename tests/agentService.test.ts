import { describe, it, expect, beforeEach } from 'vitest';
import { agentService } from '../services/agentService.js';
import { __redisTestUtils, redisService } from '../services/redisService.ts';
import { AgentExecutionLog } from '../types.ts';

beforeEach(() => {
    __redisTestUtils.resetMock();
});

describe('agentService', () => {
    it('validates cron schedules', () => {
        expect(() => agentService.validateSchedule('* * * * *')).not.toThrow();
        expect(() => agentService.validateSchedule('invalid cron')).toThrow();
    });

    it('upserts and lists agents', async () => {
        await agentService.upsertAgent('agent-1', 'test prompt', true, '* * * * *');
        const agents = await agentService.listAgents();
        expect(agents).toHaveLength(1);
        expect(agents[0].id).toBe('agent-1');
        expect(agents[0].enabled).toBe(true);
    });

    it('returns execution logs filtered by agent id', async () => {
        const now = new Date().toISOString();
        const execution: AgentExecutionLog = {
            id: 'exec-1',
            agentId: 'agent-logs',
            startedAt: now,
            finishedAt: now,
            status: 'completed',
            traceCount: 0,
            responsePreview: 'ok'
        };

        await redisService.request(['ZADD', 'sz:agents:executions', Date.parse(now), execution.id]);
        await redisService.request(['SET', `sz:agents:execution:${execution.id}`, JSON.stringify(execution)]);

        const logs = await agentService.getExecutionLogs('agent-logs');
        expect(logs).toHaveLength(1);
        expect(logs[0].agentId).toBe('agent-logs');
    });

    it('replaces all agents and clears executions', async () => {
        await agentService.upsertAgent('existing', 'old', true, '* * * * *');
        const now = new Date().toISOString();
        await redisService.request(['ZADD', 'sz:agents:executions', Date.parse(now), 'exec-old']);
        await redisService.request(['SET', 'sz:agents:execution:exec-old', JSON.stringify({ id: 'exec-old' })]);
        await redisService.request(['SET', 'sz:agents:execution:exec-old:traces', JSON.stringify([])]);

        const imported = [{
            id: 'new-agent',
            schedule: '*/5 * * * *',
            prompt: 'imported',
            enabled: true,
            createdAt: now,
            updatedAt: now
        }];

        await agentService.replaceAllAgents(imported as any);
        const agents = await agentService.listAgents();
        expect(agents).toHaveLength(1);
        expect(agents[0].id).toBe('new-agent');

        const logs = await agentService.getExecutionLogs();
        expect(logs).toHaveLength(0);
    });
});
