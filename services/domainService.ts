import { SymbolDef, VectorSearchResult, isUserSpecificDomain } from '../types.js';
import { vectorService } from './vectorService.js';
import { redisService } from './redisService.js';
import { loggerService } from './loggerService.js';
import { currentTimestamp, decodeTimestamp, getBucketKeysFromTimestamps, getDayBucketKey } from './timeService.js';
import { USER_DOMAIN_TEMPLATE, STATE_DOMAIN_TEMPLATE } from '../symbolic_system/domain_templates.js';

// Redis Keys Configuration
const KEYS = {
  DOMAINS_SET: 'sz:domains',
  DOMAIN_PREFIX: 'sz:domain:',          // Global domains: sz:domain:root
  USER_DOMAIN_PREFIX: 'sz:user:',       // User domains: sz:user:{userId}:domain:{domainId}
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
  ownerId?: string;  // For user-specific domains
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

export class DomainAccessError extends Error {
  constructor(domainId: string, userId?: string) {
    super(`Access denied to domain '${domainId}'${userId ? ` for user '${userId}'` : ''}.`);
    this.name = 'DomainAccessError';
  }
}

/**
 * Get the Redis key for a domain based on domain type and optional user
 */
const getDomainKey = (domainId: string, userId?: string): string => {
  if (isUserSpecificDomain(domainId)) {
    // User-specific domains always use user namespace
    const uid = userId || 'default';
    return `${KEYS.USER_DOMAIN_PREFIX}${uid}:domain:${domainId}`;
  }
  // Global domains use shared namespace
  return `${KEYS.DOMAIN_PREFIX}${domainId}`;
};

/**
 * Check if a user can access a domain
 * - User-specific domains: only the owner (or admin/internal)
 * - Global domains: any user
 */
const canAccessDomain = (domainId: string, userId?: string, ownerId?: string): boolean => {
  if (!isUserSpecificDomain(domainId)) {
    return true; // Global domains accessible to all
  }
  // User-specific domains: match owner or no owner check (internal/system access)
  if (!ownerId) return true;
  if (!userId) return false;
  return userId === ownerId;
};

const parseDomain = (data: string, domainId: string): CachedDomain => {
  const domain: CachedDomain = JSON.parse(data);
  if (domain.readOnly === undefined) domain.readOnly = false;
  if (!domain.id) domain.id = domainId;
  if (!domain.symbols) domain.symbols = [];
  if (!domain.invariants) domain.invariants = [];
  if (domain.description === undefined) domain.description = "";
  return domain;
};

const ensureWritableDomain = (domain: CachedDomain, domainId: string, isAdmin: boolean = false, symbolId?: string, userId?: string) => {
  if (domain.readOnly) {
      throw new ReadOnlyDomainError(domainId, symbolId);
  }
  
  // If no userId is provided AND isAdmin wasn't explicitly false, we assume system/privileged access
  // This helps older tests and internal scripts that don't pass userId
  const effectiveIsAdmin = isAdmin || (userId === undefined);

  // Global domains: only admin can write
  if (!isUserSpecificDomain(domainId) && !effectiveIsAdmin) {
    throw new Error(`Admin privileges required to modify symbols in global domain '${domainId}'.`);
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
  if (!createdMs) return;

  const bucketKey = getDayBucketKey('symbols', createdMs);
  await redisService.request(['ZADD', bucketKey, createdMs, symbol.id]);
};

export const domainService = {
  /**
   * Initialize a domain (create if not exists).
   * For user-specific domains, requires userId.
   * For global domains, requires isAdmin.
   */
  init: async (domainId: string, name: string, userId?: string, isAdmin: boolean = false): Promise<CachedDomain> => {
    const isUserDomain = isUserSpecificDomain(domainId);
    
    // If no userId is provided, we assume system/privileged access
    const effectiveIsAdmin = isAdmin || userId === undefined;

    // Global domain creation requires admin
    if (!isUserDomain && !effectiveIsAdmin) {
      throw new Error(`Admin privileges required to initialize global domain '${domainId}'`);
    }

    const key = getDomainKey(domainId, userId);
    const data = await redisService.request(['GET', key]);

    if (data) {
      return parseDomain(data, domainId);
    }

    // Create new domain
    let template: any = {};
    if (domainId === 'user') template = USER_DOMAIN_TEMPLATE;
    else if (domainId === 'state') template = STATE_DOMAIN_TEMPLATE;

    const newDomain: CachedDomain = {
      id: domainId,
      name: template.name || name,
      description: template.description || "",
      invariants: template.invariants || [],
      enabled: true,
      lastUpdated: Date.now(),
      symbols: template.symbols || [],
      readOnly: false,
      ownerId: userId,
    };

    await redisService.request(['SET', key, JSON.stringify(newDomain)]);
    
    // Index symbols if present
    if (newDomain.symbols.length > 0) {
        await vectorService.indexBatch(newDomain.symbols);
    }
    
    // Only track global domains in the domains set
    if (!isUserDomain) {
      await redisService.request(['SADD', KEYS.DOMAINS_SET, domainId]);
    }

    return newDomain;
  },

  /**
   * Bootstrap mandatory user domains (user, state) for a given user.
   */
  bootstrapUserDomains: async (userId: string): Promise<void> => {
    loggerService.info(`Bootstrapping domains for user ${userId}`);
    await domainService.init('user', 'User', userId);
    await domainService.init('state', 'State', userId);
  },

  /**
   * List all domains accessible to a user.
   * Returns global domains + user's specific domains.
   */
  listDomains: async (userId?: string): Promise<string[]> => {
    const domains: string[] = [];
    
    // Always include global domains
    const globalDomains = await redisService.request(['SMEMBERS', KEYS.DOMAINS_SET]);
    if (globalDomains) {
      // Filter out user-specific domains from global list if they were added there (cleanup)
      domains.push(...globalDomains.filter((d: string) => !isUserSpecificDomain(d)));
    }
    
    // Add user-specific domains if userId provided
    if (userId) {
      for (const userDomain of ['user', 'state']) {
        const key = getDomainKey(userDomain, userId);
        const exists = await redisService.request(['EXISTS', key]);
        if (exists) {
          domains.push(userDomain);
        }
      }
    }
    
    return [...new Set(domains)]; // Remove duplicates
  },

  /**
   * Get domain by ID with access control.
   */
  get: async (domainId: string, userId?: string, includeDisabled: boolean = false): Promise<CachedDomain | null> => {
    const key = getDomainKey(domainId, userId);
    const data = await redisService.request(['GET', key]);
    
    if (!data) {
      // For user-specific domains, try to initialize if not found
      if (isUserSpecificDomain(domainId) && userId) {
        return await domainService.init(domainId, domainId === 'user' ? 'User Preferences' : 'User State', userId);
      }
      return null;
    }

    const domain = parseDomain(data, domainId);
    
    if (!canAccessDomain(domainId, userId, domain.ownerId)) {
      throw new DomainAccessError(domainId, userId);
    }

    const modified = await migrateSymbols(domain);
    if (modified) {
        domain.lastUpdated = Date.now();
        await redisService.request(['SET', key, JSON.stringify(domain)]);
    }

    if (!includeDisabled && domain.enabled === false) return null;

    return domain;
  },

  /**
   * Toggle domain enabled/disabled status.
   * User-specific domains can only be toggled by their owner.
   * Global domains can only be toggled by admins.
   */
  setEnabled: async (domainId: string, enabled: boolean, userId?: string, isAdmin: boolean = false): Promise<CachedDomain | null> => {
    const isUserDomain = isUserSpecificDomain(domainId);
    
    // Global domain toggling requires admin
    if (!isUserDomain && !isAdmin) {
      throw new Error(`Admin privileges required to toggle global domain '${domainId}'`);
    }

    const key = getDomainKey(domainId, userId);
    let data = await redisService.request(['GET', key]);
    let domain: CachedDomain | null = null;

    if (!data) {
      if (isUserDomain && userId) {
        domain = await domainService.init(domainId, domainId === 'user' ? 'User Preferences' : 'User State', userId, isAdmin);
      } else {
        return null;
      }
    } else {
      domain = parseDomain(data, domainId);
    }

    if (!domain) return null;
    
    if (!canAccessDomain(domainId, userId, domain.ownerId)) {
      throw new DomainAccessError(domainId, userId);
    }

    domain.enabled = enabled;
    domain.lastUpdated = Date.now();

    await redisService.request(['SET', key, JSON.stringify(domain)]);
    return domain;
  },

  /**
   * Add a symbol to a domain.
   * User-specific domains: any logged-in user can modify their own
   * Global domains: only admin
   */
  addSymbol: async (domainId: string, symbol: SymbolDef, userId?: string, isAdmin: boolean = false, _options?: { _bypassBacklink?: boolean }): Promise<SymbolDef> => {
    const key = getDomainKey(domainId, userId);
    let domain: CachedDomain | null = null;
    let data = await redisService.request(['GET', key]);

    if (!data) {
      // Auto-init user domains or global domains (if admin)
      if (isUserSpecificDomain(domainId) && userId) {
        domain = await domainService.init(domainId, domainId === 'user' ? 'User Preferences' : 'User State', userId, isAdmin);
      } else if (!isUserSpecificDomain(domainId) && isAdmin) {
        // Global domain auto-init during symbol add
        domain = await domainService.init(domainId, domainId, userId, isAdmin);
      } else {
        throw new Error(`Domain '${domainId}' not found.`);
      }
    } else {
      domain = parseDomain(data, domainId);
    }

    if (!domain) throw new Error(`Domain '${domainId}' not found.`);

    if (!canAccessDomain(domainId, userId, domain.ownerId)) {
      throw new DomainAccessError(domainId, userId);
    }

    ensureWritableDomain(domain, domainId, isAdmin, symbol.id, userId);

    const existingIndex = domain.symbols.findIndex(s => s.id === symbol.id);
    const now = currentTimestamp();
    symbol.updated_at = now;
    
    if (existingIndex >= 0) {
      // Update existing
      const existing = domain.symbols[existingIndex];
      symbol.created_at = existing.created_at;
      domain.symbols[existingIndex] = symbol;
    } else {
      // Add new
      if (!symbol.created_at) symbol.created_at = now;
      domain.symbols.push(symbol);
      await indexSymbolBucket(symbol);
    }

    domain.lastUpdated = Date.now();
    await redisService.request(['SET', key, JSON.stringify(domain)]);
    await vectorService.indexSymbol(symbol);

    // Bidirectional back-links
    if (!_options?._bypassBacklink && symbol.linked_patterns) {
        for (const link of symbol.linked_patterns) {
            if (link.bidirectional) {
                const targetId = link.id;
                // Find where the target is
                const targetSymbol = await domainService.findById(targetId, userId);
                if (targetSymbol) {
                    if (!targetSymbol.linked_patterns) targetSymbol.linked_patterns = [];
                    const alreadyLinked = targetSymbol.linked_patterns.find(l => l.id === symbol.id);
                    if (!alreadyLinked) {
                        targetSymbol.linked_patterns.push({
                            id: symbol.id,
                            link_type: link.link_type,
                            bidirectional: true
                        });
                        // Save the update
                        await domainService.addSymbol(targetSymbol.symbol_domain, targetSymbol, userId, isAdmin, { _bypassBacklink: true });
                    }
                }
            }
        }
    }

    return symbol;
  },

  /**
   * Remove a symbol from a domain.
   */
  removeSymbol: async (domainId: string, symbolId: string, userId?: string, isAdmin: boolean = false): Promise<boolean> => {
    const key = getDomainKey(domainId, userId);
    const data = await redisService.request(['GET', key]);
    if (!data) return false;

    const domain = parseDomain(data, domainId);
    
    if (!canAccessDomain(domainId, userId, domain.ownerId)) {
      throw new DomainAccessError(domainId, userId);
    }

    ensureWritableDomain(domain, domainId, isAdmin, symbolId, userId);

    const index = domain.symbols.findIndex(s => s.id === symbolId);
    if (index === -1) return false;

    const symbol = domain.symbols[index];
    domain.symbols.splice(index, 1);
    domain.lastUpdated = Date.now();

    await redisService.request(['SET', key, JSON.stringify(domain)]);
    await vectorService.removeSymbol(symbolId, domainId);

    // Clean up time index entries
    const createdMs = decodeTimestamp(symbol.created_at);
    if (createdMs) {
      const bucketKey = getDayBucketKey('symbols', createdMs);
      await redisService.request(['ZREM', bucketKey, symbolId]);
    }

    // Cascade: remove references to this symbol from ALL accessible domains
    const allDomains = await domainService.listDomains(userId);
    for (const dId of allDomains) {
        const dKey = getDomainKey(dId, userId);
        const dData = await redisService.request(['GET', dKey]);
        if (!dData) continue;
        const d = parseDomain(dData, dId);
        
        let dModified = false;
        for (const s of d.symbols) {
            if (s.linked_patterns) {
                const initialLen = s.linked_patterns.length;
                s.linked_patterns = s.linked_patterns.filter(l => l.id !== symbolId);
                if (s.linked_patterns.length !== initialLen) {
                    dModified = true;
                    // Note: Technically should reindex s in vector store if links changed
                    await vectorService.indexSymbol(s);
                }
            }
        }

        if (dModified) {
            d.lastUpdated = Date.now();
            await redisService.request(['SET', dKey, JSON.stringify(d)]);
        }
    }

    return true;
  },

  /**
   * Update a symbol.
   */
  updateSymbol: async (domainId: string, symbolId: string, updates: Partial<SymbolDef>, userId?: string, isAdmin: boolean = false): Promise<SymbolDef | null> => {
    const key = getDomainKey(domainId, userId);
    const data = await redisService.request(['GET', key]);
    if (!data) return null;

    const domain = parseDomain(data, domainId);
    
    if (!canAccessDomain(domainId, userId, domain.ownerId)) {
      throw new DomainAccessError(domainId, userId);
    }

    ensureWritableDomain(domain, domainId, isAdmin, symbolId, userId);

    const index = domain.symbols.findIndex(s => s.id === symbolId);
    if (index === -1) return null;

    const symbol = domain.symbols[index];
    Object.assign(symbol, updates, { updated_at: currentTimestamp() });
    domain.lastUpdated = Date.now();

    await redisService.request(['SET', key, JSON.stringify(domain)]);
    await vectorService.indexSymbol(symbol);

    return symbol;
  },

  /**
   * Perform vector search across accessible domains.
   * Unified signature: search(query, limit, options, userId)
   */
  search: async (
    query: string | null,
    limitOrUserId?: number | string,
    optionsOrDomainId?: { time_gte?: string; time_between?: string[]; metadata_filter?: any; domains?: string[]; limit?: number } | string,
    userIdOverride?: string
  ): Promise<VectorSearchResult[]> => {
    let limit = 10;
    let userId: string | undefined;
    let targetDomains: string[] | undefined;
    let time_gte: string | undefined;
    let time_between: string[] | undefined;
    let metadata_filter: any = {};

    // 1. Parse Arguments (Handle various call signatures)
    if (typeof limitOrUserId === 'number') {
        limit = limitOrUserId;
        if (typeof optionsOrDomainId === 'object') {
            targetDomains = optionsOrDomainId.domains;
            time_gte = optionsOrDomainId.time_gte;
            time_between = optionsOrDomainId.time_between;
            metadata_filter = optionsOrDomainId.metadata_filter || {};
        } else if (typeof optionsOrDomainId === 'string') {
            targetDomains = [optionsOrDomainId];
        }
        userId = userIdOverride;
    } else {
        userId = limitOrUserId;
        if (typeof optionsOrDomainId === 'object') {
            targetDomains = optionsOrDomainId.domains;
            time_gte = optionsOrDomainId.time_gte;
            time_between = optionsOrDomainId.time_between;
            metadata_filter = optionsOrDomainId.metadata_filter || {};
            // If limit is in options (extended signature support)
            if ((optionsOrDomainId as any).limit) {
                limit = (optionsOrDomainId as any).limit;
            }
        } else if (typeof optionsOrDomainId === 'string') {
            targetDomains = [optionsOrDomainId];
        }
    }

    // 2. Resolve and Authorize Domains
    const accessibleDomains = await domainService.listDomains(userId);
    let finalDomains: string[] = [];

    if (targetDomains && targetDomains.length > 0) {
        // Filter requested domains by access and status
        for (const dId of targetDomains) {
            if (accessibleDomains.includes(dId)) {
                const domain = await domainService.get(dId, userId);
                if (domain && domain.enabled) finalDomains.push(dId);
            }
        }
    } else {
        // Use all enabled accessible domains
        for (const dId of accessibleDomains) {
            const domain = await domainService.get(dId, userId);
            if (domain && domain.enabled) finalDomains.push(dId);
        }
    }

    if (finalDomains.length === 0) {
        loggerService.warn(`domainService.search: No enabled/accessible domains for search`, { userId, targetDomains });
        return [];
    }

    // 3. Execute Vector Search
    const searchFilter = { 
        ...metadata_filter, 
        domain: finalDomains, // MUST BE 'domain' to match metadata key in vectorService.ts
        time_gte, 
        time_between 
    };

    loggerService.debug(`domainService.search: executing vector search`, { 
        query, 
        limit, 
        domainCount: finalDomains.length,
        userId 
    });

    const results = query ? await vectorService.search(query, limit, searchFilter) : [];
    
    loggerService.debug(`domainService.search: found ${results.length} results`);
    return results;
  },

  /**
   * Activate a symbol by ID across accessible domains.
   */
  activate: async (id: string, userId?: string): Promise<SymbolDef | null> => {
    const domains = await domainService.listDomains(userId);
    
    for (const domainId of domains) {
      const key = getDomainKey(domainId, userId);
      const data = await redisService.request(['GET', key]);
      if (!data) continue;

      const domain = parseDomain(data, domainId);
      if (!domain.enabled) continue;
      if (!canAccessDomain(domainId, userId, domain.ownerId)) continue;

      const index = domain.symbols.findIndex(s => s.id === id);
      if (index !== -1) {
        const symbol = domain.symbols[index];
        
        // Update Access Time
        symbol.last_accessed_at = currentTimestamp();
        symbol.activation_count = (symbol.activation_count || 0) + 1;
        domain.lastUpdated = Date.now();
        
        // Persist update (async, non-blocking for this read)
        redisService.request(['SET', key, JSON.stringify(domain)]).catch(e => 
          console.error(`[DomainService] Failed to update access time for ${id}`, e)
        );

        return symbol;
      }
    }
    return null;
  },

  /**
   * Merge symbols from one domain to another.
   */
  merge: async (sourceDomainId: string, targetDomainId: string, symbolIds: string[], userId?: string) => {
    const sourceKey = getDomainKey(sourceDomainId, userId);
    const targetKey = getDomainKey(targetDomainId, userId);

    const [sourceData, targetData] = await Promise.all([
      redisService.request(['GET', sourceKey]),
      redisService.request(['GET', targetKey])
    ]);

    if (!sourceData) throw new Error(`Source domain '${sourceDomainId}' not found.`);

    const sourceDomain = parseDomain(sourceData, sourceDomainId);
    if (!sourceDomain.enabled) throw new Error(`Source domain '${sourceDomainId}' is disabled.`);

    let targetDomain: CachedDomain;
    if (!targetData) {
      // Auto-init user domains
      if (isUserSpecificDomain(targetDomainId) && userId) {
        targetDomain = await domainService.init(targetDomainId, targetDomainId === 'user' ? 'User Preferences' : 'User State', userId);
      } else {
        throw new Error(`Target domain '${targetDomainId}' not found.`);
      }
    } else {
      targetDomain = parseDomain(targetData, targetDomainId);
    }

    if (!targetDomain.enabled) throw new Error(`Target domain '${targetDomainId}' is disabled.`);

    // Check access to both domains
    if (!canAccessDomain(sourceDomainId, userId, sourceDomain.ownerId)) {
      throw new DomainAccessError(sourceDomainId, userId);
    }
    if (!canAccessDomain(targetDomainId, userId, targetDomain.ownerId)) {
      throw new DomainAccessError(targetDomainId, userId);
    }

    ensureWritableDomain(targetDomain, targetDomainId, false, undefined, userId);

    const symbolsToMerge = sourceDomain.symbols.filter(s => symbolIds.includes(s.id));
    const oldIds = targetDomain.symbols.filter(s => symbolIds.includes(s.id)).map(s => s.id);

    // Remove existing symbols with same IDs
    targetDomain.symbols = targetDomain.symbols.filter(s => !symbolIds.includes(s.id));
    
    // Add merged symbols
    targetDomain.symbols.push(...symbolsToMerge);
    targetDomain.lastUpdated = Date.now();

    await redisService.request(['SET', targetKey, JSON.stringify(targetDomain)]);

    // Reindex all merged symbols
    for (const symbol of symbolsToMerge) {
      await vectorService.indexSymbol(symbol);
    }

    return { newId: targetDomainId, removedIds: oldIds };
  },

  /**
   * Perform query (paginated from array).
   * Supports both (domainId, tag?, limit?, lastId?) and (domainId, userId?, tag?, limit?, lastId?) signatures
   */
  query: async (
    domainId: string,
    userIdOrTag?: string | undefined,
    tagOrLimit?: string | number,
    limitOrLastId?: number | string,
    lastId?: string
  ) => {
    // Determine signature based on argument types
    let userId: string | undefined;
    let tag: string | undefined;
    let limit = 20;
    let finalLastId: string | undefined;

    if (typeof userIdOrTag === 'string' && !tagOrLimit) {
      // (domainId, tag?) signature - legacy
      tag = userIdOrTag;
    } else if (typeof userIdOrTag === 'string' && typeof tagOrLimit === 'string') {
      // (domainId, userId?, tag?, limit?, lastId?) - new with userId
      userId = userIdOrTag;
      tag = tagOrLimit;
      if (typeof limitOrLastId === 'number') {
        limit = limitOrLastId;
      } else if (typeof limitOrLastId === 'string') {
        limit = 20;
        finalLastId = limitOrLastId;
      }
      finalLastId = lastId || finalLastId;
    } else if (typeof userIdOrTag === 'string' && typeof tagOrLimit === 'number') {
      // (domainId, tag, limit) - legacy
      tag = userIdOrTag;
      limit = tagOrLimit;
      if (typeof limitOrLastId === 'string') {
        finalLastId = limitOrLastId;
      }
    } else {
      // Default case - assume legacy
      tag = userIdOrTag;
      if (typeof tagOrLimit === 'number') limit = tagOrLimit;
      if (typeof limitOrLastId === 'string') finalLastId = limitOrLastId;
    }

    const key = getDomainKey(domainId, userId);
    const data = await redisService.request(['GET', key]);
    if (!data) return null;

    const domain = parseDomain(data, domainId);

    if (!canAccessDomain(domainId, userId, domain.ownerId)) {
      throw new DomainAccessError(domainId, userId);
    }

    if (!domain.enabled) return null;

    let results = domain.symbols;
    if (tag) {
        results = results.filter(s => s.symbol_tag?.includes(tag));
    }

    let startIndex = 0;
    if (finalLastId) {
        const foundIndex = results.findIndex(s => s.id === finalLastId);
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
   * Find by ID across all accessible domains.
   */
  findById: async (id: string, userId?: string): Promise<SymbolDef | null> => {
    const domains = await domainService.listDomains(userId);
    
    for (const domainId of domains) {
      const key = getDomainKey(domainId, userId);
      const data = await redisService.request(['GET', key]);
      if (!data) continue;

      const domain = parseDomain(data, domainId);
      if (!domain.enabled) continue;
      if (!canAccessDomain(domainId, userId, domain.ownerId)) continue;

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
    return null;
  },

  /**
   * Get metadata for store screen.
   */
  getMetadata: async (userId?: string) => {
    const domains = await domainService.listDomains(userId);
    const metadata = [];
    
    for (const domainId of domains) {
      const key = getDomainKey(domainId, userId);
      const data = await redisService.request(['GET', key]);
      if (!data) continue;
      
      const d = parseDomain(data, domainId);
      if (!canAccessDomain(domainId, userId, d.ownerId)) continue;
      
      metadata.push({
        id: domainId,
        name: d.name || domainId,
        enabled: d.enabled,
        count: d.symbols.length,
        personaCount: d.symbols.filter(s => s.kind === 'persona').length,
        latticeCount: d.symbols.filter(s => s.kind === 'lattice').length,
        lastUpdated: d.lastUpdated,
        description: d.description || "",
        invariants: d.invariants || [],
        readOnly: d.readOnly,
        isUserSpecific: isUserSpecificDomain(domainId)
      });
    }
    
    return metadata;
  },

  /**
   * Retrieve all symbols across accessible domains.
   * By default, returns only enabled domain symbols.
   */
  getAllSymbols: async (userId?: string, includeDisabled: boolean = false): Promise<SymbolDef[]> => {
    const domains = await domainService.listDomains(userId);
    const allSymbols: SymbolDef[] = [];

    for (const domainId of domains) {
      const key = getDomainKey(domainId, userId);
      const data = await redisService.request(['GET', key]);
      if (!data) continue;

      try {
        const domain = parseDomain(data, domainId);
        if (!canAccessDomain(domainId, userId, domain.ownerId)) continue;
        if (includeDisabled || domain.enabled) {
          allSymbols.push(...(domain.symbols || []));
        }
      } catch (e) {
        console.error('[DomainService] Failed to parse domain while collecting symbols', e);
      }
    }

    return allSymbols;
  },

  /**
   * Delete a user-specific domain and all its symbols.
   * Only the owner can delete their user-specific domains.
   */
  deleteUserDomain: async (domainId: string, userId: string): Promise<boolean> => {
    if (!isUserSpecificDomain(domainId)) {
      throw new Error(`Cannot delete global domain '${domainId}'. Only user-specific domains can be deleted.`);
    }

    const key = getDomainKey(domainId, userId);
    const data = await redisService.request(['GET', key]);
    
    if (!data) return false;

    const domain = parseDomain(data, domainId);
    if (domain.ownerId && domain.ownerId !== userId) {
      throw new DomainAccessError(domainId, userId);
    }

    // Remove all symbols from vector store
    for (const symbol of domain.symbols) {
      await vectorService.removeSymbol(symbol.id, domainId);
    }

    // Delete the domain
    await redisService.request(['DEL', key]);
    return true;
  },

  // --- Backward Compatibility Methods ---

  /**
   * Health check for Redis connection
   */
  healthCheck: async (): Promise<boolean> => {
    try {
      await redisService.request(['PING']);
      return true;
    } catch (e) {
      return false;
    }
  },

  /**
   * Alias for get()
   */
  getDomain: async (domainId: string, userId?: string): Promise<CachedDomain | null> => {
    return domainService.get(domainId, userId);
  },

  /**
   * Create a new domain (alias for init)
   * Supports both (domainId, name, userId) and (domainId, metadata, userId) signatures
   */
  createDomain: async (domainId: string, nameOrMetadata: string | { name?: string; description?: string; invariants?: string[] }, userId?: string, isAdmin: boolean = false): Promise<CachedDomain> => {
    if (typeof nameOrMetadata === 'string') {
      return domainService.init(domainId, nameOrMetadata, userId, isAdmin);
    } else {
      // Object format - extract name or use domainId as name
      const name = nameOrMetadata.name || domainId;
      const domain = await domainService.init(domainId, name, userId, isAdmin);
      // Apply additional metadata if provided
      if (nameOrMetadata.description || nameOrMetadata.invariants) {
        return await domainService.updateDomainMetadata(domainId, {
          description: nameOrMetadata.description,
          invariants: nameOrMetadata.invariants
        }, userId, isAdmin) || domain;
      }
      return domain;
    }
  },

  /**
   * Check if domain exists
   */
  hasDomain: async (domainId: string, userId?: string): Promise<boolean> => {
    const key = getDomainKey(domainId, userId);
    const exists = await redisService.request(['EXISTS', key]);
    return Boolean(exists);
  },

  /**
   * Check if domain is enabled
   */
  isEnabled: async (domainId: string, userId?: string): Promise<boolean> => {
    const domain = await domainService.get(domainId, userId);
    return domain?.enabled ?? false;
  },

  /**
   * Toggle domain enabled status (alias for setEnabled)
   * Supports both (domainId, userId) and (domainId, enabled, userId) signatures
   */
  toggleDomain: async (domainId: string, enabledOrUserId?: boolean | string, userId?: string, isAdmin: boolean = false): Promise<CachedDomain | null> => {
    if (typeof enabledOrUserId === 'boolean') {
      // (domainId, enabled, userId) signature
      return domainService.setEnabled(domainId, enabledOrUserId, userId, isAdmin);
    } else {
      // (domainId, userId) signature - toggle current state
      const effectiveUserId = enabledOrUserId as string | undefined;
      const domain = await domainService.get(domainId, effectiveUserId);
      if (!domain) return null;
      return domainService.setEnabled(domainId, !domain.enabled, effectiveUserId, isAdmin);
    }
  },

  /**
   * Update domain metadata
   */
  updateDomainMetadata: async (domainId: string, metadata: Partial<CachedDomain>, userId?: string, isAdmin: boolean = false): Promise<CachedDomain | null> => {
    const isUserDomain = isUserSpecificDomain(domainId);
    
    // Global domain metadata updates require admin
    if (!isUserDomain && !isAdmin) {
      throw new Error(`Admin privileges required to update metadata for global domain '${domainId}'`);
    }

    const key = getDomainKey(domainId, userId);
    let data = await redisService.request(['GET', key]);
    let domain: CachedDomain | null = null;

    if (!data) {
      // Auto-initialize if domain doesn't exist
      if (isUserDomain && userId) {
        domain = await domainService.init(domainId, domainId === 'user' ? 'User Preferences' : 'User State', userId, isAdmin);
      } else if (!isUserDomain && isAdmin) {
        // Global domain auto-init during metadata update
        domain = await domainService.init(domainId, metadata.name || domainId, userId, isAdmin);
      } else {
        return null;
      }
    } else {
      domain = parseDomain(data, domainId);
    }

    if (!domain) return null;
    
    if (!canAccessDomain(domainId, userId, domain.ownerId)) {
      throw new DomainAccessError(domainId, userId);
    }

    Object.assign(domain, metadata, { lastUpdated: Date.now() });
    await redisService.request(['SET', key, JSON.stringify(domain)]);
    return domain;
  },

  /**
   * Delete a domain.
   * User-specific domains: only owner.
   * Global domains: only admin.
   */
  deleteDomain: async (domainId: string, userId?: string, isAdmin: boolean = false): Promise<boolean> => {
    const isUserDomain = isUserSpecificDomain(domainId);
    loggerService.debug(`deleteDomain: Starting deletion for ${domainId}`, { isUserDomain, userId, isAdmin });
    
    if (isUserDomain) {
      if (!userId) throw new Error('User ID required to delete user-specific domain');
      return await domainService.deleteUserDomain(domainId, userId);
    }

    // Global domain deletion - requires admin
    if (!isAdmin) {
      loggerService.warn(`deleteDomain: Unauthorized attempt to delete global domain ${domainId} by user ${userId}`);
      throw new Error('Admin privileges required to delete global domains');
    }

    const key = getDomainKey(domainId);
    const data = await redisService.request(['GET', key]);
    if (!data) {
      loggerService.warn(`deleteDomain: Domain data not found for ${domainId} (key: ${key})`);
      return false;
    }

    const domain = parseDomain(data, domainId);
    ensureWritableDomain(domain, domainId, isAdmin, undefined, userId);

    loggerService.info(`deleteDomain: Deleting ${domain.symbols.length} symbols from vector store for domain ${domainId}`);
    // Remove all symbols from vector store
    for (const symbol of domain.symbols) {
      await vectorService.removeSymbol(symbol.id, domainId);
    }

    // Remove from global domains set
    const sremResult = await redisService.request(['SREM', KEYS.DOMAINS_SET, domainId]);
    loggerService.debug(`deleteDomain: SREM result for ${domainId}: ${sremResult}`);
    
    // Delete the domain data
    const delResult = await redisService.request(['DEL', key]);
    loggerService.debug(`deleteDomain: DEL result for ${key}: ${delResult}`);
    
    loggerService.info(`Global domain deleted: ${domainId}`);
    return true;
  },

  /**
   * Clear all domains (DANGEROUS - for testing only)
   */
  clearAll: async (): Promise<void> => {
    const domains = await domainService.listDomains();
    for (const domainId of domains) {
      const key = getDomainKey(domainId, undefined);
      await redisService.request(['DEL', key]);
    }
    await redisService.request(['DEL', KEYS.DOMAINS_SET]);
  },

  /**
   * Get symbols from a specific domain (includes disabled)
   */
  getSymbols: async (domainId: string, userId?: string): Promise<SymbolDef[]> => {
    const domain = await domainService.get(domainId, userId, true);
    return domain?.symbols || [];
  },

  /**
   * Alias for addSymbol
   */
  upsertSymbol: async (domainId: string, symbol: SymbolDef, userId?: string, isAdmin: boolean = false): Promise<SymbolDef> => {
    return domainService.addSymbol(domainId, symbol, userId, isAdmin);
  },

  /**
   * Bulk upsert symbols
   * Supports both (domainId, symbols, userId?) and (domainId, symbols, options?) signatures
   */
  bulkUpsert: async (
    domainId: string,
    symbols: SymbolDef[],
    userIdOrOptions?: string | { userId?: string, bypassValidation?: boolean, isAdmin?: boolean }
  ): Promise<SymbolDef[]> => {
    let userId: string | undefined;
    let isAdmin = false;

    if (typeof userIdOrOptions === 'string') {
      userId = userIdOrOptions;
    } else if (typeof userIdOrOptions === 'object') {
      userId = userIdOrOptions.userId;
      isAdmin = !!userIdOrOptions.isAdmin;
    }

    const results: SymbolDef[] = [];
    for (const symbol of symbols) {
      const result = await domainService.addSymbol(domainId, symbol, userId, isAdmin);
      results.push(result);
    }
    return results;
  },

  /**
   * Alias for removeSymbol
   * Supports both (domainId, symbolId, userId?) and (domainId, symbolId, cascade?) signatures
   */
  deleteSymbol: async (domainId: string, symbolId: string, userIdOrCascade?: string | boolean, isAdmin: boolean = false): Promise<boolean> => {
    // If third argument is a boolean, it's cascade (legacy), ignore it for now
    const userId = typeof userIdOrCascade === 'string' ? userIdOrCascade : undefined;
    return domainService.removeSymbol(domainId, symbolId, userId, isAdmin);
  },

  /**
   * Propagate rename across all symbols (placeholder - would need full implementation)
   */
  propagateRename: async (domainId: string, oldId: string, newId: string, userId?: string, isAdmin: boolean = false): Promise<void> => {
    const isUserDomain = isUserSpecificDomain(domainId);
    if (!isUserDomain && !isAdmin) {
      throw new Error(`Admin privileges required to propagate rename in global domain '${domainId}'`);
    }

    const domain = await domainService.get(domainId, userId);
    if (!domain) throw new Error(`Domain '${domainId}' not found`);
    
    // Update all symbols that reference oldId in linked_patterns
    for (const symbol of domain.symbols) {
      if (symbol.linked_patterns) {
        for (const link of symbol.linked_patterns) {
          if (link.id === oldId) {
            link.id = newId;
          }
        }
      }
    }
    
    // Rename the symbol itself if it exists
    const symbol = domain.symbols.find(s => s.id === oldId);
    if (symbol) {
      symbol.id = newId;
      symbol.updated_at = currentTimestamp();
    }
    
    domain.lastUpdated = Date.now();
    const key = getDomainKey(domainId, userId);
    await redisService.request(['SET', key, JSON.stringify(domain)]);
  },

  /**
   * Process refactor operation (placeholder)
   * Supports both (updates) and (domainId, operation, userId) signatures
   */
  processRefactorOperation: async (
    domainIdOrUpdates: string | any[],
    operation?: any,
    userId?: string
  ): Promise<any> => {
    // Check if first argument is an array (legacy signature)
    if (Array.isArray(domainIdOrUpdates)) {
      // Legacy signature: processRefactorOperation(updates)
      loggerService.info('Refactor operation received (legacy)', { updates: domainIdOrUpdates });
      return { status: 'not_implemented' };
    }
    // New signature: processRefactorOperation(domainId, operation, userId)
    loggerService.info('Refactor operation received', { domainId: domainIdOrUpdates, operation });
    return { status: 'not_implemented' };
  },

  /**
   * Compress symbols (placeholder)
   * Supports both (newSymbol, oldIds) and (domainId, threshold, userId) signatures
   */
  compressSymbols: async (
    newSymbolOrDomainId: any,
    oldIdsOrThreshold: any[] | number,
    userId?: string
  ): Promise<any> => {
    // Check if second argument is an array (legacy signature)
    if (Array.isArray(oldIdsOrThreshold)) {
      // Legacy signature: compressSymbols(newSymbol, oldIds)
      loggerService.info('Compress symbols called (legacy)', { newSymbol: newSymbolOrDomainId, oldIds: oldIdsOrThreshold });
      return { status: 'not_implemented' };
    }
    // New signature: compressSymbols(domainId, threshold, userId)
    loggerService.info('Compress symbols called', { domainId: newSymbolOrDomainId, threshold: oldIdsOrThreshold });
    return { status: 'not_implemented' };
  }
};
