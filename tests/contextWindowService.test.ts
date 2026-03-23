import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContextWindowService } from '../services/contextWindowService.ts';
import { contextService } from '../services/contextService.js';
import { domainService } from '../services/domainService.js';
import { redisService } from '../services/redisService.js';
import { SymbolDef, ContextMessage } from '../types.js';

vi.mock('../services/contextService');
vi.mock('../services/domainService');
vi.mock('../services/redisService.js');

const GLOBAL_REDIS_DATA: Record<string, any> = {};

describe('ContextWindowService', () => {
    let service: ContextWindowService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new ContextWindowService();
        
        // Reset global redis data before each test
        for (const key in GLOBAL_REDIS_DATA) delete GLOBAL_REDIS_DATA[key];
        
        vi.mocked(redisService.request).mockImplementation(async (args: any[]) => {
            const cmd = args[0];
            const key = args[1];
            if (cmd === 'GET') return GLOBAL_REDIS_DATA[key] || null;
            if (cmd === 'SET') {
                GLOBAL_REDIS_DATA[key] = args[2];
                return 'OK';
            }
            if (cmd === 'DEL') {
                delete GLOBAL_REDIS_DATA[key];
                return 1;
            }
            return null;
        });

        // Default mocks
        vi.mocked(contextService.getSession).mockResolvedValue({ id: 'sess-1', type: 'conversation', status: 'open', createdAt: '', updatedAt: '' });
        vi.mocked(contextService.getUnfilteredHistory).mockResolvedValue([]);
        vi.mocked(domainService.getMetadata).mockResolvedValue([]);
        vi.mocked(domainService.findById).mockResolvedValue(null);
        vi.mocked(domainService.getSymbols).mockResolvedValue([]);
    });

    it('should construct a context window with system prompt and stable context', async () => {
        const window = await service.constructContextWindow('sess-1', 'Base System Prompt');
        
        expect(window[0]).toEqual({ role: 'system', content: 'Base System Prompt' });
        expect(window[1].role).toBe('system');
        expect(window[1].content).toContain('[KERNEL]');
    });

    it('should include sliding history window', async () => {
        const history: ContextMessage[] = [
            { id: '1', role: 'user', content: 'Hello', timestamp: '' },
            { id: '2', role: 'assistant', content: 'Hi there', timestamp: '' }
        ];
        vi.mocked(contextService.getUnfilteredHistory).mockResolvedValue(history);

        const window = await service.constructContextWindow('sess-1', 'Prompt');
        
        const historyEntries = window.filter(m => m.role === 'user' || m.role === 'assistant');
        // Round group logic might prepend a [DYNAMIC_CONTENT] user message or similar
        expect(historyEntries.some(m => m.content === 'Hello')).toBe(true);
        expect(historyEntries.some(m => m.content === 'Hi there')).toBe(true);
    });

    it('should recursively load symbols', async () => {
        const sym1: any = { 
            id: 'ROOT', 
            name: 'Root Sym', 
            linked_patterns: [{ id: 'CHILD', link_type: 'relates_to', bidirectional: false }] 
        };
        const sym2: any = { id: 'CHILD', name: 'Child Sym', linked_patterns: [] };

        vi.mocked(domainService.findById).mockImplementation(async (id) => {
            if (id === 'ROOT') return sym1;
            if (id === 'CHILD') return sym2;
            return null;
        });

        // Test private method indirectly or via a helper
        // Since buildStableContext is private, we'll check if findById was called
        await service.constructContextWindow('sess-1', 'Prompt');
        
        // Should have tried to load core symbols defined in service
        expect(domainService.findById).toHaveBeenCalled();
    });

    it('should format symbols into DSL table', async () => {
        const symbols: SymbolDef[] = [{
            id: 'SYM-1',
            name: 'Test Symbol',
            triad: 'A,B,C',
            kind: 'pattern',
            role: 'Tester',
            macro: 'Logic',
            activation_conditions: [],
            facets: { function: 'test' } as any,
            symbol_domain: 'dom',
            symbol_tag: 'tag',
            failure_mode: 'none',
            linked_patterns: [],
            created_at: '',
            updated_at: ''
        }];

        // Mock findById to return our symbol for one of the core roots
        vi.mocked(domainService.findById).mockImplementation(async (id) => {
            if (id === 'SELF-RECURSIVE-CORE') return symbols[0];
            return null;
        });
        
        const window = await service.constructContextWindow('sess-1', 'Prompt');
        const dynamicContent = window.find(m => m.content?.includes('[DYNAMIC_SYMBOLS]'))?.content || '';
        
        expect(dynamicContent).toContain('[SYMBOL CACHE]');
        expect(dynamicContent).toContain('| SYM-1 | Test Symbol | [A, B, C] | 🧩 | Logic |');
    });

    it('should strip tool outputs from older rounds', async () => {
        const history: ContextMessage[] = [
            { id: 'u1', role: 'user', content: 'First', timestamp: '' },
            { id: 'a1', role: 'assistant', content: 'Thinking', toolCalls: [{ id: 'tc1', name: 'find_symbols', arguments: {} }], timestamp: '' },
            { id: 't1', role: 'tool', toolName: 'find_symbols', toolCallId: 'tc1', content: '{"symbols":[]}', timestamp: '' },
            { id: 'u2', role: 'user', content: 'Second', timestamp: '' }
        ];
        vi.mocked(contextService.getUnfilteredHistory).mockResolvedValue(history);

        const window = await service.constructContextWindow('sess-1', 'Prompt');
        
        // Find the tool message in the constructed window - should be GONE
        const toolMsg = window.find(m => (m as any).tool_call_id === 'tc1');
        expect(toolMsg).toBeUndefined();

        // Verify the assistant message lost its tool_calls
        const assistantMsg = window.find(m => m.role === 'assistant' && m.content === 'Thinking');
        expect((assistantMsg as any).tool_calls).toBeUndefined();
    });
});
