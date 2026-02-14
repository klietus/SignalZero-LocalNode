import { redisService } from '../services/redisService.js';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';

export async function exportRun(runId: string) {
    process.env.REDIS_URL = 'redis://localhost:6380';
    console.log(`Starting export for run: ${runId}`);

    // 1. Get run metadata
    const runMetaRaw = await redisService.request(['GET', `sz:test_run:${runId}`]);
    if (!runMetaRaw) {
        console.error("Run metadata not found");
        return;
    }
    const runMeta = JSON.parse(runMetaRaw);

    // 2. Get all result keys
    const resultKeys = await redisService.request(['KEYS', `sz:test_run_result:${runId}:*`]);
    console.log(`Found ${resultKeys.length} result keys.`);

    const results = [];
    for (const key of resultKeys) {
        const data = await redisService.request(['GET', key]);
        if (data) {
            results.push(JSON.parse(data));
        }
    }

    // 3. Create Zip
    const zip = new JSZip();
    zip.file('run_metadata.json', JSON.stringify(runMeta, null, 2));
    
    const resultsFolder = zip.folder('results');
    results.forEach((res, i) => {
        const filename = `${res.id}.json`;
        resultsFolder?.file(filename, JSON.stringify(res, null, 2));
    });

    const content = await zip.generateAsync({ type: 'nodebuffer' });
    const outputPath = path.join(process.cwd(), `gsm8k_export_${runId}.zip`);
    fs.writeFileSync(outputPath, content);

    console.log(`Export complete: ${outputPath}`);
    await redisService.disconnect();
}

exportRun('RUN-1769119904537');
