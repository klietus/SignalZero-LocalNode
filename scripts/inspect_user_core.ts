import { redisService } from '../services/redisService.js';
import { domainService } from '../services/domainService.js';

async function main() {
    try {
        console.log("Inspecting Redis for USER-RECURSIVE-CORE...");
        
        // 1. Get all domain keys
        const domains = await redisService.request(['SMEMBERS', 'sz:domains']);
        console.log(`Found domains: ${domains.join(', ')}`);

        for (const domain of domains) {
            const key = `sz:domain:${domain}`;
            const data = await redisService.request(['GET', key]);
            if (!data) continue;

            const parsed = JSON.parse(data);
            const matches = parsed.symbols.filter((s: any) => s.id === 'USER-RECURSIVE-CORE');
            
            if (matches.length > 0) {
                console.log(`\n--- Found in Domain: ${domain} ---`);
                console.log(`Count: ${matches.length}`);
                console.log(JSON.stringify(matches, null, 2));
            }
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

main();
