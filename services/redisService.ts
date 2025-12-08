import { Redis } from 'ioredis';
import { settingsService } from './settingsService.js';
import { loggerService } from './loggerService.js';

const isTestEnv = process.env.NODE_ENV === 'test';

// Lightweight in-memory mock to avoid real Redis connections during tests
const mockStore = new Map<string, string>();
const mockSets = new Map<string, Set<string>>();

const getMockSet = (key: string) => {
    if (!mockSets.has(key)) mockSets.set(key, new Set<string>());
    return mockSets.get(key)!;
};

const handleMockCommand = async (command: any[]): Promise<any> => {
    const [cmd, ...args] = command;
    switch (cmd) {
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
    case 'SREM': {
        const set = getMockSet(args[0]);
        let removed = 0;
        args.slice(1).forEach((val) => {
            if (set.delete(val)) removed++;
        });
        return removed;
    }
    case 'DEL': {
        let removed = 0;
        args.forEach((key) => {
            if (mockStore.delete(key)) removed++;
            if (mockSets.delete(key)) removed++;
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
        // Assume localhost:6379 if just that is provided, or add redis://
        connectionUrl = `redis://${connectionUrl}`;
    }

    loggerService.info(`Initializing Redis Client with URL: ${connectionUrl}`);

    client = new Redis(connectionUrl, {
        lazyConnect: true,
        retryStrategy(times: number) {
            const delay = Math.min(times * 50, 2000);
            return delay;
        },
    });

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
    }
};
