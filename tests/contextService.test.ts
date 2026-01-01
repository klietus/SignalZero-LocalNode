
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { contextService } from '../services/contextService.ts';
import { __redisTestUtils, redisService } from '../services/redisService.ts';

describe('ContextService', () => {
    beforeEach(() => {
        __redisTestUtils.resetMock();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        __redisTestUtils.resetMock();
    });

    it('should filter tool_result messages from history', async () => {
        const sessionId = 'test-session';
        const historyKey = `context:history:${sessionId}`;
        
        const mockHistory = [
            { role: 'user', content: 'hello', timestamp: new Date().toISOString() },
            { role: 'assistant', content: 'searching...', timestamp: new Date().toISOString(), metadata: { kind: 'assistant_response' } },
            { role: 'tool', content: 'result', timestamp: new Date().toISOString(), metadata: { kind: 'tool_result' } },
            { role: 'assistant', content: 'found it', timestamp: new Date().toISOString(), metadata: { kind: 'assistant_response' } }
        ];

        await redisService.request(['SET', historyKey, JSON.stringify(mockHistory)]);

        const history = await contextService.getHistory(sessionId);
        
        expect(history).toHaveLength(3);
        expect(history.find(m => m.metadata?.kind === 'tool_result')).toBeUndefined();
        expect(history[0].role).toBe('user');
        expect(history[1].metadata?.kind).toBe('assistant_response');
        expect(history[2].content).toBe('found it');
    });

    it('should return all messages if none are tool_result', async () => {
        const sessionId = 'test-session-2';
        const historyKey = `context:history:${sessionId}`;
        
        const mockHistory = [
            { role: 'user', content: 'hello', timestamp: new Date().toISOString() },
            { role: 'assistant', content: 'hi', timestamp: new Date().toISOString() }
        ];

        await redisService.request(['SET', historyKey, JSON.stringify(mockHistory)]);

        const history = await contextService.getHistory(sessionId);
        expect(history).toHaveLength(2);
    });
});
