import { describe, it, expect } from 'vitest';

describe('export_gsm8k', () => {
    it('should be importable', async () => {
        // Verify the module can be imported and has the expected export
        const module = await import('../scripts/export_gsm8k.ts');
        expect(module).toBeDefined();
        expect(typeof module.exportRun).toBe('function');
    });
});
