import { CronExpressionParser } from 'cron-parser';
import fs from 'fs/promises';
import path from 'path';
import { ACTIVATION_PROMPT } from '../symbolic_system/activation_prompt.ts';
import { LoopDefinition, LoopExecutionLog, TraceData } from '../types.ts';
import { createToolExecutor, toolDeclarations } from './toolsService.js';
import { redisService } from './redisService.js';
import { loggerService } from './loggerService.js';
import { systemPromptService } from './systemPromptService.js';
import { createFreshChatSession, sendMessageAndHandleTools } from './inferenceService.js';
import { settingsService } from './settingsService.js';
import { traceService } from './traceService.js';
import { EXECUTION_ZSET_KEY, LOOP_INDEX_KEY, getExecutionKey, getLoopKey, getTraceKey } from './loopStorage.js';
const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_WEEK_MS = 7 * 24 * ONE_HOUR_MS;

class LoopService {
    private scheduler: NodeJS.Timeout | null = null;
    private sweeper: NodeJS.Timeout | null = null;
    private executingLoops = new Set<string>();

    validateSchedule(schedule: string): Date {
        const interval = CronExpressionParser.parse(schedule);
        return interval.next().toDate();
    }

    private createLoopPayload(id: string, schedule: string, prompt: string, enabled: boolean, existing?: LoopDefinition): LoopDefinition {
        const nowIso = new Date().toISOString();
        this.validateSchedule(schedule);

        return {
            id,
            schedule,
            prompt,
            enabled,
            createdAt: existing?.createdAt || nowIso,
            updatedAt: nowIso,
            lastRunAt: existing?.lastRunAt,
        };
    }

    async listLoops(): Promise<LoopDefinition[]> {
        const ids = await redisService.request(['SMEMBERS', LOOP_INDEX_KEY]);
        if (!Array.isArray(ids) || ids.length === 0) return [];

        const loops: LoopDefinition[] = [];
        for (const id of ids) {
            const stored = await redisService.request(['GET', getLoopKey(id)]);
            if (stored) {
                try {
                    loops.push(JSON.parse(stored));
                } catch (error) {
                    loggerService.error('LoopService: Failed to parse loop payload', { id, error });
                }
            }
        }
        return loops;
    }

    async getLoop(id: string): Promise<LoopDefinition | null> {
        const payload = await redisService.request(['GET', getLoopKey(id)]);
        if (!payload) return null;
        try {
            return JSON.parse(payload);
        } catch (error) {
            loggerService.error('LoopService: Failed to parse loop definition', { id, error });
            return null;
        }
    }

    async upsertLoop(id: string, schedule: string, prompt: string, enabled: boolean): Promise<LoopDefinition> {
        const existing = await this.getLoop(id);
        const loop = this.createLoopPayload(id, schedule, prompt, enabled, existing || undefined);

        await redisService.request(['SADD', LOOP_INDEX_KEY, id]);
        await redisService.request(['SET', getLoopKey(id), JSON.stringify(loop)]);
        loggerService.info('LoopService: Upserted loop', { id, enabled, schedule });
        return loop;
    }

    async deleteLoop(id: string): Promise<boolean> {
        await redisService.request(['SREM', LOOP_INDEX_KEY, id]);
        const removed = await redisService.request(['DEL', getLoopKey(id)]);
        loggerService.info('LoopService: Deleted loop', { id });
        return removed > 0;
    }

    private getNextRun(loop: LoopDefinition, reference: Date): Date | null {
        try {
            const baseDate = loop.lastRunAt ? new Date(loop.lastRunAt) : reference;
            const interval = CronExpressionParser.parse(loop.schedule, { currentDate: baseDate });
            return interval.next().toDate();
        } catch (error) {
            loggerService.error('LoopService: Failed to compute next run', { loopId: loop.id, error });
            return null;
        }
    }

    private async updateLastRun(loop: LoopDefinition, timestamp: string): Promise<void> {
        const updated = { ...loop, lastRunAt: timestamp, updatedAt: timestamp };
        await redisService.request(['SET', getLoopKey(loop.id), JSON.stringify(updated)]);
    }

    private async persistExecution(execution: LoopExecutionLog, traces: TraceData[]): Promise<void> {
        await redisService.request(['SET', getExecutionKey(execution.id), JSON.stringify(execution)]);
        await redisService.request(['ZADD', EXECUTION_ZSET_KEY, Date.parse(execution.startedAt), execution.id]);
        await redisService.request(['SET', getTraceKey(execution.id), JSON.stringify(traces)]);
    }

    private async writeExecutionLogFile(executionId: string, payload: any): Promise<string> {
        const dir = path.join(process.cwd(), 'logs', 'loops');
        await fs.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `${executionId}.json`);
        await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
        return filePath;
    }

    private async buildSystemInstruction(prompt: string): Promise<string> {
        const basePrompt = await systemPromptService.loadPrompt(ACTIVATION_PROMPT);
        return `${basePrompt}\n\n[Loop Prompt]\n${prompt}`;
    }

    private captureNewTraces(existingIds: Set<string>): TraceData[] {
        const traces = traceService.getTraces();
        return traces.filter((trace) => !existingIds.has(trace.id));
    }

    private async executeLoop(loop: LoopDefinition): Promise<void> {
        if (this.executingLoops.has(loop.id)) {
            return;
        }

        this.executingLoops.add(loop.id);
        const executionId = `${loop.id}-${Date.now()}`;
        const startedAt = new Date().toISOString();
        const baselineTraceIds = new Set(traceService.getTraces().map((t) => t.id));
        loggerService.info('LoopService: Executing loop', { loopId: loop.id, executionId });

        await this.updateLastRun(loop, startedAt);

        let logFilePath: string | undefined;
        let responseText = '';
        let traces: TraceData[] = [];
        let status: LoopExecutionLog['status'] = 'running';
        let errorMessage: string | undefined;

        try {
            const systemInstruction = await this.buildSystemInstruction(loop.prompt);
            const chat = createFreshChatSession(systemInstruction);

            const toolExecutor = createToolExecutor(() => settingsService.getApiKey());
            const stream = sendMessageAndHandleTools(chat, loop.prompt, toolExecutor, systemInstruction);
            const toolCalls: any[] = [];

            for await (const chunk of stream) {
                if (chunk.text) responseText += chunk.text;
                if (chunk.toolCalls) toolCalls.push(...chunk.toolCalls);
            }

            traces = this.captureNewTraces(baselineTraceIds);
            logFilePath = await this.writeExecutionLogFile(executionId, {
                loopId: loop.id,
                executionId,
                startedAt,
                prompt: loop.prompt,
                systemInstruction,
                responseText,
                toolCalls,
                traces,
            });
            status = 'completed';
        } catch (error: any) {
            status = 'failed';
            errorMessage = String(error);
            loggerService.error('LoopService: Loop execution failed', { loopId: loop.id, executionId, error });
        } finally {
            const finishedAt = new Date().toISOString();
            const executionLog: LoopExecutionLog = {
                id: executionId,
                loopId: loop.id,
                startedAt,
                finishedAt,
                status,
                traceCount: traces.length,
                logFilePath,
                responsePreview: responseText.slice(0, 500),
                error: errorMessage,
            };

            await this.persistExecution(executionLog, traces);
            loggerService.info('LoopService: Loop execution recorded', { loopId: loop.id, executionId, status });
            this.executingLoops.delete(loop.id);
        }
    }

    private async schedulerTick() {
        try {
            loggerService.info('LoopService: Scheduler tick started');
            const loops = (await this.listLoops()).filter((loop) => loop.enabled);
            const now = new Date();
            const checkedLoops: { loopId: string; nextRun: string | null }[] = [];
            const dueLoops: { loop: LoopDefinition; nextRun: string }[] = [];

            for (const loop of loops) {
                const nextRun = this.getNextRun(loop, now);
                checkedLoops.push({ loopId: loop.id, nextRun: nextRun ? nextRun.toISOString() : null });

                if (!nextRun) continue;
                if (nextRun.getTime() <= now.getTime()) {
                    dueLoops.push({ loop, nextRun: nextRun.toISOString() });
                }
            }

            loggerService.info('LoopService: Scheduler checked loops', { checkedLoops, referenceTime: now.toISOString() });

            if (dueLoops.length > 0) {
                loggerService.info('LoopService: Loops due for execution', {
                    loopIds: dueLoops.map((entry) => entry.loop.id),
                });
            }

            for (const { loop, nextRun } of dueLoops) {
                loggerService.info('LoopService: Triggering loop execution', { loopId: loop.id, nextRun });
                await this.executeLoop(loop);
            }
        } catch (error) {
            loggerService.error('LoopService: Scheduler tick failed', { error });
        }
    }

    private async sweeperTick() {
        const threshold = Date.now() - ONE_WEEK_MS;
        try {
            const expiredIds: string[] = await redisService.request(['ZRANGEBYSCORE', EXECUTION_ZSET_KEY, 0, threshold]);
            for (const executionId of expiredIds) {
                const executionRaw = await redisService.request(['GET', getExecutionKey(executionId)]);
                const execution: LoopExecutionLog | null = executionRaw ? JSON.parse(executionRaw) : null;
                const traceKey = getTraceKey(executionId);

                await redisService.request(['DEL', getExecutionKey(executionId), traceKey]);
                await redisService.request(['ZREM', EXECUTION_ZSET_KEY, executionId]);

                if (execution?.logFilePath) {
                    try {
                        await fs.rm(execution.logFilePath, { force: true });
                    } catch (err) {
                        loggerService.error('LoopService: Failed to delete log file', { executionId, error: err });
                    }
                }

                loggerService.info('LoopService: Sweeper removed execution', { executionId });
            }
        } catch (error) {
            loggerService.error('LoopService: Sweeper tick failed', { error });
        }
    }

    async startBackgroundThreads() {
        if (!this.scheduler) {
            loggerService.info('LoopService: Starting scheduler thread');
            await this.schedulerTick();
            this.scheduler = setInterval(() => this.schedulerTick(), ONE_MINUTE_MS);
        }

        if (!this.sweeper) {
            loggerService.info('LoopService: Starting sweeper thread');
            await this.sweeperTick();
            this.sweeper = setInterval(() => this.sweeperTick(), ONE_HOUR_MS);
        }
    }

    async getExecutionLogs(loopId?: string, limit: number = 20, includeTraces: boolean = false): Promise<(LoopExecutionLog & { traces?: TraceData[] })[]> {
        const ids: string[] = await redisService.request(['ZRANGEBYSCORE', EXECUTION_ZSET_KEY, '-inf', '+inf']);
        const ordered = Array.isArray(ids) ? ids.slice().reverse() : [];
        const results: (LoopExecutionLog & { traces?: TraceData[] })[] = [];
        for (const id of ordered) {
            if (results.length >= limit) break;
            const payload = await redisService.request(['GET', getExecutionKey(id)]);
            if (!payload) continue;
            try {
                const parsed: LoopExecutionLog & { traces?: TraceData[] } = JSON.parse(payload);
                if (!loopId || parsed.loopId === loopId) {
                    if (includeTraces) {
                        const tracePayload = await redisService.request(['GET', getTraceKey(id)]);
                        if (tracePayload) {
                            try {
                                parsed.traces = JSON.parse(tracePayload) as TraceData[];
                            } catch (error) {
                                loggerService.error('LoopService: Failed to parse execution traces', { id, error });
                            }
                        }
                    }
                    results.push(parsed);
                }
            } catch (error) {
                loggerService.error('LoopService: Failed to parse execution log', { id, error });
            }
        }
        return results;
    }
}

export const loopService = new LoopService();
