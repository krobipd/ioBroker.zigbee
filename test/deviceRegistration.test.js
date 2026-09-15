'use strict';

// Tests for messages that arrive before the adapter has registered their device (lib/statescontroller.js
// waitForDeviceRegistration() / deviceRegistered(), main.js newDevice() / syncDeviceState()).
//
// During the start zigbee-herdsman delivers messages while the adapter is still iterating the devices, and
// right after an interview the first report of the device arrives before newDevice() is through. Such a
// message used to run into 'Unknown getDevStates:0x...: Model "..." not found' (the model definition is
// registered by newDevice()), set info.lasterror and lose the value. Now it waits for the registration.
//
// Runs the real Zigbee class from main.js (real StatesController, real models.js, the real ZHC definition
// of the Aqara WSDCGQ11LM 'lumi.weather') against a stubbed @iobroker/adapter-core with an in-memory
// object store; timers are collected and fired by hand. No hardware, no network.
// Run:  node --test test/deviceRegistration.test.js

const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { describe, it } = require('node:test');
const assert = require('node:assert');

// The Adapter base class with the object/state access the registration and the message path use.
class FakeAdapterBase extends EventEmitter {
    constructor() {
        super();
        this.name = 'zigbee';
        this.namespace = 'zigbee.0';
        this.config = {};
        this.log = { debug() {}, info() {}, warn() {}, error() {}, level: 'info' };
        this.objects = new Map();   // id without namespace -> object
        this.stateWrites = [];      // { id, val, ack } in write order
        this.timers = [];           // { id, fn, ms } of adapter.setTimeout, fired by the test
        this.timerId = 0;
    }
    expandFileName(f) {
        return '/nonexistent/' + f;
    }
    setTimeout(fn, ms) {
        const id = ++this.timerId;
        this.timers.push({ id, fn, ms });
        return id;
    }
    clearTimeout(id) {
        this.timers = this.timers.filter(t => t.id !== id);
    }
    setInterval() {}
    clearInterval() {}
    subscribeStates() {}
    fileExists(namespace, file, callback) {
        callback(null, true);
    }
    key(id) {
        return id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : id;
    }
    merge(target, source) {
        for (const [k, v] of Object.entries(source)) {
            if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') this.merge(target[k], v);
            else target[k] = v;
        }
        return target;
    }
    // callbacks come back asynchronously like from the database (js-controller hands a callback passed
    // to getObjectAsync() through to getObject())
    getObjectAsync(id, callback) {
        const obj = this.objects.get(this.key(id)) ?? null;
        if (typeof callback === 'function') setImmediate(() => callback(null, obj));
        return Promise.resolve(obj);
    }
    getObject(id, callback) {
        setImmediate(() => callback(null, this.objects.get(this.key(id)) ?? null));
    }
    getForeignObjectAsync(id) {
        return this.getObjectAsync(id);
    }
    extendObjectAsync(id, obj) {
        const key = this.key(id);
        const existing = this.objects.get(key);
        this.objects.set(key, existing ? this.merge(existing, JSON.parse(JSON.stringify(obj))) : { _id: `${this.namespace}.${key}`, common: {}, native: {}, ...JSON.parse(JSON.stringify(obj)) });
        return Promise.resolve({ id: `${this.namespace}.${key}` });
    }
    extendObject(id, obj, callback) {
        const promise = this.extendObjectAsync(id, obj);
        if (typeof callback === 'function') promise.then(r => setImmediate(() => callback(null, r)));
        return promise;
    }
    setObjectAsync(id, obj) {
        const key = this.key(id);
        this.objects.set(key, { _id: `${this.namespace}.${key}`, common: {}, native: {}, ...JSON.parse(JSON.stringify(obj)) });
        return Promise.resolve({ id: `${this.namespace}.${key}` });
    }
    setObjectNotExistsAsync(id, obj) {
        if (this.objects.has(this.key(id))) return Promise.resolve(undefined);
        return this.setObjectAsync(id, obj);
    }
    getDevicesAsync() {
        return Promise.resolve([...this.objects.values()].filter(o => o.type === 'device'));
    }
    getStatesOf(id, callback) {
        setImmediate(() => callback(null, []));
    }
    getStateAsync() {
        return Promise.resolve(null);
    }
    getState(id, callback) {
        setImmediate(() => callback(null, null));
    }
    setState(id, val, ack, callback) {
        this.stateWrites.push({ id: this.key(id), val, ack });
        if (typeof callback === 'function') setImmediate(() => callback(null));
    }
    setStateAsync(id, val, ack) {
        this.setState(id, val, ack);
        return Promise.resolve();
    }
    setStateChangedAsync(id, val, ack) {
        return this.setStateAsync(id, val, ack);
    }
}

const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === '@iobroker/adapter-core') return { Adapter: FakeAdapterBase };
    return origLoad.call(this, request, ...rest);
};

const factory = require('../main.js');
const modelDefinitions = require('../lib/models');
const { findByDevice } = require('zigbee-herdsman-converters');

const IEEE = '0x00158d0001a2b3c4';
const ADID = '00158d0001a2b3c4';

// the part of a zigbee-herdsman Device the lookup, the registration and the converters touch
function weatherDevice(overrides) {
    const device = {
        ieeeAddr: IEEE,
        networkAddress: 4711,
        type: 'EndDevice',
        modelID: 'lumi.weather',
        manufacturerName: 'LUMI',
        manufacturerID: 4151,
        powerSource: 'Battery',
        interviewState: 'SUCCESSFUL',
        interviewing: false,
        meta: {},
        endpoints: [{ ID: 1, inputClusters: [0, 3, 1026, 1029, 1027], outputClusters: [0, 4] }],
        getEndpoint(id) {
            return this.endpoints.find(e => e.ID === id);
        },
        save() {},
        ...overrides,
    };
    return device;
}

async function weatherEntity(overrides) {
    const device = weatherDevice(overrides);
    const mapped = await findByDevice(device, false);
    assert.ok(mapped && mapped.model === 'WSDCGQ11LM', 'the ZHC definition of lumi.weather is available');
    return { type: 'device', device, mapped, endpoint: device.getEndpoint(1), endpoints: device.endpoints, name: mapped.model, id: ADID, options: {} };
}

function temperatureReport(device, measuredValue) {
    return {
        type: 'attributeReport',
        device,
        endpoint: device.getEndpoint(1),
        cluster: 'msTemperatureMeasurement',
        data: { measuredValue },
        linkquality: 120,
        groupID: 0,
        meta: { zclTransactionSequenceNumber: 1 },
    };
}

function mkAdapter() {
    const adapter = factory({});
    adapter.stController.localConfig.localData = { by_id: {}, by_model: {} };
    adapter.stController.localConfig.retainData = async () => {};
    adapter.stController.downloadIconToAdmin = async () => {}; // keeps the test offline
    adapter.stController.debugDevices = [];
    adapter.zbController = {
        resolveEntity: () => Promise.resolve(undefined),
        getClientIterator: () => [].values(),
        callExtensionMethod: () => Promise.resolve([]),
        setDeviceDisabled() {},
    };
    const lines = [];
    adapter.stController.on('log', (level, msg) => lines.push([level, msg]));
    const stashed = [];
    const origStash = adapter.stController.stashUnknownModel.bind(adapter.stController);
    adapter.stController.stashUnknownModel = (key, msg) => {
        stashed.push([key, msg]);
        return origStash(key, msg);
    };
    return { adapter, st: adapter.stController, lines, stashed };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settled(times = 20) {
    for (let i = 0; i < times; i++) await tick();
}
const temperatureWrites = adapter => adapter.stateWrites.filter(w => w.id === `${ADID}.temperature`);
const count = (lines, level, start) => lines.filter(l => l[0] === level && l[1].startsWith(start)).length;

// a fresh adapter per test - the model registry of models.js is a module singleton, so it is cleared too
async function fresh() {
    await modelDefinitions.clearModelDefinitions();
    const t = mkAdapter();
    t.st.registeredDevices.clear();
    return t;
}

// a message that is never released would hang the test - the timeout turns that into a failure
describe('a message that arrives before its device is registered', { timeout: 10000 }, () => {
    it('waits for newDevice() and is processed with the model afterwards - no "Model not found", the value arrives', async () => {
        const { adapter, st, lines, stashed } = await fresh();
        const entity = await weatherEntity();

        const done = st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        await settled();
        assert.strictEqual(st.registrationGates.size, 1, 'the message waits');
        assert.strictEqual(adapter.timers.length, 1, 'one wait timer');
        assert.deepStrictEqual(stashed, []);
        assert.deepStrictEqual(temperatureWrites(adapter), []);

        await adapter.newDevice(entity);
        await done;
        await settled();

        assert.deepStrictEqual(stashed, [], 'the model is found');
        assert.strictEqual(adapter.stateWrites.filter(w => w.id === 'info.lasterror').length, 0);
        assert.deepStrictEqual(temperatureWrites(adapter).map(w => w.val), [21.5]);
        assert.strictEqual(st.registrationGates.size, 0);
        assert.strictEqual(adapter.timers.length, 0, 'the wait timer is cleared');
        assert.ok(st.registeredDevices.has(IEEE));
        assert.strictEqual(count(lines, 'info', '1 message from'), 1);
        assert.strictEqual(count(lines, 'error', 'Unknown getDevStates'), 0);
    });

    it('passes without waiting once the device is registered', async () => {
        const { adapter, st, lines } = await fresh();
        const entity = await weatherEntity();
        await adapter.newDevice(entity);
        adapter.stateWrites.length = 0;

        await st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2275));
        await settled();

        assert.deepStrictEqual(temperatureWrites(adapter).map(w => w.val), [22.75]);
        assert.strictEqual(st.registrationGates.size, 0);
        assert.strictEqual(adapter.timers.length, 0);
        assert.strictEqual(count(lines, 'info', '1 message from'), 0);
    });

    it('is processed anyway when the registration does not happen within the wait - once, with a warning', async () => {
        const { adapter, st, lines, stashed } = await fresh();
        const entity = await weatherEntity();

        const done = st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        await settled();
        assert.strictEqual(adapter.timers.length, 1);
        assert.strictEqual(adapter.timers[0].ms, 30000);
        const timer = adapter.timers[0];
        adapter.timers.length = 0;
        timer.fn();
        await done;
        await settled();

        const warnings = lines.filter(l => l[0] === 'warn');
        assert.strictEqual(warnings.length, 1, JSON.stringify(warnings));
        assert.match(warnings[0][1], new RegExp(`^Device '.*${IEEE}\\)' was not registered within 30 s - processing 1 waiting message anyway$`));
        // the message ran into the usual handling of a missing model
        assert.deepStrictEqual(stashed.map(s => s[0]), [`getDevStates:${IEEE}`]);
        assert.strictEqual(count(lines, 'error', 'Unknown getDevStates'), 1);
        assert.ok(st.registeredDevices.has(IEEE), 'the device is not held back again');

        await st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        assert.strictEqual(st.registrationGates.size, 0, 'the next message does not wait');
        assert.strictEqual(adapter.timers.length, 0);
    });

    it('never holds back an unsupported device, a failed interview or the coordinator', async () => {
        const { st } = await fresh();
        const entity = await weatherEntity();

        const unsupported = { ...entity, mapped: undefined };
        await st.onZigbeeEvent('attributeReport', unsupported, temperatureReport(entity.device, 2150));
        const failed = await weatherEntity({ interviewState: 'FAILED' });
        await st.onZigbeeEvent('attributeReport', failed, temperatureReport(failed.device, 2150));
        // resolveEntity() maps the coordinator to { model: 'Coordinator' } - a mapped entity without a newDevice()
        const coordinatorDevice = weatherDevice({ type: 'Coordinator', modelID: undefined });
        const coordinator = { type: 'device', device: coordinatorDevice, mapped: { model: 'Coordinator' }, endpoint: coordinatorDevice.getEndpoint(1), name: 'Coordinator' };
        await st.onZigbeeEvent('attributeReport', coordinator, temperatureReport(coordinatorDevice, 2150));

        assert.strictEqual(st.registrationGates.size, 0);
    });

    it('stop() drops the waiting messages and clears the timer, nothing waits afterwards', async () => {
        const { adapter, st, stashed } = await fresh();
        const entity = await weatherEntity();

        const done = st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        await settled();
        await st.stop();
        await done;
        await settled();

        assert.deepStrictEqual(temperatureWrites(adapter), []);
        assert.deepStrictEqual(stashed, []);
        assert.strictEqual(adapter.timers.length, 0);
        assert.strictEqual(st.registrationGates.size, 0);

        await st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        assert.strictEqual(st.registrationGates.size, 0);
        assert.strictEqual(adapter.timers.length, 0);
    });

    it('a device that left drops its waiting messages and waits again for its registration when paired again', async () => {
        const { adapter, st, stashed } = await fresh();
        const entity = await weatherEntity();
        await adapter.newDevice(entity);
        assert.ok(st.registeredDevices.has(IEEE));

        st.leaveDevice(IEEE, entity.mapped.model);
        assert.ok(!st.registeredDevices.has(IEEE));
        adapter.stateWrites.length = 0;

        const done = st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        await settled();
        assert.strictEqual(st.registrationGates.size, 1, 'the message of the re-paired device waits');
        st.leaveDevice(IEEE, entity.mapped.model);
        await done;
        await settled();
        assert.deepStrictEqual(temperatureWrites(adapter), [], 'dropped with the device');
        assert.deepStrictEqual(stashed, []);
        assert.strictEqual(adapter.timers.length, 0);

        const again = st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        await settled();
        await adapter.newDevice(entity, true);
        await again;
        await settled();
        assert.deepStrictEqual(temperatureWrites(adapter).map(w => w.val), [21.5]);
    });

    it('lets a message through at once when 50 are already waiting for the same device', async () => {
        const { adapter, st, stashed } = await fresh();
        const entity = await weatherEntity();

        const waiting = [];
        for (let i = 0; i < 50; i++) waiting.push(st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2000 + i)));
        await settled();
        assert.strictEqual(st.registrationGates.get(IEEE).waiters.length, 50);

        await st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        await settled();
        assert.strictEqual(st.registrationGates.get(IEEE).waiters.length, 50, 'the 51st did not queue');
        assert.deepStrictEqual(stashed.map(s => s[0]), [`getDevStates:${IEEE}`], 'the 51st ran into the missing model');

        await adapter.newDevice(entity);
        await Promise.all(waiting);
        await settled(200);
        assert.strictEqual(temperatureWrites(adapter).length, 50);
        assert.strictEqual(adapter.timers.length, 0);
    });

    it('processes waiting messages in the order they arrived', async () => {
        const { adapter, st } = await fresh();
        const entity = await weatherEntity();

        const waiting = [2100, 2200, 2300].map(v => st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, v)));
        await settled();
        await adapter.newDevice(entity);
        await Promise.all(waiting);
        await settled(50);

        assert.deepStrictEqual(temperatureWrites(adapter).map(w => w.val), [21, 22, 23]);
    });

    it('a plain syncDeviceState() (no rebuild) registers nothing and does not release a waiting message', async () => {
        const { adapter, st, stashed } = await fresh();
        const entity = await weatherEntity();

        const done = st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        await settled();
        adapter.zbController.resolveEntity = () => Promise.resolve(entity);
        await adapter.syncDeviceState(entity.device, false); // the start runs this for every device after 'ready'
        await settled();
        assert.strictEqual(st.registrationGates.size, 1, 'still waiting for newDevice()');
        assert.ok(!st.registeredDevices.has(IEEE));
        assert.deepStrictEqual(temperatureWrites(adapter), []);
        // the sync itself looked the model up without a registration (its own stash, not the message's)
        const stashedBySync = stashed.length;

        await adapter.newDevice(entity);
        await done;
        await settled();
        assert.strictEqual(stashed.length, stashedBySync, 'the message found the model');
        assert.deepStrictEqual(temperatureWrites(adapter).map(w => w.val), [21.5]);
    });

    it('waits again after the model definitions were cleared until syncDeviceState() registered the device', async () => {
        const { adapter, st, stashed } = await fresh();
        const entity = await weatherEntity();
        await adapter.newDevice(entity);
        adapter.stateWrites.length = 0;

        await st.clearModelDefinitions();
        assert.ok(!st.registeredDevices.has(IEEE));
        const done = st.onZigbeeEvent('attributeReport', entity, temperatureReport(entity.device, 2150));
        await settled();
        assert.strictEqual(st.registrationGates.size, 1);

        adapter.zbController.resolveEntity = () => Promise.resolve(entity);
        await adapter.syncDeviceState(entity.device, true);
        await done;
        await settled();

        assert.deepStrictEqual(stashed, []);
        assert.deepStrictEqual(temperatureWrites(adapter).map(w => w.val), [21.5]);
        assert.ok(st.registeredDevices.has(IEEE));
    });
});
