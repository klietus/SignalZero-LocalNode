
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
   * Includes:
   * 1. System Prompt
   * 2. Injected Symbols (based on predefined queries)
   * 3. Sliding window of last history turns up to 100,000 tokens
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

    // 2. Knowledge Injection (Symbols & Metadata)
    const symbolicContext = await this.buildSymbolicContext(type);
    
    // Generate fresh system metadata
    const systemMetadata = buildSystemMetadataBlock({
        id: session?.id,
        type: session?.type,
        lifecycle: session?.status === 'closed' ? 'zombie' : 'live',
        readonly: session?.metadata?.readOnly === true
    });

    messages.push({
      role: 'system',
      content: `[STATIC_CONTENT]\n[KNOWLEDGE]${symbolicContext}`
    });

    // 3. Sliding History Window (Token based)
    const rawHistory = await contextService.getUnfilteredHistory(contextSessionId);
    const historyMessages: ChatCompletionMessageParam[] = [];
    let currentTokens = 0;

    // Process from newest to oldest
    for (let i = rawHistory.length - 1; i >= 0; i--) {
        const msg = rawHistory[i];
        const chatMsg = this.mapToOpenAIMessage(msg);
        
        // Estimate tokens for this message
        const msgTokens = this.estimateTokens(JSON.stringify(chatMsg));
        
        if (currentTokens + msgTokens > this.TOKEN_LIMIT) {
            loggerService.info(`Context window limit reached for ${contextSessionId}. Included ${historyMessages.length} messages.`);
            break;
        }

        historyMessages.unshift(chatMsg); // Prepend to maintain chronological order
        currentTokens += msgTokens;
    }
    historyMessages.unshift({ role: 'user', content: `[DYNAMIC_CONTENT]` });
    return [...messages, ...historyMessages];
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

  /**
   * Fetches symbols based on the required queries and formats them for injection.
   */
  private async buildSymbolicContext(type: 'conversation' | 'loop' = 'conversation'): Promise<string> {
    try {
      const results: string[] = [];

      // Query 1: List Domains
      const meta = await domainService.getMetadata();
      const domains = meta.map(d => ({
          id: d.id,
          name: d.name,
          description: d.description,
          invariants: d.invariants
      }));
      results.push(`[DOMAINS]${JSON.stringify(domains)}`);
      loggerService.debug(`Injected ${domains.length} domains`);

      // Query 2: Root Domain "core" symbols (50)
      const coreSymbolsResult = await domainService.search("core", 50, { domains: ['root','self','state']});
      const coreSymbols = coreSymbolsResult.map(r => r.symbol).filter(Boolean) as SymbolDef[];
      results.push(`[CORE]${this.formatSymbols(coreSymbols)}`);
      loggerService.debug(`Injected ${coreSymbols.length} core symbols: ${coreSymbols.map(s => s.id).join(', ')}`);

      // Query 3: Root and selfDomain "persona" kind (20)
      const rootSymbols = await domainService.getSymbols('root');
      const personas = rootSymbols.filter(s => s.kind === 'persona').slice(0, 20);
      results.push(`[PERSONAS]${this.formatSymbols(personas)}`);
      loggerService.debug(`Injected ${personas.length} personas: ${personas.map(s => s.id).join(', ')}`);

      let identityCount = 0;
      let preferenceCount = 0;

      if (type !== 'loop') {
          // Query 4: "self" and "user" domains "identity" (50) - Only for User Conversations
          const identitySymbolsResult = await domainService.search("identity", 40, { domains: ['self', 'user'] });
          const identitySymbols = identitySymbolsResult.map(r => r.symbol).filter(Boolean) as SymbolDef[];
          identityCount = identitySymbols.length;
          results.push(`[IDENTITY]${this.formatSymbols(identitySymbols)}`);
          loggerService.debug(`Injected ${identityCount} identity symbols: ${identitySymbols.map(s => s.id).join(', ')}`);

          // Query 5: "user" domain "preference" (50) - Only for User Conversations
          const preferenceSymbolsResult = await domainService.search("preference", 30, { domains: ['user'] });
          const preferenceSymbols = preferenceSymbolsResult.map(r => r.symbol).filter(Boolean) as SymbolDef[];
          preferenceCount = preferenceSymbols.length;
          results.push(`[PREFERENCES]${this.formatSymbols(preferenceSymbols)}`);
          loggerService.debug(`Injected ${preferenceCount} preference symbols: ${preferenceSymbols.map(s => s.id).join(', ')}`);
      } else {
          // Query 4: "self" and "user" domains "identity" (50) - Only for User Conversations
          const identitySymbolsResult = await domainService.search("identity", 40, { domains: ['self'] });
          const identitySymbols = identitySymbolsResult.map(r => r.symbol).filter(Boolean) as SymbolDef[];
          identityCount = identitySymbols.length;
          results.push(`[IDENTITY]${this.formatSymbols(identitySymbols)}`);
          loggerService.debug(`Injected ${identityCount} identity symbols (Loop context): ${identitySymbols.map(s => s.id).join(', ')}`);
      }

      // Query 6: Recent State Domain Symbols (Last 5 by date time)
      const stateSymbols = await domainService.getSymbols('state');
      const recentStateSymbols = stateSymbols
          .sort((a, b) => {
              const getT = (s?: string) => {
                  if (!s) return 0;
                  try { return Number(Buffer.from(s, 'base64').toString()); } catch { return 0; }
              };
              return getT(b.created_at) - getT(a.created_at);
          })
          .slice(0, 5);
      results.push(`[STATE]${this.formatSymbols(recentStateSymbols)}`);
      loggerService.debug(`Injected ${recentStateSymbols.length} recent state symbols: ${recentStateSymbols.map(s => s.id).join(', ')}`);

      const fullContext = results.join('');
      
      loggerService.info("Constructed Symbolic Context for Injection", {
          type,
          domains: domains.length,
          coreSymbols: coreSymbols.length,
          personas: personas.length,
          identitySymbols: identityCount,
          preferenceSymbols: preferenceCount,
          stateSymbols: recentStateSymbols.length,
          totalLength: fullContext.length
      });

      return fullContext;
    } catch (error) {
      loggerService.error("Failed to build symbolic context", { error });
      return "Error loading symbolic context.";
    }
  }

  private formatSymbols(symbols: SymbolDef[]): string {
    if (symbols.length === 0) return "None found.";
    // Format symbols as a JSON list for clean injection
    return symbols.map(s => {
        const payload: any = {
            id: s.id,
            name: s.name,
            kind: s.kind || 'pattern',
            triad: s.triad,
            role: s.role,
            macro: s.macro,
            domain: s.symbol_domain,
            invariants: s.facets?.invariants || [],
            linked_patterns: s.linked_patterns || []
        };

        if (s.kind === 'lattice' && s.lattice) {
            payload.lattice = { topology: s.lattice.topology, closure: s.lattice.closure };
            payload.members = s.linked_patterns || [];
        } else if (s.kind === 'persona' && s.persona) {
            payload.persona = { 
                recursion_level: s.persona.recursion_level, 
                function: s.persona.function, 
                fallback_behavior: s.persona.fallback_behavior 
            };
        } else {
            payload.linked_patterns = s.linked_patterns || [];
        }

        return JSON.stringify(payload);
    }).join('');
  }
}

export const contextWindowService = new ContextWindowService();
