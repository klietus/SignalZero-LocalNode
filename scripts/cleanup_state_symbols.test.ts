import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { domainService } from '../services/domainService.js';
import { redisService, __redisTestUtils } from '../services/redisService.js';
import { cleanupOrphanedSymbols, CleanupResult } from './cleanup_state_symbols.js';

describe('cleanup_state_symbols', () => {
  // Mock console methods to capture output
  const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    __redisTestUtils.resetMock();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __redisTestUtils.resetMock();
  });

  describe('cleanupOrphanedSymbols function', () => {
    it('should clean up orphaned symbol entries from redis buckets', async () => {
      // Setup: Create a domain with valid symbols
      const validSymbol = { 
        id: 'valid-sym-1', 
        name: 'Valid Symbol',
        created_at: Date.now()
      };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      // Setup: Create a symbol bucket with both valid and orphaned IDs
      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'valid-sym-1', 'orphaned-sym-1', 'orphaned-sym-2']);

      // Run cleanup
      const result = await cleanupOrphanedSymbols();

      // Verify result
      expect(result.validSymbolsCount).toBe(1);
      expect(result.bucketsScanned).toBe(1);
      expect(result.orphanedEntriesRemoved).toBe(2);

      // Verify: orphaned IDs should be removed from bucket
      const remainingIds = await redisService.request(['SMEMBERS', bucketKey]);
      expect(remainingIds).toContain('valid-sym-1');
      expect(remainingIds).not.toContain('orphaned-sym-1');
      expect(remainingIds).not.toContain('orphaned-sym-2');
      expect(remainingIds).toHaveLength(1);
    });

    it('should handle multiple time buckets', async () => {
      // Setup: Create domains with valid symbols
      const validSymbol1 = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const validSymbol2 = { id: 'sym-2', name: 'Symbol 2', created_at: Date.now() };
      
      const domain1 = {
        id: 'domain-1',
        name: 'Domain 1',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol1],
        invariants: [],
        readOnly: false
      };
      const domain2 = {
        id: 'domain-2',
        name: 'Domain 2',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol2],
        invariants: [],
        readOnly: false
      };
      
      await redisService.request(['SET', 'sz:domain:domain-1', JSON.stringify(domain1)]);
      await redisService.request(['SET', 'sz:domain:domain-2', JSON.stringify(domain2)]);
      await redisService.request(['SADD', 'sz:domains', 'domain-1', 'domain-2']);

      // Setup: Create multiple buckets
      const bucket1 = 'sz:bucket:symbols:2024-01-01';
      const bucket2 = 'sz:bucket:symbols:2024-01-02';
      await redisService.request(['SADD', bucket1, 'sym-1', 'orphan-1']);
      await redisService.request(['SADD', bucket2, 'sym-2', 'orphan-2']);

      // Run cleanup
      const result = await cleanupOrphanedSymbols();

      // Verify result
      expect(result.validSymbolsCount).toBe(2);
      expect(result.bucketsScanned).toBe(2);
      expect(result.orphanedEntriesRemoved).toBe(2);

      // Verify both buckets cleaned
      const bucket1Ids = await redisService.request(['SMEMBERS', bucket1]);
      const bucket2Ids = await redisService.request(['SMEMBERS', bucket2]);
      
      expect(bucket1Ids).toEqual(['sym-1']);
      expect(bucket2Ids).toEqual(['sym-2']);
    });

    it('should handle empty symbol buckets gracefully', async () => {
      // Setup: Create domain but no bucket entries
      const validSymbol = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const domain = {
        id: 'empty-domain',
        name: 'Empty Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:empty-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'empty-domain']);

      // Run cleanup - should complete without error
      const result = await cleanupOrphanedSymbols();

      expect(result.validSymbolsCount).toBe(1);
      expect(result.bucketsScanned).toBe(0);
      expect(result.orphanedEntriesRemoved).toBe(0);
    });

    it('should handle buckets with no valid symbols (all orphaned)', async () => {
      // Setup: No valid domains/symbols
      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'orphan-1', 'orphan-2', 'orphan-3']);

      const result = await cleanupOrphanedSymbols();

      expect(result.validSymbolsCount).toBe(0);
      expect(result.bucketsScanned).toBe(1);
      expect(result.orphanedEntriesRemoved).toBe(3);

      // All IDs should be removed
      const remainingIds = await redisService.request(['SMEMBERS', bucketKey]);
      expect(remainingIds).toHaveLength(0);
    });

    it('should skip buckets that return non-array data', async () => {
      // Setup: Create domain with valid symbol
      const validSymbol = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      // Create bucket
      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'sym-1']);

      // Mock SMEMBERS to return non-array for this test
      const originalRequest = redisService.request;
      vi.spyOn(redisService, 'request').mockImplementation(async (command: any[]) => {
        if (command[0] === 'SMEMBERS') {
          return null; // Return non-array
        }
        return originalRequest(command);
      });

      // Run cleanup - should complete without error
      const result = await cleanupOrphanedSymbols();

      // Should complete without errors (bucket skipped due to non-array)
      expect(result.bucketsScanned).toBe(1);
      // Since SMEMBERS returned null, nothing was removed
      expect(result.orphanedEntriesRemoved).toBe(0);
    });

    it('should handle no symbol buckets found', async () => {
      // Setup: Create domain but no buckets
      const validSymbol = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      const result = await cleanupOrphanedSymbols();

      expect(result.validSymbolsCount).toBe(1);
      expect(result.bucketsScanned).toBe(0);
      expect(result.orphanedEntriesRemoved).toBe(0);

      // Should log that 0 buckets were scanned
      expect(mockConsoleLog).toHaveBeenCalledWith('Scanning 0 time buckets...');
    });

    it('should handle symbols with state domain correctly', async () => {
      // Setup: Create a state domain symbol
      const stateSymbol = { 
        id: 'state-sym-1', 
        name: 'State Symbol',
        created_at: Date.now()
      };
      const stateDomain = {
        id: 'state',
        name: 'State Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [stateSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:state', JSON.stringify(stateDomain)]);
      await redisService.request(['SADD', 'sz:domains', 'state']);

      // Create bucket with state symbol and orphan
      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'state-sym-1', 'orphan-1']);

      const result = await cleanupOrphanedSymbols();

      expect(result.validSymbolsCount).toBe(1);
      expect(result.orphanedEntriesRemoved).toBe(1);

      // State symbol should remain, orphan removed
      const remainingIds = await redisService.request(['SMEMBERS', bucketKey]);
      expect(remainingIds).toContain('state-sym-1');
      expect(remainingIds).not.toContain('orphan-1');
    });

    it('should handle duplicate symbol IDs across domains', async () => {
      // Setup: Same symbol ID in multiple domains (edge case)
      const sharedSymbol = { id: 'shared-sym', name: 'Shared Symbol', created_at: Date.now() };
      const domain1 = {
        id: 'domain-1',
        name: 'Domain 1',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [sharedSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:domain-1', JSON.stringify(domain1)]);
      await redisService.request(['SADD', 'sz:domains', 'domain-1']);

      // Create bucket with the shared symbol
      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'shared-sym']);

      const result = await cleanupOrphanedSymbols();

      expect(result.validSymbolsCount).toBe(1);
      expect(result.orphanedEntriesRemoved).toBe(0);

      // Shared symbol should remain
      const remainingIds = await redisService.request(['SMEMBERS', bucketKey]);
      expect(remainingIds).toContain('shared-sym');
    });

    it('should handle large numbers of symbols efficiently', async () => {
      // Setup: Create domain with many symbols
      const symbols = Array.from({ length: 100 }, (_, i) => ({
        id: `sym-${i}`,
        name: `Symbol ${i}`,
        created_at: Date.now()
      }));
      
      const domain = {
        id: 'large-domain',
        name: 'Large Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols,
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:large-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'large-domain']);

      // Create bucket with mix of valid and orphaned
      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      const validIds = symbols.map(s => s.id);
      const orphanIds = Array.from({ length: 50 }, (_, i) => `orphan-${i}`);
      await redisService.request(['SADD', bucketKey, ...validIds, ...orphanIds]);

      const result = await cleanupOrphanedSymbols();

      expect(result.validSymbolsCount).toBe(100);
      expect(result.bucketsScanned).toBe(1);
      expect(result.orphanedEntriesRemoved).toBe(50);

      // Verify only valid symbols remain
      const remainingIds = await redisService.request(['SMEMBERS', bucketKey]);
      expect(remainingIds).toHaveLength(100);
      expect(remainingIds).toEqual(expect.arrayContaining(validIds));
      orphanIds.forEach(orphan => {
        expect(remainingIds).not.toContain(orphan);
      });
    });

    it('should handle disabled domains when includeDisabled is false', async () => {
      // Setup: Create enabled and disabled domains
      const enabledSymbol = { id: 'enabled-sym', name: 'Enabled Symbol', created_at: Date.now() };
      const disabledSymbol = { id: 'disabled-sym', name: 'Disabled Symbol', created_at: Date.now() };
      
      const enabledDomain = {
        id: 'enabled-domain',
        name: 'Enabled Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [enabledSymbol],
        invariants: [],
        readOnly: false
      };
      const disabledDomain = {
        id: 'disabled-domain',
        name: 'Disabled Domain',
        enabled: false,
        lastUpdated: Date.now(),
        symbols: [disabledSymbol],
        invariants: [],
        readOnly: false
      };
      
      await redisService.request(['SET', 'sz:domain:enabled-domain', JSON.stringify(enabledDomain)]);
      await redisService.request(['SET', 'sz:domain:disabled-domain', JSON.stringify(disabledDomain)]);
      await redisService.request(['SADD', 'sz:domains', 'enabled-domain', 'disabled-domain']);

      // Create bucket with both symbols
      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'enabled-sym', 'disabled-sym', 'orphan-1']);

      // Note: cleanupOrphanedSymbols calls getAllSymbols(true) which includes disabled domains
      const result = await cleanupOrphanedSymbols();

      // Both enabled and disabled symbols should be considered valid since includeDisabled=true
      expect(result.validSymbolsCount).toBe(2);
      expect(result.orphanedEntriesRemoved).toBe(1);

      const remainingIds = await redisService.request(['SMEMBERS', bucketKey]);
      expect(remainingIds).toContain('enabled-sym');
      expect(remainingIds).toContain('disabled-sym');
      expect(remainingIds).not.toContain('orphan-1');
    });
  });

  describe('error handling', () => {
    it('should handle redis KEYS command errors', async () => {
      // Mock redisService.request to throw an error on KEYS
      vi.spyOn(redisService, 'request').mockImplementation(async (command: any[]) => {
        if (command[0] === 'KEYS') {
          throw new Error('Redis connection error');
        }
        return __redisTestUtils['handleMockCommand'](command);
      });

      await expect(cleanupOrphanedSymbols()).rejects.toThrow('Redis connection error');
    });

    it('should handle domainService.getAllSymbols errors', async () => {
      vi.spyOn(domainService, 'getAllSymbols').mockRejectedValue(new Error('Domain service error'));

      await expect(cleanupOrphanedSymbols()).rejects.toThrow('Domain service error');
    });

    it('should handle SREM command errors', async () => {
      // Setup valid data
      const validSymbol = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'sym-1', 'orphan-1']);

      // Mock SREM to fail
      let callCount = 0;
      vi.spyOn(redisService, 'request').mockImplementation(async (command: any[]) => {
        callCount++;
        if (command[0] === 'SREM') {
          throw new Error('SREM failed');
        }
        // Use the original mock for other commands
        return redisService.request(command);
      });

      await expect(cleanupOrphanedSymbols()).rejects.toThrow('SREM failed');
    });
  });

  describe('output logging', () => {
    it('should log progress and results correctly', async () => {
      const validSymbol = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'sym-1', 'orphan-1']);

      await cleanupOrphanedSymbols();

      // Verify log messages
      expect(mockConsoleLog).toHaveBeenCalledWith('Cleaning up orphaned symbol entries (including state domain)...');
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Found 1 valid symbols'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Scanning 1 time buckets'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Removing 1 orphaned IDs'));
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Cleanup complete. Total orphaned entries removed: 1'));
    });

    it('should not log removal message when no orphans found', async () => {
      const validSymbol = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'sym-1']); // No orphans

      await cleanupOrphanedSymbols();

      // Should not log removal message
      const removalLogs = mockConsoleLog.mock.calls.filter(call => 
        call[0]?.includes('Removing')
      );
      expect(removalLogs).toHaveLength(0);
      expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining('Cleanup complete. Total orphaned entries removed: 0'));
    });
  });

  describe('edge cases with bucket patterns', () => {
    it('should only process sz:bucket:symbols:* keys', async () => {
      const validSymbol = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      // Create symbol bucket and other buckets
      const symbolBucket = 'sz:bucket:symbols:2024-01-01';
      const otherBucket1 = 'sz:bucket:other:2024-01-01';
      const otherBucket2 = 'sz:other:symbols:2024-01-01';
      
      await redisService.request(['SADD', symbolBucket, 'sym-1', 'orphan-1']);
      await redisService.request(['SADD', otherBucket1, 'should-not-process']);
      await redisService.request(['SADD', otherBucket2, 'should-not-process']);

      const result = await cleanupOrphanedSymbols();

      // Only symbol bucket should be scanned
      expect(result.bucketsScanned).toBe(1);
      
      // Only symbol bucket should be cleaned
      const symbolBucketIds = await redisService.request(['SMEMBERS', symbolBucket]);
      expect(symbolBucketIds).toEqual(['sym-1']);
      
      // Other buckets should remain untouched
      const otherBucket1Ids = await redisService.request(['SMEMBERS', otherBucket1]);
      const otherBucket2Ids = await redisService.request(['SMEMBERS', otherBucket2]);
      expect(otherBucket1Ids).toContain('should-not-process');
      expect(otherBucket2Ids).toContain('should-not-process');
    });

    it('should handle empty bucket IDs gracefully', async () => {
      const validSymbol = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      // Create empty bucket
      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey]); // Add nothing, creates empty set

      const result = await cleanupOrphanedSymbols();

      expect(result.bucketsScanned).toBe(1);
      expect(result.orphanedEntriesRemoved).toBe(0);
    });

    it('should handle buckets with only valid symbols (no orphans)', async () => {
      const validSymbol1 = { id: 'sym-1', name: 'Symbol 1', created_at: Date.now() };
      const validSymbol2 = { id: 'sym-2', name: 'Symbol 2', created_at: Date.now() };
      const domain = {
        id: 'test-domain',
        name: 'Test Domain',
        enabled: true,
        lastUpdated: Date.now(),
        symbols: [validSymbol1, validSymbol2],
        invariants: [],
        readOnly: false
      };
      await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
      await redisService.request(['SADD', 'sz:domains', 'test-domain']);

      const bucketKey = 'sz:bucket:symbols:2024-01-01';
      await redisService.request(['SADD', bucketKey, 'sym-1', 'sym-2']);

      const result = await cleanupOrphanedSymbols();

      expect(result.orphanedEntriesRemoved).toBe(0);
      
      const remainingIds = await redisService.request(['SMEMBERS', bucketKey]);
      expect(remainingIds).toHaveLength(2);
      expect(remainingIds).toContain('sym-1');
      expect(remainingIds).toContain('sym-2');
    });
  });
});
