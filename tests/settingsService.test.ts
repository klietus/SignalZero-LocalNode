
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { settingsService } from '../services/settingsService.ts';

describe('SettingsService', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        vi.resetModules();
        process.env = { ...originalEnv };
    });

    afterEach(() => {
        process.env = originalEnv;
    });

    it('should get API key from env', () => {
        process.env.API_KEY = 'test-key';
        expect(settingsService.getApiKey()).toBe('test-key');
    });

    it('should set API key to env', () => {
        settingsService.setApiKey('new-key');
        expect(process.env.API_KEY).toBe('new-key');
    });

    it('should get user profile from env', () => {
        process.env.USER_NAME = 'Test User';
        process.env.USER_EMAIL = 'test@example.com';
        
        const user = settingsService.getUser();
        expect(user).toEqual({
            name: 'Test User',
            email: 'test@example.com',
            picture: ''
        });
    });

    it('should get default user if env vars missing', () => {
        delete process.env.USER_NAME;
        delete process.env.USER_EMAIL;
        
        const user = settingsService.getUser();
        expect(user).toEqual({
            name: 'Kernel Admin',
            email: 'admin@signalzero.local',
            picture: ''
        });
    });

    it('should get Redis settings', () => {
        process.env.REDIS_URL = 'redis://localhost:6379';
        process.env.REDIS_TOKEN = 'token';
        
        const settings = settingsService.getRedisSettings();
        expect(settings).toEqual({
            redisUrl: 'redis://localhost:6379',
            redisToken: 'token'
        });
    });

    it('should set Redis settings', () => {
        settingsService.setRedisSettings({
            redisUrl: 'https://new-redis.com',
            redisToken: 'new-token'
        });
        
        expect(process.env.REDIS_URL).toBe('https://new-redis.com');
        expect(process.env.REDIS_TOKEN).toBe('new-token');
    });

    it('should get Vector settings', () => {
        process.env.USE_EXTERNAL_VECTOR_DB = 'true';
        process.env.CHROMA_URL = 'http://chroma:8000';
        process.env.CHROMA_COLLECTION = 'test-collection';
        
        const settings = settingsService.getVectorSettings();
        expect(settings).toEqual({
            useExternal: true,
            chromaUrl: 'http://chroma:8000',
            collectionName: 'test-collection'
        });
    });

    it('should set Vector settings', () => {
        settingsService.setVectorSettings({
            useExternal: false,
            chromaUrl: 'http://localhost:8000',
            collectionName: 'default'
        });
        
        expect(process.env.USE_EXTERNAL_VECTOR_DB).toBe('false');
        expect(process.env.CHROMA_URL).toBe('http://localhost:8000');
        expect(process.env.CHROMA_COLLECTION).toBe('default');
    });
});
