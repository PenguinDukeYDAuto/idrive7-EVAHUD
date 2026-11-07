'use strict';
/**
 * EVA's demo drive, in place of the kit's 46 s one: a round of 22 s that shows everything the designs can show.
 *
 *   0-10 s  the drive: a full-throttle pull through four gears to the shift point, a weave at speed in sixth, a surge, a hard stop,
 *           then N, R and P. The oil and then the coolant run hot on the way, so MAGI approves and rejects.
 *   10-22 s every full-screen alert for 2 s, with the car standing in P.
 *
 * Only the demo setting reaches this. Nothing here ever stands in for a reading of a real car.
 *   sample(now) -> what kit/runtime/sim.js gives, and the stage: P, R, N or D
 *   alertAt(now) -> the alert the round has reached, or null
 */
const DRIVE_MS = 10000;
const ALERT_MS = 2000;
const ALERTS = ['knock', 'fuel', 'afr', 'heat', 'boost', 'multi'];     // in the order of their priority, the many last
const ROUND_MS = DRIVE_MS + ALERTS.length * ALERT_MS;
const PULL_S = [1.1, 2.2, 3.4, 4.8];     // when each gear of the pull ends
const TOP_KMH = 175, SURGE_KMH = 158;

const mix = (a, b, p) => a + (b - a) * Math.max(0, Math.min(1, p));
/** Along a list of [t, value]: straight between them. */
const along = (points, t) => {
    if (t <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
        if (t <= points[i][0]) return mix(points[i - 1][1], points[i][1], (t - points[i - 1][0]) / (points[i][0] - points[i - 1][0]));
    }
    return points[points.length - 1][1];
};
const OIL = [[0, 92], [6, 104], [6.8, 133], [7.4, 133], [8.2, 104], [10, 100]];
const COOLANT = [[0, 84], [7.4, 94], [8, 113], [8.5, 113], [9.4, 92], [10, 92]];

class EvaDemo {
    constructor(now) {
        this.t0 = now === undefined ? Date.now() : now;
        this.red = 7000;
    }

    /** The demo's rev limit: the app's redline. */
    setRedline(rpm) { this.red = rpm; }

    _at(now) { return (((now - this.t0) % ROUND_MS) + ROUND_MS) % ROUND_MS; }

    alertAt(now) {
        const t = this._at(now);
        return t < DRIVE_MS ? null : ALERTS[Math.floor((t - DRIVE_MS) / ALERT_MS)];
    }

    /** The full-throttle pull: the revs climb through each gear to the shift point and fall back with the next. */
    _pull(t) {
        let i = 0;
        while (i < PULL_S.length - 1 && t >= PULL_S[i]) i++;
        const from = i ? PULL_S[i - 1] : 0, peak = this.red - 50;
        const rpm = mix(i ? peak * 0.66 : 3000, peak, (t - from) / (PULL_S[i] - from));
        const p = t / PULL_S[PULL_S.length - 1];
        return { stage: 'D', gear: i + 1, rpm, speed: TOP_KMH * (1 - (1 - p) * (1 - p)), throttle: 1, torque: 380 + 200 * Math.sin(Math.min(1, rpm / this.red) * Math.PI * 0.6), gLong: mix(0.9, 0.35, p), gLat: 0 };
    }

    _drive(t) {
        const end = PULL_S[PULL_S.length - 1];
        if (t < end) return this._pull(t);
        if (t < 6.4) {      // lifted, in sixth, weaving at speed
            const w = Math.sin((t - end) * 7);
            return { stage: 'D', gear: 6, rpm: 2300 + 200 * w, speed: mix(TOP_KMH, 150, (t - end) / 1.6), throttle: 0.22 + 0.12 * w, torque: 120 + 50 * w, gLong: -0.15, gLat: 0.9 * w };
        }
        if (t < 7.2) {      // a surge in fifth
            const p = (t - 6.4) / 0.8;
            return { stage: 'D', gear: 5, rpm: mix(3300, 4200, p), speed: mix(150, SURGE_KMH, p), throttle: 0.65, torque: 300, gLong: 0.3, gLat: -0.3 };
        }
        if (t < 8.6) {      // a hard stop, down through the gears
            const p = (t - 7.2) / 1.4, speed = mix(SURGE_KMH, 0, p);
            return { stage: 'D', gear: Math.max(1, Math.ceil((1 - p) * 5)), rpm: Math.max(850, mix(3000, 850, p)), speed, throttle: 0, torque: 0, gLong: -1, gLat: 0 };
        }
        if (t < 9) {        // N, with a blip of the throttle
            const b = Math.sin((t - 8.6) / 0.4 * Math.PI);
            return { stage: 'N', gear: 0, rpm: 850 + 1600 * b, speed: 0, throttle: 0.35 * b, torque: 30, gLong: 0, gLat: 0 };
        }
        if (t < 9.5) return { stage: 'R', gear: -1, rpm: 1100, speed: 5, throttle: 0.08, torque: 60, gLong: 0, gLat: 0 };
        return { stage: 'P', gear: 0, rpm: 780 + 20 * Math.sin(t * 9), speed: 0, throttle: 0, torque: 18, gLong: 0, gLat: 0 };
    }

    sample(now) {
        now = now === undefined ? Date.now() : now;
        const t = Math.min(this._at(now), DRIVE_MS) / 1000;     // the alerts hold the end of the drive: parked
        const d = this._drive(t >= 10 ? 9.99 : t);
        return Object.assign(d, { oil: along(OIL, t), coolant: along(COOLANT, t) });
    }
}

EvaDemo.ROUND_MS = ROUND_MS;

module.exports = EvaDemo;
