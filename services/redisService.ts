import { Redis } from 'ioredis';
import { settingsService } from './settingsService.js';
import { loggerService } from './loggerService.js';

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
        if (client) {
            await client.quit();
            client = null;
        }
    }
};
