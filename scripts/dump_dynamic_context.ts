import { contextWindowService } from '../services/contextWindowService.js';
import { redisService } from '../services/redisService.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export async function main() {
    try {
        console.log("Loading dynamic context...");
        // Accessing private method via type casting
        const context = await (contextWindowService as any).buildDynamicContext('conversation');
        
        const outputPath = path.join(process.cwd(), 'dynamic_context.txt');
        fs.writeFileSync(outputPath, context);
        
        console.log(`Dynamic context dumped to dynamic_context.txt`);
    } catch (error) {
        console.error("Failed to dump dynamic context:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main();
}