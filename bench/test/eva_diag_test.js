'use strict';
/**
 * The EVA HUD's engine unit readings (shared/eva_diag.js), through the kit's real DidReader on a fake link
 * that answers the way a control unit does: 62 <did> <data>, 41 <pid> <data>, 7F 22 <nrc>, or nothing.
 *   node bench/test/eva_diag_test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { DidReader } = require('../../kit/runtime/dids');
const { EvaDiag } = require('../../shared/eva_diag');

const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, '../../apps/eva_hud/app.json'), 'utf8'));
const CONFIG = SPEC.config.dme;
const ECU = 18;

/** replies: { 'F423': [data bytes] | 'refuse' | undefined (no answer), 'OBD 34': [...] } */
function harness(replies) {
    const asked = [];
    const link = {
        physical: async (ecu, sid, data) => {
            assert.strictEqual(ecu, ECU);
            const obd = sid === 0x01;
            const name = obd ? 'OBD ' + data[0].toString(16).toUpperCase().padStart(2, '0')
                : ((data[0] << 8) | data[1]).toString(16).toUpperCase().padStart(4, '0');
            asked.push(name);
            const r = replies[name];
            if (r === undefined) return null;
            if (r === 'refuse') return [0x7F, sid, 0x31];
            return obd ? [0x41, data[0]].concat(r) : [0x62, data[0], data[1]].concat(r);
        },
    };
    let t = 1000;
    const got = {};
    const d = new EvaDiag({
        reader: new DidReader(link, { ecu: CONFIG.ecu }), config: CONFIG, now: () => t,
        onReading: (name, v, at) => { got[name] = { v, at }; },
    });
    return { d, got, asked, advance: (ms) => { t += ms; }, now: () => t };
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + ' is not ' + b);

const tests = {
    'the fuel flow comes out in litres an hour, from BMW\'s own identifier'() {
        const h = harness({ 5656: [0x07, 0xD0] });                       // 2000 * 0.00119209 ml/s = 2.384 ml/s
        return h.d.round({ burn: true }).then(() => near(h.got.burn.v, 2000 * 0.00119209 * 3.6));
    },
    'the OBD fuel flow has its own scale'() {
        const h = harness({ 5656: 'refuse', 'OBD 5E': [0x00, 0xC8] });   // 200 * 0.05 L/h
        return h.d.round({ burn: true }).then(() => near(h.got.burn.v, 10));
    },
    'a fuel cut is a reading of nothing, not a missing one'() {
        const h = harness({ 5656: [0x00, 0x00] });
        return h.d.round({ burn: true }).then(() => near(h.got.burn.v, 0));
    },
    'the fuel flow is read only when asked for'() {
        const h = harness({ 5656: [0x07, 0xD0], F423: [0x07, 0xD0] });
        return h.d.round({ fuel: true }).then(() => {
            assert.strictEqual(h.got.burn, undefined);
            assert.ok(h.asked.indexOf('5656') < 0, h.asked.join(' '));
        });
    },
    'a car that refuses the fuel flow says so'() {
        const h = harness({ 5656: 'refuse', 'OBD 5E': 'refuse' });
        return h.d.round({ burn: true }).then(() => assert.deepStrictEqual(h.d.unavailable(), ['burn']));
    },
    'rail pressure comes out in bar'() {
        const h = harness({ F423: [0x07, 0xD0] });
        return h.d.round({ fuel: true }).then(() => { near(h.got.fuel.v, 200); assert.strictEqual(h.got.fuel.at, 1000); });
    },
    'BMW\'s own rail pressure identifier is scaled from MPa to bar too'() {
        const h = harness({ F423: 'refuse', F459: 'refuse', 'OBD 23': 'refuse', '58EF': [0x9C, 0x40] });  // 40000 * 0.0005 MPa
        return h.d.round({ fuel: true }).then(() => near(h.got.fuel.v, 200));
    },
    'lambda comes out as an air-fuel ratio'() {
        const h = harness({ 5889: [0x10, 0x00] });                       // 4096 * 1/4096 = lambda 1
        return h.d.round({ afr: true }).then(() => near(h.got.afr.v, 14.7));
    },
    'the OBD lambda answer has its own scale'() {
        const h = harness({ 5889: 'refuse', 5640: 'refuse', 'OBD 34': [0x80, 0x00] });     // 32768 * 2/65536 = lambda 1
        return h.d.round({ afr: true }).then(() => near(h.got.afr.v, 14.7));
    },
    'an implausible lambda, as in fuel cut, gives no reading at all'() {
        const h = harness({ 5889: [0xFF, 0xFF], 5640: [0xFF, 0xFF], 'OBD 34': [0xFF, 0xFF] });
        return h.d.round({ afr: true }).then(() => assert.strictEqual(h.got.afr, undefined));
    },
    'knock retard is reported as a size, whichever sign the unit uses'() {
        const h = harness({ '554C': [0xF0] });                           // -16 * 0.375 deg
        return h.d.round({ knock: true }).then(() => near(h.got.knock.v, 6));
    },
    'boost is the absolute pressure less the outside air, in bar'() {
        const h = harness({ F470: [0, 0, 0, 0x1F, 0x40], F433: [100] });  // 8000 / 32 = 250 kPa, outside 100 kPa
        return h.d.round({ boost: true }).then(() => near(h.got.boost.v, 1.5));
    },
    'only the channels asked for are read'() {
        const h = harness({ F423: [0x07, 0xD0], '554C': [0x08] });
        return h.d.round({ fuel: true }).then(() => assert.deepStrictEqual(h.asked, ['F423']));
    },
    'a channel the car refuses is left alone for 30 s, then tried again'() {
        const h = harness({ '554C': 'refuse' });
        return h.d.round({ knock: true }).then(() => {
            assert.deepStrictEqual(h.d.unavailable(), ['knock']);
            assert.strictEqual(h.asked.length, 1);
            h.advance(29000);
            return h.d.round({ knock: true });
        }).then(() => {
            assert.strictEqual(h.asked.length, 1);
            h.advance(2000);
            return h.d.round({ knock: true });
        }).then(() => assert.strictEqual(h.asked.length, 2));
    },
    'a channel that starts answering is available again'() {
        const replies = { '554C': 'refuse' };
        const h = harness(replies);
        return h.d.round({ knock: true }).then(() => {
            replies['554C'] = [0x08];
            h.advance(31000);
            return h.d.round({ knock: true });
        }).then(() => { assert.deepStrictEqual(h.d.unavailable(), []); near(h.got.knock.v, 3); });
    },
    'no answer is not a refusal: the next round asks again'() {
        const h = harness({});
        return h.d.round({ knock: true }).then(() => {
            assert.deepStrictEqual(h.d.unavailable(), []);
            return h.d.round({ knock: true });
        }).then(() => assert.strictEqual(h.asked.length, 2));
    },
    'the link counts as up for 5 s after any answer'() {
        const h = harness({ F423: [0x07, 0xD0] });
        assert.strictEqual(h.d.linkOk(), false);
        return h.d.round({ fuel: true }).then(() => {
            assert.strictEqual(h.d.linkOk(), true);
            h.advance(4900);
            assert.strictEqual(h.d.linkOk(), true);
            h.advance(200);
            assert.strictEqual(h.d.linkOk(), false);
        });
    },
    'a refusal still counts as an answer for the link'() {
        const h = harness({ '554C': 'refuse' });
        return h.d.round({ knock: true }).then(() => assert.strictEqual(h.d.linkOk(), true));
    },
};

let failed = 0;
Object.keys(tests).reduce((p, name) => p.then(() => tests[name]()).then(
    () => console.log('ok    ' + name),
    (e) => { failed++; console.log('FAIL  ' + name + '\n      ' + String(e.message).split('\n')[0]); },
), Promise.resolve()).then(() => {
    console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
    process.exit(failed ? 1 : 0);
});
