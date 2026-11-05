'use strict';
/**
 * The EVA HUD's alert rules (shared/eva_alerts.js). No car and no renderer: time and values go in by hand.
 *   node bench/test/eva_alerts_test.js
 */
const assert = require('assert');
const { AlertEngine } = require('../../shared/eva_alerts');

const THRESHOLDS = { knock: 4.5, heat: 118, boost: 2.0, fuel: 30, afrLow: 10.6, afrHigh: 18.4 };
const OK = { knock: 0, heat: 90, boost: 0.5, fuel: 120, afr: 14.7 };

/** An engine that has been running long enough to judge, at time `t` (ms); every channel fresh and fine. */
function running() {
    const h = { e: new AlertEngine({ thresholds: Object.assign({}, THRESHOLDS) }), t: 0, vals: Object.assign({}, OK), pedal: 20, rpm: 2000, at: {} };
    h.step = (ms) => {
        h.t += ms;
        const values = {};
        Object.keys(h.vals).forEach((k) => {
            const at = h.at[k] === undefined ? h.t : h.at[k];
            values[k] = { v: h.vals[k], at };
        });
        return h.e.update(h.t, { rpm: h.rpm, pedal: h.pedal, values });
    };
    h.step(0);
    h.step(5000);
    return h;
}
const idOf = (show) => (show ? show.id : null);

const tests = {
    'nothing shows while everything is within limits'() {
        assert.strictEqual(running().step(50), null);
    },
    'an alert does not fire before the engine has run for 5 s'() {
        const h = { e: new AlertEngine({ thresholds: Object.assign({}, THRESHOLDS) }) };
        const input = (t) => ({ rpm: 2000, pedal: 20, values: { heat: { v: 130, at: t } } });
        assert.strictEqual(h.e.update(0, input(0)), null);
        assert.strictEqual(h.e.update(4900, input(4900)), null);
        assert.strictEqual(idOf(h.e.update(5100, input(5100))), 'heat');
    },
    'a value past its limit shows at once, with its value'() {
        const h = running();
        h.vals.heat = 125;
        const s = h.step(50);
        assert.deepStrictEqual([s.kind, s.id, s.value], ['single', 'heat', 125]);
    },
    'the value shown follows the latest reading'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.vals.heat = 127;
        assert.strictEqual(h.step(50).value, 127);
    },
    'fuel pressure alerts when it falls to its limit, not when it rises'() {
        const h = running();
        h.vals.fuel = 500;
        assert.strictEqual(h.step(50), null);
        h.vals.fuel = 30;
        assert.strictEqual(idOf(h.step(50)), 'fuel');
    },
    'after the value recovers the alert stays 2 s, then goes'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.vals.heat = 90;
        h.step(50);                                 // the first reading back inside starts the 2 s
        assert.strictEqual(idOf(h.step(1900)), 'heat');
        assert.strictEqual(h.step(200), null);
    },
    'a value just inside the limit does not start the hold (hysteresis)'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.vals.heat = 117;
        h.step(50);
        assert.strictEqual(idOf(h.step(5000)), 'heat');
    },
    'a new trip during the hold keeps the alert and restarts the hold'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.vals.heat = 90; h.step(1500);
        h.vals.heat = 125; h.step(50);
        h.vals.heat = 90; h.step(50);
        assert.strictEqual(idOf(h.step(1900)), 'heat');
        assert.strictEqual(h.step(200), null);
    },
    'the engine stopping clears everything at once and it must run 5 s again'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.rpm = 0;
        assert.strictEqual(h.step(50), null);
        h.rpm = 2000;
        assert.strictEqual(h.step(100), null);
        assert.strictEqual(h.step(4800), null);
        assert.strictEqual(idOf(h.step(300)), 'heat');
    },
    'a missing rpm counts as the engine not running'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.rpm = null;
        assert.strictEqual(h.step(50), null);
    },
    'old data never trips an alert'() {
        const h = running();
        h.vals.heat = 125; h.at.heat = h.t;
        h.step(3100);
        assert.strictEqual(h.step(50), null);
    },
    'an alert whose data goes stale clears at once, without the hold'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.at.heat = h.t;
        assert.strictEqual(h.step(3100), null);
    },
    'a value that is not a number never trips an alert'() {
        const h = running();
        h.vals.heat = null;
        assert.strictEqual(h.step(50), null);
        h.vals.heat = NaN;
        assert.strictEqual(h.step(50), null);
    },
    'a channel with no reading at all stays quiet'() {
        const e = new AlertEngine({ thresholds: Object.assign({}, THRESHOLDS) });
        e.update(0, { rpm: 2000, pedal: 20, values: {} });
        assert.strictEqual(e.update(6000, { rpm: 2000, pedal: 20, values: {} }), null);
    },
    'a limit set to null switches that alert off'() {
        const h = running();
        h.e.setThresholds(Object.assign({}, THRESHOLDS, { heat: null }));
        h.vals.heat = 150;
        assert.strictEqual(h.step(50), null);
    },
    'a changed limit applies to the next reading'() {
        const h = running();
        h.e.setThresholds(Object.assign({}, THRESHOLDS, { heat: 100 }));
        h.vals.heat = 105;
        assert.strictEqual(idOf(h.step(50)), 'heat');
    },
    'a lean mixture only alerts with the pedal past 50 %'() {
        const h = running();
        h.vals.afr = 19;
        h.pedal = 50;
        assert.strictEqual(h.step(50), null);
        h.pedal = 51;
        assert.strictEqual(idOf(h.step(50)), 'afr');
    },
    'a rich mixture alerts too'() {
        const h = running();
        h.vals.afr = 10; h.pedal = 90;
        assert.strictEqual(idOf(h.step(50)), 'afr');
    },
    'the mixture is not judged when the pedal is unknown'() {
        const h = running();
        h.vals.afr = 19; h.pedal = null;
        assert.strictEqual(h.step(50), null);
    },
    'lifting off starts the mixture alert\'s hold'() {
        const h = running();
        h.vals.afr = 19; h.pedal = 90; h.step(50);
        h.pedal = 0;
        h.step(50);
        assert.strictEqual(idOf(h.step(1900)), 'afr');
        assert.strictEqual(h.step(200), null);
    },
    'two alerts take turns every 2 s, the more serious first'() {
        const h = running();
        h.vals.heat = 125; h.vals.knock = 6;
        assert.strictEqual(idOf(h.step(0)), 'knock');
        assert.strictEqual(idOf(h.step(1900)), 'knock');
        assert.strictEqual(idOf(h.step(200)), 'heat');
        assert.strictEqual(idOf(h.step(2000)), 'knock');
    },
    'three or more become one multiple alert, listed most serious first'() {
        const h = running();
        h.vals.heat = 125; h.vals.knock = 6; h.vals.boost = 3;
        const s = h.step(50);
        assert.deepStrictEqual([s.kind, s.ids, s.count], ['multi', ['knock', 'heat', 'boost'], 3]);
    },
    'priority runs knock, fuel, mixture, coolant, boost'() {
        const h = running();
        h.vals.boost = 3; h.vals.heat = 125; h.vals.afr = 19; h.pedal = 90; h.vals.fuel = 5; h.vals.knock = 6;
        assert.deepStrictEqual(h.step(50).ids, ['knock', 'fuel', 'afr', 'heat', 'boost']);
    },
    'dismissing hides the alert while it lasts'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.e.dismiss();
        assert.strictEqual(h.step(50), null);
        assert.strictEqual(h.step(5000), null);
    },
    'a dismissed alert comes back only after it has cleared and tripped again'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.e.dismiss();
        h.vals.heat = 90;
        assert.strictEqual(h.step(1000), null);    // still holding: stays hidden
        h.vals.heat = 125;
        assert.strictEqual(h.step(50), null);      // tripped again inside the hold: same event
        h.vals.heat = 90; h.step(50);
        assert.strictEqual(h.step(2100), null);    // now really cleared
        h.vals.heat = 125;
        assert.strictEqual(idOf(h.step(50)), 'heat');
    },
    'dismissing one batch does not hide a different alert that fires later'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.e.dismiss();
        h.vals.knock = 6;
        assert.strictEqual(idOf(h.step(50)), 'knock');
    },
    'the engine stopping forgets a dismissal'() {
        const h = running();
        h.vals.heat = 125; h.step(50);
        h.e.dismiss();
        h.rpm = 0; h.step(50);
        h.rpm = 2000; h.step(100); h.step(5100);
        assert.strictEqual(idOf(h.step(50)), 'heat');
    },
};

let failed = 0;
Object.keys(tests).forEach((name) => {
    try { tests[name](); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
});
console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
