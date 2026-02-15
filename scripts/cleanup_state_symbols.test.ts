import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { redisService, __redisTestUtils } from '../services/redisService.js';
import { domainService } from '../services/domainService.js';
import { cleanupOrphanedSymbols } from './cleanup_state_symbols.js';

describe('cleanup_state_symbols', () => {
  const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

  beforeEach(async () => {
    __redisTestUtils.resetMock();
    mockConsoleLog.mockClear();
    mockConsoleError.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should clean up orphaned symbol entries', async () => {
    const validSymbol = { id: 'valid-sym-1', name: 'Valid Symbol' };
    const domain = { id: 'test-domain', symbols: [validSymbol] };
    await redisService.request(['SET', 'sz:domain:test-domain', JSON.stringify(domain)]);
    await redisService.request(['SADD', 'sz:domains', 'test-domain']);

    const bucketKey = 'sz:bucket:symbols:2024-01-01';
    await redisService.request(['SADD', bucketKey, 'valid-sym-1', 'orphaned-sym-1']);

    const result = await cleanupOrphanedSymbols();

    expect(result.orphanedEntriesRemoved).toBe(1);
    const remainingIds = await redisService.request(['SMEMBERS', bucketKey]);
    expect(remainingIds).toContain('valid-sym-1');
    expect(remainingIds).not.toContain('orphaned-sym-1');
  });

  it('should handle no symbol buckets found', async () => {
    const result = await cleanupOrphanedSymbols();
    expect(result.bucketsScanned).toBe(0);
  });

  it('should handle symbols across multiple domains', async () => {
    const sym1 = { id: 'sym-1', name: 'S1' };
    const sym2 = { id: 'sym-2', name: 'S2' };
    
    await redisService.request(['SET', 'sz:domain:d1', JSON.stringify({ id: 'd1', symbols: [sym1] })]);
    await redisService.request(['SET', 'sz:domain:d2', JSON.stringify({ id: 'd2', symbols: [sym2] })]);
    await redisService.request(['SADD', 'sz:domains', 'd1', 'd2']);

    const bucketKey = 'sz:bucket:symbols:2024-01-01';
    await redisService.request(['SADD', bucketKey, 'sym-1', 'sym-2', 'orphan-1']);

    const result = await cleanupOrphanedSymbols();
    expect(result.orphanedEntriesRemoved).toBe(1);
    expect(result.validSymbolsCount).toBe(2);
    
    const remaining = await redisService.request(['SMEMBERS', bucketKey]);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain('sym-1');
    expect(remaining).toContain('sym-2');
  });

  it('should handle redis KEYS command errors', async () => {
    const originalRequest = redisService.request;
    vi.spyOn(redisService, 'request').mockImplementation(async (command: any[]) => {
      if (command[0] === 'KEYS') throw new Error('Redis connection error');
      return originalRequest(command);
    });

    await expect(cleanupOrphanedSymbols()).rejects.toThrow('Redis connection error');
  });
});