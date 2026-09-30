import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { EncounterCommandResult, DemoSessionResponse } from '@hard-vtt/shared';
import { createDemoServer, type DemoServerHandle } from '../packages/backend/src/demo/DemoServer.js';

async function main(): Promise<void> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'elysian-broadcast-test-')));
  const credential = randomBytes(24).toString('hex');
  const clients: Socket[] = [];
  let server: DemoServerHandle | undefined;
  try {
    server = await createDemoServer({ dataDirectory: directory, host: '127.0.0.1', port: 0, hostCredential: credential });
    const { url } = await server.listen();
    const response = await fetch(`${url}/api/demo/host`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential }),
    });
    assert.equal(response.status, 200);
    const { data } = await response.json() as DemoSessionResponse;
    const connect = async () => {
      const counts = { increments: 0, snapshots: 0 };
      const socket = io(url, { autoConnect: false, transports: ['websocket'], reconnection: false, forceNew: true, auth: { accessToken: data.accessToken } });
      clients.push(socket);
      socket.on('DEMO_INCREMENT', () => counts.increments++);
      socket.on('DEMO_SNAPSHOT', () => counts.snapshots++);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('initial snapshot timeout')), 3000);
        socket.once('DEMO_SNAPSHOT', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', error => { clearTimeout(timer); reject(error); });
        socket.connect();
      });
      return { socket, counts };
    };
    const first = await connect();
    const second = await connect();
    const fence = (socket: Socket) => new Promise<void>((resolve, reject) => {
      // Socket.io preserves packet order; ACK for this no-op invalid command
      // proves preceding broadcast packets have arrived, without a sleep.
      socket.timeout(3000).emit('DEMO_COMMAND', { requestId: 'fence', type: 'INVALID', payload: {} }, (error: Error | null) => error ? reject(error) : resolve());
    });
    await Promise.all([fence(first.socket), fence(second.socket)]);
    for (const client of [first, second]) Object.assign(client.counts, { increments: 0, snapshots: 0 });
    const entity = server.coordinator.getSnapshot().entities[0];
    const result = await new Promise<EncounterCommandResult>((resolve, reject) => {
      first.socket.timeout(3000).emit('DEMO_COMMAND', {
        requestId: 'adjust-once', type: 'GM_ADJUST_ENTITY',
        payload: { entityId: entity.id, reason: 'broadcast regression', position: { x: 4, y: 4, z: 0 } },
      }, (error: Error | null, value: EncounterCommandResult) => error ? reject(error) : resolve(value));
    });
    assert.equal(result.ok, true);
    await Promise.all([fence(first.socket), fence(second.socket)]);
    for (const { counts } of [first, second]) {
      assert.equal(counts.increments, 1, 'each independent socket receives exactly one mutation');
      assert.equal(counts.snapshots, 0, 'increments must not also broadcast full snapshot events');
    }
    first.socket.disconnect();
    const reconnected = await connect();
    assert.ok(reconnected.counts.snapshots > 0, 'reconnect still receives a full snapshot');
    const beforeSync = reconnected.counts.snapshots;
    await new Promise<void>((resolve, reject) => {
      reconnected.socket.timeout(3000).emit('AUTHENTICATE', { accessToken: data.accessToken },
        (error: Error | null, result: { ok: boolean }) => {
          if (error) reject(error);
          else if (!result.ok) reject(new Error('explicit authentication sync rejected'));
          else resolve();
        });
    });
    await fence(reconnected.socket);
    assert.equal(reconnected.counts.snapshots, beforeSync + 1, 'explicit authentication sync still emits a full snapshot');
    console.log('demo-broadcast-once: two sockets, ordered update delivery and reconnect passed');
  } finally {
    clients.forEach(socket => socket.disconnect());
    await server?.close();
    assert.equal(dirname(directory), realpathSync(tmpdir()));
    assert.ok(basename(directory).startsWith('elysian-broadcast-test-'));
    rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
