'use strict';

// Bridge between the log output of zigbee-herdsman / zigbee-herdsman-converters and the adapter log.
//
// Both libraries write through their own module-level logger, which defaults to console.*. The adapter
// runs as a child process of js-controller with stdout ignored, so without this bridge every warning
// and error the libraries report is lost - and the 'debugHerdsman' option has been without effect
// since zigbee-herdsman stopped using the 'debug' package.
//
// Mapping (outside a join trace):
//   library debug   -> adapter debug, only while 'debugHerdsman' is enabled
//   library info    -> adapter debug (the adapter reports the same events in its own words)
//   library warning -> adapter warn
//   library error   -> adapter error
// Debug/info lines of the byte-level namespaces (uart, ash, unpi, tokens) are always dropped.
//
// Join trace: a device that never completed its interview has no object and no states - the adapter
// only ever shows 'Starting interview' / 'Failed to interview' for it. The join type, the parent router
// it came in through and the delivery status of every interview request are debug lines of the
// libraries. While the network is closed, every library line naming such a device is logged at info
// level; its join line registers the device for TRACE_WINDOW_MS, and in that time the lines that carry
// only its network address (delivery status, route errors, the timeout of a leave request) are logged
// at info level as well. The lines that set the join policy of the coordinator are always logged at
// info level. Nothing is sent to the network for this; it only decides what the libraries already log.

const TRACE_WINDOW_MS = 180000;
const BYTE_LEVEL_NAMESPACE = /(?::uart|:ash|:unpi|:tokens)(?::|$)/;
const IEEE_ADDRESSES = /0x[0-9a-f]{16}/gi;
const NOT_A_DEVICE = new Set(['0x0000000000000000', '0xffffffffffffffff']);
// texts of the library lines that start (or end) a join of a device
const JOIN_MARKERS = ['TrustCenterJoin', ' joined', 'rejected by handler'];
// the network address in front of the IEEE address in the join line of ember: 'newNodeId=44772 newNodeEui64=0x...'
const NWK_BEFORE_IEEE = /newNodeId=(\d+) newNodeEui64=(0x[0-9a-f]{16})/i;
// text of the ember lines that set the join policy of the coordinator (two per pairing, two per start)
const POLICY_MARKER = 'TRUST_CENTER_POLICY';

class LibraryLogBridge {
    constructor(adapter) {
        this.adapter = adapter;
        this.active = false;
        this.tracked = new Map(); // IEEE -> { nwk, pattern, until } of the devices whose join is traced
        this.deciding = false;
    }

    /** Route the loggers of both libraries through handle(). Returns the names of the attached libraries. */
    install() {
        const logger = {
            debug: (message, namespace) => this.handle('debug', message, namespace),
            info: (message, namespace) => this.handle('info', message, namespace),
            warning: (message, namespace) => this.handle('warning', message, namespace),
            error: (message, namespace) => this.handle('error', message, namespace),
        };
        this.active = true;
        const attached = [];
        for (const name of ['zigbee-herdsman', 'zigbee-herdsman-converters']) {
            try {
                const library = require(name);
                if (typeof library.setLogger !== 'function') {
                    throw new Error('setLogger is not exported');
                }
                library.setLogger(logger);
                attached.push(name);
            } catch (error) {
                this.adapter.log.warn(`Log output of ${name} stays on the console: ${error.message}`);
            }
        }
        return attached;
    }

    /** Stop forwarding; the libraries keep the bridge, so every later line is dropped silently. */
    stop() {
        this.active = false;
    }

    /**
     * Entry point for all four levels of both libraries. Must never throw - it is called from inside the
     * libraries' own code paths.
     */
    handle(level, messageOrLambda, namespace) {
        try {
            if (!this.active) return;
            const ns = (typeof namespace === 'string' && namespace) ? namespace : 'lib';
            const diagnostic = level === 'debug' || level === 'info';
            if (diagnostic && BYTE_LEVEL_NAMESPACE.test(ns)) return;
            const message = String(typeof messageOrLambda === 'function' ? messageOrLambda() : messageOrLambda);
            const log = this.adapter.log;

            if (message.includes(POLICY_MARKER)) {
                log.info(`[${ns}] ${message}`);
                return;
            }
            if (this.traced(message)) {
                log.info(`[trace ${ns}] ${message}`);
                return;
            }

            switch (level) {
                case 'error':
                    log.error(`[${ns}] ${message}`);
                    break;
                case 'warning':
                    log.warn(`[${ns}] ${message}`);
                    break;
                case 'info':
                    log.debug(`[${ns}] ${message}`);
                    break;
                default:
                    if (this.adapter.config && this.adapter.config.debugHerdsman) log.debug(`[${ns}] ${message}`);
            }
        } catch (error) {
            try {
                this.adapter.log.debug(`library log bridge: ${error && error.message ? error.message : error}`);
            } catch {
                // nothing left that could take the message
            }
        }
    }

    /**
     * Decide whether the line belongs to the join trace and keep the traced devices. A failure in the
     * device lookup (database not injected yet, re-entered from the lookup's own logging) leaves the
     * line on the normal mapping - it is never lost.
     */
    traced(message) {
        if (this.deciding) return false;
        this.deciding = true;
        try {
            if (this.networkOpen()) return false;
            const now = this.now();
            for (const [ieee, entry] of this.tracked) {
                if (entry.until <= now) this.tracked.delete(ieee);
            }
            const ieee = this.tracedDeviceIn(message);
            if (ieee) {
                this.track(ieee, message, now);
                return true;
            }
            for (const entry of this.tracked.values()) {
                if (entry.pattern && entry.pattern.test(message)) return true;
            }
            return false;
        } catch {
            return false;
        } finally {
            this.deciding = false;
        }
    }

    /** Register the device on its join line; learn its network address from any traced line that carries it. */
    track(ieee, message, now) {
        const entry = this.tracked.get(ieee);
        const joined = JOIN_MARKERS.some(marker => message.includes(marker));
        if (!entry && !joined) return;
        const nwk = this.nwkIn(message, ieee) || (entry ? entry.nwk : undefined);
        this.tracked.set(ieee, {
            nwk,
            // the address stands alone in the line: 44772 in 'indexOrDestination=44772', not in 144772
            pattern: nwk ? new RegExp(`(?<![0-9])${nwk}(?![0-9])`) : undefined,
            until: joined ? now + TRACE_WINDOW_MS : entry.until,
        });
    }

    /** Network address of the device in the line, from 'newNodeId=<nwk> newNodeEui64=<ieee>' or '<ieee>:<nwk>'. */
    nwkIn(message, ieee) {
        const join = message.match(NWK_BEFORE_IEEE);
        const request = message.match(new RegExp(`${ieee}:(\\d+)`, 'i'));
        const nwk = join && join[2].toLowerCase() === ieee ? join[1] : request ? request[1] : undefined;
        return Number(nwk) > 0 ? nwk : undefined;
    }

    /** IEEE address named in the line whose device never completed its interview, if any. */
    tracedDeviceIn(message) {
        const found = message.match(IEEE_ADDRESSES);
        if (!found) return undefined;
        for (const raw of found) {
            const ieee = raw.toLowerCase();
            if (NOT_A_DEVICE.has(ieee)) continue;
            const device = this.deviceByIeee(ieee);
            if (!device || device.interviewState !== 'SUCCESSFUL') return ieee;
        }
        return undefined;
    }

    deviceByIeee(ieee) {
        const herdsman = this.adapter.zbController ? this.adapter.zbController.herdsman : undefined;
        if (!herdsman || typeof herdsman.getDeviceByIeeeAddr !== 'function') return undefined;
        return herdsman.getDeviceByIeeeAddr(ieee);
    }

    now() {
        return Date.now();
    }

    /** true while devices are allowed to join - their interviews are wanted, not traced. */
    networkOpen() {
        const herdsman = this.adapter.zbController ? this.adapter.zbController.herdsman : undefined;
        if (!herdsman || typeof herdsman.getPermitJoin !== 'function') return false;
        return herdsman.getPermitJoin() === true;
    }
}

module.exports = { LibraryLogBridge, TRACE_WINDOW_MS };
