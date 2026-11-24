import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { Auth } from '../server/auth.mjs';
import { DesktopCapabilities } from '../server/desktop-capabilities.mjs';
import { PushService } from '../server/push-service.mjs';
import { observeHostComputers } from '../runtime/host-computers.mjs';

function memory(store) {
  store.value = structuredClone(store.initial);
  store.mutate = async update => update(store.value);
}

test('Android pairings do not gain desktop execution rights; display metadata preserves older clients', async () => {
  const auth = new Auth('.'); memory(auth.store);
  const push = new PushService('.', auth); memory(push.store);
  for (const [kind, platform, label] of [['android', 'android', 'android'], ['windows', 'desktop', 'windows'], ['linux', 'desktop', 'linux'], [undefined, 'desktop', 'desktop']]) {
    const { pairingKey } = await auth.createPairing();
    const { token, deviceId } = await auth.pair({ platform: 'desktop', deviceName: 'demo', clientKind: kind, pairingKey });
    assert.equal(auth.authenticate(token).platform, platform);
    await push.register(deviceId, { kind: 'desktop', clientKind: kind });
    assert.equal(push.get(deviceId).kind, label);
  }
});

test('Host desktop capabilities and computer observer recognize Linux desktop clients', async () => {
  const seen = [];
  const bridge = {
    userComputers: { list: () => [
      { id: 'mac-a', label: 'Mac', connected: true },
      { id: 'win-b', label: 'Win', connected: true },
      { id: 'linux-c', label: 'LinuxBox', connected: true },
    ] },
    registerProvider: () => () => {},
    submitResponses: () => ({}),
  };
  const observer = observeHostComputers(bridge, { send: value => seen.push(value), intervalMs: 60000 });
  observer.close();
  assert.deepEqual(seen[0].computers.map(item => [item.id, item.platform]), [
    ['mac-a', 'darwin'], ['win-b', 'win32'], ['linux-c', 'linux'],
  ]);

  const caps = new DesktopCapabilities({
    authenticate: () => ({ id: 'dev-linux', platform: 'desktop' }),
    internalToken: 'secret',
  });
  const writes = [];
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writeHead() {},
    write(chunk) { writes.push(chunk); },
    destroy() { this.destroyed = true; this.emit('close'); },
  });
  await caps.route({ method: 'GET', url: '/desktop-capabilities/requests?platform=linux', headers: {} }, res, '/desktop-capabilities/requests');
  const welcome = JSON.parse(writes[0].replace(/^data:\s*/, ''));
  assert.equal(welcome.machineId, 'linux-dev-linux');
  caps.close();
});
