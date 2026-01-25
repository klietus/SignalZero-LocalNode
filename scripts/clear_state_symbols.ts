import { redisService } from '../services/redisService.js';
import { vectorService } from '../services/vectorService.js';

async function main() {
    const domainId = 'state';
    const key = `sz:domain:${domainId}`;

    try {
        console.log(`🧹 Clearing symbols for domain: ${domainId}`);
        
        const data = await redisService.request(['GET', key]);
        if (!data) {
            console.error(`❌ Domain '${domainId}' not found.`);
            return;
        }

        const domain = JSON.parse(data);
        const symbolCount = domain.symbols?.length || 0;

        if (symbolCount === 0) {
            console.log("ℹ️ No symbols found in domain.");
            return;
        }

        console.log(`🗑️ Deleting ${symbolCount} symbols from vector store...`);
        for (const symbol of domain.symbols) {
            try {
                await vectorService.deleteSymbol(symbol.id);
            } catch (e) {
                console.warn(`⚠️ Failed to delete symbol ${symbol.id} from vector store:`, e);
            }
        }

        console.log("💾 Updating domain metadata in Redis...");
        domain.symbols = [];
        domain.lastUpdated = Date.now();
        
        await redisService.request(['SET', key, JSON.stringify(domain)]);

        console.log(`✅ Success! Domain '${domainId}' preserved, symbols cleared.`);

    } catch (error) {
        console.error("❌ Error during operation:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

main();
