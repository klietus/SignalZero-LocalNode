import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { getChatSession, resetChatSession, sendMessageAndHandleTools, runSignalZeroTest, processMessageAsync } from './services/inferenceService.js';
import { createToolExecutor, toolDeclarations } from './services/toolsService.js';
import { settingsService } from './services/settingsService.js';
import { ACTIVATION_PROMPT } from './symbolic_system/activation_prompt.js';
import { domainService, ReadOnlyDomainError } from './services/domainService.js';
import { traceService } from './services/traceService.js';
import { projectService } from './services/projectService.js';
import { testService } from './services/testService.js';
import { ProjectMeta } from './types.js';
import { loggerService } from './services/loggerService.js';
import { systemPromptService } from './services/systemPromptService.js';
import { mcpPromptService } from './services/mcpPromptService.js';
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
const mcpSessions = new Map<string, { userId: string; userRole: string; res: express.Response; createdAt: number }>();

// MCP Method Handler
async function handleMCPMethod(method: string, params: any, userId: string, userRole: string): Promise<any> {
    switch (method) {
        case 'initialize':
            return {
                protocolVersion: '2024-11-05',
                capabilities: {
                    tools: {},
                    resources: {},
                    prompts: {}
                },
                serverInfo: {
                    name: 'signalzero-mcp',
                    version: '1.0.0'
                }
            };

        case 'prompts/list':
            return {
                prompts: activeMcpPrompt ? [
                    {
                        name: 'project-prompt',
                        description: 'Custom MCP prompt for this project',
                        arguments: []
                    }
                ] : []
            };

        case 'prompts/get':
            if (params.name === 'project-prompt' && activeMcpPrompt) {
                return {
                    description: 'Custom MCP prompt for this project',
                    messages: [
                        {
                            role: 'user',
                            content: {
                                type: 'text',
                                text: activeMcpPrompt
                            }
                        }
                    ]
                };
            }
            throw new Error(`Prompt not found: ${params.name}`);

        case 'tools/list':
            const restrictedTools = [
                'list_secrets', 'store_secret', 'get_secret',
                'upsert_agent', 'list_agents', 'list_agent_executions', 'send_agent_message', 'list_agent_contexts',
                'sys_exec', 'speak', 'send_user_message',
                'list_test_runs', 'list_test_failures',
                'write_file', 'web_fetch', 'web_search', 'web_post', 'symbol_transaction'
            ];
            const adminOnlyTools = ['upsert_symbols', 'delete_symbols', 'create_domain'];
            const isAdmin = userRole === 'admin';

            return {
                tools: toolDeclarations
                    .filter(t => !restrictedTools.includes(t.function.name))
                    .filter(t => isAdmin || !adminOnlyTools.includes(t.function.name))
                    .map(t => ({
                        name: t.function.name,
                        description: t.function.description,
                        inputSchema: t.function.parameters
                    }))
            };

        case 'tools/call': {
            const { name, arguments: toolArgs } = params;
            const restrictedTools = [
                'list_secrets', 'store_secret', 'get_secret',
                'upsert_agent', 'list_agents', 'list_agent_executions', 'send_agent_message', 'list_agent_contexts',
                'sys_exec', 'speak', 'send_user_message',
                'list_test_runs', 'list_test_failures',
                'write_file', 'web_fetch', 'web_search', 'web_post', 'symbol_transaction'
            ];
            const adminOnlyTools = ['upsert_symbols', 'delete_symbols', 'create_domain'];
            const isAdmin = userRole === 'admin';
            
            if (restrictedTools.includes(name)) {
                throw new Error(`Tool ${name} is restricted on this MCP server.`);
            }

            if (adminOnlyTools.includes(name) && !isAdmin) {
                throw new Error(`Tool ${name} requires admin privileges.`);
            }

            const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), undefined, userId, isAdmin);
            try {
                const result = await toolExecutor(name, toolArgs);
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2)
                        }
                    ]
                };
            } catch (error: any) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `Error executing tool ${name}: ${error.message}`
                        }
                    ],
                    isError: true
                };
            }
        }

        case 'notifications/initialized':
            return {};

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
        req.url.startsWith('/api/domains') ||
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
    
    const publicPaths = ['/api/health', '/api/auth/status', '/api/auth/setup', '/api/auth/login', '/mcp/sse', '/mcp/messages'];
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
            loggerService.debug(`requireAuth: Authenticated via API key for user ${authContext.userId}`);
            req.user = authContext;
            return next();
        }
    }

    // Check for Session Token
    const authHeader = req.headers['authorization'] || req.headers['x-auth-token'];
    const token = typeof authHeader === 'string' ? authHeader.replace('Bearer ', '') : null;

    if (token) {
        const authContext = await authService.verifySession(token);
        if (authContext) {
            const isPolling = req.method === 'GET' && (
                req.url.startsWith('/api/contexts') || 
                req.url.includes('/history') || 
                req.url.startsWith('/api/traces') ||
                req.url.startsWith('/api/domains') ||
                req.url === '/api/voice/mic/status' ||
                req.url === '/api/voice/story/status'
            );
            
            if (!isPolling) {
                loggerService.debug(`requireAuth: Authenticated via session token for user ${authContext.userId}, role: ${authContext.role}`);
            }
            req.user = authContext;
            return next();
        } else {
            loggerService.warn(`requireAuth: Invalid session token provided`);
        }
    }

    loggerService.warn(`requireAuth: Unauthorized request to ${req.path}`);
    res.status(401).json({ error: 'Unauthorized' });
};

app.use(requireAuth);

// Auth Routes
app.get('/api/auth/status', async (req, res) => {
    const token = (req.headers['x-auth-token'] as string) || '';
    const session = token ? await authService.verifySession(token) : null;
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

// Regenerate API key
app.post('/api/users/:id/apikey', async (req: AuthenticatedRequest, res) => {
    try {
        if (!req.user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        // Users can regenerate their own, admins can regenerate anyone's
        if (req.user.role !== 'admin' && req.user.userId !== req.params.id) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const apiKey = await userService.regenerateApiKey(req.params.id);
        res.json({ apiKey });
    } catch (e: any) {
        loggerService.error('Error regenerating API key', { error: e });
        res.status(400).json({ error: e.message || String(e) });
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
export let activeSystemPrompt = ACTIVATION_PROMPT;
export let activeMcpPrompt = '';

export function resetActiveMcpPrompt() { activeMcpPrompt = ''; }
export function setActiveMcpPrompt(prompt: string) { activeMcpPrompt = prompt; }
export function resetActiveSystemPrompt() { activeSystemPrompt = ACTIVATION_PROMPT; }

// Chat Endpoint
app.post('/api/chat', async (req: AuthenticatedRequest, res) => {
  const { message, contextSessionId, messageId } = req.body;
  const userId = req.user?.userId;
  const isAdmin = req.user?.role === 'admin';

  if (!message) {
     res.status(400).json({ error: 'Message is required' });
     return;
  }

  if (!contextSessionId) {
      res.status(400).json({ error: 'Context session ID is required' });
      return;
  }

  try {
    // Get session with ownership check
    const contextSession = await contextService.getSession(contextSessionId, userId, isAdmin);
    if (!contextSession) {
        res.status(404).json({ error: 'Context session not found or access denied' });
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
    await contextService.setActiveMessage(contextSession.id, messageId || 'unknown', userId, isAdmin);

    const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), contextSession.id, userId, isAdmin);
    
    // Fire and forget
    processMessageAsync(contextSession.id, message, toolExecutor, activeSystemPrompt, messageId, userId);

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
app.post('/api/chat/stop', async (req: AuthenticatedRequest, res) => {
    const { contextSessionId } = req.body;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    
    if (!contextSessionId) {
        res.status(400).json({ error: 'Context session ID is required' });
        return;
    }
    try {
        await contextService.requestCancellation(contextSessionId, userId, isAdmin);
        loggerService.info("Cancellation requested for session", { contextSessionId });
        res.json({ status: 'cancellation_requested' });
    } catch (e) {
        loggerService.error("Failed to stop chat", { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Trigger Context Processing (Queue Drain)
app.post('/api/contexts/:id/trigger', async (req: AuthenticatedRequest, res) => {
    const { id } = req.params;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    
    try {
        // Verify access first
        const hasAccess = await contextService.canAccessSession(id, userId, isAdmin);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Access denied' });
        }
        
        if (!await contextService.hasActiveMessage(id, userId, isAdmin) && await contextService.hasQueuedMessages(id, userId, isAdmin)) {
            const nextItem = await contextService.popNextMessage(id, userId, isAdmin);
            if (nextItem) {
                loggerService.info(`Triggering queued message for ${id}`, { sourceId: nextItem.sourceId });
                const queueMsgId = `queued-${Date.now()}`;
                await contextService.setActiveMessage(id, queueMsgId, userId, isAdmin);
                
                const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), id, req.user?.userId, isAdmin);
                processMessageAsync(id, nextItem.message, toolExecutor, activeSystemPrompt, queueMsgId, userId);
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
app.post('/api/contexts/latest/assistant-message', async (req: AuthenticatedRequest, res) => {
    const { message } = req.body;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    
    try {
        const contexts = await contextService.listSessions(userId, isAdmin);
        const conversations = contexts
            .filter(c => c.type === 'conversation' && c.status === 'open')
            .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

        const latest = conversations[0];
        if (!latest) {
            res.status(404).json({ error: 'No active conversational context found' });
            return;
        }

        await contextService.appendHistory(latest.id, [{
            id: randomUUID(),
            role: 'model',
            content: message,
            timestamp: new Date().toISOString(),
            metadata: { kind: 'agent_update' }
        }], userId, isAdmin);

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

// MCP Prompt
app.get('/api/mcp/prompt', (req, res) => {
    res.json({ prompt: activeMcpPrompt });
});

app.post('/api/mcp/prompt', async (req, res) => {
    const { prompt } = req.body;
    // prompt can be empty string to clear it
    try {
        await mcpPromptService.setPrompt(prompt || '');
        activeMcpPrompt = prompt || '';
        res.json({ status: 'MCP prompt updated' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to persist MCP prompt' });
    }
});

// Context Sessions
app.get('/api/contexts', async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    
    try {
        const contexts = await contextService.listSessions(userId, isAdmin);
        res.json({ contexts });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to list contexts' });
    }
});

app.post('/api/contexts', async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    
    try {
        const type = req.body?.type || 'conversation';
        
        // Only admins can create agent/loop contexts
        if (type === 'agent' && !isAdmin) {
            return res.status(403).json({ error: 'Admin access required to create agent contexts' });
        }
        
        const session = await contextService.createSession(type, { source: 'api' }, undefined, userId);
        res.status(201).json(session);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to create context' });
    }
});

app.post('/api/contexts/:id/archive', async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    
    try {
        const session = await contextService.closeSession(req.params.id, userId, isAdmin);
        if (!session) {
            res.status(404).json({ error: 'Context not found or access denied' });
            return;
        }
        res.json(session);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to archive context' });
    }
});

app.get('/api/contexts/:id/history', async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    
    try {
        const session = await contextService.getSession(req.params.id, userId, isAdmin);
        if (!session) {
            res.status(404).json({ error: 'Context session not found or access denied' });
            return;
        }

        const history = await contextService.getHistoryGrouped(req.params.id, userId, isAdmin);
        res.json({ session, history });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to get context history' });
    }
});

// --- Domain Management ---

// List all domains (Metadata)
app.get('/api/domains', async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user?.userId;
        const domains = await domainService.getMetadata(userId);
        res.json(domains);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Create domain
app.post('/api/domains', async (req: AuthenticatedRequest, res) => {
    const { id, name, description, invariants } = req.body;
    if (!id) {
        res.status(400).json({ error: 'id is required' });
        return;
    }
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        await domainService.createDomain(id, { name, description, invariants }, userId, isAdmin);
        res.json({ status: 'success', id });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Check domain existence
app.get('/api/domains/:id/exists', async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user?.userId;
        const exists = await domainService.hasDomain(req.params.id, userId);
        res.json({ exists });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Check domain enabled status
app.get('/api/domains/:id/enabled', async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user?.userId;
        const enabled = await domainService.isEnabled(req.params.id, userId);
        res.json({ enabled });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Toggle domain enabled status
app.post('/api/domains/:id/toggle', async (req: AuthenticatedRequest, res) => {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled boolean is required' });
        return;
    }
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        await domainService.toggleDomain(req.params.id, enabled, userId, isAdmin);
        res.json({ status: 'success', domainId: req.params.id, enabled });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Update domain metadata
app.patch('/api/domains/:id', async (req: AuthenticatedRequest, res) => {
    const { name, description, invariants } = req.body;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        await domainService.updateDomainMetadata(req.params.id, { name, description, invariants }, userId, isAdmin);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Delete domain
app.delete('/api/domains/:id', async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        await domainService.deleteDomain(req.params.id, userId, isAdmin);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Clear ALL domains
app.post('/api/admin/clear-all', async (req: AuthenticatedRequest, res) => {
    if (req.user?.role !== 'admin') {
        res.status(403).json({ error: 'Admin only' });
        return;
    }
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
app.get('/api/symbols/search', async (req: AuthenticatedRequest, res) => {
    const { q, limit, time_gte, time_between } = req.query;
    const userId = req.user?.userId;
    if (!q && !time_gte && !time_between) {
        res.status(400).json({ error: 'Provide a query or time filter (time_gte or time_between) to search symbols.' });
        return;
    }
    try {
        const results = await domainService.search(q as string | null, userId, {
            limit: limit ? Number(limit) : 5,
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
app.get('/api/symbols/:id', async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user?.userId;
        const symbol = await domainService.findById(req.params.id, userId);
        if (symbol) res.json(symbol);
        else res.status(404).json({ error: 'Symbol not found' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Get all symbols in domain
app.get('/api/domains/:id/symbols', async (req: AuthenticatedRequest, res) => {
    try {
        const userId = req.user?.userId;
        const symbols = await domainService.getSymbols(req.params.id, userId);
        res.json(symbols);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Query/Filter symbols in domain
app.get('/api/domains/:id/query', async (req: AuthenticatedRequest, res) => {
    const { tag, limit, lastId } = req.query;
    const userId = req.user?.userId;
    try {
        const result = await domainService.query(
            req.params.id,
            userId,
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
app.post('/api/domains/:id/symbols', async (req: AuthenticatedRequest, res) => {
    const symbol = req.body;
    if (!symbol || !symbol.id) {
        res.status(400).json({ error: 'Valid symbol object with id is required' });
        return;
    }
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        await domainService.upsertSymbol(req.params.id, symbol, userId, isAdmin);
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
app.post('/api/domains/:id/symbols/bulk', async (req: AuthenticatedRequest, res) => {
    const symbols = req.body;
    if (!Array.isArray(symbols)) {
        res.status(400).json({ error: 'Array of symbols required' });
        return;
    }
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        // API bulk loads default to bypassing validation to allow cross-domain/external links
        await domainService.bulkUpsert(req.params.id, symbols, { userId, isAdmin });
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
app.delete('/api/domains/:domainId/symbols/:symbolId', async (req: AuthenticatedRequest, res) => {
    const { cascade } = req.query;
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        await domainService.deleteSymbol(req.params.domainId, req.params.symbolId, userId, isAdmin);
        res.json({ status: 'success' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Rename symbol (Internal propagation)
app.post('/api/domains/:domainId/symbols/rename', async (req: AuthenticatedRequest, res) => {
    const { oldId, newId } = req.body;
    if (!oldId || !newId) {
        res.status(400).json({ error: 'oldId and newId required' });
        return;
    }
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        await domainService.propagateRename(req.params.domainId, oldId, newId, userId, isAdmin);
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
app.post('/api/tests/runs', async (req: AuthenticatedRequest, res) => {
    const { testSetId, compareWithBaseModel } = req.body;
    if (!testSetId) {
        res.status(400).json({ error: 'testSetId is required' });
        return;
    }

    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        // We inject the runner logic here to resolve circular dependencies
        const runnerFn = async (prompt: string) => {
            const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), undefined, userId, isAdmin);
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
app.post('/api/tests/runs/:runId/resume', async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        // Reinject runner
        const runnerFn = async (prompt: string) => {
            const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), undefined, userId, isAdmin);
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
app.post('/api/tests/runs/:runId/cases/:caseId/rerun', async (req: AuthenticatedRequest, res) => {
    const userId = req.user?.userId;
    const isAdmin = req.user?.role === 'admin';
    try {
        const runnerFn = async (prompt: string) => {
            const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), undefined, userId, isAdmin);
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
        const blob = await projectService.export(projectMeta, activeSystemPrompt, activeMcpPrompt);
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

        // Update active MCP prompt
        if (result.mcpPrompt !== undefined) {
            activeMcpPrompt = result.mcpPrompt;
            await mcpPromptService.setPrompt(result.mcpPrompt);
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

app.post('/api/agents', async (req: AuthenticatedRequest, res) => {
    const { id, schedule, prompt, enabled } = req.body;
    const userId = req.user?.userId;
    if (!id || !prompt) {
        res.status(400).json({ error: 'id and prompt are required' });
        return;
    }
    try {
        const agent = await agentService.upsertAgent(id, prompt, enabled ?? true, schedule, userId);
        res.json(agent);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.put('/api/agents/:id', async (req: AuthenticatedRequest, res) => {
    const { schedule, prompt, enabled } = req.body;
    const { id } = req.params;
    const userId = req.user?.userId;
    if (!prompt) {
        res.status(400).json({ error: 'prompt is required' });
        return;
    }
    try {
        const agent = await agentService.upsertAgent(id, prompt, enabled ?? true, schedule, userId);
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

// --- MCP Server Endpoints ---

// SSE endpoint for MCP
app.get('/mcp/sse', async (req, res) => {
    // Verify API key for MCP access
    const apiKey = req.headers['x-api-key'] as string;
    loggerService.info(`MCP: Incoming SSE connection attempt`, { 
        hasApiKey: !!apiKey,
        userAgent: req.headers['user-agent']
    });
    
    if (!apiKey) {
        loggerService.warn(`MCP: SSE connection attempt missing API key`);
        return res.status(401).json({ error: 'API key required' });
    }
    
    const user = await userService.getUserByApiKey(apiKey);
    if (!user || !user.enabled) {
        loggerService.warn(`MCP: SSE connection attempt with invalid API key`, { apiKey: apiKey.substring(0, 8) + '...' });
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const sessionId = randomUUID();
    
    // Send endpoint event with absolute URL
    const protocol = req.protocol;
    const host = req.get('host');
    const endpointUrl = `${protocol}://${host}/mcp/messages?sessionId=${sessionId}`;
    
    loggerService.info(`MCP: Establishing SSE stream`, { sessionId, endpointUrl });
    
    res.write(`event: endpoint\n`);
    res.write(`data: ${endpointUrl}\n\n`);
    
    // Store session
    mcpSessions.set(sessionId, {
        userId: user.id,
        userRole: user.role,
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

// Fallback for clients that POST to the SSE endpoint directly
app.post('/mcp/sse', async (req: AuthenticatedRequest, res) => {
    // Verify API key
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    const user = await userService.getUserByApiKey(apiKey);
    if (!user || !user.enabled) return res.status(401).json({ error: 'Invalid API key' });

    const { jsonrpc, method, params, id } = req.body;
    loggerService.debug(`MCP: Received POST to SSE endpoint`, { method, id });
    
    try {
        const result = await handleMCPMethod(method, params, user.id, user.role);
        return res.json({ jsonrpc: '2.0', result, id });
    } catch (e: any) {
        // Some methods like notifications/initialized might not return a result
        if (method.startsWith('notifications/')) {
            return res.json({ jsonrpc: '2.0', result: {} });
        }
        return res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message }, id });
    }
});

// MCP message endpoint (JSON-RPC)
app.post('/mcp/messages', async (req: AuthenticatedRequest, res) => {
    // Verify API key
    const apiKey = req.headers['x-api-key'] as string;
    if (!apiKey) return res.status(401).json({ error: 'API key required' });
    const user = await userService.getUserByApiKey(apiKey);
    if (!user || !user.enabled) return res.status(401).json({ error: 'Invalid API key' });

    const { sessionId } = req.query;
    
    if (!sessionId || typeof sessionId !== 'string') {
        return res.status(400).json({ error: 'sessionId required' });
    }
    
    const session = mcpSessions.get(sessionId);
    if (!session) {
        loggerService.warn(`MCP: Session ${sessionId} not found`);
        return res.status(404).json({ error: 'Session not found' });
    }
    
    const { jsonrpc, method, params, id } = req.body;
    loggerService.debug(`MCP: Received message`, { method, id, sessionId });
    
    if (jsonrpc !== '2.0') {
        return res.status(400).json({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id });
    }
    
    try {
        const result = await handleMCPMethod(method, params, session.userId, session.userRole);
        loggerService.debug(`MCP: Sending result`, { method, id, sessionId });
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
                
                // Initialize/Ensure admin user
                await userService.initializeDefaultAdmin();
                loggerService.info("User system checked/initialized");
            } catch (error) {
                loggerService.error("Failed to initialize settings/users", { error });
            }
            
            // Load persisted system prompt
            try {
                const prompt = await systemPromptService.loadPrompt(ACTIVATION_PROMPT);
                activeSystemPrompt = prompt;
                loggerService.info("System Prompt loaded from Redis");
            } catch (error) {
                loggerService.error("Failed to load system prompt during startup", { error });
            }

            // Load persisted MCP prompt
            try {
                const prompt = await mcpPromptService.loadPrompt('');
                activeMcpPrompt = prompt;
                loggerService.info("MCP Prompt loaded from Redis");
            } catch (error) {
                loggerService.error("Failed to load MCP prompt during startup", { error });
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
            // System-level recovery - pass undefined userId and true for isAdmin to see all contexts
            const contexts = await contextService.listSessions(undefined, true);
            const pendingContexts = contexts.filter(c => c.activeMessageId && c.status === 'open');
            
            for (const ctx of pendingContexts) {
                // Get history as system/admin
                const history = await contextService.getUnfilteredHistory(ctx.id, undefined, true);
                const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
                
                if (lastUserMsg) {
                    loggerService.info(`Recovering context ${ctx.id}. Retrying message ${ctx.activeMessageId}`);
                    // Check if the user who owns this context is an admin
                    let isContextAdmin = false;
                    if (ctx.userId) {
                        const contextUser = await userService.getUserById(ctx.userId);
                        isContextAdmin = contextUser?.role === 'admin';
                    }
                    const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), ctx.id, ctx.userId || undefined, isContextAdmin);
                    // Use the original messageId from the lock to ensure idempotency/grouping on client
                    processMessageAsync(ctx.id, lastUserMsg.content, toolExecutor, activeSystemPrompt, ctx.activeMessageId || undefined, ctx.userId || undefined);
                } else {
                    // No user message found to retry, clear the stale lock
                    loggerService.warn(`Context ${ctx.id} has activeMessageId but no user prompt in history. Clearing stale lock.`);
                    await contextService.clearActiveMessage(ctx.id, undefined, true);
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