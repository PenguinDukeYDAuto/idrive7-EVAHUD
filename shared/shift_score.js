'use strict';
/**
 * Shift scoring and the cold-engine rev guard, for the Redline HUD layout. The rules are ported
 * from cauliflowermossgrape's Redline app (apps/redline/main.js, MIT, Copyright (c) 2026
 * cauliflowermossgrape), with the petrol defaults this car needs:
 *
 *  - shift point = redline - "shiftBefore" (never below 2500 rpm)
 *  - cold guard ("coldGuard" on): until the oil reaches 80 °C the shift point is pulled down to
 *    4500 rpm at 30 °C oil and climbs with the oil temperature, in 50 rpm steps
 *  - every upshift (gear number +1; or, with no gear signal, rpm falling over 18 % within 0.4 s
 *    while moving) is scored on the highest rpm in the 0.6 s before it:
 *    LIMITER (within 60 rpm of the redline), EARLY (over 250 under the shift point),
 *    LATE (over 200 above it; COLD REV while the guard holds it down), else SPOT ON.
 *    Shifts under 2500 rpm aren't scored.
 *  - peak rpm, held 15 s; limiter hits counted per session.
 *
 *   const score = new ShiftScore(car, () => ({ redline, shiftBefore, coldGuard }), log)
 *   score.shiftPoint(oil) -> { rpm, cold }
 *   score.last -> { at, from, to, rpm, target, verdict } or null; score.peak, score.limiterHits
 */
const WARM_OIL = 80;           // °C
const COLD_LIMIT = 4500;       // rpm at 30 °C oil (Redline's petrol default)
const PEAK_HOLD_MS = 15000;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

class ShiftScore {
    constructor(car, opts, log) {
        this.opts = opts;
        this.log = log;
        this.car = car;
        this.last = null;
        this.peak = 0;
        this.peakT = 0;
        this.limiterHits = 0;
        this.recent = [];          // [t, rpm, speed], the last ~1.2 s
        this.lastGear = null;
        this.onLimiter = false;
        car.onSample((d, t) => this._sample(d, t), () => { this.recent.length = 0; this.lastGear = null; });
    }

    _normal() { const o = this.opts(); return Math.max(2500, o.redline - o.shiftBefore); }

    /** The shift point right now: lowered while the oil is cold (cold guard on). */
    shiftPoint(oil) {
        const n = this._normal();
        if (!this.opts().coldGuard || !isNum(oil) || oil >= WARM_OIL) return { rpm: n, cold: false };
        const cold = Math.min(COLD_LIMIT, n);
        const f = clamp((oil - 30) / (WARM_OIL - 30), 0, 1);
        return { rpm: Math.round((cold + (n - cold) * f) / 50) * 50, cold: true };
    }

    verdict(rpm, target, cold) {
        const red = this.opts().redline;
        return rpm >= red - 60 ? 'LIMITER' : rpm < target - 250 ? 'EARLY' : rpm > target + 200 ? (cold ? 'COLD REV' : 'LATE') : 'SPOT ON';
    }

    _record(t, from, to) {
        const win = this.recent.filter((r) => t - r[0] < 600);
        if (!win.length) return;
        const rpm = Math.max.apply(null, win.map((r) => r[1]));
        if (!(rpm > 2500)) return;
        const sp = this.shiftPoint(this.car.data().oil);
        this.last = { at: Date.now(), from, to, rpm: Math.round(rpm), target: sp.rpm, verdict: this.verdict(rpm, sp.rpm, sp.cold) };
        this.log.info('shift ' + from + '->' + to + ' @' + this.last.rpm + ' (shift point ' + sp.rpm + ') ' + this.last.verdict);
    }

    _sample(d, t) {
        if (!isNum(d.rpm)) return;
        const r = this.recent;
        r.push([t, d.rpm, d.speed]);
        while (r.length && t - r[0][0] > 1200) r.shift();
        const now = Date.now();
        if (d.rpm >= this.peak || now - this.peakT > PEAK_HOLD_MS) { this.peak = d.rpm; this.peakT = now; }
        const lim = d.rpm >= this.opts().redline - 60;
        if (lim && !this.onLimiter) this.limiterHits++;
        this.onLimiter = lim;
        const g = d.gear;
        if (isNum(g) && g > 0 && isNum(this.lastGear) && this.lastGear > 0 && g === this.lastGear + 1) this._record(t, this.lastGear, g);
        else if (!isNum(g) && r.length > 4 && d.speed > 10) {
            const back = r.filter((x) => t - x[0] < 400);
            const hi = Math.max.apply(null, back.map((x) => x[1]));
            if (hi > 3000 && d.rpm < hi * 0.82 && (!this.last || now - this.last.at > 800)) this._record(t, '?', '?');
        }
        if (isNum(g)) this.lastGear = g;
    }
}

module.exports = ShiftScore;
