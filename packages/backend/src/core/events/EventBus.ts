import { EventEmitter } from 'events';
import { LogPayload } from '@hard-vtt/shared';

export enum InternalEvent {
    GAME_LOG        = 'GAME_LOG',
    STATE_MUTATED   = 'STATE_MUTATED',
    VISUAL_FX       = 'VISUAL_FX',
    ACTION_SCHEDULED= 'ACTION_SCHEDULED',
    ENTITY_DIED     = 'ENTITY_DIED',
    COMBAT_END      = 'COMBAT_END',
    SCENE_LOADING   = 'SCENE_LOADING',
    SCENE_ACTIVE    = 'SCENE_ACTIVE',
    SCENE_DESTROYED = 'SCENE_DESTROYED',
    PLAYER_JOIN     = 'PLAYER_JOIN',
    PLAYER_LEAVE    = 'PLAYER_LEAVE',
}

export interface GameLogEvent {
    payload: LogPayload;
}

class EventBusSingleton extends EventEmitter {
    private static instance: EventBusSingleton;

    private constructor() {
        super();
        this.setMaxListeners(100);
    }

    static getInstance(): EventBusSingleton {
        if (!EventBusSingleton.instance) {
            EventBusSingleton.instance = new EventBusSingleton();
        }
        return EventBusSingleton.instance;
    }
}

export const EventBus = EventBusSingleton.getInstance();
