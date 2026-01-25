import { redisService } from '../services/redisService.js';

async function migrate() {
    try {
        console.log("🚀 Starting Test Run Data Recovery...");
        
        // 1. Get all Test Run keys
        const runKeys = await redisService.request(['KEYS', 'sz:test_run:*']);
        console.log(`Found ${runKeys.length} potential runs to check.`);

        for (const key of runKeys) {
            // Skip individual result keys (new format)
            if (key.includes(':result:')) continue;

            const runId = key.split(':').pop();
            const data = await redisService.request(['GET', key]);
            if (!data) continue;

            const run = JSON.parse(data);

            // 2. Check if this run has the "Old" inline results array
            if (Array.isArray(run.results) && run.results.length > 0) {
                console.log(`📦 Recovering ${run.results.length} results for Run: ${runId}`);

                // 3. Move each result to an individual key (New Format)
                const recoveryPromises = run.results.map((result: any) => {
                    const resultKey = `sz:test_run_result:${runId}:${result.id}`;
                    return redisService.request(['SET', resultKey, JSON.stringify(result), 'EX', '604800']);
                });

                await Promise.all(recoveryPromises);

                // 4. Strip the results from the main key to finalize migration
                const { results, ...meta } = run;
                await redisService.request(['SET', key, JSON.stringify(meta)]);
                
                console.log(`✅ Run ${runId} migrated successfully.`);
            } else {
                console.log(`- Run ${runId} already migrated or empty.`);
            }
        }

        console.log("✨ Recovery complete. Please refresh your Test Runner UI.");

    } catch (error) {
        console.error("❌ Recovery failed:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

migrate();
