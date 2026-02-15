import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app, resetActiveMcpPrompt, setActiveMcpPrompt } from '../server.ts';
import { userService } from '../services/userService.ts';
import { domainService } from '../services/domainService.ts';

// Mock Services
vi.mock('../services/userService');
vi.mock('../services/domainService');
vi.mock('../services/mcpPromptService');
vi.mock('../services/settingsService', () => ({
    settingsService: {
        getApiKey: vi.fn().mockReturnValue('test-key'),
        getInferenceSettings: vi.fn().mockResolvedValue({
            provider: 'openai',
            model: 'gpt-4',
            endpoint: 'http://localhost:1234'
        })
    }
}));
vi.mock('../services/redisService');
vi.mock('../services/loggerService');
vi.mock('../services/embeddingService', () => ({
    embedText: vi.fn().mockResolvedValue(new Array(1536).fill(0))
}));

describe('MCP Server Integration (Direct handleMCPMethod Testing)', () => {
    const adminUser = { id: 'user_admin', role: 'admin', enabled: true };
    const regularUser = { id: 'user_reg', role: 'user', enabled: true };

    beforeEach(() => {
        vi.clearAllMocks();
        // Reset server global state helper
        resetActiveMcpPrompt();
    });

    it('MCP prompts/list should return project-prompt if activeMcpPrompt is set', async () => {
        // Set MCP prompt directly via helper for testing
        setActiveMcpPrompt('Test MCP Prompt');

        // SSE to get a session (mocked getUserByApiKey to succeed)
        vi.mocked(userService.getUserByApiKey).mockResolvedValue(adminUser as any);
        
        // We use the JSON-RPC over POST /mcp/sse which doesn't hang like SSE
        const res = await request(app)
            .post('/mcp/sse')
            .set('x-api-key', 'admin-key')
            .send({
                jsonrpc: '2.0',
                id: 1,
                method: 'prompts/list',
                params: {}
            });

        expect(res.status).toBe(200);
        expect(res.body.result.prompts).toHaveLength(1);
        expect(res.body.result.prompts[0].name).toBe('project-prompt');
    });

    it('MCP tools/list should filter out restricted tools for everyone', async () => {
        vi.mocked(userService.getUserByApiKey).mockResolvedValue(adminUser as any);
        const res = await request(app)
            .post('/mcp/sse')
            .set('x-api-key', 'admin-key')
            .send({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {}
            });

        const tools = res.body.result.tools.map((t: any) => t.name);
        expect(tools).not.toContain('sys_exec');
        expect(tools).not.toContain('write_file');
        expect(tools).not.toContain('web_search');
        expect(tools).not.toContain('list_secrets');
        expect(tools).not.toContain('upsert_agent');
        expect(tools).not.toContain('web_post');
        expect(tools).not.toContain('symbol_transaction');
    });

    it('MCP tools/list should filter out admin-only tools for regular users', async () => {
        vi.mocked(userService.getUserByApiKey).mockResolvedValue(regularUser as any);
        const res = await request(app)
            .post('/mcp/sse')
            .set('x-api-key', 'user-key')
            .send({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/list',
                params: {}
            });

        const tools = res.body.result.tools.map((t: any) => t.name);
        expect(tools).not.toContain('create_domain');
        expect(tools).not.toContain('upsert_symbols');
        expect(tools).not.toContain('delete_symbols');
        expect(tools).toContain('find_symbols');
    });

    it('MCP tools/call should block admin tools for regular users', async () => {
        vi.mocked(userService.getUserByApiKey).mockResolvedValue(regularUser as any);
        const res = await request(app)
            .post('/mcp/sse')
            .set('x-api-key', 'user-key')
            .send({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'create_domain',
                    arguments: { domain_id: 'test', description: 'desc' }
                }
            });

        expect(res.status).toBe(500);
        expect(res.body.error.message).toContain('requires admin privileges');
    });

    it('MCP tools/call should allow admin tools for admin users', async () => {
        vi.mocked(userService.getUserByApiKey).mockResolvedValue(adminUser as any);
        vi.mocked(domainService.hasDomain).mockResolvedValue(false);
        vi.mocked(domainService.getMetadata).mockResolvedValue([]);
        vi.mocked(domainService.createDomain).mockResolvedValue({ id: 'test', invariants: [] } as any);

        const res = await request(app)
            .post('/mcp/sse')
            .set('x-api-key', 'admin-key')
            .send({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'create_domain',
                    arguments: { domain_id: 'test', description: 'desc', invariants: ['Fixed Invariant'] }
                }
            });

        expect(res.status).toBe(200);
        expect(res.body.error).toBeUndefined();
        expect(res.body.result.content[0].text).toContain('Domain created');
    });
});