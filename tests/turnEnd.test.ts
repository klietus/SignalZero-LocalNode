
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendMessageAndHandleTools } from '../services/inferenceService.ts';
import { contextService } from '../services/contextService.js';
import { contextWindowService } from '../services/contextWindowService.js';
import { settingsService } from '../services/settingsService.ts';
import { symbolCacheService } from '../services/symbolCacheService.ts';
import { randomUUID } from 'crypto';

// Mock Services
vi.mock('../services/contextService', () => {
    const history: any[] = [];
    return {
        contextService: {
            getSession: vi.fn(),
            recordMessage: vi.fn().mockImplementation(async (sessionId, message) => {
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

describe('Turn Ending and Audit Logic Refined', () => {
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
        (symbolCacheService.getSymbols as any).mockResolvedValue([{ id: 'S1' }]);
    });

    it('should end turn IMMEDIATELY after log_trace and speak (Loop 0)', async () => {
        const voiceMessage = JSON.stringify({ voice_message: "hello", route_output: "speech tool" });
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        // Loop 0: Provides BOTH requirements
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "",
                    functionCalls: () => [
                        { name: 'log_trace', args: { trace: {} } },
                        { name: 'speak', args: { text: "Hello!" } }
                    ],
                    candidates: [{ content: { parts: [
                        { functionCall: { name: 'log_trace', args: { trace: {} } } },
                        { functionCall: { name: 'speak', args: { text: "Hello!" } } }
                    ] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, voiceMessage, toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        // Requirements met in Loop 0. Breaks immediately after tool execution.
        expect(sendMessageStreamMock).toHaveBeenCalledTimes(1);
    });

    it('should end turn IMMEDIATELY if log_trace and text are in same turn', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        // Loop 0: provides log_trace AND text
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "I found the answer.",
                    functionCalls: () => [{ name: 'log_trace', args: { trace: {} } }],
                    candidates: [{ content: { parts: [
                        { text: "I found the answer." },
                        { functionCall: { name: 'log_trace', args: { trace: {} } } }
                    ] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        expect(sendMessageStreamMock).toHaveBeenCalledTimes(1);
    });

    it('should end turn if log_trace followed by text', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        // Loop 0: log_trace only
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "",
                    functionCalls: () => [{ name: 'log_trace', args: { trace: {} } }],
                    candidates: [{ content: { parts: [{ functionCall: { name: 'log_trace', args: { trace: {} } } }] } }]
                };
            })()
        });

        // Loop 1: text only
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "This is my response.",
                    functionCalls: () => null,
                    candidates: [{ content: { parts: [{ text: "This is my response." }] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        // Loop 0: trace. Loop 1: text. Ends immediately after text turn.
        expect(sendMessageStreamMock).toHaveBeenCalledTimes(2);
    });

    it('should audit failure if NO log_trace is provided', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        // Loop 0: text only (Fails Trace Audit)
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "Narrative without trace.",
                    functionCalls: () => null,
                    candidates: [{ content: { parts: [{ text: "Narrative without trace." }] } }]
                };
            })()
        });

        // Loop 1 (Audit Correction): log_trace
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "",
                    functionCalls: () => [{ name: 'log_trace', args: { trace: {} } }],
                    candidates: [{ content: { parts: [{ functionCall: { name: 'log_trace', args: { trace: {} } } }] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        // Loop 0: audit fail. Loop 1: trace provided. Narrative from Loop 0 is still in 'totalTextAccumulatedAcrossLoops'.
        // So Loop 1 satisfies requirements.
        expect(sendMessageStreamMock).toHaveBeenCalledTimes(2);
    });
});
