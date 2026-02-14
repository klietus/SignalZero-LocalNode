import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { userService } from '../services/userService.js';
import { authService } from '../services/authService.js';
import { domainService } from '../services/domainService.js';
import { redisService, __redisTestUtils } from '../services/redisService.js';
import { isUserSpecificDomain, USER_SPECIFIC_DOMAINS } from '../types.js';

describe('UserService', () => {
  beforeEach(async () => {
    __redisTestUtils.resetMock();
  });

  describe('createUser', () => {
    it('should create a new user with valid credentials', async () => {
      const user = await userService.createUser({
        username: 'testuser',
        password: 'password123'
      });

      expect(user).toBeDefined();
      expect(user.username).toBe('testuser');
      expect(user.role).toBe('user');
      expect(user.apiKey).toBeDefined();
      expect(user.apiKey.startsWith('sz_')).toBe(true);
      expect(user.enabled).toBe(true);
    });

    it('should create an admin user when specified', async () => {
      const user = await userService.createUser({
        username: 'adminuser',
        password: 'password123'
      }, 'admin');

      expect(user.role).toBe('admin');
    });

    it('should reject usernames with special characters', async () => {
      await expect(userService.createUser({
        username: 'test@user',
        password: 'password123'
      })).rejects.toThrow('Username can only contain letters, numbers, underscores, and hyphens');
    });

    it('should reject short usernames', async () => {
      await expect(userService.createUser({
        username: 'a',
        password: 'password123'
      })).rejects.toThrow('Username must be at least 2 characters');
    });

    it('should reject short passwords', async () => {
      await expect(userService.createUser({
        username: 'testuser',
        password: '123'
      })).rejects.toThrow('Password must be at least 6 characters');
    });

    it('should reject duplicate usernames', async () => {
      await userService.createUser({
        username: 'testuser',
        password: 'password123'
      });

      await expect(userService.createUser({
        username: 'testuser',
        password: 'password123'
      })).rejects.toThrow("Username 'testuser' already exists");
    });
  });

  describe('authenticateUser', () => {
    beforeEach(async () => {
      await userService.createUser({
        username: 'testuser',
        password: 'password123'
      });
    });

    it('should authenticate with valid credentials', async () => {
      const user = await userService.authenticateUser('testuser', 'password123');
      expect(user).toBeDefined();
      expect(user?.username).toBe('testuser');
    });

    it('should reject invalid password', async () => {
      const user = await userService.authenticateUser('testuser', 'wrongpassword');
      expect(user).toBeNull();
    });

    it('should reject non-existent user', async () => {
      const user = await userService.authenticateUser('nonexistent', 'password123');
      expect(user).toBeNull();
    });

    it('should reject disabled user', async () => {
      const user = await userService.getUserByUsername('testuser');
      await userService.updateUser(user!.id, { enabled: false });

      const authenticated = await userService.authenticateUser('testuser', 'password123');
      expect(authenticated).toBeNull();
    });
  });

  describe('verifyApiKey', () => {
    let apiKey: string;

    beforeEach(async () => {
      const user = await userService.createUser({
        username: 'testuser',
        password: 'password123'
      });
      apiKey = user.apiKey;
    });

    it('should verify valid API key', async () => {
      const user = await userService.verifyApiKey(apiKey);
      expect(user).toBeDefined();
      expect(user?.username).toBe('testuser');
    });

    it('should reject invalid API key', async () => {
      const user = await userService.verifyApiKey('invalid_key');
      expect(user).toBeNull();
    });

    it('should accept internal service key', async () => {
      process.env.INTERNAL_SERVICE_KEY = 'internal_test_key';
      const user = await userService.verifyApiKey('internal_test_key');
      expect(user).toBeDefined();
      expect(user?.role).toBe('admin');
    });

    it('should reject disabled user API key', async () => {
      const user = await userService.getUserByApiKey(apiKey);
      await userService.updateUser(user!.id, { enabled: false });

      const verified = await userService.verifyApiKey(apiKey);
      expect(verified).toBeNull();
    });
  });

  describe('updateUser', () => {
    let userId: string;

    beforeEach(async () => {
      const user = await userService.createUser({
        username: 'testuser',
        password: 'password123'
      });
      userId = user.id;
    });

    it('should update username', async () => {
      const updated = await userService.updateUser(userId, { username: 'newname' });
      expect(updated?.username).toBe('newname');
    });

    it('should update password', async () => {
      await userService.updateUser(userId, { password: 'newpassword' });
      
      // Should be able to authenticate with new password
      const authWithNew = await userService.authenticateUser('testuser', 'newpassword');
      expect(authWithNew).toBeDefined();
      expect(authWithNew?.username).toBe('testuser');

      // Old password should not work
      const authWithOld = await userService.authenticateUser('testuser', 'password123');
      expect(authWithOld).toBeNull();
    });

    it('should regenerate API key', async () => {
      const oldUser = await userService.getUserById(userId);
      const oldKey = oldUser!.apiKey;

      const updated = await userService.updateUser(userId, { apiKey: 'regenerate' });
      expect(updated?.apiKey).not.toBe(oldKey);

      // Old key should not work
      const oldVerify = await userService.verifyApiKey(oldKey);
      expect(oldVerify).toBeNull();

      // New key should work
      const newVerify = await userService.verifyApiKey(updated!.apiKey);
      expect(newVerify).toBeDefined();
    });

    it('should not allow duplicate usernames', async () => {
      await userService.createUser({
        username: 'anotheruser',
        password: 'password123'
      });

      await expect(userService.updateUser(userId, { username: 'anotheruser' }))
        .rejects.toThrow("Username 'anotheruser' already exists");
    });
  });

  describe('deleteUser', () => {
    it('should delete user and clean up indexes', async () => {
      const user = await userService.createUser({
        username: 'testuser',
        password: 'password123'
      });

      const deleted = await userService.deleteUser(user.id);
      expect(deleted).toBe(true);

      const found = await userService.getUserById(user.id);
      expect(found).toBeNull();

      const byUsername = await userService.getUserByUsername('testuser');
      expect(byUsername).toBeNull();

      const byApiKey = await userService.verifyApiKey(user.apiKey);
      expect(byApiKey).toBeNull();
    });

    it('should return false for non-existent user', async () => {
      const deleted = await userService.deleteUser('nonexistent');
      expect(deleted).toBe(false);
    });
  });

  describe('listUsers', () => {
    it('should return all users', async () => {
      await userService.createUser({ username: 'user1', password: 'password123' });
      await userService.createUser({ username: 'user2', password: 'password123' });
      await userService.createUser({ username: 'user3', password: 'password123' });

      const users = await userService.listUsers();
      expect(users.length).toBe(3);
    });

    it('should return empty array when no users', async () => {
      const users = await userService.listUsers();
      expect(users).toEqual([]);
    });
  });
});

describe('AuthService with UserService', () => {
  beforeEach(async () => {
    __redisTestUtils.resetMock();
  });

  describe('isInitialized', () => {
    it('should return false when no users exist', async () => {
      expect(await authService.isInitialized()).toBe(false);
    });

    it('should return true when users exist', async () => {
      await userService.createUser({ username: 'test', password: 'password123' });
      expect(await authService.isInitialized()).toBe(true);
    });
  });

  describe('initialize', () => {
    it('should create admin user', async () => {
      await authService.initialize('admin', 'password123');
      
      const user = await userService.getUserByUsername('admin');
      expect(user).toBeDefined();
      expect(user?.role).toBe('admin');
    });

    it('should fail if already initialized', async () => {
      await authService.initialize('admin', 'password123');
      
      await expect(authService.initialize('another', 'password123'))
        .rejects.toThrow('System already initialized');
    });
  });

  describe('login', () => {
    beforeEach(async () => {
      await userService.createUser({ username: 'testuser', password: 'password123' });
    });

    it('should return token on successful login', async () => {
      const token = await authService.login('testuser', 'password123');
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token!.length).toBeGreaterThan(0);
    });

    it('should return null on failed login', async () => {
      const token = await authService.login('testuser', 'wrongpassword');
      expect(token).toBeNull();
    });
  });

  describe('verifySession', () => {
    beforeEach(async () => {
      await userService.createUser({ username: 'testuser', password: 'password123' });
    });

    it('should verify valid session', async () => {
      const token = await authService.login('testuser', 'password123');
      const session = await authService.verifySession(token!);
      
      expect(session).toBeDefined();
      expect(session?.username).toBe('testuser');
      expect(session?.userId).toBeDefined();
    });

    it('should reject invalid session', async () => {
      const session = await authService.verifySession('invalid_token');
      expect(session).toBeNull();
    });
  });

  describe('verifyApiKey', () => {
    let apiKey: string;

    beforeEach(async () => {
      const user = await userService.createUser({ username: 'testuser', password: 'password123' });
      apiKey = user.apiKey;
    });

    it('should verify valid API key', async () => {
      const context = await authService.verifyApiKey(apiKey);
      expect(context).toBeDefined();
      expect(context?.username).toBe('testuser');
      expect(context?.role).toBe('user');
    });

    it('should reject invalid API key', async () => {
      const context = await authService.verifyApiKey('invalid');
      expect(context).toBeNull();
    });
  });
});

describe('Domain Isolation', () => {
  beforeEach(async () => {
    __redisTestUtils.resetMock();
  });

  describe('isUserSpecificDomain', () => {
    it('should identify user-specific domains', () => {
      expect(isUserSpecificDomain('user')).toBe(true);
      expect(isUserSpecificDomain('state')).toBe(true);
    });

    it('should identify global domains', () => {
      expect(isUserSpecificDomain('root')).toBe(false);
      expect(isUserSpecificDomain('interfaces')).toBe(false);
      expect(isUserSpecificDomain('cyber_sec')).toBe(false);
      expect(isUserSpecificDomain('ethics')).toBe(false);
    });
  });

  describe('domainService with userId', () => {
    it('should create user-specific domains separately', async () => {
      const user1Id = 'user_1';
      const user2Id = 'user_2';

      // Initialize user domains for both users
      await domainService.init('user', 'User Preferences', user1Id);
      await domainService.init('user', 'User Preferences', user2Id);

      // Create symbols in user domain for user1
      await domainService.addSymbol('user', {
        id: 'symbol1',
        name: 'User1 Symbol',
        kind: 'pattern',
        symbol_domain: 'user',
        triad: 'test',
        role: 'test',
        macro: 'test',
        activation_conditions: [],
        symbol_tag: 'test',
        facets: { function: '', topology: '', commit: '', temporal: '', gate: [], substrate: [], invariants: [] },
        failure_mode: '',
        linked_patterns: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, user1Id);

      // Create symbols in user domain for user2
      await domainService.addSymbol('user', {
        id: 'symbol2',
        name: 'User2 Symbol',
        kind: 'pattern',
        symbol_domain: 'user',
        triad: 'test',
        role: 'test',
        macro: 'test',
        activation_conditions: [],
        symbol_tag: 'test',
        facets: { function: '', topology: '', commit: '', temporal: '', gate: [], substrate: [], invariants: [] },
        failure_mode: '',
        linked_patterns: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, user2Id);

      // Verify isolation
      const user1Domain = await domainService.get('user', user1Id);
      const user2Domain = await domainService.get('user', user2Id);

      expect(user1Domain?.symbols.length).toBe(1);
      expect(user1Domain?.symbols[0].name).toBe('User1 Symbol');

      expect(user2Domain?.symbols.length).toBe(1);
      expect(user2Domain?.symbols[0].name).toBe('User2 Symbol');
    });

    it('should share global domains across users', async () => {
      const user1Id = 'user_1';
      const user2Id = 'user_2';

      // Initialize global root domain
      await domainService.init('root', 'Root Domain');

      // Create symbol in global root domain as user1
      await domainService.addSymbol('root', {
        id: 'root_symbol',
        name: 'Root Symbol',
        kind: 'pattern',
        symbol_domain: 'root',
        triad: 'test',
        role: 'test',
        macro: 'test',
        activation_conditions: [],
        symbol_tag: 'test',
        facets: { function: '', topology: '', commit: '', temporal: '', gate: [], substrate: [], invariants: [] },
        failure_mode: '',
        linked_patterns: [],
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, user1Id);

      // Both users should see the same symbol
      const rootForUser1 = await domainService.get('root', user1Id);
      const rootForUser2 = await domainService.get('root', user2Id);

      expect(rootForUser1?.symbols.length).toBe(1);
      expect(rootForUser2?.symbols.length).toBe(1);
      expect(rootForUser1?.symbols[0].id).toBe('root_symbol');
      expect(rootForUser2?.symbols[0].id).toBe('root_symbol');
    });
  });
});
