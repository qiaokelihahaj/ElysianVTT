import type { EncounterCommand, EncounterCommandBase, EncounterCommandType, EntityId, Vector3D } from '@hard-vtt/shared';

export function requestId(prefix = 'demo'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function makeCommand(
  type: EncounterCommandType,
  payload: Record<string, unknown>,
  context: Pick<EncounterCommandBase, 'expectedRevision' | 'expectedBarrierVersion' | 'expectedDecisionVersion' | 'controlEpoch'> = {},
): EncounterCommand {
  const command = {
    type,
    payload,
    ...context,
    requestId: requestId(type.toLowerCase()),
  } satisfies EncounterCommandBase;
  return command as EncounterCommand;
}

export function actionPayload(entityId: EntityId, actionTemplateId: string, targetIds: EntityId[], targetCoords?: Vector3D): Record<string, unknown> {
  return {
    entityId,
    actionTemplateId,
    targetIds,
    ...(targetCoords ? { targetCoords } : {}),
  };
}
