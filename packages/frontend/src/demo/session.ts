import type { DemoSessionInfo } from './types';

export type StoredDemoSession = Pick<DemoSessionInfo, 'accessToken' | 'session' | 'joinCode'>;

export function mergeRefreshedSession(fresh: DemoSessionInfo, stored: StoredDemoSession): DemoSessionInfo {
  return { ...fresh, accessToken: stored.accessToken, joinCode: fresh.joinCode ?? stored.joinCode };
}
