import * as tf from '@tensorflow/tfjs';
import '@tensorflow/tfjs-backend-wasm';
import { domainService } from './domainService.js';
import { symbolCacheService } from './symbolCacheService.js';
import { tentativeLinkService } from './tentativeLinkService.js';
import { loggerService } from './loggerService.js';
import { settingsService } from './settingsService.js';
import { getClient, getGeminiClient, extractJson } from './inferenceService.js';
import { eventBusService, KernelEventType } from './eventBusService.js';
import { SymbolDef, SymbolLink, GraphHygieneSettings } from '../types.js';

export interface TopologyStats {
    symbolCount: number;
    linkCount: number;
    linkTypes: string[];
    reconstructionError: number;
    newLinksPredicted: number;
    redundantSymbolsFound: number;
}

class TopologyService {
    private readonly CONFIDENCE_THRESHOLD = 0.85;
    private readonly REDUNDANCY_THRESHOLD = 0.98;
    private readonly RANK = 20; // Latent factor dimension
    private isAnalyzing = false;

    constructor() {
        // Initialize backend - Prefer wasm, fallback to cpu in tests or if wasm fails
        const backend = process.env.NODE_ENV === 'test' ? 'cpu' : 'wasm';
        
        const initBackend = async () => {
            try {
                await tf.setBackend(backend);
                await tf.ready();
            } catch (e) {
                if (backend === 'wasm') {
                    await tf.setBackend('cpu');
                }
            }
            loggerService.info(`TopologyService: TensorFlow ${tf.getBackend()} backend initialized`);
        };

        initBackend();
    }

    /**
     * Executes the global topology analysis loop.
     * If specificStrategy is provided, it runs only that one.
     * If overrideSettings is provided, it uses those instead of saved settings.
     */
    async analyze(userId?: string, specificStrategy?: string, overrideSettings?: GraphHygieneSettings): Promise<TopologyStats | null> {
        if (this.isAnalyzing) {
            loggerService.warn("TopologyService: Analysis already in progress, skipping request");
            return null;
        }

        try {
            this.isAnalyzing = true;
            tf.engine().startScope();
            await tf.ready();
            const hygiene = overrideSettings || await settingsService.getHygieneSettings();

            loggerService.info("TopologyService: Starting topology analysis", { 
                strategy: specificStrategy || 'full', 
                hygiene,
                isOverride: !!overrideSettings 
            });
            
            // 1. Fetch all symbols
            const allDomains = await domainService.listDomains(userId);
            const symbols: SymbolDef[] = [];
            for (const domainId of allDomains) {
                const domainSymbols = await domainService.getSymbols(domainId, userId);
                symbols.push(...domainSymbols);
            }

            if (symbols.length < 2) {
                loggerService.info("TopologyService: Not enough symbols for analysis");
                return null;
            }

            // Calculate global link stats
            const linkTypes = new Set<string>();
            let linkCount = 0;
            symbols.forEach(s => {
                (s.linked_patterns || []).forEach(l => {
                    linkTypes.add(l.link_type || 'emergent');
                    linkCount++;
                });
            });

            let newLinksPredicted = 0;
            let redundantSymbolsFound = 0;

            // --- STRATEGY: Dead Link Cleanup ---
            if (specificStrategy === 'deadLinkCleanup' || (specificStrategy === undefined && hygiene.deadLinkCleanup)) {
                await this.cleanupDeadLinks(symbols, userId);
            }

            // --- STRATEGY: Positional (Tensor) Analysis ---
            let reconstructionError = 0;
            if (specificStrategy === 'positional' || (specificStrategy === undefined && (hygiene.positional.autoCompress || hygiene.positional.autoLink))) {
                const positionalResults = await this.runPositionalAnalysis(symbols, hygiene, userId);
                newLinksPredicted += positionalResults.newLinks;
                redundantSymbolsFound += positionalResults.redundantCount;
                reconstructionError = positionalResults.reconstructionError || 0;
            }

            // --- STRATEGY: Semantic (Vector) Analysis ---
            if (specificStrategy === 'semantic' || (specificStrategy === undefined && (hygiene.semantic.autoCompress || hygiene.semantic.autoLink))) {
                const semanticResults = await this.runSemanticAnalysis(symbols, hygiene, userId);
                newLinksPredicted += semanticResults.newLinks;
                redundantSymbolsFound += semanticResults.redundantCount;
            }

            // --- STRATEGY: Triadic Analysis ---
            if (specificStrategy === 'triadic' || (specificStrategy === undefined && (hygiene.triadic.autoCompress || hygiene.triadic.autoLink))) {
                const triadicResults = await this.runTriadicAnalysis(symbols, hygiene, userId);
                newLinksPredicted += triadicResults.newLinks;
                redundantSymbolsFound += triadicResults.redundantCount;
            }

            // --- STRATEGY: Orphan Analysis ---
            if (specificStrategy === 'orphanAnalysis' || (specificStrategy === undefined && hygiene.orphanAnalysis)) {
                await this.analyzeOrphans(symbols, userId);
            }

            const stats: TopologyStats = {
                symbolCount: symbols.length,
                linkCount,
                linkTypes: Array.from(linkTypes), 
                reconstructionError,
                newLinksPredicted,
                redundantSymbolsFound
            };

            loggerService.info("TopologyService: Analysis complete", stats);
            return stats;

        } catch (error: any) {
            loggerService.error("TopologyService: Analysis failed", { 
                error: error?.message || String(error),
                stack: error?.stack
            });
            return null;
        } finally {
            tf.engine().endScope();
            this.isAnalyzing = false;
        }
    }

    private async runPositionalAnalysis(symbols: SymbolDef[], hygiene: GraphHygieneSettings, userId?: string) {
        try {
            const N = symbols.length;
            const symbolMap = new Map<string, number>();
            symbols.forEach((s, i) => symbolMap.set(s.id, i));

            const linkTypes = new Set<string>();
            symbols.forEach(s => {
                (s.linked_patterns || []).forEach(l => linkTypes.add(l.link_type || 'emergent'));
            });
            const linkTypeList = Array.from(linkTypes);
            const K = linkTypeList.length || 1;
            const linkTypeMap = new Map<string, number>();
            linkTypeList.forEach((t, i) => linkTypeMap.set(t, i));

            loggerService.info(`TopologyService: Building positional factors for ${N} symbols across ${K} link types`);

            // To avoid V8 size limit for large 3D tensors, we decompose by building the factors
            // directly from the sparse representation rather than one giant dense tensor.
            const rank = this.RANK;
            let A = tf.variable(tf.randomUniform([N, rank], 0, 1));
            let B = tf.variable(tf.randomUniform([N, rank], 0, 1));
            let C = tf.variable(tf.randomUniform([K, rank], 0, 1));

            const learningRate = 0.05;
            const maxIter = 5;

            // Simple SGD for CP decomposition without ever building the full dense tensor
            for (let iter = 0; iter < maxIter; iter++) {
                await tf.nextFrame();
                
                // Optimize factors A, B, C using sampled links
                for (const target of [A, B, C]) {
                    const optimizer = tf.train.sgd(learningRate);
                    optimizer.minimize(() => {
                        return tf.tidy(() => {
                            let totalLoss = tf.scalar(0);
                            const sampleSize = 100; // Sample 100 symbols
                            
                            for (let s = 0; s < sampleSize; s++) {
                                const i = Math.floor(Math.random() * N);
                                const sourceSymbol = symbols[i];
                                const links = sourceSymbol.linked_patterns || [];
                                
                                if (links.length === 0) continue;
                                
                                const l = links[Math.floor(Math.random() * links.length)];
                                const j = symbolMap.get(l.id);
                                if (j === undefined || i === j) continue;
                                
                                const k = linkTypeMap.get(l.link_type || 'emergent') || 0;
                                
                                // Slice factors
                                const Ai = A.slice([i, 0], [1, rank]);
                                const Bj = B.slice([j, 0], [1, rank]);
                                const Ck = C.slice([k, 0], [1, rank]);
                                
                                // Predicted link (inner product of factors)
                                const pred = Ai.mul(Bj).mul(Ck).sum();
                                const loss = tf.losses.meanSquaredError(tf.scalar(1.0), pred) as tf.Scalar;
                                totalLoss = totalLoss.add(loss);
                            }
                            return totalLoss;
                        });
                    }, true, [target]);
                    optimizer.dispose();
                }
                loggerService.debug(`TopologyService: CP-SGD Sparse Iteration ${iter + 1}/${maxIter} complete`);
            }

            // 3. Link Prediction
            let newLinks = 0;
            if (hygiene.positional.autoLink) {
                const predictedLinks = [];
                // Sample potential new links for large graphs instead of exhaustive check
                const samplePairs = 5000;
                for (let s = 0; s < samplePairs; s++) {
                    const i = Math.floor(Math.random() * N);
                    const j = Math.floor(Math.random() * N);
                    const k = Math.floor(Math.random() * K);
                    if (i === j) continue;

                    const score = await tf.tidy(() => {
                        const Ai = A.slice([i, 0], [1, rank]);
                        const Bj = B.slice([j, 0], [1, rank]);
                        const Ck = C.slice([k, 0], [1, rank]);
                        return Ai.mul(Bj).mul(Ck).sum().data();
                    });

                    if (score[0] > this.CONFIDENCE_THRESHOLD) {
                        const hasLink = symbols[i].linked_patterns?.some(l => l.id === symbols[j].id);
                        if (!hasLink) {
                            predictedLinks.push({
                                sourceId: symbols[i].id,
                                targetId: symbols[j].id,
                                linkType: linkTypeList[k],
                                confidence: score[0]
                            });
                        }
                    }
                }

                if (predictedLinks.length > 0) {
                    await this.promoteToTentative(predictedLinks, userId);
                    newLinks = predictedLinks.length;
                }
            }

            // 4. Redundancy Detection
            let redundantCount = 0;
            if (hygiene.positional.autoCompress) {
                const redundantGroups = this.findRedundantSymbols(A, symbols);
                if (redundantGroups.length > 0) {
                    const validated = [];
                    for (const group of redundantGroups) {
                        if (await this.validateCompression(group, symbols)) validated.push(group);
                    }
                    if (validated.length > 0) {
                        await this.mergeRedundantSymbols(validated, userId);
                        redundantCount = validated.flat().length;
                    }
                }
            }

            A.dispose();
            B.dispose();
            C.dispose();

            return { newLinks, redundantCount, reconstructionError: 0 };
        } catch (error: any) {
            loggerService.error("TopologyService: Positional analysis failed", { 
                error: error.message, 
                stack: error.stack 
            });
            return { newLinks: 0, redundantCount: 0 };
        }
    }

    private async runSemanticAnalysis(symbols: SymbolDef[], hygiene: GraphHygieneSettings, userId?: string) {
        loggerService.info("TopologyService: Starting semantic analysis", { symbolCount: symbols.length });
        let newLinksCount = 0;
        let redundantCount = 0;

        const texts = symbols.map(s => `${s.name}: ${s.role}`);
        
        let embeddings: number[][] = [];
        try {
            const { embedTexts } = await import('./embeddingService.js');
            embeddings = await embedTexts(texts);
        } catch (embErr) {
            loggerService.error("TopologyService: Embedding failed", { error: embErr });
            return { newLinks: 0, redundantCount: 0 };
        }

        const N = symbols.length;
        if (embeddings.length !== N) return { newLinks: 0, redundantCount: 0 };

        // Normalize all embeddings first
        const normalizedEmbeddings: number[][] = [];
        for (let i = 0; i < N; i++) {
            const emb = embeddings[i];
            const norm = Math.sqrt(emb.reduce((sum, val) => sum + val * val, 0));
            normalizedEmbeddings.push(emb.map(val => val / (norm + 1e-9)));
        }

        const chunkSize = 200;
        const allNormEmb = tf.tensor2d(normalizedEmbeddings);
        
        if (hygiene.semantic.autoCompress) {
            loggerService.info("TopologyService: Checking for semantic redundancy");
            const redundantGroups: string[][] = [];
            const visited = new Set<number>();

            for (let i = 0; i < N; i += chunkSize) {
                const end = Math.min(i + chunkSize, N);
                const chunk = allNormEmb.slice([i, 0], [end - i, -1]);
                const chunkSimilarities = await chunk.matMul(allNormEmb.transpose()).array() as number[][];
                
                for (let row = 0; row < chunkSimilarities.length; row++) {
                    const absI = i + row;
                    if (visited.has(absI)) continue;
                    
                    const group = [symbols[absI].id];
                    for (let absJ = absI + 1; absJ < N; absJ++) {
                        if (chunkSimilarities[row][absJ] > this.REDUNDANCY_THRESHOLD) {
                            group.push(symbols[absJ].id);
                            visited.add(absJ);
                        }
                    }
                    if (group.length > 1) {
                        redundantGroups.push(group);
                        visited.add(absI);
                    }
                }
                chunk.dispose();
            }

            if (redundantGroups.length > 0) {
                loggerService.info(`TopologyService: Found ${redundantGroups.length} potential redundant groups`);
                const validated = [];
                for (const group of redundantGroups) {
                    if (await this.validateCompression(group, symbols)) validated.push(group);
                }
                if (validated.length > 0) {
                    await this.mergeRedundantSymbols(validated, userId);
                    redundantCount = validated.reduce((acc, g) => acc + g.length - 1, 0);
                }
            }
        }

        if (hygiene.semantic.autoLink) {
            loggerService.info("TopologyService: Checking for semantic link opportunities");
            const predicted = [];
            for (let i = 0; i < N; i += chunkSize) {
                const end = Math.min(i + chunkSize, N);
                const chunk = allNormEmb.slice([i, 0], [end - i, -1]);
                const chunkSimilarities = await chunk.matMul(allNormEmb.transpose()).array() as number[][];
                
                for (let row = 0; row < chunkSimilarities.length; row++) {
                    const absI = i + row;
                    for (let absJ = absI + 1; absJ < N; absJ++) {
                        // Use a slightly lower threshold for potential links than for redundancy
                        if (chunkSimilarities[row][absJ] > this.CONFIDENCE_THRESHOLD && chunkSimilarities[row][absJ] <= this.REDUNDANCY_THRESHOLD) {
                            const hasLink = symbols[absI].linked_patterns?.some(l => l.id === symbols[absJ].id) ||
                                            symbols[absJ].linked_patterns?.some(l => l.id === symbols[absI].id);
                            
                            if (!hasLink) {
                                // LLM Validation for link
                                const validation = await this.validateLink(symbols[absI], symbols[absJ]);
                                if (validation.shouldLink) {
                                    predicted.push({
                                        sourceId: symbols[absI].id,
                                        targetId: symbols[absJ].id,
                                        linkType: validation.linkType || 'semantic_inference',
                                        confidence: chunkSimilarities[row][absJ]
                                    });
                                }
                            }
                        }
                    }
                }
                chunk.dispose();
            }

            if (predicted.length > 0) {
                await this.promoteToTentative(predicted, userId);
                newLinksCount = predicted.length;
            }
        }

        allNormEmb.dispose();

        return { newLinks: newLinksCount, redundantCount };
    }

    private async runTriadicAnalysis(symbols: SymbolDef[], hygiene: GraphHygieneSettings, userId?: string) {
        loggerService.info("TopologyService: Starting triadic analysis", { symbolCount: symbols.length });
        let redundantCount = 0;
        let newLinksCount = 0;

        if (hygiene.triadic.autoCompress) {
            const triadicGroups = new Map<string, string[]>();
            symbols.forEach(s => {
                if (!s.triad) return;
                const existing = triadicGroups.get(s.triad) || [];
                existing.push(s.id);
                triadicGroups.set(s.triad, existing);
            });

            const redundantGroups = Array.from(triadicGroups.values()).filter(g => g.length > 1);

            if (redundantGroups.length > 0) {
                const validated = [];
                for (const group of redundantGroups) {
                    if (await this.validateCompression(group, symbols)) validated.push(group);
                }
                if (validated.length > 0) {
                    await this.mergeRedundantSymbols(validated, userId);
                    redundantCount = validated.reduce((acc, g) => acc + g.length - 1, 0);
                }
            }
        }

        if (hygiene.triadic.autoLink) {
            const predicted = [];
            for (let i = 0; i < symbols.length; i++) {
                const triadI = symbols[i].triad;
                if (!triadI) continue;

                for (let j = i + 1; j < symbols.length; j++) {
                    const triadJ = symbols[j].triad;
                    if (triadI === triadJ) {
                        const hasLink = symbols[i].linked_patterns?.some(l => l.id === symbols[j].id) ||
                                        symbols[j].linked_patterns?.some(l => l.id === symbols[i].id);
                        
                        if (!hasLink) {
                            predicted.push({
                                sourceId: symbols[i].id,
                                targetId: symbols[j].id,
                                linkType: 'triadic_resonance',
                                confidence: 1.0
                            });
                        }
                    }
                }
            }
            if (predicted.length > 0) {
                await this.promoteToTentative(predicted, userId);
                newLinksCount = predicted.length;
            }
        }

        return { newLinks: newLinksCount, redundantCount };
    }

    private async cleanupDeadLinks(symbols: SymbolDef[], userId?: string) {
        loggerService.info("TopologyService: Starting dead link cleanup");
        const symbolIds = new Set(symbols.map(s => s.id));
        let deadLinksCount = 0;

        for (const s of symbols) {
            if (!s.linked_patterns) continue;
            
            const initialCount = s.linked_patterns.length;
            const validLinks = s.linked_patterns.filter(link => symbolIds.has(link.id));
            
            if (validLinks.length < initialCount) {
                deadLinksCount += (initialCount - validLinks.length);
                s.linked_patterns = validLinks;
                await domainService.addSymbol(s.symbol_domain, s, userId, true);
            }
        }

        if (deadLinksCount > 0) {
            loggerService.info(`TopologyService: Cleaned up ${deadLinksCount} dead links`);
        }
    }

    private async analyzeOrphans(symbols: SymbolDef[], userId?: string) {
        loggerService.info("TopologyService: Starting orphan analysis");
        const incomingLinks = new Set<string>();
        symbols.forEach(s => {
            (s.linked_patterns || []).forEach(l => incomingLinks.add(l.id));
        });

        const orphans = symbols.filter(s => {
            const hasOutgoing = s.linked_patterns && s.linked_patterns.length > 0;
            const hasIncoming = incomingLinks.has(s.id);
            return !hasOutgoing && !hasIncoming;
        });

        if (orphans.length > 0) {
            loggerService.info(`TopologyService: Found ${orphans.length} orphan symbols`);
            for (const orphan of orphans) {
                eventBusService.emit(KernelEventType.ORPHAN_DETECTED, { symbolId: orphan.id, domainId: orphan.symbol_domain });
            }
        }
    }

    private findRedundantSymbols(A: tf.Tensor, symbols: SymbolDef[]): string[][] {
        const normA = tf.tidy(() => {
            const norms = A.norm(2, 1, true);
            return A.div(norms.add(1e-9));
        });

        const S = normA.matMul(normA.transpose());
        const sData = S.arraySync() as number[][];
        
        const redundantGroups: string[][] = [];
        const visited = new Set<number>();

        for (let i = 0; i < symbols.length; i++) {
            if (visited.has(i)) continue;
            const group = [symbols[i].id];
            
            for (let j = i + 1; j < symbols.length; j++) {
                if (sData[i][j] > this.REDUNDANCY_THRESHOLD) {
                    group.push(symbols[j].id);
                    visited.add(j);
                }
            }

            if (group.length > 1) {
                redundantGroups.push(group);
            }
        }

        normA.dispose();
        S.dispose();
        return redundantGroups;
    }

    private async validateCompression(groupIds: string[], allSymbols: SymbolDef[]): Promise<boolean> {
        try {
            const settings = await settingsService.getInferenceSettings();
            const fastModel = settings.fastModel;
            if (!fastModel) return true;

            const groupSymbols = groupIds.map(id => allSymbols.find(s => s.id === id)).filter(Boolean) as SymbolDef[];
            if (groupSymbols.length < 2) return false;

            const symbolInfo = groupSymbols.map(s => {
                return `ID: ${s.id}\nName: ${s.name}\nRole: ${s.role}\nMacro: ${s.macro}`;
            }).join('\n\n---\n\n');

            const prompt = `Analyze the following symbols from a symbolic knowledge graph. Determine if they represent the EXACT SAME concept and can be safely merged into a single canonical symbol.
            
            Symbols to compare:
            ${symbolInfo}
            
            Are these the same concept? Output valid JSON only:
            {
              "isSame": true/false,
              "reason": "Brief explanation"
            }`;

            let isSame = false;

            if (settings.provider === 'gemini') {
                const client = await getGeminiClient();
                const model = client.getGenerativeModel({ 
                    model: fastModel,
                    generationConfig: { responseMimeType: "application/json" }
                });
                const result = await model.generateContent(prompt);
                const response = result.response.text();
                isSame = !!extractJson(response).isSame;
            } else {
                const client = await getClient();
                const result = await client.chat.completions.create({
                    model: fastModel,
                    messages: [{ role: "user", content: prompt }],
                    response_format: { type: "text" }
                });
                const response = result.choices[0]?.message?.content || "{}";
                isSame = !!extractJson(response).isSame;
            }

            loggerService.info(`TopologyService: LLM Validation for ${groupIds[0]}: ${isSame}`);
            return isSame;

        } catch (error) {
            loggerService.error("TopologyService: LLM Validation failed", { error });
            return false;
        }
    }

    private async validateLink(s1: SymbolDef, s2: SymbolDef): Promise<{ shouldLink: boolean, linkType?: string }> {
        try {
            const settings = await settingsService.getInferenceSettings();
            const fastModel = settings.fastModel;
            if (!fastModel) return { shouldLink: true, linkType: 'relates_to' };

            const prompt = `Analyze the two symbols from a symbolic knowledge graph. Determine if there is a STRONG and MEANINGFUL semantic relationship between them that justifies an automated link.
            
            Symbol 1:
            Name: ${s1.name}
            Role: ${s1.role}
            Macro: ${s1.macro}
            
            Symbol 2:
            Name: ${s2.name}
            Role: ${s2.role}
            Macro: ${s2.macro}
            
            Should these symbols be linked? Output valid JSON only.
            If "shouldLink" is true, you MUST choose the most appropriate "linkType" from this list:
            - relates_to: General association
            - depends_on: Symbol 1 requires Symbol 2 for its definition or function
            - instance_of: Symbol 1 is a specific example of the class/concept Symbol 2
            - part_of: Symbol 1 is a component of the aggregate Symbol 2
            - informs: Symbol 1 provides context or data to Symbol 2
            - constrained_by: Symbol 1 is limited or governed by the rule/invariant Symbol 2

            {
              "shouldLink": true/false,
              "reason": "Brief explanation",
              "linkType": "chosen_link_type"
            }`;

            let resultJson: any = {};

            if (settings.provider === 'gemini') {
                const client = await getGeminiClient();
                const model = client.getGenerativeModel({ 
                    model: fastModel,
                    generationConfig: { responseMimeType: "application/json" }
                });
                const result = await model.generateContent(prompt);
                const response = result.response.text();
                resultJson = extractJson(response);
            } else {
                const client = await getClient();
                const result = await client.chat.completions.create({
                    model: fastModel,
                    messages: [{ role: "user", content: prompt }],
                    response_format: { type: "text" }
                });
                const response = result.choices[0]?.message?.content || "{}";
                resultJson = extractJson(response);
            }

            return { 
                shouldLink: !!resultJson.shouldLink, 
                linkType: resultJson.linkType || 'relates_to' 
            };
        } catch (error) {
            loggerService.error("TopologyService: Link validation failed", { error });
            return { shouldLink: false };
        }
    }

    private async promoteToTentative(links: { sourceId: string, targetId: string, linkType: string, confidence: number }[], userId?: string) {
        loggerService.info(`TopologyService: Promoting ${links.length} predicted links to tentative store`);
        for (const link of links) {
            const tracePath = [
                { symbol_id: link.sourceId }, 
                { symbol_id: link.targetId, link_type: link.linkType, reason: 'Topology-based automated link prediction' }
            ];
            await tentativeLinkService.processTrace(tracePath, userId);
        }
    }

    private async mergeRedundantSymbols(groups: string[][], userId?: string) {
        for (const group of groups) {
            const canonicalId = group[0];
            const redundantIds = group.slice(1);
            
            loggerService.info(`TopologyService: Merging redundant symbols into ${canonicalId}`, { redundantIds });
            
            for (const oldId of redundantIds) {
                try {
                    await domainService.mergeSymbols(canonicalId, oldId, userId);
                    eventBusService.emit(KernelEventType.SYMBOL_COMPRESSION, { 
                        canonicalId, 
                        redundantId: oldId 
                    });
                } catch (error) {
                    loggerService.error(`TopologyService: Failed to merge ${oldId} into ${canonicalId}`, { error });
                }
            }
        }
    }
}

export const topologyService = new TopologyService();
