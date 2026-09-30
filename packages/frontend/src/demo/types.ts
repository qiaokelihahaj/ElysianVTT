import type {
  EncounterCommandResult,
  EncounterSnapshot,
  DemoAssignEntityRequest,
  DemoRosterEntry,
  DemoRosterResponse,
  DemoCatalogResponse,
  DemoSessionResponse,
  DemoSessionView,
} from '@hard-vtt/shared';

/**
 * The demo transport keeps lobby metadata alongside the shared encounter
 * snapshot.  Gameplay state itself always uses the shared contract above.
 */
export type DemoRoomInfo = DemoRosterResponse['data'];

/** View-model composed from the token response; the credential never enters it. */
export type DemoSessionInfo = DemoSessionResponse['data'];

export type DemoCatalog = DemoCatalogResponse['data'];

export type { DemoRosterEntry, DemoSessionView };

export interface DemoTransportError {
  code?: string;
  reason: string;
  requestId?: string;
}

export type DemoCommandResult = EncounterCommandResult;

export interface DemoSocketEvents {
  snapshot: (snapshot: EncounterSnapshot) => void;
  roster: (entries: DemoRosterEntry[]) => void;
  command: (result: DemoCommandResult) => void;
  error: (error: DemoTransportError) => void;
  connection: (connected: boolean) => void;
}

export interface DemoApiError {
  status: number;
  code?: string;
  reason: string;
}

export type DemoRoomAssignment = DemoAssignEntityRequest;

export interface DemoSelectedCell {
  x: number;
  y: number;
}
