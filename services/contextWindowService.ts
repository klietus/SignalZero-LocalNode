
import { contextService } from './contextService.js';
import { domainService } from './domainService.js';
import { SymbolDef, ContextMessage } from '../types.js';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { loggerService } from './loggerService.js';
import { buildSystemMetadataBlock } from './timeService.js';
import { getEncoding } from "js-tiktoken";

const enc = getEncoding("cl100k_base");

export class ContextWindowService {
  private readonly TOKEN_LIMIT = 100000;

  /**
   * Constructs the full context window for an LLM request.
   * Optimized for Prompt Caching:
   * 1. System Prompt
   * 2. Stable Symbolic Context (Domains, Core, Personas) -> Cache Anchor
   * 3. Sliding History Window
   * 4. Dynamic Symbolic Context (Identity, Preferences, State) -> Volatile
   */
  async constructContextWindow(
    contextSessionId: string,
    systemPrompt: string
  ): Promise<ChatCompletionMessageParam[]> {
    const messages: ChatCompletionMessageParam[] = [];

    // Determine context type for selective injection
    const session = await contextService.getSession(contextSessionId);
    const type = session?.type || 'conversation';

    // 1. System Prompt
    messages.push({ role: 'system', content: systemPrompt });

    // 2. Stable Symbolic Context (Cache Anchor)
    const stableContext = await this.buildStableContext();
    messages.push({
      role: 'system',
      content: `[KERNEL]\n${stableContext}`
    });

    // 3. Sliding History Window (Token based)
    const rawHistory = await contextService.getUnfilteredHistory(contextSessionId);
    const historyMessages: ChatCompletionMessageParam[] = [];
    let currentTokens = 0;

    // Group into rounds (reverse chronological)
    const rounds: ContextMessage[][] = [];
    let currentRound: ContextMessage[] = [];

    for (let i = rawHistory.length - 1; i >= 0; i--) {
        const msg = rawHistory[i];
        currentRound.unshift(msg);
        if (msg.role === 'user') {
            rounds.push(currentRound);
            currentRound = [];
        }
    }
    if (currentRound.length > 0) {
        rounds.push(currentRound);
    }

    // Process rounds
    for (let index = 0; index < rounds.length; index++) {
        if (index >= 10) {
            loggerService.info(`Context window round limit reached for ${contextSessionId}. Included ${index} rounds.`);
            break;
        }

        let round = rounds[index];

        // Strip tools from older rounds (index > 0)
        if (index > 0) {
            round = this.stripTools(round);
        }

        if (round.length === 0) continue;

        const roundMessages = round.map(msg => this.mapToOpenAIMessage(msg));
        const roundTokens = roundMessages.reduce((sum, msg) => sum + this.estimateTokens(JSON.stringify(msg)), 0);

        if (currentTokens + roundTokens > this.TOKEN_LIMIT) {
            loggerService.info(`Context window limit reached for ${contextSessionId}. Included ${historyMessages.length} messages.`);
            break;
        }

        // Prepend round messages to history (maintaining order within round)
        historyMessages.unshift(...roundMessages);
        currentTokens += roundTokens;
    }
    historyMessages.unshift({ role: 'user', content: `[DYNAMIC_CONTENT]` });
    messages.push(...historyMessages);

    // 4. Dynamic Symbolic Context (Volatile)
    const dynamicContext = await this.buildDynamicContext(type);
    
    // Generate fresh system metadata
    const systemMetadata = buildSystemMetadataBlock({
        id: session?.id,
        type: session?.type,
        lifecycle: session?.status === 'closed' ? 'zombie' : 'live',
        readonly: session?.metadata?.readOnly === true
    });
    
    const systemMetadataStr = JSON.stringify(systemMetadata, null, 2);

    messages.push({
      role: 'system',
      content: `[DYNAMIC_STATE]\n${systemMetadataStr}\n${dynamicContext}`
    });

    // Append system metadata again at the end for recency bias
    messages.push({
      role: 'system',
      content: `[SYSTEM_METADATA]\n${systemMetadataStr}`
    });

    const totalTokens = messages.reduce((sum, m) => sum + this.estimateTokens(JSON.stringify(m)), 0);
    loggerService.info(`Constructed Context Window for ${contextSessionId}`, {
        type,
        historyRounds: rounds.length,
        historyMessages: historyMessages.length,
        historyTokens: currentTokens,
        totalMessages: messages.length,
        totalTokens
    });

    return messages;
  }

  private stripTools(round: ContextMessage[]): ContextMessage[] {
      return round.map(msg => {
          // 1. Collapse tool response messages but MAINTAIN STRUCTURE
          // We must keep role='tool' and the toolCallId so the LLM API knows the call was resolved.
          if (msg.role === 'tool') {
              let collapsedContent = `[System: Tool output collapsed]`;

              // Enhanced retention for symbol loading tools
              if (msg.toolName === 'find_symbols' || msg.toolName === 'load_symbols') {
                  try {
                      const result = JSON.parse(msg.content || '{}');
                      if (result && Array.isArray(result.symbols)) {
                          const symbolList = result.symbols as SymbolDef[];
                          if (symbolList.length > 0) {
                              const reduced = this.formatSymbols(symbolList); // Reuse existing formatter
                              collapsedContent = `[System: Retained Symbol Context]\n${reduced}`;
                          } else {
                              collapsedContent = `[System: No symbols found]`;
                          }
                      }
                  } catch (e) {
                      // Fallback if parsing fails
                  }
              }

              return {
                  ...msg,
                  content: collapsedContent,
              } as ContextMessage;
          }

          // 2. Retain tool calls in assistant messages (do not strip)
          // The previous logic stripped them; now we keep them so the model sees what it asked for.
          // We only filter out empty messages if they truly have no content AND no tool calls.
          return msg;
      }).filter(msg => {
          // 3. Remove assistant messages that have become empty (no content AND no tool calls)
          if ((msg.role === 'assistant' || msg.role === 'model')) {
              const hasContent = msg.content && msg.content.trim().length > 0;
              const hasTools = msg.toolCalls && msg.toolCalls.length > 0;
              return hasContent || hasTools;
          }
          return true;
      });
  }

  private mapToOpenAIMessage(msg: ContextMessage): ChatCompletionMessageParam {
    const chatMsg: any = {
        role: msg.role === 'model' ? 'assistant' : msg.role,
        content: msg.content || null,
    };

    if (msg.toolCalls) {
        chatMsg.tool_calls = msg.toolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: {
                name: tc.name,
                arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
            }
        }));
    }

    if (msg.role === 'tool') {
        chatMsg.tool_call_id = msg.toolCallId;
    }

    return chatMsg;
  }

  private estimateTokens(text: string): number {
      return enc.encode(text).length;
  }

  private formatSymbols(symbols: SymbolDef[]): string {
    if (symbols.length === 0) return "None found.";
    
    // De-duplicate by ID
    const uniqueMap = new Map<string, SymbolDef>();
    symbols.forEach(s => uniqueMap.set(s.id, s));
    const uniqueSymbols = Array.from(uniqueMap.values());

    // Sort by ID to ensure deterministic output for cache stability
    uniqueSymbols.sort((a, b) => a.id.localeCompare(b.id));

    const TOPOLOGY_MAP: Record<string, string> = {
        'inductive': '♻️', 
        'deductive': '⬇️',
        'bidirectional': '⇄',
        'invariant': '🔒',
        'energy': '⚡'
    };
    
    const CLOSURE_MAP: Record<string, string> = {
        'loop': '➰',
        'branch': '🌿',
        'collapse': '💥',
        'constellation': '✨',
        'synthesis': '⚗️'
    };

    const KIND_MAP: Record<string, string> = {
        'pattern': '🧩',
        'persona': '👤',
        'data': '💾'
    };

    // Format symbols using DSL: | ID | Name | Triad | Kind |
    // This reduces token usage significantly compared to JSON.
    return uniqueSymbols.map(s => {
        let triadDisplay = "";
        let kindDisplay = KIND_MAP[s.kind || 'pattern'] || (s.kind || 'pattern');
        let payloadDisplay = "";

        if (s.kind === 'lattice') {
            const topKey = s.lattice?.topology || 'inductive';
            const top = TOPOLOGY_MAP[topKey] || topKey;
            
            const cloKey = s.lattice?.closure || 'loop';
            const clo = CLOSURE_MAP[cloKey] || cloKey;
            
            kindDisplay = `${top} ${clo}`;

             // Triad as array of linked triads
             if (s.linked_patterns && s.linked_patterns.length > 0) {
                 const linkedTriads = s.linked_patterns
                    .map(id => uniqueMap.get(id)?.triad)
                    .filter(t => t); // Filter out undefined (missing symbols)
                 
                 if (linkedTriads.length > 0) {
                    triadDisplay = `[${linkedTriads.join(', ')}]`;
                 } else {
                     triadDisplay = s.triad || "[]";
                 }
             } else {
                 triadDisplay = s.triad || "[]";
             }
        } else if (s.kind === 'data') {
             // For data symbols, include the payload
             if (s.data && s.data.payload) {
                 payloadDisplay = `Payload: ${JSON.stringify(s.data.payload)}`;
             }
             let triadArr: string[] = [];
             if (Array.isArray(s.triad)) {
                triadArr = s.triad;
             } else if (typeof s.triad === 'string') {
                triadArr = (s.triad as string).split(',').map(t => t.trim());
             }
             triadDisplay = `[${triadArr.slice(0, 3).join(', ')}]`;
        } else {
            let triadArr: string[] = [];
            if (Array.isArray(s.triad)) {
                triadArr = s.triad;
            } else if (typeof s.triad === 'string') {
                // Handle string triad (e.g. "A, B, C")
                triadArr = (s.triad as string).split(',').map(t => t.trim());
            }
            triadDisplay = `[${triadArr.slice(0, 3).join(', ')}]`;
        }
        
        // Truncate macro for brevity if needed, but keep it useful
        const macroDisplay = (s.macro || "").slice(0, 100).replace(/\n/g, " ");
        const content = payloadDisplay ? `${payloadDisplay}` : macroDisplay;

        return `| ${s.id} | ${s.name} | ${triadDisplay} | ${kindDisplay} | ${content} |`;
    }).join('\n');
  }

  /**
   * Fetches stable symbols (Domains, Core, Personas) that rarely change.
   */
  private async buildStableContext(): Promise<string> {
      try {
          const results: string[] = [];
          
          // Query 1: List Domains
          const meta = await domainService.getMetadata();
          // Compact domain list with invariants
          const domains = meta.map(d => `| ${d.id} | ${d.name} | ${d.invariants?.join('; ') || ''} |`);
          results.push(`[DOMAINS]\n${domains.join('\n')}`);

          // Query 2: Recursive Core Injection
          // Start with SELF-RECURSIVE-CORE and expand 3 levels deep
          const coreSet = new Map<string, SymbolDef>();
          await this.recursiveSymbolLoad('SELF-RECURSIVE-CORE', 3, coreSet);
          
          const coreSymbols = Array.from(coreSet.values());
          results.push(`\n[SELF]\n${this.formatSymbols(coreSymbols)}`);

          // Query 3: Root Domain
          const rootSet = new Map<string, SymbolDef>();
          await this.recursiveSymbolLoad('ROOT-SYNTHETIC-CORE', 3, rootSet);
          
          const rootSymbols = Array.from(rootSet.values());
          results.push(`\n[ROOT]\n${this.formatSymbols(rootSymbols)}`);
          

          const fullContext = results.join('');
          loggerService.info(`Built Stable Context`, { 
              domains: domains.length, 
              coreSymbols: coreSymbols.length, 
              root: rootSymbols.length, 
              chars: fullContext.length 
          });
          return fullContext;
      } catch (error: any) {
          loggerService.error("Failed to build stable context", { message: error.message, stack: error.stack });
          return "Error loading stable context.";
      }
  }

  private async recursiveSymbolLoad(startId: string, depth: number, collected: Map<string, SymbolDef>) {
      if (depth < 0) return;
      if (collected.has(startId)) return; // Already visited

      const symbol = await domainService.findById(startId);
      if (!symbol) return;

      collected.set(symbol.id, symbol);

      if (depth > 0 && symbol.linked_patterns && symbol.linked_patterns.length > 0) {
          // Parallel fetch for next layer
          await Promise.all(symbol.linked_patterns.map(linkId => 
              this.recursiveSymbolLoad(linkId, depth - 1, collected)
          ));
      }
  }

  /**
   * Fetches dynamic symbols (Identity, Preferences, Recent State) that change frequently.
   */
  private async buildDynamicContext(type: 'conversation' | 'loop' = 'conversation'): Promise<string> {
      try {
          const results: string[] = [];
          let userCoreCount = 0;
          
          if (type !== 'loop') {
              // Query 4: Recursive User Core Injection
              // Start with USER-RECURSIVE-CORE and expand 3 levels deep
              const userSet = new Map<string, SymbolDef>();
              await this.recursiveSymbolLoad('USER-RECURSIVE-CORE', 3, userSet);
              
              const userSymbols = Array.from(userSet.values());
              userCoreCount = userSymbols.length;
              results.push(`[USER]\n${this.formatSymbols(userSymbols)}`);
          }

          // Query 6: Recent State Domain Symbols (Last 5 by date time)
          const stateSymbols = await domainService.getSymbols('state');
          const recentStateSymbols = stateSymbols
              .sort((a, b) => {
                  const getT = (s?: string) => {
                      if (!s) return 0;
                      // Handle ISO string or timestamp
                      const date = new Date(s);
                      return !isNaN(date.getTime()) ? date.getTime() : 0;
                  };
                  // Sort DESC (Newest First)
                  return getT(b.created_at) - getT(a.created_at);
              })
              .slice(0, 5);
          
          // Custom formatter for state symbols to include timestamp
          const stateFormatted = recentStateSymbols.map(s => {
              // Reuse base logic but append timestamp
              const base = this.formatSymbols([s]).trim(); 
              // formatSymbols returns a block, possibly with newlines if multiple.
              // Since we map 1 by 1, it should be a single line (or block).
              // We want to inject the timestamp. 
              // DSL is: | ID | Name | Triad | Kind | Content |
              // We will append | CreatedAt |
              return `${base.slice(0, -1)} ${s.created_at} |`;
          }).join('\n');

          results.push(`\n[STATE]\n${stateFormatted}`);

          const fullContext = results.join('');
          loggerService.info(`Built Dynamic Context`, { 
              type,
              userCoreSymbols: userCoreCount, 
              stateSymbols: recentStateSymbols.length, 
              chars: fullContext.length 
          });
          return fullContext;
      } catch (error: any) {
          loggerService.error("Failed to build dynamic context", { message: error.message, stack: error.stack });
          return "Error loading dynamic context.";
      }
  }
}

export const contextWindowService = new ContextWindowService();
