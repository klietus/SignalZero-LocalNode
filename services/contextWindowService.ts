
import { contextService } from './contextService.js';
import { domainService } from './domainService.js';
import { SymbolDef, ContextMessage } from '../types.js';
import { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { loggerService } from './loggerService.js';

export class ContextWindowService {
  /**
   * Constructs the full context window for an LLM request.
   * Includes:
   * 1. System Prompt
   * 2. Injected Symbols (based on predefined queries)
   * 3. Sliding window of last 10 turns (approx 20-30 messages including tools)
   */
  async constructContextWindow(
    contextSessionId: string,
    systemPrompt: string,
    maxTurns: number = 10
  ): Promise<ChatCompletionMessageParam[]> {
    const messages: ChatCompletionMessageParam[] = [];

    // Determine context type for selective injection
    const session = await contextService.getSession(contextSessionId);
    const type = session?.type || 'conversation';

    // 1. System Prompt
    messages.push({ role: 'system', content: systemPrompt });

    // 2. Knowledge Injection (Symbols)
    const symbolicContext = await this.buildSymbolicContext(type);
    messages.push({
      role: 'system',
      content: `[KNOWLEDGE_INJECTION]\n${symbolicContext}`
    });

    // 3. Sliding History Window
    // We fetch raw history because we need tool results for context continuity.
    const rawHistory = await contextService.getUnfilteredHistory(contextSessionId);
    
    // A "turn" is roughly User -> Asst. 10 turns is at least 20 messages.
    // We take more to account for interleaved tool results.
    const sliceCount = maxTurns * 4; 
    const recentHistory = rawHistory.slice(-sliceCount);

    for (const msg of recentHistory) {
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

        messages.push(chatMsg);
    }

    return messages;
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
      results.push(`[DOMAINS]\n${JSON.stringify(domains, null, 2)}`);

      // Query 2: Root Domain "core" symbols (50)
      const coreSymbols = await domainService.search("core", 50, { domains: ['root','self'] });
      results.push(`[CORE_SYMBOLS]\n${this.formatSymbols(coreSymbols.map(r => r.symbol).filter(Boolean) as SymbolDef[])}`);

      // Query 3: Root and selfDomain "persona" kind (20)
      const rootSymbols = await domainService.getSymbols('root');
      const personas = rootSymbols.filter(s => s.kind === 'persona').slice(0, 20);
      results.push(`[PERSONAS]\n${this.formatSymbols(personas)}`);

      let identityCount = 0;
      let preferenceCount = 0;

      if (type !== 'loop') {
          // Query 4: "self" and "user" domains "identity" (50) - Only for User Conversations
          const identitySymbols = await domainService.search("identity", 50, { domains: ['self', 'user'] });
          identityCount = identitySymbols.length;
          results.push(`[IDENTITY_CONTEXT]\n${this.formatSymbols(identitySymbols.map(r => r.symbol).filter(Boolean) as SymbolDef[])}`);

          // Query 5: "user" domain "preference" (50) - Only for User Conversations
          const preferenceSymbols = await domainService.search("preference", 50, { domains: ['user'] });
          preferenceCount = preferenceSymbols.length;
          results.push(`[USER_PREFERENCES]\n${this.formatSymbols(preferenceSymbols.map(r => r.symbol).filter(Boolean) as SymbolDef[])}`);
      } else {
          // Query 4: "self" and "user" domains "identity" (50) - Only for User Conversations
          const identitySymbols = await domainService.search("identity", 50, { domains: ['self'] });
          identityCount = identitySymbols.length;
          results.push(`[IDENTITY_CONTEXT]\n${this.formatSymbols(identitySymbols.map(r => r.symbol).filter(Boolean) as SymbolDef[])}`);
      }

      const fullContext = results.join('\n\n');
      
      loggerService.info("Constructed Symbolic Context for Injection", {
          type,
          domains: domains.length,
          coreSymbols: coreSymbols.length,
          personas: personas.length,
          identitySymbols: identityCount,
          preferenceSymbols: preferenceCount,
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
    // Map to a more compact representation for context injection
    return symbols.map(s => {
        let specialized = "";
        if (s.kind === 'lattice' && s.lattice) {
            const { topology, closure } = s.lattice;
            specialized = `Lattice: ${JSON.stringify({ topology, closure })}`;
        } else if (s.kind === 'persona' && s.persona) {
            const { recursion_level, function: func, fallback_behavior } = s.persona;
            specialized = `Persona: ${JSON.stringify({ recursion_level, function: func, fallback_behavior })}`;
        }

        return `<sz_symbol id="${s.id}" name="${s.name}" domain="${s.symbol_domain}">
Triad: ${s.triad}
Role: ${s.role}
Macro: ${s.macro || 'N/A'}
Invariants: ${(s.facets?.invariants || []).join(', ')}
${specialized}
</sz_symbol>`;
    }).join('\n');
  }
}

export const contextWindowService = new ContextWindowService();
