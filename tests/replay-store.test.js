'use strict';
const mkTmp = require('./tmpdir');
/* dev/replay/store.js: the uci overlay cannot reach Object.prototype and
   refuses names libuci refuses; plugins answer their objects; log text is
   kept free of control characters. Uses a small synthetic mirror. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, safe } = require('../dev/replay/store');

function mirror() {
	const dir = mkTmp('vantage-store-test-');
	fs.mkdirSync(path.join(dir, 'browser-2026-01-01T00-00-00-000Z'));
	const rows = [
		{ at: 1, object: 'uci', method: 'get', args: { config: 'network' }, result: [ 0, { values: {
			lan: { '.anonymous': false, '.type': 'interface', '.name': 'lan', '.index': 0, proto: 'static' } } } ] },
		{ at: 2, object: 'system', method: 'board', args: {}, result: [ 0, { hostname: 'ap', model: 'Demo' } ] }
	];
	fs.writeFileSync(path.join(dir, 'browser-2026-01-01T00-00-00-000Z', 'rpc.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
	return dir;
}

test('store: uci overlay is prototype-safe and validates names like libuci', () => {
	const s = new Store(mirror(), { synthetic: false });
	const INVAL = { result: [ 2 ] };
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: '__proto__', values: { zz: 'x' } }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'constructor', values: { zz: 'x' } }), INVAL);
	assert.deepEqual(s.call('uci', 'add', { config: '__proto__', type: 'x' }), INVAL);
	assert.deepEqual(s.call('uci', 'add', { config: 'network', type: 'x', name: 'prototype' }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: JSON.parse('{"__proto__":{"polluted":1}}') }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: { 'a.b': '1' } }), INVAL);
	assert.deepEqual(s.call('uci', 'delete', { config: 'network', section: 'lan', options: [ '__proto__' ] }), INVAL);
	assert.deepEqual(s.call('uci', 'rename', { config: 'network', section: 'lan', name: '__rt' }).result, [ 0 ], '__rt is a valid uci name');
	assert.deepEqual(s.call('uci', 'rename', { config: 'network', section: '__rt', name: 'lan' }).result, [ 0 ]);
	/* inherited names are not sections or options */
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'toString' }), { result: [ 4 ] });
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'lan', option: 'hasOwnProperty' }), { result: [ 4 ] });
	assert.deepEqual(s.call('uci', 'get', { config: 'toString' }).result, [ 4 ]);
	assert.equal(s.uciGet('network', 'lan', 'constructor'), null);
	assert.equal(({}).zz, undefined);
	assert.equal(({}).polluted, undefined);
	/* ordinary use still works */
	const add = s.call('uci', 'add', { config: 'network', type: 'route', values: { target: 'x' } });
	assert.equal(add.result[0], 0);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: { mtu: 1500, dns: [ 'a', 'b' ] } }), { result: [ 0 ] });
	assert.equal(s.call('uci', 'changes', { config: 'network' }).result[1].changes.length, 6);   /* 2 renames, add, 3 values */
	s.call('uci', 'commit', { config: 'network' });
	assert.equal(s.uciGet('network', 'lan', 'mtu'), '1500');
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'lan', option: 'dns' }), { result: [ 0, { value: [ 'a', 'b' ] } ] });
	assert.equal(s.uciSeed('__proto__', { x: {} }), false);
	assert.equal(s.uciSeed('extra', { main: { '.type': 'x', '.name': 'main', a: '1' } }), true);
	assert.equal(s.uciGet('extra', 'main', 'a'), '1');
});

test('store: plugins answer their objects and are listed', () => {
	const s = new Store(mirror(), { synthetic: false });
	const files = fs.readdirSync(path.join(__dirname, '../dev/replay')).filter(f => /-plugin\.js$/.test(f));
	for (const f of files) {
		const mod = require(path.join(__dirname, '../dev/replay', f));
		for (const o of Array.isArray(mod.OBJECTS) ? mod.OBJECTS : [ mod.OBJECT ]) {
			assert.ok(s.plugins.has(o), o);
			assert.ok(s.list().includes(o), o + ' listed');
		}
	}
	assert.equal(new Store(mirror(), { synthetic: false, plugins: false }).plugins.size, 0);
});

test('store: request-derived log text has no control characters', () => {
	assert.equal(safe('a\u001b]0;x\u0007b\n\u009b31m\u007f'), 'a\\x1b]0;x\\x07b\\x0a\\x9b31m\\x7f');
	const s = new Store(mirror(), { synthetic: false });
	const lines = [];
	const orig = console.error;
	console.error = (...a) => lines.push(a.join(' '));
	try { s.call('o\u001b]52;c;Y3VybA==\u0007', 'm\n[replay] apply (checked): FORGED', {}); }
	finally { console.error = orig; }
	assert.equal(lines.length, 1);
	assert.doesNotMatch(lines[0], /[\x00-\x1f\x7f-\x9f]/);
});

test('--wired: no radios, the uplink renamed wan, synthetic networks with growing counters', () => {
	const wired = require('../dev/replay/wired');
	const ok = data => ({ result: [ 0, data ] });
	assert.deepEqual(wired.transform('luci.vantage', 'wireless', {}, ok({ radio0: {} })), ok({}));
	assert.deepEqual(wired.transform('network.wireless', 'status', {}, ok({ radio0: {} })), ok({}));
	const dump = wired.transform('network.interface', 'dump', {}, ok({ interface: [
		{ interface: 'loopback', up: true, l3_device: 'lo' },
		{ interface: 'lan', up: true, l3_device: 'br-lan', proto: 'static', route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ] },
		{ interface: 'lan6', up: true, l3_device: 'br-lan' }
	] })).result[1].interface;
	assert.deepEqual(dump.map(i => i.interface), [ 'loopback', 'wan', ...wired.NETS.map(n => n.iface) ]);
	assert.equal(dump[1].l3_device, 'br-lan');
	const devs = () => wired.transform('network.device', 'status', {}, ok({ 'br-lan': {} })).result[1];
	const a = devs()['br-lan0'].statistics.tx_bytes;
	assert.ok(devs()['br-lan0'].statistics.tx_bytes >= a);
	assert.ok('br-lan' in devs());
	/* one device asked by name, errors: untouched */
	assert.deepEqual(wired.transform('network.device', 'status', { name: 'eth0' }, ok({ up: true })), ok({ up: true }));
	assert.deepEqual(wired.transform('luci.vantage', 'wireless', {}, { error: 'x' }), { error: 'x' });
	/* switch ports in the bridge, hosts on them, their names */
	assert.deepEqual(devs()['br-lan0']['bridge-members'], [ 'lan1', 'lan2' ]);
	assert.deepEqual([ devs().lan1.speed, devs().lan2.speed ], [ '1000F', '2500F' ]);
	const hosts = wired.transform('luci.vantage', 'wired', {}, ok({ hosts: [] })).result[1].hosts;
	assert.deepEqual(hosts.map(h => [ h.mac, h.port ]), wired.HOSTS.map(h => [ h[0], h[1] ]));
	assert.ok(hosts.every(h => /^00:00:5e:00:53:/.test(h.mac) && Number.isInteger(h.seen) && h.seen >= 0));
	const hints = wired.transform('luci-rpc', 'getHostHints', {}, ok({})).result[1];
	assert.deepEqual(hints['00:00:5E:00:53:B1'], { ipaddrs: [ '198.51.100.10' ], ip6addrs: [], name: 'desktop' });
});

test('synthetic: three documentation hosts on the recorded bridge\'s wired member, none without a bridge', () => {
	const { Synthetic } = require('../dev/replay/synthetic');
	const plugin = require('../dev/replay/vantage-plugin');
	const devs = { 'br-lan': { type: 'bridge', 'bridge-members': [ 'phy0-ap0', 'eth0' ] }, eth0: { devtype: 'ethernet' }, 'phy0-ap0': { devtype: 'wlan' } };
	const syn = new Synthetic({ data: (o, m) => (o === 'network.device' && m === 'status') ? devs : null });
	const orig = console.error;
	console.error = () => {};
	try {
		const hosts = plugin.wired(syn.fdb());
		assert.deepEqual(hosts.map(h => [ h.mac, h.port, h.bridge ]), [ 1, 2, 3 ].map(i => [ '00:00:5e:00:53:a' + i, 'eth0', 'br-lan' ]));
		assert.deepEqual(new Synthetic({ data: () => ({ eth0: {} }) }).fdb(), []);
	}
	finally { console.error = orig; }
});
