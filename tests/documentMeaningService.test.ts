
import { describe, it, expect } from 'vitest';
import { documentMeaningService } from '../services/documentMeaningService.js';

describe('DocumentMeaningService', () => {
    it('should parse HTML using Readability', async () => {
        const html = `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Test Page</title>
            </head>
            <body>
                <header>Noise</header>
                <main>
                    <article>
                        <h1>Main Title</h1>
                        <p>This is the important content that should be kept.</p>
                    </article>
                </main>
                <footer>More Noise</footer>
            </body>
            </html>
        `;
        const result = await documentMeaningService.parse(html, 'text/html', 'https://example.com');
        
        expect(result.type).toBe('html');
        expect(result.content).toContain('Main Title');
        expect(result.content).toContain('This is the important content');
        expect(result.content).not.toContain('Noise');
        expect(result.metadata.title).toBeDefined();
    });

    it('should extract images from HTML', async () => {
        const html = `
            <html>
            <body>
                <p>Hello</p>
                <img src="https://example.com/image.png" alt="An Image">
            </body>
            </html>
        `;
        const result = await documentMeaningService.parse(html, 'text/html');
        
        expect(result.structured_data.images).toHaveLength(1);
        expect(result.structured_data.images[0].url).toBe('https://example.com/image.png');
        expect(result.structured_data.images[0].title).toBe('An Image');
        expect(result.content).toContain('[Image: An Image] (https://example.com/image.png)');
    });

    it('should parse JSON', async () => {
        const json = JSON.stringify({ key: 'value' });
        const result = await documentMeaningService.parse(json, 'application/json');
        
        expect(result.type).toBe('json');
        expect(result.structured_data).toEqual({ key: 'value' });
    });
});
