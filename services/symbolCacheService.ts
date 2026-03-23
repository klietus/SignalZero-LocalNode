
import { redisService } from './redisService.js';
import { SymbolDef } from '../types.js';
import { loggerService } from './loggerService.js';
import { eventBusService, KernelEventType } from './eventBusService.js';

export interface CacheEntry {
    symbol: SymbolDef;
    turnCount: number;
    lastUsed: number; // timestamp for LRU stability
}

export class SymbolCacheService {
    private readonly CACHE_PREFIX = 'sz:symbol_cache:';
    private readonly MAX_TURNS = 5;

    private getCacheKey(sessionId: string): string {
        return `${this.CACHE_PREFIX}${sessionId}`;
    }

    /**
     * Get all symbols in the cache for a session, sorted by Symbol ID for determinism.
     */
    async getSymbols(sessionId: string): Promise<SymbolDef[]> {
        const key = this.getCacheKey(sessionId);
        const data = await redisService.request(['GET', key]);
        if (!data) return [];

        const cache: Record<string, CacheEntry> = JSON.parse(data);
        const entries = Object.values(cache);

        // Sort by ID for deterministic output (crucial for prompt caching)
        entries.sort((a, b) => a.symbol.id.localeCompare(b.symbol.id));

        return entries.map(e => e.symbol);
    }

    /**
     * Partition symbols into Mature (turnCount > 3) and New (turnCount <= 3).
     * Both blocks are sorted by ID for determinism.
     */
    async getPartitionedSymbols(sessionId: string): Promise<{ mature: SymbolDef[], newSymbols: SymbolDef[] }> {
        const key = this.getCacheKey(sessionId);
        const data = await redisService.request(['GET', key]);
        if (!data) return { mature: [], newSymbols: [] };

        const cache: Record<string, CacheEntry> = JSON.parse(data);
        const entries = Object.values(cache);

        const matureEntries = entries.filter(e => e.turnCount > 3);
        const newEntries = entries.filter(e => e.turnCount <= 3);

        // Sort both by ID for deterministic output
        matureEntries.sort((a, b) => a.symbol.id.localeCompare(b.symbol.id));
        newEntries.sort((a, b) => a.symbol.id.localeCompare(b.symbol.id));

        return {
            mature: matureEntries.map(e => e.symbol),
            newSymbols: newEntries.map(e => e.symbol)
        };
    }

    /**
     * Add or update a symbol in the cache. Resets its turnCount to 0 and lastUsed to now.
     */
    async upsertSymbol(sessionId: string, symbol: SymbolDef): Promise<void> {
        if (!sessionId) return;
        const key = this.getCacheKey(sessionId);
        const data = await redisService.request(['GET', key]);
        const cache: Record<string, CacheEntry> = data ? JSON.parse(data) : {};

        cache[symbol.id] = {
            symbol,
            turnCount: 0,
            lastUsed: Date.now()
        };

        await redisService.request(['SET', key, JSON.stringify(cache), 'EX', '86400']); // 24h TTL
    }

    /**
     * Add or update multiple symbols in the cache. 
     * If a symbol is already present, its turnCount is preserved.
     * If new, it starts with initialTurnCount (defaults to 0).
     */
    async batchUpsertSymbols(sessionId: string, symbols: SymbolDef[], initialTurnCount: number = 0): Promise<void> {
        if (!sessionId || symbols.length === 0) return;

        const key = this.getCacheKey(sessionId);
        const data = await redisService.request(['GET', key]);
        const cache: Record<string, CacheEntry> = data ? JSON.parse(data) : {};

        const now = Date.now();
        for (const symbol of symbols) {
            // Preserve turnCount if symbol already exists
            if (cache[symbol.id]) {
                cache[symbol.id] = {
                    ...cache[symbol.id],
                    symbol,
                    lastUsed: now
                };
            } else {
                cache[symbol.id] = {
                    symbol,
                    turnCount: initialTurnCount,
                    lastUsed: now
                };
            }
        }

        await redisService.request(['SET', key, JSON.stringify(cache), 'EX', '86400']);
    }

    /**
     * Emit a CACHE_LOAD event for the cache of a session.
     */
    async emitCacheLoad(sessionId: string): Promise<void> {
        const key = this.getCacheKey(sessionId);
        const data = await redisService.request(['GET', key]);
        if (!data) return;

        const cache: Record<string, CacheEntry> = JSON.parse(data);
        const entries = Object.values(cache);

        // Sort: lowest turn count first (stable), then newest first (LRU)
        entries.sort((a, b) => {
            if (a.turnCount !== b.turnCount) {
                return a.turnCount - b.turnCount;
            }
            return b.lastUsed - a.lastUsed;
        });

        const symbols = entries.map(e => e.symbol);
        // Emit batched CACHE_LOAD event
        eventBusService.emit(KernelEventType.CACHE_LOAD, {
            sessionId,
            symbolIds: symbols.map(s => s.id),
            symbols: symbols
        });
    }

    /**
     * Reset the turnCount of a symbol to 0 (current) and update lastUsed.
     */
    async touchSymbol(sessionId: string, symbolId: string): Promise<void> {
        if (!sessionId) return;
        const key = this.getCacheKey(sessionId);
        const data = await redisService.request(['GET', key]);
        if (!data) return;

        const cache: Record<string, CacheEntry> = JSON.parse(data);
        if (cache[symbolId]) {
            cache[symbolId].turnCount = 0;
            cache[symbolId].lastUsed = Date.now();
            await redisService.request(['SET', key, JSON.stringify(cache), 'EX', '86400']);
        }
    }

    /**
     * Increment turnCount for all symbols and evict those that exceed MAX_TURNS.
     */
    async incrementTurns(sessionId: string): Promise<void> {
        if (!sessionId) return;
        const key = this.getCacheKey(sessionId);
        const data = await redisService.request(['GET', key]);
        if (!data) return;

        const cache: Record<string, CacheEntry> = JSON.parse(data);
        const newCache: Record<string, CacheEntry> = {};
        let evictedCount = 0;
        const evictedIds: string[] = [];

        for (const [id, entry] of Object.entries(cache)) {
            const newTurnCount = entry.turnCount + 1;
            if (newTurnCount < this.MAX_TURNS) {
                newCache[id] = {
                    ...entry,
                    turnCount: newTurnCount
                };
            } else {
                evictedCount++;
                evictedIds.push(id);
            }
        }

        if (Object.keys(newCache).length > 0) {
            await redisService.request(['SET', key, JSON.stringify(newCache), 'EX', '86400']);
        } else {
            await redisService.request(['DEL', key]);
        }

        if (evictedCount > 0) {
            loggerService.debug(`Evicted ${evictedCount} symbols from cache for session ${sessionId}`);
            // Emit single CACHE_EVICT event with all IDs
            eventBusService.emit(KernelEventType.CACHE_EVICT, {
                sessionId,
                symbolIds: evictedIds
            });
        }
    }

    /**
     * Check if a symbol is in the cache.
     */
    async hasSymbol(sessionId: string, symbolId: string): Promise<boolean> {
        if (!sessionId) return false;
        const key = this.getCacheKey(sessionId);
        const data = await redisService.request(['GET', key]);
        if (!data) return false;

        const cache: Record<string, CacheEntry> = JSON.parse(data);
        return !!cache[symbolId];
    }

    /**
     * Clear the cache for a session.
     */
    async clearCache(sessionId: string): Promise<void> {
        const key = this.getCacheKey(sessionId);
        await redisService.request(['DEL', key]);
    }
}

export const symbolCacheService = new SymbolCacheService();
