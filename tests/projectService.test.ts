
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { projectService } from '../services/projectService.ts';
import { domainService } from '../services/domainService.ts';
import { testService } from '../services/testService.ts';
import { loopService } from '../services/loopService.ts';
import JSZip from 'jszip';

// Mock dependencies
vi.mock('../services/domainService');
vi.mock('../services/testService');
vi.mock('../services/loopService');

describe('ProjectService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        
        // Mock Domain Service
        vi.mocked(domainService.listDomains).mockResolvedValue(['d1']);
        vi.mocked(domainService.getSymbols).mockResolvedValue([{ id: 's1' }] as any);
        vi.mocked(domainService.getMetadata).mockResolvedValue([{ id: 'd1', name: 'Domain 1' }] as any);
        vi.mocked(domainService.clearAll).mockResolvedValue(undefined);
        vi.mocked(domainService.bulkUpsert).mockResolvedValue(undefined);
        vi.mocked(domainService.updateDomainMetadata).mockResolvedValue(undefined);

        // Mock Test Service
        vi.mocked(testService.getTests).mockResolvedValue([{ id: 't1', prompt: 'test prompt', expectedActivations: [] }] as any);
        vi.mocked(testService.setTests).mockResolvedValue(undefined);

        // Mock Loop Service
        vi.mocked(loopService.listLoops).mockResolvedValue([{ id: 'loop-1', schedule: '* * * * *', prompt: 'p', enabled: true, createdAt: '', updatedAt: '' }] as any);
        vi.mocked(loopService.replaceAllLoops).mockResolvedValue(undefined);
    });

    it('should export project as zip', async () => {
        const meta = { name: 'Test', version: '1.0', author: 'Me', created_at: '', updated_at: '' };
        const blob = await projectService.export(meta, 'system prompt');
        
        expect(blob).toBeDefined();
        // In Node vitest, Blob is available.
        expect(blob.size).toBeGreaterThan(0);

        // Verify content
        const buffer = await blob.arrayBuffer();
        const zip = await JSZip.loadAsync(buffer);
        
        expect(zip.file('metadata.json')).not.toBeNull();
        expect(zip.file('system_prompt.txt')).not.toBeNull();
        expect(zip.file('tests.json')).not.toBeNull();
        expect(zip.folder('domains')?.file('d1.json')).not.toBeNull();
        expect(zip.file('loops.json')).not.toBeNull();
    });

    it('should import project from zip buffer', async () => {
        // Create a real zip to import
        const zip = new JSZip();
        zip.file('metadata.json', JSON.stringify({ name: 'Imp' }));
        zip.file('system_prompt.txt', 'new prompt');
        zip.file('tests.json', JSON.stringify(['t1']));
        zip.file('loops.json', JSON.stringify([{ id: 'loop-1', schedule: '* * * * *', prompt: 'p', enabled: true, createdAt: '', updatedAt: '' }]));
        zip.folder('domains')?.file('d1.json', JSON.stringify({
            domain: 'd1',
            items: [{ id: 's1' }]
        }));
        
        const content = await zip.generateAsync({ type: 'nodebuffer' });

        const result = await projectService.import(content);
        
        expect(result.systemPrompt).toBe('new prompt');
        expect(result.stats.totalSymbols).toBe(1);
        expect(result.stats.loopCount).toBe(1);
        
        expect(domainService.clearAll).toHaveBeenCalled();
        expect(domainService.bulkUpsert).toHaveBeenCalledWith('d1', expect.anything(), { bypassValidation: true });
        expect(testService.setTests).toHaveBeenCalledWith(['t1']);
        expect(loopService.replaceAllLoops).toHaveBeenCalledWith(expect.any(Array));
    });
});
