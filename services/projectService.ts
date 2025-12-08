import { loggerService } from './loggerService.ts';
import JSZip from 'jszip';
import { domainService } from './domainService.ts';
import { testService } from './testService.ts';
import { ProjectMeta, ProjectImportStats, DomainImportStat } from '../types.ts';
import { redisService } from './redisService.ts';

const ACTIVE_PROJECT_KEY = 'sz:project:active:meta';

const cacheActiveProjectMeta = async (meta: ProjectMeta) => {
    try {
        await redisService.request(['SET', ACTIVE_PROJECT_KEY, JSON.stringify(meta)]);
    } catch (error) {
        loggerService.error('Project Import: Failed to cache active project metadata', { error });
    }
};

export const projectService = {
    /**
     * Exports the current project state to a .szproject (zip) blob.
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

            // 2. System Prompt
            zip.file("system_prompt.txt", systemPrompt);

            // 3. Tests
            const tests = testService.getTests();
            zip.file("tests.json", JSON.stringify(tests, null, 2));

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

            const content = await zip.generateAsync({ type: "blob" });
            console.groupEnd();
            return content;

        } catch (error) {
            console.error("Export failed", error);
            console.groupEnd();
            throw error;
        }
    },

    /**
     * Imports a .szproject zip file.
     */
    import: async (file: Blob | File | ArrayBuffer | Uint8Array | Buffer): Promise<{ systemPrompt: string, stats: ProjectImportStats }> => {
        loggerService.info("Project Import: Starting import process.");
        try {
            loggerService.info("Project Import: Cracking the zip file.");
            const zip = await JSZip.loadAsync(file);
            loggerService.info("Project Import: Zip file cracked. Parsing contents.");

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
                loggerService.info(`Project Import: Parsed metadata for project '${meta.name}'.`);
            }

            // 2. System Prompt
            const promptFile = zip.file("system_prompt.txt");
            if (promptFile) {
                systemPrompt = await promptFile.async("string");
                loggerService.info("Project Import: Parsed system prompt.");
            }

            // 3. Tests
            const testFile = zip.file("tests.json");
            if (testFile) {
                const tText = await testFile.async("string");
                const tests = JSON.parse(tText);
                testService.setTests(tests);
                testCount = tests.length;
                loggerService.info(`Project Import: Loaded ${testCount} test cases.`);
            }

            // 4. Domains
            loggerService.info("Project Import: Clearing existing domains.");
            await domainService.clearAll();
            loggerService.info("Project Import: Processing domains from zip.");

            const domainsFolder = zip.folder("domains");
            if (domainsFolder) {
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
                                    loggerService.info(`Project Import: Loaded domain '${id}' with ${json.items.length} symbols.`);
                                }
                            } catch (e) {
                                loggerService.error(`Project Import: Failed to parse domain file ${relativePath}`, { error: e });
                            }
                        })();
                        filePromises.push(p);
                    }
                });

                await Promise.all(filePromises);
            }
            loggerService.info("Project Import: All domains processed. Project loading complete.");

            await cacheActiveProjectMeta(meta);

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
            loggerService.error("Project Import: Import failed", { error });
            console.groupEnd();
            throw error;
        }
    },

    getActiveProjectMeta: async (): Promise<ProjectMeta | null> => {
        try {
            const cached = await redisService.request(['GET', ACTIVE_PROJECT_KEY]);
            if (!cached) return null;
            return JSON.parse(cached);
        } catch (error) {
            loggerService.error('Project Service: Failed to retrieve active project metadata', { error });
            return null;
        }
    }
}
