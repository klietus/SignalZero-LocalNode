import { redisService } from './redisService.js';
import { loggerService } from './loggerService.js';
import { ContextMessage, ContextSession } from '../types.js';

const CONTEXT_INDEX_KEY = 'context:index';
const sessionKey = (id: string) => `context:session:${id}`;
const historyKey = (id: string) => `context:history:${id}`;

const generateId = () => `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const persistSession = async (session: ContextSession) => {
  await redisService.request(['SADD', CONTEXT_INDEX_KEY, session.id]);
  await redisService.request(['SET', sessionKey(session.id), JSON.stringify(session)]);
};

const loadSession = async (id: string): Promise<ContextSession | null> => {
  const payload = await redisService.request(['GET', sessionKey(id)]);
  if (!payload) return null;
  try {
    return JSON.parse(payload) as ContextSession;
  } catch (error) {
    loggerService.error('ContextService: Failed to parse session payload', { id, error });
    return null;
  }
};

const loadHistory = async (sessionId: string): Promise<ContextMessage[]> => {
  const payload = await redisService.request(['GET', historyKey(sessionId)]);
  if (!payload) return [];
  try {
    return JSON.parse(payload) as ContextMessage[];
  } catch (error) {
    loggerService.error('ContextService: Failed to parse history payload', { sessionId, error });
    return [];
  }
};

const persistHistory = async (sessionId: string, history: ContextMessage[]) => {
  await redisService.request(['SET', historyKey(sessionId), JSON.stringify(history)]);
};

const closeSessionInternal = async (session: ContextSession): Promise<ContextSession> => {
  if (session.status === 'closed') return session;

  const closed: ContextSession = {
    ...session,
    status: 'closed',
    closedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await persistSession(closed);
  return closed;
};

const writeToolNames = new Set([
  'upsert_symbols',
  'delete_symbols',
  'compress_symbols',
  'create_domain',
  'upsert_loop',
  'add_test_case',
  'delete_test_case',
  'reindex_vector_store',
]);

export const contextService = {
  async createSession(type: ContextSession['type'], metadata?: Record<string, any>): Promise<ContextSession> {
    const now = new Date().toISOString();
    const session: ContextSession = {
      id: generateId(),
      type,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      metadata,
    };

    await persistSession(session);
    await persistHistory(session.id, []);
    return session;
  },

  async listSessions(): Promise<ContextSession[]> {
    const ids: string[] = await redisService.request(['SMEMBERS', CONTEXT_INDEX_KEY]);
    const sessions: ContextSession[] = [];

    for (const id of ids || []) {
      const session = await loadSession(id);
      if (session) sessions.push(session);
    }

    return sessions;
  },

  async getSession(id: string): Promise<ContextSession | null> {
    return loadSession(id);
  },

  async getHistory(id: string): Promise<ContextMessage[]> {
    return loadHistory(id);
  },

  async recordMessage(sessionId: string, message: Omit<ContextMessage, 'timestamp'> & { timestamp?: string }): Promise<void> {
    const session = await loadSession(sessionId);
    if (!session) {
      throw new Error(`Context session not found: ${sessionId}`);
    }

    const history = await loadHistory(sessionId);
    const entry: ContextMessage = {
      ...message,
      timestamp: message.timestamp || new Date().toISOString(),
    };

    history.push(entry);
    await persistHistory(sessionId, history);

    const updated: ContextSession = {
      ...session,
      updatedAt: new Date().toISOString(),
    };
    await persistSession(updated);
  },

  async ensureConversationSession(forceNew: boolean = false, metadata?: Record<string, any>): Promise<{ session: ContextSession; created: boolean }> {
    const sessions = await this.listSessions();
    const openConversations = sessions.filter((s) => s.type === 'conversation' && s.status === 'open');

    if (openConversations.length > 0 && !forceNew) {
      const [primary, ...extras] = openConversations;
      for (const session of extras) {
        await closeSessionInternal(session);
      }
      return { session: primary, created: false };
    }

    for (const session of openConversations) {
      await closeSessionInternal(session);
    }

    const session = await this.createSession('conversation', metadata);
    return { session, created: true };
  },

  async closeSession(id: string): Promise<ContextSession | null> {
    const session = await loadSession(id);
    if (!session) return null;
    return closeSessionInternal(session);
  },

  async closeConversationSessions(): Promise<void> {
    const sessions = await this.listSessions();
    const openConversations = sessions.filter((s) => s.type === 'conversation' && s.status === 'open');
    for (const session of openConversations) {
      await closeSessionInternal(session);
    }
  },

  async startLoopSession(loopId: string, metadata?: Record<string, any>): Promise<ContextSession> {
    return this.createSession('loop', { loopId, ...(metadata || {}) });
  },

  async closeLoopSession(id: string): Promise<ContextSession | null> {
    return this.closeSession(id);
  },

  async isWriteAllowed(sessionId: string | undefined, toolName: string): Promise<boolean> {
    if (!sessionId) return true;
    const session = await loadSession(sessionId);
    if (!session) return true;
    if (session.status === 'closed' && writeToolNames.has(toolName)) {
      return false;
    }
    return true;
  },
};
