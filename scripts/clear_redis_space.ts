import { redisService } from '../services/redisService.js';
import { loggerService } from '../services/loggerService.js';

async function clearSpace() {
    console.log('Starting Redis space cleanup (preserving symbols and users)...');

    const patterns = [
        'context:*',
        'sz:trace:*',
        'sz:session_traces:*',
        'sz:buckets:traces:*',
        'attachment:*',
        'sz:test_run:*',
        'sz:test_run_result:*',
        'sz:test_run_summary:*'
    ];

    let totalDeleted = 0;

    for (const pattern of patterns) {
        console.log(`Scanning for pattern: ${pattern}`);
        const keys = await redisService.request(['KEYS', pattern]);
        if (keys && keys.length > 0) {
            console.log(`Deleting ${keys.length} keys for pattern: ${pattern}`);
            // Delete in batches of 1000 to avoid blocking
            for (let i = 0; i < keys.length; i += 1000) {
                const batch = keys.slice(i, i + 1000);
                await redisService.request(['DEL', ...batch]);
                totalDeleted += batch.length;
            }
        }
    }

    // Also clear the sets of IDs
    const sets = [
        'context:index',
        'sz:test_runs'
    ];

    for (const set of sets) {
        console.log(`Clearing set: ${set}`);
        const exists = await redisService.request(['EXISTS', set]);
        if (exists) {
            await redisService.request(['DEL', set]);
            totalDeleted++;
        }
    }

    console.log(`Cleanup complete. Total keys deleted: ${totalDeleted}`);
}

clearSpace().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('Cleanup failed', err);
    process.exit(1);
});
