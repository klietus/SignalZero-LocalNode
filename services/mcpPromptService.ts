import { redisService } from './redisService.js';
import { loggerService } from './loggerService.js';

const MCP_PROMPT_KEY = 'sz:mcp:prompt';

export const mcpPromptService = {
    getKey: () => MCP_PROMPT_KEY,

    loadPrompt: async (fallbackPrompt: string = ''): Promise<string> => {
        try {
            const stored = await redisService.request(['GET', MCP_PROMPT_KEY]);
            if (typeof stored === 'string' && stored.length > 0) {
                return stored;
            }
        } catch (error) {
            loggerService.error('McpPromptService: Failed to load prompt from Redis', { error });
        }
        return fallbackPrompt;
    },

    setPrompt: async (prompt: string): Promise<void> => {
        try {
            await redisService.request(['SET', MCP_PROMPT_KEY, prompt]);
        } catch (error) {
            loggerService.error('McpPromptService: Failed to persist prompt to Redis', { error });
            throw error;
        }
    }
};
