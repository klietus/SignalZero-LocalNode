import { redisService } from '../services/redisService.js';
import * as fs from 'fs';
import * as path from 'path';

async function exportTestData() {
    console.log('Exporting test runs and results...');
    
    const allKeys = await redisService.request(['KEYS', '*']);
    console.log(`All keys in Redis: ${JSON.stringify(allKeys)}`);

    const runIds: string[] = await redisService.request(['SMEMBERS', 'sz:test_runs']);
    if (!runIds || runIds.length === 0) {
        console.log('No test runs found.');
        return;
    }

    const exportData: any[] = [];

    for (const runId of runIds) {
        console.log(`Exporting run: ${runId}`);
        const runMetaRaw = await redisService.request(['GET', `sz:test_run:${runId}`]);
        if (!runMetaRaw) continue;

        const run = JSON.parse(runMetaRaw);
        
        // Fetch results for this run
        const resultKeys = await redisService.request(['KEYS', `sz:test_run_result:${runId}:*`]);
        const results: any[] = [];
        
        if (resultKeys && resultKeys.length > 0) {
            for (let i = 0; i < resultKeys.length; i += 100) {
                const batch = resultKeys.slice(i, i + 100);
                const batchResults = await Promise.all(batch.map(k => redisService.request(['GET', k])));
                results.push(...batchResults.filter(r => r !== null).map(r => JSON.parse(r)));
            }
        }

        exportData.push({
            ...run,
            results
        });
    }

    const outputPath = path.join(process.cwd(), 'test_results_export.json');
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));
    console.log(`Exported ${exportData.length} runs to ${outputPath}`);
}

exportTestData().then(() => process.exit(0)).catch(err => {
    console.error(err);
    process.exit(1);
});
