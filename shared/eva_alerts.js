'use strict';
/**
 * When the EVA HUD's full-screen alerts show. Only the rules: no renderer, no signals, no clock of its own,
 * so bench/test/eva_alerts_test.js can run them by hand.
 *
 *   const e = new AlertEngine({ thresholds: { knock, heat, boost, fuel, afrLow, afrHigh } });
 *   e.update(nowMs, { rpm, pedal, values: { knock: { v, at }, heat: ..., boost: ..., fuel: ..., afr: ... } })
 *       -> null | { kind: 'single', id, value } | { kind: 'multi', ids, count }
 *   e.dismiss()              the alerts up now stay hidden until they clear and trip again
 *   e.setThresholds(t)       a limit of null switches that alert off
 *
 * A wrong full-screen alert is worse than a late one, so:
 * - nothing is judged until the engine has run for armMs; a stopped engine clears everything at once;
 * - a reading that is missing, not a number or older than staleMs clears its alert at once, without the hold;
 * - the mixture is only judged with the pedal past 50 % (not on a lift-off, when fuel cut reads very lean).
 * An alert shows at once, and goes holdMs after its value has come back past the limit by the hysteresis.
 */
const PRIORITY = ['knock', 'fuel', 'afr', 'heat', 'boost'];
const HYSTERESIS = { knock: 1, heat: 3, boost: 0.15, fuel: 5, afr: 0.3 };
const PEDAL_FOR_AFR = 50;
const RUNNING_RPM = 500;

const isNum = (v) => typeof v === 'number' && isFinite(v);

class AlertEngine {
    constructor(opts) {
        const o = opts || {};
        this.thresholds = o.thresholds || {};
        this.armMs = o.armMs === undefined ? 5000 : o.armMs;
        this.holdMs = o.holdMs === undefined ? 2000 : o.holdMs;
        this.staleMs = o.staleMs === undefined ? 3000 : o.staleMs;
        this.rotateMs = o.rotateMs === undefined ? 2000 : o.rotateMs;
        this.runningSince = null;
        this.state = {};           // id -> { value, clearAt, dismissed }
        this.pair = null;          // the two ids taking turns, and since when
        this.pairAt = 0;
    }

    setThresholds(t) { this.thresholds = t || {}; }

    dismiss() { Object.keys(this.state).forEach((id) => { this.state[id].dismissed = true; }); }

    /** 1 past the limit, 0 in the hysteresis band, -1 clearly inside it, null when this alert is off. */
    _judge(id, v, pedal) {
        const t = this.thresholds, band = HYSTERESIS[id];
        if (id === 'afr') {
            if (!isNum(t.afrLow) && !isNum(t.afrHigh)) return null;
            if (!isNum(pedal) || pedal <= PEDAL_FOR_AFR) return -1;
            if ((isNum(t.afrLow) && v <= t.afrLow) || (isNum(t.afrHigh) && v >= t.afrHigh)) return 1;
            const inside = (!isNum(t.afrLow) || v > t.afrLow + band) && (!isNum(t.afrHigh) || v < t.afrHigh - band);
            return inside ? -1 : 0;
        }
        const limit = t[id];
        if (!isNum(limit)) return null;
        if (id === 'fuel') return v <= limit ? 1 : (v > limit + band ? -1 : 0);
        return v >= limit ? 1 : (v < limit - band ? -1 : 0);
    }

    _channel(id, now, input) {
        const r = input.values && input.values[id];
        if (!r || !isNum(r.v) || !isNum(r.at) || now - r.at > this.staleMs) { delete this.state[id]; return; }
        const j = this._judge(id, r.v, input.pedal);
        if (j === null) { delete this.state[id]; return; }
        const st = this.state[id];
        if (j === 1) {
            if (st) { st.value = r.v; st.clearAt = null; } else this.state[id] = { value: r.v, clearAt: null, dismissed: false };
        } else if (st) {
            st.value = r.v;
            if (j === 0) st.clearAt = null;
            else if (st.clearAt === null) st.clearAt = now + this.holdMs;
            else if (now >= st.clearAt) delete this.state[id];
        }
    }

    update(now, input) {
        if (!isNum(input.rpm) || input.rpm < RUNNING_RPM) {
            this.runningSince = null; this.state = {}; this.pair = null;
            return null;
        }
        if (this.runningSince === null) this.runningSince = now;
        if (now - this.runningSince < this.armMs) return null;
        PRIORITY.forEach((id) => this._channel(id, now, input));

        const ids = PRIORITY.filter((id) => this.state[id] && !this.state[id].dismissed);
        if (ids.length !== 2) this.pair = null;
        if (!ids.length) return null;
        if (ids.length > 2) return { kind: 'multi', ids, count: ids.length };
        let id = ids[0];
        if (ids.length === 2) {
            const key = ids.join();
            if (this.pair !== key) { this.pair = key; this.pairAt = now; }
            id = ids[Math.floor((now - this.pairAt) / this.rotateMs) % 2];
        }
        return { kind: 'single', id, value: this.state[id].value };
    }
}

module.exports = { AlertEngine, PRIORITY };
