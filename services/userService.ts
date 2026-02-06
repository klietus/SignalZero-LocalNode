import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { redisService } from './redisService.js';
import { loggerService } from './loggerService.js';
import { User, UserRole, CreateUserRequest, UpdateUserRequest } from '../types.js';

// Redis Keys Configuration
const KEYS = {
  USERS_SET: 'sz:users',
  USER_PREFIX: 'sz:user:', // e.g., sz:user:admin
  USERNAME_INDEX: 'sz:usernames', // Hash: username -> userId
  API_KEY_INDEX: 'sz:apikeys', // Hash: apiKey -> userId
};

/**
 * Generate a secure random API key
 */
const generateApiKey = (): string => {
  return `sz_${randomBytes(32).toString('hex')}`;
};

/**
 * Hash a password with a salt
 */
const hashPassword = (password: string, salt: string): string => {
  return scryptSync(password, salt, 64).toString('hex');
};

/**
 * Verify a password against a hash
 */
const verifyPassword = (password: string, salt: string, hash: string): boolean => {
  const hashedPassword = scryptSync(password, salt, 64);
  const storedPassword = Buffer.from(hash, 'hex');
  return timingSafeEqual(hashedPassword, storedPassword);
};

export const userService = {
  /**
   * Initialize the default admin user if no users exist
   * This is called during system startup for backward compatibility
   */
  initializeDefaultAdmin: async (adminUsername?: string, adminPassword?: string): Promise<void> => {
    const users = await userService.listUsers();
    if (users.length > 0) {
      loggerService.info('Users already exist, skipping default admin creation');
      return;
    }

    // Check for legacy admin user from settings file
    const { settingsService } = await import('./settingsService.js');
    const legacyAdmin = settingsService.getAdminUser();

    if (legacyAdmin) {
      loggerService.info('Migrating legacy admin user to new user system');
      await userService.createUser({
        username: legacyAdmin.username,
        password: '', // Will use hash from legacy
      }, 'admin', {
        passwordHash: legacyAdmin.passwordHash,
        salt: legacyAdmin.salt,
      });
      return;
    }

    // Create default admin if credentials provided
    if (adminUsername && adminPassword) {
      loggerService.info('Creating default admin user');
      await userService.createUser({
        username: adminUsername,
        password: adminPassword,
      }, 'admin');
    }
  },

  /**
   * Create a new user
   */
  createUser: async (
    request: CreateUserRequest,
    role: UserRole = 'user',
    legacyCredentials?: { passwordHash: string; salt: string }
  ): Promise<User> => {
    const { username, password } = request;

    // Validate username
    if (!username || username.length < 2) {
      throw new Error('Username must be at least 2 characters');
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      throw new Error('Username can only contain letters, numbers, underscores, and hyphens');
    }

    // Check if username already exists
    const existingUserId = await userService.getUserIdByUsername(username);
    if (existingUserId) {
      throw new Error(`Username '${username}' already exists`);
    }

    // Generate credentials
    let salt: string;
    let passwordHash: string;

    if (legacyCredentials) {
      // Use existing credentials (migration case)
      salt = legacyCredentials.salt;
      passwordHash = legacyCredentials.passwordHash;
    } else {
      // Generate new credentials
      if (!password || password.length < 6) {
        throw new Error('Password must be at least 6 characters');
      }
      salt = randomBytes(16).toString('hex');
      passwordHash = hashPassword(password, salt);
    }

    const apiKey = generateApiKey();
    const now = new Date().toISOString();
    const userId = `user_${randomBytes(8).toString('hex')}`;

    const user: User = {
      id: userId,
      username,
      passwordHash,
      salt,
      apiKey,
      role,
      createdAt: now,
      updatedAt: now,
      enabled: true,
    };

    // Save user to Redis
    await redisService.request(['SET', `${KEYS.USER_PREFIX}${userId}`, JSON.stringify(user)]);
    await redisService.request(['SADD', KEYS.USERS_SET, userId]);
    await redisService.request(['HSET', KEYS.USERNAME_INDEX, username.toLowerCase(), userId]);
    await redisService.request(['HSET', KEYS.API_KEY_INDEX, apiKey, userId]);

    loggerService.info(`User created: ${username} (${userId}) with role ${role}`);
    return user;
  },

  /**
   * Get user by ID
   */
  getUserById: async (userId: string): Promise<User | null> => {
    const data = await redisService.request(['GET', `${KEYS.USER_PREFIX}${userId}`]);
    if (!data) return null;
    try {
      return JSON.parse(data) as User;
    } catch (e) {
      loggerService.error(`Failed to parse user ${userId}`, { error: e });
      return null;
    }
  },

  /**
   * Alias for getUserById
   */
  getUser: async (userId: string): Promise<User | null> => {
    return userService.getUserById(userId);
  },

  /**
   * Get user ID by username (case-insensitive)
   */
  getUserIdByUsername: async (username: string): Promise<string | null> => {
    const userId = await redisService.request(['HGET', KEYS.USERNAME_INDEX, username.toLowerCase()]);
    return userId || null;
  },

  /**
   * Get user by username
   */
  getUserByUsername: async (username: string): Promise<User | null> => {
    const userId = await userService.getUserIdByUsername(username);
    if (!userId) return null;
    return userService.getUserById(userId);
  },

  /**
   * Get user by API key
   */
  getUserByApiKey: async (apiKey: string): Promise<User | null> => {
    const userId = await redisService.request(['HGET', KEYS.API_KEY_INDEX, apiKey]);
    if (!userId) return null;
    return userService.getUserById(userId);
  },

  /**
   * List all users
   */
  listUsers: async (): Promise<User[]> => {
    const userIds = await redisService.request(['SMEMBERS', KEYS.USERS_SET]);
    if (!Array.isArray(userIds) || userIds.length === 0) return [];

    const users = await Promise.all(
      userIds.map((id: string) => userService.getUserById(id))
    );

    return users.filter((u): u is User => u !== null);
  },

  /**
   * Update a user
   */
  updateUser: async (userId: string, request: UpdateUserRequest): Promise<User | null> => {
    const user = await userService.getUserById(userId);
    if (!user) return null;

    // Update username
    if (request.username !== undefined && request.username !== user.username) {
      // Validate new username
      if (!request.username || request.username.length < 2) {
        throw new Error('Username must be at least 2 characters');
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(request.username)) {
        throw new Error('Username can only contain letters, numbers, underscores, and hyphens');
      }

      // Check if new username already exists
      const existingId = await userService.getUserIdByUsername(request.username);
      if (existingId && existingId !== userId) {
        throw new Error(`Username '${request.username}' already exists`);
      }

      // Update username index
      await redisService.request(['HDEL', KEYS.USERNAME_INDEX, user.username.toLowerCase()]);
      await redisService.request(['HSET', KEYS.USERNAME_INDEX, request.username.toLowerCase(), userId]);

      user.username = request.username;
    }

    // Update password
    if (request.password !== undefined) {
      if (request.password.length < 6) {
        throw new Error('Password must be at least 6 characters');
      }
      user.salt = randomBytes(16).toString('hex');
      user.passwordHash = hashPassword(request.password, user.salt);
    }

    // Update role
    if (request.role !== undefined) {
      user.role = request.role;
    }

    // Update enabled status
    if (request.enabled !== undefined) {
      user.enabled = request.enabled;
    }

    // Update API key (regenerate)
    if (request.apiKey === 'regenerate') {
      // Remove old API key from index
      await redisService.request(['HDEL', KEYS.API_KEY_INDEX, user.apiKey]);
      // Generate new one
      user.apiKey = generateApiKey();
      await redisService.request(['HSET', KEYS.API_KEY_INDEX, user.apiKey, userId]);
    }

    user.updatedAt = new Date().toISOString();

    // Save updated user
    await redisService.request(['SET', `${KEYS.USER_PREFIX}${userId}`, JSON.stringify(user)]);

    loggerService.info(`User updated: ${user.username} (${userId})`);
    return user;
  },

  /**
   * Delete a user
   */
  deleteUser: async (userId: string): Promise<boolean> => {
    const user = await userService.getUserById(userId);
    if (!user) return false;

    // Remove from all indexes
    await redisService.request(['DEL', `${KEYS.USER_PREFIX}${userId}`]);
    await redisService.request(['SREM', KEYS.USERS_SET, userId]);
    await redisService.request(['HDEL', KEYS.USERNAME_INDEX, user.username.toLowerCase()]);
    await redisService.request(['HDEL', KEYS.API_KEY_INDEX, user.apiKey]);

    loggerService.info(`User deleted: ${user.username} (${userId})`);
    return true;
  },

  /**
   * Authenticate user by username and password
   */
  authenticateUser: async (username: string, password: string): Promise<User | null> => {
    const user = await userService.getUserByUsername(username);
    if (!user) return null;
    if (!user.enabled) return null;

    const isValid = verifyPassword(password, user.salt, user.passwordHash);
    if (!isValid) return null;

    return user;
  },

  /**
   * Verify an API key and return the user
   */
  verifyApiKey: async (apiKey: string): Promise<User | null> => {
    // Check for internal service key
    if (apiKey === process.env.INTERNAL_SERVICE_KEY) {
      // Return a system user for internal service calls
      return {
        id: 'system',
        username: 'system',
        passwordHash: '',
        salt: '',
        apiKey: apiKey,
        role: 'admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        enabled: true,
      };
    }

    const user = await userService.getUserByApiKey(apiKey);
    if (!user || !user.enabled) return null;
    return user;
  },

  /**
   * Regenerate API key for a user
   */
  regenerateApiKey: async (userId: string): Promise<string | null> => {
    const user = await userService.getUserById(userId);
    if (!user) return null;

    // Remove old API key from index
    await redisService.request(['HDEL', KEYS.API_KEY_INDEX, user.apiKey]);

    // Generate new API key
    const newApiKey = generateApiKey();
    user.apiKey = newApiKey;
    user.updatedAt = new Date().toISOString();

    // Save updated user
    await redisService.request(['SET', `${KEYS.USER_PREFIX}${userId}`, JSON.stringify(user)]);
    await redisService.request(['HSET', KEYS.API_KEY_INDEX, newApiKey, userId]);

    loggerService.info(`API key regenerated for user: ${user.username} (${userId})`);
    return newApiKey;
  },

  /**
   * Count total users
   */
  countUsers: async (): Promise<number> => {
    const count = await redisService.request(['SCARD', KEYS.USERS_SET]);
    return Number(count) || 0;
  },

  /**
   * Check if any users exist
   */
  hasUsers: async (): Promise<boolean> => {
    const count = await userService.countUsers();
    return count > 0;
  },
};
