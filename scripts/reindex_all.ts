
import { domainService } from '../services/domainService.js';
import { vectorService } from '../services/vectorService.js';
import { redisService } from '../services/redisService.js';

async function run() {
    console.log("Starting full re-index...");
    
    // 1. Get all domain keys
    const keys = await redisService.request(['KEYS', 'sz:domain:*']);
    console.log(`Found ${keys.length} domains in Redis`);

    let totalIndexed = 0;

    for (const key of keys) {
        const domainId = key.replace('sz:domain:', '');
        console.log(`Processing domain: ${domainId}`);
        
        const data = await redisService.request(['GET', key]);
        if (!data) continue;

        try {
            const domain = JSON.parse(data);
            const symbols = domain.symbols || [];
            console.log(` - Domain ${domainId} has ${symbols.length} symbols`);
            
            if (symbols.length > 0) {
                const count = await vectorService.indexBatch(symbols);
                totalIndexed += count;
                console.log(` - Indexed ${count} symbols for ${domainId}`);
            }
        } catch (e) {
            console.error(` - Failed to process domain ${domainId}:`, e);
        }
    }

    console.log(`Re-indexing complete. Total symbols indexed: ${totalIndexed}`);
    process.exit(0);
}

run().catch(e => {
    console.error(e);
    process.exit(1);
});
