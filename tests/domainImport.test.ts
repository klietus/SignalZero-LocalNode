
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { domainService } from '../services/domainService.js';
import { redisService } from '../services/redisService.js';
import { vectorService } from '../services/vectorService.js';

vi.mock('../services/redisService.js', () => ({
  redisService: {
    request: vi.fn(),
  },
}));

vi.mock('../services/vectorService.js', () => ({
  vectorService: {
    indexSymbol: vi.fn(),
    indexBatch: vi.fn(),
  },
}));

describe('Domain Import Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a new global domain during updateDomainMetadata if it does not exist and user is admin', async () => {
    const domainId = 'new-global-domain';
    const metadata = { name: 'New Domain', description: 'Imported domain' };
    
    // 1. First GET returns null (domain doesn't exist)
    vi.mocked(redisService.request).mockResolvedValueOnce(null);
    
    // 2. Mock init responses (it does another GET, then SET, then SADD)
    vi.mocked(redisService.request).mockResolvedValueOnce(null); // init's GET
    vi.mocked(redisService.request).mockResolvedValueOnce('OK'); // init's SET
    vi.mocked(redisService.request).mockResolvedValueOnce(1);    // init's SADD

    // 3. Final SET for the update
    vi.mocked(redisService.request).mockResolvedValueOnce('OK');

    const result = await domainService.updateDomainMetadata(domainId, metadata, undefined, true);

    expect(result).not.toBeNull();
    expect(result?.id).toBe(domainId);
    expect(result?.name).toBe(metadata.name);
    
    // Verify init was called (indirectly via SADD to global domains set)
    expect(redisService.request).toHaveBeenCalledWith(['SADD', 'sz:domains', domainId]);
  });

  it('should create a new global domain during addSymbol if it does not exist and user is admin', async () => {
    const domainId = 'imported-domain';
    const symbol = { id: 's1', name: 'Symbol 1', triad: 't', role: 'r', macro: 'm', activation_conditions: [], symbol_domain: domainId, symbol_tag: 'tag', facets: { function: 'f', topology: 't', commit: 'c', temporal: 't', gate: [], substrate: [], invariants: [] }, failure_mode: 'f', linked_patterns: [] };
    
    // 1. First GET returns null (domain doesn't exist)
    vi.mocked(redisService.request).mockResolvedValueOnce(null);
    
    // 2. Mock init responses
    vi.mocked(redisService.request).mockResolvedValueOnce(null); // init's GET
    vi.mocked(redisService.request).mockResolvedValueOnce('OK'); // init's SET
    vi.mocked(redisService.request).mockResolvedValueOnce(1);    // init's SADD

    // 3. Final SET for the addSymbol
    vi.mocked(redisService.request).mockResolvedValueOnce('OK');

    const result = await domainService.addSymbol(domainId, symbol as any, undefined, true);

    expect(result).not.toBeNull();
    expect(result.id).toBe('s1');
    
    // Verify domain was initialized
    expect(redisService.request).toHaveBeenCalledWith(['SADD', 'sz:domains', domainId]);
  });
});
