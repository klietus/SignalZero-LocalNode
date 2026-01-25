
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { domainService } from "./domainService.ts";
import { domainInferenceService } from "./domainInferenceService.ts";
import { loopService } from "./loopService.ts";
import { testService } from "./testService.ts";
import { traceService } from "./traceService.ts";
import { LoopDefinition, LoopExecutionLog, SymbolDef, TraceData } from "../types.ts";
import { indexingService } from "./indexingService.ts";
import { loggerService } from "./loggerService.ts";
import { EXECUTION_ZSET_KEY, LOOP_INDEX_KEY, getExecutionKey, getLoopKey, getTraceKey } from "./loopStorage.js";
import { redisService } from "./redisService.js";
import { secretManagerService } from "./secretManagerService.ts";
import { contextService } from "./contextService.js";
import { documentMeaningService } from "./documentMeaningService.js";
import { runSignalZeroTest } from "./inferenceService.js";

// Shared Symbol Data Schema Properties for reuse in tools
const SYMBOL_DATA_SCHEMA = {
    type: 'object',
    description: 'The full JSON object representing the Symbol schema.',
    properties: {
        id: { type: 'string' },
        kind: { type: 'string', description: "Type of symbol: 'pattern', 'lattice', 'persona', or 'data'. Defaults to 'pattern'." },
        triad: { type: 'string' },
        macro: { type: 'string' },
        role: { type: 'string' },
        name: { type: 'string' },
        lattice: {
            type: 'object',
            description: "Configuration for lattice symbols (execution topology)",
            properties: {
                topology: { type: 'string', description: "inductive, deductive, bidirectional, invariant, energy" },
                closure: { type: 'string', description: "loop, branch, collapse, constellation, synthesis" }
            }
        },
        persona: {
            type: 'object',
            description: "Configuration for persona symbols",
            properties: {
                recursion_level: { type: 'string' },
                function: { type: 'string' },
                fallback_behavior: { type: 'array', items: { type: 'string' } },
                linked_personas: { type: 'array', items: { type: 'string' } }
            }
        },
        data: {
            type: 'object',
            description: "Configuration for data symbols (key-value store)",
            properties: {
                source: { type: 'string', description: "Origin of the data." },
                verification: { type: 'string', description: "Verification status or method." },
                status: { type: 'string', description: "Current status of the data." },
                payload: { 
                    type: 'object', 
                    additionalProperties: true, 
                    description: "Key-value store for arbitrary data." 
                }
            }
        },
        activation_conditions: { type: 'array', items: { type: 'string' } },
        facets: {
            type: 'object',
            properties: {
                function: { type: 'string' },
                topology: { type: 'string' },
                commit: { type: 'string' },
                gate: { type: 'array', items: { type: 'string' } },
                substrate: { 
                    type: 'array', 
                    items: { 
                        type: 'string',
                        enum: [
                            'text', 'code', 'image', 'audio', 'video', 'data', 'event', 'signal', 
                            'state', 'process', 'concept', 'relation',
                            'cognitive', 'symbolic', 'temporal', 'social', 'biological', 
                            'physical', 'digital', 'virtual', 'abstract', 'meta'
                        ]
                    },
                    description: "Physical or logical medium where the symbol manifests. Must be one of the allowed values."
                },
                temporal: { type: 'string' },
                invariants: { type: 'array', items: { type: 'string' } }
            },
            required: ['function', 'topology', 'commit', 'gate', 'substrate', 'temporal', 'invariants']
        },
        symbol_domain: { type: 'string' },
        symbol_tag: { type: 'string' },
        failure_mode: { type: 'string' },
        linked_patterns: { type: 'array', items: { type: 'string' }, description:"valid persistent, existing ids for other symbols." }
    },
    required: ['id', 'kind', 'triad', 'macro', 'role', 'name', 'activation_conditions', 'facets', 'symbol_domain', 'failure_mode', 'linked_patterns']
};

const TRACE_DATA_SCHEMA = {
    type: 'object',
    description: 'The full JSON object representing a symbolic reasoning trace.',
    properties: {
        id: { type: 'string' },
        entry_node: { type: 'string' },
        activated_by: { type: 'string' },
        activation_path: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    symbol_id: { type: 'string' },
                    reason: { type: 'string' },
                    link_type: { type: 'string' }
                },
                required: ['symbol_id', 'reason', 'link_type']
            }
        },
        source_context: {
            type: 'object',
            properties: {
                symbol_domain: { type: 'string' },
                trigger_vector: { type: 'string' }
            },
            required: ['symbol_domain', 'trigger_vector']
        },
        output_node: { type: 'string' },
        status: { type: 'string' }
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
export const toolDeclarations: ChatCompletionTool[] = [
  // --- SignalZero Symbol Store Tools (Local Cache Only) ---
  {
    type: 'function',
    function: {
      name: 'find_symbols',
      description: 'Unified symbol finder that accepts multiple search queries at once. Supports semantic vector search and structured metadata filtering. Results from all queries are aggregated and deduplicated.',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            description: 'List of search queries to execute in parallel.',
            items: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Semantic search string. Only applied if provided.' },
                symbol_domains: { type: 'array', items: { type: 'string' }, description: 'Filter by multiple domains. Defaults to all domains if omitted.' },
                symbol_tag: { type: 'string', description: 'Filter by symbol tag. Only applied if provided.' },
                metadata_filter: { type: 'object', additionalProperties: true, description: 'Direct metadata key-value filters. Only applied if provided.' },
                limit: { type: 'integer', description: 'Maximum symbols to return for this specific query (default 10, max 20).' },
                time_gte: { type: 'string', description: "Filter by creation time >= timestamp. Only applied if provided." },
                time_between: { type: 'array', items: { type: 'string' }, description: "Filter by creation time range [start, end]. Only applied if provided." },
                fetch_all: { type: 'boolean', description: "Fetch all matching symbols for this query (bypass limit)." }
              }
            }
          }
        },
        required: ['queries'],
      },
    }
  },
  {
    type: 'function',
    function: {
      name: 'load_symbols',
      description: 'Retrieve multiple symbols at once by their IDs. Useful for expanding a list of linked patterns.',
      parameters: {
        type: 'object',
        properties: {
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of symbol IDs to retrieve.',
          },
        },
        required: ['ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_symbols',
      description: 'Permanently remove one or more symbols from the registry. CAUTION: Only use this tool when explicitly instructed by the user, or when completing a merge/refactor operation where a new replacement symbol has successfully been created.',
      parameters: {
        type: 'object',
        properties: {
          symbol_ids: { type: 'array', items: { type: 'string' }, description: 'The IDs of the symbols to delete.' },
          symbol_domain: { type: 'string', description: 'The domain the symbols belong to (optional, inferred if missing).' },
          cascade: { type: 'boolean', description: 'If true, removes references to this symbol from other symbols (linked_patterns, members). Defaults to true.' }
        },
        required: ['symbol_ids']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'upsert_symbols',
      description: 'Upsert multiple symbols at once. Supports updates, renames (with old_id), and new symbol additions.',
      parameters: {
        type: 'object',
        properties: {
          symbols: {
            type: 'array',
            description: 'List of symbol upsert operations.',
            items: {
              type: 'object',
              properties: {
                old_id: { type: 'string', description: 'Optional existing ID for rename or update. If omitted, a new symbol will be added.' },
                // Explicitly reuse the full schema here so the model doesn't send empty objects
                symbol_data: SYMBOL_DATA_SCHEMA
              },
              required: ['symbol_data']
            }
          }
        },
        required: ['symbols'],
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_domain',
      description: 'Create a new SignalZero domain. When only a domain id and description are provided, the tool infers invariants using semantic similarity to the root domain and the two closest domains before saving.',
      parameters: {
        type: 'object',
        properties: {
          domain_id: { type: 'string', description: 'The unique id/slug for the domain.' },
          name: { type: 'string', description: 'Optional display name for the domain.' },
          description: { type: 'string', description: 'Human-readable description of the new domain.' },
          invariants: { type: 'array', items: { type: 'string' }, description: 'Optional explicit invariants. If omitted, the tool will infer them.' }
        },
      required: ['domain_id', 'description']
    }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_domains',
      description: 'List all available symbol domains in the local registry. Returns name, id, description, invariant constraints, list of symbol_ids, and full definitions for persona symbols.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'upsert_loop',
      description: 'Create or update a background loop definition, adjusting its schedule, prompt, and enabled status.',
      parameters: {
        type: 'object',
        properties: {
          loop_id: { type: 'string', description: 'Unique identifier for the loop. Will be created if it does not exist.' },
          schedule: { type: 'string', description: 'Cron expression defining how often the loop should run.' },
          prompt: { type: 'string', description: 'Loop prompt that will be appended to the activation prompt before execution.' },
          enabled: { type: 'boolean', description: 'Set to true to enable the loop or false to disable it.' },
        },
        required: ['loop_id', 'schedule', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_loops',
      description: 'List configured background loops with their schedules, prompts, and status flags.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_loop_executions',
      description: 'List recent loop execution logs. Optionally filter by loop id and include symbolic traces.',
      parameters: {
        type: 'object',
        properties: {
          loop_id: { type: 'string', description: 'Filter executions to a specific loop id.' },
          limit: { type: 'integer', description: 'Maximum number of executions to return (default 20).' },
          include_traces: { type: 'boolean', description: 'Include symbolic traces captured during each execution.' }
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_test_runs',
      description: 'Retrieve a list of all historical and active test runs with their summary metadata.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_test_failures',
      description: 'Get a detailed report of failed test cases for a specific test run.',
      parameters: {
        type: 'object',
        properties: {
          run_id: { type: 'string', description: 'The unique ID of the test run to analyze.' }
        },
        required: ['run_id']
      }
    }
  },
    {
      type: 'function',
      function: {
        name: 'reindex_vector_store',
      description: 'Reset the ChromaDB collection and rebuild the vector index from the current symbol store.',
      parameters: {
        type: 'object',
        properties: {
          include_disabled: {
            type: 'boolean',
            description: 'If true, include symbols from disabled domains in the reindex job.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a URL over HTTP(S) and return the response body for downstream analysis.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'The absolute URL to fetch (http or https).'
          },
          headers: {
            type: 'object',
            description: 'Optional custom HTTP headers to include in the request. Values must be strings.',
            additionalProperties: true
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_post',
      description: 'Submit data to a web URL (POST, PUT, DELETE, etc.) and return the response. Supports JSON bodies and form data.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The absolute URL to send data to.' },
          method: { type: 'string', description: 'HTTP method (POST, PUT, PATCH, DELETE). Defaults to POST.' },
          headers: {
            type: 'object',
            description: 'Optional custom HTTP headers.',
            additionalProperties: true
          },
          body: {
            type: 'string',
            description: 'Raw body content (e.g. JSON string). Mutually exclusive with form_data.'
          },
          form_data: {
            type: 'object',
            description: 'Key-value pairs for form submission (application/x-www-form-urlencoded). Mutually exclusive with body.',
            additionalProperties: true
          }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Perform a Google Custom Search for a query and return structured JSON results.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query to look up on Google Custom Search.'
          },
          queries: {
            type: 'array',
            description: 'Optional list of multiple search queries to execute in parallel. If provided, "query" is ignored.',
            items: {
              type: 'object',
              properties: {
                query: { type: 'string' }
              },
              required: ['query']
            }
          },
          image_search: {
            type: 'boolean',
            description: 'If true, performs an image search instead of a web search.'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_secrets',
      description: 'List secrets from Google Secret Manager using the configured service account credentials.',
      parameters: {
        type: 'object',
        properties: {
          project_id: {
            type: 'string',
            description: 'Optional GCP project ID override. Defaults to GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT environment variables.'
          },
          page_size: {
            type: 'integer',
            description: 'Number of secrets to fetch (1-250). Defaults to the Secret Manager service default.'
          },
          page_token: {
            type: 'string',
            description: 'Pagination token from a previous list_secrets call.'
          }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_secret',
      description: 'Retrieve a secret value from Google Secret Manager using the configured service account credentials.',
      parameters: {
        type: 'object',
        properties: {
          secret_id: {
            type: 'string',
            description: 'ID of the secret to retrieve (without the project path).'
          },
          version: {
            type: 'string',
            description: "Secret version to access (defaults to 'latest')."
          },
          project_id: {
            type: 'string',
            description: 'Optional GCP project ID override. Defaults to GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT environment variables.'
          }
        },
        required: ['secret_id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'log_trace',
      description: 'Log a symbolic reasoning trace. This must be called for every symbolic operation or deduction chain to maintain the recursive log.',
      parameters: {
        type: 'object',
        properties: {
          trace: TRACE_DATA_SCHEMA
        },
        required: ['trace']
      }
    }
  }
];

// 2. Define the execution logic
export const createToolExecutor = (getApiKey: () => string | null, contextSessionId?: string) => {
  return async (name: string, args: any): Promise<any> => {
    console.log(`[ToolExecutor] Executing ${name} with`, args);

    const writeAllowed = await contextService.isWriteAllowed(contextSessionId, name);
    if (!writeAllowed) {
      return { error: `Session ${contextSessionId} is closed. Write operations are not allowed.`, code: 403 };
    }
    
    switch (name) {
      
      case 'find_symbols': {
        const { queries } = args || {};
        // Fallback for single query args if model uses old schema (or hallucinated)
        const queryList = Array.isArray(queries) ? queries : [args]; 

        const aggregatedSymbols = new Map<string, any>();
        const executionLog: any[] = [];
        let anyFetchAll = false;

        for (const queryConfig of queryList) {
            const { query, symbol_domains, symbol_tag, limit, fetch_all, time_gte, time_between, metadata_filter } = queryConfig;
            
            if (fetch_all) anyFetchAll = true;

            const maxLimit = fetch_all ? 1000 : Math.min(limit || 10, 50);
            
            // Default to all domains if none specified
            let targetDomains: string[];
            if (symbol_domains && Array.isArray(symbol_domains)) {
                targetDomains = symbol_domains;
            } else {
                targetDomains = await domainService.listDomains();
            }

            const mergedMetadataFilter: Record<string, unknown> = { ...(metadata_filter || {}) };
            if (symbol_tag) mergedMetadataFilter.symbol_tag = symbol_tag;

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
            
            let queryResultCount = 0;

            if (wantsSemantic) {
                const results = await domainService.search(query ?? null, maxLimit, {
                    time_gte,
                    time_between,
                    metadata_filter: Object.keys(mergedMetadataFilter).length > 0 ? mergedMetadataFilter : undefined,
                    domains: targetDomains
                });
                
                results.forEach((r: any) => {
                    if (!aggregatedSymbols.has(r.id)) aggregatedSymbols.set(r.id, r);
                });
                queryResultCount = results.length;
            } else {
                for (const domain of targetDomains) {
                    const domainSymbols = await domainService.getSymbols(domain);
                    const filtered = domainSymbols.filter((s) => matchesMetadata(s, mergedMetadataFilter));
                    
                    const paged = fetch_all ? filtered : filtered.slice(0, maxLimit);
                    
                    paged.forEach((s) => {
                        if (!aggregatedSymbols.has(s.id)) aggregatedSymbols.set(s.id, s);
                    });
                    queryResultCount += paged.length;
                }
            }
            
            executionLog.push({ query: query || 'structured_filter', count: queryResultCount });
        }

        let resultList = Array.from(aggregatedSymbols.values());

        // Apply global limit if no query requested fetch_all
        const GLOBAL_SYMBOL_LIMIT = 50;
        if (!anyFetchAll && resultList.length > GLOBAL_SYMBOL_LIMIT) {
            loggerService.warn(`find_symbols: Truncating results from ${resultList.length} to ${GLOBAL_SYMBOL_LIMIT} (global limit). Use 'fetch_all' to bypass.`);
            resultList = resultList.slice(0, GLOBAL_SYMBOL_LIMIT);
        }

        const sanitizedSymbols = resultList.map((item: any) => {
            // Normalize: If item is a search result wrapper with .symbol, extract it. Otherwise use item.
            const s = item.symbol ? { ...item.symbol } : { ...item };
            
            // Explicitly remove score if present on the symbol object or wrapper copy
            if ('score' in s) delete s.score;
            if ('created_at' in s) delete s.created_at;
            if ('last_accessed_at' in s) delete s.last_accessed_at;

            // Remove irrelevant attributes based on kind
            if (s.kind !== 'persona') delete s.persona;
            if (s.kind !== 'lattice') delete s.lattice;
            if (s.kind !== 'data') delete s.data;
            
            return s;
        });

        loggerService.info(`find_symbols returning ${sanitizedSymbols.length} unique symbols across ${queryList.length} queries.`);

        return {
            count: sanitizedSymbols.length,
            symbols: sanitizedSymbols,
            execution_log: executionLog
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
          // IMPORTANT: bypass_validation is intentionally removed from the AI tool interface to enforce integrity.
          // It defaults to false here.
          const bypass_validation = false;

          loggerService.info(`upsert_symbols called with ${symbols?.length || 0} symbols`, { 
              symbolIds: Array.isArray(symbols) ? symbols.map((s: any) => s.symbol_data?.id) : [] 
          });

          if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
              loggerService.warn("upsert_symbols failed: Invalid symbols array");
              return { error: "Invalid symbols array" };
          }

          const upsertByDomain: Record<string, SymbolDef[]> = {};
          const refactors: { old_id: string, symbol_data: SymbolDef }[] = [];
          const domainsToCheck = new Set<string>();

          for (const entry of symbols) {
              const { symbol_data, old_id } = entry || {};
              if (!symbol_data || typeof symbol_data !== 'object') {
                  loggerService.warn("upsert_symbols failed: Missing symbol_data in entry", { entry });
                  return { error: "Each entry must include symbol_data" };
              }

              const s = symbol_data;

              // Only perform strict schema validation if NOT bypassing
              if (!bypass_validation) {
                  const missingFields = [];
                  if (!s.id) missingFields.push('id');
                  if (!s.name) missingFields.push('name');
                  if (!s.triad) missingFields.push('triad');
                  if (!s.macro) missingFields.push('macro');
                  if (!s.role) missingFields.push('role');
                  if (!s.symbol_domain) missingFields.push('symbol_domain');
                  if (!s.failure_mode) missingFields.push('failure_mode');
                  if (!Array.isArray(s.activation_conditions)) missingFields.push('activation_conditions');
                  if (!Array.isArray(s.linked_patterns)) missingFields.push('linked_patterns');
                  if (!s.facets) missingFields.push('facets');
                  
                  if (missingFields.length > 0) {
                      const errorMsg = `Symbol validation failed for ID '${s.id || 'unknown'}': Missing required fields: ${missingFields.join(', ')}`;
                      loggerService.warn(`upsert_symbols validation error: ${errorMsg}`);
                      return { error: errorMsg };
                  }

                  // Validate nested facets
                  const f = s.facets;
                  const missingFacets = [];
                  if (!f.function) missingFacets.push('function');
                  if (!f.topology) missingFacets.push('topology');
                  if (!f.commit) missingFacets.push('commit');
                  if (!f.temporal) missingFacets.push('temporal');
                  if (!Array.isArray(f.gate)) missingFacets.push('gate');
                  if (!Array.isArray(f.substrate)) missingFacets.push('substrate');
                  if (!Array.isArray(f.invariants)) missingFacets.push('invariants');

                  if (missingFacets.length > 0) {
                      const errorMsg = `Symbol validation failed for ID '${s.id}': Missing required facets properties: ${missingFacets.join(', ')}`;
                      loggerService.warn(`upsert_symbols validation error: ${errorMsg}`);
                      return { error: errorMsg };
                  }
              }

              // Validate and default symbol kind
              const validKinds = ['pattern', 'persona', 'lattice', 'data'];
              if (!s.kind || !validKinds.includes(s.kind)) {
                  s.kind = 'pattern';
              }

              const domain = s.symbol_domain || 'root';
              domainsToCheck.add(domain);

              if (old_id && old_id !== s.id) {
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
              const errorMsg = `Domains not found: ${missingDomains.join(', ')}`;
              loggerService.warn(`upsert_symbols failed: ${errorMsg}`);
              return { error: errorMsg , missing_domains: missingDomains, code: 404 };
          }

          try {
              const upserted: { domain: string, count: number }[] = [];
              for (const [domain, domainSymbols] of Object.entries(upsertByDomain)) {
                  if (domainSymbols.length === 0) continue;
                  loggerService.info(`upsert_symbols processing batch for domain ${domain}`, { count: domainSymbols.length });
                  await domainService.bulkUpsert(domain, domainSymbols, { bypassValidation: bypass_validation });
                  upserted.push({ domain, count: domainSymbols.length });
              }

              if (refactors.length > 0) {
                  loggerService.info(`upsert_symbols processing refactors`, { count: refactors.length });
                  await domainService.processRefactorOperation(refactors);
              }

              loggerService.info("upsert_symbols completed successfully", { upserted, refactors: refactors.length });

              return {
                  status: "Upsert completed.",
                  upserted,
                  refactor_count: refactors.length,
              };
          } catch (e: any) {
              loggerService.error("Upsert symbols failed", { error: e.message || String(e), stack: e.stack });
              return { error: `Upsert failed: ${e.message || String(e)}` };
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
          } catch (e: any) {
              loggerService.error("Delete symbols failed", { error: e.message || String(e), stack: e.stack });
              return { error: `Delete failed: ${e.message || String(e)}` };
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
          } catch (e: any) {
              loggerService.error("Create domain failed", { error: e.message || String(e), stack: e.stack });
              return { error: `Failed to create domain: ${e.message || String(e)}` };
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
                readOnly: d.readOnly === true
                //personas: personas
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

      case 'upsert_loop': {
          const { loop_id, schedule, prompt, enabled } = args || {};

          if (!loop_id || !schedule || !prompt) {
              return { error: "Missing required 'loop_id', 'schedule', or 'prompt' argument." };
          }

          if (enabled !== undefined && typeof enabled !== 'boolean') {
              return { error: "Invalid 'enabled' flag. Expected a boolean value." };
          }

          try {
              const loop = await loopService.upsertLoop(
                  String(loop_id),
                  String(schedule),
                  String(prompt),
                  enabled === undefined ? true : enabled
              );
              return {
                  status: 'Loop upserted successfully.',
                  loop,
              };
          } catch (error) {
              return { error: `Failed to upsert loop: ${String(error)}` };
          }
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

      case 'list_test_runs': {
          const runs = await testService.listTestRuns();
          return {
              count: runs.length,
              runs: runs.map(r => ({
                  id: r.id,
                  testSetId: r.testSetId,
                  testSetName: r.testSetName,
                  status: r.status,
                  startTime: r.startTime,
                  endTime: r.endTime,
                  summary: r.summary,
                  compareWithBaseModel: r.compareWithBaseModel
              }))
          };
      }

      case 'list_test_failures': {
          const { run_id } = args;
          if (!run_id) return { error: "Missing run_id" };
          
          const run = await testService.getTestRun(run_id);
          if (!run) return { error: `Test run ${run_id} not found.` };

          const failures = (run.results || []).filter(r => r.status === 'failed' || r.responseMatch === false);
          
          return {
              run_id,
              testSetName: run.testSetName,
              failure_count: failures.length,
              total_count: run.summary?.total || run.results?.length || 0,
              failures: failures.map(f => ({
                  id: f.id,
                  name: f.name,
                  prompt: f.prompt,
                  expected_response: f.expectedResponse,
                  signalzero_response: f.signalZeroResponse,
                  match_reasoning: f.responseMatchReasoning,
                  analysis: f.evaluation?.overall_reasoning,
                  error: f.error
              }))
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

              if (!response.ok) {
                  return { error: `HTTP ${response.status} ${response.statusText}` };
              }

              const buffer = await response.arrayBuffer();
              const contentType = response.headers.get('content-type') || '';
              
              // Use DocumentMeaningService to normalize content
              const parsed = await documentMeaningService.parse(Buffer.from(buffer), contentType, url);

              return {
                  url,
                  status: response.status,
                  content_type: contentType,
                  document_type: parsed.type,
                  metadata: parsed.metadata,
                  content: parsed.content,
                  structured_data: parsed.structured_data
              };
          } catch (error: any) {
              loggerService.error("Web fetch failed", { url, error: error.message || String(error) });
              return { error: `Failed to fetch URL: ${error.message || String(error)}` };
          }
      }

      case 'web_post': {
          const { url, method = 'POST', headers, body, form_data } = args;
          
          if (!url || typeof url !== 'string') return { error: "Missing 'url' argument." };

          const requestHeaders: Record<string, string> = {
              'User-Agent': 'Mozilla/5.0 (compatible; SignalZeroBot/1.0; +https://signalzero.ai)',
          };

          if (headers && typeof headers === 'object') {
              Object.assign(requestHeaders, headers);
          }

          let requestBody: any = undefined;

          if (form_data) {
              const params = new URLSearchParams();
              for (const [key, value] of Object.entries(form_data)) {
                  params.append(key, String(value));
              }
              requestBody = params;
              // URLSearchParams automatically sets Content-Type to application/x-www-form-urlencoded usually,
              // but explicit header doesn't hurt if fetch doesn't do it automatically in this env.
              // Actually, passing URLSearchParams to fetch body usually handles it.
          } else if (body) {
              requestBody = typeof body === 'string' ? body : JSON.stringify(body);
              if (!requestHeaders['Content-Type']) {
                   // Try to infer JSON
                   try {
                       JSON.parse(requestBody);
                       requestHeaders['Content-Type'] = 'application/json';
                   } catch (e) {
                       requestHeaders['Content-Type'] = 'text/plain';
                   }
              }
          }

          try {
              const response = await fetch(url, {
                  method: method.toUpperCase(),
                  headers: requestHeaders,
                  body: requestBody
              });

              if (!response.ok) {
                   const errorText = await response.text();
                   return { error: `HTTP ${response.status} ${response.statusText}: ${errorText}` };
              }

              const buffer = await response.arrayBuffer();
              const contentType = response.headers.get('content-type') || '';
              const parsed = await documentMeaningService.parse(Buffer.from(buffer), contentType, url);

              return {
                  url,
                  method,
                  status: response.status,
                  content_type: contentType,
                  document_type: parsed.type,
                  metadata: parsed.metadata,
                  content: parsed.content,
                  structured_data: parsed.structured_data
              };

          } catch (error: any) {
              loggerService.error("Web post failed", { url, method, error: error.message || String(error) });
              return { error: `Failed to post to URL: ${error.message || String(error)}` };
          }
      }

      case 'web_search': {
          const { query, queries, image_search } = args;
          
          // Normalize input to a list of queries
          let queryList: string[] = [];
          if (Array.isArray(queries) && queries.length > 0) {
              queryList = queries.map((q: any) => typeof q === 'string' ? q : q.query).filter((q: any) => typeof q === 'string' && q.trim().length > 0);
          } else if (typeof query === 'string' && query.trim().length > 0) {
              queryList = [query];
          }

          if (queryList.length === 0) {
              loggerService.warn("web_search failed: No valid queries provided", { args });
              return { error: "Missing or invalid 'query' or 'queries' argument." };
          }

          loggerService.info(`web_search executing ${queryList.length} queries`, { queries: queryList });

          const apiKey = process.env.API_KEY || process.env.GOOGLE_CUSTOM_SEARCH_KEY || process.env.GOOGLE_SEARCH_KEY;
          const searchEngineId = process.env.GOOGLE_CSE_ID || process.env.GOOGLE_SEARCH_ENGINE_ID || process.env.GOOGLE_CUSTOM_SEARCH_CX;

          loggerService.info("web_search config check", {
              hasApiKey: !!apiKey,
              apiKeyLength: apiKey ? apiKey.length : 0,
              hasSearchEngineId: !!searchEngineId,
              searchEngineIdLength: searchEngineId ? searchEngineId.length : 0
          });

          if (!apiKey) return { error: 'Google Custom Search failed: Missing GOOGLE_API_KEY environment variable.' };
          if (!searchEngineId) return { error: 'Google Custom Search failed: Missing search engine ID.' };

          const executeSearch = async (q: string) => {
              try {
                  const searchUrl = new URL('https://customsearch.googleapis.com/customsearch/v1');
                  searchUrl.searchParams.set('key', apiKey);
                  searchUrl.searchParams.set('cx', searchEngineId);
                  searchUrl.searchParams.set('q', q);
                  searchUrl.searchParams.set('num', '10');
                  if (image_search) searchUrl.searchParams.set('searchType', 'image');

                  const response = await fetch(searchUrl.toString(), {
                      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SignalZeroBot/1.0; +https://signalzero.ai)', 'Accept': 'application/json' }
                  });

                  if (!response.ok) {
                      const errorBody = await response.text();
                      loggerService.error("web_search HTTP error", { status: response.status, body: errorBody });
                      return { query: q, error: `HTTP ${response.status}: ${errorBody}` };
                  }

                  const bodyText = await response.text();
                  const json = JSON.parse(bodyText);
                  const items = Array.isArray(json.items) ? json.items : [];
                  
                  return {
                      query: q,
                      total_results: json.searchInformation?.totalResults,
                      results: items.map((item: any) => ({
                          title: item.title,
                          snippet: item.snippet || item.htmlSnippet,
                          url: item.link,
                          display_link: item.displayLink,
                          mime: item.mime
                      }))
                  };
              } catch (e: any) {
                  return { query: q, error: e.message || String(e) };
              }
          };

          const results = await Promise.all(queryList.map(executeSearch));
          
          const errors = results.filter(r => r.error);
          loggerService.info(`web_search completed ${results.length} searches`, { 
              successCount: results.filter(r => !r.error).length,
              errorCount: errors.length,
              errors: errors.map(e => ({ query: e.query, error: e.error }))
          });

          // Flatten results if single query for backward compatibility, or return list structure
          if (results.length === 1) return results[0];
          return { batch_results: results };
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

          await traceService.addTrace({ 
              ...trace, 
              sessionId: contextSessionId 
          } as TraceData);
          return { status: "Trace logged successfully." };
      }

      default:
        return { error: `Function ${name} not found.` };
    }
  };
};
