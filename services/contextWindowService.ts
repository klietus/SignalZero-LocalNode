
import { contextService } from './contextService.js';
import { domainService } from './domainService.js';
import { symbolCacheService } from './symbolCacheService.js';
import { SymbolDef, ContextMessage, isUserSpecificDomain, ContextKind } from '../types.js';
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
     * 
     * @param contextSessionId - The session ID for context
     * @param systemPrompt - Base system prompt
     * @param userId - Optional user ID for domain isolation (filters user/state domains)
     */
    async constructContextWindow(
        contextSessionId: string,
        systemPrompt: string,
        userId?: string
    ): Promise<ChatCompletionMessageParam[]> {
        const messages: ChatCompletionMessageParam[] = [];

        // Determine context type for selective injection
        const session = await contextService.getSession(contextSessionId, userId, true);
        const type = session?.type || 'conversation';
        const effectiveUserId = userId || session?.userId || undefined;

        // 1. System Prompt
        let effectiveSystemPrompt = systemPrompt;
        if (type === 'agent' && session?.metadata?.agentPrompt) {
            effectiveSystemPrompt = `${systemPrompt}\n\n[Agent Prompt]\n${session.metadata.agentPrompt}`;
        }
        messages.push({ role: 'system', content: effectiveSystemPrompt });

        // 2. Stable Symbolic Context (Cache Anchor)
        const stableContext = await this.buildStableContext(contextSessionId, effectiveUserId);
        messages.push({
            role: 'system',
            content: `[KERNEL]\n${stableContext}`
        });

        // Calculate tokens used by static context
        let currentTokens = messages.reduce((sum, m) => sum + this.estimateTokens(JSON.stringify(m)), 0);

        // 3. Sliding History Window (Token based)
        const rawHistory = await contextService.getUnfilteredHistory(contextSessionId, effectiveUserId, true);
        const historyMessages: ChatCompletionMessageParam[] = [];

        // Group into rounds (reverse chronological: Newest -> Oldest)
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
            // For the latest round (index 0), we keep them initially to show execution results
            if (index > 0) {
                round = this.stripTools(round);
            }

            if (round.length === 0) continue;

            let roundMessages = round.map(msg => this.mapToOpenAIMessage(msg));
            let roundTokens = roundMessages.reduce((sum, msg) => sum + this.estimateTokens(JSON.stringify(msg)), 0);

            // Check if adding this round exceeds limit
            if (currentTokens + roundTokens > this.TOKEN_LIMIT) {
                if (index === 0) {
                    // Critical: The LATEST round is NEVER truncated. 
                    // We allow it to exceed the limit to ensure model sees the full prompt/execution.
                    loggerService.info(`Latest round preserved despite size (${roundTokens} tokens).`);
                } else {
                    // Older rounds: just drop them
                    loggerService.info(`Context window limit reached for ${contextSessionId}. Included ${historyMessages.length} messages.`);
                    break;
                }
            }

            // Prepend round messages to history (maintaining order within round)
            historyMessages.unshift(...roundMessages);
            currentTokens += roundTokens;
        }

        // Inject Dynamic Content marker if history exists
        if (historyMessages.length > 0) {
            // Find the first user message and prepend marker? 
            // Actually, we just want to ensure the model knows where dynamic content starts.
            // But historyMessages[0] is the oldest user message in the window.
            // The original code unshifted a separate message.
            historyMessages.unshift({ role: 'user', content: `[DYNAMIC_CONTENT_START]` });
        }

        messages.push(...historyMessages);

        // 4. Dynamic Symbolic Context (Volatile)
        const dynamicContext = await this.buildDynamicContext(contextSessionId, type, effectiveUserId);

        // Generate fresh system metadata
        const systemMetadata = buildSystemMetadataBlock({
            id: session?.id,
            type: session?.type,
            lifecycle: session?.status === 'closed' ? 'zombie' : 'live',
            readonly: session?.metadata?.readOnly === true,
            trace_needed: session?.metadata?.trace_needed,
            trace_reason: session?.metadata?.trace_reason
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
            historyTokens: currentTokens, // This is cumulative context size now
            totalMessages: messages.length,
            totalTokens
        });

        return messages;
    }

    private stripTools(round: ContextMessage[]): ContextMessage[] {
        return round.map(msg => {
            // 1. Collapse tool response messages
            // In older rounds, we remove the detailed tool output but keep a placeholder
            if (msg.role === 'tool') {
                return null; // We filter these out below
            }

            // 2. Remove tool call metadata from assistant messages
            // This keeps the text response but removes the function call definitions
            if ((msg.role === 'assistant' || msg.role === 'model') && msg.toolCalls) {
                return {
                    ...msg,
                    toolCalls: undefined
                } as ContextMessage;
            }

            return msg;
        }).filter((msg): msg is ContextMessage => {
            if (!msg) return false;
            // Remove assistant messages that have no content after stripping tools
            if ((msg.role === 'assistant' || msg.role === 'model')) {
                return !!(msg.content && msg.content.trim().length > 0);
            }
            return true;
        });
    }

    private mapToOpenAIMessage(msg: ContextMessage): ChatCompletionMessageParam {
        let role = msg.role;
        if (role === 'model') role = 'assistant';

        const chatMsg: any = {
            role: role,
            content: msg.content || null,
        };

        if (msg.toolCalls && msg.toolCalls.length > 0) {
            chatMsg.tool_calls = msg.toolCalls.map((tc: any) => ({
                id: tc.id,
                type: 'function',
                function: {
                    name: tc.name,
                    arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments)
                }
            }));
        }

        if (role === 'tool') {
            chatMsg.tool_call_id = msg.toolCallId;
        }

        return chatMsg as ChatCompletionMessageParam;
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
            // Remove updated_at from the symbol object to ensure it is not used in formatting
            // (Though our DSL below doesn't use it, this is a safety measure if DSL changes)
            const { updated_at, ...symbolWithoutUpdate } = s;
            const sym = symbolWithoutUpdate as any;

            let triadDisplay = "";
            let kindDisplay = KIND_MAP[sym.kind || 'pattern'] || (sym.kind || 'pattern');
            let payloadDisplay = "";

            if (sym.kind === 'lattice') {
                const topKey = sym.lattice?.topology || 'inductive';
                const top = TOPOLOGY_MAP[topKey] || topKey;

                const cloKey = sym.lattice?.closure || 'loop';
                const clo = CLOSURE_MAP[cloKey] || cloKey;

                kindDisplay = `${top} ${clo}`;

                // Triad as array of linked triads
                if (sym.linked_patterns && sym.linked_patterns.length > 0) {
                    const linkedTriads = sym.linked_patterns
                        .map((link: any) => uniqueSymbols.find((ext: SymbolDef) => ext.id === link.id)?.triad)
                        .filter(Boolean);
                    if (linkedTriads.length > 0) {
                        kindDisplay += ` (Links: ${linkedTriads.join(', ')})`;
                    }
                }
            } else if (sym.kind === 'data') {
                // For data symbols, include the payload
                if (sym.data && sym.data.payload) {
                    payloadDisplay = `Payload: ${JSON.stringify(sym.data.payload)}`;
                }
                let triadArr: string[] = [];
                if (Array.isArray(sym.triad)) {
                    triadArr = sym.triad;
                } else if (typeof sym.triad === 'string') {
                    triadArr = (sym.triad as string).split(',').map(t => t.trim());
                }
                triadDisplay = `[${triadArr.slice(0, 3).join(', ')}]`;
            } else {
                let triadArr: string[] = [];
                if (Array.isArray(sym.triad)) {
                    triadArr = sym.triad;
                } else if (typeof sym.triad === 'string') {
                    // Handle string triad (e.g. "A, B, C")
                    triadArr = (sym.triad as string).split(',').map(t => t.trim());
                }
                triadDisplay = `[${triadArr.slice(0, 3).join(', ')}]`;
            }

            // Truncate macro for brevity if needed, but keep it useful
            const macroDisplay = (sym.macro || "").slice(0, 100).replace(/\n/g, " ");
            const content = payloadDisplay ? `${payloadDisplay}` : macroDisplay;

            return `| ${sym.id} | ${sym.name} | ${triadDisplay} | ${kindDisplay} | ${content} |`;
        }).join('\n');
    }

    /**
     * Fetches stable symbols (Domains, Core, Personas) that rarely change.
     * Includes global domains + user's user/state domains.
     */
    private async buildStableContext(contextSessionId: string, userId?: string): Promise<string> {
        try {
            const results: string[] = [];

            // Query 1: List Domains (filtered by user)
            const meta = await domainService.getMetadata(userId);
            // Compact domain list with invariants
            const domains = meta.map(d => `| ${d.id} | ${d.name} | ${d.invariants?.join('; ') || ''} |`);
            results.push(`[DOMAINS]\n${domains.join('\n')}`);

            // Query 2: Recursive Core Injection
            // Start with SELF-RECURSIVE-CORE and expand 3 levels deep
            const coreSet = new Map<string, SymbolDef>();
            await this.recursiveSymbolLoad('SELF-RECURSIVE-CORE', 3, coreSet, userId);

            const coreSymbols = Array.from(coreSet.values());
            symbolCacheService.batchUpsertSymbols(contextSessionId, coreSymbols);
            //results.push(`\n[SELF]\n${this.formatSymbols(coreSymbols)}`);

            // Query 3: Root Domain
            const rootSet = new Map<string, SymbolDef>();
            await this.recursiveSymbolLoad('ROOT-SYNTHETIC-CORE', 3, rootSet, userId);

            const rootSymbols = Array.from(rootSet.values());
            symbolCacheService.batchUpsertSymbols(contextSessionId, rootSymbols);
            //results.push(`\n[ROOT]\n${this.formatSymbols(rootSymbols)}`);


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

    private async recursiveSymbolLoad(startId: string, depth: number, collected: Map<string, SymbolDef>, userId?: string) {
        if (depth < 0) return;
        if (collected.has(startId)) return; // Already visited

        const symbol = await domainService.findById(startId, userId);
        if (!symbol) return;

        collected.set(symbol.id, symbol);

        // Recursive expansion (Deep Traversal)
        if (depth > 0 && symbol.linked_patterns && symbol.linked_patterns.length > 0) {
            await Promise.all(symbol.linked_patterns.map(link =>
                this.recursiveSymbolLoad(link.id, depth - 1, collected, userId)
            ));
        }
    }

    /**
     * Fetches dynamic symbols (Identity, Preferences, Recent State) that change frequently.
     * User and state domains are filtered by userId.
     */
    private async buildDynamicContext(contextSessionId: string, type: ContextKind = 'conversation', userId?: string): Promise<string> {
        try {
            const results: string[] = [];
            let userCoreCount = 0;

            if (type !== 'agent') {
                // Query 4: Recursive User Core Injection
                // Start with USER-RECURSIVE-CORE and expand 3 levels deep
                const userSet = new Map<string, SymbolDef>();
                await this.recursiveSymbolLoad('USER-RECURSIVE-CORE', 3, userSet, userId);

                const userSymbols = Array.from(userSet.values());
                userCoreCount = userSymbols.length;
                symbolCacheService.batchUpsertSymbols(contextSessionId, userSymbols);
                //results.push(`[USER]\n${this.formatSymbols(userSymbols)}`);
            }

            // Symbol Cache Injection
            let cacheCount = 0;
            if (contextSessionId) {
                const cachedSymbols = await symbolCacheService.getSymbols(contextSessionId);
                if (cachedSymbols.length > 0) {
                    cacheCount = cachedSymbols.length;
                    results.push(`\n[SYMBOL CACHE]\n${this.formatSymbols(cachedSymbols)}`);
                }
            }
            await symbolCacheService.emitCacheLoad(contextSessionId);

            const fullContext = results.join('');
            loggerService.info(`Built Dynamic Context`, {
                type,
                userCoreSymbols: userCoreCount,
                symbolCacheCount: cacheCount,
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
