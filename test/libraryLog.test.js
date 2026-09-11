'use strict';

// Tests for lib/libraryLog.js - the bridge that routes the log output of zigbee-herdsman and
// zigbee-herdsman-converters into the adapter log, plus the join trace for devices that never
// completed their interview. No hardware, no network; the herdsman controller is a stub.
// Run:  node --test test/libraryLog.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LibraryLogBridge, TRACE_WINDOW_MS } = require('../lib/libraryLog');
const utils = require('../lib/utils');

const GHOST = '0xb4e3f9fffe56ebc8';   // in the database, interview FAILED
const PAIRING = '0x0c4314fffe0ed00e'; // in the database, interview IN_PROGRESS
const KNOWN = '0xf0d1b8be240c0a21';   // in the database, interview SUCCESSFUL
const UNKNOWN = '0x70c59cfffe2c43f5'; // not in the database at all
const COORDINATOR = '0x00124b0029c1c8d4';

// line texts as zigbee-herdsman 10.9.1 writes them
const JOIN_LINE = `ezspTrustCenterJoinHandler: newNodeId=44772 newNodeEui64=${GHOST} status=STANDARD_SECURITY_SECURED_REJOIN policyDecision=USE_PRECONFIGURED_KEY parentOfNewNodeId=12345`;
const SENT_LINE = '~~~> [SENT ZDO UNICAST messageTag=17 apsSequence=201 status=OK]';
const DELIVERY_LINE = '~x~> DELIVERY_FAILED [indexOrDestination=44772 apsFrame={"profileId":0} messageTag=17]';

function fakeAdapter({ debugHerdsman = false, permitJoin = false, withController = true } = {}) {
    const lines = [];
    const devices = {
        [GHOST]: { interviewState: 'FAILED' },
        [PAIRING]: { interviewState: 'IN_PROGRESS' },
        [KNOWN]: { interviewState: 'SUCCESSFUL' },
        [COORDINATOR]: { interviewState: 'SUCCESSFUL', type: 'Coordinator' },
    };
    const adapter = {
        config: { debugHerdsman },
        log: {
            debug: m => lines.push(['debug', m]),
            info: m => lines.push(['info', m]),
            warn: m => lines.push(['warn', m]),
            error: m => lines.push(['error', m]),
        },
        lines,
    };
    if (withController) {
        adapter.zbController = {
            herdsman: {
                getDeviceByIeeeAddr: ieee => devices[ieee],
                getPermitJoin: () => permitJoin,
            },
        };
    }
    return adapter;
}

function bridgeFor(adapter, clock) {
    const bridge = new LibraryLogBridge(adapter);
    bridge.active = true;
    if (clock) bridge.now = () => clock.t;
    return bridge;
}

describe('level mapping outside a trace', () => {
    it('maps error/warning/info and drops debug while debugHerdsman is off', () => {
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter);
        bridge.handle('error', 'boom', 'zh:ember');
        bridge.handle('warning', 'careful', 'zh:controller');
        bridge.handle('info', '[NCP COUNTERS] 1,2,3', 'zh:ember');
        bridge.handle('debug', 'chatter', 'zh:ember:ezsp');
        assert.deepStrictEqual(adapter.lines, [
            ['error', '[zh:ember] boom'],
            ['warn', '[zh:controller] careful'],
            ['debug', '[zh:ember] [NCP COUNTERS] 1,2,3'],
        ]);
    });

    it('forwards debug lines as adapter debug while debugHerdsman is on', () => {
        const adapter = fakeAdapter({ debugHerdsman: true });
        bridgeFor(adapter).handle('debug', 'chatter', 'zh:ember:ezsp');
        assert.deepStrictEqual(adapter.lines, [['debug', '[zh:ember:ezsp] chatter']]);
    });

    it('resolves lambda messages (herdsman passes functions for expensive lines)', () => {
        const adapter = fakeAdapter();
        bridgeFor(adapter).handle('warning', () => `built ${1 + 1}`, 'zhc:tuya');
        assert.deepStrictEqual(adapter.lines, [['warn', '[zhc:tuya] built 2']]);
    });

    it('drops debug and info of byte-level namespaces but keeps their warnings and errors', () => {
        const adapter = fakeAdapter({ debugHerdsman: true });
        const bridge = bridgeFor(adapter);
        bridge.handle('debug', 'raw frame', 'zh:ember:uart:ash');
        bridge.handle('info', 'queue stats', 'zh:ember:uart:queues');
        bridge.handle('debug', 'token dump', 'zh:ember:tokens');
        bridge.handle('debug', 'unpi', 'zh:zstack:unpi:parser');
        bridge.handle('error', 'ASH connection lost', 'zh:ember:uart:ash');
        assert.deepStrictEqual(adapter.lines, [['error', '[zh:ember:uart:ash] ASH connection lost']]);
    });

    it('falls back to a generic namespace when the library passes none', () => {
        const adapter = fakeAdapter();
        bridgeFor(adapter).handle('error', 'no namespace', undefined);
        assert.deepStrictEqual(adapter.lines, [['error', '[lib] no namespace']]);
    });
});

describe('join trace', () => {
    it('logs every line naming a device without a completed interview at info level', () => {
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter);
        bridge.handle('debug', `Interview - node descriptor request failed for '${GHOST}', attempt 3`, 'zh:controller:device');
        bridge.handle('error', `Interview failed for '${UNKNOWN} with error 'Error: Interview failed because can not get node descriptor'`, 'zh:controller');
        bridge.handle('debug', `Interview - start device '${PAIRING}'`, 'zh:controller:device');
        assert.deepStrictEqual(adapter.lines.map(l => l[0]), ['info', 'info', 'info']);
        assert.ok(adapter.lines.every(l => l[1].startsWith('[trace zh:controller')));
    });

    it('leaves lines about interviewed devices, the coordinator and the broadcast address on the normal mapping', () => {
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter);
        bridge.handle('debug', `Device '${KNOWN}' joined`, 'zh:controller');
        bridge.handle('debug', `Coordinator ${COORDINATOR} ready`, 'zh:controller');
        bridge.handle('debug', 'Delivery of BROADCAST failed for 0xffffffffffffffff', 'zh:ember');
        bridge.handle('debug', 'blank 0x0000000000000000 target', 'zh:ember');
        assert.deepStrictEqual(adapter.lines, []);
        assert.strictEqual(bridge.traceUntil, 0);
    });

    it('opens the window on the join line and keeps all library lines at info until it closes', () => {
        const clock = { t: 1000000 };
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter, clock);
        bridge.handle('debug', JOIN_LINE, 'zh:ember:ezsp');
        clock.t += 5000;
        bridge.handle('debug', SENT_LINE, 'zh:ember');
        bridge.handle('debug', DELIVERY_LINE, 'zh:ember');
        bridge.handle('info', 'unrelated info', 'zh:controller');
        clock.t = 1000000 + TRACE_WINDOW_MS - 1;
        bridge.handle('debug', 'last one inside', 'zh:ember');
        clock.t = 1000000 + TRACE_WINDOW_MS;
        bridge.handle('debug', 'first one outside', 'zh:ember');
        bridge.handle('info', 'info outside', 'zh:ember');
        assert.deepStrictEqual(adapter.lines, [
            ['info', `[trace zh:ember:ezsp] ${JOIN_LINE}`],
            ['info', `[trace zh:ember] ${SENT_LINE}`],
            ['info', `[trace zh:ember] ${DELIVERY_LINE}`],
            ['info', '[trace zh:controller] unrelated info'],
            ['info', '[trace zh:ember] last one inside'],
            ['debug', '[zh:ember] info outside'],
        ]);
    });

    it('does not open the window on a line without a join marker, even for a traced device', () => {
        const clock = { t: 5000 };
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter, clock);
        bridge.handle('debug', `Candidates for ${GHOST}/undefined: ZYCT-202/Trust`, 'zhc:index');
        bridge.handle('debug', 'context line', 'zh:ember');
        assert.deepStrictEqual(adapter.lines, [['info', `[trace zhc:index] Candidates for ${GHOST}/undefined: ZYCT-202/Trust`]]);
        assert.strictEqual(bridge.traceUntil, 0);
    });

    it('opens the window on the controller join line and on a rejected join as well', () => {
        for (const line of [`New device '${UNKNOWN}' joined`, `Device '${GHOST}' rejected by handler, removing it`]) {
            const clock = { t: 42 };
            const bridge = bridgeFor(fakeAdapter(), clock);
            bridge.handle('debug', line, 'zh:controller');
            assert.strictEqual(bridge.traceUntil, 42 + TRACE_WINDOW_MS, line);
        }
    });

    it('traces nothing while the network is open for joining', () => {
        const adapter = fakeAdapter({ permitJoin: true });
        const bridge = bridgeFor(adapter);
        bridge.handle('debug', JOIN_LINE, 'zh:ember:ezsp');
        bridge.handle('error', `Interview failed for '${UNKNOWN}'`, 'zh:controller');
        assert.deepStrictEqual(adapter.lines, [['error', `[zh:controller] Interview failed for '${UNKNOWN}'`]]);
        assert.strictEqual(bridge.traceUntil, 0);
    });
});

describe('robustness', () => {
    it('logs on the normal mapping before the controller exists (any IEEE counts as unknown then)', () => {
        const adapter = fakeAdapter({ withController: false });
        const bridge = bridgeFor(adapter);
        bridge.handle('error', 'startup failure', 'zh:ember');
        bridge.handle('debug', `Device '${KNOWN}' joined`, 'zh:controller');
        assert.deepStrictEqual(adapter.lines, [
            ['error', '[zh:ember] startup failure'],
            ['info', `[trace zh:controller] Device '${KNOWN}' joined`],
        ]);
    });

    it('drops everything after stop() without touching the adapter', () => {
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter);
        bridge.stop();
        bridge.handle('error', 'after unload', 'zh:ember');
        assert.deepStrictEqual(adapter.lines, []);
    });

    it('keeps a line on the normal mapping when the device lookup fails (database not injected yet)', () => {
        const adapter = fakeAdapter();
        adapter.zbController.herdsman.getDeviceByIeeeAddr = () => { throw new TypeError("Cannot read properties of undefined (reading 'getEntriesIterator')"); };
        const bridge = bridgeFor(adapter);
        bridge.handle('error', `Interview failed for '${GHOST}'`, 'zh:controller');
        bridge.handle('debug', `Device '${GHOST}' joined`, 'zh:controller');
        assert.deepStrictEqual(adapter.lines, [['error', `[zh:controller] Interview failed for '${GHOST}'`]]);
        assert.strictEqual(bridge.traceUntil, 0);
    });

    it('survives a device lookup that logs through the bridge itself (no recursion, nothing lost)', () => {
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter);
        adapter.zbController.herdsman.getDeviceByIeeeAddr = ieee => {
            bridge.handle('warning', `loading database for ${ieee}`, 'zh:controller:database');
            return undefined;
        };
        bridge.handle('debug', `Device '${UNKNOWN}' joined`, 'zh:controller');
        assert.deepStrictEqual(adapter.lines, [
            ['warn', `[zh:controller:database] loading database for ${UNKNOWN}`],
            ['info', `[trace zh:controller] Device '${UNKNOWN}' joined`],
        ]);
        assert.notStrictEqual(bridge.traceUntil, 0);
    });

    it('never throws: broken adapter log, throwing lambda, missing config', () => {
        const bridge = new LibraryLogBridge({ config: undefined, log: { info() { throw new Error('log is gone'); }, debug() { throw new Error('gone too'); } } });
        bridge.active = true;
        assert.doesNotThrow(() => bridge.handle('info', 'x', 'zh:ember'));
        assert.doesNotThrow(() => bridge.handle('debug', () => { throw new Error('lambda failed'); }, 'zh:ember'));
        assert.doesNotThrow(() => bridge.handle('warning', 'x', 'zh:ember'));
        assert.doesNotThrow(() => new LibraryLogBridge({}).handle('error', 'no log at all', 'zh:ember'));
    });
});

describe('installation on the real libraries', () => {
    it('receives what zigbee-herdsman and zigbee-herdsman-converters log through their module loggers', () => {
        const adapter = fakeAdapter();
        const bridge = new LibraryLogBridge(adapter);
        const attached = bridge.install();
        assert.deepStrictEqual(attached, ['zigbee-herdsman', 'zigbee-herdsman-converters']);
        require('zigbee-herdsman/dist/utils/logger').logger.warning('from herdsman', 'zh:test');
        require('zigbee-herdsman-converters/lib/logger').logger.error(() => 'from converters', 'zhc:test');
        require('zigbee-herdsman/dist/utils/logger').logger.debug(() => `Device '${UNKNOWN}' joined`, 'zh:controller');
        assert.deepStrictEqual(adapter.lines, [
            ['warn', '[zh:test] from herdsman'],
            ['error', '[zhc:test] from converters'],
            ['info', `[trace zh:controller] Device '${UNKNOWN}' joined`],
        ]);
        bridge.stop();
    });
});

describe('blocklist parsing', () => {
    it('accepts arrays and separated strings, normalises case and the 0x prefix, reports the rest', () => {
        const fromArray = utils.parseIeeeList(['0xB4E3F9FFFE56EBC8', ' 0c4314fffe0ed00e ', '', 'nope', 12]);
        assert.deepStrictEqual([...fromArray.ieees], [GHOST, PAIRING]);
        assert.deepStrictEqual(fromArray.invalid, ['nope', '12']);
        const fromString = utils.parseIeeeList('0xb4e3f9fffe56ebc8, 0C4314FFFE0ED00E;0xb4e3f9fffe56ebc8\n');
        assert.deepStrictEqual([...fromString.ieees], [GHOST, PAIRING]);
        assert.deepStrictEqual(fromString.invalid, []);
        assert.strictEqual(utils.parseIeeeList(undefined).ieees.size, 0);
        assert.strictEqual(utils.parseIeeeList(42).ieees.size, 0);
    });
});

describe('join blocklist in the controller', () => {
    const ZigbeeController = require('../lib/zigbeecontroller');
    const baseOptions = {
        net: { panId: 0x1a62, extPanId: [1, 2, 3, 4, 5, 6, 7, 8], channelList: [20], precfgkey: [1, 3, 5, 7, 9, 11, 13, 15, 0, 2, 4, 6, 8, 10, 12, 13] },
        sp: { port: 'tcp://10.0.0.1:6638', baudRate: 115200, rtscts: false, adapter: 'ember' },
        dbDir: '/nonexistent', dbPath: 'shepherd.db', backupPath: 'nvbackup.json',
        extPanIdFix: true, startWithInconsistent: false,
    };

    function controllerWith(blocklist) {
        const adapter = {
            config: { listDevicesAtStart: false, readAtAnnounce: true, warnOnDeviceAnnouncement: true, pingTimeout: 300 },
            localConfig: {},
            log: { debug() {}, info() {}, warn() {}, error() {} },
            expandFileName: f => `/nonexistent/${f}`,
        };
        const controller = new ZigbeeController(adapter);
        const lines = [];
        controller.on('log', (level, msg) => lines.push([level, msg]));
        return { controller, lines, configured: controller.configure({ ...baseOptions, blocklist }) };
    }

    it('installs herdsman\'s acceptJoiningDeviceHandler only when the list has valid entries', async () => {
        const empty = controllerWith([]);
        await empty.configured;
        assert.strictEqual(empty.controller.herdsmanSettings.acceptJoiningDeviceHandler, undefined);
        const absent = controllerWith(undefined);
        await absent.configured;
        assert.strictEqual(absent.controller.herdsmanSettings.acceptJoiningDeviceHandler, undefined);
        const onlyInvalid = controllerWith(['nope']);
        await onlyInvalid.configured;
        assert.strictEqual(onlyInvalid.controller.herdsmanSettings.acceptJoiningDeviceHandler, undefined);
        assert.deepStrictEqual(onlyInvalid.lines, [['warn', "Ignoring blocklist entry 'nope': not an IEEE address"]]);
    });

    it('rejects exactly the listed devices, regardless of letter case, and says so once per join', async () => {
        const { controller, lines, configured } = controllerWith(['0xB4E3F9FFFE56EBC8', 'bad']);
        await configured;
        const handler = controller.herdsmanSettings.acceptJoiningDeviceHandler;
        assert.strictEqual(typeof handler, 'function');
        assert.strictEqual(await handler(GHOST), false);
        assert.strictEqual(await handler(GHOST.toUpperCase()), false);
        assert.strictEqual(await handler(KNOWN), true);
        assert.strictEqual(await handler(UNKNOWN), true);
        assert.deepStrictEqual(lines, [
            ['warn', "Ignoring blocklist entry 'bad': not an IEEE address"],
            ['info', `Join blocklist active for ${GHOST}`],
            ['info', `Join of '${GHOST}' rejected: the device is on the blocklist`],
            ['info', `Join of '${GHOST}' rejected: the device is on the blocklist`],
        ]);
    });

    it('is honoured by the installed zigbee-herdsman: a rejected join gets a leave request and no device', async () => {
        const { Controller, Zdo } = require('zigbee-herdsman');
        const Database = require('zigbee-herdsman/dist/controller/database').default;
        const Entity = require('zigbee-herdsman/dist/controller/model/entity').default;
        const { controller, configured } = controllerWith([GHOST]);
        await configured;
        const herdsman = new Controller(controller.herdsmanSettings);
        // an empty device database in a scratch file, so the device lookups of herdsman work
        const dbPath = path.join(os.tmpdir(), `zigbee-blocklist-test-${process.pid}.db`);
        Entity.injectDatabase(Database.open(dbPath));
        try {
            const sent = [];
            // the radio side of herdsman, replaced: record every ZDO request and answer it with SUCCESS
            herdsman.adapter = {
                hasZdoMessageOverhead: false,
                sendZdo: async (ieeeAddr, networkAddress, clusterId) => {
                    sent.push({ ieeeAddr, networkAddress, clusterId });
                    return [Zdo.Status.SUCCESS, undefined];
                },
            };
            const events = [];
            herdsman.on('deviceJoined', () => events.push('deviceJoined'));
            herdsman.on('deviceInterview', payload => events.push(`deviceInterview:${payload.status}`));
            await herdsman.onDeviceJoined({ networkAddress: 44772, ieeeAddr: GHOST });
            assert.deepStrictEqual(sent, [{ ieeeAddr: GHOST, networkAddress: 44772, clusterId: Zdo.ClusterId.LEAVE_REQUEST }]);
            assert.deepStrictEqual(events, []);
            assert.strictEqual(herdsman.getDeviceByIeeeAddr(GHOST), undefined);
        } finally {
            fs.rmSync(dbPath, { force: true });
        }
    });
});

describe('the real line sequence of a rejoin (formats of zigbee-herdsman 10.9.1)', () => {
    // one failed interview as herdsman logs it: join, six node descriptor attempts of ~11 s each with
    // the delivery status lines that carry only the network address, then the final error lines
    function failedInterview(bridge, clock, nwk, tagBase) {
        bridge.handle('debug', `ezspTrustCenterJoinHandler: newNodeId=${nwk} newNodeEui64=${GHOST} status=STANDARD_SECURITY_SECURED_REJOIN policyDecision=USE_PRECONFIGURED_KEY parentOfNewNodeId=12345`, 'zh:ember:ezsp');
        bridge.handle('debug', `Device '${GHOST}' joined`, 'zh:controller');
        bridge.handle('info', `Interview for '${GHOST}' started`, 'zh:controller');
        bridge.handle('debug', `Interview - start device '${GHOST}'`, 'zh:controller:device');
        for (let attempt = 1; attempt <= 6; attempt++) {
            const tag = tagBase + attempt;
            bridge.handle('debug', `~~~> [ZDO NODE_DESCRIPTOR_REQUEST UNICAST to=${GHOST}:${nwk} messageTag=${tag} payload=0000]`, 'zh:ember');
            bridge.handle('debug', `~~~> [SENT ZDO UNICAST messageTag=${tag} apsSequence=${100 + attempt} status=OK]`, 'zh:ember');
            clock.t += 1500;
            bridge.handle('debug', `ezspMessageSentHandler: status=ZIGBEE_DELIVERY_FAILED type=DIRECT indexOrDestination=${nwk} apsFrame={"profileId":0,"clusterId":2} messageTag=${tag}`, 'zh:ember:ezsp');
            bridge.handle('debug', `~x~> DELIVERY_FAILED [indexOrDestination=${nwk} apsFrame={"profileId":0,"clusterId":2} messageTag=${tag}]`, 'zh:ember');
            clock.t += 9500;
            bridge.handle('debug', `Interview - node descriptor request failed for '${GHOST}', attempt ${attempt}`, 'zh:controller:device');
        }
        bridge.handle('debug', `Interview - failed for device '${GHOST}' with error 'Error: Interview failed because can not get node descriptor ('${GHOST}')'`, 'zh:controller:device');
        bridge.handle('error', `Interview failed for '${GHOST} with error 'Error: Interview failed because can not get node descriptor ('${GHOST}')'`, 'zh:controller');
    }

    it('keeps every line of a failed interview at info level, including the status lines without IEEE', () => {
        const clock = { t: 1_000_000 };
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter, clock);
        failedInterview(bridge, clock, 44772, 10);
        assert.strictEqual(adapter.lines.length, 4 + 6 * 5 + 2);
        assert.deepStrictEqual([...new Set(adapter.lines.map(l => l[0]))], ['info']);
        assert.ok(adapter.lines.every(l => l[1].startsWith('[trace ')));
        assert.ok(clock.t - 1_000_000 < TRACE_WINDOW_MS, 'an interview of six attempts fits into the window');
    });

    it('opens a fresh window for the next rejoin minutes later and drops unrelated chatter in between', () => {
        const clock = { t: 1_000_000 };
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter, clock);
        failedInterview(bridge, clock, 44772, 10);
        clock.t += TRACE_WINDOW_MS; // well past the first window
        bridge.handle('debug', 'unrelated frame between the rejoins', 'zh:ember:ezsp');
        const before = adapter.lines.length;
        failedInterview(bridge, clock, 44772, 30);
        assert.strictEqual(adapter.lines.length, before + 4 + 6 * 5 + 2);
        assert.ok(!adapter.lines.some(l => l[1].includes('unrelated frame')));
        assert.deepStrictEqual([...new Set(adapter.lines.map(l => l[0]))], ['info']);
    });

    it('a blocked rejoin ends with the unreachable leave request at info level, not as an error', () => {
        const clock = { t: 5_000_000 };
        const adapter = fakeAdapter();
        const bridge = bridgeFor(adapter, clock);
        bridge.handle('debug', `ezspTrustCenterJoinHandler: newNodeId=44772 newNodeEui64=${GHOST} status=STANDARD_SECURITY_SECURED_REJOIN policyDecision=USE_PRECONFIGURED_KEY parentOfNewNodeId=0`, 'zh:ember:ezsp');
        bridge.handle('debug', `Device '${GHOST}' joined`, 'zh:controller');
        bridge.handle('debug', `Device '${GHOST}' rejected by handler, removing it`, 'zh:controller');
        bridge.handle('debug', `~~~> [ZDO LEAVE_REQUEST UNICAST to=${GHOST}:44772 messageTag=7 payload=00]`, 'zh:ember');
        bridge.handle('debug', '~~~> [SENT ZDO UNICAST messageTag=7 apsSequence=9 status=OK]', 'zh:ember');
        clock.t += 10_000;
        bridge.handle('error', 'Failed to remove rejected device: {"target":44772,"apsFrame":{"profileId":0,"clusterId":52},"zdoResponseClusterId":32820} timed out after 10000ms', 'zh:controller');
        assert.strictEqual(adapter.lines.length, 6);
        assert.deepStrictEqual([...new Set(adapter.lines.map(l => l[0]))], ['info']);
    });
});
