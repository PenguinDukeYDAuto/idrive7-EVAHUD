'use strict';
/**
 * The NERV mark's occasional flicker (shared/eva_flicker.js): when it happens and how fast.
 *   node bench/test/eva_flicker_test.js
 */
const assert = require('assert');
const { Flicker } = require('../../shared/eva_flicker');

const fixed = (r) => () => r;
const make = (random) => new Flicker({ gapMs: [20000, 45000], flashes: 3, phaseMs: 250, random: random || fixed(0) });

/** The on/off pattern from now, one sample every 50 ms, as the app's tick asks. */
function trace(f, from, ms) {
    const out = [];
    for (let t = from; t < from + ms; t += 50) out.push(f.on(t));
    return out;
}
const rises = (a) => a.reduce((n, v, i) => n + (v && !a[i - 1] ? 1 : 0), 0);

const tests = {
    'it starts steady, for the first gap'() {
        const f = make();
        assert.ok(trace(f, 0, 19950).every((v) => !v));
    },
    'then it flashes exactly as many times as asked'() {
        const f = make();
        const all = trace(f, 0, 21500);
        assert.strictEqual(rises(all), 3);
    },
    'each flash lasts the phase, and so does each gap between them'() {
        const f = make();
        f.on(0);
        assert.strictEqual(f.on(20000), true);
        assert.strictEqual(f.on(20249), true);
        assert.strictEqual(f.on(20250), false);
        assert.strictEqual(f.on(20499), false);
        assert.strictEqual(f.on(20500), true);
    },
    'after a burst it is steady again until the next gap has passed'() {
        const f = make();
        trace(f, 0, 21500);
        assert.ok(trace(f, 21500, 19000).every((v) => !v));
        assert.ok(trace(f, 40500, 2000).some((v) => v));
    },
    'the gap varies: it follows the random draw across the whole range'() {
        const slow = make(fixed(0.999));
        slow.on(0);
        assert.strictEqual(slow.on(44000), false);
        assert.strictEqual(slow.on(45000), true);
    },
    'successive gaps differ'() {
        const draws = [0, 1];
        const f = make(() => (draws.length ? draws.shift() : 0));
        f.on(0);
        assert.strictEqual(f.on(20000), true);     // gap of 20 s
        trace(f, 20000, 1550);                     // the burst ends at 21500, and the next draw is the longest
        assert.strictEqual(f.on(21500 + 40000), false);
        assert.strictEqual(f.on(21500 + 45000), true);
    },
    'a long time unseen (an alert, a pop-up) does not leave it flashing or catching up'() {
        const f = make();
        f.on(0);
        assert.strictEqual(f.on(1000000), false);
        assert.ok(trace(f, 1000050, 19000).every((v) => !v));
    },
    'a broken range does not stop the app: it stays steady'() {
        const f = new Flicker({ gapMs: null, flashes: 3, phaseMs: 250 });
        assert.ok(trace(f, 0, 60000).every((v) => !v));
        const none = new Flicker({ gapMs: [20000, 45000], flashes: 0, phaseMs: 250, random: fixed(0) });
        assert.ok(trace(none, 0, 60000).every((v) => !v));
    },
};

let failed = 0;
Object.keys(tests).forEach((name) => {
    try { tests[name](); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
});
console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
