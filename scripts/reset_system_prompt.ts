import { systemPromptService } from '../services/systemPromptService.js';
import { redisService } from '../services/redisService.js';
import { ACTIVATION_PROMPT } from '../symbolic_system/activation_prompt.js';

async function main() {
    try {
        console.log("Resetting system prompt in Redis...");
        await systemPromptService.setPrompt(ACTIVATION_PROMPT);
        console.log("System prompt updated to current code version.");
    } catch (error) {
        console.error("Error:", error);
    } finally {
        await redisService.disconnect();
        process.exit(0);
    }
}

main();
