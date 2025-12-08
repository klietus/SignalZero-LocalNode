import { domainService } from './domainService.ts';
import { vectorService } from './vectorService.ts';
import { loggerService } from './loggerService.ts';

interface IndexQueueState {
    pending: number;
    total: number;
    running: boolean;
}

interface ReindexResult {
    status: 'completed' | 'already-running';
    resetPerformed?: boolean;
    indexedCount?: number;
    totalSymbols?: number;
    failedIds?: string[];
    lastReindexAt?: string | null;
    queue?: IndexQueueState;
}

let queueState: IndexQueueState = {
    pending: 0,
    total: 0,
    running: false
};

let lastReindexAt: string | null = null;

async function reindexSymbols(includeDisabled: boolean = false): Promise<ReindexResult> {
    if (queueState.running) {
        return { status: 'already-running', queue: { ...queueState }, lastReindexAt };
    }

    queueState = { pending: 0, total: 0, running: true };

    try {
        const symbols = await domainService.getAllSymbols(includeDisabled);
        queueState.total = symbols.length;
        queueState.pending = symbols.length;

        const resetPerformed = await vectorService.resetCollection();
        const failedIds: string[] = [];
        let indexedCount = 0;

        for (const symbol of symbols) {
            const success = await vectorService.indexSymbol(symbol);
            if (success) indexedCount++;
            else failedIds.push(symbol.id);
            queueState.pending = Math.max(queueState.pending - 1, 0);
        }

        lastReindexAt = new Date().toISOString();
        return {
            status: 'completed',
            resetPerformed,
            indexedCount,
            totalSymbols: symbols.length,
            failedIds,
            lastReindexAt,
            queue: { ...queueState }
        };
    } catch (e) {
        loggerService.error('IndexingService: reindex failed', { error: e });
        throw e;
    } finally {
        queueState = { ...queueState, running: false, pending: 0 };
    }
}

async function getStatus() {
    const collectionCount = await vectorService.countCollection();
    return {
        queue: { ...queueState },
        collectionCount,
        lastReindexAt
    };
}

export const indexingService = {
    reindexSymbols,
    getStatus
};
