import { randomBytes } from 'crypto';
import { userService } from './userService.js';
import { loggerService } from './loggerService.js';
import { User } from '../types.js';

// Simple in-memory session store
// key: token, value: { userId, username, expiresAt }
const sessions = new Map<string, { userId: string; username: string; expiresAt: number }>();

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

export interface AuthContext {
  userId: string;
  username: string;
  role: string;
  apiKey?: string;
}

export const authService = {
  /**
   * Checks if the system is initialized (has any users).
   */
  isInitialized: async (): Promise<boolean> => {
    return await userService.hasUsers();
  },

  /**
   * Creates the initial admin user. Fails if already initialized.
   */
  initialize: async (username: string, password: string): Promise<void> => {
    if (await authService.isInitialized()) {
      throw new Error('System already initialized');
    }

    await userService.createUser({ username, password }, 'admin');
    loggerService.info(`Admin user '${username}' created.`);
  },

  /**
   * Authenticates a user and returns a session token.
   */
  login: async (username: string, password: string): Promise<string | null> => {
    const user = await userService.authenticateUser(username, password);
    if (!user) {
      return null;
    }

    // Success - create session
    const token = randomBytes(32).toString('hex');
    sessions.set(token, {
      userId: user.id,
      username: user.username,
      expiresAt: Date.now() + SESSION_TTL,
    });

    loggerService.info(`User '${username}' logged in.`);
    return token;
  },

  /**
   * Changes a user's password (defaults to current user from session).
   */
  changePassword: async (
    oldPassword: string,
    newPassword: string,
    userId?: string
  ): Promise<void> => {
    let targetUserId = userId;

    // If no userId provided, we need to find the user from context
    // This is called from the API where we have the session
    if (!targetUserId) {
      throw new Error('User ID is required');
    }

    const user = await userService.getUserById(targetUserId);
    if (!user) {
      throw new Error('User not found');
    }

    // Verify old password
    const isValid = await userService.authenticateUser(user.username, oldPassword);
    if (!isValid) {
      throw new Error('Invalid current password');
    }

    // Update password
    await userService.updateUser(targetUserId, { password: newPassword });
    loggerService.info(`Password changed for user '${user.username}'.`);
  },

  /**
   * Verifies a session token.
   */
  verifySession: (token: string): AuthContext | null => {
    const session = sessions.get(token);
    if (!session) return null;

    if (Date.now() > session.expiresAt) {
      sessions.delete(token);
      return null;
    }

    return {
      userId: session.userId,
      username: session.username,
      role: 'user', // Will be looked up if needed
    };
  },

  /**
   * Verifies an API key and returns auth context.
   */
  verifyApiKey: async (apiKey: string): Promise<AuthContext | null> => {
    const user = await userService.verifyApiKey(apiKey);
    if (!user) return null;

    return {
      userId: user.id,
      username: user.username,
      role: user.role,
      apiKey: user.apiKey,
    };
  },

  /**
   * Get the current user from a session token.
   */
  getUserFromSession: async (token: string): Promise<User | null> => {
    const session = authService.verifySession(token);
    if (!session) return null;
    return userService.getUserById(session.userId);
  },

  /**
   * Logout (invalidate session).
   */
  logout: (token: string): void => {
    sessions.delete(token);
  },

  /**
   * Cleanup expired sessions (optional, call periodically).
   */
  cleanupSessions: () => {
    const now = Date.now();
    let cleaned = 0;
    for (const [token, session] of sessions.entries()) {
      if (now > session.expiresAt) {
        sessions.delete(token);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      loggerService.debug(`Cleaned up ${cleaned} expired sessions`);
    }
  },

  /**
   * Check if user is admin.
   */
  isAdmin: async (userId: string): Promise<boolean> => {
    const user = await userService.getUserById(userId);
    return user?.role === 'admin';
  },
};
