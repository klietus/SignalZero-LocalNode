
import { settingsService } from '../services/settingsService.js';
import { vectorService } from '../services/vectorService.js';

async function run() {
    const count = await vectorService.countCollection();
    console.log(`Total symbols in ChromaDB: ${count}`);

    // Peek at some results
    const results = await vectorService.search("psychological", 10);
    console.log(`Search for 'psychological' returned ${results.length} hits`);
    results.forEach(r => {
        console.log(` - [${r.metadata.domain}] ${r.id}: ${r.score}`);
    });

    const results2 = await vectorService.search("projection", 10);
    console.log(`Search for 'projection' returned ${results2.length} hits`);
    results2.forEach(r => {
        console.log(` - [${r.metadata.domain}] ${r.id}: ${r.score}`);
    });

    const results3 = await vectorService.search("psychological projection", 10);
    console.log(`Search for 'psychological projection' returned ${results3.length} hits`);
    results3.forEach(r => {
        console.log(` - [${r.metadata.domain}] ${r.id}: ${r.score}`);
    });

    const results4 = await vectorService.search("familial manipulation", 10);
    console.log(`Search for 'familial manipulation' returned ${results4.length} hits`);
    results4.forEach(r => {
        console.log(` - [${r.metadata.domain}] ${r.id}: ${r.score}`);
    });
}

run().catch(console.error);
