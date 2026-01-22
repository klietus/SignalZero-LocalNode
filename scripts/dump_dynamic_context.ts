import { contextWindowService } from '../services/contextWindowService.js';
import { redisService } from '../services/redisService.js';
import fs from 'fs';
import path from 'path';

async function main() {
    try {
        console.log("Loading dynamic context...");
        // Accessing private method via type casting
        const context = await (contextWindowService as any).buildDynamicContext('conversation');
        
        const outputPath = path.join(process.cwd(), 'dynamic_context.txt');
        fs.writeFileSync(outputPath, context);
        
        console.log(`Dynamic context written to ${outputPath}`);
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

main();
