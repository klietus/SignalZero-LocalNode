
import { redisService } from './redisService.js';
import { domainService } from './domainService.js';
import { eventBusService, KernelEventType } from './eventBusService.js';
import { loggerService } from './loggerService.js';

export interface TentativeLink {
    sourceId: string;
    targetId: string;
    count: number;
    age: number; // turns since last reinforce
}

class TentativeLinkService {
    private readonly REDIS_KEY = 'sz:tentative_links';
    private readonly FINALIZATION_THRESHOLD = 3;
    private readonly EVICTION_AGE = 10;

    /**
     * Process a trace to identify and update tentative links.
     */
    async processTrace(activationPath: { symbol_id?: string }[], userId?: string) {
        if (!activationPath || activationPath.length < 2) return;

        const links = await this.getAllLinks();
        
        for (let i = 0; i < activationPath.length - 1; i++) {
            const sourceId = activationPath[i].symbol_id;
            const targetId = activationPath[i+1].symbol_id;

            if (sourceId && targetId && sourceId !== targetId) {
                await this.handlePair(sourceId, targetId, links, userId);
            }
        }

        await this.saveLinks(links);
    }

    private async handlePair(sourceId: string, targetId: string, links: Record<string, TentativeLink>, userId?: string) {
        // Check if a persistent link already exists
        const sourceSym = await domainService.findById(sourceId, userId);
        if (sourceSym?.linked_patterns?.some(l => l.id === targetId)) {
            return; // Already persistent
        }

        const linkKey = this.getLinkKey(sourceId, targetId);
        
        if (links[linkKey]) {
            // Reinforce
            links[linkKey].count += 1;
            links[linkKey].age = 0; // Reset age on reinforce

            if (links[linkKey].count >= this.FINALIZATION_THRESHOLD) {
                await this.finalizeLink(sourceId, targetId, userId);
                delete links[linkKey];
            } else {
                loggerService.debug(`Reinforced tentative link: ${sourceId} -> ${targetId} (${links[linkKey].count})`);
                // Re-emit create event to trigger visual flare in frontend
                eventBusService.emit(KernelEventType.TENTATIVE_LINK_CREATE, links[linkKey]);
            }
        } else {
            // New tentative link
            const newLink: TentativeLink = {
                sourceId,
                targetId,
                count: 1,
                age: 0
            };
            links[linkKey] = newLink;
            loggerService.debug(`New tentative link detected: ${sourceId} -> ${targetId}`);
            eventBusService.emit(KernelEventType.TENTATIVE_LINK_CREATE, newLink);
        }
    }

    private async finalizeLink(sourceId: string, targetId: string, userId?: string) {
        loggerService.info(`Finalizing tentative link into persistent store: ${sourceId} -> ${targetId}`);
        
        try {
            const sourceSym = await domainService.findById(sourceId, userId);
            if (sourceSym) {
                if (!sourceSym.linked_patterns) sourceSym.linked_patterns = [];
                sourceSym.linked_patterns.push({
                    id: targetId,
                    link_type: 'emergent',
                    bidirectional: true
                });
                
                // addSymbol handles back-link creation and LINK_CREATE event emission
                await domainService.addSymbol(sourceSym.symbol_domain, sourceSym, userId, true);
                
                // Emit delete for the tentative line
                eventBusService.emit(KernelEventType.TENTATIVE_LINK_DELETE, { sourceId, targetId });
            }
        } catch (e) {
            loggerService.error(`Failed to finalize link ${sourceId} -> ${targetId}`, { error: e });
        }
    }

    /**
     * Increment age of all links and evict old ones.
     */
    async incrementTurns() {
        const links = await this.getAllLinks();
        let changed = false;

        for (const key in links) {
            links[key].age += 1;
            if (links[key].age >= this.EVICTION_AGE) {
                loggerService.debug(`Evicting decayed tentative link: ${links[key].sourceId} -> ${links[key].targetId}`);
                eventBusService.emit(KernelEventType.TENTATIVE_LINK_DELETE, { 
                    sourceId: links[key].sourceId, 
                    targetId: links[key].targetId 
                });
                delete links[key];
                changed = true;
            } else {
                changed = true;
            }
        }

        if (changed) await this.saveLinks(links);
    }

    private getLinkKey(s: string, t: string) {
        // Order doesn't matter for key, but we store directed pairs for simplicity in this version
        // To treat A->B same as B->A, sort them:
        const sorted = [s, t].sort();
        return `${sorted[0]}:${sorted[1]}`;
    }

    private async getAllLinks(): Promise<Record<string, TentativeLink>> {
        const data = await redisService.request(['GET', this.REDIS_KEY]);
        return data ? JSON.parse(data) : {};
    }

    private async saveLinks(links: Record<string, TentativeLink>) {
        await redisService.request(['SET', this.REDIS_KEY, JSON.stringify(links)]);
    }
}

export const tentativeLinkService = new TentativeLinkService();
