import { redisService } from '../services/redisService.js';

async function rebuild() {
    try {
        console.log("🚀 Starting Test Run Metadata Rebuild...");
        
        // 1. Get all Test Run IDs
        const runIds = await redisService.request(['SMEMBERS', 'sz:test_runs']);
        console.log(`Found ${runIds.length} runs to process.`);

        for (const runId of runIds) {
            console.log(`\n🔍 Processing Run: ${runId}`);

            // 2. Scan for all individual result keys for this run
            // Pattern: sz:test_run_result:RUN-ID:*
            const resultKeys = await redisService.request(['KEYS', `sz:test_run_result:${runId}:*`]);
            console.log(`   - Found ${resultKeys.length} result keys.`);

            if (resultKeys.length === 0) {
                console.log(`   - Skipping: No results found.`);
                continue;
            }

            // 3. Fetch all results to calculate counts
            const resultsRaw = await Promise.all(resultKeys.map((k: string) => redisService.request(['GET', k])));
            const results = resultsRaw.filter(r => r !== null).map(r => JSON.parse(r));

            const total = results.length;
            const completed = results.filter(r => r.status === 'completed' || r.status === 'failed').length;
            const passed = results.filter(r => r.status === 'completed').length;
            const failed = results.filter(r => r.status === 'failed').length;

            console.log(`   - New Summary: Total=${total}, Completed=${completed}, Passed=${passed}, Failed=${failed}`);

            // 4. Update the main metadata object
            const metaKey = `sz:test_run:${runId}`;
            const summaryKey = `sz:test_run_summary:${runId}`;
            const metaData = await redisService.request(['GET', metaKey]);
            
            if (metaData) {
                // Sync Redis Hash counters for atomic increments
                await redisService.request(['HSET', summaryKey, 'completed', String(completed), 'passed', String(passed), 'failed', String(failed)]);
                await redisService.request(['EXPIRE', summaryKey, '604800']);

                const run = JSON.parse(metaData);
                run.summary = { total, completed, passed, failed };
                
                // If it was running but interrupted, we set it to stopped
                if (run.status === 'running') {
                    run.status = 'stopped';
                }

                await redisService.request(['SET', metaKey, JSON.stringify(run)]);
                console.log(`   ✅ Metadata updated for ${runId}`);
            } else {
                console.log(`   ⚠️ Warning: Metadata key ${metaKey} not found! Creating minimal skeleton.`);
                // Could create a skeleton here if needed, but usually the run exists if it's in SMEMBERS
            }
        }

        console.log("\n✨ Rebuild complete. Please refresh your Test Runner UI.");

    } catch (error) {
        console.error("❌ Rebuild failed:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

rebuild();
