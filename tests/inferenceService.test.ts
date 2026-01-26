import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sendMessageAndHandleTools } from '../services/inferenceService.ts';
import { contextService } from '../services/contextService.js';
import { contextWindowService } from '../services/contextWindowService.js';
import { settingsService } from '../services/settingsService.ts';
import { redisService } from '../services/redisService.js';

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
export const sendMessageStreamMock = vi.fn();
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

describe('InferenceService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        (settingsService.getInferenceSettings as any).mockReturnValue({
            provider: 'gemini',
            endpoint: 'http://localhost:1234/v1',
            apiKey: 'test-key',
            model: 'test-model',
            loopModel: 'test-model',
            visionModel: 'test-vision'
        });

        (contextService.getSession as any).mockResolvedValue({
            id: 'sess-1',
            type: 'conversation',
            status: 'open',
            createdAt: '',
            updatedAt: ''
        });

        sendMessageStreamMock.mockResolvedValue({
            stream: (async function* () {
                yield {
                    text: () => "",
                    functionCalls: () => null,
                    candidates: [{ content: { parts: [] } }]
                };
            })()
        });
    });

    it('should drive the tool loop and yield results', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn().mockResolvedValue({ status: 'ok' });
        
        (contextWindowService.constructContextWindow as any).mockResolvedValue([
            { role: 'system', content: 'Instruction' },
            { role: 'user', content: 'Hello' }
        ]);

        // Turn 1 calls tool
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "",
                    functionCalls: () => [{ name: 'find_symbols', args: { queries: [{ query: 'test' }] } }],
                    candidates: [{ content: { parts: [{ functionCall: { name: 'find_symbols', args: { queries: [{ query: 'test' }] } } }] } }]
                };
            })()
        });

        // Turn 2 returns text
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "I found some symbols.",
                    functionCalls: () => null,
                    candidates: [{ content: { parts: [{ text: "I found some symbols." }] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        
        const results = [];
        for await (const part of generator) {
            results.push(part);
        }

        expect(toolExecutor).toHaveBeenCalledWith('find_symbols', expect.anything());
        expect(results.some(r => r.text === 'I found some symbols.')).toBe(true);
    });

    it('should handle system audit failures and retry', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const toolExecutor = vi.fn();

        (contextWindowService.constructContextWindow as any).mockResolvedValue([
            { role: 'system', content: 'Instruction' },
            { role: 'user', content: 'Hello' }
        ]);

        // Audit failure turn (no tools)
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "No tools used here.",
                    functionCalls: () => null,
                    candidates: [{ content: { parts: [{ text: "No tools used here." }] } }]
                };
            })()
        });

        // Retry turn (after nudge)
        sendMessageStreamMock.mockResolvedValueOnce({
            stream: (async function* () {
                yield {
                    text: () => "Audited response.",
                    functionCalls: () => null,
                    candidates: [{ content: { parts: [{ text: "Audited response." }] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, 'Hello', toolExecutor, 'Instruction', 'sess-1');
        
        const chunks = [];
        for await (const part of generator) {
            if (part.text) chunks.push(part.text);
        }

        expect(chunks.some(c => c.includes('System Audit: Enforcing Symbolic Integrity'))).toBe(true);
    });

    it('should resolve attachments from Redis', async () => {
        const chatState = { messages: [], systemInstruction: 'Instruction', model: 'test-model' };
        const message = 'Check this <attachments>[{"id":"att-1","filename":"test.txt"}]</attachments>';
        
        (redisService.request as any).mockResolvedValue(JSON.stringify({
            type: 'text',
            content: 'Attached file content'
        }));

        sendMessageStreamMock.mockResolvedValue({
            stream: (async function* () {
                yield {
                    text: () => "Received.",
                    functionCalls: () => null,
                    candidates: [{ content: { parts: [{ text: "Received." }] } }]
                };
            })()
        });

        const generator = sendMessageAndHandleTools(chatState as any, message, vi.fn(), 'Instruction', 'sess-1');
        for await (const _ of generator) {}

        expect(contextService.recordMessage).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            content: expect.stringContaining('Attached file content')
        }));
    });
});
