import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authService } from '../services/authService.ts';
import { userService } from '../services/userService.ts';
import { redisService, __redisTestUtils } from '../services/redisService.js';

describe('AuthService', () => {
    beforeEach(async () => {
        __redisTestUtils.resetMock();
        vi.resetModules();
    });

    it('should report as not initialized when no admin user exists', async () => {
        expect(await authService.isInitialized()).toBe(false);
    });

    it('should initialize with username and password', async () => {
        await authService.initialize('admin', 'password123');
        
        expect(await authService.isInitialized()).toBe(true);
        
        const user = await userService.getUserByUsername('admin');
        expect(user).not.toBeNull();
        expect(user?.username).toBe('admin');
        expect(user?.role).toBe('admin');
        expect(user?.passwordHash).toBeDefined();
        expect(user?.salt).toBeDefined();
    });

    it('should fail to initialize if already initialized', async () => {
        await authService.initialize('admin', 'password123');

        await expect(authService.initialize('other', 'pass')).rejects.toThrow('System already initialized');
    });

    it('should allow login with correct credentials', async () => {
        await authService.initialize('admin', 'correct-password');
        
        const token = await authService.login('admin', 'correct-password');
        expect(token).not.toBeNull();
        expect(typeof token).toBe('string');
        
        const session = authService.verifySession(token!);
        expect(session).toBeTruthy();
        expect(session?.username).toBe('admin');
    });

    it('should reject login with wrong password', async () => {
        await authService.initialize('admin', 'correct-password');
        
        const token = await authService.login('admin', 'wrong-password');
        expect(token).toBeNull();
    });

    it('should reject invalid session tokens', () => {
        const session = authService.verifySession('invalid-token');
        expect(session).toBeNull();
    });

    it('should verify API keys correctly', async () => {
        await authService.initialize('admin', 'password123');
        const user = await userService.getUserByUsername('admin');
        
        // Valid API key
        const context = await authService.verifyApiKey(user!.apiKey);
        expect(context).toBeTruthy();
        expect(context?.username).toBe('admin');
        
        // Invalid API key
        const invalidContext = await authService.verifyApiKey('invalid-key');
        expect(invalidContext).toBeNull();
    });

    it('should verify internal service key', async () => {
        process.env.INTERNAL_SERVICE_KEY = 'test-internal-key';
        
        const context = await authService.verifyApiKey('test-internal-key');
        expect(context).toBeTruthy();
        expect(context?.role).toBe('admin');
        expect(context?.userId).toBe('system');
    });

    it('should change password correctly', async () => {
        await authService.initialize('admin', 'old-password');
        const user = await userService.getUserByUsername('admin');
        
        // Change password
        await authService.changePassword('old-password', 'new-password', user!.id);
        
        // Old password should not work
        const oldLogin = await authService.login('admin', 'old-password');
        expect(oldLogin).toBeNull();
        
        // New password should work
        const newLogin = await authService.login('admin', 'new-password');
        expect(newLogin).not.toBeNull();
    });

    it('should reject password change with wrong old password', async () => {
        await authService.initialize('admin', 'correct-password');
        const user = await userService.getUserByUsername('admin');
        
        await expect(authService.changePassword('wrong-password', 'new-password', user!.id))
            .rejects.toThrow('Invalid current password');
    });

    it('should check admin status correctly', async () => {
        await authService.initialize('admin', 'password123');
        const adminUser = await userService.getUserByUsername('admin');
        
        // Create a regular user
        const regularUser = await userService.createUser({
            username: 'user',
            password: 'password123'
        }, 'user');
        
        expect(await authService.isAdmin(adminUser!.id)).toBe(true);
        expect(await authService.isAdmin(regularUser.id)).toBe(false);
    });

    it('should get user from session', async () => {
        await authService.initialize('admin', 'password123');
        const token = await authService.login('admin', 'password123');
        
        const user = await authService.getUserFromSession(token!);
        expect(user).not.toBeNull();
        expect(user?.username).toBe('admin');
    });

    it('should logout and invalidate session', async () => {
        await authService.initialize('admin', 'password123');
        const token = await authService.login('admin', 'password123');
        
        // Verify session exists
        expect(authService.verifySession(token!)).toBeTruthy();
        
        // Logout
        authService.logout(token!);
        
        // Session should be invalid
        expect(authService.verifySession(token!)).toBeNull();
    });
});
