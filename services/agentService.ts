import { randomUUID } from 'crypto';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs/promises';
import path from 'path';
import { ACTIVATION_PROMPT } from '../symbolic_system/activation_prompt.js';
import { AgentDefinition, AgentExecutionLog, TraceData } from '../types.js';
import { createToolExecutor } from './toolsService.js';
import { redisService } from './redisService.js';
import { loggerService } from './loggerService.js';
import { systemPromptService } from './systemPromptService.js';
import { createFreshChatSession, sendMessageAndHandleTools } from './inferenceService.js';
import { settingsService } from './settingsService.js';
import { traceService } from './traceService.js';
import { EXECUTION_ZSET_KEY, LOOP_INDEX_KEY, getExecutionKey, getLoopKey, getTraceKey } from './loopStorage.js';
import { contextService } from './contextService.js';
import { contextWindowService } from './contextWindowService.js';

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_WEEK_MS = 7 * 24 * ONE_HOUR_MS;
const AGENT_TOKEN_LIMIT = 500_000;

class AgentService {
    private scheduler: NodeJS.Timeout | null = null;
    private sweeper: NodeJS.Timeout | null = null;

    validateSchedule(schedule: string): Date {
        const interval = CronExpressionParser.parse(schedule);
        return interval.next().toDate();
    }

    private createAgentPayload(id: string, prompt: string, enabled: boolean, schedule?: string, existing?: AgentDefinition, userId?: string): AgentDefinition {
        const nowIso = new Date().toISOString();
        if (schedule) this.validateSchedule(schedule);

        return {
            id,
            userId: userId || existing?.userId,
            schedule,
            prompt,
            enabled,
            createdAt: existing?.createdAt || nowIso,
            updatedAt: nowIso,
            lastRunAt: existing?.lastRunAt,
        };
    }

    private async persistAgent(agent: AgentDefinition): Promise<void> {
        await redisService.request(['SADD', LOOP_INDEX_KEY, agent.id]);
        await redisService.request(['SET', getLoopKey(agent.id), JSON.stringify(agent)]);
    }

    async listAgents(): Promise<AgentDefinition[]> {
        const ids = await redisService.request(['SMEMBERS', LOOP_INDEX_KEY]);
        if (!Array.isArray(ids) || ids.length === 0) return [];

        const agents: AgentDefinition[] = [];
        for (const id of ids) {
            const stored = await redisService.request(['GET', getLoopKey(id)]);
            if (stored) {
                try {
                    agents.push(JSON.parse(stored));
                } catch (error) {
                    loggerService.error('AgentService: Failed to parse agent payload', { id, error });
                }
            }
        }
        return agents;
    }

    async getAgent(id: string): Promise<AgentDefinition | null> {
        const payload = await redisService.request(['GET', getLoopKey(id)]);
        if (!payload) return null;
        try {
            return JSON.parse(payload);
        } catch (error) {
            loggerService.error('AgentService: Failed to parse agent definition', { id, error });
            return null;
        }
    }

    async upsertAgent(id: string, prompt: string, enabled: boolean, schedule?: string, userId?: string): Promise<AgentDefinition> {
        const existing = await this.getAgent(id);
        const agent = this.createAgentPayload(id, prompt, enabled, schedule, existing || undefined, userId);

        await this.persistAgent(agent);
        loggerService.info('AgentService: Upserted agent', { id, enabled, schedule: schedule || 'event-driven', userId });
        return agent;
    }

    async deleteAgent(id: string): Promise<boolean> {
        await redisService.request(['SREM', LOOP_INDEX_KEY, id]);
        const removed = await redisService.request(['DEL', getLoopKey(id)]);
        loggerService.info('AgentService: Deleted agent', { id });
        return removed > 0;
    }

    async replaceAllAgents(agents: AgentDefinition[], userId?: string): Promise<void> {
        const ids = await redisService.request(['SMEMBERS', LOOP_INDEX_KEY]);
        if (Array.isArray(ids)) {
            for (const id of ids) {
                await this.deleteAgent(id);
            }
        }
        // Also clear executions
        await redisService.request(['DEL', EXECUTION_ZSET_KEY]);
        
        for (const agent of agents) {
            await this.upsertAgent(agent.id, agent.prompt, agent.enabled, agent.schedule, userId || agent.userId);
        }
    }

    private getNextRun(agent: AgentDefinition, reference: Date): Date | null {
        if (!agent.schedule) return null;
        try {
            const baseDate = agent.lastRunAt
                ? new Date(agent.lastRunAt)
                : agent.createdAt
                    ? new Date(agent.createdAt)
                    : reference;
            const interval = CronExpressionParser.parse(agent.schedule, { currentDate: baseDate });
            return interval.next().toDate();
        } catch (error) {
            loggerService.error('AgentService: Failed to compute next run', { agentId: agent.id, error });
            return null;
        }
    }

    private async updateLastRun(agent: AgentDefinition, timestamp: string): Promise<void> {
        const updated = { ...agent, lastRunAt: timestamp, updatedAt: timestamp };
        await redisService.request(['SET', getLoopKey(agent.id), JSON.stringify(updated)]);
    }

    private async persistExecution(execution: AgentExecutionLog, traces: TraceData[]): Promise<void> {
        await redisService.request(['SET', getExecutionKey(execution.id), JSON.stringify(execution)]);
        await redisService.request(['ZADD', EXECUTION_ZSET_KEY, Date.parse(execution.startedAt), execution.id]);
        await redisService.request(['SET', getTraceKey(execution.id), JSON.stringify(traces)]);
    }

    private async writeExecutionLogFile(executionId: string, payload: any): Promise<string> {
        const dir = path.join(process.cwd(), 'logs', 'agents');
        await fs.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `${executionId}.json`);
        await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
        return filePath;
    }

    private async captureNewTraces(existingIds: Set<string>): Promise<TraceData[]> {
        const traces = await traceService.getTraces();
        return (traces as TraceData[]).filter((trace) => !existingIds.has(trace.id));
    }

    private async getOrCreateAgentContext(agent: AgentDefinition): Promise<string> {
        const sessions = await contextService.listSessions(undefined, true);
        const existing = sessions.find(s => s.metadata?.agentId === agent.id && s.status === 'open');
        if (existing) return existing.id;
        
        const newSession = await contextService.createSession('agent', { agentId: agent.id }, `Agent: ${agent.id}`, undefined);
        return newSession.id;
    }

    private async checkTokenLimit(contextSessionId: string): Promise<void> {
        const window = await contextWindowService.constructContextWindow(contextSessionId, "");
        const totalTokens = window.reduce((sum, m) => sum + (m.content ? m.content.length / 4 : 0), 0);
        
        if (totalTokens > AGENT_TOKEN_LIMIT) {
            loggerService.warn(`AgentService: Token limit exceeded (${totalTokens} > ${AGENT_TOKEN_LIMIT}). Closing context.`, { contextSessionId });
            await contextService.closeSession(contextSessionId, undefined, true);
        }
    }

    async executeAgent(agentId: string, triggerMessage?: string): Promise<void> {
        const agent = await this.getAgent(agentId);
        if (!agent) return;

        if (!agent.enabled && !triggerMessage) return;

        const contextSessionId = await this.getOrCreateAgentContext(agent);
        
        // Ensure prompt is current in metadata
        await contextService.updateSessionMetadata(contextSessionId, { agentPrompt: agent.prompt }, undefined, true);

        if (triggerMessage) {
            await contextService.enqueueMessage(contextSessionId, {
                id: randomUUID(),
                role: 'user',
                content: triggerMessage,
                timestamp: new Date().toISOString(),
                metadata: { kind: 'external-trigger' }
            }, undefined, true);
        }

        if (await contextService.hasActiveMessage(contextSessionId, undefined, true)) {
            loggerService.info("Agent context busy, message queued.", { agentId, contextSessionId });
            return;
        }

        this.drainQueue(agentId, contextSessionId).catch(err => loggerService.error("Queue drain error", err));
    }

    private async drainQueue(agentId: string, contextSessionId: string): Promise<void> {
        const agent = await this.getAgent(agentId);
        if (!agent) return;

        const nextItem = await contextService.popNextMessage(contextSessionId, undefined, true);
        const inputMessage = nextItem?.message || (agent.schedule ? "Wake up and execute your scheduled task." : null);
        
        if (!inputMessage) return;

        const lockId = `agent-exec-${Date.now()}`;
        await contextService.setActiveMessage(contextSessionId, lockId, undefined, true);

        const executionId = `${agent.id}-${Date.now()}`;
        const startedAt = new Date().toISOString();
        const baselineTraces = await traceService.getTraces();
        const baselineTraceIds = new Set<string>(baselineTraces.map((t: TraceData) => t.id));
        
        loggerService.info('AgentService: Starting execution turn', { agentId: agent.id, executionId, contextSessionId });

        await this.updateLastRun(agent, startedAt);

        let logFilePath: string | undefined;
        let responseText = '';
        let traces: TraceData[] = [];
        let status: AgentExecutionLog['status'] = 'running';
        let errorMessage: string | undefined;

        try {
            const baseSystemPrompt = await systemPromptService.loadPrompt(ACTIVATION_PROMPT);
            const { loopModel } = await settingsService.getInferenceSettings();
            const chat = await createFreshChatSession(baseSystemPrompt, contextSessionId, loopModel);
            const toolExecutor = createToolExecutor(() => settingsService.getApiKey(), contextSessionId);
            
            const stream = sendMessageAndHandleTools(chat, inputMessage, toolExecutor, baseSystemPrompt, contextSessionId, lockId, agent.userId || undefined);
            const toolCalls: any[] = [];

            for await (const chunk of stream) {
                if (chunk.text) responseText += chunk.text;
                if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
            }

            traces = await this.captureNewTraces(baselineTraceIds);
            logFilePath = await this.writeExecutionLogFile(executionId, {
                agentId: agent.id,
                executionId,
                startedAt,
                prompt: agent.prompt,
                trigger: inputMessage,
                responseText,
                toolCalls,
                traces,
            });
            status = 'completed';
            await this.checkTokenLimit(contextSessionId);
        } catch (error: any) {
            status = 'failed';
            errorMessage = String(error);
            loggerService.error('AgentService: Turn failed', { agentId: agent.id, executionId, error });
        } finally {
            const finishedAt = new Date().toISOString();
            const executionLog: AgentExecutionLog = {
                id: executionId,
                agentId: agent.id,
                startedAt,
                finishedAt,
                status,
                traceCount: traces.length,
                logFilePath,
                responsePreview: responseText.slice(0, 500),
                error: errorMessage,
            };

            await this.persistExecution(executionLog, traces);
            await contextService.clearActiveMessage(contextSessionId, undefined, true);
            
            this.drainQueue(agentId, contextSessionId);
        }
    }

    private async schedulerTick() {
        try {
            const agents = (await this.listAgents()).filter((a) => a.enabled && a.schedule);
            const now = new Date();
            for (const agent of agents) {
                const nextRun = this.getNextRun(agent, now);
                if (nextRun && nextRun.getTime() <= now.getTime()) {
                    this.executeAgent(agent.id).catch(e => loggerService.error("Scheduled execution error", e));
                }
            }
        } catch (error: any) {
            loggerService.error('AgentService: Scheduler tick failed', { error });
        }
    }

    async startBackgroundThreads() {
        if (!this.scheduler) {
            loggerService.info('AgentService: Starting scheduler thread');
            this.scheduler = setInterval(() => this.schedulerTick(), ONE_MINUTE_MS);
        }
    }

    async getExecutionLogs(agentId?: string, limit: number = 20, includeTraces: boolean = false): Promise<(AgentExecutionLog & { traces?: TraceData[] })[]> {
        const ids: string[] = await redisService.request(['ZRANGEBYSCORE', EXECUTION_ZSET_KEY, '-inf', '+inf']);
        const ordered = Array.isArray(ids) ? ids.slice().reverse() : [];
        const results: (AgentExecutionLog & { traces?: TraceData[] })[] = [];
        for (const id of ordered) {
            if (results.length >= limit) break;
            const payload = await redisService.request(['GET', getExecutionKey(id)]);
            if (!payload) continue;
            try {
                const parsed = JSON.parse(payload);
                const recordAgentId = parsed.agentId || parsed.loopId;
                if (!agentId || recordAgentId === agentId) {
                    if (includeTraces) {
                        const tracePayload = await redisService.request(['GET', getTraceKey(id)]);
                        if (tracePayload) parsed.traces = JSON.parse(tracePayload);
                    }
                    results.push(parsed);
                }
            } catch (error) {}
        }
        return results;
    }
}

export const agentService = new AgentService();
