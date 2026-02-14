import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { redisService, __redisTestUtils } from '../services/redisService.ts';
import { contextWindowService } from '../services/contextWindowService.js';
import fs from 'fs';
import path from 'path';

// Mock dependencies
vi.mock('../services/contextWindowService.js', () => ({
    contextWindowService: {
        buildStableContext: vi.fn()
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

describe('dump_static_context script', () => {
    beforeEach(() => {
        __redisTestUtils.resetMock();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should build static context and write to file', async () => {
        const mockContext = '[KERNEL]\nStatic symbolic context';
        vi.mocked(contextWindowService.buildStableContext).mockResolvedValue(mockContext);

        const { main } = await import('../scripts/dump_static_context.ts');
        await main();

        expect(contextWindowService.buildStableContext).toHaveBeenCalled();
        expect(fs.writeFileSync).toHaveBeenCalledWith(
            path.join(process.cwd(), 'static_context.txt'),
            mockContext
        );
        expect(consoleMocks.log).toHaveBeenCalledWith(expect.stringContaining('Static context written to'));
    });

    it('should handle errors gracefully', async () => {
        const error = new Error('Build failed');
        vi.mocked(contextWindowService.buildStableContext).mockRejectedValue(error);

        const { main } = await import('../scripts/dump_static_context.ts');
        await main();

        expect(consoleMocks.error).toHaveBeenCalledWith('Error:', error);
    });

    it('should disconnect from redis in finally block', async () => {
        const disconnectSpy = vi.spyOn(redisService, 'disconnect');
        vi.mocked(contextWindowService.buildStableContext).mockResolvedValue('test');

        const { main } = await import('../scripts/dump_static_context.ts');
        await main();

        expect(disconnectSpy).toHaveBeenCalled();
    });

    it('should log loading message at start', async () => {
        vi.mocked(contextWindowService.buildStableContext).mockResolvedValue('test');

        const { main } = await import('../scripts/dump_static_context.ts');
        await main();

        expect(consoleMocks.log).toHaveBeenCalledWith('Loading static context...');
    });

    it('should write correct file path', async () => {
        vi.mocked(contextWindowService.buildStableContext).mockResolvedValue('static data');

        const { main } = await import('../scripts/dump_static_context.ts');
        await main();

        const expectedPath = path.join(process.cwd(), 'static_context.txt');
        expect(fs.writeFileSync).toHaveBeenCalledWith(expectedPath, 'static data');
    });
});
