import assert from 'node:assert/strict';
import { DemoSessionService } from '../packages/backend/src/demo/DemoSessionService.js';

let now = 1000;
const service = new DemoSessionService({
    hostCredential: 'test-host-only', joinCode: 'TEST-ROOM', maxPlayers: 1,
    sessionTtlMs: 10000, reconnectGraceMs: 100, now: () => now,
});

let failures = 0;
function check(name: string, run: () => void): void {
    service.clear();
    now = 1000;
    try { run(); console.log(`PASS ${name}`); }
    catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}

try {
    check('a second socket keeps a player connected after the first disconnects', () => {
        const player = service.joinPlayer('TEST-ROOM', 'Alice');
        assert.ok(player);
        assert.ok(service.attachSocket(player.accessToken, 'tab-a').ok);
        assert.ok(service.attachSocket(player.accessToken, 'tab-b').ok);
        service.detachSocket('tab-a');
        now += 101;
        assert.ok(service.authenticate(player.accessToken).ok);
        assert.equal(service.getView(player.session).connectedSocketCount, 1);
        service.detachSocket('tab-b');
        now += 101;
        assert.equal(service.authenticate(player.accessToken).ok, false);
    });

    check('logging out frees a player slot for another player', () => {
        const player = service.joinPlayer('TEST-ROOM', 'Alice');
        assert.ok(player);
        assert.equal(service.joinPlayer('TEST-ROOM', 'Bob'), null);
        assert.ok(service.logout(player.accessToken).ok);
        assert.ok(service.joinPlayer('TEST-ROOM', 'Bob'), 'a logged-out player must not permanently occupy the room');
    });

    check('expired disconnected identities do not permanently fill the room', () => {
        const player = service.joinPlayer('TEST-ROOM', 'Alice');
        assert.ok(player);
        assert.ok(service.attachSocket(player.accessToken, 'tab-a').ok);
        service.detachSocket('tab-a');
        now += 101;
        assert.ok(service.joinPlayer('TEST-ROOM', 'Bob'));
        assert.equal(service.authenticate(player.accessToken).ok, false);
    });

    check('re-authenticating a socket detaches its previous identity', () => {
        const player = service.joinPlayer('TEST-ROOM', 'Alice');
        const host = service.createHostSession('test-host-only', 'Host');
        assert.ok(player && host);
        service.attachSocket(player.accessToken, 'shared-tab');
        service.attachSocket(host.accessToken, 'shared-tab');
        assert.equal(service.getView(player.session).connectedSocketCount, 0);
        now += 101;
        assert.equal(service.authenticate(player.accessToken).ok, false, 'the previous identity must enter its reconnect grace period');
        assert.equal(service.sessionForSocket('shared-tab')?.userId, host.session.userId);
    });
} finally {
    service.clear();
}

assert.equal(failures, 0, `${failures} demo session regressions failed`);
console.log('demo-session-regression: all 4 scenarios passed');
