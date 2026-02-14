import { Redis } from 'ioredis';
import { settingsService } from './settingsService.js';
import { loggerService } from './loggerService.js';

const isTestEnv = process.env.NODE_ENV === 'test';

// Lightweight in-memory mock to avoid real Redis connections during tests
const mockStore = new Map<string, string>();
const mockSets = new Map<string, Set<string>>();
const mockHashes = new Map<string, Map<string, string>>();
const mockSortedSets = new Map<string, Map<string, number>>();

const getMockSet = (key: string) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set<string>());
    return mockSets.get(key)!;
};

const handleMockCommand = async (command: any[]): Promise<any> => {
    const [cmd, ...args] = command;
    switch (cmd) {
    case 'HINCRBY': {
        const [key, field, increment] = args;
        const hash = mockHashes.get(key) || new Map<string, string>();
        const current = parseInt(hash.get(field) || '0', 10);
        const next = current + parseInt(increment, 10);
        hash.set(field, String(next));
        mockHashes.set(key, hash);
        return next;
    }
    case 'HGET': {
        const [key, field] = args;
        const hash = mockHashes.get(key);
        return hash?.get(field) ?? null;
    }
    case 'HSET': {
        const key = args[0];
        const hash = mockHashes.get(key) || new Map<string, string>();
        let added = 0;
        for (let i = 1; i < args.length; i += 2) {
            const field = args[i];
            const value = args[i + 1];
            if (!hash.has(field)) added++;
            hash.set(field, value);
        }
        mockHashes.set(key, hash);
        return added;
    }
    case 'HDEL': {
        const key = args[0];
        const hash = mockHashes.get(key);
        if (!hash) return 0;
        let removed = 0;
        for (let i = 1; i < args.length; i++) {
            if (hash.delete(args[i])) removed++;
        }
        return removed;
    }
    case 'HGETALL': {
        const key = args[0];
        const hash = mockHashes.get(key);
        if (!hash) return [];
        const result: string[] = [];
        hash.forEach((val, key) => {
            result.push(key, val);
        });
        return result;
    }
    case 'KEYS': {
        const pattern = args[0].replace(/\*/g, '.*');
        const regex = new RegExp(`^${pattern}$`);
        const keys = [
            ...mockStore.keys(),
            ...mockSets.keys(),
            ...mockHashes.keys(),
            ...mockSortedSets.keys()
        ];
        return keys.filter(k => regex.test(k));
    }
    case 'EXPIRE': {
        return 1;
    }
    case 'ZADD': {
        const key = args[0];
        const set = mockSortedSets.get(key) || new Map<string, number>();
        for (let i = 1; i < args.length; i += 2) {
            const score = Number(args[i]);
            const value = args[i + 1];
            set.set(String(value), score);
        }
        mockSortedSets.set(key, set);
        return set.size;
    }
    case 'ZRANGEBYSCORE': {
        const key = args[0];
        const min = args[1] === '-inf' ? -Infinity : Number(args[1]);
        const max = args[2] === '+inf' ? Infinity : Number(args[2]);
        const set = mockSortedSets.get(key) || new Map<string, number>();
        return Array.from(set.entries())
            .filter(([, score]) => score >= min && score <= max)
            .sort((a, b) => a[1] - b[1])
            .map(([value]) => value);
    }
    case 'ZREM': {
        const key = args[0];
        const set = mockSortedSets.get(key) || new Map<string, number>();
        let removed = 0;
        for (let i = 1; i < args.length; i++) {
            if (set.delete(String(args[i]))) {
                removed++;
            }
        }
        mockSortedSets.set(key, set);
        return removed;
    }
    case 'SMEMBERS': {
        const set = getMockSet(args[0]);
        return Array.from(set);
    }
    case 'SADD': {
        const set = getMockSet(args[0]);
        let added = 0;
        args.slice(1).forEach((val) => {
            if (!set.has(val)) {
                set.add(val);
                added++;
            }
        });
        return added;
    }
    case 'SISMEMBER': {
        const set = getMockSet(args[0]);
        return set.has(args[1]) ? 1 : 0;
    }
    case 'SREM': {
        const set = getMockSet(args[0]);
        let removed = 0;
        args.slice(1).forEach((val) => {
            if (set.delete(val)) removed++;
        });
        return removed;
    }
    case 'SCARD': {
        const set = mockSets.get(args[0]);
        return set?.size ?? 0;
    }
    case 'DEL': {
        let removed = 0;
        args.forEach((key) => {
            if (mockStore.delete(key)) removed++;
            if (mockSets.delete(key)) removed++;
            if (mockHashes.delete(key)) removed++;
            if (mockSortedSets.delete(key)) removed++;
        });
        return removed;
    }
    case 'EXISTS': {
        return mockStore.has(args[0]) ? 1 : 0;
    }
    case 'GET': {
        return mockStore.get(args[0]) ?? null;
    }
    case 'SET': {
        mockStore.set(args[0], String(args[1]));
        return 'OK';
    }
    case 'PING': {
        return 'PONG';
    }
    default:
        throw new Error(`Unsupported mock command: ${cmd}`);
    }
};

let client: Redis | null = null;

const getClient = (): Redis => {
    if (client) return client;

    const { redisUrl } = settingsService.getRedisSettings();

    // Fix common misconfiguration where http is used instead of redis protocol
    let connectionUrl = redisUrl;
    if (connectionUrl.startsWith('http://')) {
        connectionUrl = connectionUrl.replace('http://', 'redis://');
    } else if (connectionUrl.startsWith('https://')) {
        connectionUrl = connectionUrl.replace('https://', 'rediss://');
    } else if (!connectionUrl.includes('://')) {
        connectionUrl = `redis://${connectionUrl}`;
    }

    loggerService.info(`Initializing Redis Client with URL: ${connectionUrl}`);

    try {
        const parsedUrl = new URL(connectionUrl);
        const options: any = {
            host: parsedUrl.hostname || 'localhost',
            port: parseInt(parsedUrl.port, 10) || 6379,
            password: parsedUrl.password || undefined,
            lazyConnect: true,
            retryStrategy(times: number) {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
        };

        if (parsedUrl.protocol === 'rediss:') {
            options.tls = {};
        }

        client = new Redis(options);
    } catch (e) {
        loggerService.warn("Failed to parse Redis URL, falling back to raw string", { error: String(e) });
        client = new Redis(connectionUrl, {
            lazyConnect: true,
            retryStrategy(times: number) {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
        });
    }

    client.on('error', (err: any) => {
        loggerService.error('Redis Client Error', { error: err });
    });

    client.on('connect', () => {
        loggerService.info('Redis Client Connected');
    });

    return client;
};

export const redisService = {
    /**
     * Executes a Redis command.
     * Compatible with the previous array-based signature: ['CMD', arg1, arg2]
     */
    request: async (command: any[]): Promise<any> => {
        if (isTestEnv) {
            return handleMockCommand(command);
        }

        const redis = getClient();

        // Ensure connection
        if (redis.status === 'wait' || redis.status === 'end') {
             await redis.connect();
        }

        const cmdName = command[0];
        const args = command.slice(1);

        try {
            const result = await redis.call(cmdName, ...args);
            return result;
        } catch (error) {
            loggerService.error(`Redis command failed: ${cmdName}`, { error });
            throw error;
        }
    },

    healthCheck: async (): Promise<boolean> => {
         if (isTestEnv) return true;

         try {
             const redis = getClient();
             if (redis.status === 'wait' || redis.status === 'end') {
                 await redis.connect();
             }
             const res = await redis.ping();
             return res === 'PONG';
         } catch (e) {
             return false;
         }
    },

    disconnect: async () => {
        if (isTestEnv) {
            mockStore.clear();
            mockSets.clear();
            return;
        }

        if (client) {
            await client.quit();
            client = null;
        }
    }
};

export const __redisTestUtils = {
    resetMock: () => {
        mockStore.clear();
        mockSets.clear();
        mockHashes.clear();
        mockSortedSets.clear();
    }
};
