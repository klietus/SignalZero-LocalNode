import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { settingsService, AdminUser } from './settingsService.js';
import { loggerService } from './loggerService.js';

// Simple in-memory session store
// key: token, value: { username, expiresAt }
const sessions = new Map<string, { username: string, expiresAt: number }>();

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

export const authService = {
    /**
     * Checks if the system is initialized (has an admin user).
     */
    isInitialized: (): boolean => {
        return !!settingsService.getAdminUser();
    },

    /**
     * Creates the initial admin user. Fails if already initialized.
     */
    initialize: (username: string, password: string): void => {
        if (authService.isInitialized()) {
            throw new Error('System already initialized');
        }

        const salt = randomBytes(16).toString('hex');
        const passwordHash = scryptSync(password, salt, 64).toString('hex');

        const adminUser: AdminUser = {
            username,
            passwordHash,
            salt
        };

        settingsService.setAdminUser(adminUser);
        loggerService.info(`Admin user '${username}' created.`);
    },

    /**
     * Authenticates a user and returns a session token.
     */
    login: (username: string, password: string): string | null => {
        const admin = settingsService.getAdminUser();
        if (!admin || admin.username !== username) {
            return null;
        }

        const hashedPassword = scryptSync(password, admin.salt, 64);
        const storedPassword = Buffer.from(admin.passwordHash, 'hex');

        if (timingSafeEqual(hashedPassword, storedPassword)) {
            // Success - create session
            const token = randomBytes(32).toString('hex');
            sessions.set(token, {
                username: admin.username,
                expiresAt: Date.now() + SESSION_TTL
            });
            return token;
        }

        return null;
    },

    /**
     * Verifies a session token.
     */
    verifySession: (token: string): boolean => {
        const session = sessions.get(token);
        if (!session) return false;

        if (Date.now() > session.expiresAt) {
            sessions.delete(token);
            return false;
        }

        return true;
    },

    /**
     * Cleanup expired sessions (optional, call periodically)
     */
    cleanupSessions: () => {
        const now = Date.now();
        for (const [token, session] of sessions.entries()) {
            if (now > session.expiresAt) {
                sessions.delete(token);
            }
        }
    }
};
