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
                // Auto-split logic mirroring the real implementation
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

    it('should end the turn immediately if log_trace AND narrative are in the same response', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "Instant narrative.",
                    functionCalls: () => [{ name: 'log_trace', args: { trace: {} } }],
                    candidates: [{ content: { parts: [
                        { text: "Instant narrative." },
                        { functionCall: { name: 'log_trace', args: { trace: {} } } }
                    ] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        const records = (contextService as any).getHistoryRecords();
        expect(records.length).toBe(4); // User, Tool Turn (empty), Narrative Turn, Tool Result
        expect(sendMessageStreamMock).toHaveBeenCalledTimes(1);
    });

    it('should NOT end turn if log_trace is sent WITHOUT narrative, allowing narrative turn next', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        // Turn 1: log_trace only
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "",
                    functionCalls: () => [{ name: 'log_trace', args: { trace: {} } }],
                    candidates: [{ content: { parts: [
                        { functionCall: { name: 'log_trace', args: { trace: {} } } }
                    ] } }]
                };
            })()
        });

        // Turn 2: narrative
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "Follow-up narrative.",
                    functionCalls: () => null,
                    candidates: [{ content: { parts: [{ text: "Follow-up narrative." }] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        const records = (contextService as any).getHistoryRecords();
        
        // Interaction flow:
        // 1. User "Hello"
        // 2. Assistant log_trace (Loop 0)
        // 3. Tool result (Loop 0)
        // 4. Assistant "Follow-up narrative." (Loop 1)
        
        expect(sendMessageStreamMock).toHaveBeenCalledTimes(2);
        expect(records.some(r => r.content === 'Follow-up narrative.')).toBe(true);
        expect(records.some(r => r.toolName === 'log_trace')).toBe(true);
    });
});
