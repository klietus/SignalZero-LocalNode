import { redisService } from '../services/redisService.ts';

async function findSymbol() {
    const symbolId = 'NARRATIVE-ANCHOR-20240521-AMAZON-OPERATOR-ACTIVATED';
    console.log(`Searching for symbol: ${symbolId}`);

    // 1. Check global domains
    const globalDomains = await redisService.request(['SMEMBERS', 'sz:domains']);
    if (globalDomains) {
        for (const domainId of globalDomains) {
            const key = `sz:domain:${domainId}`;
            const data = await redisService.request(['GET', key]);
            if (data) {
                const domain = JSON.parse(data);
                if (domain.symbols && domain.symbols.find((s: any) => s.id === symbolId)) {
                    console.log(`FOUND in global domain: ${domainId} (Key: ${key})`);
                }
            }
        }
    }

    // 2. Check user domains (scan for all sz:user:*:domain:*)
    // Note: SCAN might be slow if there are many users, but it's the most thorough.
    let cursor = '0';
    do {
        const [nextCursor, keys] = await redisService.request(['SCAN', cursor, 'MATCH', 'sz:user:*:domain:*', 'COUNT', '100']);
        cursor = nextCursor;
        for (const key of keys) {
            const data = await redisService.request(['GET', key]);
            if (data) {
                const domain = JSON.parse(data);
                if (domain.symbols && domain.symbols.find((s: any) => s.id === symbolId)) {
                    console.log(`FOUND in user domain: ${key}`);
                }
            }
        }
    } while (cursor !== '0');

    console.log('Search complete.');
    process.exit(0);
}

findSymbol().catch(err => {
    console.error(err);
    process.exit(1);
});
