
import { SymbolDef, VectorSearchResult } from '../types.ts';
import { vectorService } from './vectorService.ts';
import { redisService } from './redisService.ts';
import { currentTimestampBase64, decodeTimestamp, getBucketKeysFromTimestamps, getDayBucketKey } from './timeService.ts';

// Redis Keys Configuration
const KEYS = {
  DOMAINS_SET: 'sz:domains',
  DOMAIN_PREFIX: 'sz:domain:', // e.g., sz:domain:root
};

export interface CachedDomain {
  id: string;   // Immutable Key
  name: string; // Display Name
  enabled: boolean;
  lastUpdated: number;
  symbols: SymbolDef[];
  description?: string;
  invariants?: string[];
}

const indexSymbolBucket = async (symbol: SymbolDef) => {
  const createdMs = decodeTimestamp(symbol.created_at);
  if (createdMs === null) return;
  await redisService.request(['SADD', getDayBucketKey('symbols', createdMs), symbol.id]);
};

type MetadataFilter = Record<string, any>;

const toArray = (value: any): any[] => {
  if (Array.isArray(value)) return value.filter((v) => v !== undefined && v !== null);
  return value === undefined || value === null ? [] : [value];
};

const mergeInFilter = (target: MetadataFilter, key: string, value: any) => {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
      const existing = target[key];
      const nextValues = value.filter((v) => v !== undefined && v !== null);
      if (nextValues.length === 0) return;

      if (existing && typeof existing === 'object' && !Array.isArray(existing) && '$in' in existing) {
          const merged = Array.from(new Set([...(existing.$in as any[]), ...nextValues]));
          target[key] = { $in: merged };
          return;
      }

      target[key] = nextValues.length === 1 ? nextValues[0] : { $in: nextValues };
      return;
  }

  target[key] = value;
};

const normalizeMetadataFilter = (rawFilter?: MetadataFilter, domains?: string[]): MetadataFilter | undefined => {
  const filter: MetadataFilter = {};

  if (rawFilter) {
      Object.entries(rawFilter).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
              if (Array.isArray(value)) {
                  mergeInFilter(filter, key, value);
              } else {
                  filter[key] = value;
              }
          }
      });
  }

  if (domains && domains.length > 0) {
      mergeInFilter(filter, 'symbol_domain', domains);
      mergeInFilter(filter, 'domain', domains);
  }

  const keys = Object.keys(filter);
  return keys.length > 0 ? filter : undefined;
};

const valueMatches = (actual: any, expected: any): boolean => {
  if (expected === undefined) return true;
  if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$in' in expected) {
      const candidates = toArray((expected as any).$in);
      if (candidates.length === 0) return true;
      return candidates.some((candidate) => valueMatches(actual, candidate));
  }

  if (Array.isArray(expected)) {
      return expected.some((candidate) => valueMatches(actual, candidate));
  }

  if (Array.isArray(actual)) {
      return actual.includes(expected);
  }

  return actual === expected;
};

const matchesMetadataFilter = (symbol: SymbolDef, filter?: MetadataFilter): boolean => {
  if (!filter || Object.keys(filter).length === 0) return true;

  return Object.entries(filter).every(([key, expected]) => valueMatches((symbol as any)[key], expected));
};

// --- Public API ---

export const domainService = {
  
  /**
   * Health Check
   */
  healthCheck: async (): Promise<boolean> => {
      return await redisService.healthCheck();
  },

  /**
   * Create a brand-new domain with optional metadata.
   */
  createDomain: async (
    domainId: string,
    metadata: { name?: string; description?: string; invariants?: string[] } = {}
  ): Promise<CachedDomain> => {
    const exists = await domainService.hasDomain(domainId);
    if (exists) {
        throw new Error(`Domain '${domainId}' already exists.`);
    }

    const now = Date.now();
    const newDomain: CachedDomain = {
        id: domainId,
        name: metadata.name || domainId,
        description: metadata.description || "",
        invariants: metadata.invariants || [],
        enabled: true,
        lastUpdated: now,
        symbols: []
    };

    const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
    await redisService.request(['SET', key, JSON.stringify(newDomain)]);
    await redisService.request(['SADD', KEYS.DOMAINS_SET, domainId]);

    return newDomain;
  },

  /**
   * Returns a list of all domain IDs currently in Redis.
   */
  listDomains: async (): Promise<string[]> => {
    const result = await redisService.request(['SMEMBERS', KEYS.DOMAINS_SET]);
    return Array.isArray(result) ? result.sort() : [];
  },

  /**
   * Checks if a domain exists.
   */
  hasDomain: async (domainId: string): Promise<boolean> => {
    const exists = await redisService.request(['EXISTS', `${KEYS.DOMAIN_PREFIX}${domainId}`]);
    return exists === 1;
  },

  /**
   * Retrieves the full cached domain record, including symbols.
   */
  getDomain: async (domainId: string): Promise<CachedDomain | null> => {
    const data = await redisService.request(['GET', `${KEYS.DOMAIN_PREFIX}${domainId}`]);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch (e) {
      console.error(`[DomainService] Failed to parse domain ${domainId}`, e);
      return null;
    }
  },

  /**
   * Checks if a domain is enabled.
   */
  isEnabled: async (domainId: string): Promise<boolean> => {
    const data = await redisService.request(['GET', `${KEYS.DOMAIN_PREFIX}${domainId}`]);
    if (!data) return false;
    try {
      const domain: CachedDomain = JSON.parse(data);
      return domain.enabled;
    } catch {
      return false;
    }
  },

  /**
   * Toggles the enabled state of a domain.
   */
  toggleDomain: async (domainId: string, enabled: boolean) => {
    const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
    const data = await redisService.request(['GET', key]);
    if (data) {
      const domain: CachedDomain = JSON.parse(data);
      domain.enabled = enabled;
      await redisService.request(['SET', key, JSON.stringify(domain)]);
    }
  },

  /**
   * Updates domain metadata without touching symbols.
   */
  updateDomainMetadata: async (domainId: string, metadata: { name?: string, description?: string, invariants?: string[] }) => {
    const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
    const data = await redisService.request(['GET', key]);
    if (data) {
      const domain: CachedDomain = JSON.parse(data);
      if (metadata.name) domain.name = metadata.name;
      if (metadata.description !== undefined) domain.description = metadata.description;
      if (metadata.invariants !== undefined) domain.invariants = metadata.invariants;
      domain.lastUpdated = Date.now();
      await redisService.request(['SET', key, JSON.stringify(domain)]);
    }
  },

  /**
   * Removes a domain and all its symbols from Redis.
   */
  deleteDomain: async (domainId: string) => {
    const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
    const data = await redisService.request(['GET', key]);
    
    if (data) {
      const domain: CachedDomain = JSON.parse(data);
      // Clean up vector store
      for (const s of domain.symbols) {
          await vectorService.deleteSymbol(s.id);
      }
    }

    // Remove from SET and DEL key
    await redisService.request(['SREM', KEYS.DOMAINS_SET, domainId]);
    await redisService.request(['DEL', key]);
  },

  /**
   * Clears ALL domains. Used when switching projects.
   */
  clearAll: async () => {
      await vectorService.resetCollection();
      const domains = await domainService.listDomains();
      for (const d of domains) {
          await redisService.request(['DEL', `${KEYS.DOMAIN_PREFIX}${d}`]);
      }
      await redisService.request(['DEL', KEYS.DOMAINS_SET]);
  },

  /**
   * Search for symbols using the vector index and hydrate them with Redis definitions.
   */
  search: async (
      query: string | null,
      limit: number = 5,
      filters?: { time_gte?: string; time_between?: string[]; metadata_filter?: MetadataFilter; domains?: string[] }
  ): Promise<(VectorSearchResult & { symbol: SymbolDef | null })[]> => {
      const hasQuery = !!(query && query.trim().length > 0);
      const hasTimeFilter = !!(filters?.time_gte || (filters?.time_between && filters.time_between.length > 0));
      if (!hasQuery && !hasTimeFilter) {
          throw new Error('Provide a query or time filter (time_gte or time_between) to search symbols.');
      }

      const metadataFilter = normalizeMetadataFilter(filters?.metadata_filter, filters?.domains);

      const { keys: bucketKeys, rangeApplied } = getBucketKeysFromTimestamps('symbols', filters?.time_gte, filters?.time_between);
      const bucketIds = new Set<string>();

      if (bucketKeys.length > 0) {
          const bucketResults = await Promise.all(bucketKeys.map((key) => redisService.request(['SMEMBERS', key])));
          bucketResults.forEach((ids) => {
              if (Array.isArray(ids)) {
                  ids.forEach((id) => bucketIds.add(String(id)));
              }
          });
      }

      const shouldSkipSemantic = !query || query.trim().length === 0;
      const results = shouldSkipSemantic ? [] : await vectorService.search(query, limit, metadataFilter);
      const domains = await domainService.listDomains();
      
      // Load all domains to hydrate (inefficient but safe for "local node")
      // Optimization: Pipeline GETs? Upstash supports pipeline via REST? 
      // For now, simple Promise.all
      const domainData = await Promise.all(domains.map(d => redisService.request(['GET', `${KEYS.DOMAIN_PREFIX}${d}`])));
      const store: Record<string, CachedDomain> = {};
      
      domainData.forEach((d, i) => {
          if (d) {
              try {
                  store[domains[i]] = JSON.parse(d);
              } catch {}
          }
      });

      const hydratedResults = results
        .filter(r => bucketIds.size === 0 || bucketIds.has(r.id))
        .map(r => {
          let symbol: SymbolDef | null = null;
          for (const domainId of Object.keys(store)) {
            if (store[domainId].enabled) {
                const found = store[domainId].symbols.find(s => s.id === r.id);
                if (found && matchesMetadataFilter(found, metadataFilter)) {
                    symbol = found;
                    break;
                }
            }
          }
          return {
              ...r,
              metadata: { ...(r.metadata || {}), bucket_keys: bucketKeys },
              symbol
          };
      });

      if (hydratedResults.length === 0 && rangeApplied && bucketIds.size > 0) {
          const bucketSymbols = Object.values(store)
              .filter((d) => d.enabled)
              .flatMap((d) => d.symbols)
              .filter((s) => bucketIds.has(s.id))
              .filter((s) => matchesMetadataFilter(s, metadataFilter));

          return bucketSymbols.map((symbol) => ({
              id: symbol.id,
              score: 1,
              metadata: { source: 'time_bucket', bucket_keys: bucketKeys },
              document: '',
              symbol
          }));
      }

      return hydratedResults;
  },

  /**
   * Removes a specific symbol from a domain.
   */
  deleteSymbol: async (domainId: string, symbolId: string, cascade: boolean = true) => {
    const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
    const data = await redisService.request(['GET', key]);
    if (!data) return;

    const domain: CachedDomain = JSON.parse(data);
    
    // 1. Remove symbol
    domain.symbols = domain.symbols.filter(s => s.id !== symbolId);
    
    // Cleanup Vector
    await vectorService.deleteSymbol(symbolId);

    // 2. Cascade
    if (cascade) {
        domain.symbols.forEach(s => {
            if (s.linked_patterns?.includes(symbolId)) {
                s.linked_patterns = s.linked_patterns.filter(id => id !== symbolId);
            }
            if (s.kind === 'lattice' && s.lattice?.members?.includes(symbolId)) {
                s.lattice.members = s.lattice.members.filter(id => id !== symbolId);
            }
            if (s.kind === 'persona' && s.persona?.linked_personas?.includes(symbolId)) {
                s.persona.linked_personas = s.persona.linked_personas.filter(id => id !== symbolId);
            }
        });
    }

    domain.lastUpdated = Date.now();
    await redisService.request(['SET', key, JSON.stringify(domain)]);
  },

  /**
   * Unified symbol finder that combines structured filters with semantic search.
   */
  findSymbols: async (params: {
      query?: string | null;
      limit?: number;
      symbol_domain?: string;
      symbol_domains?: string[];
      symbol_tag?: string;
      last_symbol_id?: string;
      fetch_all?: boolean;
      metadata_filter?: MetadataFilter;
      time_gte?: string;
      time_between?: string[];
  }) => {
      const {
          query,
          symbol_domain,
          symbol_domains,
          symbol_tag,
          last_symbol_id,
          fetch_all,
          metadata_filter,
          time_gte,
          time_between,
      } = params;

      const domainsInput = symbol_domains ?? symbol_domain ?? metadata_filter?.symbol_domain ?? 'root';
      const domains = Array.isArray(domainsInput) ? domainsInput.filter(Boolean) : [domainsInput];
      const uniqueDomains = Array.from(new Set(domains.length > 0 ? domains : ['root']));

      const availability = await Promise.all(uniqueDomains.map((d) => domainService.hasDomain(d)));
      const availableDomains = uniqueDomains.filter((_, i) => availability[i]);
      const missingDomains = uniqueDomains.filter((_, i) => !availability[i]);

      if (availableDomains.length === 0) {
           return { count: 0, symbols: [], status: `Domains not found in registry: ${uniqueDomains.join(', ')}` };
      }

      const mergedMetadataFilter: MetadataFilter = { ...(metadata_filter || {}) };
      if (symbol_tag && mergedMetadataFilter.symbol_tag === undefined) {
          mergedMetadataFilter.symbol_tag = symbol_tag;
      }
      if (mergedMetadataFilter.symbol_domain === undefined) {
          mergedMetadataFilter.symbol_domain = availableDomains;
      }

      const normalizedMetadataFilter = normalizeMetadataFilter(mergedMetadataFilter);
      const normalizedLimit = Math.min(params.limit ?? 20, 50);

      const structuredSymbols: SymbolDef[] = [];
      const pageInfoEntries: any[] = [];

      for (const domainId of availableDomains) {
          const symbols = await domainService.getSymbols(domainId);
          const filtered = symbols.filter((s) => matchesMetadataFilter(s, normalizedMetadataFilter));

          if (fetch_all) {
              structuredSymbols.push(...filtered);
              continue;
          }

          let startIndex = 0;
          if (last_symbol_id) {
              const foundIndex = filtered.findIndex((s) => s.id === last_symbol_id);
              if (foundIndex !== -1) startIndex = foundIndex + 1;
          }

          const paged = filtered.slice(startIndex, startIndex + normalizedLimit);
          structuredSymbols.push(...paged);
          pageInfoEntries.push({
              domain: domainId,
              limit: normalizedLimit,
              last_id: paged.length > 0 ? paged[paged.length - 1].id : null,
          });
      }

      const shouldSearchVector = !!(query && query.trim().length > 0) || !!time_gte || !!(time_between && time_between.length > 0);
      const semanticResults = shouldSearchVector
          ? await domainService.search(query || null, normalizedLimit, {
                time_gte,
                time_between,
                metadata_filter: mergedMetadataFilter,
                domains: availableDomains,
            })
          : [];

      const combined = new Map<string, SymbolDef>();
      semanticResults.forEach((r) => {
          if (r.symbol) combined.set(r.symbol.id, r.symbol);
      });
      structuredSymbols.forEach((s) => {
          if (!combined.has(s.id)) combined.set(s.id, s);
      });

      return {
          count: combined.size,
          symbols: Array.from(combined.values()),
          semantic_results: semanticResults,
          structured_count: structuredSymbols.length,
          structured_page_info: pageInfoEntries.length === 1 ? pageInfoEntries[0] : pageInfoEntries,
          missing_domains: missingDomains.length > 0 ? missingDomains : undefined,
          filters: {
              query: query ?? null,
              symbol_domains: availableDomains,
              symbol_tag,
              metadata_filter: mergedMetadataFilter,
              time_gte,
              time_between,
          },
      };
  },

  /**
   * Updates references during rename.
   */
  propagateRename: async (domainId: string, oldId: string, newId: string) => {
      const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
      const data = await redisService.request(['GET', key]);
      if (!data) return;

      const domain: CachedDomain = JSON.parse(data);
      let updatedCount = 0;

      domain.symbols.forEach(s => {
          let modified = false;
          if (s.linked_patterns?.includes(oldId)) {
              s.linked_patterns = s.linked_patterns.map(id => id === oldId ? newId : id);
              modified = true;
          }
          if (s.kind === 'lattice' && s.lattice?.members?.includes(oldId)) {
              s.lattice.members = s.lattice.members.map(id => id === oldId ? newId : id);
              modified = true;
          }
          if (s.kind === 'persona' && s.persona?.linked_personas?.includes(oldId)) {
              s.persona.linked_personas = s.persona.linked_personas.map(id => id === oldId ? newId : id);
              modified = true;
          }
          if (modified) updatedCount++;
      });

      if (updatedCount > 0) {
          domain.lastUpdated = Date.now();
          await redisService.request(['SET', key, JSON.stringify(domain)]);
      }
  },

  /**
   * Retrieves all symbols for a domain.
   */
  getSymbols: async (domainId: string): Promise<SymbolDef[]> => {
    const data = await redisService.request(['GET', `${KEYS.DOMAIN_PREFIX}${domainId}`]);
    if (!data) return [];
    try {
        const domain: CachedDomain = JSON.parse(data);
        return domain.symbols || [];
    } catch {
        return [];
    }
  },

  /**
   * Saves or updates a symbol.
   */
  upsertSymbol: async (domainId: string, symbol: SymbolDef) => {
    const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
    const data = await redisService.request(['GET', key]);
    
    let domain: CachedDomain;

    if (!data) {
        // Create new
        domain = {
            id: domainId,
            name: domainId,
            enabled: true,
            lastUpdated: Date.now(),
            symbols: [],
            description: "",
            invariants: []
        };
        // Add to Set
        await redisService.request(['SADD', KEYS.DOMAINS_SET, domainId]);
    } else {
        domain = JSON.parse(data);
        if (!domain.id) domain.id = domainId; // migration safety
    }

    const nowB64 = currentTimestampBase64();
    const existingIndex = domain.symbols.findIndex(s => s.id === symbol.id);
    const normalizedSymbol: SymbolDef = {
        ...symbol,
        created_at: existingIndex >= 0 ? domain.symbols[existingIndex].created_at : nowB64,
        updated_at: nowB64,
    };

    if (existingIndex >= 0) {
        domain.symbols[existingIndex] = normalizedSymbol;
    } else {
        domain.symbols.push(normalizedSymbol);
    }

    domain.lastUpdated = Date.now();
    
    // Save Domain
    await redisService.request(['SET', key, JSON.stringify(domain)]);

    // Time bucket index (based on creation time)
    await indexSymbolBucket(normalizedSymbol);
    
    // Index Vector
    await vectorService.indexSymbol(symbol);
  },

  /**
   * Bulk upsert.
   */
  bulkUpsert: async (domainId: string, symbols: SymbolDef[]) => {
      const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
      const data = await redisService.request(['GET', key]);
      
      let domain: CachedDomain;
      if (!data) {
          domain = {
              id: domainId,
              name: domainId,
              enabled: true,
              lastUpdated: Date.now(),
              symbols: [],
              description: "",
              invariants: []
          };
          await redisService.request(['SADD', KEYS.DOMAINS_SET, domainId]);
      } else {
          domain = JSON.parse(data);
      }

      const symbolMap = new Map(domain.symbols.map(s => [s.id, s]));
      const nowB64 = currentTimestampBase64();
      for (const sym of symbols) {
          const existing = symbolMap.get(sym.id);
          const normalized: SymbolDef = {
              ...sym,
              created_at: existing?.created_at || nowB64,
              updated_at: nowB64,
          };
          symbolMap.set(sym.id, normalized);
          await indexSymbolBucket(normalized);
      }
      domain.symbols = Array.from(symbolMap.values());
      domain.lastUpdated = Date.now();

      await redisService.request(['SET', key, JSON.stringify(domain)]);
      await vectorService.indexBatch(symbols);
  },

  /**
   * Process refactor operations.
   */
  processRefactorOperation: async (updates: { old_id: string, symbol_data: SymbolDef }[]) => {
      const updatesByDomain: Record<string, typeof updates> = {};
      updates.forEach(u => {
          const dom = u.symbol_data.symbol_domain || 'root';
          if (!updatesByDomain[dom]) updatesByDomain[dom] = [];
          updatesByDomain[dom].push(u);
      });

      const renamedIds: string[] = [];
      let updateCount = 0;

      for (const [domainId, domainUpdates] of Object.entries(updatesByDomain)) {
          const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
          const data = await redisService.request(['GET', key]);
          
          let domain: CachedDomain;
          if (!data) {
             domain = { id: domainId, name: domainId, enabled: true, lastUpdated: Date.now(), symbols: [] };
             await redisService.request(['SADD', KEYS.DOMAINS_SET, domainId]);
          } else {
             domain = JSON.parse(data);
          }

          const existingCreatedAt = new Map<string, string>();
          domain.symbols.forEach((s) => {
              if (s.created_at) existingCreatedAt.set(s.id, s.created_at);
          });

          // 1. Renames
          domainUpdates.forEach(update => {
              if (update.old_id !== update.symbol_data.id) {
                  domain.symbols.forEach(s => {
                      if (s.id === update.old_id) return;
                      if (s.linked_patterns?.includes(update.old_id)) {
                          s.linked_patterns = s.linked_patterns.map(id => id === update.old_id ? update.symbol_data.id : id);
                      }
                      if (s.kind === 'lattice' && s.lattice?.members?.includes(update.old_id)) {
                          s.lattice.members = s.lattice.members.map(id => id === update.old_id ? update.symbol_data.id : id);
                      }
                      if (s.kind === 'persona' && s.persona?.linked_personas?.includes(update.old_id)) {
                          s.persona.linked_personas = s.persona.linked_personas.map(id => id === update.old_id ? update.symbol_data.id : id);
                      }
                  });
                  renamedIds.push(`${update.old_id} -> ${update.symbol_data.id}`);
                  vectorService.deleteSymbol(update.old_id);
              }
          });

          // 2. Remove Old
          const oldIdsToRemove = domainUpdates.map(u => u.old_id);
          domain.symbols = domain.symbols.filter(s => !oldIdsToRemove.includes(s.id));

          // 3. Add New
          domainUpdates.forEach(update => {
              const nowB64 = currentTimestampBase64();
              const normalized: SymbolDef = {
                  ...update.symbol_data,
                  created_at: existingCreatedAt.get(update.old_id) || nowB64,
                  updated_at: nowB64,
              };
              domain.symbols.push(normalized);
              updateCount++;
              vectorService.indexSymbol(normalized);
              indexSymbolBucket(normalized);
          });

          domain.lastUpdated = Date.now();
          await redisService.request(['SET', key, JSON.stringify(domain)]);
      }

      return { count: updateCount, renamedIds };
  },

  /**
   * Compress symbols.
   */
  compressSymbols: async (newSymbol: SymbolDef, oldIds: string[]) => {
      const domainId = newSymbol.symbol_domain || 'root';
      await domainService.upsertSymbol(domainId, newSymbol);
      
      for (const oldId of oldIds) {
          if (oldId === newSymbol.id) continue;
          await domainService.propagateRename(domainId, oldId, newSymbol.id);
          await domainService.deleteSymbol(domainId, oldId, false);
      }
      return { newId: newSymbol.id, removedIds: oldIds };
  },

  /**
   * Perform query (paginated from array).
   */
  query: async (domainId: string, tag?: string, limit: number = 20, lastId?: string) => {
    const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
    const data = await redisService.request(['GET', key]);
    if (!data) return null;

    const domain: CachedDomain = JSON.parse(data);
    if (!domain.enabled) return null;

    let results = domain.symbols;
    if (tag) {
        results = results.filter(s => s.symbol_tag?.includes(tag));
    }

    let startIndex = 0;
    if (lastId) {
        const foundIndex = results.findIndex(s => s.id === lastId);
        if (foundIndex !== -1) startIndex = foundIndex + 1;
    }

    const pagedResults = results.slice(startIndex, startIndex + limit);
    return {
        items: pagedResults,
        total: results.length,
        source: 'redis_cache'
    };
  },

  /**
   * Find by ID across all domains.
   */
  findById: async (id: string): Promise<SymbolDef | null> => {
    const domains = await domainService.listDomains();
    // Inefficient but functional for low-scale "Local Node"
    // Fetch all domains (parallel)
    const rawData = await Promise.all(domains.map(d => redisService.request(['GET', `${KEYS.DOMAIN_PREFIX}${d}`])));
    
    for (const data of rawData) {
        if (!data) continue;
        const domain: CachedDomain = JSON.parse(data);
        if (domain.enabled) {
            const found = domain.symbols.find(s => s.id === id);
            if (found) return found;
        }
    }
    return null;
  },

  /**
   * Get metadata for store screen.
   */
  getMetadata: async () => {
    const domains = await domainService.listDomains();
    const rawData = await Promise.all(domains.map(d => redisService.request(['GET', `${KEYS.DOMAIN_PREFIX}${d}`])));
    
    return rawData
      .map((data, i) => {
          if (!data) return null;
          const d: CachedDomain = JSON.parse(data);
          return {
              id: domains[i],
              name: d.name || domains[i],
              enabled: d.enabled,
              count: d.symbols.length,
              lastUpdated: d.lastUpdated,
              description: d.description || "",
              invariants: d.invariants || []
          };
      })
      .filter((d): d is any => d !== null);
  },

  /**
   * Retrieve all symbols across domains.
   * By default, returns only enabled domain symbols.
   */
  getAllSymbols: async (includeDisabled: boolean = false): Promise<SymbolDef[]> => {
      const domains = await domainService.listDomains();
      const rawData = await Promise.all(domains.map(d => redisService.request(['GET', `${KEYS.DOMAIN_PREFIX}${d}`])));

      const allSymbols: SymbolDef[] = [];

      rawData.forEach((data) => {
          if (!data) return;
          try {
              const domain: CachedDomain = JSON.parse(data);
              if (includeDisabled || domain.enabled) {
                  allSymbols.push(...(domain.symbols || []));
              }
          } catch (e) {
              console.error('[DomainService] Failed to parse domain while collecting symbols', e);
          }
      });

      return allSymbols;
  }
};
