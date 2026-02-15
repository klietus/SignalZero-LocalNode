import { describe, it, expect, vi } from 'vitest';

vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

describe('fix_user_core', () => {
    it('should be importable', async () => {
        const module = await import('../scripts/fix_user_core.ts?t=' + Date.now());
        expect(module).toBeDefined();
        expect(typeof module.fixUserCore).toBe('function');
    });
});