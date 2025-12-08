
import { UserProfile } from '../types';

// Storage Keys
const KEYS = {
  API_KEY: 'signalzero_api_key',
  USER_PROFILE: 'signalzero_user',
  THEME: 'signalzero_theme',
  ACTIVE_PROMPT: 'signalzero_active_prompt',
  VECTOR_USE_EXTERNAL: 'signalzero_use_external_vectordb',
  VECTOR_CHROMA_URL: 'signalzero_chroma_url',
  VECTOR_COLLECTION: 'signalzero_chroma_collection',
  REDIS_URL: 'signalzero_redis_url',
  REDIS_TOKEN: 'signalzero_redis_token',
};

export interface VectorSettings {
  useExternal: boolean;
  chromaUrl: string;
  collectionName: string;
}

export interface RedisSettings {
  redisUrl: string;
  redisToken: string;
}

export const settingsService = {
  // --- Core Identity ---
  getApiKey: (): string => {
    return localStorage.getItem(KEYS.API_KEY) || '';
  },
  
  setApiKey: (key: string) => {
    localStorage.setItem(KEYS.API_KEY, key);
  },

  getUser: (): UserProfile | null => {
    const raw = localStorage.getItem(KEYS.USER_PROFILE);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  setUser: (user: UserProfile | null) => {
    if (user) {
      localStorage.setItem(KEYS.USER_PROFILE, JSON.stringify(user));
    } else {
      localStorage.removeItem(KEYS.USER_PROFILE);
    }
  },

  // --- UI/System ---
  getTheme: (): 'light' | 'dark' => {
    return (localStorage.getItem(KEYS.THEME) as 'light' | 'dark') || 'dark';
  },

  setTheme: (theme: 'light' | 'dark') => {
    localStorage.setItem(KEYS.THEME, theme);
  },

  getSystemPrompt: (defaultPrompt: string): string => {
    return localStorage.getItem(KEYS.ACTIVE_PROMPT) || defaultPrompt;
  },

  setSystemPrompt: (prompt: string) => {
    localStorage.setItem(KEYS.ACTIVE_PROMPT, prompt);
  },

  clearSystemPrompt: () => {
      localStorage.removeItem(KEYS.ACTIVE_PROMPT);
  },

  // --- Redis Settings ---
  getRedisSettings: (): RedisSettings => {
    return {
      redisUrl: localStorage.getItem(KEYS.REDIS_URL) || '',
      redisToken: localStorage.getItem(KEYS.REDIS_TOKEN) || '',
    };
  },

  setRedisSettings: (settings: RedisSettings) => {
    localStorage.setItem(KEYS.REDIS_URL, settings.redisUrl);
    localStorage.setItem(KEYS.REDIS_TOKEN, settings.redisToken);
  },

  // --- Vector Database ---
  getVectorSettings: (): VectorSettings => {
    return {
      useExternal: localStorage.getItem(KEYS.VECTOR_USE_EXTERNAL) === 'true',
      chromaUrl: localStorage.getItem(KEYS.VECTOR_CHROMA_URL) || 'http://localhost:8000',
      collectionName: localStorage.getItem(KEYS.VECTOR_COLLECTION) || 'signalzero',
    };
  },

  setVectorSettings: (settings: VectorSettings) => {
    localStorage.setItem(KEYS.VECTOR_USE_EXTERNAL, String(settings.useExternal));
    localStorage.setItem(KEYS.VECTOR_CHROMA_URL, settings.chromaUrl);
    localStorage.setItem(KEYS.VECTOR_COLLECTION, settings.collectionName);
  },

  // --- Utilities ---
  clearAll: () => {
    localStorage.clear();
  }
};
