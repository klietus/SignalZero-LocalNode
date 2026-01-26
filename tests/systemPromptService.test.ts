import { describe, it, expect, beforeEach, vi } from 'vitest';
import { systemPromptService } from '../services/systemPromptService.ts';
import { redisService } from '../services/redisService.js';

vi.mock('../services/redisService');
vi.mock('../services/loggerService');

describe('SystemPromptService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should load prompt from Redis if available', async () => {
        vi.mocked(redisService.request).mockResolvedValue('Stored Prompt');
        const prompt = await systemPromptService.loadPrompt('Fallback');
        expect(prompt).toBe('Stored Prompt');
    });

    it('should use fallback if Redis is empty', async () => {
        vi.mocked(redisService.request).mockResolvedValue(null);
        const prompt = await systemPromptService.loadPrompt('Fallback');
        expect(prompt).toBe('Fallback');
    });

    it('should persist prompt to Redis', async () => {
        await systemPromptService.setPrompt('New Prompt');
        expect(redisService.request).toHaveBeenCalledWith(['SET', 'sz:system:prompt', 'New Prompt']);
    });
});
