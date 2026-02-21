
import { settingsService } from './services/settingsService.ts';
import { loggerService } from './services/loggerService.ts';

async function check() {
    const settings = await settingsService.getSerpApiSettings();
    console.log('SerpApi Key found:', settings.apiKey ? 'YES' : 'NO');
    if (settings.apiKey) {
        console.log('Key length:', settings.apiKey.length);
        console.log('Masked key:', settings.apiKey.substring(0, 4) + '...');
    }
}

check().catch(console.error);
