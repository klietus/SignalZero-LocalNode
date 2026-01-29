
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../server.ts';
import { domainService, ReadOnlyDomainError } from '../services/domainService.ts';
import { traceService } from '../services/traceService.ts';
import { testService } from '../services/testService.ts';
import { projectService } from '../services/projectService.ts';
import { contextService } from '../services/contextService.ts';
import { authService } from '../services/authService.ts';
import { loopService } from '../services/loopService.ts';

// Mock Services
vi.mock('../services/domainService');
vi.mock('../services/traceService');
vi.mock('../services/testService');
vi.mock('../services/projectService');
vi.mock('../services/loopService');
vi.mock('../services/authService', () => ({
    authService: {
        verifySession: vi.fn().mockReturnValue(true),
        isInitialized: vi.fn().mockReturnValue(true),
        login: vi.fn(),
        initialize: vi.fn()
    }
}));
vi.mock('../services/contextService', () => ({
    contextService: {
        ensureConversationSession: vi.fn().mockResolvedValue({ session: { id: 'ctx-1', status: 'open' }, created: false }),
        closeConversationSessions: vi.fn(),
        listSessions: vi.fn().mockResolvedValue([]),
        getSession: vi.fn(),
        getHistory: vi.fn(),
        getUnfilteredHistory: vi.fn().mockResolvedValue([]),
        getHistoryGrouped: vi.fn().mockResolvedValue([]),
        hasActiveMessage: vi.fn().mockResolvedValue(false),
        setActiveMessage: vi.fn(),
        clearActiveMessage: vi.fn(),
        recordMessage: vi.fn(),
        cleanupTestSessions: vi.fn().mockResolvedValue(0),
        clearCancellation: vi.fn(),
        isCancelled: vi.fn().mockResolvedValue(false)
    }
}));

const AUTH_TOKEN = 'test-token';
const authedRequest = () => request(app).get('/').set('x-auth-token', AUTH_TOKEN); // helper just for headers if needed

describe('Server API Endpoints', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Setup minimal domainService mocks to support constructContextWindow
        vi.mocked(domainService.getMetadata).mockResolvedValue([]);
        vi.mocked(domainService.findById).mockResolvedValue(null);
        vi.mocked(domainService.getSymbols).mockResolvedValue([]);
    });

    // --- System ---
    it('GET /api/system/prompt should return current prompt', async () => {
        const res = await request(app).get('/api/system/prompt').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty('prompt');
    });

    it('POST /api/chat should handle message', async () => {
        vi.mocked(contextService.getSession).mockResolvedValue({ id: 'ctx-1', status: 'open' } as any);
        vi.mocked(contextService.hasActiveMessage).mockResolvedValue(false);
        vi.mocked(contextService.setActiveMessage).mockResolvedValue(undefined);

        const res = await request(app)
            .post('/api/chat')
            .set('x-auth-token', AUTH_TOKEN)
            .send({ message: 'Hello', contextSessionId: 'ctx-1' });
        
        expect(res.status).toBe(202);
        // expect(res.body.content).toBe('Response'); // 202 doesn't return content
    });

    it('POST /api/chat should reuse provided context session', async () => {
        vi.mocked(contextService.getSession).mockResolvedValue({ id: 'ctx-99', status: 'open' } as any);

        const res = await request(app)
            .post('/api/chat')
            .set('x-auth-token', AUTH_TOKEN)
            .send({ message: 'Hello', contextSessionId: 'ctx-99' });

        expect(res.status).toBe(202);
        expect(contextService.getSession).toHaveBeenCalledWith('ctx-99');
        expect(res.body.contextSessionId).toBe('ctx-99');
    });

    it('POST /api/chat should return 404 for missing context session', async () => {
        vi.mocked(contextService.getSession).mockResolvedValue(null as any);

        const res = await request(app)
            .post('/api/chat')
            .set('x-auth-token', AUTH_TOKEN)
            .send({ message: 'Hello', contextSessionId: 'missing' });

        expect(res.status).toBe(404);
        expect(res.body.error).toContain('Context session not found');
    });

    it('GET /api/contexts should list contexts', async () => {
        vi.mocked(contextService.listSessions).mockResolvedValue([{ id: 'ctx-1', status: 'open' } as any]);

        const res = await request(app).get('/api/contexts').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body.contexts[0].id).toBe('ctx-1');
    });

    it('GET /api/contexts/:id/history should return history', async () => {
        vi.mocked(contextService.getSession).mockResolvedValue({ id: 'ctx-1', status: 'open' } as any);
        vi.mocked(contextService.getHistoryGrouped).mockResolvedValue([{
            correlationId: 'msg-1',
            userMessage: { id: 'msg-1', role: 'user', content: 'hi', timestamp: new Date().toISOString() },
            assistantMessages: [],
            status: 'complete'
        }]);

        const res = await request(app).get('/api/contexts/ctx-1/history').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body.session.id).toBe('ctx-1');
        expect(res.body.history).toHaveLength(1);
    });

    // --- Domains ---
    it('GET /api/domains should list domains', async () => {
        vi.mocked(domainService.getMetadata).mockResolvedValue([{ id: 'd1', name: 'D1' }] as any);
        
        const res = await request(app).get('/api/domains').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].id).toBe('d1');
    });

    it('POST /api/domains/:id/toggle should toggle domain', async () => {
        vi.mocked(domainService.toggleDomain).mockResolvedValue(undefined);
        
        const res = await request(app)
            .post('/api/domains/d1/toggle')
            .set('x-auth-token', AUTH_TOKEN)
            .send({ enabled: true });
            
        expect(res.status).toBe(200);
        expect(domainService.toggleDomain).toHaveBeenCalledWith('d1', true);
    });

    // --- Symbols ---
    it('GET /api/symbols/search should search symbols', async () => {
        vi.mocked(domainService.search).mockResolvedValue([{ id: 's1', score: 1 }] as any);

        const res = await request(app).get('/api/symbols/search?q=test').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(domainService.search).toHaveBeenCalledWith('test', 5, { time_gte: undefined, time_between: undefined });
    });

    it('GET /api/symbols/search should require query or time filter', async () => {
        const res = await request(app).get('/api/symbols/search').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Provide a query or time filter');
        expect(domainService.search).not.toHaveBeenCalled();
    });

    it('GET /api/symbols/:id should return symbol', async () => {
        vi.mocked(domainService.findById).mockResolvedValue({ id: 's1' } as any);

        const res = await request(app).get('/api/symbols/s1').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body.id).toBe('s1');
    });

    it('POST /api/domains/:id/symbols should reject writes to read-only domains', async () => {
        vi.mocked(domainService.upsertSymbol).mockRejectedValue(new ReadOnlyDomainError('d1', 's1'));

        const res = await request(app)
            .post('/api/domains/d1/symbols')
            .set('x-auth-token', AUTH_TOKEN)
            .send({ id: 's1' });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('read-only');
    });

    // --- Tests ---
    it('GET /api/tests/sets should list test sets', async () => {
        vi.mocked(testService.listTestSets).mockResolvedValue([{ id: 'ts1' }] as any);
        
        const res = await request(app).get('/api/tests/sets').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body[0].id).toBe('ts1');
    });

    // --- Project ---
    it('POST /api/project/export should return zip', async () => {
        const mockBlob = new Blob(['zip content']);
        vi.mocked(projectService.export).mockResolvedValue(mockBlob as any);
        
        const res = await request(app).post('/api/project/export').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.header['content-type']).toBe('application/zip');
    });

    // --- Loop Management Tests ---
    it('GET /api/loops should list loops', async () => {
        vi.mocked(loopService.listLoops).mockResolvedValue([{ id: 'l1' } as any]);
        const res = await request(app).get('/api/loops').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ loops: [{ id: 'l1' }] });
    });

    it('POST /api/loops should upsert loop', async () => {
        vi.mocked(loopService.upsertLoop).mockResolvedValue({ id: 'l1' } as any);
        const res = await request(app).post('/api/loops').set('x-auth-token', AUTH_TOKEN).send({ id: 'l1', schedule: '* * * * *', prompt: 'p' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: 'l1' });
    });

    it('PUT /api/loops/:id should upsert loop', async () => {
        vi.mocked(loopService.upsertLoop).mockResolvedValue({ id: 'l1' } as any);
        const res = await request(app).put('/api/loops/l1').set('x-auth-token', AUTH_TOKEN).send({ schedule: '* * * * *', prompt: 'p' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: 'l1' });
        expect(loopService.upsertLoop).toHaveBeenCalledWith('l1', '* * * * *', 'p', true);
    });

    it('DELETE /api/loops/:id should delete loop', async () => {
        vi.mocked(loopService.deleteLoop).mockResolvedValue(true);
        const res = await request(app).delete('/api/loops/l1').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(loopService.deleteLoop).toHaveBeenCalledWith('l1');
    });

    it('GET /api/loops/logs should return execution logs', async () => {
        vi.mocked(loopService.getExecutionLogs).mockResolvedValue([{ id: 'e1' } as any]);
        const res = await request(app).get('/api/loops/logs?loopId=l1').set('x-auth-token', AUTH_TOKEN);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ logs: [{ id: 'e1' }] });
    });
});
