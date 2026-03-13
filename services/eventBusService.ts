
import { Response } from 'express';
import { loggerService } from './loggerService.js';

export enum KernelEventType {
    SYMBOL_ADD = 'SYMBOL_ADD',
    SYMBOL_DELETE = 'SYMBOL_DELETE',
    CACHE_LOAD = 'CACHE_LOAD',
    CACHE_EVICT = 'CACHE_EVICT',
    LINK_CREATE = 'LINK_CREATE',
    LINK_DELETE = 'LINK_DELETE',
    TENTATIVE_LINK_CREATE = 'TENTATIVE_LINK_CREATE',
    TENTATIVE_LINK_DELETE = 'TENTATIVE_LINK_DELETE',
    TRACE_GENERATE = 'TRACE_GENERATE'
}

export interface KernelEvent {
    type: KernelEventType;
    timestamp: string;
    data: any;
}

class EventBusService {
    private subscribers: Set<Response> = new Set();

    /**
     * Subscribe a client (Express Response) to the SSE stream.
     */
    subscribe(res: Response) {
        this.subscribers.add(res);
        loggerService.info(`Client subscribed to Kernel Event Bus. Total subscribers: ${this.subscribers.size}`);

        // Remove subscriber on close
        res.on('close', () => {
            this.subscribers.delete(res);
            loggerService.info(`Client disconnected from Kernel Event Bus. Total subscribers: ${this.subscribers.size}`);
        });
    }

    /**
     * Emit an event to all subscribers.
     */
    emit(type: KernelEventType, data: any) {
        const event: KernelEvent = {
            type,
            timestamp: new Date().toISOString(),
            data
        };

        const payload = `data: ${JSON.stringify(event)}\n\n`;
        this.subscribers.forEach(res => {
            res.write(payload);
        });

        // Debug log for important events
        if (type !== KernelEventType.TRACE_GENERATE) {
            loggerService.debug(`Kernel Event Emitted: ${type}`, { symbolId: data.symbolId || data.id });
        }
    }
}

export const eventBusService = new EventBusService();
