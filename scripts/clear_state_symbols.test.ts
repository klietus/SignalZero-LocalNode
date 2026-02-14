import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { redisService, __redisTestUtils } from '../services/redisService.ts';

// Store console mock state
const consoleMocks = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
};

// Mock console before any imports
vi.stubGlobal('console', {
    ...console,
    log: consoleMocks.log,
    error: consoleMocks.error,
    warn: consoleMocks.warn
});

// Mock the vectorService
vi.mock('../services/vectorService.js', () => ({
    vectorService: {
        deleteSymbol: vi.fn()
    }
}));

// Import after mocks
import { vectorService } from '../services/vectorService.js';

describe('clear_state_symbols script', () => {
    beforeEach(() => {
        __redisTestUtils.resetMock();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should exit early if domain is not found', async () => {
        const { main } = await import('../scripts/clear_state_symbols.ts');
        await main();

        expect(consoleMocks.error).toHaveBeenCalledWith("❌ Domain 'state' not found.");
        expect(vectorService.deleteSymbol).not.toHaveBeenCalled();
    });

    it('should exit early if domain has no symbols', async () => {
        await redisService.request(['SET', 'sz:domain:state', JSON.stringify({
            id: 'state',
            symbols: [],
            lastUpdated: Date.now()
        })]);

        const { main } = await import('../scripts/clear_state_symbols.ts');
        await main();

        expect(consoleMocks.log).toHaveBeenCalledWith("ℹ️ No symbols found in domain.");
        expect(vectorService.deleteSymbol).not.toHaveBeenCalled();
    });

    it('should delete all symbols from vector store and update domain', async () => {
        const symbols = [
            { id: 'SYM-1', name: 'Symbol 1' },
            { id: 'SYM-2', name: 'Symbol 2' },
            { id: 'SYM-3', name: 'Symbol 3' }
        ];

        await redisService.request(['SET', 'sz:domain:state', JSON.stringify({
            id: 'state',
            symbols: symbols,
            lastUpdated: Date.now()
        })]);

        vi.mocked(vectorService.deleteSymbol).mockResolvedValue(true);

        // Spy on SET to capture what gets saved before disconnect clears it
        const setSpy = vi.spyOn(redisService, 'request');

        const { main } = await import('../scripts/clear_state_symbols.ts');
        await main();

        expect(vectorService.deleteSymbol).toHaveBeenCalledTimes(3);
        expect(vectorService.deleteSymbol).toHaveBeenCalledWith('SYM-1');
        expect(vectorService.deleteSymbol).toHaveBeenCalledWith('SYM-2');
        expect(vectorService.deleteSymbol).toHaveBeenCalledWith('SYM-3');

        expect(consoleMocks.log).toHaveBeenCalledWith("🗑️ Deleting 3 symbols from vector store...");
        expect(consoleMocks.log).toHaveBeenCalledWith("💾 Updating domain metadata in Redis...");
        expect(consoleMocks.log).toHaveBeenCalledWith("✅ Success! Domain 'state' preserved, symbols cleared.");

        // Check the SET call to verify domain was updated with empty symbols
        const setCalls = setSpy.mock.calls.filter(call => call[0][0] === 'SET');
        expect(setCalls.length).toBeGreaterThan(0);
        const lastSetCall = setCalls[setCalls.length - 1];
        const savedDomain = JSON.parse(lastSetCall[0][2]);
        expect(savedDomain.symbols).toEqual([]);
        expect(savedDomain.lastUpdated).toBeDefined();
    });

    it('should continue deleting symbols if one fails', async () => {
        const symbols = [
            { id: 'SYM-1', name: 'Symbol 1' },
            { id: 'SYM-2', name: 'Symbol 2' }
        ];

        await redisService.request(['SET', 'sz:domain:state', JSON.stringify({
            id: 'state',
            symbols: symbols,
            lastUpdated: Date.now()
        })]);

        vi.mocked(vectorService.deleteSymbol)
            .mockResolvedValueOnce(true)
            .mockRejectedValueOnce(new Error('Delete failed'));

        // Spy on SET to capture what gets saved before disconnect clears it
        const setSpy = vi.spyOn(redisService, 'request');

        const { main } = await import('../scripts/clear_state_symbols.ts');
        await main();

        expect(vectorService.deleteSymbol).toHaveBeenCalledTimes(2);
        
        expect(consoleMocks.warn).toHaveBeenCalledWith(
            expect.stringContaining('⚠️ Failed to delete symbol SYM-2 from vector store:'),
            expect.any(Error)
        );

        // Check the SET call to verify domain was updated with empty symbols
        const setCalls = setSpy.mock.calls.filter(call => call[0][0] === 'SET');
        expect(setCalls.length).toBeGreaterThan(0);
        const lastSetCall = setCalls[setCalls.length - 1];
        const savedDomain = JSON.parse(lastSetCall[0][2]);
        expect(savedDomain.symbols).toEqual([]);
    });

    it('should handle JSON parse errors gracefully', async () => {
        await redisService.request(['SET', 'sz:domain:state', 'invalid-json{']);

        const { main } = await import('../scripts/clear_state_symbols.ts');
        await main();

        expect(consoleMocks.error).toHaveBeenCalledWith(
            "❌ Error during operation:",
            expect.any(SyntaxError)
        );
    });

    it('should disconnect from Redis on completion', async () => {
        const disconnectSpy = vi.spyOn(redisService, 'disconnect');
        
        await redisService.request(['SET', 'sz:domain:state', JSON.stringify({
            id: 'state',
            symbols: [],
            lastUpdated: Date.now()
        })]);

        const { main } = await import('../scripts/clear_state_symbols.ts');
        await main();

        expect(disconnectSpy).toHaveBeenCalled();
    });

    it('should log the initial clearing message', async () => {
        await redisService.request(['SET', 'sz:domain:state', JSON.stringify({
            id: 'state',
            symbols: [],
            lastUpdated: Date.now()
        })]);

        const { main } = await import('../scripts/clear_state_symbols.ts');
        await main();

        expect(consoleMocks.log).toHaveBeenCalledWith('🧹 Clearing symbols for domain: state');
    });
});
