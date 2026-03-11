import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendMessageAndHandleTools } from '../services/inferenceService.ts';
import { contextService } from '../services/contextService.js';
import { contextWindowService } from '../services/contextWindowService.js';
import { settingsService } from '../services/settingsService.ts';
import { symbolCacheService } from '../services/symbolCacheService.ts';

// Mock Services
vi.mock('../services/contextService', () => ({
    contextService: {
        getSession: vi.fn(),
        recordMessage: vi.fn(),
        isCancelled: vi.fn().mockResolvedValue(false),
        clearCancellation: vi.fn(),
        clearActiveMessage: vi.fn()
    }
}));

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
        
        const results = [];
        for await (const part of generator) {
            results.push(part);
        }

        // 1. Check that narrative was yielded to the user
        expect(results.some(r => r.text === 'This is the narrative text.')).toBe(true);

        // 2. Check recordMessage calls: 
        // 1 user message, 1 assistant (tools), 1 assistant (narrative), 1 tool result
        // Total should be 4
        expect(contextService.recordMessage).toHaveBeenCalledTimes(4);
        
        // User Message
        expect(contextService.recordMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            role: 'user',
            content: 'Hello'
        }), undefined, true);

        // Assistant Tool Turn: content should be empty because log_trace was present
        expect(contextService.recordMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            role: 'assistant',
            content: '',
            metadata: expect.objectContaining({ kind: 'assistant_response' })
        }), undefined, true);

        // Assistant Narrative Turn: content should be the text
        expect(contextService.recordMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            role: 'assistant',
            content: 'This is the narrative text.',
            metadata: expect.objectContaining({ kind: 'assistant_narrative' })
        }), undefined, true);

        // Tool Result Turn
        expect(contextService.recordMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            role: 'tool',
            toolName: 'log_trace'
        }), undefined, true);

        // 3. Check that loop terminated
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
        
        // Verify find_symbols turn kept its text because NO log_trace was in THAT turn
        expect(contextService.recordMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            role: 'assistant',
            content: 'I will search now.',
            metadata: expect.objectContaining({ kind: 'assistant_response' })
        }), undefined, true);
    });
});
