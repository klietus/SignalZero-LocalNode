import { describe, it, expect } from 'vitest';
import { secretManagerService } from '../services/secretManagerService.ts';

describe('SecretManagerService', () => {
    it('should export required functions', () => {
        expect(typeof secretManagerService.listSecrets).toBe('function');
        expect(typeof secretManagerService.accessSecretVersion).toBe('function');
        expect(typeof secretManagerService.setServiceAccountKey).toBe('function');
        expect(typeof secretManagerService.storeSecret).toBe('function');
    });

    it('should set service account key programmatically', () => {
        const newKey = {
            client_email: 'new@example.com',
            private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAxG\n-----END RSA PRIVATE KEY-----'
        };
        
        expect(() => secretManagerService.setServiceAccountKey(newKey)).not.toThrow();
    });

    it('should throw when setting invalid service account key', () => {
        expect(() => secretManagerService.setServiceAccountKey({} as any)).toThrow('client_email and private_key');
        expect(() => secretManagerService.setServiceAccountKey({ client_email: 'test' } as any)).toThrow('client_email and private_key');
    });
});
