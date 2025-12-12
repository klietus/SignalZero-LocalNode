import { GoogleGenAI } from "@google/genai";
import { domainService } from "./domainService.ts";
import { embedText } from "./embeddingService.ts";

interface DomainDescriptor {
    id: string;
    name: string;
    description: string;
    invariants: string[];
}

interface SimilarDomain extends DomainDescriptor {
    similarity: number;
}

const apiKey = process.env.API_KEY || "missing-api-key";
if (!process.env.API_KEY) {
    console.warn("WARNING: API_KEY not found in environment. Domain inference will not work until configured.");
}

const ai = new GoogleGenAI({ apiKey });

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

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ parts: [{ text: prompt }] }],
            config: { responseMimeType: "application/json" }
        });

        let parsed: any = {};
        try {
            parsed = JSON.parse(response.text || '{}');
        } catch (err) {
            throw new Error(`Failed to parse invariant JSON: ${String(err)}`);
        }

        if (!Array.isArray(parsed.invariants) || parsed.invariants.length === 0) {
            throw new Error('Model did not return invariants for the new domain.');
        }

        return {
            invariants: parsed.invariants as string[],
            reasoning: parsed.reasoning,
            context: contextualDomains,
        };
    },

    async createDomainWithInference(domainId: string, description: string, displayName?: string) {
        const exists = await domainService.hasDomain(domainId);
        if (exists) {
            throw new Error(`Domain '${domainId}' already exists.`);
        }

        const inference = await this.inferInvariants(domainId, description, displayName);
        const created = await domainService.createDomain(domainId, {
            name: displayName || domainId,
            description,
            invariants: inference.invariants,
        });

        return {
            domain: created,
            inferred_from: inference.context.map((c) => ({ id: c.id, similarity: c.similarity, invariants: c.invariants })),
            reasoning: inference.reasoning,
        };
    }
};
