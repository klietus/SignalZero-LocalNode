
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../server.ts';
import { domainService } from '../services/domainService.ts';
import { authService } from '../services/authService.ts';
import { __redisTestUtils, redisService } from '../services/redisService.ts';
import { vectorService } from '../services/vectorService.ts';

// Mock Services that aren't Redis
vi.mock('../services/vectorService', () => ({
    vectorService: {
        indexSymbol: vi.fn().mockResolvedValue(true),
        indexBatch: vi.fn().mockResolvedValue(0),
        removeSymbol: vi.fn().mockResolvedValue(true),
        search: vi.fn().mockResolvedValue([]),
        resetCollection: vi.fn().mockResolvedValue(true)
    }
}));

describe('Authorization Write Operations', () => {
    const ADMIN_TOKEN = 'admin-token';
    const USER_TOKEN = 'user-token';
    const OTHER_USER_TOKEN = 'other-user-token';

    const ADMIN_CONTEXT = { userId: 'admin_1', username: 'admin', role: 'admin' };
    const USER_CONTEXT = { userId: 'user_1', username: 'user', role: 'user' };
    const OTHER_USER_CONTEXT = { userId: 'user_2', username: 'other', role: 'user' };

    beforeEach(async () => {
        __redisTestUtils.resetMock();
        vi.clearAllMocks();

        // Mock authService.verifySession to return different contexts based on token
        vi.spyOn(authService, 'verifySession').mockImplementation(async (token: string) => {
            if (token === ADMIN_TOKEN) return ADMIN_CONTEXT as any;
            if (token === USER_TOKEN) return USER_CONTEXT as any;
            if (token === OTHER_USER_TOKEN) return OTHER_USER_CONTEXT as any;
            return null;
        });

        vi.spyOn(authService, 'isInitialized').mockResolvedValue(true);
    });

    describe('Domain Operations', () => {
        it('should allow admin to create a global domain', async () => {
            const res = await request(app)
                .post('/api/domains')
                .set('x-auth-token', ADMIN_TOKEN)
                .send({ id: 'global-1', name: 'Global Domain' });
            
            expect(res.status).toBe(200);
            const exists = await redisService.request(['SISMEMBER', 'sz:domains', 'global-1']);
            expect(exists).toBe(1);
        });

        it('should reject regular user creating a global domain', async () => {
            const res = await request(app)
                .post('/api/domains')
                .set('x-auth-token', USER_TOKEN)
                .send({ id: 'global-2', name: 'Global Domain' });
            
            expect(res.status).toBe(500); // Service throws Error
            expect(res.body.error).toContain('Admin privileges required');
        });

        it('should allow user to toggle their own user domain', async () => {
            // Setup user domain
            await domainService.init('user', 'User Preferences', 'user_1', true);

            const res = await request(app)
                .post('/api/domains/user/toggle')
                .set('x-auth-token', USER_TOKEN)
                .send({ enabled: false });
            
            expect(res.status).toBe(200);
            const domain = await domainService.get('user', 'user_1', true);
            expect(domain?.enabled).toBe(false);
        });

        it("should reject user toggling a domain they don't own", async () => {
            // Create a domain owned by user_2
            await domainService.init('custom-domain', 'Custom', 'user_2', true);

            const res = await request(app)
                .post('/api/domains/custom-domain/toggle')
                .set('x-auth-token', USER_TOKEN) // user_1
                .send({ enabled: false });
            
            expect(res.status).toBe(500);
            expect(res.body.error).toContain('Admin privileges required');
        });

        it('should allow admin to delete a global domain', async () => {
            await domainService.init('global-3', 'Global', undefined, true);

            const res = await request(app)
                .delete('/api/domains/global-3')
                .set('x-auth-token', ADMIN_TOKEN);
            
            expect(res.status).toBe(200);
        });

        it('should reject user deleting a global domain', async () => {
            await domainService.init('global-4', 'Global', undefined, true);

            const res = await request(app)
                .delete('/api/domains/global-4')
                .set('x-auth-token', USER_TOKEN);
            
            expect(res.status).toBe(500);
            expect(res.body.error).toContain('Admin privileges required');
        });
    });

    describe('Symbol Operations', () => {
        beforeEach(async () => {
            await domainService.init('global-sync', 'Global', undefined, true);
            await domainService.init('user', 'User Preferences', 'user_1', true);
        });

        it('should allow admin to add symbol to global domain', async () => {
            const res = await request(app)
                .post('/api/domains/global-sync/symbols')
                .set('x-auth-token', ADMIN_TOKEN)
                .send({ id: 'sym-global-1', name: 'Global Symbol' });
            
            expect(res.status).toBe(200);
        });

        it('should reject user adding symbol to global domain', async () => {
            const res = await request(app)
                .post('/api/domains/global-sync/symbols')
                .set('x-auth-token', USER_TOKEN)
                .send({ id: 'sym-global-2', name: 'Global Symbol' });
            
            expect(res.status).toBe(500);
            expect(res.body.error).toContain('Admin privileges required');
        });

        it('should allow user to add symbol to their user domain', async () => {
            const res = await request(app)
                .post('/api/domains/user/symbols')
                .set('x-auth-token', USER_TOKEN)
                .send({ id: 'pref-1', name: 'My Pref' });
            
            expect(res.status).toBe(200);
        });

        it('should allow admin to delete symbol from global domain', async () => {
            await domainService.addSymbol('global-sync', { id: 's1' } as any, undefined, true);

            const res = await request(app)
                .delete('/api/domains/global-sync/symbols/s1')
                .set('x-auth-token', ADMIN_TOKEN);
            
            expect(res.status).toBe(200);
        });

        it('should reject user deleting symbol from global domain', async () => {
            await domainService.addSymbol('global-sync', { id: 's2' } as any, undefined, true);

            const res = await request(app)
                .delete('/api/domains/global-sync/symbols/s2')
                .set('x-auth-token', USER_TOKEN);
            
            expect(res.status).toBe(500);
            expect(res.body.error).toContain('Admin privileges required');
        });
    });
});
