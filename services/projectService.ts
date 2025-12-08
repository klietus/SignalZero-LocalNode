
import JSZip from 'jszip';
import { domainService } from './domainService';
import { testService } from './testService';
import { ProjectMeta, ProjectImportStats, DomainImportStat } from '../types';

export const projectService = {
    /**
     * Exports the current project state (System Prompt, Domains, Tests, Meta) to a .szproject (zip) file.
     */
    export: async (meta: ProjectMeta, systemPrompt: string): Promise<Blob> => {
        console.group("Project Export");
        try {
            const zip = new JSZip();

            // 1. Metadata
            const currentMeta: ProjectMeta = {
                ...meta,
                updated_at: new Date().toISOString()
            };
            zip.file("metadata.json", JSON.stringify(currentMeta, null, 2));
            console.log("Metadata packaged.");

            // 2. System Prompt
            zip.file("system_prompt.txt", systemPrompt);
            console.log("System prompt packaged.");

            // 3. Tests
            const tests = testService.getTests();
            zip.file("tests.json", JSON.stringify(tests, null, 2));
            console.log(`Test suite packaged (${tests.length} tests).`);

            // 4. Domains
            const domainsFolder = zip.folder("domains");
            const domainIds = await domainService.listDomains();
            const allMeta = await domainService.getMetadata();

            for (const id of domainIds) {
                const symbols = await domainService.getSymbols(id);
                const meta = allMeta.find(m => m.id === id);
                
                const domainData = {
                    domain: id,
                    name: meta?.name || id,
                    description: meta?.description || "",
                    invariants: meta?.invariants || [],
                    items: symbols
                };
                domainsFolder?.file(`${id}.json`, JSON.stringify(domainData, null, 2));
            }
            console.log(`Domains packaged (${domainIds.length} domains).`);

            // Generate
            const content = await zip.generateAsync({ type: "blob" });
            console.log("Zip generation complete.");
            console.groupEnd();
            return content;

        } catch (error) {
            console.error("Export failed", error);
            console.groupEnd();
            throw error;
        }
    },

    /**
     * Imports a .szproject zip file, restoring context, domains, and tests.
     * Returns statistics about the import.
     */
    import: async (file: File): Promise<{ systemPrompt: string, stats: ProjectImportStats }> => {
        console.group("Project Import");
        try {
            const zip = await JSZip.loadAsync(file);
            let systemPrompt = "";
            let meta: ProjectMeta = {
                name: "Imported Project",
                version: "1.0.0",
                author: "Unknown",
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            };
            let testCount = 0;
            const domainStats: DomainImportStat[] = [];
            let totalSymbols = 0;

            // 1. Metadata
            const metaFile = zip.file("metadata.json");
            if (metaFile) {
                const metaStr = await metaFile.async("string");
                meta = JSON.parse(metaStr);
                console.log("Metadata loaded:", meta.name);
            }

            // 2. System Prompt
            const promptFile = zip.file("system_prompt.txt");
            if (promptFile) {
                systemPrompt = await promptFile.async("string");
                console.log("System Prompt loaded.");
            }

            // 3. Tests
            const testFile = zip.file("tests.json");
            if (testFile) {
                const tText = await testFile.async("string");
                const tests = JSON.parse(tText);
                testService.setTests(tests);
                testCount = tests.length;
                console.log(`Test suite loaded (${testCount} tests).`);
            }

            // 4. Domains (Wipe & Load)
            console.log("Clearing existing domains...");
            await domainService.clearAll();

            const domainsFolder = zip.folder("domains");
            if (domainsFolder) {
                // Collect promises to ensure all files are processed
                const filePromises: Promise<void>[] = [];

                domainsFolder.forEach((relativePath, file) => {
                    if (relativePath.endsWith('.json')) {
                        const p = (async () => {
                            try {
                                const content = await file.async("string");
                                const json = JSON.parse(content);
                                
                                if (json.items && Array.isArray(json.items)) {
                                    const id = json.domain || "imported";
                                    await domainService.bulkUpsert(id, json.items);
                                    await domainService.updateDomainMetadata(id, {
                                        name: json.name,
                                        description: json.description,
                                        invariants: json.invariants
                                    });
                                    
                                    domainStats.push({
                                        id: id,
                                        name: json.name || id,
                                        symbolCount: json.items.length
                                    });
                                    totalSymbols += json.items.length;
                                    console.log(`Loaded domain: ${id} (${json.items.length} symbols)`);
                                }
                            } catch (e) {
                                console.error(`Failed to parse domain file ${relativePath}`, e);
                            }
                        })();
                        filePromises.push(p);
                    }
                });

                await Promise.all(filePromises);
            }

            console.groupEnd();
            
            return {
                systemPrompt,
                stats: {
                    meta,
                    testCaseCount: testCount,
                    domains: domainStats,
                    totalSymbols
                }
            };

        } catch (error) {
            console.error("Import failed", error);
            console.groupEnd();
            throw error;
        }
    }
}
