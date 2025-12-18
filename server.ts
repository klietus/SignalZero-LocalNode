import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs';
import { getChatSession, resetChatSession, sendMessageAndHandleTools, runSignalZeroTest } from './services/inferenceService.js';
import { createToolExecutor } from './services/toolsService.js';
import { settingsService } from './services/settingsService.js';
import { ACTIVATION_PROMPT } from './symbolic_system/activation_prompt.js';
import { domainService } from './services/domainService.js';
import { traceService } from './services/traceService.js';
import { projectService } from './services/projectService.js';
import { testService } from './services/testService.js';
import { ProjectMeta } from './types.js';
import { loggerService } from './services/loggerService.js';
import { systemPromptService } from './services/systemPromptService.js';
import { fileURLToPath } from 'url';
import { loopService } from './services/loopService.js';

import { vectorService } from './services/vectorService.js';
import { indexingService } from './services/indexingService.js';

dotenv.config();

const app = express();
// @ts-ignore
app.use(cors());
// @ts-ignore
app.use(express.json({ limit: '50mb' }));

// Request Logging Middleware
app.use((req, res, next) => {
    loggerService.info(`Request: ${req.method} ${req.url}`, {
        query: req.query,
        body: req.method === 'POST' || req.method === 'PATCH' ? req.body : undefined
    });
    next();
});

const PORT = process.env.PORT || 3001;

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
app.get('/api/settings', (req, res) => {
    try {
        const settings = settingsService.getSystemSettings();
        res.json(settings);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

app.post('/api/settings', (req, res) => {
    try {
        const { redis, chroma, geminiKey } = req.body || {};
        settingsService.setSystemSettings({ redis, chroma, geminiKey });
        const updated = settingsService.getSystemSettings();
        res.json(updated);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: 'Failed to update settings' });
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

// Load persisted system prompt if available
systemPromptService.loadPrompt(ACTIVATION_PROMPT)
    .then((prompt) => { activeSystemPrompt = prompt; })
    .catch((error) => loggerService.error('Failed to load system prompt', { error }));

// Chat Endpoint
app.post('/api/chat', async (req, res) => {
  const { message } = req.body;

  if (!message) {
     res.status(400).json({ error: 'Message is required' });
     return;
  }

  try {
    const chat = getChatSession(activeSystemPrompt);
    const toolExecutor = createToolExecutor(() => settingsService.getApiKey());
    
    // Use the streaming helper but collect the full response for the HTTP response
    const stream = sendMessageAndHandleTools(chat, message, toolExecutor, activeSystemPrompt);
    
    let fullResponseText = "";
    let toolCalls: any[] = [];

    for await (const chunk of stream) {
        if (chunk.text) fullResponseText += chunk.text;
        if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
    }

    res.json({
        role: 'model',
        content: fullResponseText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined
    });

  } catch (error) {
    loggerService.error("Chat Error", { error });
    res.status(500).json({ error: String(error) });
  }
});

// Reset Chat
app.post('/api/chat/reset', (req, res) => {
    resetChatSession();
    traceService.clear();
    res.json({ status: 'Chat session reset' });
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
        res.status(500).json({ error: String(e) });
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
        res.status(500).json({ error: String(e) });
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
        res.status(500).json({ error: String(e) });
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
        await domainService.bulkUpsert(req.params.id, symbols);
        res.json({ status: 'success', count: symbols.length });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
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
        const run = await testService.getTestRun(req.params.id);
        if (run) {
            res.json(run);
            return;
        }

        // Return an empty result set instead of a 404 to keep the response shape predictable
        res.json({ results: [] });
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
app.get('/api/traces', (req, res) => {
    res.json(traceService.getTraces());
});

// Loop Management
app.get('/api/loops', async (req, res) => {
    try {
        const loops = await loopService.listLoops();
        res.json({ loops });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Place this before the /:id route to avoid being captured by the dynamic segment
app.get('/api/loops/logs', async (req, res) => {
    try {
        const limit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : undefined;
        const includeTraces = req.query.includeTraces === 'true';
        const logs = await loopService.getExecutionLogs(
            typeof req.query.loopId === 'string' ? req.query.loopId : undefined,
            Number.isFinite(limit) ? limit : 20,
            includeTraces
        );
        res.json({ logs });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.get('/api/loops/:id', async (req, res) => {
    try {
        const loop = await loopService.getLoop(req.params.id);
        if (!loop) {
            res.status(404).json({ error: 'Loop not found' });
            return;
        }
        res.json(loop);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

app.put('/api/loops/:id', async (req, res) => {
    const { schedule, prompt, enabled } = req.body || {};

    if (typeof schedule !== 'string' || typeof prompt !== 'string' || typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'schedule (string), prompt (string), and enabled (boolean) are required' });
        return;
    }

    try {
        loopService.validateSchedule(schedule);
        const loop = await loopService.upsertLoop(req.params.id, schedule, prompt, enabled);
        res.json(loop);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(400).json({ error: String(e) });
    }
});

app.delete('/api/loops/:id', async (req, res) => {
    try {
        const removed = await loopService.deleteLoop(req.params.id);
        res.json({ status: removed ? 'deleted' : 'not_found' });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

export { app };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    app.listen(PORT, async () => {
        loggerService.info(`SignalZero Kernel Server running on port ${PORT}`);
        
        // Startup Health Check
        loggerService.info("Performing startup health checks...");
        const redisHealth = await domainService.healthCheck();
        if (redisHealth) loggerService.info("Redis Connection: OK");
        else loggerService.error("Redis Connection: FAILED");

        const vectorHealth = await vectorService.healthCheck();
        if (vectorHealth) loggerService.info("Vector DB Connection: OK");
        else loggerService.error("Vector DB Connection: FAILED");

        await loopService.startBackgroundThreads();
    });
}