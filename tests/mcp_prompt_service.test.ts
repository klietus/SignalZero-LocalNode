import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mcpPromptService } from '../services/mcpPromptService.ts';
import { redisService } from '../services/redisService.js';

vi.mock('../services/redisService');
vi.mock('../services/loggerService');

describe('McpPromptService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should load MCP prompt from Redis if available', async () => {
        vi.mocked(redisService.request).mockResolvedValue('Stored MCP Prompt');
        const prompt = await mcpPromptService.loadPrompt('Fallback');
        expect(prompt).toBe('Stored MCP Prompt');
    });

    it('should use fallback if Redis is empty', async () => {
        vi.mocked(redisService.request).mockResolvedValue(null);
        const prompt = await mcpPromptService.loadPrompt('Fallback');
        expect(prompt).toBe('Fallback');
    });

    it('should persist MCP prompt to Redis', async () => {
        await mcpPromptService.setPrompt('New MCP Prompt');
        expect(redisService.request).toHaveBeenCalledWith(['SET', 'sz:mcp:prompt', 'New MCP Prompt']);
    });
});
