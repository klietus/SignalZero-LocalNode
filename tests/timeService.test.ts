import { describe, it, expect } from 'vitest';
import { encodeTimestamp, decodeTimestamp, getDayBucketKey, enumerateBucketKeys, getBucketKeysFromTimestamps } from '../services/timeService.ts';

describe('TimeService', () => {
    it('should encode and decode ISO timestamps', () => {
        const now = Date.now();
        const encoded = encodeTimestamp(now);
        expect(encoded).toContain('Z'); // Should be ISO
        
        const decoded = decodeTimestamp(encoded);
        // Precision might be slightly different due to ISO string conversion (ms loss sometimes if not careful, but Date.toISOString keeps it)
        expect(decoded).toBe(now);
    });

    it('should decode legacy base64 timestamps', () => {
        const now = Date.now();
        const base64 = Buffer.from(String(now)).toString('base64');
        const decoded = decodeTimestamp(base64);
        expect(decoded).toBe(now);
    });

    it('should handle invalid timestamps gracefully', () => {
        expect(decodeTimestamp(null)).toBeNull();
        expect(decodeTimestamp('')).toBeNull();
        expect(decodeTimestamp('invalid-date')).toBeNull();
    });

    it('should generate consistent day bucket keys', () => {
        const date = new Date('2024-05-23T12:00:00Z').getTime();
        const key = getDayBucketKey('symbols', date);
        expect(key).toBe('sz:index:symbols:2024-05-23T00:00:00.000Z');
    });

    it('should enumerate bucket keys across multiple days', () => {
        const start = new Date('2024-05-20T12:00:00Z').getTime();
        const end = new Date('2024-05-22T12:00:00Z').getTime();
        const keys = enumerateBucketKeys('traces', start, end);
        
        expect(keys).toHaveLength(3);
        expect(keys[0]).toContain('2024-05-20');
        expect(keys[1]).toContain('2024-05-21');
        expect(keys[2]).toContain('2024-05-22');
    });

    it('should resolve bucket keys from time filters', () => {
        const gte = '2024-05-23T00:00:00.000Z';
        // Mocking now implicitly by checking length relative to a fixed start
        const { keys, rangeApplied } = getBucketKeysFromTimestamps('symbols', gte);
        expect(rangeApplied).toBe(true);
        expect(keys.length).toBeGreaterThan(0);
        expect(keys[0]).toBe('sz:index:symbols:2024-05-23T00:00:00.000Z');
    });
});
