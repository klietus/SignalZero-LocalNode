import { UserProfile } from '../types.ts';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');

export interface VectorSettings {
  useExternal: boolean;
  chromaUrl: string;
  collectionName: string;
}

export interface RedisSettings {
  redisUrl: string;
  redisToken: string;
  redisServer: string;
  redisPort: number;
  redisPassword: string;
}

export interface SystemSettings {
  redis?: {
    server?: string;
    port?: number;
    password?: string;
  };
  chroma?: {
    url?: string;
    collection?: string;
    useExternal?: boolean;
  };
  inference?: Partial<InferenceSettings>;
}

export interface InferenceSettings {
  provider: 'local' | 'openai';
  apiKey: string;
  endpoint: string;
  model: string;
  loopModel: string;
  visionModel: string;
}

const savePersistedSettings = (settings: any) => {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    console.error('Failed to save settings file', e);
  }
};

const loadPersistedSettings = () => {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      if (data.redis) {
        if (data.redis.server) process.env.REDIS_SERVER = data.redis.server;
        if (data.redis.port) process.env.REDIS_PORT = String(data.redis.port);
        if (data.redis.password) process.env.REDIS_PASSWORD = data.redis.password;
      }
      if (data.chroma) {
        if (data.chroma.url) process.env.CHROMA_URL = data.chroma.url;
        if (data.chroma.collection) process.env.CHROMA_COLLECTION = data.chroma.collection;
        if (data.chroma.useExternal !== undefined) process.env.USE_EXTERNAL_VECTOR_DB = String(data.chroma.useExternal);
      }
      if (data.inference) {
        if (data.inference.provider) process.env.INFERENCE_PROVIDER = data.inference.provider;
        if (data.inference.apiKey) process.env.INFERENCE_API_KEY = data.inference.apiKey;
        if (data.inference.endpoint) process.env.INFERENCE_ENDPOINT = data.inference.endpoint;
        if (data.inference.model) process.env.INFERENCE_MODEL = data.inference.model;
        if (data.inference.loopModel) process.env.INFERENCE_LOOP_MODEL = data.inference.loopModel;
        if (data.inference.visionModel) process.env.INFERENCE_VISION_MODEL = data.inference.visionModel;
      }
    } catch (e) {
      console.error('Failed to load settings file', e);
    }
  }
};

// Load settings on initialization
loadPersistedSettings();

export const settingsService = {
  // --- Core Identity ---
  getApiKey: (): string => {
    return process.env.API_KEY || '';
  },

  setApiKey: (key: string) => {
    process.env.API_KEY = key;
  },

  getUser: (): UserProfile | null => {
    return {
        name: process.env.USER_NAME || "Kernel Admin",
        email: process.env.USER_EMAIL || "admin@signalzero.local",
        picture: ""
    };
  },

  setUser: (user: UserProfile | null) => {
    // No-op in backend env
  },

  // --- UI/System ---
  getTheme: (): 'light' | 'dark' => 'dark',

  setTheme: (theme: 'light' | 'dark') => {},

  getSystemPrompt: (defaultPrompt: string): string => {
    return defaultPrompt;
  },

  setSystemPrompt: (prompt: string) => {
  },

  clearSystemPrompt: () => {},

  // --- Redis Settings ---
  getRedisSettings: (): RedisSettings => {
    const parseRedisUrl = (url: string) => {
      if (!url) {
        return { host: '', port: 0, password: '' };
      }

      try {
        const normalizedUrl = url.includes('://') ? url : `redis://${url}`;
        const parsed = new URL(normalizedUrl);

        return {
          host: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : 6379,
          password: parsed.password
        };
      } catch (e) {
        return { host: '', port: 0, password: '' };
      }
    };

    const redisUrl = process.env.REDIS_URL || '';
    const derived = parseRedisUrl(redisUrl);

    return {
      redisUrl,
      redisToken: process.env.REDIS_TOKEN || '',
      redisServer: process.env.REDIS_SERVER || derived.host,
      redisPort: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : (derived.port || 6379),
      redisPassword: process.env.REDIS_PASSWORD || process.env.REDIS_TOKEN || derived.password || '',
    };
  },

  setRedisSettings: (settings: RedisSettings) => {
    process.env.REDIS_URL = settings.redisUrl;
    process.env.REDIS_TOKEN = settings.redisToken;
    process.env.REDIS_SERVER = settings.redisServer;
    process.env.REDIS_PORT = String(settings.redisPort);
    process.env.REDIS_PASSWORD = settings.redisPassword;
  },

  // --- Vector Database ---
  getVectorSettings: (): VectorSettings => {
    return {
      useExternal: process.env.USE_EXTERNAL_VECTOR_DB === 'true',
      chromaUrl: process.env.CHROMA_URL || 'http://localhost:8000',
      collectionName: process.env.CHROMA_COLLECTION || 'signalzero',
    };
  },

  setVectorSettings: (settings: VectorSettings) => {
    process.env.USE_EXTERNAL_VECTOR_DB = String(settings.useExternal);
    process.env.CHROMA_URL = settings.chromaUrl;
    process.env.CHROMA_COLLECTION = settings.collectionName;
  },

  // --- Inference Settings ---
  getInferenceSettings: (): InferenceSettings => {
    return {
      provider: (process.env.INFERENCE_PROVIDER as 'local' | 'openai') || 'local',
      apiKey: process.env.INFERENCE_API_KEY || '',
      endpoint: process.env.INFERENCE_ENDPOINT || 'http://localhost:1234/v1',
      model: process.env.INFERENCE_MODEL || 'lmstudio-community/Meta-Llama-3-70B-Instruct',
      loopModel: process.env.INFERENCE_LOOP_MODEL || process.env.INFERENCE_MODEL || 'lmstudio-community/Meta-Llama-3-70B-Instruct',
      visionModel: process.env.INFERENCE_VISION_MODEL || 'gpt-4o-mini'
    };
  },

  setInferenceSettings: (settings: InferenceSettings) => {
    process.env.INFERENCE_PROVIDER = settings.provider;
    process.env.INFERENCE_API_KEY = settings.apiKey;
    process.env.INFERENCE_ENDPOINT = settings.endpoint;
    process.env.INFERENCE_MODEL = settings.model;
    process.env.INFERENCE_LOOP_MODEL = settings.loopModel;
    process.env.INFERENCE_VISION_MODEL = settings.visionModel;
  },

  // --- Aggregated Settings ---
  getSystemSettings: () => {
    const redisSettings = settingsService.getRedisSettings();
    const vectorSettings = settingsService.getVectorSettings();
    const inferenceSettings = settingsService.getInferenceSettings();

    return {
      redis: {
        server: redisSettings.redisServer,
        port: redisSettings.redisPort,
        password: redisSettings.redisPassword,
      },
      chroma: {
        url: vectorSettings.chromaUrl,
        collection: vectorSettings.collectionName,
        useExternal: vectorSettings.useExternal,
      },
      inference: {
        provider: inferenceSettings.provider,
        apiKey: inferenceSettings.apiKey,
        endpoint: inferenceSettings.endpoint,
        model: inferenceSettings.model,
        loopModel: inferenceSettings.loopModel,
        visionModel: inferenceSettings.visionModel,
      },
    };
  },

  setSystemSettings: (settings: SystemSettings) => {
    if (settings.redis) {
        const currentRedis = settingsService.getRedisSettings();
        const redisInput = settings.redis as Record<string, unknown>;
        settingsService.setRedisSettings({
          redisUrl: currentRedis.redisUrl,
          redisToken: currentRedis.redisToken,
          redisServer: (redisInput.server as string | undefined) ?? currentRedis.redisServer,
          redisPort: (redisInput.port as number | undefined) ?? currentRedis.redisPort,
          redisPassword: (redisInput.password as string | undefined) ?? currentRedis.redisPassword,
        });
    }

    if (settings.chroma) {
        const currentVector = settingsService.getVectorSettings();
        const chromaInput = settings.chroma as Record<string, unknown>;
        settingsService.setVectorSettings({
          useExternal: (chromaInput.useExternal as boolean | undefined) ?? currentVector.useExternal,
          chromaUrl: (chromaInput.url as string | undefined) ?? currentVector.chromaUrl,
          collectionName: (chromaInput.collection as string | undefined) ?? currentVector.collectionName,
        });
    }

    if (settings.inference) {
      const currentInference = settingsService.getInferenceSettings();
      const inferenceInput = settings.inference as Record<string, unknown>;
      settingsService.setInferenceSettings({
        provider: (inferenceInput.provider as 'local' | 'openai' | undefined) ?? currentInference.provider,
        apiKey: (inferenceInput.apiKey as string | undefined) ?? currentInference.apiKey,
        endpoint: (inferenceInput.endpoint as string | undefined) ?? currentInference.endpoint,
        model: (inferenceInput.model as string | undefined) ?? currentInference.model,
        loopModel: (inferenceInput.loopModel as string | undefined) ?? (inferenceInput.model as string | undefined) ?? currentInference.loopModel,
        visionModel: (inferenceInput.visionModel as string | undefined) ?? currentInference.visionModel,
      });
    }

    // Save aggregated settings to file
    savePersistedSettings(settingsService.getSystemSettings());
  },

  // --- Utilities ---
  clearAll: () => {
    // No-op
  }
};