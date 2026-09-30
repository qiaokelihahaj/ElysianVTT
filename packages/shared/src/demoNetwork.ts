import type {
  EncounterCommand,
  EncounterCommandResult,
  EncounterIncrement,
  EncounterRole,
  EncounterSnapshot,
  EncounterFaction,
  EntityId,
  ActionTemplate,
  MapData,
  SpatialActionConfig,
  EncounterScenario,
  AoeShape,
} from './index.js';

/**
 * HTTP and Socket.io payloads for the isolated LAN demo.
 *
 * The access token is deliberately omitted from every view type.  It is
 * returned only by the join/host HTTP response and is supplied to Socket.io
 * through the auth handshake or an AUTHENTICATE event.
 */
export interface DemoSessionView {
  sessionId: string;
  userId: string;
  role: EncounterRole;
  displayName: string;
  expiresAt: number;
  reconnectUntil: number;
  connectedSocketCount: number;
  controlledEntityIds: EntityId[];
}

export interface DemoSessionResponse {
  ok: true;
  data: {
    accessToken: string;
    session: DemoSessionView;
    snapshot: EncounterSnapshot;
    settlement?: DemoSettlementState;
    /** Present only for GM responses; JSON omits the undefined PL value. */
    joinCode: string | undefined;
  };
}

export type DemoSettlementPersistenceStatus = 'pending' | 'saved' | 'failed';

export interface DemoSettlementState {
  status: DemoSettlementPersistenceStatus;
  retryable: boolean;
  message?: string;
  updatedAt?: number;
}

export interface DemoErrorResponse {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
  session?: DemoSessionView;
}

export interface DemoJoinRequest {
  joinCode: string;
  displayName?: string;
}

export interface DemoHostRequest {
  credential?: string;
  displayName?: string;
}

export interface DemoRosterEntry {
  /** Hidden from PL viewers; present for the GM roster only. */
  userId?: string;
  displayName: string;
  role: EncounterRole;
  connectedSocketCount: number;
  connected: boolean;
  controlledEntityIds: EntityId[];
}

export interface DemoRosterResponse {
  ok: true;
  data: {
    encounterId: string;
    entries: DemoRosterEntry[];
    snapshot: EncounterSnapshot;
    settlement?: DemoSettlementState;
  };
}

export interface DemoAssignmentResponse {
  ok: true;
  data: {
    entries: DemoRosterEntry[];
    snapshot: EncounterSnapshot;
    assignedUserId: string;
    entityId: EntityId;
    settlement?: DemoSettlementState;
  };
}

export interface DemoSettlementResponse {
  ok: true;
  data: DemoSettlementState;
}

export interface DemoAssignEntityRequest {
  userId: string;
  entityId: EntityId;
}

export interface DemoUnassignEntityRequest {
  userId: string;
  entityId: EntityId;
}

export interface DemoCatalogAction {
  id: string;
  label: string;
  tags: string[];
  startupTicks: number;
  recoveryTicks: number;
  resourceCost: Record<string, string>;
  description?: string;
  targetKind?: 'entity' | 'cell' | 'none';
  spatial?: SpatialActionConfig;
  range?: ActionTemplate['range'];
  launchProjectile?: ActionTemplate['launchProjectile'];
  aoe?: { shape: AoeShape; radius: number; angle?: number; width?: number };
}

export interface DemoCatalogEntry {
  templateId: string;
  label: string;
  faction: EncounterFaction | null;
  /** Full stats are only sent to a GM. */
  entityTemplate?: Record<string, unknown>;
  actions: DemoCatalogAction[];
}

export interface DemoCatalogResponse {
  ok: true;
  data: {
    map: MapData;
    /** GM receives the full action/template palette. */
    entries: DemoCatalogEntry[];
    scenario?: EncounterScenario;
    /** Optional capability flags allow a newer client to degrade against an older demo server. */
    capabilities?: {
      actionPreview?: boolean;
    };
  };
}

/** Request for the read-only target picker preview. */
export interface DemoActionPreviewRequest {
  entityId: EntityId;
  actionTemplateId: string;
}

export type DemoActionPreviewTargetKind = 'entity' | 'cell' | 'none';

export interface DemoActionPreviewEntity {
  /** Current geometric range, distinct from permission to lock a future target. */
  inRange?: boolean;
  entityId: EntityId;
  allowed: boolean;
  reason?: string;
}

export interface DemoActionPreviewCell {
  x: number;
  y: number;
  allowed: boolean;
  reason?: string;
}

/**
 * Recipient-filtered, side-effect-free target preview for a main action.
 * The authoritative ACTION command still performs the complete validation.
 */
export interface DemoActionPreview {
  revision: number;
  actorId: EntityId;
  actionTemplateId: string;
  targetKind: DemoActionPreviewTargetKind;
  available: boolean;
  reason?: string;
  entities: DemoActionPreviewEntity[];
  cells: DemoActionPreviewCell[];
}

export interface DemoActionPreviewResponse {
  ok: true;
  data: DemoActionPreview;
}

/** Internal helper shape for catalog builders; never sent as-is to PL clients. */
export type DemoCatalogSource = {
  map: MapData;
  actions: ActionTemplate[];
  entries: DemoCatalogEntry[];
};

export interface DemoSocketAuthPayload {
  accessToken: string;
}

export interface DemoSocketAuthAck {
  ok: true;
  session: DemoSessionView;
  snapshot: EncounterSnapshot;
}

export interface DemoSocketError {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
}

/** A command sent after the socket has been authenticated and joined. */
export type DemoSocketCommand = EncounterCommand;

/** Every command ACK contains the recipient-filtered snapshot. */
export type DemoSocketCommandAck = EncounterCommandResult;

export interface DemoSocketIncrementPayload {
  increment: EncounterIncrement;
  snapshot: EncounterSnapshot;
}

export interface DemoSocketRosterPayload {
  entries: DemoRosterEntry[];
  settlement?: DemoSettlementState;
}

export interface DemoSocketEvents {
  AUTHENTICATE: (payload: DemoSocketAuthPayload, ack?: (result: DemoSocketAuthAck | DemoSocketError) => void) => void;
  DEMO_COMMAND: (command: DemoSocketCommand, ack?: (result: DemoSocketCommandAck) => void) => void;
  DEMO_SNAPSHOT: (payload: { snapshot: EncounterSnapshot }) => void;
  DEMO_INCREMENT: (payload: DemoSocketIncrementPayload) => void;
  DEMO_ROSTER: (payload: DemoSocketRosterPayload) => void;
  DEMO_ERROR: (error: DemoSocketError) => void;
}
