import { domainService } from './domainService.ts';
import { testService } from './testService.ts';
import { agentService } from './agentService.js';
import { ProjectMeta, ProjectImportStats } from '../types.ts';
import { systemPromptService } from './systemPromptService.ts';
import { mcpPromptService } from './mcpPromptService.ts';
import JSZip from 'jszip';

export const projectService = {
    async getActiveProjectMeta(): Promise<ProjectMeta> {
        // ... (implementation)
        return { name: 'SignalZero', version: '1.0', created_at: '', updated_at: '', author: '' }; // Dummy
    },

    async setActiveProjectMeta(meta: ProjectMeta) {
        // ...
    },

    async export(meta: ProjectMeta, systemPrompt: string, mcpPrompt: string): Promise<Blob> {
        const zip = new JSZip();
        
        // Meta
        zip.file('metadata.json', JSON.stringify(meta, null, 2));
        
        // System Prompt
        zip.file('system_prompt.txt', systemPrompt);

        // MCP Prompt
        zip.file('mcp_prompt.txt', mcpPrompt);

        // Domains & Symbols
        const allDomains = await domainService.listDomains();
        // Filter out user-specific domains (user, state) to only export global ones
        const globalDomains = allDomains.filter(d => d !== 'user' && d !== 'state');
        
        const domainsFolder = zip.folder('domains');
        for (const d of globalDomains) {
            const domainMeta = await domainService.getDomain(d); // Contains invariants
            const symbols = await domainService.getSymbols(d);
            if (domainsFolder) {
                domainsFolder.file(`${d}.json`, JSON.stringify({ meta: domainMeta, symbols }, null, 2));
            }
        }

        // Tests
        const testSets = await testService.listTestSets();
        if (testSets.length > 0) {
            zip.file('tests.json', JSON.stringify(testSets, null, 2));
        }

        // Agents
        const agents = await agentService.listAgents();
        if (agents.length > 0) {
            zip.file('agents.json', JSON.stringify(agents, null, 2));
        }

        return zip.generateAsync({ type: 'blob' });
    },

    async import(buffer: Buffer): Promise<{ stats: ProjectImportStats, systemPrompt?: string, mcpPrompt?: string }> {
        const zip = await JSZip.loadAsync(buffer);
        
        let meta: ProjectMeta = { name: 'Imported', version: '1.0', created_at: '', updated_at: '', author: '' };
        if (zip.file('metadata.json')) {
            const text = await zip.file('metadata.json')?.async('string');
            if (text) meta = JSON.parse(text);
        }

        let systemPrompt: string | undefined;
        if (zip.file('system_prompt.txt')) {
            systemPrompt = await zip.file('system_prompt.txt')?.async('string');
        }

        let mcpPrompt: string | undefined;
        if (zip.file('mcp_prompt.txt')) {
            mcpPrompt = await zip.file('mcp_prompt.txt')?.async('string');
        }

        // Domains
        const domains = [];
        const domainFiles = zip.folder('domains')?.filter((path, file) => path.endsWith('.json')) || [];
        let totalSymbols = 0;
        
        await domainService.clearAll();

        for (const file of domainFiles) {
            const text = await file.async('string');
            const data = JSON.parse(text);
            const { meta: dMeta, symbols } = data;
            
            await domainService.createDomain(dMeta.id, dMeta);
            if (Array.isArray(symbols)) {
                await domainService.bulkUpsert(dMeta.id, symbols, { bypassValidation: true });
                totalSymbols += symbols.length;
                domains.push({ id: dMeta.id, name: dMeta.name, symbolCount: symbols.length });
            }
        }

        // Tests
        let testCaseCount = 0;
        if (zip.file('tests.json')) {
            const text = await zip.file('tests.json')?.async('string');
            if (text) {
                const sets = JSON.parse(text);
                await testService.replaceAllTestSets(sets);
                testCaseCount = sets.reduce((sum: number, s: any) => sum + (s.tests?.length || 0), 0);
            }
        }

        // Agents (Loops backward compat)
        let agentCount = 0;
        const agentsFile = zip.file('agents.json') || zip.file('loops.json');
        if (agentsFile) {
            const text = await agentsFile.async('string');
            if (text) {
                const agents = JSON.parse(text);
                // Clear existing agents? Usually import clears state.
                // We don't have clearAllAgents on service, let's just upsert.
                if (Array.isArray(agents)) {
                    for (const agent of agents) {
                        await agentService.upsertAgent(
                            agent.id, 
                            agent.prompt, 
                            agent.enabled, 
                            agent.schedule
                        );
                    }
                    agentCount = agents.length;
                }
            }
        }

        return {
            stats: {
                meta,
                testCaseCount,
                agentCount,
                domains,
                totalSymbols
            },
            systemPrompt,
            mcpPrompt
        };
    }
};