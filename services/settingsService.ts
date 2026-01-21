import { UserProfile } from '../types.ts';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const SETTINGS_FILE = process.env.SETTINGS_FILE_PATH || path.join(process.cwd(), 'settings.json');

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

export interface AdminUser {
  username: string;
  passwordHash: string;
  salt: string;
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
  adminUser?: AdminUser;
  googleSearch?: {
    apiKey?: string;
    cx?: string;
  };
}

export interface InferenceConfiguration {
  apiKey: string;
  endpoint: string;
  model: string;
  loopModel: string;
  visionModel: string;
}

export interface InferenceSettings {
  provider: 'local' | 'openai' | 'gemini';
  apiKey: string;
  endpoint: string;
  model: string;
  loopModel: string;
  visionModel: string;
  savedConfigs?: Record<string, InferenceConfiguration>;
}

// In-memory store for saved configs, loaded from file
let _savedInferenceConfigs: Record<string, InferenceConfiguration> = {};
let _adminUser: AdminUser | null = null;

const savePersistedSettings = (settings: any) => {
  try {
    // Merge current savedConfigs into the object being saved
    const payload = {
      ...settings,
      inference: {
        ...settings.inference,
        savedConfigs: _savedInferenceConfigs
      },
      adminUser: _adminUser
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(payload, null, 2));
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
        
        if (data.inference.savedConfigs) {
           _savedInferenceConfigs = data.inference.savedConfigs;
        }
      }
      if (data.googleSearch) {
        if (data.googleSearch.apiKey) process.env.GOOGLE_CUSTOM_SEARCH_KEY = data.googleSearch.apiKey;
        if (data.googleSearch.cx) process.env.GOOGLE_CSE_ID = data.googleSearch.cx;
      }
      if (data.adminUser) {
          _adminUser = data.adminUser;
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

  // --- Admin Auth ---
  getAdminUser: (): AdminUser | null => _adminUser,
  
  setAdminUser: (user: AdminUser) => {
      _adminUser = user;
      savePersistedSettings(settingsService.getSystemSettings());
  },

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
      provider: (process.env.INFERENCE_PROVIDER as 'local' | 'openai' | 'gemini') || 'local',
      apiKey: process.env.INFERENCE_API_KEY || '',
      endpoint: process.env.INFERENCE_ENDPOINT || 'http://localhost:1234/v1',
      model: process.env.INFERENCE_MODEL || 'openai/gpt-oss-120b',
      loopModel: process.env.INFERENCE_LOOP_MODEL || process.env.INFERENCE_MODEL || 'openai/gpt-oss-120b',
      visionModel: process.env.INFERENCE_VISION_MODEL || 'zai-org/glm-4.6v-flash',
      savedConfigs: _savedInferenceConfigs
    };
  },

  setInferenceSettings: (settings: InferenceSettings) => {
    process.env.INFERENCE_PROVIDER = settings.provider;
    process.env.INFERENCE_API_KEY = settings.apiKey;
    process.env.INFERENCE_ENDPOINT = settings.endpoint;
    process.env.INFERENCE_MODEL = settings.model;
    process.env.INFERENCE_LOOP_MODEL = settings.loopModel;
    process.env.INFERENCE_VISION_MODEL = settings.visionModel;
    
    // Update the saved config for this provider
    if (settings.provider) {
        _savedInferenceConfigs[settings.provider] = {
            apiKey: settings.apiKey,
            endpoint: settings.endpoint,
            model: settings.model,
            loopModel: settings.loopModel,
            visionModel: settings.visionModel
        };
    }
    
    // If incoming settings has a bulk update for savedConfigs (e.g. from UI import), respect it
    if (settings.savedConfigs) {
        _savedInferenceConfigs = { ..._savedInferenceConfigs, ...settings.savedConfigs };
    }
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
      googleSearch: {
        apiKey: process.env.GOOGLE_CUSTOM_SEARCH_KEY || '',
        cx: process.env.GOOGLE_CSE_ID || ''
      },
      adminUser: _adminUser || undefined
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
        provider: (inferenceInput.provider as 'local' | 'openai' | 'gemini' | undefined) ?? currentInference.provider,
        apiKey: (inferenceInput.apiKey as string | undefined) ?? currentInference.apiKey,
        endpoint: (inferenceInput.endpoint as string | undefined) ?? currentInference.endpoint,
        model: (inferenceInput.model as string | undefined) ?? currentInference.model,
        loopModel: (inferenceInput.loopModel as string | undefined) ?? (inferenceInput.model as string | undefined) ?? currentInference.loopModel,
        visionModel: (inferenceInput.visionModel as string | undefined) ?? currentInference.visionModel,
      });
    }

    if (settings.googleSearch) {
        if (settings.googleSearch.apiKey !== undefined) process.env.GOOGLE_CUSTOM_SEARCH_KEY = settings.googleSearch.apiKey;
        if (settings.googleSearch.cx !== undefined) process.env.GOOGLE_CSE_ID = settings.googleSearch.cx;
    }

    if (settings.adminUser) {
        settingsService.setAdminUser(settings.adminUser);
    } else {
        // Save aggregated settings to file
        savePersistedSettings(settingsService.getSystemSettings());
    }
  },

  // --- Utilities ---
  clearAll: () => {
    // No-op
  }
};