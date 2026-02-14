import { describe, it, expect } from 'vitest';
import { 
    LOOP_INDEX_KEY, 
    EXECUTION_ZSET_KEY, 
    getLoopKey, 
    getExecutionKey, 
    getTraceKey 
} from '../services/loopStorage.ts';

describe('LoopStorage', () => {
    it('should export constant keys', () => {
        expect(LOOP_INDEX_KEY).toBe('sz:loops:index');
        expect(EXECUTION_ZSET_KEY).toBe('sz:loops:executions');
    });

    it('should generate correct loop key', () => {
        expect(getLoopKey('loop-123')).toBe('sz:loops:def:loop-123');
        expect(getLoopKey('test-loop')).toBe('sz:loops:def:test-loop');
    });

    it('should generate correct execution key', () => {
        expect(getExecutionKey('exec-456')).toBe('sz:loops:execution:exec-456');
        expect(getExecutionKey('test-exec')).toBe('sz:loops:execution:test-exec');
    });

    it('should generate correct trace key', () => {
        expect(getTraceKey('exec-789')).toBe('sz:loops:execution:exec-789:traces');
    });

    it('should generate unique keys for different IDs', () => {
        const key1 = getLoopKey('loop-1');
        const key2 = getLoopKey('loop-2');
        expect(key1).not.toBe(key2);
    });
});
