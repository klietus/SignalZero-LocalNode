import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { getChatSession, resetChatSession, sendMessageAndHandleTools, runSignalZeroTest, processMessageAsync } from './services/inferenceService.js';
import { createToolExecutor } from './services/toolsService.js';
import { settingsService } from './services/settingsService.js';
import { ACTIVATION_PROMPT } from './symbolic_system/activation_prompt.js';
import { domainService, ReadOnlyDomainError } from './services/domainService.js';
import { traceService } from './services/traceService.js';
import { projectService } from './services/projectService.js';
import { testService } from './services/testService.js';
import { ProjectMeta } from './types.js';
import { loggerService } from './services/loggerService.js';
import { systemPromptService } from './services/systemPromptService.js';
import { fileURLToPath } from 'url';
import { agentService } from './services/agentService.js';
import { contextService } from './services/contextService.js';
import { documentMeaningService } from './services/documentMeaningService.js';
import { redisService } from './services/redisService.js';
import { authService, AuthContext } from './services/authService.js';
import { userService } from './services/userService.js';
import { contextWindowService } from './services/contextWindowService.js';

import { vectorService } from './services/vectorService.js';
import { indexingService } from './services/indexingService.js';

// MCP Session Store
const mcpSessions = new Map<string, { userId: string; res: express.Response; createdAt: number }>();

// MCP Method Handler
async function handleMCPMethod(method: string, params: any, userId: string): Promise<any> {
    switch (method) {
        case 'initialize':
            return {
                protocolVersion: '2024-11-05',
                capabilities: {
                    symbolicDomains: true,
                    vectorSearch: true,
                    contextWindows: true
                },
                serverInfo: {
                    name: 'signalzero-mcp',
                    version: '1.0.0'
                }
            };

        case 'domains/list':
            const domains = await domainService.listDomains(userId);
            return { domains };

        case 'domains/get':
            const domain = await domainService.get(params.domainId, userId);
            return { domain };

        case 'symbols/search':
            const results = await domainService.search(
                params.query,
                userId,
                params.domainId,
                params.limit || 10
            );
            return { results };

        case 'symbols/activate':
            const symbol = await domainService.activate(params.symbolId, userId);
            return { symbol };

        case 'context/build':
            const contextSessionId = params.sessionId || randomUUID();
            const systemPrompt = params.systemPrompt || ACTIVATION_PROMPT;
            const context = await contextWindowService.constructContextWindow(
                contextSessionId,
                systemPrompt,
                userId
            );
            return { contextSessionId, context };

        case 'ping':
            return { pong: true };

        default:
            throw new Error(`Method not found: ${method}`);
    }
}

dotenv.config();

const app = express();
// @ts-ignore
app.use(cors());
// @ts-ignore
app.use(express.json({ limit: '500mb' }));

// Configure Multer for file uploads
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

const isReadOnlyError = (error: unknown): error is ReadOnlyDomainError => {
    return error instanceof ReadOnlyDomainError || (typeof error === 'object' && error !== null && (error as any).name === 'ReadOnlyDomainError');
};

const buildReadOnlyResponse = (error: any) => ({
    error: (error as Error)?.message || 'Domain is read-only',
    domainId: error?.domainId,
    symbolId: error?.symbolId
});

// Request Logging Middleware
app.use((req, res, next) => {
    const isPolling = req.method === 'GET' && (
        req.url.startsWith('/api/contexts') || 
        req.url.includes('/history') || 
        req.url.startsWith('/api/traces') ||
        req.url === '/api/voice/mic/status' ||
        req.url === '/api/voice/story/status'
    );
    
    if (!isPolling) {
        loggerService.info(`Request: ${req.method} ${req.url}`, {
            query: req.query,
            body: req.method === 'POST' || req.method === 'PATCH' ? req.body : undefined
        });
    }
    next();
});

const PORT = process.env.PORT || 3001;

// Extend Express Request to include user
interface AuthenticatedRequest extends express.Request {
    user?: AuthContext;
}

// Auth Middleware
const requireAuth = async (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
    if (req.method === 'OPTIONS') return next();
    
    const publicPaths = ['/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login'];
    if (publicPaths.includes(req.path)) return next();

    // Check for Internal Service Key
    const internalKey = req.headers['x-internal-key'];
    if (internalKey && internalKey === process.env.INTERNAL_SERVICE_KEY) {
        req.user = { userId: 'system', username: 'system', role: 'admin' };
        return next();
    }

    // Check for API Key (X-API-Key header)
    const apiKey = req.headers['x-api-key'];
    if (typeof apiKey === 'string') {
        const authContext = await authService.verifyApiKey(apiKey);
        if (authContext) {
            req.user = authContext;
            return next();
        }
    }

    // Check for Session Token
    const authHeader = req.headers['authorization'] || req.headers['x-auth-token'];
    const token = typeof authHeader === 'string' ? authHeader.replace('Bearer ', '') : null;

    if (token) {
        const authContext = authService.verifySession(token);
        if (authContext) {
            req.user = authContext;
            return next();
        }
    }

    res.status(401).json({ error: 'Unauthorized' });
};

app.use(requireAuth);

// Auth Routes
app.get('/api/auth/status', async (req, res) => {
    const token = (req.headers['x-auth-token'] as string) || '';
    const session = token ? authService.verifySession(token) : null;
    res.json({
        initialized: await authService.isInitialized(),
        authenticated: !!session,
        user: session ? { userId: session.userId, username: session.username, role: session.role } : null
    });
});

app.post('/api/auth/setup', async (req, res) => {
    const { username, password, inference } = req.body;
    try {
        if (await authService.isInitialized()) {
             res.status(400).json({ error: 'System already initialized' });
             return;
        }
        if (!username || !password) {
             res.status(400).json({ error: 'Username and password required' });
             return;
        }

        await authService.initialize(username, password);
        
        if (inference) {
            await settingsService.setInferenceSettings(inference);
        }

        const token = await authService.login(username, password);
        res.json({ status: 'success', token, user: { name: username } });
    } catch (e) {
        loggerService.error('Setup failed', { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    const token = await authService.login(username, password);
    if (token) {
        const user = await userService.getUserByUsername(username);
        res.json({ 
            token, 
            user: { 
                id: user?.id,
                name: username,
                role: user?.role,
                apiKey: user?.apiKey 
            } 
        });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/api/auth/change-password', async (req: AuthenticatedRequest, res) => {
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
        return res.status(400).json({ error: 'Missing current or new password' });
    }

    try {
        if (!req.user?.userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        await authService.changePassword(oldPassword, newPassword, req.user.userId);
        res.json({ success: true, message: 'Password changed successfully' });
    } catch (error: any) {
        res.status(401).json({ error: error.message });
    }
});

// --- User Management Routes ---

// List all users (admin only)
app.get('/api/users', async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const users = await userService.listUsers();
        // Don't return password hashes
        const safeUsers = users.map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            enabled: u.enabled,
            createdAt: u.createdAt,
            updatedAt: u.updatedAt,
            apiKey: u.apiKey
        }));
        res.json({ users: safeUsers });
    } catch (e) {
        loggerService.error('Error listing users', { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Create new user (admin only)
app.post('/api/users', async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        const { username, password, role = 'user' } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const user = await userService.createUser({ username, password }, role);
        res.status(201).json({
            id: user.id,
            username: user.username,
            role: user.role,
            enabled: user.enabled,
            apiKey: user.apiKey,
            createdAt: user.createdAt
        });
    } catch (e: any) {
        loggerService.error('Error creating user', { error: e });
        res.status(400).json({ error: e.message || String(e) });
    }
});

// Get current user
app.get('/api/users/me', async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user?.userId) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        const user = await userService.getUserById(req.user.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            enabled: user.enabled,
            apiKey: user.apiKey,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt
        });
    } catch (e) {
        loggerService.error('Error getting current user', { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Get user by ID
app.get('/api/users/:id', async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        // Users can view themselves, admins can view anyone
        if (req.user.role !== 'admin' && req.user.userId !== req.params.id) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const user = await userService.getUserById(req.params.id);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            enabled: user.enabled,
            apiKey: user.apiKey,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt
        });
    } catch (e) {
        loggerService.error('Error getting user', { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Update user
app.patch('/api/users/:id', async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        // Users can update themselves, admins can update anyone
        if (req.user.role !== 'admin' && req.user.userId !== req.params.id) {
            return res.status(403).json({ error: 'Access denied' });
        }
        // Non-admins can't change role
        if (req.body.role && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Only admins can change role' });
        }
        const user = await userService.updateUser(req.params.id, req.body);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            enabled: user.enabled,
            apiKey: user.apiKey,
            updatedAt: user.updatedAt
        });
    } catch (e: any) {
        loggerService.error('Error updating user', { error: e });
        res.status(400).json({ error: e.message || String(e) });
    }
});

// Delete user (admin only)
app.delete('/api/users/:id', async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        // Prevent deleting yourself
        if (req.user.userId === req.params.id) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }
        const success = await userService.deleteUser(req.params.id);
        if (!success) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ success: true });
    } catch (e) {
        loggerService.error('Error deleting user', { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// --- MCP Server Routes ---

// MCP Server-Sent Events endpoint
app.get('/mcp/sse', async (req: AuthenticatedRequest, res) => {
    // Verify API key for MCP access
    const apiKey = req.headers['x-api-key'];
    const internalKey = req.headers['x-internal-key'];
    
    let user = null;
    if (typeof apiKey === 'string') {
        user = await authService.verifyApiKey(apiKey);
    }
    if (!user && internalKey === process.env.INTERNAL_SERVICE_KEY) {
        user = { userId: 'system', username: 'system', role: 'admin' };
    }
    
    if (!user) {
        return res.status(401).json({ error: 'Invalid API key' });
    }

    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial endpoint event
    const sessionId = randomUUID();
    res.write(`event: endpoint\n`);
    res.write(`data: /mcp/messages?sessionId=${sessionId}\n\n`);

    // Store session for message routing
    await redisService.request(['SET', `mcp:session:${sessionId}`, JSON.stringify({ userId: user.userId, createdAt: Date.now() }), 'EX', '3600']);

    // Keep connection alive
    const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
    }, 30000);

    // Clean up on close
    req.on('close', () => {
        clearInterval(keepAlive);
        redisService.request(['DEL', `mcp:session:${sessionId}`]);
    });
});

// MCP Messages endpoint (JSON-RPC)
app.post('/mcp/messages', async (req: AuthenticatedRequest, res) => {
    const { sessionId } = req.query;
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'Session ID required' });
    }

    // Verify session
    const sessionData = await redisService.request(['GET', `mcp:session:${sessionId}`]);
    if (!sessionData) {
        return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const session = JSON.parse(sessionData);
    const { jsonrpc, method, params, id } = req.body;

    if (jsonrpc !== '2.0') {
        return res.json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id });
    }

    try {
        let result: any;

        switch (method) {
            case 'initialize':
                result = {
                    protocolVersion: '2024-11-05',
                    capabilities: {
                        tools: {},
                        resources: {}
                    },
                    serverInfo: {
                        name: 'SignalZero LocalNode',
                        version: '1.0.0'
                    }
                };
                break;

            case 'tools/list':
                result = {
                    tools: [
                        {
                            name: 'search_symbols',
                            description: 'Search for symbols across domains',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    query: { type: 'string', description: 'Search query' },
                                    limit: { type: 'number', description: 'Max results' }
                                },
                                required: ['query']
                            }
                        },
                        {
                            name: 'get_symbol',
                            description: 'Get a symbol by ID',
                            inputSchema: {
                                type: 'object',
                                properties: {
                                    id: { type: 'string', description: 'Symbol ID' }
                                },
                                required: ['id']
                            }
                        },
                        {
                            name: 'list_domains',
                            description: 'List all accessible domains',
                            inputSchema: {
                                type: 'object',
                                properties: {}
                            }
                        }
                    ]
                };
                break;

            case 'tools/call':
                const { name, arguments: args } = params;
                switch (name) {
                    case 'search_symbols':
                        const searchResults = await domainService.search(args.query, session.userId, undefined, args.limit || 5);
                        result = {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify(searchResults, null, 2)
                                }
                            ]
                        };
                        break;
                    case 'get_symbol':
                        const symbol = await domainService.findById(args.id, session.userId);
                        result = {
                            content: [
                                {
                                    type: 'text',
                                    text: symbol ? JSON.stringify(symbol, null, 2) : 'Symbol not found'
                                }
                            ]
                        };
                        break;
                    case 'list_domains':
                        const domains = await domainService.getMetadata(session.userId);
                        result = {
                            content: [
                                {
                                    type: 'text',
                                    text: JSON.stringify(domains, null, 2)
                                }
                            ]
                        };
                        break;
                    default:
                        return res.json({ jsonrpc: '2.0', error: { code: -32601, message: `Tool not found: ${name}` }, id });
                }
                break;

            default:
                return res.json({ jsonrpc: '2.0', error: { code: -32601, message: `Method not found: ${method}` }, id });
        }

        res.json({ jsonrpc: '2.0', result, id });
    } catch (error: any) {
        loggerService.error('MCP error', { method, error });
        res.json({ jsonrpc: '2.0', error: { code: -32603, message: error.message || 'Internal error' }, id });
    }
});

// Upload Endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
    }

    try {
        const { buffer, mimetype, originalname } = req.file;
        const parsed = await documentMeaningService.parse(buffer, mimetype, originalname);
        
        const attachmentId = randomUUID();
        // Save to Redis with 24h TTL
        await redisService.request(['SET', `attachment:${attachmentId}`, JSON.stringify(parsed), 'EX', '86400']);

        loggerService.info(`File uploaded, parsed and cached: ${originalname}`, { 
            attachmentId,
            type: parsed.type, 
            metadata: parsed.metadata 
        });

        res.json({
            status: 'success',
            attachmentId,
            filename: originalname,
            document: parsed // Returning full doc for backward compatibility/immediate UI preview if needed
        });
    } catch (e) {
        loggerService.error(`File upload failed`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Health Check Endpoint
app.get('/api/health', async (req, res) => {
    const redis = await domainService.healthCheck();
    const vector = await vectorService.healthCheck();

    const status = redis && vector ? 'healthy' : 'degraded';
    
    res.json({
        status,
        services: {
            redis: redis ? 'up' : 'down',
            vector: vector ? 'up' : 'down'
        },
        timestamp: new Date().toISOString()
    });
});

// System Settings
app.get('/api/settings', async (req, res) => {
    try {
        const settings = await settingsService.getSystemSettings();
        res.json(settings);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const { redis, chroma, inference, googleSearch } = req.body || {};
        await settingsService.setSystemSettings({ redis, chroma, inference, googleSearch });
        const updated = await settingsService.getSystemSettings();
        res.json(updated);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to update settings' });
    }
});

// Upload GCP Service Account
app.post('/api/admin/gcp-service-account', upload.single('file'), async (req, res) => {
    if (!req.file) {
        res.status(400).json({ error: 'No file uploaded' });
        return;
    }

    try {
        const fileContent = req.file.buffer.toString('utf-8');
        let json: any;
        try {
            json = JSON.parse(fileContent);
        } catch (e) {
            res.status(400).json({ error: 'Uploaded file is not valid JSON' });
            return;
        }

        // Import dynamically to avoid circular deps if any (though secretManagerService is safe)
        const { secretManagerService } = await import('./services/secretManagerService.js');
        
        // Update memory
        secretManagerService.setServiceAccountKey(json);

        // Persist to disk for restarts
        try {
            await fs.promises.writeFile('/app/data/service-account.json', fileContent, 'utf-8');
            loggerService.info('Saved GCP service account to /app/data/service-account.json');
            
            // Note: secretManagerService.loadServiceAccount() logic might need to be aware of this path 
            // if it wasn't already configured via env var. 
            // However, the prompt asked to "upload ... to power secrets manager api". 
            // Setting it in memory powers it immediately.
        } catch (persistError) {
            loggerService.warn('Failed to persist service account file to disk', { error: persistError });
        }

        res.json({ status: 'success', message: 'Service account updated' });
    } catch (e: any) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: e.message || String(e) });
    }
});

// Index Management
app.post('/api/index/reindex', async (req, res) => {
    try {
        const includeDisabled = req.body?.includeDisabled === true;
        const result = await indexingService.reindexSymbols(includeDisabled);
        res.json(result);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/index/status', async (req, res) => {
    try {
        const status = await indexingService.getStatus();
        res.json(status);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Initialize Chat
let activeSystemPrompt = ACTIVATION_PROMPT;

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
  const { message, contextSessionId, messageId } = req.body;

  if (!message) {
     res.status(400).json({ error: 'Message is required' });
     return;
  }

  if (!contextSessionId) {
      res.status(400).json({ error: 'Context session ID is required' });
      return;
  }

  try {
    const contextSession = await contextService.getSession(contextSessionId);
    if (!contextSession) {
        res.status(404).json({ error: 'Context session not found' });
        return;
    }

    if (contextSession.status === 'closed') {
        res.status(400).json({ error: 'Context session is closed/archived' });
        return;
    }

    if (await contextService.hasActiveMessage(contextSession.id)) {
        res.status(409).json({ error: 'Context is busy processing another message' });
        return;
    }

    // Lock the context
    await contextService.setActiveMessage(contextSession.id, messageId || 'unknown');

    const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), contextSession.id);
    
    // Fire and forget
    processMessageAsync(contextSession.id, message, toolExecutor, activeSystemPrompt, messageId);

    res.status(202).json({
        status: 'accepted',
        contextSessionId: contextSession.id
    });

  } catch (error) {
    loggerService.error("Chat Error", { error });
    res.status(500).json({ error: String(error) });
  }
});

// Stop Chat Endpoint
app.post('/api/chat/stop', async (req, res) => {
    const { contextSessionId } = req.body;
    if (!contextSessionId) {
        res.status(400).json({ error: 'Context session ID is required' });
        return;
    }
    try {
        await contextService.requestCancellation(contextSessionId);
        loggerService.info("Cancellation requested for session", { contextSessionId });
        res.json({ status: 'cancellation_requested' });
    } catch (e) {
        loggerService.error("Failed to stop chat", { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Trigger Context Processing (Queue Drain)
app.post('/api/contexts/:id/trigger', async (req, res) => {
    const { id } = req.params;
    try {
        if (!await contextService.hasActiveMessage(id) && await contextService.hasQueuedMessages(id)) {
            const nextItem = await contextService.popNextMessage(id);
            if (nextItem) {
                loggerService.info(`Triggering queued message for ${id}`, { sourceId: nextItem.sourceId });
                const queueMsgId = `queued-${Date.now()}`;
                await contextService.setActiveMessage(id, queueMsgId);
                
                const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), id);
                processMessageAsync(id, nextItem.message, toolExecutor, activeSystemPrompt, queueMsgId);
                res.json({ status: 'triggered' });
                return;
            }
        }
        res.json({ status: 'idle' });
    } catch (e) {
        loggerService.error(`Error triggering context ${id}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Send Assistant Message to Latest Conversational Context
app.post('/api/contexts/latest/assistant-message', async (req, res) => {
    const { message } = req.body;
    try {
        const contexts = await contextService.listSessions();
        const conversations = contexts
            .filter(c => c.type === 'conversation' && c.status === 'open')
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

        const latest = conversations[0];
        if (!latest) {
            res.status(404).json({ error: 'No active conversational context found' });
            return;
        }

        await contextService.recordMessage(latest.id, {
            id: randomUUID(),
            role: 'assistant',
            content: message,
            metadata: { kind: 'agent_update' }
        });

        res.json({ status: 'sent', contextId: latest.id });
    } catch (e) {
        loggerService.error('Error sending message to latest context', { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// System Prompt
app.get('/api/system/prompt', (req, res) => {
    res.json({ prompt: activeSystemPrompt });
});

app.post('/api/system/prompt', async (req, res) => {
    const { prompt } = req.body;
    if (prompt) {
        try {
            await systemPromptService.setPrompt(prompt);
            activeSystemPrompt = prompt;
            resetChatSession();
            res.json({ status: 'System prompt updated' });
        } catch (e) {
            loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
            res.status(500).json({ error: 'Failed to persist system prompt' });
        }
    } else {
        res.status(400).json({ error: 'Prompt is required' });
    }
});

// Context Sessions
app.get('/api/contexts', async (req, res) => {
    try {
        const contexts = await contextService.listSessions();
        res.json({ contexts });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to list contexts' });
    }
});

app.post('/api/contexts', async (req, res) => {
    try {
        const type = req.body?.type || 'conversation';
        const session = await contextService.createSession(type, { source: 'api' });
        res.status(201).json(session);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to create context' });
    }
});

app.post('/api/contexts/:id/archive', async (req, res) => {
    try {
        const session = await contextService.closeSession(req.params.id);
        if (!session) {
            res.status(404).json({ error: 'Context not found' });
            return;
        }
        res.json(session);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to archive context' });
    }
});

app.get('/api/contexts/:id/history', async (req, res) => {
    try {
        const session = await contextService.getSession(req.params.id);
        if (!session) {
            res.status(404).json({ error: 'Context session not found' });
            return;
        }

        const since = typeof req.query.since === 'string' ? req.query.since : undefined;
        const history = await contextService.getHistoryGrouped(req.params.id, since);
        res.json({ session, history });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to get context history' });
    }
});

// --- Domain Management ---

// List all domains (Metadata)
app.get('/api/domains', async (req, res) => {
    try {
        const domains = await domainService.getMetadata();
        res.json(domains);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Create domain
app.post('/api/domains', async (req, res) => {
    const { id, name, description, invariants } = req.body;
    if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
    }
    try {
        await domainService.createDomain(id, { name, description, invariants });
        res.json({ status: 'success', id });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Check domain existence
app.get('/api/domains/:id/exists', async (req, res) => {
    try {
        const exists = await domainService.hasDomain(req.params.id);
        res.json({ exists });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Check domain enabled status
app.get('/api/domains/:id/enabled', async (req, res) => {
    try {
        const enabled = await domainService.isEnabled(req.params.id);
        res.json({ enabled });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Toggle domain enabled status
app.post('/api/domains/:id/toggle', async (req, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled boolean is required' });
        return;
    }
    try {
        await domainService.toggleDomain(req.params.id, enabled);
        res.json({ status: 'success', domainId: req.params.id, enabled });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Update domain metadata
app.patch('/api/domains/:id', async (req, res) => {
    const { name, description, invariants } = req.body;
    try {
        await domainService.updateDomainMetadata(req.params.id, { name, description, invariants });
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Delete domain
app.delete('/api/domains/:id', async (req, res) => {
    try {
        await domainService.deleteDomain(req.params.id);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Clear ALL domains
app.post('/api/admin/clear-all', async (req, res) => {
    try {
        await domainService.clearAll();
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// --- Symbol Management ---

// Search symbols (Vector) - Must be before /:id route
app.get('/api/symbols/search', async (req, res) => {
    const { q, limit, time_gte, time_between } = req.query;
    if (!q && !time_gte && !time_between) {
        res.status(400).json({ error: 'Provide a query or time filter (time_gte or time_between) to search symbols.' });
        return;
    }
    try {
        const results = await domainService.search(q as string | null, limit ? Number(limit) : 5, {
            time_gte: time_gte as string | undefined,
            time_between: typeof time_between === 'string' ? (time_between as string).split(',') : (time_between as string[] | undefined),
        });
        res.json(results);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        const message = e instanceof Error ? e.message : String(e);
        const status = message.includes('Provide a query or time filter') ? 400 : 500;
        res.status(status).json({ error: message });
    }
});

// Refactor Symbols
app.post('/api/symbols/refactor', async (req, res) => {
    const { updates } = req.body;
    if (!Array.isArray(updates)) {
        res.status(400).json({ error: 'updates array required' });
        return;
    }
    try {
        const result = await domainService.processRefactorOperation(updates);
        res.json(result);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        if (isReadOnlyError(e)) {
            res.status(400).json(buildReadOnlyResponse(e));
        } else {
            res.status(500).json({ error: String(e) });
        }
    }
});

// Compress Symbols
app.post('/api/symbols/compress', async (req, res) => {
    const { newSymbol, oldIds } = req.body;
    if (!newSymbol || !Array.isArray(oldIds)) {
        res.status(400).json({ error: 'newSymbol and oldIds array required' });
        return;
    }
    try {
        const result = await domainService.compressSymbols(newSymbol, oldIds);
        res.json(result);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        if (isReadOnlyError(e)) {
            res.status(400).json(buildReadOnlyResponse(e));
        } else {
            res.status(500).json({ error: String(e) });
        }
    }
});

// Get symbol by ID (Global)
app.get('/api/symbols/:id', async (req, res) => {
    try {
        const symbol = await domainService.findById(req.params.id);
        if (symbol) res.json(symbol);
        else res.status(404).json({ error: 'Symbol not found' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Get all symbols in domain
app.get('/api/domains/:id/symbols', async (req, res) => {
    try {
        const symbols = await domainService.getSymbols(req.params.id);
        res.json(symbols);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Query/Filter symbols in domain
app.get('/api/domains/:id/query', async (req, res) => {
    const { tag, limit, lastId } = req.query;
    try {
        const result = await domainService.query(
            req.params.id,
            tag as string,
            limit ? Number(limit) : 20,
            lastId as string
        );
        res.json(result || { items: [], total: 0 });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Upsert symbol
app.post('/api/domains/:id/symbols', async (req, res) => {
    const symbol = req.body;
    if (!symbol || !symbol.id) {
        res.status(400).json({ error: 'Valid symbol object with id is required' });
        return;
    }
    try {
        await domainService.upsertSymbol(req.params.id, symbol);
        res.json({ status: 'success', id: symbol.id });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        if (isReadOnlyError(e)) {
            res.status(400).json(buildReadOnlyResponse(e));
        } else {
            res.status(500).json({ error: String(e) });
        }
    }
});

// Bulk Upsert symbols
app.post('/api/domains/:id/symbols/bulk', async (req, res) => {
    const symbols = req.body;
    if (!Array.isArray(symbols)) {
        res.status(400).json({ error: 'Array of symbols required' });
        return;
    }
    try {
        // API bulk loads default to bypassing validation to allow cross-domain/external links
        await domainService.bulkUpsert(req.params.id, symbols, { bypassValidation: true });
        res.json({ status: 'success', count: symbols.length });
    } catch (e: any) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e?.message || e });
        if (isReadOnlyError(e)) {
            res.status(400).json(buildReadOnlyResponse(e));
        } else {
            res.status(500).json({ 
                error: e?.message || String(e),
                details: typeof e === 'object' ? JSON.stringify(e, Object.getOwnPropertyNames(e)) : undefined
            });
        }
    }
});

// Delete symbol
app.delete('/api/domains/:domainId/symbols/:symbolId', async (req, res) => {
    const { cascade } = req.query;
    try {
        await domainService.deleteSymbol(req.params.domainId, req.params.symbolId, cascade === 'true');
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Rename symbol (Internal propagation)
app.post('/api/domains/:domainId/symbols/rename', async (req, res) => {
    const { oldId, newId } = req.body;
    if (!oldId || !newId) {
        res.status(400).json({ error: 'oldId and newId required' });
        return;
    }
    try {
        await domainService.propagateRename(req.params.domainId, oldId, newId);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// --- Test Management ---

// List Test Sets
app.get('/api/tests/sets', async (req, res) => {
    try {
        const sets = await testService.listTestSets();
        res.json(sets);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Create/Update Test Set
app.post('/api/tests/sets', async (req, res) => {
    const testSet = req.body;
    const hasValidTests = Array.isArray(testSet.tests) && testSet.tests.every((t: any) => typeof t.prompt === 'string' && typeof t.name === 'string' && Array.isArray(t.expectedActivations));
    if (!testSet.name || !hasValidTests) {
        res.status(400).json({ error: 'Invalid test set format' });
        return;
    }
    try {
        await testService.createOrUpdateTestSet(testSet);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Delete Test Set
app.delete('/api/tests/sets/:id', async (req, res) => {
    try {
        await testService.deleteTestSet(req.params.id);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Start Test Run
app.post('/api/tests/runs', async (req, res) => {
    const { testSetId, compareWithBaseModel } = req.body;
    if (!testSetId) {
        res.status(400).json({ error: 'testSetId is required' });
        return;
    }

    try {
        // We inject the runner logic here to resolve circular dependencies
        const runnerFn = async (prompt: string) => {
            const toolExecutor = createToolExecutor(() => settingsService.getApiKey());
            return await runSignalZeroTest(prompt, toolExecutor, [], activeSystemPrompt);
        };

        const run = await testService.startTestRun(testSetId, runnerFn, compareWithBaseModel === true);
        res.json({ status: 'started', runId: run.id });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Stop Test Run
app.post('/api/tests/runs/:runId/stop', async (req, res) => {
    try {
        await testService.stopTestRun(req.params.runId);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Resume Test Run
app.post('/api/tests/runs/:runId/resume', async (req, res) => {
    try {
        // Reinject runner
        const runnerFn = async (prompt: string) => {
            const toolExecutor = createToolExecutor(() => settingsService.getApiKey());
            return await runSignalZeroTest(prompt, toolExecutor, [], activeSystemPrompt);
        };

        const run = await testService.resumeTestRun(req.params.runId, runnerFn);
        res.json({ status: 'resumed', runId: run.id });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Rerun Single Test Case
app.post('/api/tests/runs/:runId/cases/:caseId/rerun', async (req, res) => {
    try {
        const runnerFn = async (prompt: string) => {
            const toolExecutor = createToolExecutor(() => settingsService.getApiKey());
            return await runSignalZeroTest(prompt, toolExecutor, [], activeSystemPrompt);
        };

        const result = await testService.rerunTestCase(req.params.runId, req.params.caseId, runnerFn);
        res.json({ status: 'success', result });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Delete Test Run
app.delete('/api/tests/runs/:runId', async (req, res) => {
    try {
        await testService.deleteTestRun(req.params.runId);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Add Test to Set
app.post('/api/tests', async (req, res) => {
    const { testSetId, name, prompt, expectedActivations } = req.body;
    if (!testSetId || !name || !prompt || !Array.isArray(expectedActivations)) {
        res.status(400).json({ error: 'testSetId, name, prompt, and expectedActivations are required' });
        return;
    }

    try {
        await testService.addTest(testSetId, prompt, expectedActivations, name);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Delete Test from Set
app.delete('/api/tests/:testSetId/:testId', async (req, res) => {
    const { testSetId, testId } = req.params;
    try {
        await testService.deleteTest(testSetId, testId);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// List Test Runs
app.get('/api/tests/runs', async (req, res) => {
    try {
        const runs = await testService.listTestRuns();
        res.json(runs);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Get Test Run Details
app.get('/api/tests/runs/:id', async (req, res) => {
    try {
        const excludeResults = req.query.excludeResults === 'true';
        const run = await testService.getTestRun(req.params.id, excludeResults);
        if (run) {
            res.json(run);
            return;
        }

        res.json({ results: [] });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Get Paginated Test Run Results
app.get('/api/tests/runs/:runId/results', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit as string || '50', 10);
        const offset = parseInt(req.query.offset as string || '0', 10);
        const status = req.query.status as string | undefined;
        
        const result = await testService.getTestRunResults(req.params.runId, limit, offset, status);
        res.json(result);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});


// --- Project Management ---

// Export Project (Get Current Project State)
app.post('/api/project/export', async (req, res) => {
    const { meta } = req.body;
    const projectMeta: ProjectMeta = meta || {
        name: "SignalZero Project",
        version: "1.0.0",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        author: "System"
    };

    try {
        const blob = await projectService.export(projectMeta, activeSystemPrompt);
        const arrayBuffer = await blob.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="project.szproject"');
        res.send(buffer);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Import Project (Load Project)
app.post('/api/project/import', async (req, res) => {
    const { data } = req.body; // Expecting base64 string
    console.log(`[DirectLog] Project import request received. Data length: ${data ? data.length : 'undefined'}`);

    if (!data) {
        res.status(400).json({ error: 'data (base64) required' });
        return;
    }

    try {
        const buffer = Buffer.from(data, 'base64');
        const result = await projectService.import(buffer);
        
        // Update active system prompt
        if (result.systemPrompt) {
            activeSystemPrompt = result.systemPrompt;
            await systemPromptService.setPrompt(result.systemPrompt);
            resetChatSession();
        }

        res.json({ status: 'success', stats: result.stats });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Active Project Metadata
app.get('/api/project/active', async (req, res) => {
    try {
        const meta = await projectService.getActiveProjectMeta();
        res.json({ meta });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Update Active Project Metadata
app.post('/api/project/active', async (req, res) => {
    const { meta } = req.body;

    const requiredFields: (keyof ProjectMeta)[] = ['name', 'version', 'created_at', 'updated_at', 'author'];
    const missingField = requiredFields.find(field => !meta || typeof meta[field] !== 'string');

    if (missingField) {
        res.status(400).json({ error: `${missingField} is required and must be a string` });
        return;
    }

    try {
        await projectService.setActiveProjectMeta(meta);
        res.json({ status: 'success', meta });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Trace Endpoint
app.get('/api/traces', async (req, res) => {
    try {
        const since = req.query.since ? parseInt(req.query.since as string, 10) : undefined;
        const traces = await traceService.getTraces(Number.isNaN(since) ? undefined : since);
        res.json(traces);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/traces/:id', async (req, res) => {
    try {
        const trace = await traceService.findById(req.params.id);
        if (trace) res.json(trace);
        else res.status(404).json({ error: 'Trace not found' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Agent Management
app.get('/api/agents', async (req, res) => {
    try {
        const agents = await agentService.listAgents();
        res.json({ agents });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/agents/logs', async (req, res) => {
    const { agentId, limit, includeTraces } = req.query;
    try {
        const logs = await agentService.getExecutionLogs(
            agentId as string,
            limit ? Number(limit) : 20,
            includeTraces === 'true'
        );
        res.json({ logs });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/agents/:id', async (req, res) => {
    try {
        const agent = await agentService.getAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        res.json(agent);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.post('/api/agents', async (req, res) => {
    const { id, schedule, prompt, enabled } = req.body;
    if (!id || !prompt) {
        res.status(400).json({ error: 'id and prompt are required' });
        return;
    }
    try {
        const agent = await agentService.upsertAgent(id, prompt, enabled ?? true, schedule);
        res.json(agent);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.put('/api/agents/:id', async (req, res) => {
    const { schedule, prompt, enabled } = req.body;
    const { id } = req.params;
    if (!prompt) {
        res.status(400).json({ error: 'prompt is required' });
        return;
    }
    try {
        const agent = await agentService.upsertAgent(id, prompt, enabled ?? true, schedule);
        res.json(agent);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.delete('/api/agents/:id', async (req, res) => {
    try {
        await agentService.deleteAgent(req.params.id);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Trigger Agent Execution (Message Injection)
app.post('/api/agents/:id/trigger', async (req, res) => {
    const { id } = req.params;
    const { message } = req.body;
    try {
        // executeAgent handles context creation and execution logic
        await agentService.executeAgent(id, message);
        res.json({ status: 'triggered' });
    } catch (e) {
        loggerService.error(`Error triggering agent ${id}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Voice Service Control
app.get('/api/voice/mic/status', async (req, res) => {
    try {
        const resp = await fetch('http://voiceservice:8000/mic/status');
        const data = await resp.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Voice service unreachable' });
    }
});

app.post('/api/voice/mic/toggle', async (req, res) => {
    try {
        const { enabled } = req.body;
        const endpoint = enabled ? 'on' : 'off';
        const resp = await fetch(`http://voiceservice:8000/mic/${endpoint}`, { method: 'POST' });
        const data = await resp.json();
        res.json({ enabled });
    } catch (e) {
        res.status(500).json({ error: 'Voice service unreachable' });
    }
});

app.get('/api/voice/story/status', async (req, res) => {
    try {
        const resp = await fetch('http://voiceservice:8000/story/status');
        const data = await resp.json();
        res.json(data);
    } catch (e) {
        res.status(500).json({ error: 'Voice service unreachable' });
    }
});

app.post('/api/voice/story/toggle', async (req, res) => {
    try {
        const { enabled } = req.body;
        const endpoint = enabled ? 'on' : 'off';
        const resp = await fetch(`http://voiceservice:8000/story/${endpoint}`, { method: 'POST' });
        const data = await resp.json();
        res.json({ enabled });
    } catch (e) {
        res.status(500).json({ error: 'Voice service unreachable' });
    }
});

// --- User Management Routes ---

// List all users (admin only)
app.get('/api/users', async (req, res) => {
    try {
        // TODO: Add admin role check
        const users = await userService.listUsers();
        // Don't expose password hashes
        const safeUsers = users.map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            enabled: u.enabled,
            createdAt: u.createdAt,
            updatedAt: u.updatedAt
        }));
        res.json({ users: safeUsers });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Get current user info
app.get('/api/users/me', async (req, res) => {
    try {
        const authHeader = req.headers['authorization'] || req.headers['x-auth-token'];
        const token = typeof authHeader === 'string' ? authHeader.replace('Bearer ', '') : null;
        
        if (!token) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        
        const session = authService.verifySession(token);
        if (!session) {
            return res.status(401).json({ error: 'Invalid session' });
        }
        
        const user = await userService.getUser(session.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            enabled: user.enabled,
            apiKey: user.apiKey
        });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Create new user (admin only)
app.post('/api/users', async (req, res) => {
    const { username, password, role } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    try {
        // TODO: Add admin role check
        const user = await userService.createUser({ username, password, role });
        res.status(201).json({
            id: user.id,
            username: user.username,
            role: user.role,
            enabled: user.enabled,
            apiKey: user.apiKey
        });
    } catch (e: any) {
        if (e.message.includes('already exists')) {
            return res.status(409).json({ error: e.message });
        }
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Update user
app.patch('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;
    
    try {
        // TODO: Add ownership or admin role check
        const user = await userService.updateUser(id, updates);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({
            id: user.id,
            username: user.username,
            role: user.role,
            enabled: user.enabled,
            apiKey: user.apiKey
        });
    } catch (e: any) {
        if (e.message.includes('not found')) {
            return res.status(404).json({ error: e.message });
        }
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Delete user
app.delete('/api/users/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        // TODO: Add admin role check
        await userService.deleteUser(id);
        res.json({ status: 'success' });
    } catch (e: any) {
        if (e.message.includes('not found')) {
            return res.status(404).json({ error: e.message });
        }
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Regenerate API key
app.post('/api/users/:id/apikey', async (req, res) => {
    const { id } = req.params;
    
    try {
        // TODO: Add ownership or admin role check
        const apiKey = await userService.regenerateApiKey(id);
        res.json({ apiKey });
    } catch (e: any) {
        if (e.message.includes('not found')) {
            return res.status(404).json({ error: e.message });
        }
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// --- MCP Server Endpoints ---

// SSE endpoint for MCP
app.get('/mcp/sse', async (req, res) => {
    // Verify API key for MCP access
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) {
        return res.status(401).json({ error: 'API key required' });
    }
    
    const user = await userService.getUserByApiKey(apiKey);
    if (!user || !user.enabled) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const sessionId = randomUUID();
    
    // Send endpoint event
    res.write(`event: endpoint\n`);
    res.write(`data: /mcp/messages?sessionId=${sessionId}\n\n`);
    
    // Store session
    mcpSessions.set(sessionId, {
        userId: user.id,
        res,
        createdAt: Date.now()
    });
    
    loggerService.info(`MCP SSE connection established`, { sessionId, userId: user.id });
    
    // Clean up on disconnect
    req.on('close', () => {
        mcpSessions.delete(sessionId);
        loggerService.info(`MCP SSE connection closed`, { sessionId });
    });
});

// MCP message endpoint (JSON-RPC)
app.post('/mcp/messages', async (req, res) => {
    const { sessionId } = req.query;
    
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId required' });
    }
    
    const session = mcpSessions.get(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    
    const { jsonrpc, method, params, id } = req.body;
    
    if (jsonrpc !== '2.0') {
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id });
    }
    
    try {
        const result = await handleMCPMethod(method, params, session.userId);
        res.json({ jsonrpc: '2.0', result, id });
    } catch (e: any) {
        loggerService.error(`MCP method error`, { method, error: e });
        res.json({ jsonrpc: '2.0', error: { code: -32603, message: e.message || 'Internal error' }, id });
    }
});

// Global Error Handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    loggerService.error(`Unhandled Error: ${err.message}`, { stack: err.stack });
    if (!res.headersSent) {
        res.status(err.status || 500).json({ error: err.message || 'Internal Server Error' });
    }
});

export { app };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    app.listen(PORT, async () => {
        loggerService.info(`SignalZero Kernel Server running on port ${PORT}`);
        
        // Startup Health Check with retry
        loggerService.info("Performing startup health checks...");
        let redisHealth = false;
        for (let i = 0; i < 5; i++) {
            redisHealth = await domainService.healthCheck();
            if (redisHealth) break;
            loggerService.warn(`Redis health check retry ${i+1}/5...`);
            await new Promise(res => setTimeout(res, 1000));
        }

        if (redisHealth) {
            loggerService.info("Redis Connection: OK");
            
            // Initialize settings (migrate from file to Redis if needed)
            try {
                await settingsService.initialize();
                loggerService.info("Settings initialized");
            } catch (error) {
                loggerService.error("Failed to initialize settings", { error });
            }
            
            // Load persisted system prompt
            try {
                const prompt = await systemPromptService.loadPrompt(ACTIVATION_PROMPT);
                activeSystemPrompt = prompt;
                loggerService.info("System Prompt loaded from Redis");
            } catch (error) {
                loggerService.error("Failed to load system prompt during startup", { error });
            }
        } else {
            loggerService.error("Redis Connection: FAILED after retries");
        }

        const vectorHealth = await vectorService.healthCheck();
        if (vectorHealth) loggerService.info("Vector DB Connection: OK");
        else loggerService.error("Vector DB Connection: FAILED");

        // Cleanup hanging test runs
        try {
            loggerService.info("Cleaning up hanging test runs...");
            const cleanedRuns = await testService.cleanupActiveRuns();
            if (cleanedRuns > 0) {
                loggerService.info(`Marked ${cleanedRuns} hanging test run(s) as stopped.`);
            }
        } catch (error) {
            loggerService.error("Test run cleanup failed", { error });
        }

        // Run full registry migration/refactor (Lattice membership unification)
        try {
            loggerService.info("Running symbol registry migration check...");
            const domains = await domainService.listDomains();
            for (const d of domains) {
                // get() internally calls migrateSymbols and saves if modified
                await domainService.get(d);
            }
            loggerService.info("Registry migration check complete.");
        } catch (error) {
            loggerService.error("Registry migration failed", { error });
        }

        // Context Recovery: Retry contexts that were active when service died
        try {
            loggerService.info("Cleaning up hanging test contexts...");
            const cleanedCount = await contextService.cleanupTestSessions();
            if (cleanedCount > 0) {
                loggerService.info(`Cleaned up ${cleanedCount} hanging test session(s).`);
            }

            loggerService.info("Checking for interrupted contexts requiring recovery...");
            const contexts = await contextService.listSessions();
            const pendingContexts = contexts.filter(c => c.activeMessageId && c.status === 'open');
            
            for (const ctx of pendingContexts) {
                const history = await contextService.getUnfilteredHistory(ctx.id);
                const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
                
                if (lastUserMsg) {
                    loggerService.info(`Recovering context ${ctx.id}. Retrying message ${ctx.activeMessageId}`);
                    const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), ctx.id);
                    // Use the original messageId from the lock to ensure idempotency/grouping on client
                    processMessageAsync(ctx.id, lastUserMsg.content, toolExecutor, activeSystemPrompt, ctx.activeMessageId || undefined);
                } else {
                    // No user message found to retry, clear the stale lock
                    loggerService.warn(`Context ${ctx.id} has activeMessageId but no user prompt in history. Clearing stale lock.`);
                    await contextService.clearActiveMessage(ctx.id);
                }
            }
            if (pendingContexts.length > 0) {
                loggerService.info(`Context recovery initiated for ${pendingContexts.length} session(s).`);
            } else {
                loggerService.info("No contexts required recovery.");
            }
        } catch (error) {
            loggerService.error("Context recovery failed", { error });
        }

        await agentService.startBackgroundThreads();
    });
}