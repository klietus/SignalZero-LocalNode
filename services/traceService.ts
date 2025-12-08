
import { TraceData } from '../types.ts';

type TraceListener = (traces: TraceData[]) => void;

class TraceService {
  private traces: TraceData[] = [];
  private listeners: TraceListener[] = [];

  addTrace(trace: Partial<TraceData>) {
    if (!trace.id) {
        trace.id = `TR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    }
    this.traces.push(trace as TraceData);
    this.notifyListeners();
  }

  getTraces(): TraceData[] {
    return [...this.traces];
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
