
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { traceService } from '../services/traceService.ts';
import { TraceData } from '../types.ts';
import { decodeTimestamp } from '../services/timeService.ts';
import { __redisTestUtils } from '../services/redisService.ts';

describe('TraceService', () => {
    beforeEach(async () => {
        __redisTestUtils.resetMock();
        await traceService.clear();
    });

    it('should add traces and retrieve them', async () => {
        const trace: Partial<TraceData> = {
            id: 'test-1',
            sessionId: 'sess-1'
        };

        await traceService.addTrace(trace);
        const traces = await traceService.getTraces();
        
        expect(traces).toHaveLength(1);
        expect(traces[0].id).toEqual(trace.id);
        expect(decodeTimestamp(traces[0].created_at)).not.toBeNull();
        expect(decodeTimestamp(traces[0].updated_at)).not.toBeNull();
    });

    it('should auto-generate ID if missing', async () => {
        const trace: Partial<TraceData> = {
            sessionId: 'sess-2'
        };

        await traceService.addTrace(trace);
        const traces = await traceService.getTraces();
        
        expect(traces).toHaveLength(1);
        expect(traces[0].id).toBeDefined();
        expect(traces[0].id).toContain('TR-');
    });

    it('should clear traces', async () => {
        await traceService.addTrace({ sessionId: 'sess-3' });
        expect(await traceService.getTraces()).toHaveLength(1);
        
        await traceService.clear();
        // Wait for notify
        await new Promise(r => setTimeout(r, 10));
        expect(await traceService.getTraces()).toHaveLength(0);
    });

    it('should notify listeners on add and clear', async () => {
        const listener = vi.fn();
        const unsubscribe = traceService.subscribe(listener);

        // Wait for initial call on subscribe
        await new Promise(r => setTimeout(r, 10));
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith([]);

        // Add trace
        await traceService.addTrace({ sessionId: 'sess-4' });
        // Wait for notify
        await new Promise(r => setTimeout(r, 10));
        expect(listener).toHaveBeenCalledTimes(2);
        const tracesArg = listener.mock.calls[1][0];
        expect(tracesArg).toHaveLength(1);

        // Clear
        await traceService.clear();
        // Wait for notify
        await new Promise(r => setTimeout(r, 10));
        expect(listener).toHaveBeenCalledTimes(3);
        expect(listener.mock.calls[2][0]).toHaveLength(0);

        unsubscribe();
    });

    it('should unsubscribe correctly', async () => {
        const listener = vi.fn();
        const unsubscribe = traceService.subscribe(listener);
        
        unsubscribe();
        await traceService.addTrace({ sessionId: 'sess-5' });
        
        // Wait just in case
        await new Promise(r => setTimeout(r, 10));
        
        // Should only be called once (initial subscribe)
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
