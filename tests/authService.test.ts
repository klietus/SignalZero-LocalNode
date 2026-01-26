import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authService } from '../services/authService.ts';
import { settingsService } from '../services/settingsService.ts';

describe('AuthService', () => {
    beforeEach(() => {
        vi.resetModules();
        // Clear admin user before each test
        vi.spyOn(settingsService, 'getAdminUser').mockReturnValue(null);
        vi.spyOn(settingsService, 'setAdminUser').mockImplementation(() => {});
    });

    it('should report as not initialized when no admin user exists', () => {
        expect(authService.isInitialized()).toBe(false);
    });

    it('should initialize with username and password', () => {
        let savedAdmin: any = null;
        vi.spyOn(settingsService, 'setAdminUser').mockImplementation((admin) => {
            savedAdmin = admin;
        });

        authService.initialize('admin', 'password123');
        
        expect(savedAdmin).not.toBeNull();
        expect(savedAdmin.username).toBe('admin');
        expect(savedAdmin.passwordHash).toBeDefined();
        expect(savedAdmin.salt).toBeDefined();
    });

    it('should fail to initialize if already initialized', () => {
        vi.spyOn(settingsService, 'getAdminUser').mockReturnValue({ 
            username: 'admin', 
            passwordHash: 'hash', 
            salt: 'salt' 
        });

        expect(() => authService.initialize('other', 'pass')).toThrow('System already initialized');
    });

    it('should allow login with correct credentials', () => {
        // Setup a real hash for a known password
        // Or just mock the scrypt call, but let's try a real login flow
        
        // Use a fixed salt/hash for testing
        const salt = 'abcdef123456';
        // We'll initialize properly to get a valid hash
        let savedAdmin: any = null;
        vi.spyOn(settingsService, 'setAdminUser').mockImplementation((admin) => {
            savedAdmin = admin;
        });
        vi.spyOn(settingsService, 'getAdminUser').mockImplementation(() => savedAdmin);

        authService.initialize('admin', 'correct-password');
        
        const token = authService.login('admin', 'correct-password');
        expect(token).not.toBeNull();
        expect(typeof token).toBe('string');
        
        expect(authService.verifySession(token!)).toBe(true);
    });

    it('should reject login with wrong password', () => {
        let savedAdmin: any = null;
        vi.spyOn(settingsService, 'setAdminUser').mockImplementation((admin) => {
            savedAdmin = admin;
        });
        vi.spyOn(settingsService, 'getAdminUser').mockImplementation(() => savedAdmin);

        authService.initialize('admin', 'correct-password');
        
        const token = authService.login('admin', 'wrong-password');
        expect(token).toBeNull();
    });

    it('should reject invalid session tokens', () => {
        expect(authService.verifySession('invalid-token')).toBe(false);
    });
});
