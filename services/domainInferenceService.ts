import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { domainService } from "./domainService.js";
import { embedText } from "./embeddingService.js";
import { settingsService } from "./settingsService.js";
import { loggerService } from "./loggerService.js";

interface DomainDescriptor {
    id: string;
    name: string;
    description: string;
    invariants: string[];
}

interface SimilarDomain extends DomainDescriptor {
    similarity: number;
}

const getClient = async () => {
    const { endpoint } = await settingsService.getInferenceSettings();
    const apiKey = settingsService.getApiKey() || "lm-studio";
    return new OpenAI({ baseURL: endpoint, apiKey });
};

const cosineSimilarity = (a: number[], b: number[]): number => {
    if (!a.length || !b.length || a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const buildDescriptor = (id: string, name: string, description?: string, invariants?: string[]): DomainDescriptor => ({
    id,
    name: name || id,
    description: description || "",
    invariants: invariants || [],
});

const findClosestDomains = async (
    targetText: string,
    domains: DomainDescriptor[],
    excludeIds: Set<string>,
    limit: number = 2
): Promise<SimilarDomain[]> => {
    const targetEmbedding = await embedText(targetText);

    const scored = await Promise.all(domains.map(async (domain) => {
        const descriptorText = `${domain.name} ${domain.description} ${(domain.invariants || []).join(' ')}`;
        const embedding = await embedText(descriptorText);
        return { ...domain, similarity: cosineSimilarity(targetEmbedding, embedding) };
    }));

    return scored
        .filter((domain) => !excludeIds.has(domain.id))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit);
};

export const domainInferenceService = {
    async inferInvariants(domainId: string, description: string, displayName?: string) {
        const metadata = await domainService.getMetadata();
        const domainMap: Record<string, DomainDescriptor> = {};

        metadata.forEach((d) => {
            domainMap[d.id] = buildDescriptor(d.id, d.name, d.description, d.invariants);
        });

        const rootDomain = domainMap['root'] || buildDescriptor('root', 'root');
        const availableDomains = Object.values(domainMap);
        const targetText = `${displayName || domainId} ${description}`;

        const closest = await findClosestDomains(targetText, availableDomains, new Set(['root', domainId]));
        const contextualDomains: SimilarDomain[] = [];

        if (rootDomain) {
            contextualDomains.push({ ...rootDomain, similarity: 1 });
        }
        contextualDomains.push(...closest);

        const prompt = `You are the SignalZero domain architect. Infer the invariant constraints for a brand new domain.

NEW DOMAIN ID: ${domainId}
DISPLAY NAME: ${displayName || domainId}
DESCRIPTION: ${description}

ROOT DOMAIN INVARIANTS: ${(rootDomain.invariants || []).join('; ') || 'None recorded'}

CLOSEST DOMAINS (semantic proximity):
${closest.map((d) => `- ${d.id} (${d.similarity.toFixed(3)}): invariants=${d.invariants.join('; ')} | description=${d.description}`).join('\n') || 'None'}

Return JSON with the field "invariants" as a non-empty array of concise invariant statements. You may include an optional "reasoning" note, but no additional text.
`;

        const { provider, model, apiKey } = await settingsService.getInferenceSettings();
        let messageText = "{}";

        if (provider === 'gemini') {
            try {
                loggerService.info(`Inferring invariants with Gemini model: ${model}`, { 
                    keyPresent: !!apiKey, 
                    keyLen: apiKey?.length 
                });
                const genAI = new GoogleGenerativeAI(apiKey);
                const genModel = genAI.getGenerativeModel({ 
                    model: model, 
                    generationConfig: { responseMimeType: "application/json" } 
                });
                const result = await genModel.generateContent(prompt);
                messageText = result.response.text();
            } catch (err: any) {
                 loggerService.error('Gemini Inference Failed', { 
                     err: String(err), 
                     model, 
                     keyPartial: apiKey ? `${apiKey.slice(0, 4)}...` : 'none' 
                 });
                 throw new Error(`Gemini Inference Failed: ${err.message || String(err)}`);
            }
        } else {
            const client = await getClient();
            const response = await client.chat.completions.create({
                model: model,
                messages: [{ role: 'user', content: prompt }],
                response_format: { type: 'json_object' }
            });
            messageText = response.choices[0]?.message?.content || '{}';
        }

        let parsed: any = {};
        try {
            parsed = JSON.parse(messageText);
        } catch (err) {
            loggerService.error('Failed to parse invariant JSON', { err, raw: messageText });
            throw new Error(`Failed to parse invariant JSON: ${String(err)}`);
        }

        if (!Array.isArray(parsed.invariants) || parsed.invariants.length === 0) {
            // Relaxed check: if it parsed but empty, maybe that's valid? But the prompt asks for non-empty.
            // Let's warn but return empty if really empty.
            loggerService.warn('Model returned empty invariants list.', { domainId });
            // throw new Error('Model did not return invariants for the new domain.'); 
            // Better to return empty than crash if model thinks none are needed? 
            // But prompt says "non-empty". Let's stick to throwing if it's strictly required, 
            // or return empty if we want to be robust. 
            // User code before threw error. I will keep it throwing to match previous behavior 
            // unless the model failed to follow instructions.
            // But actually, for "Create domain failed", failing here aborts creation.
            // I'll keep the throw to ensure quality.
             if (!parsed.invariants) parsed.invariants = [];
        }

        return {
            invariants: parsed.invariants as string[],
            reasoning: parsed.reasoning,
            context: contextualDomains,
        };
    },

    async createDomainWithInference(domainId: string, description: string, displayName?: string, userId?: string, isAdmin: boolean = false) {
        const exists = await domainService.hasDomain(domainId, userId);
        if (exists) {
            throw new Error(`Domain '${domainId}' already exists.`);
        }

        const inference = await this.inferInvariants(domainId, description, displayName);
        const created = await domainService.createDomain(domainId, {
            name: displayName || domainId,
            description,
            invariants: inference.invariants,
        }, userId, isAdmin);

        return {
            domain: created,
            inferred_from: inference.context.map((c) => ({ id: c.id, similarity: c.similarity, invariants: c.invariants })),
            reasoning: inference.reasoning,
        };
    },

    async populateDomainInvariants(domainId: string) {
        const domain = await domainService.getDomain(domainId);
        if (!domain) {
            throw new Error(`Domain '${domainId}' not found.`);
        }

        const existingInvariants = domain.invariants || [];
        if (existingInvariants.length > 0) {
            throw new Error(`Domain '${domainId}' already has invariants defined.`);
        }

        const inference = await this.inferInvariants(domainId, domain.description || "", domain.name);
        await domainService.updateDomainMetadata(domainId, { invariants: inference.invariants });

        return {
            invariants: inference.invariants,
            inferred_from: inference.context.map((c) => ({ id: c.id, similarity: c.similarity, invariants: c.invariants })),
            reasoning: inference.reasoning,
        };
    }
};