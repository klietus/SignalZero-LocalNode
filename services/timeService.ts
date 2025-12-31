const MS_PER_DAY = 24 * 60 * 60 * 1000;

const startOfDayUtc = (ms: number) => {
  const date = new Date(ms);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime();
};

export const encodeTimestamp = (ms: number): string => Buffer.from(String(ms)).toString('base64');

export const decodeTimestamp = (value?: string | null): number | null => {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, 'base64').toString('utf-8');
    const num = Number(decoded);
    return Number.isFinite(num) ? num : null;
  } catch {
    return null;
  }
};

export const currentTimestampBase64 = (): string => encodeTimestamp(Date.now());

export const getDayBucketKey = (type: 'symbols' | 'traces', ms: number): string => {
  const start = startOfDayUtc(ms);
  return `sz:index:${type}:${encodeTimestamp(start)}`;
};

export const enumerateBucketKeys = (type: 'symbols' | 'traces', startMs: number, endMs: number): string[] => {
  const normalizedStart = startOfDayUtc(startMs);
  const normalizedEnd = startOfDayUtc(endMs);
  const keys: string[] = [];
  for (let cursor = normalizedStart; cursor <= normalizedEnd; cursor += MS_PER_DAY) {
    keys.push(getDayBucketKey(type, cursor));
  }
  return keys;
};

export const getBucketKeysFromTimestamps = (
  type: 'symbols' | 'traces',
  timeGte?: string,
  timeBetween?: string[]
): { keys: string[]; rangeApplied: boolean } => {
  const now = Date.now();
  const parsedGte = decodeTimestamp(timeGte || undefined);
  const parsedBetween = Array.isArray(timeBetween) && timeBetween.length === 2
    ? timeBetween.map((v) => decodeTimestamp(v)).filter((v): v is number => v !== null)
    : [];

  let start: number | null = null;
  let end: number | null = null;

  if (parsedBetween.length === 2) {
    start = parsedBetween[0];
    end = parsedBetween[1];
  } else if (parsedGte !== null) {
    start = parsedGte;
    end = now;
  }

  if (start === null || end === null || start > end) {
    return { keys: [], rangeApplied: false };
  }

  return { keys: enumerateBucketKeys(type, start, end), rangeApplied: true };
};

export const buildSystemMetadataBlock = (context?: Record<string, any>) => ({
  system_time_iso: new Date().toISOString(),
  ...(context ? { context } : {}),
});
