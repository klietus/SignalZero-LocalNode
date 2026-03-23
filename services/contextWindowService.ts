
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
     * Optimized for Prompt Caching (Context Checkpoints):
     * 1. System Prompt (Static Anchor)
     * 2. Stable Symbolic Context (Kernel/Domains)
     * 3. Mature Symbols (turnCount > 3) -> Sorted by ID
     * 4. History Summary (Compressed prefix)
     * 5. Conversation History (Sliding window of last 3-5 rounds)
     * 6. New Symbols (turnCount <= 3) -> Volatile tail
     * 7. System Metadata (Turn-specific state)
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

        // 1. System Prompt (Stable Anchor)
        let effectiveSystemPrompt = systemPrompt;
        if (type === 'agent' && session?.metadata?.agentPrompt) {
            effectiveSystemPrompt = `${systemPrompt}\n\n[Agent Prompt]\n${session.metadata.agentPrompt}`;
        }
        messages.push({ role: 'system', content: effectiveSystemPrompt });

        // 2. Stable Symbolic Context (Cache Anchor)
        // Domains and core recursive symbols are mostly static.
        const stableContext = await this.buildStableContext(contextSessionId, effectiveUserId);
        messages.push({
            role: 'system',
            content: `[KERNEL]\n${stableContext}`
        });

        // 3. Mature Symbols (Cache Anchor Expansion)
        // Symbols that have survived decay (turnCount > 3) are stable.
        const { mature, newSymbols } = await symbolCacheService.getPartitionedSymbols(contextSessionId);
        if (mature.length > 0) {
            messages.push({
                role: 'system',
                content: `[MATURE_SYMBOLS]\n${this.formatSymbols(mature)}`
            });
        }

        // 4. History Summary (Stable Prefix of History)
        if (session?.summary) {
            messages.push({
                role: 'system',
                content: `[HISTORY_SUMMARY]\n${session.summary}`
            });
        }

        // Calculate tokens used by static prefix (Sections 1-4)
        let currentTokens = messages.reduce((sum, m) => sum + this.estimateTokens(JSON.stringify(m)), 0);

        // 5. Sliding History Window (Sliding Cache)
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

        // Process rounds (Limit to 5 rounds if summary exists, else 10)
        const maxRounds = session?.summary ? 5 : 10;
        for (let index = 0; index < rounds.length; index++) {
            if (index >= maxRounds) {
                loggerService.info(`Context window round limit reached for ${contextSessionId}. Included ${index} rounds.`);
                break;
            }

            let round = rounds[index];

            // Strip tools from older rounds (index > 0)
            if (index > 0) {
                round = this.stripTools(round);
            }

            if (round.length === 0) continue;

            let roundMessages = round.map(msg => this.mapToOpenAIMessage(msg));
            let roundTokens = roundMessages.reduce((sum, msg) => sum + this.estimateTokens(JSON.stringify(msg)), 0);

            // Check if adding this round exceeds limit
            if (currentTokens + roundTokens > this.TOKEN_LIMIT) {
                if (index === 0) {
                    loggerService.info(`Latest round preserved despite size (${roundTokens} tokens).`);
                } else {
                    loggerService.info(`Context window limit reached for ${contextSessionId}. Included ${historyMessages.length} messages.`);
                    break;
                }
            }

            // Prepend round messages to history (maintaining order within round)
            historyMessages.unshift(...roundMessages);
            currentTokens += roundTokens;
        }

        if (historyMessages.length > 0) {
            messages.push({ role: 'user', content: `[CONVERSATION_HISTORY_START]` });
            messages.push(...historyMessages);
        }

        // 6. New Symbols (Volatile Tail)
        // Recently activated symbols (turnCount <= 3) change frequently.
        const dynamicContext = await this.buildDynamicContext(contextSessionId, type, effectiveUserId, newSymbols);
        if (dynamicContext.trim().length > 0) {
            messages.push({
                role: 'system',
                content: `[DYNAMIC_SYMBOLS]\n${dynamicContext}`
            });
        }

        // 7. System Metadata (Highly Volatile)
        // Contains current time and lifecycle status - changes every turn.
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
            content: `[SYSTEM_STATE]\n${systemMetadataStr}`
        });

        const totalTokens = messages.reduce((sum, m) => sum + this.estimateTokens(JSON.stringify(m)), 0);
        loggerService.info(`Constructed Context Window for ${contextSessionId}`, {
            type,
            historyRounds: Math.min(rounds.length, maxRounds),
            historyMessages: historyMessages.length,
            historyTokens: currentTokens,
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
            // Remove volatile fields to ensure the string representation is identical if the semantic content hasn't changed.
            // Even if DSL doesn't use all fields, we want a clean object for any future changes.
            const { updated_at, turnCount, lastUsed, ...sym } = s as any;

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
            // Inject with turnCount 4 to stabilize immediately in the mature block
            symbolCacheService.batchUpsertSymbols(contextSessionId, coreSymbols, 4);

            // Query 3: Root Domain
            const rootSet = new Map<string, SymbolDef>();
            await this.recursiveSymbolLoad('ROOT-SYNTHETIC-CORE', 3, rootSet, userId);

            const rootSymbols = Array.from(rootSet.values());
            // Inject with turnCount 4 to stabilize immediately
            symbolCacheService.batchUpsertSymbols(contextSessionId, rootSymbols, 4);


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
    private async buildDynamicContext(
        contextSessionId: string, 
        type: ContextKind = 'conversation', 
        userId?: string,
        newSymbols: SymbolDef[] = []
    ): Promise<string> {
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
                // Inject with turnCount 4 to stabilize immediately
                symbolCacheService.batchUpsertSymbols(contextSessionId, userSymbols, 4);
            }

            // Symbol Cache Injection (New/Volatile Symbols)
            if (newSymbols.length > 0) {
                results.push(`\n[SYMBOL CACHE]\n${this.formatSymbols(newSymbols)}`);
            }
            await symbolCacheService.emitCacheLoad(contextSessionId);

            const fullContext = results.join('');
            loggerService.info(`Built Dynamic Context`, {
                type,
                userCoreSymbols: userCoreCount,
                symbolCacheCount: newSymbols.length,
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
