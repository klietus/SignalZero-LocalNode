import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const consoleMocks = {
    log: vi.fn(),
    error: vi.fn()
};

vi.stubGlobal('console', {
    ...console,
    log: consoleMocks.log,
    error: consoleMocks.error
});

// Intercept process.exit to prevent test process termination
vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
    throw new Error(`process.exit(${code})`);
});

import { contextWindowService } from '../services/contextWindowService.js';
import { redisService } from '../services/redisService.js';
import { main } from './dump_dynamic_context.ts';
import fs from 'fs';
import path from 'path';

vi.mock('../services/contextWindowService.js');
vi.mock('../services/redisService.js');
vi.mock('fs');

describe('dump_dynamic_context script', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const runMain = async () => {
        try {
            await main();
        } catch (e: any) {
            if (e.message.startsWith('process.exit')) return;
            throw e;
        }
    };

    it('should build dynamic context and write to file', async () => {
        vi.mocked(contextWindowService.buildDynamicContext).mockResolvedValue('dynamic context data');

        await runMain();

        const expectedPath = path.join(process.cwd(), 'dynamic_context.txt');
        expect(contextWindowService.buildDynamicContext).toHaveBeenCalled();
        expect(fs.writeFileSync).toHaveBeenCalledWith(expectedPath, 'dynamic context data');
        expect(consoleMocks.log).toHaveBeenCalledWith('Dynamic context dumped to dynamic_context.txt');
    });

    it('should handle errors gracefully', async () => {
        vi.mocked(contextWindowService.buildDynamicContext).mockRejectedValue(new Error('Test Error'));

        await runMain();

        expect(consoleMocks.error).toHaveBeenCalledWith('Failed to dump dynamic context:', expect.any(Error));
    });

    it('should disconnect from redis in finally block', async () => {
        vi.mocked(contextWindowService.buildDynamicContext).mockResolvedValue('test');

        await runMain();

        expect(redisService.disconnect).toHaveBeenCalled();
    });

    it('should log loading message at start', async () => {
        vi.mocked(contextWindowService.buildDynamicContext).mockResolvedValue('test');

        await runMain();

        expect(consoleMocks.log).toHaveBeenCalledWith('Loading dynamic context...');
    });

    it('should write correct file path', async () => {
        vi.mocked(contextWindowService.buildDynamicContext).mockResolvedValue('context data');

        await runMain();

        const expectedPath = path.join(process.cwd(), 'dynamic_context.txt');
        expect(fs.writeFileSync).toHaveBeenCalledWith(expectedPath, 'context data');
    });
});