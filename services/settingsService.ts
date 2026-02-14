import { UserProfile } from '../types.ts';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { redisService } from './redisService.ts';
import { loggerService } from './loggerService.ts';

dotenv.config();

// Settings file for local development / migration source
const SETTINGS_FILE = process.env.SETTINGS_FILE_PATH || path.join(process.cwd(), 'settings.json');
const SETTINGS_KEY = 'sz:settings:system';

// Detect Cloud Run / stateless environment
const isStateless = (): boolean => {
  return process.env.STATELESS === 'true' || 
         process.env.K_SERVICE !== undefined || // Cloud Run sets this
         process.env.SETTINGS_STORAGE === 'redis';
};

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

export interface VoiceSettings {
  pulseServer?: string;
  wakeWord?: string;
}

export interface InferenceSettings {
  provider: 'local' | 'openai' | 'gemini' | 'kimi2';
  apiKey: string;
  endpoint: string;
  model: string;
  loopModel: string;
  visionModel: string;
  savedConfigs?: Record<string, InferenceConfiguration>;
}

export interface InferenceConfiguration {
  apiKey: string;
  endpoint: string;
  model: string;
  loopModel: string;
  visionModel: string;
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
  voice?: VoiceSettings;
  adminUser?: AdminUser;
  googleSearch?: {
    apiKey?: string;
    cx?: string;
  };
}

// In-memory cache for settings (reduces Redis calls)
let _settingsCache: SystemSettings | null = null;
let _cacheTimestamp = 0;
const CACHE_TTL = 5000; // 5 seconds

// Load settings from Redis
const loadFromRedis = async (): Promise<SystemSettings | null> => {
  try {
    const data = await redisService.request(['GET', SETTINGS_KEY]);
    if (data) {
      return JSON.parse(data) as SystemSettings;
    }
  } catch (e) {
    loggerService.error('Failed to load settings from Redis', { error: e });
  }
  return null;
};

// Save settings to Redis
const saveToRedis = async (settings: SystemSettings): Promise<void> => {
  try {
    await redisService.request(['SET', SETTINGS_KEY, JSON.stringify(settings)]);
    _settingsCache = settings;
    _cacheTimestamp = Date.now();
  } catch (e) {
    loggerService.error('Failed to save settings to Redis', { error: e });
    throw e;
  }
};

// Load settings from file (for migration)
const loadFromFile = (): SystemSettings | null => {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return null;
  }
  
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    return data as SystemSettings;
  } catch (e) {
    loggerService.error('Failed to load settings from file', { error: e });
    return null;
  }
};

// Save settings to file (local mode only)
const saveToFile = (settings: SystemSettings): void => {
  if (isStateless()) {
    return; // Don't write files in stateless mode
  }
  
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch (e) {
    loggerService.error('Failed to save settings to file', { error: e });
  }
};

// Migration: Move file settings to Redis
export const migrateSettingsToRedis = async (): Promise<boolean> => {
  const fileSettings = loadFromFile();
  if (!fileSettings) {
    return false; // Nothing to migrate
  }
  
  const redisSettings = await loadFromRedis();
  if (redisSettings) {
    loggerService.info('Settings already exist in Redis, skipping migration');
    return false;
  }
  
  loggerService.info('Migrating settings from file to Redis...');
  
  // Don't store connection settings in Redis - keep them in env
  // Only store application settings
  const settingsToMigrate: SystemSettings = {
    inference: fileSettings.inference,
    voice: fileSettings.voice,
    googleSearch: fileSettings.googleSearch,
    // Don't migrate: redis, chroma, adminUser (userService handles users now)
  };
  
  await saveToRedis(settingsToMigrate);
  loggerService.info('Settings migration complete');
  
  // Rename the old file as backup
  try {
    const backupPath = `${SETTINGS_FILE}.backup`;
    fs.renameSync(SETTINGS_FILE, backupPath);
    loggerService.info(`Backed up old settings file to ${backupPath}`);
  } catch (e) {
    loggerService.warn('Could not backup old settings file', { error: e });
  }
  
  return true;
};

// Initialize settings on startup
export const initializeSettings = async (): Promise<void> => {
  if (isStateless()) {
    loggerService.info('Running in stateless mode - settings stored in Redis');
    await migrateSettingsToRedis();
  } else {
    loggerService.info('Running in local mode - settings from file with Redis fallback');
    // In local mode, try Redis first, fall back to file
    const redisSettings = await loadFromRedis();
    if (!redisSettings) {
      const fileSettings = loadFromFile();
      if (fileSettings) {
        await saveToRedis(fileSettings);
      }
    }
  }
};

// Get settings with caching
const getSettings = async (): Promise<SystemSettings> => {
  const now = Date.now();
  
  // Return cached if fresh
  if (_settingsCache && (now - _cacheTimestamp) < CACHE_TTL) {
    return _settingsCache;
  }
  
  // Try Redis first
  let settings = await loadFromRedis();
  
  // Fall back to file in local mode
  if (!settings && !isStateless()) {
    settings = loadFromFile();
    if (settings) {
      // Sync to Redis for next time
      await saveToRedis(settings).catch(() => {});
    }
  }
  
  // Default empty settings
  settings = settings || {};
  
  _settingsCache = settings;
  _cacheTimestamp = now;
  
  return settings;
};

// --- Connection Settings (Always from ENV) ---

const getRedisSettingsFromEnv = (): RedisSettings => {
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
};

const getVectorSettingsFromEnv = (): VectorSettings => {
  return {
    useExternal: process.env.USE_EXTERNAL_VECTOR_DB === 'true',
    chromaUrl: process.env.CHROMA_URL || 'http://localhost:8000',
    collectionName: process.env.CHROMA_COLLECTION || 'signalzero',
  };
};

export const settingsService = {
  // --- Initialization ---
  initialize: initializeSettings,
  migrateToRedis: migrateSettingsToRedis,
  
  isStateless: isStateless,

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

  setSystemPrompt: (prompt: string) => {},

  clearSystemPrompt: () => {},

  // --- Redis Settings (Always from ENV) ---
  getRedisSettings: getRedisSettingsFromEnv,

  setRedisSettings: (settings: RedisSettings) => {
    // In stateless mode, only update env vars (won't persist)
    process.env.REDIS_URL = settings.redisUrl;
    process.env.REDIS_TOKEN = settings.redisToken;
    process.env.REDIS_SERVER = settings.redisServer;
    process.env.REDIS_PORT = String(settings.redisPort);
    process.env.REDIS_PASSWORD = settings.redisPassword;
    
    // In local mode, also save to file for backward compatibility
    if (!isStateless()) {
      const current = loadFromFile() || {};
      current.redis = {
        server: settings.redisServer,
        port: settings.redisPort,
        password: settings.redisPassword,
      };
      saveToFile(current);
    }
  },

  // --- Vector Database (Always from ENV) ---
  getVectorSettings: getVectorSettingsFromEnv,

  setVectorSettings: (settings: VectorSettings) => {
    process.env.USE_EXTERNAL_VECTOR_DB = String(settings.useExternal);
    process.env.CHROMA_URL = settings.chromaUrl;
    process.env.CHROMA_COLLECTION = settings.collectionName;
    
    // In local mode, also save to file
    if (!isStateless()) {
      const current = loadFromFile() || {};
      current.chroma = {
        url: settings.chromaUrl,
        collection: settings.collectionName,
        useExternal: settings.useExternal,
      };
      saveToFile(current);
    }
  },

  // --- Inference Settings (Stored in Redis) ---
  getInferenceSettings: async (): Promise<InferenceSettings> => {
    const settings = await getSettings();
    const saved = settings.inference || {};
    
    return {
      provider: (saved.provider as 'local' | 'openai' | 'gemini' | 'kimi2') || 
                (process.env.INFERENCE_PROVIDER as 'local' | 'openai' | 'gemini' | 'kimi2') || 
                'local',
      apiKey: saved.apiKey || process.env.INFERENCE_API_KEY || '',
      endpoint: saved.endpoint || process.env.INFERENCE_ENDPOINT || 'http://localhost:1234/v1',
      model: saved.model || process.env.INFERENCE_MODEL || 'openai/gpt-oss-120b',
      loopModel: saved.loopModel || process.env.INFERENCE_LOOP_MODEL || saved.model || process.env.INFERENCE_MODEL || 'openai/gpt-oss-120b',
      visionModel: saved.visionModel || process.env.INFERENCE_VISION_MODEL || 'zai-org/glm-4.6v-flash',
      savedConfigs: saved.savedConfigs || {},
    };
  },

  setInferenceSettings: async (settings: InferenceSettings) => {
    const current = await getSettings();
    
    current.inference = {
      provider: settings.provider,
      apiKey: settings.apiKey,
      endpoint: settings.endpoint,
      model: settings.model,
      loopModel: settings.loopModel,
      visionModel: settings.visionModel,
      savedConfigs: settings.savedConfigs || current.inference?.savedConfigs || {},
    };
    
    await saveToRedis(current);
    
    // Also update env for current process
    process.env.INFERENCE_PROVIDER = settings.provider;
    process.env.INFERENCE_API_KEY = settings.apiKey;
    process.env.INFERENCE_ENDPOINT = settings.endpoint;
    process.env.INFERENCE_MODEL = settings.model;
    process.env.INFERENCE_LOOP_MODEL = settings.loopModel;
    process.env.INFERENCE_VISION_MODEL = settings.visionModel;
    
    // Local mode: also save to file
    if (!isStateless()) {
      saveToFile(current);
    }
  },

  // --- Google Search Settings (Stored in Redis) ---
  getGoogleSearchSettings: async (): Promise<{ apiKey: string; cx: string }> => {
    const settings = await getSettings();
    return {
      apiKey: settings.googleSearch?.apiKey || process.env.GOOGLE_CUSTOM_SEARCH_KEY || '',
      cx: settings.googleSearch?.cx || process.env.GOOGLE_CSE_ID || '',
    };
  },

  setGoogleSearchSettings: async (settings: { apiKey?: string; cx?: string }) => {
    const current = await getSettings();
    current.googleSearch = {
      apiKey: settings.apiKey ?? current.googleSearch?.apiKey ?? '',
      cx: settings.cx ?? current.googleSearch?.cx ?? '',
    };
    await saveToRedis(current);
    
    if (settings.apiKey !== undefined) process.env.GOOGLE_CUSTOM_SEARCH_KEY = settings.apiKey;
    if (settings.cx !== undefined) process.env.GOOGLE_CSE_ID = settings.cx;
    
    if (!isStateless()) {
      saveToFile(current);
    }
  },

  // --- Voice Settings (Stored in Redis) ---
  getVoiceSettings: async (): Promise<VoiceSettings> => {
    const settings = await getSettings();
    return {
      pulseServer: settings.voice?.pulseServer || process.env.PULSE_SERVER || '',
      wakeWord: settings.voice?.wakeWord || process.env.WAKE_WORD || 'axiom',
    };
  },

  setVoiceSettings: async (settings: VoiceSettings) => {
    const current = await getSettings();
    current.voice = {
      pulseServer: settings.pulseServer ?? current.voice?.pulseServer ?? '',
      wakeWord: settings.wakeWord ?? current.voice?.wakeWord ?? 'axiom',
    };
    await saveToRedis(current);
    
    if (settings.pulseServer !== undefined) process.env.PULSE_SERVER = settings.pulseServer;
    if (settings.wakeWord !== undefined) process.env.WAKE_WORD = settings.wakeWord;
    
    // Push config to Voice Server
    if (settings.pulseServer || settings.wakeWord) {
      const voiceUrl = 'http://voiceservice:8000';
      fetch(`${voiceUrl}/config`, {
          method: 'POST',
          headers: { 
              'Content-Type': 'application/json',
              'x-internal-key': process.env.INTERNAL_SERVICE_KEY || ''
          },
          body: JSON.stringify({
              pulse_server: settings.pulseServer,
              wake_word: settings.wakeWord
          })
      }).catch(err => loggerService.error("Failed to push config to Voice Server", { error: err }));
    }
    
    if (!isStateless()) {
      saveToFile(current);
    }
  },

  // --- Aggregated Settings ---
  get: async (): Promise<SystemSettings> => {
    const [inference, googleSearch, voice] = await Promise.all([
      settingsService.getInferenceSettings(),
      settingsService.getGoogleSearchSettings(),
      settingsService.getVoiceSettings(),
    ]);
    
    const redisSettings = getRedisSettingsFromEnv();
    const vectorSettings = getVectorSettingsFromEnv();
    
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
      inference,
      googleSearch,
      voice,
    };
  },

  update: async (settings: Partial<SystemSettings>) => {
    if (settings.redis) {
      const currentRedis = getRedisSettingsFromEnv();
      settingsService.setRedisSettings({
        ...currentRedis,
        redisServer: settings.redis.server ?? currentRedis.redisServer,
        redisPort: settings.redis.port ?? currentRedis.redisPort,
        redisPassword: settings.redis.password ?? currentRedis.redisPassword,
      });
    }

    if (settings.chroma) {
      const currentVector = getVectorSettingsFromEnv();
      settingsService.setVectorSettings({
        ...currentVector,
        useExternal: settings.chroma.useExternal ?? currentVector.useExternal,
        chromaUrl: settings.chroma.url ?? currentVector.chromaUrl,
        collectionName: settings.chroma.collection ?? currentVector.collectionName,
      });
    }

    if (settings.inference) {
      const currentInference = await settingsService.getInferenceSettings();
      await settingsService.setInferenceSettings({
        ...currentInference,
        ...settings.inference as InferenceSettings,
      });
    }

    if (settings.googleSearch) {
      await settingsService.setGoogleSearchSettings(settings.googleSearch);
    }

    if (settings.voice) {
      await settingsService.setVoiceSettings(settings.voice);
    }
  },

  // --- Legacy / Backward Compatibility ---
  getSystemSettings: async (): Promise<SystemSettings> => {
    return settingsService.get();
  },

  setSystemSettings: async (settings: SystemSettings) => {
    return settingsService.update(settings);
  },

  /**
   * Get legacy admin user from settings file for migration
   */
  getAdminUser: (): { username: string; passwordHash: string; salt: string } | null => {
    try {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      const settings = JSON.parse(data);
      if (settings?.admin?.username && settings?.admin?.passwordHash) {
        return {
          username: settings.admin.username,
          passwordHash: settings.admin.passwordHash,
          salt: settings.admin.salt || '',
        };
      }
    } catch (e) {
      // File doesn't exist or no admin section
    }
    return null;
  },

  clearAll: () => {
    // No-op - use update with empty values instead
  }
};
