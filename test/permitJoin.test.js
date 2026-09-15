'use strict';

// Tests for closing the network on the coordinator (lib/zigbeecontroller.js): zigbee-herdsman starts the
// coordinator with joining allowed and its pairing countdown only reports its end - the controller has
// to send permitJoin(0) itself after the start and when the countdown ends. The herdsman controller is a
// stub that records every permitJoin() call; no hardware, no network.
// Run:  node --test test/permitJoin.test.js

const { describe, it } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const ZigbeeController = require('../lib/zigbeecontroller');

// the part of zigbee-herdsman's Controller (10.9.1) the network close relies on: permitJoin(0) closes
// the coordinator and emits permitJoinChanged(false) from inside the call, the countdown timer only
// emits permitJoinChanged(false)
class HerdsmanStub extends EventEmitter {
    constructor() {
        super();
        this.permitJoinCalls = [];
        this.failPermitJoin = false;
        this.open = false;
    }
    async start() { return 'resumed'; }
    async stop() { await this.permitJoin(0); }
    async getCoordinatorVersion() { return { type: 'EmberZNet', meta: { revision: '8.0.2' } }; }
    async getNetworkParameters() { return { panID: 0x1a62, channel: 20, extendedPanID: '0x0102030405060708' }; }
    async setLED() {}
    getGroupsIterator() { return [].values(); }
    getPermitJoin() { return this.open; }
    async permitJoin(time) {
        this.open = false;
        if (this.failPermitJoin) throw new Error('[ZDO] Failed set join policy with status=FAIL.');
        this.permitJoinCalls.push(time);
        if (time > 0) {
            this.open = true;
            this.emit('permitJoinChanged', { permitted: true, time });
        } else {
            this.emit('permitJoinChanged', { permitted: false });
        }
    }
    countdownEnded() {
        this.emit('permitJoinChanged', { permitted: false });
        this.open = false;
    }
}

function controllerWith(herdsman) {
    const adapter = {
        config: { listDevicesAtStart: false, readAtAnnounce: true, warnOnDeviceAnnouncement: true, pingTimeout: 300 },
        localConfig: {},
        log: { debug() {}, info() {}, warn() {}, error() {} },
        expandFileName: f => `/nonexistent/${f}`,
    };
    const controller = new ZigbeeController(adapter);
    controller.extensions = []; // availability, configure, event and delayed-action handling need devices
    controller.herdsman = herdsman;
    controller.zbcontrollerStarted = 0;
    const lines = [];
    controller.on('log', (level, msg) => lines.push([level, msg]));
    return { controller, lines };
}

async function started() {
    const herdsman = new HerdsmanStub();
    const { controller, lines } = controllerWith(herdsman);
    await controller.start();
    return { herdsman, controller, lines };
}

const settled = () => new Promise(resolve => setImmediate(resolve));
const count = (lines, level, start) => lines.filter(l => l[0] === level && l[1].startsWith(start)).length;

describe('network close after start', () => {
    it('sends permitJoin(0) once after zigbee-herdsman started and says so', async () => {
        const { herdsman, controller, lines } = await started();
        assert.deepStrictEqual(herdsman.permitJoinCalls, [0]);
        assert.strictEqual(controller.herdsmanStarted, true);
        assert.strictEqual(controller._closingNetwork, false);
        assert.strictEqual(count(lines, 'info', 'Network closed for new devices until pairing is opened'), 1);
        assert.strictEqual(count(lines, 'info', 'Closed Zigbee network'), 0, 'the echo of herdsman is not a countdown end');
    });

    it('does not break the start when the coordinator refuses the close', async () => {
        const herdsman = new HerdsmanStub();
        herdsman.failPermitJoin = true;
        const { controller, lines } = controllerWith(herdsman);
        await controller.start();
        assert.strictEqual(controller.herdsmanStarted, true);
        assert.strictEqual(controller._closingNetwork, false);
        assert.deepStrictEqual(lines.filter(l => l[0] === 'warn'), [['warn', 'Unable to close the network after start: [ZDO] Failed set join policy with status=FAIL.']]);
        assert.strictEqual(count(lines, 'info', 'Network closed'), 0);
    });
});

describe('network close when the pairing countdown ends', () => {
    it('closes the coordinator exactly once when herdsman reports the end of the countdown', async () => {
        const { herdsman, controller, lines } = await started();
        herdsman.permitJoinCalls.length = 0;
        assert.strictEqual(await controller.permitJoin(60), true);
        assert.deepStrictEqual(herdsman.permitJoinCalls, [60]);
        assert.ok(controller._permitJoinInterval, 'the countdown of the adapter runs');
        herdsman.countdownEnded();
        await settled();
        assert.deepStrictEqual(herdsman.permitJoinCalls, [60, 0]);
        assert.strictEqual(controller._permitJoinInterval, null);
        assert.strictEqual(controller._closingNetwork, false);
        assert.strictEqual(count(lines, 'info', 'Closed Zigbee network'), 1);
        assert.strictEqual(count(lines, 'error', 'Error in handlePermitJoinChanged'), 0);
    });

    it('closes once when the network is closed explicitly - the echo of herdsman does not close it again', async () => {
        const { herdsman, controller, lines } = await started();
        herdsman.permitJoinCalls.length = 0;
        await controller.permitJoin(60);
        assert.strictEqual(await controller.permitJoin(0), true);
        await settled();
        assert.deepStrictEqual(herdsman.permitJoinCalls, [60, 0]);
        assert.strictEqual(controller._permitJoinInterval, null);
        assert.strictEqual(count(lines, 'info', 'Closing network.'), 1);
        assert.strictEqual(count(lines, 'info', 'Closed Zigbee network'), 1);
    });

    it('ignores a permitJoinChanged(false) without a running countdown', async () => {
        const { herdsman, controller, lines } = await started();
        herdsman.permitJoinCalls.length = 0;
        herdsman.emit('permitJoinChanged', { permitted: false });
        await settled();
        assert.deepStrictEqual(herdsman.permitJoinCalls, []);
        assert.strictEqual(controller._permitJoinInterval, undefined);
        assert.strictEqual(count(lines, 'info', 'Closed Zigbee network'), 0);
    });

    it('does not talk to a coordinator that is gone when the countdown ends after a disconnect', async () => {
        const { herdsman, controller, lines } = await started();
        herdsman.permitJoinCalls.length = 0;
        await controller.permitJoin(60);
        await controller.handleDisconnected();
        herdsman.countdownEnded();
        await settled();
        assert.deepStrictEqual(herdsman.permitJoinCalls, [60]);
        assert.strictEqual(controller._permitJoinInterval, null);
        assert.strictEqual(count(lines, 'error', 'Error in handlePermitJoinChanged'), 0);
    });

    it('stop() closes through permitJoin(0) and herdsman.stop() only - no third close from the countdown end', async () => {
        const { herdsman, controller, lines } = await started();
        herdsman.permitJoinCalls.length = 0;
        await controller.permitJoin(60);
        await controller.stop();
        await settled();
        assert.deepStrictEqual(herdsman.permitJoinCalls, [60, 0, 0]);
        assert.strictEqual(controller._permitJoinInterval, null);
        assert.strictEqual(controller.herdsmanStarted, false);
        assert.strictEqual(count(lines, 'info', 'Closed Zigbee network'), 1);
    });
});
