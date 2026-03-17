import { settingsService } from './services/settingsService.js';
import { redisService } from './services/redisService.js';

async function main() {
    console.log('Adding Skills MCP configuration...');
    
    // Ensure we are connected to Redis (settingsService needs it)
    // Wait a bit for initialization
    await new Promise(resolve => setTimeout(resolve, 1000));

    const skillsConfig = {
        id: 'skills',
        name: 'Gemini Skills',
        endpoint: process.env.METAMCP_ENDPOINT || 'http://metamcp:12008/metamcp/signalzero/sse',
        token: process.env.INTERNAL_SERVICE_KEY,
        enabled: true
    };

    const currentConfigs = await settingsService.getMcpConfigs();
    const updatedConfigs = currentConfigs.filter(c => c.id !== 'skills');
    updatedConfigs.push(skillsConfig);

    await settingsService.setMcpConfigs(updatedConfigs);
    console.log('Skills MCP configuration added successfully.');
    process.exit(0);
}

main().catch(err => {
    console.error('Failed to add MCP config:', err);
    process.exit(1);
});
