
import { TraceData } from '../types.ts';
import { currentTimestamp, decodeTimestamp, getDayBucketKey } from './timeService.ts';
import { redisService } from './redisService.ts';

type TraceListener = (traces: TraceData[]) => void;

class TraceService {
  private listeners: TraceListener[] = [];

  async addTrace(trace: Partial<TraceData>) {
    const nowB64 = currentTimestamp();
    const normalizedId = trace.id || `TR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    
    // Check for existing to preserve created_at if possible
    const existingRaw = await redisService.request(['GET', `sz:trace:${normalizedId}`]);
    const existing = existingRaw ? JSON.parse(existingRaw) : null;

    const normalizedTrace: TraceData = {
        ...trace,
        id: normalizedId,
        created_at: existing ? existing.created_at : nowB64,
        updated_at: nowB64,
    } as TraceData;

    // Persist to Redis
    await redisService.request(['SET', `sz:trace:${normalizedId}`, JSON.stringify(normalizedTrace), 'EX', '604800']); // 7 day TTL

    if (normalizedTrace.sessionId) {
        await redisService.request(['SADD', `sz:session_traces:${normalizedTrace.sessionId}`, normalizedTrace.id]);
        await redisService.request(['EXPIRE', `sz:session_traces:${normalizedTrace.sessionId}`, '604800']);
    }

    const createdMs = decodeTimestamp(normalizedTrace.created_at);
    if (createdMs !== null) {
        await redisService.request(['SADD', getDayBucketKey('traces', createdMs), normalizedTrace.id]);
    }

    this.notifyListeners();
  }

  async getTraces(since?: number): Promise<TraceData[]> {
    const now = Date.now();
    const start = since || (now - 3600000); // Default to last hour if since not provided
    
    // Use the timeService logic to get relevant bucket keys
    const { getBucketKeysFromTimestamps } = await import('./timeService.js');
    const { keys } = getBucketKeysFromTimestamps('traces', new Date(start).toISOString());
    
    if (keys.length === 0) return [];

    // Get all trace IDs from these buckets
    const idPromises = keys.map(key => redisService.request(['SMEMBERS', key]));
    const idResults = await Promise.all(idPromises);
    const allIds = new Set<string>();
    idResults.forEach(ids => {
        if (Array.isArray(ids)) ids.forEach(id => allIds.add(String(id)));
    });

    if (allIds.size === 0) return [];

    // Fetch full trace objects
    const tracePromises = Array.from(allIds).map(id => this.findById(id));
    const results = await Promise.all(tracePromises);
    
    // Filter by timestamp and sort
    const { decodeTimestamp } = await import('./timeService.js');
    return results
        .filter((t): t is TraceData => t !== null)
        .filter(t => {
            const ts = decodeTimestamp(t.created_at);
            return ts !== null && ts >= start;
        })
        .sort((a, b) => {
            const tsA = decodeTimestamp(a.created_at) || 0;
            const tsB = decodeTimestamp(b.created_at) || 0;
            return tsB - tsA;
        });
  }

  async findById(id: string): Promise<TraceData | null> {
      const data = await redisService.request(['GET', `sz:trace:${id}`]);
      return data ? JSON.parse(data) : null;
  }

  async getBySession(sessionId: string): Promise<TraceData[]> {
      const ids = await redisService.request(['SMEMBERS', `sz:session_traces:${sessionId}`]);
      if (!ids || !Array.isArray(ids)) return [];
      
      const promises = ids.map(id => this.findById(id));
      const results = await Promise.all(promises);
      return results.filter((r): r is TraceData => r !== null);
  }

  async getIdsBySession(sessionId: string): Promise<string[]> {
      const ids = await redisService.request(['SMEMBERS', `sz:session_traces:${sessionId}`]);
      return Array.isArray(ids) ? ids : [];
  }

  async clear() {
    const keys = await redisService.request(['KEYS', 'sz:trace:*']);
    const sessionKeys = await redisService.request(['KEYS', 'sz:session_traces:*']);
    const bucketKeys = await redisService.request(['KEYS', 'sz:buckets:traces:*']);
    
    const allKeys = [...(keys || []), ...(sessionKeys || []), ...(bucketKeys || [])];
    if (allKeys.length > 0) {
        await redisService.request(['DEL', ...allKeys]);
    }
    await this.notifyListeners();
  }

  subscribe(listener: TraceListener) {
    this.listeners.push(listener);
    // Send current state immediately
    this.getTraces().then(current => listener(current));
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  private async notifyListeners() {
    const current = await this.getTraces();
    this.listeners.forEach(l => l(current));
  }
}

export const traceService = new TraceService();
