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
        try {
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

        } catch (error) {
            loggerService.error("TopologyService: Analysis failed", { error });
            return null;
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
            const linkTypeMap = new Map<string, number>();
            linkTypeList.forEach((t, i) => linkTypeMap.set(t, i));

            const K = linkTypeList.length || 1;

            loggerService.info(`TopologyService: Building 3D adjacency tensor (${N}x${N}x${K})`);

            // 1. Build Adjacency Tensor
            const buffer = tf.buffer([N, N, K]);
            symbols.forEach((s, i) => {
                (s.linked_patterns || []).forEach(l => {
                    const j = symbolMap.get(l.id);
                    if (j !== undefined && i !== j) {
                        const k = linkTypeMap.get(l.link_type || 'emergent') || 0;
                        buffer.set(1.0, i, j, k);
                    }
                });
            });

            const tensor = buffer.toTensor();

            // 2. CP-ALS Decomposition
            const factors = await this.decomposeCP(tensor, this.RANK, 5);
            const [A, B, C] = factors;

            // 3. Link Prediction (Slice-Based)
            let newLinks = 0;
            if (hygiene.positional.autoLink) {
                const predictedLinks = await this.findNewLinks3D(tensor, A, B, C, symbols, linkTypeList);
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

            tensor.dispose();
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

    private async findNewLinks3D(original: tf.Tensor, A: tf.Tensor, B: tf.Tensor, C: tf.Tensor, symbols: SymbolDef[], linkTypes: string[]): Promise<any[]> {
        const [I, J, K] = original.shape;
        const predicted: any[] = [];
        const rank = A.shape[1];

        for (let k = 0; k < K; k++) {
            await tf.nextFrame();
            const sliceLinks = tf.tidy(() => {
                const C_k = C.slice([k, 0], [1, rank]);
                const reconstructedSlice = A.mul(C_k).matMul(B.transpose());
                const originalSlice = original.slice([0, 0, k], [I, J, 1]).reshape([I, J]);
                const mask = originalSlice.equal(0);
                return reconstructedSlice.mul(mask.cast('float32'));
            });

            const data = await sliceLinks.data();
            for (let idx = 0; idx < data.length; idx++) {
                if (data[idx] > this.CONFIDENCE_THRESHOLD) {
                    const i = Math.floor(idx / J);
                    const j = idx % J;
                    if (i !== j) {
                        predicted.push({
                            sourceId: symbols[i].id,
                            targetId: symbols[j].id,
                            linkType: linkTypes[k],
                            confidence: data[idx]
                        });
                    }
                }
            }
            sliceLinks.dispose();
        }
        return predicted;
    }

    private async decomposeCP(X: tf.Tensor, rank: number, maxIter: number): Promise<tf.Tensor[]> {
        const [I, J, K] = X.shape;
        
        let A = tf.variable(tf.randomUniform([I, rank], 0, 1));
        let B = tf.variable(tf.randomUniform([J, rank], 0, 1));
        let C = tf.variable(tf.randomUniform([K, rank], 0, 1));

        // Using a simple SGD approach for each factor matrix instead of matrix inversion
        // This is much more memory stable and works on all backends.
        const learningRate = 0.05;

        for (let iter = 0; iter < maxIter; iter++) {
            await tf.nextFrame();
            
            // Optimize A, B, C sequentially
            for (const target of [A, B, C]) {
                const optimizer = tf.train.sgd(learningRate);
                optimizer.minimize(() => {
                    return tf.tidy(() => {
                        let totalLoss = tf.scalar(0);
                        const sampleSize = Math.min(K, 5);
                        for (let s = 0; s < sampleSize; s++) {
                            const k = Math.floor(Math.random() * K);
                            const sliceX = X.slice([0, 0, k], [I, J, 1]).reshape([I, J]);
                            const sliceCk = C.slice([k, 0], [1, rank]);
                            const slicePred = A.mul(sliceCk).matMul(B.transpose());
                            
                            const loss = tf.losses.meanSquaredError(sliceX, slicePred) as tf.Scalar;
                            totalLoss = totalLoss.add(loss);
                        }
                        return totalLoss;
                    });
                }, true, [target]);
                optimizer.dispose();
            }
            
            loggerService.debug(`TopologyService: CP-SGD Iteration ${iter + 1}/${maxIter} complete`);
        }

        return [A, B, C];
    }

    private async runSemanticAnalysis(symbols: SymbolDef[], hygiene: GraphHygieneSettings, userId?: string) {
        loggerService.info("TopologyService: Starting semantic analysis");
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

        if (embeddings.length !== symbols.length) return { newLinks: 0, redundantCount: 0 };

        const embTensor = tf.tensor2d(embeddings);
        const normEmb = tf.tidy(() => {
            const norms = embTensor.norm(2, 1, true);
            return embTensor.div(norms.add(1e-9));
        });
        const similarityMatrix = normEmb.matMul(normEmb.transpose());
        const similarities = await similarityMatrix.array() as number[][];

        if (hygiene.semantic.autoCompress) {
            const redundantGroups: string[][] = [];
            const visited = new Set<number>();

            for (let i = 0; i < symbols.length; i++) {
                if (visited.has(i)) continue;
                const group = [symbols[i].id];
                for (let j = i + 1; j < symbols.length; j++) {
                    if (similarities[i][j] > this.REDUNDANCY_THRESHOLD) {
                        group.push(symbols[j].id);
                        visited.add(j);
                    }
                }
                if (group.length > 1) redundantGroups.push(group);
            }

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

        if (hygiene.semantic.autoLink) {
            const predicted = [];
            for (let i = 0; i < symbols.length; i++) {
                for (let j = i + 1; j < symbols.length; j++) {
                    if (similarities[i][j] > this.CONFIDENCE_THRESHOLD) {
                        const hasLink = symbols[i].linked_patterns?.some(l => l.id === symbols[j].id) ||
                                        symbols[j].linked_patterns?.some(l => l.id === symbols[i].id);
                        
                        if (!hasLink) {
                            predicted.push({
                                sourceId: symbols[i].id,
                                targetId: symbols[j].id,
                                linkType: 'semantic_inference',
                                confidence: similarities[i][j]
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

        embTensor.dispose();
        normEmb.dispose();
        similarityMatrix.dispose();

        return { newLinks: newLinksCount, redundantCount };
    }

    private async runTriadicAnalysis(symbols: SymbolDef[], hygiene: GraphHygieneSettings, userId?: string) {
        loggerService.info("TopologyService: Starting triadic analysis");
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
                    redundantCount = validated.flat().length;
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

    private async promoteToTentative(links: any[], userId?: string) {
        loggerService.info(`TopologyService: Promoting ${links.length} predicted links to tentative store`);
        for (const link of links) {
            const tracePath = [{ symbol_id: link.sourceId }, { symbol_id: link.targetId }];
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
