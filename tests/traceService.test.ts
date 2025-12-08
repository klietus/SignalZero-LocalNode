
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { traceService } from '../services/traceService.ts';
import { TraceData } from '../types.ts';

describe('TraceService', () => {
    beforeEach(() => {
        traceService.clear();
    });

    it('should add traces and retrieve them', () => {
        const trace: TraceData = {
            id: 'test-1',
            timestamp: Date.now(),
            source: 'test',
            content: { step: 'init' },
            type: 'reasoning'
        };

        traceService.addTrace(trace);
        const traces = traceService.getTraces();
        
        expect(traces).toHaveLength(1);
        expect(traces[0]).toEqual(trace);
    });

    it('should auto-generate ID if missing', () => {
        const trace: Partial<TraceData> = {
            timestamp: Date.now(),
            source: 'test',
            content: { step: 'init' },
            type: 'reasoning'
        };

        traceService.addTrace(trace);
        const traces = traceService.getTraces();
        
        expect(traces).toHaveLength(1);
        expect(traces[0].id).toBeDefined();
        expect(traces[0].id).toContain('TR-');
    });

    it('should clear traces', () => {
        traceService.addTrace({ timestamp: Date.now(), source: 'test', content: {}, type: 'reasoning' });
        expect(traceService.getTraces()).toHaveLength(1);
        
        traceService.clear();
        expect(traceService.getTraces()).toHaveLength(0);
    });

    it('should notify listeners on add and clear', () => {
        const listener = vi.fn();
        const unsubscribe = traceService.subscribe(listener);

        // Initial call on subscribe
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith([]);

        // Add trace
        traceService.addTrace({ timestamp: Date.now(), source: 'test', content: {}, type: 'reasoning' });
        expect(listener).toHaveBeenCalledTimes(2);
        const tracesArg = listener.mock.calls[1][0];
        expect(tracesArg).toHaveLength(1);

        // Clear
        traceService.clear();
        expect(listener).toHaveBeenCalledTimes(3);
        expect(listener.mock.calls[2][0]).toHaveLength(0);

        unsubscribe();
    });

    it('should unsubscribe correctly', () => {
        const listener = vi.fn();
        const unsubscribe = traceService.subscribe(listener);
        
        unsubscribe();
        traceService.addTrace({ timestamp: Date.now(), source: 'test', content: {}, type: 'reasoning' });
        
        // Should only be called once (initial subscribe)
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
