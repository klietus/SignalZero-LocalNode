import { contextWindowService } from '../services/contextWindowService.js';
import { redisService } from '../services/redisService.js';
import fs from 'fs';
import path from 'path';

export async function main() {
    try {
        console.log("Loading static context...");
        // Accessing private method via type casting
        const context = await (contextWindowService as any).buildStableContext();
        
        const outputPath = path.join(process.cwd(), 'static_context.txt');
        fs.writeFileSync(outputPath, context);
        
        console.log(`Static context written to ${outputPath}`);
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

main();
