
import { SymbolDef, VectorSearchResult } from '../types.ts';
import { vectorService } from './vectorService.ts';
import { redisService } from './redisService.ts';
import { currentTimestamp, decodeTimestamp, getBucketKeysFromTimestamps, getDayBucketKey } from './timeService.ts';

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
  readOnly: boolean;
}

export class ReadOnlyDomainError extends Error {
  domainId: string;
  symbolId?: string;

  constructor(domainId: string, symbolId?: string) {
    super(`Domain '${domainId}' is read-only; cannot modify symbol '${symbolId || 'unknown'}'.`);
    this.domainId = domainId;
    this.symbolId = symbolId;
    this.name = 'ReadOnlyDomainError';
  }
}

const parseDomain = (data: string, domainId: string): CachedDomain => {
  const domain: CachedDomain = JSON.parse(data);
  if (domain.readOnly === undefined) domain.readOnly = false;
  if (!domain.id) domain.id = domainId;
  if (!domain.symbols) domain.symbols = [];
  if (!domain.invariants) domain.invariants = [];
  if (domain.description === undefined) domain.description = "";
  return domain;
};

const ensureWritableDomain = (domain: CachedDomain, domainId: string, symbolId?: string) => {
  if (domain.readOnly) {
      throw new ReadOnlyDomainError(domainId, symbolId);
  }
};

export const migrateSymbols = async (domain: CachedDomain): Promise<boolean> => {
    let modified = false;
    const validKinds = ['pattern', 'persona', 'lattice', 'data'];

    for (const symbol of domain.symbols) {
        // Validation: Default invalid or missing kind to pattern
        if (!symbol.kind || !validKinds.includes(symbol.kind)) {
            symbol.kind = 'pattern';
            modified = true;
        }

        // Migrate linked_patterns from string[] to SymbolLink[]
        if (Array.isArray(symbol.linked_patterns)) {
            const needsMigration = symbol.linked_patterns.some(link => typeof link === 'string');
            if (needsMigration) {
                symbol.linked_patterns = symbol.linked_patterns.map((link: any) => {
                    if (typeof link === 'string') {
                        return { id: link, link_type: 'relates_to', bidirectional: false };
                    }
                    return link;
                });
                modified = true;
            }
        } else {
            symbol.linked_patterns = [];
            modified = true;
        }

        if (symbol.kind === 'lattice' && symbol.lattice && (symbol.lattice as any).members) {
            const members = (symbol.lattice as any).members as string[];
            const existingIds = new Set(symbol.linked_patterns.map(l => l.id));
            
            members.forEach(id => {
                if (!existingIds.has(id)) {
                    symbol.linked_patterns.push({ id, link_type: 'relates_to', bidirectional: false });
                }
            });

            delete (symbol.lattice as any).members;
            modified = true;
            // Reindex in vector store to reflect schema change
            await vectorService.indexSymbol(symbol);
        }
    }
    return modified;
};

const indexSymbolBucket = async (symbol: SymbolDef) => {
  const createdMs = decodeTimestamp(symbol.created_at);
  if (createdMs === null) return;
  await redisService.request(['SADD', getDayBucketKey('symbols', createdMs), symbol.id]);
};

const matchesValue = (symbolValue: unknown, filterValue: unknown): boolean => {
  const filterValues = Array.isArray(filterValue) ? filterValue : [filterValue];

  return filterValues.some((fv) => {
      const fvStr = String(fv).trim();
      if (Array.isArray(symbolValue)) {
          return symbolValue.map(s => String(s).trim()).includes(fvStr);
      }
      
      if (typeof symbolValue === 'string') {
          // Handle comma-separated tag strings or similar
          const parts = symbolValue.split(',').map(s => s.trim());
          if (parts.includes(fvStr)) return true;
      }

      const normalizedSymbolValue = typeof symbolValue === 'string' ? symbolValue.trim() : String(symbolValue).trim();
      return symbolValue !== undefined && symbolValue !== null && normalizedSymbolValue === fvStr;
  });
};

const matchesMetadataFilter = (symbol: SymbolDef, metadataFilter?: Record<string, unknown>): boolean => {
  if (!metadataFilter || Object.keys(metadataFilter).length === 0) return true;

  return Object.entries(metadataFilter).every(([key, value]) => {
      if (value === undefined || value === null) return true;
      const symbolValue = (symbol as Record<string, unknown>)[key];
      if (symbolValue === undefined || symbolValue === null) return false;
      return matchesValue(symbolValue, value);
  });
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
    metadata: { name?: string; description?: string; invariants?: string[]; readOnly?: boolean } = {}
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
        readOnly: metadata.readOnly === true,
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
      const domain = parseDomain(data, domainId);
      const modified = await migrateSymbols(domain);
      if (modified) {
          domain.lastUpdated = Date.now();
          await redisService.request(['SET', `${KEYS.DOMAIN_PREFIX}${domainId}`, JSON.stringify(domain)]);
      }
      return domain;
    } catch (e) {
      console.error(`[DomainService] Failed to parse domain ${domainId}`, e);
      return null;
    }
  },

  /**
   * Checks if a domain is enabled.
   */
  isEnabled: async (domainId: string): Promise<boolean> => {
    const domain = await domainService.getDomain(domainId);
    return domain ? domain.enabled : false;
  },

  /**
   * Toggles the enabled state of a domain.
   */
  toggleDomain: async (domainId: string, enabled: boolean) => {
    const domain = await domainService.getDomain(domainId);
    if (domain) {
      domain.enabled = enabled;
      domain.lastUpdated = Date.now();
      await redisService.request(['SET', `${KEYS.DOMAIN_PREFIX}${domainId}`, JSON.stringify(domain)]);
    }
  },

  /**
   * Updates domain metadata without touching symbols.
   */
  updateDomainMetadata: async (domainId: string, metadata: { name?: string, description?: string, invariants?: string[], readOnly?: boolean }) => {
    const domain = await domainService.getDomain(domainId);
    if (domain) {
      if (metadata.name) domain.name = metadata.name;
      if (metadata.description !== undefined) domain.description = metadata.description;
      if (metadata.invariants) domain.invariants = metadata.invariants;
      if (metadata.readOnly !== undefined) domain.readOnly = metadata.readOnly;
      domain.lastUpdated = Date.now();
      await redisService.request(['SET', `${KEYS.DOMAIN_PREFIX}${domainId}`, JSON.stringify(domain)]);
    }
  },

  /**
   * Removes a domain and all its symbols from Redis.
   */
  deleteDomain: async (domainId: string) => {
    const domain = await domainService.getDomain(domainId);
    if (domain) {
      // Clean up vector store
      for (const s of domain.symbols) {
          await vectorService.deleteSymbol(s.id);
      }
    }

    // Remove from SET and DEL key
    await redisService.request(['DEL', `${KEYS.DOMAIN_PREFIX}${domainId}`]);
    await redisService.request(['SREM', KEYS.DOMAINS_SET, domainId]);
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
      filters?: { time_gte?: string; time_between?: string[]; metadata_filter?: Record<string, unknown>; domains?: string[] }
  ): Promise<(VectorSearchResult & { symbol: SymbolDef | null })[]> => {
      const hasQuery = !!(query && query.trim().length > 0);
      const hasTimeFilter = !!(filters?.time_gte || (filters?.time_between && filters.time_between.length > 0));
      const hasMetadataFilter = !!(filters?.metadata_filter && Object.keys(filters.metadata_filter).length > 0);
      if (!hasQuery && !hasTimeFilter && !hasMetadataFilter) {
          throw new Error('Provide a query, metadata_filter, or time filter (time_gte or time_between) to search symbols.');
      }

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

      const shouldSkipSemantic = !hasQuery;
      const domains = filters?.domains && filters.domains.length > 0
          ? filters.domains
          : await domainService.listDomains();

      // Load all domains to hydrate (inefficient but safe for "local node")
      // Optimization: Pipeline GETs? Upstash supports pipeline via REST?
      // For now, simple Promise.all
      const domainData = await Promise.all(domains.map(d => redisService.request(['GET', `${KEYS.DOMAIN_PREFIX}${d}`])));
      const store: Record<string, CachedDomain> = {};
      
      domainData.forEach((d, i) => {
          if (d) {
              try {
                  store[domains[i]] = parseDomain(d, domains[i]);
              } catch {}
          }
      });

      const prefilteredSymbols = Object.values(store)
          .filter((d) => d.enabled)
          .flatMap((d) => d.symbols)
          .filter((s) => matchesMetadataFilter(s, filters?.metadata_filter));

      // Build a filter for the vector store that includes domain restrictions
      const vectorMetadataFilter: Record<string, unknown> = { ...(filters?.metadata_filter || {}) };
      if (domains && domains.length > 0) {
          vectorMetadataFilter.symbol_domain = domains.length === 1 ? domains[0] : domains;
      }

      const results = shouldSkipSemantic ? [] : await vectorService.search(query!, limit, vectorMetadataFilter);

      const hydratedResults = results
        .filter(r => bucketIds.size === 0 || bucketIds.has(r.id))
        .map(r => {
          let symbol: SymbolDef | null = null;
          for (const domainId of Object.keys(store)) {
            if (store[domainId].enabled) {
                const found = store[domainId].symbols.find(s => s.id === r.id);
                if (found) {
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
      })
      .filter((entry) => entry.symbol ? matchesMetadataFilter(entry.symbol, filters?.metadata_filter) : false);

      if (!hasQuery) {
          return prefilteredSymbols
              .filter((s) => bucketIds.size === 0 || bucketIds.has(s.id))
              .sort((a, b) => {
                  const getT = (s?: string) => s ? decodeTimestamp(s) || 0 : 0;
                  const timeA = getT(a.last_accessed_at) || getT(a.updated_at) || getT(a.created_at);
                  const timeB = getT(b.last_accessed_at) || getT(b.updated_at) || getT(b.created_at);
                  return timeB - timeA;
              })
              .slice(0, limit)
              .map((symbol) => ({
                  id: symbol.id,
                  score: 1,
                  metadata: { source: 'structured_filter', bucket_keys: bucketKeys },
                  document: '',
                  symbol
              }));
      }

      if (hydratedResults.length === 0 && rangeApplied && bucketIds.size > 0) {
          const bucketSymbols = prefilteredSymbols
              .filter((s) => bucketIds.has(s.id))
              .sort((a, b) => {
                  const getT = (s?: string) => s ? decodeTimestamp(s) || 0 : 0;
                  const timeA = getT(a.last_accessed_at) || getT(a.updated_at) || getT(a.created_at);
                  const timeB = getT(b.last_accessed_at) || getT(b.updated_at) || getT(b.created_at);
                  return timeB - timeA;
              });

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
    await domainService.deleteSymbols(domainId, [symbolId], cascade);
  },

  /**
   * Removes one or more symbols from a domain.
   */
  deleteSymbols: async (domainId: string, symbolIds: string[], cascade: boolean = true) => {
    if (symbolIds.length === 0) return;

    const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
    const data = await redisService.request(['GET', key]);
    if (!data) return;

    const domain = parseDomain(data, domainId);
    const idsToDelete = new Set(symbolIds);

    domain.symbols = domain.symbols.filter(s => !idsToDelete.has(s.id));

    for (const symbolId of idsToDelete) {
        await vectorService.deleteSymbol(symbolId);
    }

    if (cascade) {
        domain.symbols.forEach(s => {
            if (s.linked_patterns) {
                s.linked_patterns = s.linked_patterns.filter(link => !idsToDelete.has(link.id));
            }
            if (s.kind === 'persona' && s.persona?.linked_personas) {
                s.persona.linked_personas = s.persona.linked_personas.filter(id => !idsToDelete.has(id));
            }
        });
    }

    domain.lastUpdated = Date.now();
    await redisService.request(['SET', key, JSON.stringify(domain)]);
  },

  /**
   * Updates references during rename.
   */
  propagateRename: async (domainId: string, oldId: string, newId: string) => {
      const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
      const data = await redisService.request(['GET', key]);
      if (!data) return;

      const domain = parseDomain(data, domainId);
      let updatedCount = 0;

      domain.symbols.forEach(s => {
          let modified = false;
          if (s.linked_patterns) {
              s.linked_patterns.forEach(link => {
                  if (link.id === oldId) {
                      link.id = newId;
                      modified = true;
                  }
              });
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
    const domain = await domainService.getDomain(domainId);
    return domain ? domain.symbols : [];
  },

  /**
   * Saves or updates a symbol.
   */
  upsertSymbol: async (domainId: string, symbol: SymbolDef, options: { bypassValidation?: boolean, internalBidirectionalCall?: boolean } = {}) => {
    let domain = await domainService.getDomain(domainId);

    if (!domain) {
        throw new Error(`Domain '${domainId}' not found. You must create the domain first.`);
    }

    ensureWritableDomain(domain, domainId, symbol.id);

    // Validation: Check if linked patterns exist
    if (!options.bypassValidation && symbol.linked_patterns && symbol.linked_patterns.length > 0) {
        const missingLinks: string[] = [];
        for (const link of symbol.linked_patterns) {
            const linkId = link.id;
            // Self-reference is allowed (or will be created)
            if (linkId === symbol.id) continue;

            const exists = await domainService.findById(linkId);
            if (!exists) {
                missingLinks.push(linkId);
            }
        }
        if (missingLinks.length > 0) {
            throw new Error(`Validation Failed: Linked patterns not found: ${missingLinks.join(', ')}`);
        }
    }

    // Default invalid kind to pattern
    const validKinds = ['pattern', 'persona', 'lattice', 'data'];
    if (!symbol.kind || !validKinds.includes(symbol.kind)) {
        symbol.kind = 'pattern';
    }

    const nowB64 = currentTimestamp();
    
    // Deduplicate: Remove any existing symbols with the same ID (fixes historical duplicates)
    const previousSymbol = domain.symbols.find(s => s.id === symbol.id);
    domain.symbols = domain.symbols.filter(s => s.id !== symbol.id);

    const normalizedSymbol: SymbolDef = {
        ...symbol,
        created_at: previousSymbol?.created_at || nowB64,
        updated_at: nowB64,
    };

    // Add normalized symbol (effectively replacing/updating)
    domain.symbols.push(normalizedSymbol);

    domain.lastUpdated = Date.now();
    
    // Save Domain
    await redisService.request(['SET', `${KEYS.DOMAIN_PREFIX}${domainId}`, JSON.stringify(domain)]);

    // Time bucket index (based on creation time)
    await indexSymbolBucket(normalizedSymbol);
    
    // Index Vector
    await vectorService.indexSymbol(normalizedSymbol);

    // Handle Bidirectional Links
    if (!options.internalBidirectionalCall && normalizedSymbol.linked_patterns) {
        for (const link of normalizedSymbol.linked_patterns) {
            if (link.bidirectional) {
                const targetSymbol = await domainService.findById(link.id);
                if (targetSymbol) {
                    const backLink = { id: normalizedSymbol.id, link_type: link.link_type, bidirectional: true };
                    const hasBackLink = targetSymbol.linked_patterns.some(l => l.id === normalizedSymbol.id);
                    
                    if (!hasBackLink) {
                        const updatedTarget = {
                            ...targetSymbol,
                            linked_patterns: [...targetSymbol.linked_patterns, backLink]
                        };
                        await domainService.upsertSymbol(targetSymbol.symbol_domain, updatedTarget, { 
                            bypassValidation: true, 
                            internalBidirectionalCall: true 
                        });
                    }
                }
            }
        }
    }
  },

  /**
   * Bulk upsert.
   */
  bulkUpsert: async (domainId: string, symbols: SymbolDef[], options: { bypassValidation?: boolean, internalBidirectionalCall?: boolean } = {}) => {
      const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
      const data = await redisService.request(['GET', key]);
      
      let domain: CachedDomain;
      if (!data) {
          throw new Error(`Domain '${domainId}' not found. You must create the domain first.`);
      } else {
          domain = parseDomain(data, domainId);
      }

      ensureWritableDomain(domain, domainId, symbols[0]?.id);

      if (!options.bypassValidation) {
          // Validation: Check linked patterns integrity
          const upsertIds = new Set(symbols.map(s => s.id));
          // Optimization: Load all existing IDs once
          const allExistingSymbols = await domainService.getAllSymbols(true);
          const validIds = new Set(allExistingSymbols.map(s => s.id));

          const missingLinksBySymbol: Record<string, string[]> = {};

                    for (const sym of symbols) {

                        if (sym.linked_patterns && sym.linked_patterns.length > 0) {

                            for (const link of sym.linked_patterns) {

                                const linkId = link.id;

                                // Allow self-reference, reference to symbol in this batch, or existing symbol

                                if (linkId === sym.id || upsertIds.has(linkId) || validIds.has(linkId)) {

                                    continue;

                                }

                                if (!missingLinksBySymbol[sym.id]) missingLinksBySymbol[sym.id] = [];

                                missingLinksBySymbol[sym.id].push(linkId);

                            }

                        }

                    }

          if (Object.keys(missingLinksBySymbol).length > 0) {
              const details = Object.entries(missingLinksBySymbol)
                  .map(([id, links]) => `${id} -> [${links.join(', ')}]`)
                  .join('; ');
              console.warn(`[DomainService] Validation Warning: Missing linked patterns for symbols: ${details}`);
              // throw new Error(`Validation Failed: Missing linked patterns for symbols: ${details}`);
          }
      }

      const symbolMap = new Map(domain.symbols.map(s => [s.id, s]));
      const nowB64 = currentTimestamp();
      const validKinds = ['pattern', 'persona', 'lattice', 'data'];

      for (const sym of symbols) {
          // Default invalid kind to pattern
          if (!sym.kind || !validKinds.includes(sym.kind)) {
              sym.kind = 'pattern';
          }

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
      
      if (symbols.length > 0) {
          await vectorService.indexBatch(symbols);
      }

      // Handle Bidirectional Links for the batch
      if (!options.internalBidirectionalCall) {
          const upsertIds = new Set(symbols.map(s => s.id));
          for (const sym of symbols) {
              if (sym.linked_patterns) {
                  for (const link of sym.linked_patterns) {
                      if (link.bidirectional) {
                          // If target is in the same batch, it might already have the link or will be handled in its turn.
                          // But to be sure, we ensure both sides have it.
                          const targetSymbol = await domainService.findById(link.id);
                          if (targetSymbol) {
                              const hasBackLink = targetSymbol.linked_patterns.some(l => l.id === sym.id);
                              if (!hasBackLink) {
                                  const backLink = { id: sym.id, link_type: link.link_type, bidirectional: true };
                                  const updatedTarget = {
                                      ...targetSymbol,
                                      linked_patterns: [...targetSymbol.linked_patterns, backLink]
                                  };
                                  await domainService.upsertSymbol(targetSymbol.symbol_domain, updatedTarget, { 
                                      bypassValidation: true, 
                                      internalBidirectionalCall: true 
                                  });
                              }
                          }
                      }
                  }
              }
          }
      }
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
             domain = { id: domainId, name: domainId, enabled: true, lastUpdated: Date.now(), symbols: [], readOnly: false };
             await redisService.request(['SADD', KEYS.DOMAINS_SET, domainId]);
          } else {
             domain = parseDomain(data, domainId);
          }

          ensureWritableDomain(domain, domainId, domainUpdates[0]?.symbol_data?.id);

          const existingCreatedAt = new Map<string, string>();
          domain.symbols.forEach((s) => {
              if (s.created_at) existingCreatedAt.set(s.id, s.created_at);
          });

          // 1. Renames
          domainUpdates.forEach(update => {
              if (update.old_id !== update.symbol_data.id) {
                  domain.symbols.forEach(s => {
                      if (s.id === update.old_id) return;
                      if (s.linked_patterns) {
                          s.linked_patterns.forEach(link => {
                              if (link.id === update.old_id) link.id = update.symbol_data.id;
                          });
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
          const validKinds = ['pattern', 'persona', 'lattice', 'data'];
          for (const update of domainUpdates) {
              if (!update.symbol_data.kind || !validKinds.includes(update.symbol_data.kind)) {
                  update.symbol_data.kind = 'pattern';
              }

              const nowB64 = currentTimestamp();
              const normalized: SymbolDef = {
                  ...update.symbol_data,
                  created_at: existingCreatedAt.get(update.old_id) || nowB64,
                  updated_at: nowB64,
              };
              domain.symbols.push(normalized);
              updateCount++;
              
              await vectorService.indexSymbol(normalized);
              await indexSymbolBucket(normalized);
          }

          domain.lastUpdated = Date.now();
          await redisService.request(['SET', key, JSON.stringify(domain)]);
      }

      return { count: updateCount, renamedIds };
  },

  /**
   * Compress symbols.
   */
  compressSymbols: async (newSymbol: SymbolDef, oldIds: string[], options: { bypassValidation?: boolean } = {}) => {
      const domainId = newSymbol.symbol_domain || 'root';

      // Validation: Check if linked patterns exist
      if (!options.bypassValidation && newSymbol.linked_patterns && newSymbol.linked_patterns.length > 0) {
          const missingLinks: string[] = [];
          for (const link of newSymbol.linked_patterns) {
              const linkId = link.id;
              const exists = await domainService.findById(linkId);
              if (!exists) {
                  missingLinks.push(linkId);
              }
          }
          
          if (missingLinks.length > 0) {
              throw new Error(`Validation Failed: Linked patterns not found: ${missingLinks.join(', ')}`);
          }
      }

      await domainService.upsertSymbol(domainId, newSymbol, { bypassValidation: options.bypassValidation });
      
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

    const domain = parseDomain(data, domainId);
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
    
    for (const domainId of domains) {
        const key = `${KEYS.DOMAIN_PREFIX}${domainId}`;
        const data = await redisService.request(['GET', key]);
        if (!data) continue;

        const domain = parseDomain(data, domainId);
        if (domain.enabled) {
            const index = domain.symbols.findIndex(s => s.id === id);
            if (index !== -1) {
                const symbol = domain.symbols[index];
                
                // Update Access Time
                symbol.last_accessed_at = currentTimestamp();
                domain.lastUpdated = Date.now();
                
                // Persist update (async, non-blocking for this read)
                redisService.request(['SET', key, JSON.stringify(domain)]).catch(e => 
                    console.error(`[DomainService] Failed to update access time for ${id}`, e)
                );

                return symbol;
            }
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
          const d = parseDomain(data, domains[i]);
          return {
              id: domains[i],
              name: d.name || domains[i],
              enabled: d.enabled,
              count: d.symbols.length,
              lastUpdated: d.lastUpdated,
              description: d.description || "",
              invariants: d.invariants || [],
              readOnly: d.readOnly
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

      rawData.forEach((data, idx) => {
          if (!data) return;
          try {
              const domain = parseDomain(data, domains[idx]);
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
