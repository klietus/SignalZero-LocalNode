import { pipeline, env } from '@xenova/transformers';

let embeddingPipelinePromise: Promise<any> | null = null;

async function getEmbeddingPipeline() {
    if (!embeddingPipelinePromise) {
        env.allowLocalModels = true;
        embeddingPipelinePromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    }
    return embeddingPipelinePromise;
}

function tensorToVectors(result: any, fallbackCount: number): number[][] {
    if (!result) return new Array(fallbackCount).fill([]);

    const toList = (value: any): any => {
        if (Array.isArray(value)) return value;
        if (typeof value?.tolist === 'function') return value.tolist();
        return [];
    };

    const list = toList(result);
    if (Array.isArray(list) && list.length > 0 && Array.isArray(list[0])) {
        return list as number[][];
    }

    return [list as number[]];
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
    if (!texts || texts.length === 0) return [];

    try {
        const embedder = await getEmbeddingPipeline();
        const tensor = await embedder(texts, { pooling: 'mean', normalize: true });
        return tensorToVectors(tensor, texts.length);
    } catch (error) {
        console.error('[EmbeddingService] Embedding generation failed', error);
        return texts.map(() => []);
    }
}

export async function embedText(text: string): Promise<number[]> {
    const [embedding] = await embedTexts([text]);
    return embedding || [];
}

export function resetEmbeddingCache() {
    embeddingPipelinePromise = null;
}
