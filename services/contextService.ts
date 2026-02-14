import { redisService } from './redisService.js';
import { loggerService } from './loggerService.js';
import { ContextMessage, ContextSession, ContextHistoryGroup } from '../types.js';

const CONTEXT_INDEX_KEY = 'context:index';
const USER_CONTEXT_INDEX_PREFIX = 'context:user:'; // context:user:{userId} -> Set of context IDs

const sessionKey = (id: string) => `context:session:${id}`;
const historyKey = (id: string) => `context:history:${id}`;
const queueKey = (id: string) => `context:queue:${id}`;
const userIndexKey = (userId: string) => `${USER_CONTEXT_INDEX_PREFIX}${userId}`;

const generateId = () => `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const persistSession = async (session: ContextSession) => {
  await redisService.request(['SADD', CONTEXT_INDEX_KEY, session.id]);
  await redisService.request(['SET', sessionKey(session.id), JSON.stringify(session)]);
  
  // Add to user-specific index if owned by a user
  if (session.userId) {
    await redisService.request(['SADD', userIndexKey(session.userId), session.id]);
  }
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
  async createSession(
    type: ContextSession['type'], 
    metadata?: Record<string, any>, 
    name?: string,
    userId?: string
  ): Promise<ContextSession> {
    const now = new Date().toISOString();
    const session: ContextSession = {
      id: generateId(),
      name: name || `Context ${new Date().toLocaleTimeString()}`,
      type,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      metadata,
      userId: userId || null,
    };

    await persistSession(session);
    await persistHistory(session.id, []);
    return session;
  },

  /**
   * List sessions accessible to a user.
   * - Regular users: only their own conversation contexts
   * - Admins: all contexts including agent/loop contexts
   */
  async listSessions(userId?: string, isAdmin?: boolean): Promise<ContextSession[]> {
    let ids: string[] = [];
    
    if (isAdmin) {
      // Admins can see all contexts
      ids = await redisService.request(['SMEMBERS', CONTEXT_INDEX_KEY]);
    } else if (userId) {
      // Regular users only see their own contexts
      ids = await redisService.request(['SMEMBERS', userIndexKey(userId)]);
    } else {
      // No userId provided - return empty (shouldn't happen with proper auth)
      return [];
    }
    
    const sessions: ContextSession[] = [];

    for (const id of ids || []) {
      const session = await loadSession(id);
      if (session) {
        // Additional filter: non-admins should not see agent/loop contexts
        if (!isAdmin && session.type === 'agent') {
          continue;
        }
        sessions.push(session);
      }
    }

    return sessions;
  },

  /**
   * Get a session if the user has access to it.
   */
  async getSession(id: string, userId?: string, isAdmin?: boolean): Promise<ContextSession | null> {
    const session = await loadSession(id);
    if (!session) return null;
    
    // Admin can access any session
    if (isAdmin) return session;
    
    // User can only access their own sessions
    if (userId && session.userId === userId) {
      // Non-admins cannot access agent/loop contexts
      if (session.type === 'agent') {
        return null;
      }
      return session;
    }
    
    // No access
    return null;
  },

  /**
   * Check if user can access a session.
   */
  async canAccessSession(id: string, userId?: string, isAdmin?: boolean): Promise<boolean> {
    const session = await loadSession(id);
    if (!session) return false;
    
    if (isAdmin) return true;
    if (userId && session.userId === userId && session.type !== 'agent') return true;
    
    return false;
  },

  async closeSession(id: string, userId?: string, isAdmin?: boolean): Promise<ContextSession | null> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(id, userId, isAdmin);
    if (!hasAccess) return null;
    
    const session = await loadSession(id);
    if (!session) return null;
    
    return closeSessionInternal(session);
  },

  async deleteSession(id: string, userId?: string, isAdmin?: boolean): Promise<boolean> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(id, userId, isAdmin);
    if (!hasAccess) return false;
    
    const session = await loadSession(id);
    if (!session) return false;

    await redisService.request(['DEL', sessionKey(id)]);
    await redisService.request(['DEL', historyKey(id)]);
    await redisService.request(['DEL', queueKey(id)]);
    await redisService.request(['SREM', CONTEXT_INDEX_KEY, id]);
    
    // Also remove from user index if applicable
    if (session.userId) {
      await redisService.request(['SREM', userIndexKey(session.userId), id]);
    }

    return true;
  },

  async getHistory(sessionId: string, userId?: string, isAdmin?: boolean): Promise<ContextMessage[]> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return [];
    
    return loadHistory(sessionId);
  },

  async getUnfilteredHistory(sessionId: string, userId?: string, isAdmin?: boolean): Promise<ContextMessage[]> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return [];
    
    return loadHistory(sessionId);
  },

  async appendHistory(sessionId: string, messages: ContextMessage[], userId?: string, isAdmin?: boolean): Promise<void> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) throw new Error('Access denied');
    
    const history = await loadHistory(sessionId);
    history.push(...messages);
    await persistHistory(sessionId, history);
  },

  async setActiveMessage(sessionId: string, messageId: string | null, userId?: string, isAdmin?: boolean): Promise<void> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) throw new Error('Access denied');
    
    const session = await loadSession(sessionId);
    if (!session) return;

    session.activeMessageId = messageId;
    session.updatedAt = new Date().toISOString();
    await persistSession(session);
  },

  async clearActiveMessage(sessionId: string, userId?: string, isAdmin?: boolean): Promise<void> {
    return contextService.setActiveMessage(sessionId, null, userId, isAdmin);
  },

  async updateSessionMetadata(sessionId: string, metadata: Record<string, any>, userId?: string, isAdmin?: boolean): Promise<ContextSession | null> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return null;
    
    const session = await loadSession(sessionId);
    if (!session) return null;

    session.metadata = { ...session.metadata, ...metadata };
    session.updatedAt = new Date().toISOString();
    await persistSession(session);
    return session;
  },

  async enqueueMessage(sessionId: string, message: ContextMessage, userId?: string, isAdmin?: boolean): Promise<void> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) throw new Error('Access denied');
    
    const queue = await redisService.request(['LPUSH', queueKey(sessionId), JSON.stringify(message)]);
  },

  async dequeueMessage(sessionId: string, userId?: string, isAdmin?: boolean): Promise<ContextMessage | null> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return null;
    
    const payload = await redisService.request(['RPOP', queueKey(sessionId)]);
    if (!payload) return null;
    try {
      return JSON.parse(payload) as ContextMessage;
    } catch {
      return null;
    }
  },

  async getHistoryGrouped(sessionId: string, userId?: string, isAdmin?: boolean): Promise<ContextHistoryGroup[]> {
    // Verify access first
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return [];
    
    const history = await loadHistory(sessionId);
    const groups: ContextHistoryGroup[] = [];
    let currentGroup: ContextHistoryGroup | null = null;

    for (const message of history) {
      if (message.role === 'user') {
        if (currentGroup) {
          groups.push(currentGroup);
        }
        currentGroup = {
          correlationId: message.correlationId || message.id,
          userMessage: message,
          assistantMessages: [],
          status: 'complete',
        };
      } else if (currentGroup) {
        currentGroup.assistantMessages.push(message);
        if (message.role === 'model' && message.isStreaming) {
          currentGroup.status = 'processing';
        }
      }
    }

    if (currentGroup) {
      groups.push(currentGroup);
    }

    return groups;
  },

  /**
   * Check if a session has an active message being processed
   */
  async hasActiveMessage(sessionId: string, userId?: string, isAdmin?: boolean): Promise<boolean> {
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return false;
    
    const session = await loadSession(sessionId);
    return !!session?.activeMessageId;
  },

  /**
   * Check if a session has queued messages
   */
  async hasQueuedMessages(sessionId: string, userId?: string, isAdmin?: boolean): Promise<boolean> {
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return false;
    
    const len = await redisService.request(['LLEN', queueKey(sessionId)]);
    return (len || 0) > 0;
  },

  /**
   * Pop the next message from the queue
   */
  async popNextMessage(sessionId: string, userId?: string, isAdmin?: boolean): Promise<{ sourceId: string; message: string } | null> {
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return null;
    
    const payload = await redisService.request(['RPOP', queueKey(sessionId)]);
    if (!payload) return null;
    
    try {
      const parsed = JSON.parse(payload) as ContextMessage;
      return {
        sourceId: parsed.id,
        message: parsed.content
      };
    } catch {
      return null;
    }
  },

  /**
   * Request cancellation for a session
   */
  async requestCancellation(sessionId: string, userId?: string, isAdmin?: boolean): Promise<void> {
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) throw new Error('Access denied');
    
    const cancelKey = `context:cancellation:${sessionId}`;
    await redisService.request(['SET', cancelKey, '1', 'EX', '60']); // 60 second expiry
  },

  /**
   * Check if cancellation has been requested
   */
  async hasCancellationRequest(sessionId: string, userId?: string, isAdmin?: boolean): Promise<boolean> {
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return false;
    
    const cancelKey = `context:cancellation:${sessionId}`;
    const exists = await redisService.request(['EXISTS', cancelKey]);
    return !!exists;
  },

  /**
   * Alias for hasCancellationRequest for backward compatibility
   */
  async isCancelled(sessionId: string, userId?: string, isAdmin?: boolean): Promise<boolean> {
    return contextService.hasCancellationRequest(sessionId, userId, isAdmin);
  },

  /**
   * Clear cancellation request
   */
  async clearCancellation(sessionId: string, userId?: string, isAdmin?: boolean): Promise<void> {
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return;
    
    const cancelKey = `context:cancellation:${sessionId}`;
    await redisService.request(['DEL', cancelKey]);
  },

  /**
   * Record a message to the session history
   */
  async recordMessage(sessionId: string, message: ContextMessage, userId?: string, isAdmin?: boolean): Promise<void> {
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) throw new Error('Access denied');
    
    const history = await loadHistory(sessionId);
    history.push(message);
    await persistHistory(sessionId, history);
  },

  /**
   * Check if write operations are allowed for a session
   */
  async isWriteAllowed(sessionId: string | undefined, toolName: string): Promise<boolean> {
    if (!sessionId) return true; // Allow if no session context
    
    const session = await loadSession(sessionId);
    if (!session) return false;
    
    // Closed sessions don't allow writes
    if (session.status === 'closed') return false;
    
    // Always allow read operations
    const readOnlyTools = ['find_symbols', 'load_symbols', 'list_domains', 'list_agents', 'list_agent_executions', 'list_test_runs', 'list_test_failures', 'sys_info', 'web_fetch', 'web_search', 'web_post'];
    if (readOnlyTools.includes(toolName)) return true;
    
    return true;
  },

  /**
   * Rename a session
   */
  async renameSession(sessionId: string, name: string, userId?: string, isAdmin?: boolean): Promise<ContextSession | null> {
    const hasAccess = await contextService.canAccessSession(sessionId, userId, isAdmin);
    if (!hasAccess) return null;
    
    const session = await loadSession(sessionId);
    if (!session) return null;

    session.name = name;
    session.updatedAt = new Date().toISOString();
    await persistSession(session);
    return session;
  },

  /**
   * Cleanup test sessions (admin only operation)
   */
  async cleanupTestSessions(): Promise<number> {
    const ids: string[] = await redisService.request(['SMEMBERS', CONTEXT_INDEX_KEY]);
    let cleaned = 0;

    for (const id of ids || []) {
      const session = await loadSession(id);
      if (session?.metadata?.testContext && session.status === 'open') {
        await closeSessionInternal(session);
        cleaned++;
      }
    }

    return cleaned;
  }
};
