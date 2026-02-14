import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loggerService } from '../services/loggerService.ts';

describe('LoggerService', () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should be defined', () => {
        expect(loggerService).toBeDefined();
    });

    it('should have info method', () => {
        expect(typeof loggerService.info).toBe('function');
        expect(() => loggerService.info('test message')).not.toThrow();
    });

    it('should have error method', () => {
        expect(typeof loggerService.error).toBe('function');
        expect(() => loggerService.error('test error')).not.toThrow();
    });

    it('should have warn method', () => {
        expect(typeof loggerService.warn).toBe('function');
        expect(() => loggerService.warn('test warning')).not.toThrow();
    });

    it('should have debug method', () => {
        expect(typeof loggerService.debug).toBe('function');
        expect(() => loggerService.debug('test debug')).not.toThrow();
    });

    it('should accept metadata with log messages', () => {
        const meta = { userId: '123', action: 'test' };
        expect(() => loggerService.info('test with meta', meta)).not.toThrow();
        expect(() => loggerService.error('error with meta', meta)).not.toThrow();
    });
});
