import { redisService } from './redisService.js';
import { loggerService } from './loggerService.js';
import { ContextMessage, ContextSession, ContextHistoryGroup } from '../types.js';

const CONTEXT_INDEX_KEY = 'context:index';
const sessionKey = (id: string) => `context:session:${id}`;
const historyKey = (id: string) => `context:history:${id}`;
const queueKey = (id: string) => `context:queue:${id}`;

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
  'create_domain',
  'upsert_loop',
  'add_test_case',
  'delete_test_case',
  'reindex_vector_store',
]);

export const contextService = {
  async createSession(type: ContextSession['type'], metadata?: Record<string, any>, name?: string): Promise<ContextSession> {
    const now = new Date().toISOString();
    const session: ContextSession = {
      id: generateId(),
      name: name || `Context ${new Date().toLocaleTimeString()}`,
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

  async renameSession(id: string, name: string): Promise<ContextSession | null> {
      const session = await loadSession(id);
      if (!session) return null;
      session.name = name;
      session.updatedAt = new Date().toISOString();
      await persistSession(session);
      return session;
  },

  async enqueueMessage(targetId: string, message: string, sourceId: string): Promise<void> {
      const payload = JSON.stringify({ message, sourceId, timestamp: Date.now() });
      await redisService.request(['RPUSH', queueKey(targetId), payload]);
  },

  async popNextMessage(targetId: string): Promise<{ message: string, sourceId: string } | null> {
      const payload = await redisService.request(['LPOP', queueKey(targetId)]);
      if (!payload) return null;
      try {
          return JSON.parse(payload);
      } catch {
          return null;
      }
  },

  async hasQueuedMessages(targetId: string): Promise<boolean> {
      const len = await redisService.request(['LLEN', queueKey(targetId)]);
      return (len as number) > 0;
  },

  async getHistory(id: string, since?: string): Promise<ContextMessage[]> {
    const history = await loadHistory(id);
    const filtered = history.filter(m => m.role !== 'tool');
    if (since) {
        const sinceTime = new Date(since).getTime();
        return filtered.filter(m => new Date(m.timestamp).getTime() >= sinceTime);
    }
    return filtered;
  },

  async getUnfilteredHistory(id: string): Promise<ContextMessage[]> {
    return loadHistory(id);
  },

  async getHistoryGrouped(id: string, since?: string): Promise<ContextHistoryGroup[]> {
      const session = await loadSession(id);
      const rawHistory = await loadHistory(id);
      
      let filtered = rawHistory;
      if (since) {
          const sinceTime = new Date(since).getTime();
          filtered = rawHistory.filter(m => new Date(m.timestamp).getTime() >= sinceTime);
      }
      
      const groups = new Map<string, ContextHistoryGroup>();
      
      for (const msg of filtered) {
          // Identify the correlation group
          let corrId = msg.correlationId;
          if (msg.role === 'user') {
              corrId = msg.id;
          }
          
          if (!corrId) continue;
          
          if (!groups.has(corrId)) {
              groups.set(corrId, {
                  correlationId: corrId,
                  // Placeholder user message if not found in this slice (will be populated if found)
                  userMessage: { id: corrId, role: 'user', content: '', timestamp: msg.timestamp } as ContextMessage,
                  assistantMessages: [],
                  status: 'complete'
              });
          }
          
          const group = groups.get(corrId)!;
          
          if (msg.role === 'user') {
              group.userMessage = msg;
          } else {
              // Include non-user messages. Sanitize tool results to hide their content from the UI.
              const cleanMsg = {
                  ...msg,
                  content: msg.role === 'tool' ? '' : msg.content
              };
              group.assistantMessages.push(cleanMsg);
          }
      }
      
      if (session?.activeMessageId && groups.has(session.activeMessageId)) {
          groups.get(session.activeMessageId)!.status = 'processing';
      }
      
      return Array.from(groups.values()).sort((a, b) => new Date(a.userMessage.timestamp).getTime() - new Date(b.userMessage.timestamp).getTime());
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

  async requestCancellation(sessionId: string): Promise<void> {
      const session = await loadSession(sessionId);
      if (!session) return;
      session.metadata = { ...session.metadata, cancellationRequested: true };
      await persistSession(session);
  },

  async clearCancellation(sessionId: string): Promise<void> {
      const session = await loadSession(sessionId);
      if (!session) return;
      if (session.metadata?.cancellationRequested) {
          delete session.metadata.cancellationRequested;
          await persistSession(session);
      }
  },

  async isCancelled(sessionId: string): Promise<boolean> {
      const session = await loadSession(sessionId);
      return !!session?.metadata?.cancellationRequested;
  },

  async updateMetadata(sessionId: string, metadata: Record<string, any>): Promise<void> {
      const session = await loadSession(sessionId);
      if (!session) return;
      session.metadata = { ...(session.metadata || {}), ...metadata };
      session.updatedAt = new Date().toISOString();
      await persistSession(session);
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

  async setActiveMessage(sessionId: string, messageId: string): Promise<void> {
      const session = await loadSession(sessionId);
      if (!session) return;
      session.activeMessageId = messageId;
      await persistSession(session);
  },

  async clearActiveMessage(sessionId: string): Promise<void> {
      const session = await loadSession(sessionId);
      if (!session) return;
      session.activeMessageId = null;
      await persistSession(session);
  },

  async hasActiveMessage(sessionId: string): Promise<boolean> {
      const session = await loadSession(sessionId);
      return !!session?.activeMessageId;
  },

  async cleanupTestSessions(): Promise<number> {
      const sessions = await this.listSessions();
      // Test sessions often have a specific metadata signature or type 'loop' that wasn't properly closed
      // Or they are 'conversation' type but were created specifically for a test run
      // Looking at startTestRun in testService, it creates tool executors which might use temp sessions.
      // Actually, runSignalZeroTest often creates a session with source: 'test' or similar if we set it.
      
      const toDelete = sessions.filter(s => 
          s.status === 'open' && 
          (s.metadata?.source === 'test' || s.metadata?.temp === true)
      );

      for (const session of toDelete) {
          await redisService.request(['SREM', CONTEXT_INDEX_KEY, session.id]);
          await redisService.request(['DEL', sessionKey(session.id)]);
          await redisService.request(['DEL', historyKey(session.id)]);
      }

      return toDelete.length;
  }
};
