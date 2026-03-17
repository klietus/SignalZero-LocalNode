import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { mcpClientService } from '../services/mcpClientService.ts';
import { settingsService } from '../services/settingsService.ts';
import { loggerService } from '../services/loggerService.ts';

vi.mock('../services/settingsService.ts', () => ({
    settingsService: {
        getMcpConfigs: vi.fn(),
    }
}));

vi.mock('../services/loggerService.ts', () => ({
    loggerService: {
        info: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
    }
}));

describe('McpClientService', () => {
    const mockMcpConfig = {
        id: 'test-mcp',
        name: 'Test MCP',
        endpoint: 'http://test-mcp/mcp/sse',
        token: 'test-token',
        enabled: true
    };

    beforeEach(() => {
        vi.clearAllMocks();
        // Mock global fetch
        global.fetch = vi.fn();
    });

    it('should fetch tools from enabled MCP servers', async () => {
        vi.mocked(settingsService.getMcpConfigs).mockResolvedValue([mockMcpConfig]);
        
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                result: {
                    tools: [
                        { name: 'test_tool', description: 'A test tool', inputSchema: { type: 'object' } }
                    ]
                }
            })
        } as any);

        // Also mock prompts/list which is called during refreshAll
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                result: { prompts: [] }
            })
        } as any);

        const tools = await mcpClientService.getAllTools();
        
        expect(tools.length).toBe(1);
        expect(tools[0].function.name).toBe('mcp_test-mcp_test_tool');
        expect(fetch).toHaveBeenCalledWith(mockMcpConfig.endpoint, expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('tools/list')
        }));
    });

    it('should handle tool execution', async () => {
        vi.mocked(settingsService.getMcpConfigs).mockResolvedValue([mockMcpConfig]);
        
        vi.mocked(fetch).mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                jsonrpc: '2.0',
                result: { content: [{ type: 'text', text: 'Tool output' }] }
            })
        } as any);

        const result = await mcpClientService.executeTool('test-mcp', 'test_tool', { arg1: 'val1' });
        
        expect(result.content[0].text).toBe('Tool output');
        expect(fetch).toHaveBeenCalledWith(mockMcpConfig.endpoint, expect.objectContaining({
            method: 'POST',
            body: expect.stringContaining('tools/call')
        }));
        
        const lastCallBody = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as any).body);
        expect(lastCallBody.params.name).toBe('test_tool');
        expect(lastCallBody.params.arguments).toEqual({ arg1: 'val1' });
    });

    it('should inject authentication headers if token is present', async () => {
        vi.mocked(settingsService.getMcpConfigs).mockResolvedValue([mockMcpConfig]);
        
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({ jsonrpc: '2.0', result: { tools: [], prompts: [] } })
        } as any);

        await mcpClientService.refreshAll();

        expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
            headers: expect.objectContaining({
                'Authorization': 'Bearer test-token',
                'X-API-Key': 'test-token'
            })
        }));
    });

    it('should handle fetch errors gracefully', async () => {
        vi.mocked(settingsService.getMcpConfigs).mockResolvedValue([mockMcpConfig]);
        vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as any);

        const tools = await mcpClientService.getAllTools();
        expect(tools).toEqual([]);
        expect(loggerService.warn).toHaveBeenCalledWith(expect.stringContaining('Could not fetch tools'), expect.any(Object));
    });
});
