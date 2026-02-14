import { describe, it, expect } from 'vitest';

describe('fix_user_core', () => {
    it('should be importable', async () => {
        const module = await import('../scripts/fix_user_core.ts');
        expect(module).toBeDefined();
        expect(typeof module.fixUserCore).toBe('function');
    });
});
