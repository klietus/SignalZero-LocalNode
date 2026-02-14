import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { authService } from '../services/authService.js';
import { userService } from '../services/userService.js';
import { domainService } from '../services/domainService.js';
import { redisService, __redisTestUtils } from '../services/redisService.js';

// Create a minimal express app for testing
const createTestApp = () => {
  const app = express();
  app.use(express.json());

  // Auth middleware
  app.use(async (req: any, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string') {
      const auth = await authService.verifyApiKey(apiKey);
      if (auth) {
        req.user = auth;
        return next();
      }
    }
    
    const token = req.headers['x-auth-token'];
    if (typeof token === 'string') {
      const auth = await authService.verifySession(token);
      if (auth) {
        req.user = auth;
        return next();
      }
    }
    
    res.status(401).json({ error: 'Unauthorized' });
  });

  // Test routes
  app.get('/api/protected', (req: any, res) => {
    res.json({ user: req.user });
  });

  app.get('/api/admin-only', (req: any, res) => {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' });
    }
    res.json({ message: 'Admin access granted' });
  });

  return app;
};

describe('Multi-User Authentication API', () => {
  let app: express.Application;
  let adminUser: any;
  let regularUser: any;
  let adminToken: string;
  let userToken: string;

  beforeEach(async () => {
    __redisTestUtils.resetMock();
    app = createTestApp();

    // Create admin user
    adminUser = await userService.createUser({
      username: 'admin',
      password: 'admin123'
    }, 'admin');

    // Create regular user
    regularUser = await userService.createUser({
      username: 'user',
      password: 'user123'
    }, 'user');

    // Login to get tokens
    adminToken = (await authService.login('admin', 'admin123'))!;
    userToken = (await authService.login('user', 'user123'))!;
  });

  describe('API Key Authentication', () => {
    it('should allow access with valid API key', async () => {
      const res = await request(app)
        .get('/api/protected')
        .set('x-api-key', adminUser.apiKey);

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('admin');
      expect(res.body.user.role).toBe('admin');
    });

    it('should allow access with regular user API key', async () => {
      const res = await request(app)
        .get('/api/protected')
        .set('x-api-key', regularUser.apiKey);

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('user');
      expect(res.body.user.role).toBe('user');
    });

    it('should reject invalid API key', async () => {
      const res = await request(app)
        .get('/api/protected')
        .set('x-api-key', 'invalid_key');

      expect(res.status).toBe(401);
    });

    it('should distinguish between admin and user roles', async () => {
      // Admin should access admin-only route
      const adminRes = await request(app)
        .get('/api/admin-only')
        .set('x-api-key', adminUser.apiKey);

      expect(adminRes.status).toBe(200);

      // Regular user should not
      const userRes = await request(app)
        .get('/api/admin-only')
        .set('x-api-key', regularUser.apiKey);

      expect(userRes.status).toBe(403);
    });
  });

  describe('Session Token Authentication', () => {
    it('should allow access with valid session token', async () => {
      const res = await request(app)
        .get('/api/protected')
        .set('x-auth-token', adminToken);

      expect(res.status).toBe(200);
      expect(res.body.user.username).toBe('admin');
    });

    it('should reject invalid session token', async () => {
      const res = await request(app)
        .get('/api/protected')
        .set('x-auth-token', 'invalid_token');

      expect(res.status).toBe(401);
    });
  });

  describe('User Management', () => {
    it('should allow admin to create new users', async () => {
      const newUser = await userService.createUser({
        username: 'newuser',
        password: 'password123'
      }, 'user');

      expect(newUser).toBeDefined();
      expect(newUser.username).toBe('newuser');
      expect(newUser.role).toBe('user');
    });

    it('should not allow duplicate usernames', async () => {
      await expect(userService.createUser({
        username: 'admin',
        password: 'password123'
      })).rejects.toThrow();
    });

    it('should allow password change', async () => {
      await userService.updateUser(regularUser.id, { password: 'newpassword' });

      // Old password should not work
      const oldLogin = await authService.login('user', 'user123');
      expect(oldLogin).toBeNull();

      // New password should work
      const newLogin = await authService.login('user', 'newpassword');
      expect(newLogin).toBeDefined();
    });

    it('should allow API key regeneration', async () => {
      const oldKey = regularUser.apiKey;
      
      const updated = await userService.updateUser(regularUser.id, { apiKey: 'regenerate' });
      const newKey = updated!.apiKey;

      expect(newKey).not.toBe(oldKey);

      // Old key should not work
      const oldAuth = await authService.verifyApiKey(oldKey);
      expect(oldAuth).toBeNull();

      // New key should work
      const newAuth = await authService.verifyApiKey(newKey);
      expect(newAuth).toBeDefined();
    });

    it('should allow disabling users', async () => {
      await userService.updateUser(regularUser.id, { enabled: false });

      // Disabled user should not be able to login
      const login = await authService.login('user', 'user123');
      expect(login).toBeNull();

      // Disabled user's API key should not work
      const apiAuth = await authService.verifyApiKey(regularUser.apiKey);
      expect(apiAuth).toBeNull();
    });
  });

  describe('Authorization', () => {
    it('should track user ID in auth context', async () => {
      const res = await request(app)
        .get('/api/protected')
        .set('x-api-key', regularUser.apiKey);

      expect(res.status).toBe(200);
      expect(res.body.user.userId).toBe(regularUser.id);
    });

    it('should maintain separate sessions for different users', async () => {
      // Both users have valid tokens
      const adminRes = await request(app)
        .get('/api/protected')
        .set('x-auth-token', adminToken);

      const userRes = await request(app)
        .get('/api/protected')
        .set('x-auth-token', userToken);

      expect(adminRes.body.user.username).toBe('admin');
      expect(userRes.body.user.username).toBe('user');
      expect(adminRes.body.user.userId).not.toBe(userRes.body.user.userId);
    });
  });
});

describe('Domain Isolation', () => {
  beforeEach(async () => {
    __redisTestUtils.resetMock();
  });

  it('should isolate user-specific domains between users', async () => {
    // Initialize user domains
    await domainService.init('user', 'User Preferences', 'user_1');
    await domainService.init('user', 'User Preferences', 'user_2');

    // User 1 creates a symbol in their user domain
    await domainService.addSymbol('user', {
      id: 'preference1',
      name: 'User 1 Preference',
      kind: 'data',
      symbol_domain: 'user',
      triad: 'pref',
      role: 'preference',
      macro: 'pref data',
      activation_conditions: [],
      symbol_tag: 'preference',
      facets: { function: '', topology: '', commit: '', temporal: '', gate: [], substrate: [], invariants: [] },
      failure_mode: '',
      linked_patterns: [],
      data: { source: 'user', verification: 'none', status: 'active', payload: { theme: 'dark' } },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, 'user_1');

    // User 2 creates a symbol in their user domain
    await domainService.addSymbol('user', {
      id: 'preference2',
      name: 'User 2 Preference',
      kind: 'data',
      symbol_domain: 'user',
      triad: 'pref',
      role: 'preference',
      macro: 'pref data',
      activation_conditions: [],
      symbol_tag: 'preference',
      facets: { function: '', topology: '', commit: '', temporal: '', gate: [], substrate: [], invariants: [] },
      failure_mode: '',
      linked_patterns: [],
      data: { source: 'user', verification: 'none', status: 'active', payload: { theme: 'light' } },
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, 'user_2');

    // Each user should only see their own preferences
    const user1Domain = await domainService.get('user', 'user_1');
    const user2Domain = await domainService.get('user', 'user_2');

    expect(user1Domain?.symbols).toHaveLength(1);
    expect(user1Domain?.symbols[0].data?.payload.theme).toBe('dark');

    expect(user2Domain?.symbols).toHaveLength(1);
    expect(user2Domain?.symbols[0].data?.payload.theme).toBe('light');
  });

  it('should share global domains across all users', async () => {
    // Initialize global cyber_sec domain
    await domainService.init('cyber_sec', 'Cyber Security');

    // Create cyber_sec symbol (global domain)
    await domainService.addSymbol('cyber_sec', {
      id: 'cve_123',
      name: 'CVE-2024-123',
      kind: 'pattern',
      symbol_domain: 'cyber_sec',
      triad: 'security',
      role: 'vulnerability',
      macro: 'CVE description',
      activation_conditions: [],
      symbol_tag: 'cve',
      facets: { function: '', topology: '', commit: '', temporal: '', gate: [], substrate: [], invariants: [] },
      failure_mode: '',
      linked_patterns: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, 'user_1');

    // Both users should see the same CVE
    const metadata1 = await domainService.getMetadata('user_1');
    const metadata2 = await domainService.getMetadata('user_2');

    const cyberSec1 = metadata1.find(d => d.id === 'cyber_sec');
    const cyberSec2 = metadata2.find(d => d.id === 'cyber_sec');

    expect(cyberSec1).toBeDefined();
    expect(cyberSec2).toBeDefined();
    expect(cyberSec1?.count).toBe(1);
    expect(cyberSec2?.count).toBe(1);
  });
});
