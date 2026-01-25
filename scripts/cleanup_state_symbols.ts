import { redisService } from '../services/redisService.js';
import { domainService } from '../services/domainService.js';

async function main() {
    try {
        console.log("Cleaning up orphaned symbol entries (including state domain)...");
        
        // 1. Get all valid symbol IDs from all domains
        const allSymbols = await domainService.getAllSymbols(true);
        const validIds = new Set(allSymbols.map(s => s.id));
        console.log(`Found ${validIds.size} valid symbols in remaining domains.`);

        // 2. Scan for symbol buckets
        const keys = await redisService.request(['KEYS', 'sz:bucket:symbols:*']);
        console.log(`Scanning ${keys.length} time buckets...`);

        let removedCount = 0;
        for (const key of keys) {
            const bucketIds = await redisService.request(['SMEMBERS', key]);
            if (!Array.isArray(bucketIds)) continue;

            const toRemove = bucketIds.filter(id => !validIds.has(id));
            if (toRemove.length > 0) {
                console.log(`Removing ${toRemove.length} orphaned IDs from ${key}`);
                await redisService.request(['SREM', key, ...toRemove]);
                removedCount += toRemove.length;
            }
        }

        console.log(`Cleanup complete. Total orphaned entries removed: ${removedCount}`);

    } catch (error) {
        console.error("Error during cleanup:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

main();
