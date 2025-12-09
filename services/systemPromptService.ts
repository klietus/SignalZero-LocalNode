import { redisService } from './redisService.ts';
import { loggerService } from './loggerService.ts';

const SYSTEM_PROMPT_KEY = 'sz:system:prompt';

export const systemPromptService = {
    getKey: () => SYSTEM_PROMPT_KEY,

    loadPrompt: async (fallbackPrompt: string): Promise<string> => {
        try {
            const stored = await redisService.request(['GET', SYSTEM_PROMPT_KEY]);
            if (typeof stored === 'string' && stored.length > 0) {
                return stored;
            }
        } catch (error) {
            loggerService.error('SystemPromptService: Failed to load prompt from Redis', { error });
        }
        return fallbackPrompt;
    },

    setPrompt: async (prompt: string): Promise<void> => {
        try {
            await redisService.request(['SET', SYSTEM_PROMPT_KEY, prompt]);
        } catch (error) {
            loggerService.error('SystemPromptService: Failed to persist prompt to Redis', { error });
            throw error;
        }
    }
};
