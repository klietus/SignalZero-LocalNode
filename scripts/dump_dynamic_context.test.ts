import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { redisService, __redisTestUtils } from '../services/redisService.ts';
import { contextWindowService } from '../services/contextWindowService.js';
import fs from 'fs';
import path from 'path';

// Mock dependencies
vi.mock('../services/contextWindowService.js', () => ({
    contextWindowService: {
        buildDynamicContext: vi.fn()
    }
}));

vi.mock('fs', () => ({
    default: {
        writeFileSync: vi.fn()
    }
}));

// Mock console
const consoleMocks = {
    log: vi.fn(),
    error: vi.fn()
};
vi.stubGlobal('console', {
    ...console,
    log: consoleMocks.log,
    error: consoleMocks.error
});

describe('dump_dynamic_context script', () => {
    beforeEach(() => {
        __redisTestUtils.resetMock();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should build dynamic context and write to file', async () => {
        const mockContext = '[USER]\nUser context data\n\n[STATE]\nState symbols here';
        vi.mocked(contextWindowService.buildDynamicContext).mockResolvedValue(mockContext);

        const { main } = await import('../scripts/dump_dynamic_context.ts');
        await main();

        expect(contextWindowService.buildDynamicContext).toHaveBeenCalledWith('conversation');
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            path.join(process.cwd(), 'dynamic_context.txt'),
            mockContext
        );
        expect(consoleMocks.log).toHaveBeenCalledWith(expect.stringContaining('Dynamic context written to'));
    });

    it('should handle errors gracefully', async () => {
        const error = new Error('Build failed');
        vi.mocked(contextWindowService.buildDynamicContext).mockRejectedValue(error);

        const { main } = await import('../scripts/dump_dynamic_context.ts');
        await main();

        expect(consoleMocks.error).toHaveBeenCalledWith('Error:', error);
    });

    it('should disconnect from redis in finally block', async () => {
        const disconnectSpy = vi.spyOn(redisService, 'disconnect');
        vi.mocked(contextWindowService.buildDynamicContext).mockResolvedValue('test');

        const { main } = await import('../scripts/dump_dynamic_context.ts');
        await main();

        expect(disconnectSpy).toHaveBeenCalled();
    });

    it('should log loading message at start', async () => {
        vi.mocked(contextWindowService.buildDynamicContext).mockResolvedValue('test');

        const { main } = await import('../scripts/dump_dynamic_context.ts');
        await main();

        expect(consoleMocks.log).toHaveBeenCalledWith('Loading dynamic context...');
    });

    it('should write correct file path', async () => {
        vi.mocked(contextWindowService.buildDynamicContext).mockResolvedValue('context data');

        const { main } = await import('../scripts/dump_dynamic_context.ts');
        await main();

        const expectedPath = path.join(process.cwd(), 'dynamic_context.txt');
        expect(fs.writeFileSync).toHaveBeenCalledWith(expectedPath, 'context data');
    });
});
