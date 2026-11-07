'use strict';
/**
 * EVA's demo drive (shared/eva_demo.js): a round of 10 s of busy driving, then each full-screen alert for 2 s.
 *   node bench/test/eva_demo_test.js
 */
const assert = require('assert');
const EvaDemo = require('../../shared/eva_demo');

const T0 = 1000000;
const demo = () => { const d = new EvaDemo(T0); d.setRedline(7000); return d; };
const drive = (d, from, to, step) => { const out = []; for (let t = from || 0; t < (to || 10000); t += step || 50) out.push(Object.assign({ t }, d.sample(T0 + t))); return out; };

const tests = {
    'a round is 10 s of driving, then each alert for exactly 2 s, and then it starts over'() {
        const d = demo();
        assert.strictEqual(EvaDemo.ROUND_MS, 22000);
        for (let t = 0; t < 10000; t += 100) assert.strictEqual(d.alertAt(T0 + t), null, t + ' ms');
        const seen = [];
        for (let t = 10000; t < 22000; t += 100) { const a = d.alertAt(T0 + t); if (seen[seen.length - 1] !== a) seen.push(a); }
        assert.deepStrictEqual(seen, ['knock', 'fuel', 'afr', 'heat', 'boost', 'multi']);
        [[10000, 'knock'], [11999, 'knock'], [12000, 'fuel'], [13999, 'fuel'], [14000, 'afr'], [16000, 'heat'], [18000, 'boost'], [20000, 'multi'], [21999, 'multi']].forEach(([t, id]) => assert.strictEqual(d.alertAt(T0 + t), id, t + ' ms'));
        assert.strictEqual(d.alertAt(T0 + 22000), null);
        assert.strictEqual(d.alertAt(T0 + 22000 + 10000), 'knock');
    },
    'the 10 s go through every gear, and P, R and N'() {
        const s = drive(demo());
        [1, 2, 3, 4, 5, 6].forEach((g) => assert.ok(s.some((x) => x.stage === 'D' && x.gear === g), 'no gear ' + g));
        ['D', 'N', 'R', 'P'].forEach((k) => assert.ok(s.some((x) => x.stage === k), 'no ' + k));
        assert.ok(s.filter((x) => x.stage === 'R').every((x) => x.gear === -1), 'R should read as reverse');
        assert.ok(s.filter((x) => x.stage === 'P').every((x) => x.speed === 0), 'a parked car should stand still');
    },
    'the revs reach the shift point and the speed covers a wide range, without jumping about'() {
        const s = drive(demo());
        assert.ok(Math.max.apply(null, s.map((x) => x.rpm)) >= 6800, 'the shift point is never reached');
        assert.ok(s.every((x) => x.rpm <= 7030), 'over the limiter');
        assert.ok(Math.max.apply(null, s.map((x) => x.speed)) >= 150);
        for (let i = 1; i < s.length; i++) assert.ok(Math.abs(s[i].speed - s[i - 1].speed) < 12, 'speed jumps at ' + s[i].t);
    },
    'the revs follow the redline the owner set'() {
        const d = new EvaDemo(T0); d.setRedline(6000);
        const peak = Math.max.apply(null, drive(d).map((x) => x.rpm));
        assert.ok(peak >= 5800 && peak <= 6030, String(peak));
    },
    'the pedal, the torque and the g forces all move'() {
        const s = drive(demo());
        const span = (k) => Math.max.apply(null, s.map((x) => x[k])) - Math.min.apply(null, s.map((x) => x[k]));
        assert.strictEqual(Math.max.apply(null, s.map((x) => x.throttle)), 1);
        assert.strictEqual(Math.min.apply(null, s.map((x) => x.throttle)), 0);
        assert.ok(span('torque') > 300, 'torque');
        assert.ok(span('gLong') > 1, 'long g');
        assert.ok(span('gLat') > 1, 'lat g');
    },
    'the temperatures take MAGI through every verdict: approved, the oil rejected, the coolant rejected'() {
        const s = drive(demo());
        assert.ok(s.some((x) => x.oil >= 80 && x.oil < 130 && x.coolant >= 70 && x.coolant < 110), 'never approved');
        assert.ok(s.some((x) => x.oil >= 130), 'the oil never rejects');
        assert.ok(s.some((x) => x.coolant >= 110), 'the coolant never rejects');
        assert.ok(s.every((x) => x.coolant < 118), 'that would be a real overheat');
    },
    'while the alerts show the car stands in P'() {
        const s = drive(demo(), 10000, 22000, 200);
        assert.ok(s.every((x) => x.stage === 'P' && x.speed === 0 && x.gear === 0 && x.throttle === 0));
    },
    'every reading is a number at every moment of the round'() {
        drive(demo(), 0, 22000, 25).forEach((x) => ['rpm', 'speed', 'gear', 'gLong', 'gLat', 'coolant', 'oil', 'torque', 'throttle'].forEach((k) => assert.ok(typeof x[k] === 'number' && isFinite(x[k]), k + ' at ' + x.t)));
    },
};

let failed = 0;
Object.keys(tests).forEach((name) => {
    try { tests[name](); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
});
console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
