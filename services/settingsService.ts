import { UserProfile } from '../types';
import dotenv from 'dotenv';
dotenv.config();

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
    return process.env.API_KEY || '';
  },
  
  // No-op for server-side setters usually, or implement FS write if needed.
  // For this implementation, we rely on env vars.
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
    // Could load from file, but default is fine for now
    return defaultPrompt;
  },

  setSystemPrompt: (prompt: string) => {
    // In a real backend, save to DB/File
  },

  clearSystemPrompt: () => {},

  // --- Redis Settings ---
  getRedisSettings: (): RedisSettings => {
    return {
      redisUrl: process.env.REDIS_URL || '',
      redisToken: process.env.REDIS_TOKEN || '',
    };
  },

  setRedisSettings: (settings: RedisSettings) => {
      process.env.REDIS_URL = settings.redisUrl;
      process.env.REDIS_TOKEN = settings.redisToken;
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

  // --- Utilities ---
  clearAll: () => {
    // No-op
  }
};