import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { networkInterfaces } from 'node:os';
import type { DemoServerHandle, DemoServerListenResult, DemoServerOptions } from './DemoServer.js';
import { createDemoServer } from './DemoServer.js';
import { DemoPersistence } from './DemoPersistence.js';
import { DemoSessionService } from './DemoSessionService.js';
import { EncounterCoordinator } from './EncounterCoordinator.js';
import { createDemoContent, createDemoRoster, installDemoContent } from './DemoContent.js';

export {
  createDemoServer,
  DemoPersistence,
  DemoSessionService,
  EncounterCoordinator,
  createDemoRoster,
  createDemoContent,
  installDemoContent,
};
export type { DemoServerHandle, DemoServerListenResult, DemoServerOptions } from './DemoServer.js';
export type * from './DemoPersistence.js';
export type * from './DemoSessionService.js';
export type * from './EncounterCoordinator.js';
export type * from './DemoContent.js';

function environmentOptions(scenario: 'classic' | 'tactics'): DemoServerOptions {
  const dataDirectory = process.env.ELYSIAN_DEMO_DATA_DIR
    ? resolve(process.env.ELYSIAN_DEMO_DATA_DIR)
    : resolve(process.cwd(), scenario === 'tactics' ? '.demo-tactics' : '.demo');
  const rawPort = process.env.ELYSIAN_DEMO_PORT;
  const parsedPort = rawPort === undefined ? (scenario === 'tactics' ? 3001 : 3000) : Number(rawPort);
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65_535) {
    throw new Error('ELYSIAN_DEMO_PORT must be an integer from 0 to 65535');
  }
  const allowedOrigins = process.env.ELYSIAN_DEMO_ALLOWED_ORIGINS
    ?.split(',')
    .map(origin => origin.trim())
    .filter(origin => origin.length > 0);
  return {
    scenario,
    dataDirectory,
    host: process.env.ELYSIAN_DEMO_HOST?.trim() || '0.0.0.0',
    port: parsedPort,
    ...(process.env.ELYSIAN_DEMO_HOST_CREDENTIAL ? { hostCredential: process.env.ELYSIAN_DEMO_HOST_CREDENTIAL } : {}),
    ...(process.env.ELYSIAN_DEMO_JOIN_CODE ? { joinCode: process.env.ELYSIAN_DEMO_JOIN_CODE } : {}),
    ...(allowedOrigins?.length ? { allowedOrigins } : {}),
  };
}

function writeLauncherCredentials(handle: DemoServerHandle, dataDirectory: string): string {
  mkdirSync(dataDirectory, { recursive: true });
  const credentialsPath = join(dataDirectory, 'credentials.json');
  writeFileSync(credentialsPath, `${JSON.stringify(handle.credentials, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return credentialsPath;
}

export async function runDemo(scenario: 'classic' | 'tactics' = 'classic'): Promise<void> {
  const options = environmentOptions(scenario);
  const handle = await createDemoServer(options);
  let listenResult: DemoServerListenResult;
  try {
    listenResult = await handle.listen();
  } catch (error) {
    await handle.close();
    throw error;
  }
  const credentialsPath = writeLauncherCredentials(handle, options.dataDirectory ?? resolve(process.cwd(), '.demo'));
  // Keep secrets in the local credentials file so a LAN banner or process
  // manager log cannot accidentally disclose the GM credential.
  console.log(`ElysianVTT ${scenario === 'tactics' ? 'spatial tactics' : 'demo'} listening at ${listenResult.url}`);
  if (options.host === '0.0.0.0' || options.host === '::') {
    const addresses = new Set(Object.values(networkInterfaces()).flatMap(entries =>
      (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address),
    ));
    for (const address of addresses) console.log(`LAN join address: http://${address}:${listenResult.port}`);
  }
  console.log(`Demo credentials written to ${credentialsPath}`);
  const shutdown = (): void => {
    void handle.close().catch(error => {
      console.error(`Demo shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (require.main === module) {
  void runDemo().catch(error => {
    console.error(`Demo server failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
