
import { FunctionDeclaration, Type } from "@google/genai";
import { domainService } from "./domainService.ts";
import { domainInferenceService } from "./domainInferenceService.ts";
import { testService } from "./testService.ts";
import { traceService } from "./traceService.ts";
import { LoopDefinition, LoopExecutionLog, SymbolDef, TraceData } from "../types.ts";
import { indexingService } from "./indexingService.ts";
import { loggerService } from "./loggerService.ts";
import { EXECUTION_ZSET_KEY, LOOP_INDEX_KEY, getExecutionKey, getLoopKey, getTraceKey } from "./loopStorage.js";
import { redisService } from "./redisService.js";
import { secretManagerService } from "./secretManagerService.ts";

// Shared Symbol Data Schema Properties for reuse in tools
const SYMBOL_DATA_SCHEMA = {
    type: Type.OBJECT,
    description: 'The full JSON object representing the Symbol schema.',
    properties: {
        id: { type: Type.STRING },
        kind: { type: Type.STRING, description: "Type of symbol: 'pattern', 'lattice', or 'persona'. Defaults to 'pattern'." },
        triad: { type: Type.STRING },
        macro: { type: Type.STRING },
        role: { type: Type.STRING },
        name: { type: Type.STRING },
        lattice: {
            type: Type.OBJECT,
            description: "Configuration for lattice symbols (execution topology)",
            properties: {
                topology: { type: Type.STRING, description: "inductive, deductive, bidirectional, invariant, energy" },
                closure: { type: Type.STRING, description: "loop, branch, collapse, constellation, synthesis" },
                members: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of member symbol IDs" }
            }
        },
        persona: {
            type: Type.OBJECT,
            description: "Configuration for persona symbols",
            properties: {
                recursion_level: { type: Type.STRING },
                function: { type: Type.STRING },
                activation_conditions: { type: Type.ARRAY, items: { type: Type.STRING } },
                fallback_behavior: { type: Type.ARRAY, items: { type: Type.STRING } },
                linked_personas: { type: Type.ARRAY, items: { type: Type.STRING } }
            }
        },
        facets: { 
            type: Type.OBJECT,
            properties: {
                function: { type: Type.STRING },
                topology: { type: Type.STRING },
                commit: { type: Type.STRING },
                gate: { type: Type.ARRAY, items: { type: Type.STRING } },
                substrate: { type: Type.ARRAY, items: { type: Type.STRING } },
                temporal: { type: Type.STRING },
                invariants: { type: Type.ARRAY, items: { type: Type.STRING } }
            },
            required: ['function', 'topology', 'commit', 'gate', 'substrate', 'temporal', 'invariants']
        },
        symbol_domain: { type: Type.STRING },
        symbol_tag: { type: Type.STRING },
        failure_mode: { type: Type.STRING },
        linked_patterns: { type: Type.ARRAY, items: { type: Type.STRING } }
    },
    required: ['id', 'kind', 'triad', 'macro', 'role', 'name', 'facets', 'symbol_domain', 'failure_mode', 'linked_patterns']
};

const TRACE_DATA_SCHEMA = {
    type: Type.OBJECT,
    description: 'The full JSON object representing a symbolic reasoning trace.',
    properties: {
        id: { type: Type.STRING },
        entry_node: { type: Type.STRING },
        activated_by: { type: Type.STRING },
        activation_path: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    symbol_id: { type: Type.STRING },
                    reason: { type: Type.STRING },
                    link_type: { type: Type.STRING }
                },
                required: ['symbol_id', 'reason', 'link_type']
            }
        },
        source_context: {
            type: Type.OBJECT,
            properties: {
                symbol_domain: { type: Type.STRING },
                trigger_vector: { type: Type.STRING }
            },
            required: ['symbol_domain', 'trigger_vector']
        },
        output_node: { type: Type.STRING },
        status: { type: Type.STRING }
    },
    required: ['entry_node', 'activated_by', 'activation_path', 'source_context', 'output_node', 'status']
};

type LoopExecutionLogWithTraces = LoopExecutionLog & { traces?: TraceData[] };

const fetchLoopDefinitions = async (): Promise<LoopDefinition[]> => {
    const ids = await redisService.request(['SMEMBERS', LOOP_INDEX_KEY]);
    if (!Array.isArray(ids) || ids.length === 0) return [];

    const loops: LoopDefinition[] = [];
    for (const id of ids) {
        const payload = await redisService.request(['GET', getLoopKey(id)]);
        if (!payload) continue;
        try {
            loops.push(JSON.parse(payload));
        } catch (error) {
            loggerService.error('ToolsService: Failed to parse loop payload', { id, error });
        }
    }
    return loops;
};

const fetchLoopExecutions = async (
    loopId?: string,
    limit: number = 20,
    includeTraces: boolean = false
): Promise<LoopExecutionLogWithTraces[]> => {
    const ids: string[] = await redisService.request(['ZRANGEBYSCORE', EXECUTION_ZSET_KEY, '-inf', '+inf']);
    const ordered = Array.isArray(ids) ? ids.slice().reverse() : [];
    const results: LoopExecutionLogWithTraces[] = [];

    for (const id of ordered) {
        if (results.length >= limit) break;
        const payload = await redisService.request(['GET', getExecutionKey(id)]);
        if (!payload) continue;

        try {
            const parsed: LoopExecutionLogWithTraces = JSON.parse(payload);
            if (!loopId || parsed.loopId === loopId) {
                if (includeTraces) {
                    const tracePayload = await redisService.request(['GET', getTraceKey(id)]);
                    if (tracePayload) {
                        try {
                            parsed.traces = JSON.parse(tracePayload) as TraceData[];
                        } catch (error) {
                            loggerService.error('ToolsService: Failed to parse execution traces', { id, error });
                        }
                    }
                }
                results.push(parsed);
            }
        } catch (error) {
            loggerService.error('ToolsService: Failed to parse loop execution', { id, error });
        }
    }

    return results;
};

// 1. Define the Schema for the tools
export const toolDeclarations: FunctionDeclaration[] = [
  // --- SignalZero Symbol Store Tools (Local Cache Only) ---
  {
    name: 'find_symbols',
    description: 'Unified symbol finder combining structured filters and semantic vector search with optional metadata pre-filters.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'Semantic search query. If omitted, results are filtered using structured metadata and domain constraints only.',
        },
        symbol_domain: {
          type: Type.STRING,
          description: 'Filter symbols by domain (e.g., root, diagnostics). Defaults to "root". Can be a single domain or list.',
        },
        symbol_domains: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'Provide multiple domains to search across in a single query.',
        },
        symbol_tag: {
          type: Type.STRING,
          description: 'Filter symbols by tag (e.g., system, ritual).',
        },
        metadata_filter: {
          type: Type.OBJECT,
          description: 'Metadata filter applied before semantic search (e.g., { "symbol_domain": "defense", "symbol_tag": "protocol" }). Accepts arrays for multi-domain filtering.',
          additionalProperties: true,
        },
        last_symbol_id: {
          type: Type.STRING,
          description: 'The ID of the last symbol from the previous page, used for cursor-based pagination.',
        },
        limit: {
          type: Type.INTEGER,
          description: 'Maximum number of symbols to return (default 20, max 20).',
        },
        fetch_all: {
          type: Type.BOOLEAN,
          description: 'If true, iteratively fetches ALL pages for the specified domain until complete.',
        }
      },
      required: [],
    },
  },
  {
    name: 'load_symbols',
    description: 'Retrieve multiple symbols at once by their IDs. Useful for expanding a list of linked patterns.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        ids: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of symbol IDs to retrieve.',
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'delete_symbols',
    description: 'Permanently remove one or more symbols from the registry. CAUTION: Only use this tool when explicitly instructed by the user, or when completing a merge/refactor operation where a new replacement symbol has successfully been created.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol_ids: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'The IDs of the symbols to delete.' },
        symbol_domain: { type: Type.STRING, description: 'The domain the symbols belong to (optional, inferred if missing).' },
        cascade: { type: Type.BOOLEAN, description: 'If true, removes references to this symbol from other symbols (linked_patterns, members). Defaults to true.' }
      },
      required: ['symbol_ids']
    }
  },
  {
    name: 'upsert_symbols',
    description: 'Upsert multiple symbols at once. Supports updates, renames (with old_id), and new symbol additions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbols: {
          type: Type.ARRAY,
          description: 'List of symbol upsert operations.',
          items: {
            type: Type.OBJECT,
            properties: {
              old_id: { type: Type.STRING, description: 'Optional existing ID for rename or update. If omitted, a new symbol will be added.' },
              // Explicitly reuse the full schema here so the model doesn't send empty objects
              symbol_data: SYMBOL_DATA_SCHEMA
            },
            required: ['symbol_data']
          }
        }
      },
      required: ['symbols'],
    }
  },
    {
      name: 'compress_symbols',
    description: 'Merge multiple existing symbols into a single new symbol (compression). This action stores the new symbol, updates all references in the domain to point to it, and then deletes the old symbols.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        new_symbol: SYMBOL_DATA_SCHEMA,
        old_ids: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: 'List of old symbol IDs to remove after merging.'
        }
      },
      required: ['new_symbol', 'old_ids']
    }
  },
  {
    name: 'create_domain',
    description: 'Create a new SignalZero domain. When only a domain id and description are provided, the tool infers invariants using semantic similarity to the root domain and the two closest domains before saving.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        domain_id: { type: Type.STRING, description: 'The unique id/slug for the domain.' },
        name: { type: Type.STRING, description: 'Optional display name for the domain.' },
        description: { type: Type.STRING, description: 'Human-readable description of the new domain.' },
        invariants: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Optional explicit invariants. If omitted, the tool will infer them.' }
      },
    required: ['domain_id', 'description']
  }
  },
  {
    name: 'list_domains',
    description: 'List all available symbol domains in the local registry. Returns name, id, description, invariant constraints, list of symbol_ids, and full definitions for persona symbols.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'list_loops',
    description: 'List configured background loops with their schedules, prompts, and status flags.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'list_loop_executions',
    description: 'List recent loop execution logs. Optionally filter by loop id and include symbolic traces.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        loop_id: { type: Type.STRING, description: 'Filter executions to a specific loop id.' },
        limit: { type: Type.INTEGER, description: 'Maximum number of executions to return (default 20).' },
        include_traces: { type: Type.BOOLEAN, description: 'Include symbolic traces captured during each execution.' }
      },
    },
  },
  {
    name: 'add_test_case',
    description: 'Add a new test case prompt to the persistent Test Runner suite.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        name: {
          type: Type.STRING,
          description: 'A human-friendly name for the test case.',
        },
        prompt: {
          type: Type.STRING,
          description: 'The prompt string to verify or test the system with.',
        },
        testSetId: {
          type: Type.STRING,
          description: 'Identifier of the test set to append the case to.'
        },
        expectedActivations: {
          type: Type.ARRAY,
          description: 'List of symbol IDs that must appear in the resulting trace for the test to pass.',
          items: { type: Type.STRING }
        }
      },
      required: ['name', 'prompt', 'testSetId', 'expectedActivations'],
    },
  },
  {
    name: 'list_test_sets',
    description: 'List all configured test sets with their metadata and test case names.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'delete_test_case',
    description: 'Delete an existing test case from a specific test set.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        testSetId: {
          type: Type.STRING,
          description: 'Identifier of the test set that contains the test case.'
        },
        testId: {
          type: Type.STRING,
          description: 'Identifier of the test case to remove.'
        }
      },
      required: ['testSetId', 'testId'],
    },
  },
  {
    name: 'reindex_vector_store',
    description: 'Reset the ChromaDB collection and rebuild the vector index from the current symbol store.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        include_disabled: {
          type: Type.BOOLEAN,
          description: 'If true, include symbols from disabled domains in the reindex job.'
        }
      }
    }
  },
  {
    name: 'web_fetch',
    description: 'Fetch a URL over HTTP(S) and return the response body for downstream analysis.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: 'The absolute URL to fetch (http or https).'
        },
        headers: {
          type: Type.OBJECT,
          description: 'Optional custom HTTP headers to include in the request. Values must be strings.',
          additionalProperties: true
        }
      },
      required: ['url']
    }
  },
  {
    name: 'web_search',
    description: 'Perform a Google Custom Search for a query and return structured JSON results.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The search query to look up on Google Custom Search.'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'list_secrets',
    description: 'List secrets from Google Secret Manager using the configured inference API key.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        project_id: {
          type: Type.STRING,
          description: 'Optional GCP project ID override. Defaults to GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT environment variables.'
        },
        page_size: {
          type: Type.INTEGER,
          description: 'Number of secrets to fetch (1-250). Defaults to the Secret Manager service default.'
        },
        page_token: {
          type: Type.STRING,
          description: 'Pagination token from a previous list_secrets call.'
        }
      },
      required: []
    }
  },
  {
    name: 'get_secret',
    description: 'Retrieve a secret value from Google Secret Manager using the configured inference API key.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        secret_id: {
          type: Type.STRING,
          description: 'ID of the secret to retrieve (without the project path).'
        },
        version: {
          type: Type.STRING,
          description: "Secret version to access (defaults to 'latest')."
        },
        project_id: {
          type: Type.STRING,
          description: 'Optional GCP project ID override. Defaults to GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT environment variables.'
        }
      },
      required: ['secret_id']
    }
  },
  {
    name: 'log_trace',
    description: 'Log a symbolic reasoning trace. This must be called for every symbolic operation or deduction chain to maintain the recursive log.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        trace: TRACE_DATA_SCHEMA
      },
      required: ['trace']
    }
  }
];

// 2. Define the execution logic
export const createToolExecutor = (getApiKey: () => string | null) => {
  return async (name: string, args: any): Promise<any> => {
    console.log(`[ToolExecutor] Executing ${name} with`, args);
    
    switch (name) {
      
      case 'find_symbols': {
        const { query, symbol_domain, symbol_domains, symbol_tag, limit, last_symbol_id, fetch_all, time_gte, time_between, metadata_filter } = args || {};

        const maxLimit = Math.min(limit || 20, 20);
        const domainsInput = symbol_domains ?? symbol_domain ?? 'root';
        const domains = Array.isArray(domainsInput)
          ? domainsInput.filter(Boolean)
          : [domainsInput];
        const uniqueDomains = Array.from(new Set(domains.length > 0 ? domains : ['root']));

        const availability = await Promise.all(uniqueDomains.map((d) => domainService.hasDomain(d)));
        const availableDomains = uniqueDomains.filter((_, i) => availability[i]);
        const missingDomains = uniqueDomains.filter((_, i) => !availability[i]);

        const defaultDomains = availableDomains.length > 0 ? availableDomains : await domainService.listDomains();
        const mergedMetadataFilter: Record<string, unknown> = { ...(metadata_filter || {}) };

        if (symbol_tag) mergedMetadataFilter.symbol_tag = mergedMetadataFilter.symbol_tag ?? symbol_tag;

        if (!mergedMetadataFilter.symbol_domain && !mergedMetadataFilter.domain) {
            if (defaultDomains.length === 1) {
                mergedMetadataFilter.symbol_domain = defaultDomains[0];
            } else if (defaultDomains.length > 1) {
                mergedMetadataFilter.symbol_domain = defaultDomains;
            }
        } else if (mergedMetadataFilter.symbol_domain && Array.isArray(mergedMetadataFilter.symbol_domain) && availableDomains.length > 0) {
            mergedMetadataFilter.symbol_domain = (mergedMetadataFilter.symbol_domain as unknown[])
                .filter((d) => availableDomains.includes(String(d)));
        }

        const matchesMetadata = (symbol: any, filter?: Record<string, unknown>): boolean => {
            if (!filter || Object.keys(filter).length === 0) return true;
            return Object.entries(filter).every(([key, value]) => {
                if (value === undefined || value === null) return true;
                const symbolValue = symbol?.[key];
                if (symbolValue === undefined || symbolValue === null) return false;
                const filterValues = Array.isArray(value) ? value : [value];
                return filterValues.some((fv) => {
                    if (Array.isArray(symbolValue)) return symbolValue.map(String).includes(String(fv));
                    return String(symbolValue) === String(fv);
                });
            });
        };

        const wantsSemantic = !!(query && query.trim().length > 0) || !!time_gte || (Array.isArray(time_between) && time_between.length > 0);

        if (wantsSemantic) {
            const results = await domainService.search(query ?? null, limit || 5, {
                time_gte,
                time_between,
                metadata_filter: mergedMetadataFilter,
                domains: defaultDomains
            });

            const response: any = {
                count: results.length,
                results,
                query,
                time_gte,
                time_between,
                bucket_scope: 'utc_day',
                timestamp_format: 'milliseconds_since_epoch_base64',
                missing_domains: missingDomains.length > 0 ? missingDomains : undefined,
            };

            if ((query && query.trim().length > 0) && results.length === 0) {
                response.message = "No relevant symbols found via vector search. Check connection to ChromaDB.";
            }

            return response;
        }

        const symbols: any[] = [];
        const pageInfoEntries: any[] = [];

        for (const domain of defaultDomains) {
            const domainSymbols = await domainService.getSymbols(domain);
            const filtered = domainSymbols.filter((s) => matchesMetadata(s, mergedMetadataFilter));

            if (fetch_all) {
                symbols.push(...filtered);
                continue;
            }

            let startIndex = 0;
            if (last_symbol_id) {
                const foundIndex = filtered.findIndex((s) => s.id === last_symbol_id);
                if (foundIndex !== -1) startIndex = foundIndex + 1;
            }

            const paged = filtered.slice(startIndex, startIndex + maxLimit);
            symbols.push(...paged);
            pageInfoEntries.push({
                domain,
                limit: maxLimit,
                last_id: paged.length > 0 ? paged[paged.length - 1].id : null
            });
        }

        return {
            count: symbols.length,
            symbols,
            page_info: pageInfoEntries.length === 1 ? pageInfoEntries[0] : pageInfoEntries,
            source: "redis_cache",
            status: fetch_all ? "Full domain load complete" : undefined,
            missing_domains: missingDomains.length > 0 ? missingDomains : undefined,
        };
      }

      case 'load_symbols': {
          const { ids } = args;
          if (!ids || !Array.isArray(ids)) return { error: "Invalid IDs array" };

          const found = [];
          const missing = [];

          for (const id of ids) {
              const sym = await domainService.findById(id);
              if (sym) found.push(sym);
              else missing.push(id);
          }

          return {
              found_count: found.length,
              symbols: found,
              missing_ids: missing
          };
      }

      case 'upsert_symbols': {
          const { symbols } = args;
          if (!symbols || !Array.isArray(symbols) || symbols.length === 0) return { error: "Invalid symbols array" };

          const upsertByDomain: Record<string, SymbolDef[]> = {};
          const refactors: { old_id: string, symbol_data: SymbolDef }[] = [];
          const domainsToCheck = new Set<string>();

          for (const entry of symbols) {
              const { symbol_data, old_id } = entry || {};
              if (!symbol_data || typeof symbol_data !== 'object') return { error: "Each entry must include symbol_data" };

              const domain = symbol_data.symbol_domain || 'root';
              domainsToCheck.add(domain);

              if (old_id && old_id !== symbol_data.id) {
                  refactors.push({ old_id, symbol_data });
                  continue;
              }

              if (!upsertByDomain[domain]) upsertByDomain[domain] = [];
              upsertByDomain[domain].push(symbol_data);
          }

          const missingDomains: string[] = [];
          await Promise.all(Array.from(domainsToCheck).map(async (domain) => {
              const exists = await domainService.hasDomain(domain);
              if (!exists) missingDomains.push(domain);
          }));

          if (missingDomains.length > 0) {
              return { error: `Domains not found: ${missingDomains.join(', ')}` , missing_domains: missingDomains, code: 404 };
          }

          try {
              const upserted: { domain: string, count: number }[] = [];
              for (const [domain, domainSymbols] of Object.entries(upsertByDomain)) {
                  if (domainSymbols.length === 0) continue;
                  await domainService.bulkUpsert(domain, domainSymbols);
                  upserted.push({ domain, count: domainSymbols.length });
              }

              if (refactors.length > 0) {
                  await domainService.processRefactorOperation(refactors);
              }

              return {
                  status: "Upsert completed.",
                  upserted,
                  refactor_count: refactors.length,
              };
          } catch (e) {
              return { error: `Upsert failed: ${String(e)}` };
          }
      }

      case 'delete_symbols': {
          const { symbol_ids, symbol_domain, cascade = true } = args;
          if (!symbol_ids || !Array.isArray(symbol_ids) || symbol_ids.length === 0) return { error: "Missing symbol_ids" };

          const domainMap: Record<string, string[]> = {};
          const missingIds: string[] = [];

          if (symbol_domain) {
              domainMap[symbol_domain] = symbol_ids;
          } else {
              for (const id of symbol_ids) {
                  const sym = await domainService.findById(id);
                  if (sym?.symbol_domain) {
                      if (!domainMap[sym.symbol_domain]) domainMap[sym.symbol_domain] = [];
                      domainMap[sym.symbol_domain].push(id);
                  } else {
                      missingIds.push(id);
                  }
              }
          }

          try {
              const deleted: { domain: string, count: number }[] = [];
              for (const [domain, ids] of Object.entries(domainMap)) {
                  if (ids.length === 0) continue;
                  await domainService.deleteSymbols(domain, ids, cascade);
                  deleted.push({ domain, count: ids.length });
              }

              return {
                  status: deleted.length > 0 ? "success" : "no-op",
                  deleted,
                  missing_ids: missingIds.length > 0 ? missingIds : undefined,
                  cascade_performed: cascade
              };
          } catch (e) {
              return { error: `Delete failed: ${String(e)}` };
          }
      }

      case 'compress_symbols': {
          const { new_symbol, old_ids } = args;
          if (!new_symbol || !old_ids || !Array.isArray(old_ids)) {
              return { error: "Invalid arguments for compression. Requires new_symbol object and old_ids array." };
          }

          try {
              const results = await domainService.compressSymbols(new_symbol, old_ids);
              return {
                  status: "Compression complete.",
                  new_symbol_id: results.newId,
                  removed_symbols_count: results.removedIds.length,
                  removed_ids: results.removedIds
              };
          } catch (e) {
              return { error: `Compression failed: ${String(e)}` };
          }
      }

      case 'create_domain': {
          const { domain_id, description, name, invariants } = args;
          if (!domain_id || !description) {
              return { error: "Missing domain_id or description." };
          }

          const exists = await domainService.hasDomain(domain_id);
          if (exists) {
              return { error: `Domain '${domain_id}' already exists.`, code: 409 };
          }

          try {
              if (Array.isArray(invariants) && invariants.length > 0) {
                  const created = await domainService.createDomain(domain_id, {
                      name: name || domain_id,
                      description,
                      invariants,
                  });

                  return {
                      status: "Domain created with provided invariants.",
                      domain: created,
                  };
              }

              const result = await domainInferenceService.createDomainWithInference(domain_id, description, name);
              return {
                  status: "Domain created with inferred invariants.",
                  domain: result.domain,
                  inferred_from: result.inferred_from,
                  reasoning: result.reasoning,
              };
          } catch (e) {
              return { error: `Failed to create domain: ${String(e)}` };
          }
      }

      case 'list_domains': {
        try {
          // Pure local list with metadata
          const metaList = await domainService.getMetadata();

          // Map to simpler format for the model, sorting alphabetically
          // ENRICHMENT: Include full persona objects per domain
          // Since getMetadata is async, metaList is the array result
          const domainResponsePromises = metaList
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(async d => {
              const allSymbols = await domainService.getSymbols(d.id);
              // Filter for full symbol definitions where kind is 'persona'
              const personas = allSymbols.filter(s => s.kind === 'persona');

              return {
                id: d.id,
                name: d.name,
                description: d.description || "No description provided.",
                invariants: d.invariants || [],
                personas: personas
              };
            });

          const domainResponse = await Promise.all(domainResponsePromises);

          return { domains: domainResponse };
        } catch (error) {
          console.error("Tool execution failed:", error);
          return { error: `Failed to list domains: ${String(error)}` };
        }
      }

      case 'list_loops': {
          const loops = await fetchLoopDefinitions();
          return { loops };
      }

      case 'list_loop_executions': {
          const { loop_id, limit, include_traces } = args || {};
          const parsedLimit = Number.isFinite(limit) ? Math.min(Math.max(Number(limit), 1), 100) : 20;
          const logs = await fetchLoopExecutions(
              typeof loop_id === 'string' ? loop_id : undefined,
              parsedLimit,
              include_traces === true
          );
          return { logs };
      }

      case 'add_test_case': {
          const { name, prompt, testSetId, expectedActivations } = args;
          if (!name || !prompt || !testSetId || !Array.isArray(expectedActivations)) return { error: "Missing name, prompt, testSetId, or expectedActivations argument" };

          await testService.addTest(testSetId, prompt, expectedActivations, name);
          return {
              status: "Test case added successfully to persistent suite.",
              name,
              prompt: prompt,
              testSetId,
              expectedActivations
          };
      }

      case 'list_test_sets': {
          const sets = await testService.listTestSets();
          return {
              count: sets.length,
              testSets: sets.map(set => ({
                  id: set.id,
                  name: set.name,
                  description: set.description,
                  tests: set.tests.map(test => ({ id: test.id, name: test.name, prompt: test.prompt, expectedActivations: test.expectedActivations }))
              }))
          };
      }

      case 'delete_test_case': {
          const { testSetId, testId } = args;
          if (!testSetId || !testId) return { error: "Missing testSetId or testId argument" };

          await testService.deleteTest(testSetId, testId);
          return {
              status: "Test case deleted successfully from persistent suite.",
              testSetId,
              testId
          };
      }

      case 'reindex_vector_store': {
          const { include_disabled } = args || {};
          const result = await indexingService.reindexSymbols(include_disabled === true);
          return {
              status: result.status,
              indexed: result.indexedCount,
              total: result.totalSymbols,
              reset_performed: result.resetPerformed,
              failed_ids: result.failedIds,
              last_reindex_at: result.lastReindexAt,
              queue: result.queue
          };
      }

      case 'web_fetch': {
          const { url, headers } = args;
          if (!url || typeof url !== 'string') {
              return { error: "Missing or invalid 'url' argument." };
          }

          if (headers !== undefined && (headers === null || typeof headers !== 'object' || Array.isArray(headers))) {
              return { error: "Invalid 'headers' argument: expected an object with string values." };
          }

          const requestHeaders: Record<string, string> = {
              'User-Agent': 'Mozilla/5.0 (compatible; SignalZeroBot/1.0; +https://signalzero.ai)',
          };

          if (headers && typeof headers === 'object') {
              for (const [key, value] of Object.entries(headers)) {
                  if (typeof value === 'string') {
                      requestHeaders[key] = value;
                  }
              }
          }

          try {
              const response = await fetch(url, {
                  headers: requestHeaders
              });

              const text = await response.text();
              return {
                  url,
                  status: response.status,
                  content_type: response.headers.get('content-type'),
                  content: text,
                  content_length: text.length
              };
          } catch (error) {
              return { error: `Failed to fetch URL: ${String(error)}` };
          }
      }

      case 'web_search': {
          const { query } = args;
          if (!query || typeof query !== 'string') {
              return { error: "Missing or invalid 'query' argument." };
          }

          try {
              const apiKey = process.env.API_KEY || process.env.GOOGLE_CUSTOM_SEARCH_KEY || process.env.GOOGLE_SEARCH_KEY;
              const searchEngineId = process.env.GOOGLE_CSE_ID || process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CUSTOM_SEARCH_CX;

              if (!apiKey) {
                  return { error: 'Google Custom Search failed: Missing GOOGLE_API_KEY environment variable.' };
              }

              if (!searchEngineId) {
                  return { error: 'Google Custom Search failed: Missing search engine ID (set GOOGLE_CSE_ID or GOOGLE_SEARCH_ENGINE_ID).' };
              }

              const searchUrl = new URL('https://customsearch.googleapis.com/customsearch/v1');
              searchUrl.searchParams.set('key', apiKey);
              searchUrl.searchParams.set('cx', searchEngineId);
              searchUrl.searchParams.set('q', query);
              searchUrl.searchParams.set('num', '5');

              const response = await fetch(searchUrl.toString(), {
                  headers: {
                      'User-Agent': 'Mozilla/5.0 (compatible; SignalZeroBot/1.0; +https://signalzero.ai)',
                      'Accept': 'application/json'
                  }
              });

              if (!response.ok) {
                  return { error: `Google Custom Search failed: HTTP ${response.status}` };
              }

              const bodyText = await response.text();

              let json;
              try {
                  json = JSON.parse(bodyText);
              } catch (parseError) {
                  return { error: `Google Custom Search failed: Invalid JSON (${String(parseError)})`, response_preview: bodyText.slice(0, 200) };
              }

              const items = Array.isArray(json.items) ? json.items : [];
              const results = items.map((item: any) => ({
                  title: item.title,
                  snippet: item.snippet || item.htmlSnippet,
                  url: item.link,
                  display_link: item.displayLink,
                  mime: item.mime
              }));

              loggerService.info('Web Search Response', {
                  query,
                  status: response.status,
                  content_type: response.headers.get('content-type') || 'unknown',
                  content_length: bodyText.length,
                  result_count: results.length
              });

              return {
                  query,
                  search_engine: 'google_custom_search',
                  total_results: json.searchInformation?.totalResults,
                  results
              };
          } catch (error) {
              return { error: `Google Custom Search failed: ${String(error)}` };
          }
      }

      case 'list_secrets': {
          const { project_id, page_size, page_token } = args || {};
          try {
              const result = await secretManagerService.listSecrets({
                  projectId: typeof project_id === 'string' && project_id.trim() ? project_id.trim() : undefined,
                  pageSize: Number.isFinite(page_size) ? Number(page_size) : undefined,
                  pageToken: typeof page_token === 'string' && page_token.trim() ? page_token : undefined
              });
              return result;
          } catch (error) {
              return { error: `Failed to list secrets: ${String(error)}` };
          }
      }

      case 'get_secret': {
          const { secret_id, version, project_id } = args || {};
          if (!secret_id || typeof secret_id !== 'string') {
              return { error: "Missing secret_id argument" };
          }

          const safeVersion = typeof version === 'string' && version.trim() ? version.trim() : 'latest';

          try {
              return await secretManagerService.accessSecretVersion(
                  secret_id,
                  safeVersion,
                  typeof project_id === 'string' && project_id.trim() ? project_id.trim() : undefined
              );
          } catch (error) {
              return { error: `Failed to access secret: ${String(error)}` };
          }
      }

      case 'log_trace': {
          const { trace } = args;
          if (!trace) return { error: "Missing trace argument" };

          traceService.addTrace(trace as TraceData);
          return { status: "Trace logged successfully." };
      }

      default:
        return { error: `Function ${name} not found.` };
    }
  };
};
