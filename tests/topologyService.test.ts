import { describe, it, expect, beforeEach, vi } from 'vitest';
import { topologyService } from '../services/topologyService.ts';
import { domainService } from '../services/domainService.ts';
import { settingsService } from '../services/settingsService.ts';
import { tentativeLinkService } from '../services/tentativeLinkService.ts';

vi.mock('../services/domainService.ts', () => ({
    domainService: {
        listDomains: vi.fn(),
        getSymbols: vi.fn(),
        addSymbol: vi.fn(),
        mergeSymbols: vi.fn(),
        loadSymbols: vi.fn(),
        search: vi.fn().mockResolvedValue([]),
    }
}));

vi.mock('../services/settingsService.ts', () => ({
    settingsService: {
        getHygieneSettings: vi.fn().mockResolvedValue({
            positional: { autoCompress: false, autoLink: false },
            semantic: { autoCompress: true, autoLink: true },
            triadic: { autoCompress: true, autoLink: true },
            deadLinkCleanup: true,
            orphanAnalysis: true
        }),
        getInferenceSettings: vi.fn().mockResolvedValue({
            provider: 'openai',
            model: 'gpt-4o',
            fastModel: 'gpt-4o-mini'
        })
    }
}));

vi.mock('../services/tentativeLinkService.ts', () => ({
    tentativeLinkService: {
        processTrace: vi.fn(),
    }
}));

// Mock embeddingService
vi.mock('../services/embeddingService.ts', () => ({
    embedTexts: vi.fn().mockResolvedValue([
        [0.1, 0.2], // S1
        [0.11, 0.21], // S2 (Similar to S1)
        [0.9, 0.9], // S3 (Different)
    ])
}));

// Mock inferenceService
vi.mock('../services/inferenceService.ts', () => ({
    getClient: vi.fn().mockResolvedValue({
        chat: {
            completions: {
                create: vi.fn().mockResolvedValue({
                    choices: [{ message: { content: '{"shouldLink": true, "isSame": true, "linkType": "relates_to"}' } }]
                })
            }
        }
    }),
    getGeminiClient: vi.fn(),
    extractJson: (text: string) => JSON.parse(text)
}));

describe('TopologyService', () => {
    const mockSymbols = [
        { id: 'S1', name: 'Concept A', role: 'A core concept', symbol_domain: 'dom1', linked_patterns: [{ id: 'S2' }] },
        { id: 'S2', name: 'Concept A Prime', role: 'A very similar concept', symbol_domain: 'dom1', linked_patterns: [{ id: 'S1' }] },
        { id: 'S3', name: 'Concept B', role: 'A different concept', symbol_domain: 'dom1', linked_patterns: [{ id: 'S2' }] },
    ];

    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should run semantic analysis and identify redundancy', async () => {
        vi.mocked(domainService.listDomains).mockResolvedValue([{ id: 'dom1' }] as any);
        vi.mocked(domainService.getSymbols).mockResolvedValue(mockSymbols as any);

        const stats = await topologyService.analyze();

        expect(stats).toBeDefined();
        expect(stats?.symbolCount).toBe(3);
        // S1 and S2 are similar in mock embeddings
        expect(domainService.mergeSymbols).toHaveBeenCalledWith('S1', 'S2', undefined);
    });

    it('should run triadic analysis and predict links', async () => {
        // S1 <-> S2, S2 <-> S3. Potential triad: S1 <-> S3
        vi.mocked(domainService.listDomains).mockResolvedValue([{ id: 'dom1' }] as any);
        vi.mocked(domainService.getSymbols).mockResolvedValue(mockSymbols as any);

        const stats = await topologyService.analyze();

        expect(stats?.newLinksPredicted).toBeGreaterThan(0);
        expect(tentativeLinkService.processTrace).toHaveBeenCalled();
    });

    it('should cleanup dead links', async () => {
        const symbolsWithDeadLink = [
            { id: 'S1', symbol_domain: 'dom1', linked_patterns: [{ id: 'NON_EXISTENT' }] },
            { id: 'S2', symbol_domain: 'dom1', linked_patterns: [] }
        ];
        vi.mocked(domainService.listDomains).mockResolvedValue([{ id: 'dom1' }] as any);
        vi.mocked(domainService.getSymbols).mockResolvedValue(symbolsWithDeadLink as any);

        await topologyService.analyze();

        expect(symbolsWithDeadLink[0].linked_patterns.length).toBe(0);
        expect(domainService.addSymbol).toHaveBeenCalled();
    });

    it('should heal orphans via semantic search', async () => {
        const orphan = { id: 'ORPHAN_1', name: 'Alone', role: 'No friends', symbol_domain: 'dom1', linked_patterns: [] };
        const candidate = { id: 'FRIEND_1', name: 'Potential Friend', role: 'Matches well', symbol_domain: 'dom1' };
        
        vi.mocked(domainService.listDomains).mockResolvedValue([{ id: 'dom1' }] as any);
        vi.mocked(domainService.getSymbols).mockResolvedValue([orphan, candidate] as any);
        vi.mocked(domainService.search).mockResolvedValue([candidate] as any);

        await topologyService.analyze();

        expect(domainService.search).toHaveBeenCalledWith(expect.stringContaining('Alone'), 5, expect.any(Object), undefined);
        expect(tentativeLinkService.processTrace).toHaveBeenCalled();
    });
});
