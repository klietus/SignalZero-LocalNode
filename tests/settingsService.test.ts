
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
        process.env.REDIS_SERVER = 'localhost';
        process.env.REDIS_PORT = '6379';
        process.env.REDIS_PASSWORD = 'token';

        const settings = settingsService.getRedisSettings();
        expect(settings).toEqual({
            redisUrl: 'redis://localhost:6379',
            redisToken: 'token',
            redisServer: 'localhost',
            redisPort: 6379,
            redisPassword: 'token'
        });
    });

    it('should set Redis settings', () => {
        settingsService.setRedisSettings({
            redisUrl: 'https://new-redis.com',
            redisToken: 'new-token',
            redisServer: 'new-redis.com',
            redisPort: 6380,
            redisPassword: 'new-password'
        });

        expect(process.env.REDIS_URL).toBe('https://new-redis.com');
        expect(process.env.REDIS_TOKEN).toBe('new-token');
        expect(process.env.REDIS_SERVER).toBe('new-redis.com');
        expect(process.env.REDIS_PORT).toBe('6380');
        expect(process.env.REDIS_PASSWORD).toBe('new-password');
    });

    it('should derive Redis host details from URL when specific env vars are missing', () => {
        process.env.REDIS_URL = 'redis://:secret@derived-host:6381';
        delete process.env.REDIS_SERVER;
        delete process.env.REDIS_PORT;
        delete process.env.REDIS_PASSWORD;
        delete process.env.REDIS_TOKEN;

        const settings = settingsService.getRedisSettings();
        expect(settings).toEqual({
            redisUrl: 'redis://:secret@derived-host:6381',
            redisToken: '',
            redisServer: 'derived-host',
            redisPort: 6381,
            redisPassword: 'secret'
        });
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

    it('should aggregate system settings including inference settings', async () => {
        process.env.REDIS_SERVER = 'redis-host';
        process.env.REDIS_PORT = '6390';
        process.env.REDIS_PASSWORD = 'pw';
        process.env.CHROMA_URL = 'http://chroma:8000';
        process.env.CHROMA_COLLECTION = 'col';
        process.env.USE_EXTERNAL_VECTOR_DB = 'false';
        process.env.INFERENCE_ENDPOINT = 'http://localhost:1234/v1';
        process.env.INFERENCE_MODEL = 'Meta-Llama-3-70B-Instruct';
        process.env.INFERENCE_API_KEY = '';
        delete process.env.INFERENCE_LOOP_MODEL;

        const systemSettings = await settingsService.getSystemSettings();

        expect(systemSettings).toEqual({
            redis: {
                server: 'redis-host',
                port: 6390,
                password: 'pw'
            },
            chroma: {
                url: 'http://chroma:8000',
                collection: 'col',
                useExternal: false
            },
            inference: {
                endpoint: 'http://localhost:1234/v1',
                model: 'Meta-Llama-3-70B-Instruct',
                provider: 'local',
                apiKey: '',
                loopModel: 'Meta-Llama-3-70B-Instruct',
                visionModel: 'zai-org/glm-4.6v-flash',
                savedConfigs: expect.any(Object)
            },
            googleSearch: {
                apiKey: '',
                cx: ''
            },
            voice: {
                pulseServer: '',
                wakeWord: 'axiom'
            },
            adminUser: undefined
        });
    });

    it('should set system settings and merge partial updates', async () => {
        process.env.INFERENCE_API_KEY = '';
        await settingsService.setSystemSettings({
            redis: {
                server: 'initial-host',
                port: 6379,
                password: 'initial'
            },
            chroma: {
                url: 'http://initial-chroma',
                collection: 'initial-collection',
                useExternal: true
            },
            inference: {
                endpoint: 'http://localhost:1234/v1',
                model: 'lmstudio-community/Meta-Llama-3-70B-Instruct'
            }
        });

        await settingsService.setSystemSettings({
            redis: { password: 'updated-pw' },
            chroma: { collection: 'updated-collection' },
            inference: { model: 'Meta-Llama-3-70B-Instruct' }
        });

        const settings = await settingsService.getSystemSettings();
        expect(settings).toEqual({
            redis: {
                server: 'initial-host',
                port: 6379,
                password: 'updated-pw'
            },
            chroma: {
                url: 'http://initial-chroma',
                collection: 'updated-collection',
                useExternal: true
            },
            inference: {
                endpoint: 'http://localhost:1234/v1',
                model: 'Meta-Llama-3-70B-Instruct',
                provider: 'local',
                apiKey: '',
                loopModel: 'Meta-Llama-3-70B-Instruct',
                visionModel: 'zai-org/glm-4.6v-flash',
                savedConfigs: expect.any(Object)
            },
            googleSearch: {
                apiKey: '',
                cx: ''
            },
            voice: {
                pulseServer: '',
                wakeWord: 'axiom'
            },
            adminUser: undefined
        });
    });
});
