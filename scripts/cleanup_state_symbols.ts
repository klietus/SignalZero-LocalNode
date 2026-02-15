import { domainService } from '../services/domainService.js';
import { redisService } from '../services/redisService.js';
import { fileURLToPath } from 'url';

export async function cleanupOrphanedSymbols() {
    console.log("Cleaning up orphaned symbol entries (including state domain)...");

    const domains = await domainService.listDomains();
    const validIds = new Set<string>();

    for (const domainId of domains) {
        const symbols = await domainService.getSymbols(domainId);
        symbols.forEach(s => validIds.add(s.id));
    }

    console.log(`Found ${validIds.size} valid symbols in remaining domains.`);

    const keys = await redisService.request(['KEYS', 'sz:bucket:symbols:*']);
    console.log(`Scanning ${keys.length} time buckets...`);

    let removedCount = 0;
    for (const key of keys) {
        const bucketIds = await redisService.request(['SMEMBERS', key]);
        const toRemove = bucketIds.filter((id: string) => !validIds.has(id));
        if (toRemove.length > 0) {
            console.log(`Removing ${toRemove.length} orphaned IDs from ${key}`);
            await redisService.request(['SREM', key, ...toRemove]);
            removedCount += toRemove.length;
        }
    }

    console.log(`Cleanup complete. Total orphaned entries removed: ${removedCount}`);

    return {
        validSymbolsCount: validIds.size,
        bucketsScanned: keys.length,
        orphanedEntriesRemoved: removedCount
    };
}

export async function main() {
    try {
        await cleanupOrphanedSymbols();
    } catch (error) {
        console.error("Error during cleanup:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}