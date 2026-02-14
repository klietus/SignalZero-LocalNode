import { redisService } from '../services/redisService.js';

export async function fixUserCore() {
    try {
        console.log("Fixing USER-RECURSIVE-CORE deduplication in 'user' domain...");
        
        const key = 'sz:domain:user';
        const data = await redisService.request(['GET', key]);
        if (!data) {
            console.log("User domain not found.");
            return;
        }

        const parsed = JSON.parse(data);
        const originalCount = parsed.symbols.length;
        
        // Find the lattice version
        const latticeVersion = parsed.symbols.find((s: any) => s.id === 'USER-RECURSIVE-CORE' && s.kind === 'lattice');
        
        if (!latticeVersion) {
            console.log("Could not find the Lattice version to keep. Aborting to be safe.");
            return;
        }

        // Filter: Keep everything that ISN'T USER-RECURSIVE-CORE, then add back the Lattice version
        const otherSymbols = parsed.symbols.filter((s: any) => s.id !== 'USER-RECURSIVE-CORE');
        parsed.symbols = [...otherSymbols, latticeVersion];

        console.log(`Removed duplicate. Original symbols: ${originalCount}, New count: ${parsed.symbols.length}`);
        
        await redisService.request(['SET', key, JSON.stringify(parsed)]);
        console.log("Redis updated successfully.");

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

fixUserCore();
