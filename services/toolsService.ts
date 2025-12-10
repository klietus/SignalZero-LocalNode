
import { FunctionDeclaration, Type } from "@google/genai";
import { domainService } from "./domainService.ts";
import { testService } from "./testService.ts";
import { traceService } from "./traceService.ts";
import { TraceData } from "../types.ts";
import { indexingService } from "./indexingService.ts";
import { loggerService } from "./loggerService.ts";

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

// 1. Define the Schema for the tools
export const toolDeclarations: FunctionDeclaration[] = [
  // --- SignalZero Symbol Store Tools (Local Cache Only) ---
  {
    name: 'query_symbols',
    description: 'Retrieve symbols from the local SignalZero store by domain or tag.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol_domain: {
          type: Type.STRING,
          description: 'Filter symbols by domain (e.g., root, diagnostics). Defaults to "root".',
        },
        symbol_tag: {
          type: Type.STRING,
          description: 'Filter symbols by tag (e.g., system, ritual).',
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
      required: ['symbol_domain'],
    },
  },
  {
    name: 'get_symbol_by_id',
    description: 'Retrieve a specific symbol by its unique ID from the local store.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        id: {
          type: Type.STRING,
          description: 'The unique identifier of the symbol (e.g., SZ:BOOT-SEAL-001).',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'load_symbols_bulk',
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
    name: 'save_symbol',
    description: 'Store or update a symbol in the local SignalZero registry.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol_id: {
          type: Type.STRING,
          description: 'The unique ID for the symbol.',
        },
        symbol_data: SYMBOL_DATA_SCHEMA
      },
      required: ['symbol_id', 'symbol_data'],
    },
  },
  {
    name: 'delete_symbol',
    description: 'Permanently remove a symbol from the registry. CAUTION: Only use this tool when explicitly instructed by the user, or when completing a merge/refactor operation where a new replacement symbol has successfully been created.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        symbol_id: { type: Type.STRING, description: 'The ID of the symbol to delete.' },
        symbol_domain: { type: Type.STRING, description: 'The domain the symbol belongs to (optional, inferred if missing).' },
        cascade: { type: Type.BOOLEAN, description: 'If true, removes references to this symbol from other symbols (linked_patterns, members). Defaults to true.' }
      },
      required: ['symbol_id']
    }
  },
  {
    name: 'bulk_update_symbols',
    description: 'Refactor multiple symbols at once. Can handle updates and renames. Used for domain-wide refactoring.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        updates: {
          type: Type.ARRAY,
          description: 'List of update operations.',
          items: {
            type: Type.OBJECT,
            properties: {
              old_id: { type: Type.STRING, description: 'The current ID of the symbol being modified.' },
              // Explicitly reuse the full schema here so the model doesn't send empty objects
              symbol_data: SYMBOL_DATA_SCHEMA
            },
            required: ['old_id', 'symbol_data']
          }
        }
      },
      required: ['updates']
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
    name: 'list_domains',
    description: 'List all available symbol domains in the local registry. Returns name, id, description, invariant constraints, list of symbol_ids, and full definitions for persona symbols.',
    parameters: {
      type: Type.OBJECT,
      properties: {},
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
    name: 'search_symbols_vector',
    description: 'Search for symbols using semantic vector similarity. Useful for finding symbols by narrative description, concept, or structural triad similarity.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The search query (narrative text, concept, or triad characters).',
        },
        limit: {
          type: Type.INTEGER,
          description: 'Number of results to return (default 5).',
        }
      },
      required: ['query'],
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
        }
      },
      required: ['url']
    }
  },
  {
    name: 'web_search',
    description: 'Perform a DuckDuckGo Instant Answer search for a query and return structured JSON results.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: 'The search query to look up on DuckDuckGo.'
        }
      },
      required: ['query']
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
      
      case 'query_symbols': {
        const { symbol_domain = 'root', symbol_tag, limit, last_symbol_id, fetch_all } = args;

        // Ensure domain exists
        const hasDomain = await domainService.hasDomain(symbol_domain);
        if (!hasDomain) {
             return { count: 0, symbols: [], status: `Domain '${symbol_domain}' not found in registry.` };
        }

        if (fetch_all) {
             const allSymbols = await domainService.getSymbols(symbol_domain);
             let filtered = allSymbols;
             if (symbol_tag) {
                 filtered = allSymbols.filter(s => s.symbol_tag?.includes(symbol_tag));
             }
             return {
                 count: filtered.length,
                 symbols: filtered,
                 status: "Full domain load complete"
             };
        }

        const cachedResult = await domainService.query(symbol_domain, symbol_tag, limit || 20, last_symbol_id);
        
        if (!cachedResult) {
             return { count: 0, symbols: [] };
        }

        return {
            count: cachedResult.items.length,
            symbols: cachedResult.items,
            page_info: {
                limit: limit || 20,
                last_id: cachedResult.items.length > 0 ? cachedResult.items[cachedResult.items.length - 1].id : null
            },
            source: "redis_cache"
        };
      }

      case 'get_symbol_by_id': {
        const cachedSymbol = await domainService.findById(args.id);
        if (cachedSymbol) {
             console.log(`[ToolExecutor] Found symbol ${args.id}`);
             return cachedSymbol;
        }
        return { error: "Symbol not found in registry", code: 400, id: args.id };
      }

      case 'load_symbols_bulk': {
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

      case 'save_symbol': {
        const { symbol_id, symbol_data } = args;
        if (!symbol_id || !symbol_data) {
           return { error: "Missing symbol_id or symbol_data", code: 400 };
        }

        console.groupCollapsed(`[ToolExecutor] save_symbol: ${symbol_id}`);
        console.log("Payload:", symbol_data);
        console.groupEnd();
        
        try {
            const domain = symbol_data.symbol_domain || 'root';
            // Determine if we need to enable the domain if it's new
            const hasDomain = await domainService.hasDomain(domain);
            
            await domainService.upsertSymbol(domain, symbol_data);
            console.log(`[ToolExecutor] Saved symbol ${symbol_id} to registry (Domain: ${domain})`);
            
            return {
                status: "Symbol stored successfully.",
                id: symbol_id,
                domain: domain,
                note: !hasDomain ? "New domain created" : undefined,
                timestamp: new Date().toISOString()
            };
        } catch (cacheErr) {
            console.error("Failed to write to registry", cacheErr);
            return { error: `Failed to save symbol: ${String(cacheErr)}` };
        }
      }

      case 'delete_symbol': {
          const { symbol_id, symbol_domain, cascade = true } = args;
          if (!symbol_id) return { error: "Missing symbol_id" };

          let targetDomain = symbol_domain;
          // Attempt to infer domain if missing
          if (!targetDomain) {
              const sym = await domainService.findById(symbol_id);
              if (sym) targetDomain = sym.symbol_domain;
          }

          if (!targetDomain) {
              return { error: `Symbol ${symbol_id} not found in any active domain.` };
          }

          try {
              await domainService.deleteSymbol(targetDomain, symbol_id, cascade);
              console.log(`[ToolExecutor] Deleted symbol ${symbol_id} from ${targetDomain}`);
              return { 
                  status: "success", 
                  message: `Symbol ${symbol_id} deleted from domain '${targetDomain}'.`,
                  cascade_performed: cascade
              };
          } catch (e) {
              return { error: `Delete failed: ${String(e)}` };
          }
      }

      case 'bulk_update_symbols': {
          const { updates } = args;
          if (!updates || !Array.isArray(updates)) return { error: "Invalid updates array" };
          
          console.group("[ToolExecutor] bulk_update_symbols Payload");
          console.log(`Count: ${updates.length}`);
          console.log("Raw Payload:", updates);
          console.groupEnd();

          try {
             const results = await domainService.processRefactorOperation(updates);
             return {
                 status: "Bulk refactor completed and re-indexed.",
                 updated_count: results.count,
                 renamed: results.renamedIds
             };
          } catch (e) {
              return { error: `Refactor failed: ${String(e)}` };
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

      case 'list_domains': {
        try {
          // Pure local list with metadata
          const metaList = await domainService.getMetadata();
          
          // Map to simpler format for the model, sorting alphabetically
          // ENRICHMENT: Include symbol_ids and full persona objects per domain
          // Since getMetadata is async, metaList is the array result
          const domainResponsePromises = metaList
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(async d => {
              const allSymbols = await domainService.getSymbols(d.id);
              const symbolIds = allSymbols.map(s => s.id);
              // Filter for full symbol definitions where kind is 'persona'
              const personas = allSymbols.filter(s => s.kind === 'persona');

              return {
                id: d.id,
                name: d.name,
                description: d.description || "No description provided.",
                invariants: d.invariants || [],
                symbol_ids: symbolIds,
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

      case 'search_symbols_vector': {
          const { query, limit } = args;
          if (!query) return { error: "Missing query argument" };

          const results = await domainService.search(query, limit || 5);
          
          if (results.length === 0) {
              return { count: 0, results: [], message: "No relevant symbols found via vector search. Check connection to ChromaDB." };
          }

          return {
              count: results.length,
              results: results,
                query: query
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
          const { url } = args;
          if (!url || typeof url !== 'string') {
              return { error: "Missing or invalid 'url' argument." };
          }

          try {
              const response = await fetch(url, {
                  headers: {
                      'User-Agent': 'Mozilla/5.0 (compatible; SignalZeroBot/1.0; +https://signalzero.ai)',
                  }
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
              const searchUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
              const response = await fetch(searchUrl, {
                  headers: {
                      'User-Agent': 'Mozilla/5.0 (compatible; SignalZeroBot/1.0; +https://signalzero.ai)',
                      'Accept-Language': 'en-US,en;q=0.9'
                  }
              });

              if (!response.ok) {
                  return { error: `DuckDuckGo search failed: HTTP ${response.status}` };
              }

              const contentType = response.headers.get('content-type') || '';
              const bodyText = await response.text();

              loggerService.info('Web Search Response', {
                  query,
                  status: response.status,
                  content_type: contentType || 'unknown',
                  content_length: bodyText.length,
                  body_preview: bodyText.slice(0, 500)
              });

              let json;
              try {
                  json = JSON.parse(bodyText);
              } catch (parseError) {
                  const preview = bodyText.slice(0, 200);
                  const contentTypeLabel = contentType || 'unknown';
                  if (!contentType.toLowerCase().includes('json')) {
                      return { error: `DuckDuckGo search failed: Unexpected content type (${contentTypeLabel})`, response_preview: preview };
                  }

                  return { error: `DuckDuckGo search failed: Invalid JSON (${String(parseError)})`, response_preview: preview };
              }
              const results: Array<{ text: string; url?: string; source?: string }> = [];

              const collectTopics = (topics: any[]) => {
                  for (const topic of topics) {
                      if (topic.Topics && Array.isArray(topic.Topics)) {
                          collectTopics(topic.Topics);
                          continue;
                      }

                      if (topic.Text) {
                          results.push({
                              text: topic.Text,
                              url: topic.FirstURL,
                              source: topic.Result ? 'instant' : undefined
                          });
                      }
                  }
              };

              if (Array.isArray(json.RelatedTopics)) {
                  collectTopics(json.RelatedTopics);
              }

              if (Array.isArray(json.Results)) {
                  for (const result of json.Results) {
                      if (result.Text) {
                          results.push({
                              text: result.Text,
                              url: result.FirstURL,
                              source: 'results'
                          });
                      }
                  }
              }

              return {
                  query,
                  heading: json.Heading,
                  abstract: json.Abstract,
                  abstract_source: json.AbstractSource,
                  results
              };
          } catch (error) {
              return { error: `DuckDuckGo search failed: ${String(error)}` };
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
