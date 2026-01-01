
import { TraceData } from '../types.ts';
import { currentTimestampBase64, decodeTimestamp, getDayBucketKey } from './timeService.ts';
import { redisService } from './redisService.ts';

type TraceListener = (traces: TraceData[]) => void;

class TraceService {
  private traces: TraceData[] = [];
  private listeners: TraceListener[] = [];

  addTrace(trace: Partial<TraceData>) {
    const nowB64 = currentTimestampBase64();
    const existingIndex = trace.id ? this.traces.findIndex(t => t.id === trace.id) : -1;

    const normalizedId = trace.id || `TR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const normalizedTrace: TraceData = {
        ...trace,
        id: normalizedId,
        created_at: existingIndex >= 0 ? this.traces[existingIndex].created_at : nowB64,
        updated_at: nowB64,
    } as TraceData;

    if (existingIndex >= 0) {
        this.traces[existingIndex] = normalizedTrace;
    } else {
        this.traces.push(normalizedTrace);
    }

    const createdMs = decodeTimestamp(normalizedTrace.created_at);
    if (createdMs !== null) {
        redisService.request(['SADD', getDayBucketKey('traces', createdMs), normalizedTrace.id]);
    }

    this.notifyListeners();
  }

  getTraces(since?: number): TraceData[] {
    if (since === undefined) return [...this.traces];
    return this.traces.filter(t => {
        const ts = decodeTimestamp(t.created_at);
        return ts !== null && ts > since;
    });
  }

  clear() {
    this.traces = [];
    this.notifyListeners();
  }

  subscribe(listener: TraceListener) {
    this.listeners.push(listener);
    // Send current state immediately
    listener(this.getTraces());
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private notifyListeners() {
    const current = this.getTraces();
    this.listeners.forEach(l => l(current));
  }
}

export const traceService = new TraceService();
