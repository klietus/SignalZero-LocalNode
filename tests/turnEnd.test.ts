import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendMessageAndHandleTools } from '../services/inferenceService.ts';
import { contextService } from '../services/contextService.js';
import { contextWindowService } from '../services/contextWindowService.js';
import { settingsService } from '../services/settingsService.ts';
import { symbolCacheService } from '../services/symbolCacheService.ts';

// Mock Services
vi.mock('../services/contextService', () => {
    const history: any[] = [];
    return {
        contextService: {
            getSession: vi.fn(),
            recordMessage: vi.fn().mockImplementation(async (sessionId, message) => {
                // Simplified auto-split logic for the mock
                const hasLogTrace = message.toolCalls?.some((tc: any) => tc.name === 'log_trace');
                if (message.role === 'assistant' && hasLogTrace && message.content?.trim().length > 0) {
                    const { content, ...toolTurn } = message;
                    history.push({ ...toolTurn, content: "" });
                    history.push({
                        id: 'narrative-id',
                        role: "assistant",
                        content: content,
                        metadata: { kind: "assistant_narrative", source: "auto_split" }
                    });
                } else {
                    history.push(message);
                }
            }),
            isCancelled: vi.fn().mockResolvedValue(false),
            clearCancellation: vi.fn(),
            clearActiveMessage: vi.fn(),
            getHistoryRecords: () => [...history],
            clearHistory: () => { history.length = 0; }
        }
    };
});

vi.mock('../services/contextWindowService', () => ({
    contextWindowService: {
        constructContextWindow: vi.fn()
    }
}));

vi.mock('../services/settingsService', () => ({
    settingsService: {
        getInferenceSettings: vi.fn(),
        getApiKey: vi.fn().mockReturnValue('test-key')
    }
}));

vi.mock('../services/symbolCacheService', () => ({
    symbolCacheService: {
        getSymbols: vi.fn().mockResolvedValue([]),
        incrementTurns: vi.fn().mockResolvedValue(undefined)
    }
}));

vi.mock('../services/redisService', () => ({
    redisService: {
        request: vi.fn()
    }
}));

vi.mock('../services/loggerService', () => ({
    loggerService: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn()
    }
}));

// Mock Google Generative AI
const sendMessageStreamMock = vi.fn();
vi.mock('@google/generative-ai', () => {
    return {
        GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
            getGenerativeModel: vi.fn().mockReturnValue({
                startChat: vi.fn().mockReturnValue({
                    sendMessageStream: sendMessageStreamMock
                })
            })
        })),
        SchemaType: {
            OBJECT: 'OBJECT'
        }
    };
});

describe('Turn Ending Logic', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (contextService as any).clearHistory();
        
        (settingsService.getInferenceSettings as any).mockReturnValue({
            provider: 'gemini',
            apiKey: 'test-key',
            model: 'test-model'
        });

        (contextService.getSession as any).mockResolvedValue({ id: 'sess-1', status: 'open' });
        (contextWindowService.constructContextWindow as any).mockResolvedValue([]);
        
        // Mock symbol cache to always return symbols so grounding audit passes
        (symbolCacheService.getSymbols as any).mockResolvedValue([{ id: 'S1' }]);
    });

    it('should end the turn immediately after log_trace call and separate narrative', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        // Turn response with text AND log_trace
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "This is the narrative text.",
                    functionCalls: () => [
                        { name: 'log_trace', args: { trace: { activation_path: [] } } }
                    ],
                    candidates: [{ content: { parts: [
                        { text: "This is the narrative text." },
                        { functionCall: { name: 'log_trace', args: { trace: { activation_path: [] } } } }
                    ] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        
        for await (const _ of generator) {}

        const records = (contextService as any).getHistoryRecords();

        // 1. User Message
        expect(records[0]).toMatchObject({ role: 'user', content: 'Hello' });

        // 2. Assistant Tool Turn (content should be empty)
        expect(records[1]).toMatchObject({
            role: 'assistant',
            content: '',
            metadata: { kind: 'assistant_response' }
        });
        expect(records[1].toolCalls).toBeDefined();

        // 3. Assistant Narrative Turn (separated from tool call)
        expect(records[2]).toMatchObject({
            role: 'assistant',
            content: 'This is the narrative text.',
            metadata: { kind: 'assistant_narrative', source: 'auto_split' }
        });

        // 4. Tool Result Turn
        expect(records[3]).toMatchObject({
            role: 'tool',
            toolName: 'log_trace'
        });

        // Loop terminated after first turn
        expect(sendMessageStreamMock).toHaveBeenCalledTimes(1);
    });

    it('should continue the loop if no log_trace call is present but other tools are', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        // First turn calls find_symbols (but NO log_trace)
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "I will search now.",
                    functionCalls: () => [{ name: 'find_symbols', args: { queries: [] } }],
                    candidates: [{ content: { parts: [
                        { text: "I will search now." },
                        { functionCall: { name: 'find_symbols', args: { queries: [] } } }
                    ] } }]
                };
            })()
        });

        // Second turn returns log_trace
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "Found it. Logging trace.",
                    functionCalls: () => [{ name: 'log_trace', args: { trace: { activation_path: [] } } }],
                    candidates: [{ content: { parts: [
                        { text: "Found it. Logging trace." },
                        { functionCall: { name: 'log_trace', args: { trace: { activation_path: [] } } } }
                    ] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        // Should have called sendMessageStream twice
        expect(sendMessageStreamMock).toHaveBeenCalledTimes(2);
        
        const records = (contextService as any).getHistoryRecords();
        // find_symbols turn (no log_trace, so NOT split)
        const findSymbolsTurn = records.find((r: any) => r.toolCalls?.some((tc: any) => tc.name === 'find_symbols'));
        expect(findSymbolsTurn.content).toBe('I will search now.');
    });
});
