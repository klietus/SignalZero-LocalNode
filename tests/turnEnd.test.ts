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

    it('should end the turn immediately after log_trace call', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });

        // First turn response with log_trace
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "Analyzing...",
                    functionCalls: () => [
                        { name: 'log_trace', args: { activation_path: [] } }
                    ],
                    candidates: [{ content: { parts: [
                        { text: "Analyzing..." },
                        { functionCall: { name: 'log_trace', args: { activation_path: [] } } }
                    ] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        expect(toolExecutor).toHaveBeenCalledWith('log_trace', expect.anything());
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
                    text: () => "",
                    functionCalls: () => [{ name: 'find_symbols', args: { queries: [] } }],
                    candidates: [{ content: { parts: [{ functionCall: { name: 'find_symbols', args: { queries: [] } } }] } }]
                };
            })()
        });

        // Second turn returns log_trace
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "I found it. Logging trace.",
                    functionCalls: () => [{ name: 'log_trace', args: { activation_path: [] } }],
                    candidates: [{ content: { parts: [
                        { text: "I found it. Logging trace." },
                        { functionCall: { name: 'log_trace', args: { activation_path: [] } } }
                    ] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        // Should have called sendMessageStream twice
        expect(sendMessageStreamMock).toHaveBeenCalledTimes(2);
        expect(toolExecutor).toHaveBeenCalledWith('find_symbols', expect.anything());
        expect(toolExecutor).toHaveBeenCalledWith('log_trace', expect.anything());
    });
});
