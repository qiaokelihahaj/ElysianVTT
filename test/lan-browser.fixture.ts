// Child-process fixture: production server/engine, deterministic test content.
// Control messages use parent IPC only; no test HTTP endpoint is exposed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createDemoServer } from '../packages/backend/src/demo/DemoServer.js';
import { EncounterCoordinator } from '../packages/backend/src/demo/EncounterCoordinator.js';

async function main(): Promise<void> {
  const directory = process.env.LAN_TEST_DIRECTORY;
  if (!directory || !process.send) throw new Error('Fixture requires isolated directory and parent IPC');
  const restoring = existsSync(join(directory, 'demo.db'));
  console.info('[fixture] composing isolated server');
  const server = await createDemoServer({
    host: '127.0.0.1', port: 0, dataDirectory: directory,
    hostCredential: process.env.LAN_TEST_CREDENTIAL, joinCode: process.env.LAN_TEST_JOIN_CODE,
    frontendDist: process.env.LAN_TEST_FRONTEND,
    coordinatorFactory: options => {
      const content = structuredClone(options.content);
      content.reactionJoinMs = 3500;
      content.reactionSelectMs = 8000;
      const movement = content.actionTemplates.find(action => action.id === 'DEMO_MOVE');
      if (movement) movement.timeCost = { startupTicks: 1, recoveryTicks: 1 };
      const entities = restoring ? options.entities : options.entities.slice(0, 4).map((entity, index) => ({
        ...entity,
        transform: { ...entity.transform, coords: [{ x: 2, y: 2, z: 0 }, { x: 2, y: 3, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 4, y: 2, z: 0 }][index] },
      }));
      if (!restoring) entities.push({
        ...structuredClone(entities[3]), id: 'lan-secret-prop', displayName: 'LAN_SECRET_ENTITY',
        type: 'PROP', faction: 'NEUTRAL', visibility: 'GM', tags: ['HIDDEN'],
        transform: { ...entities[3].transform, coords: { x: 9, y: 5, z: 0 } },
      });
      return new EncounterCoordinator({ ...options, content, entities });
    },
  });
  console.info('[fixture] binding loopback listener');
  const { url } = await server.listen();
  console.info('[fixture] listener ready');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    process.disconnect?.();
  };
  process.on('message', (message: unknown) => {
    if (message === 'stop') void close();
    if (message === 'persistence') process.send?.({
      type: 'persistence', record: server.persistence.load(),
      history: server.persistence.loadSettlementHistory(),
    });
  });
  process.on('disconnect', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.send({ type: 'ready', url, pid: process.pid });
}
void main().catch(error => { console.error(error); process.exitCode = 2; process.disconnect?.(); });
