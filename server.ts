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
import { fileURLToPath } from 'url';

import { vectorService } from './services/vectorService.js';

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

// Initialize Chat
let activeSystemPrompt = ACTIVATION_PROMPT;

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
    const stream = sendMessageAndHandleTools(chat, message, toolExecutor);
    
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

app.post('/api/system/prompt', (req, res) => {
    const { prompt } = req.body;
    if (prompt) {
        activeSystemPrompt = prompt;
        resetChatSession();
        res.json({ status: 'System prompt updated' });
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
    const { q, limit } = req.query;
    if (!q) {
        res.status(400).json({ error: 'Query parameter q is required' });
        return;
    }
    try {
        const results = await domainService.search(q as string, limit ? Number(limit) : 5);
        res.json(results);
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
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
    if (!testSet.name || !Array.isArray(testSet.tests)) {
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
    const { testSetId } = req.body;
    if (!testSetId) {
        res.status(400).json({ error: 'testSetId is required' });
        return;
    }

    try {
        // We inject the runner logic here to resolve circular dependencies
        const runnerFn = async (prompt: string) => {
            const toolExecutor = createToolExecutor(() => settingsService.getApiKey());
            return await runSignalZeroTest(prompt, toolExecutor);
        };

        const run = await testService.startTestRun(testSetId, runnerFn);
        res.json({ status: 'started', runId: run.id });
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
        if (run) res.json(run);
        else res.status(404).json({ error: 'Run not found' });
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
            resetChatSession();
        }

        res.json({ status: 'success', stats: result.stats });
    } catch (e) {
        loggerService.error(`Error in ${req.method} ${req.url}`, { error: e });
        res.status(500).json({ error: String(e) });
    }
});

// Trace Endpoint
app.get('/api/traces', (req, res) => {
    res.json(traceService.getTraces());
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
    });
}