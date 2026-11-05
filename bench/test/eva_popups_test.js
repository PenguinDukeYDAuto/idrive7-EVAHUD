'use strict';
/**
 * How the EVA app knows a BMW pop-up is showing (shared/eva_popups.js): it reads the slot table's changes from
 * cluster-render's log, because only uid 5000 may talk to the display manager itself.
 *   node bench/test/eva_popups_test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PopupWatch } = require('../../shared/eva_popups');

const POPUP_ON = '2026-11-05 08:58:45.390 I dcsm: slot 0x322 status 2 content 0x1000251 class 512 map 1\n';
const POPUP_OFF = '2026-11-05 08:58:46.983 I dcsm: slot 0x322 status 0 content 0x1000251 class 512 map 0\n';
const HOLD = 1500;

function fresh(text) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eva-popups-')), 'cluster-render.log');
    fs.writeFileSync(file, text || '');
    const w = new PopupWatch({ path: file, holdMs: HOLD, pollMs: 0 });
    w.poll(0);
    return { w, add: (s) => fs.appendFileSync(file, s), file };
}

const tests = {
    'nothing shows on an empty log'() {
        assert.strictEqual(fresh().w.shown(0x322, 0), false);
    },
    'a mapped row in the slot is a pop-up'() {
        const h = fresh();
        h.add(POPUP_ON);
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x322, 100), true);
    },
    'map status 2, in the background, counts too'() {
        const h = fresh();
        h.add('2026-11-05 08:58:45.390 I dcsm: slot 0x322 status 2 content 0x1000251 class 512 map 2\n');
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x322, 100), true);
    },
    'it only counts for its own slot'() {
        const h = fresh();
        h.add(POPUP_ON);
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x202, 100), false);
    },
    'a row listed but unmapped is not showing'() {
        const h = fresh();
        h.add('2026-11-05 08:58:47.165 I dcsm: slot 0x322 status 1 content 0x1000251 class 512 map 0\n');
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x322, 100), false);
    },
    'an empty row is not a pop-up'() {
        const h = fresh();
        h.add('2026-11-05 08:58:47.165 I dcsm: slot 0x322 status 1 content 0x0 class 0 map 1\n');
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x322, 100), false);
    },
    'it still counts for the hold after the pop-up goes, then stops'() {
        const h = fresh();
        h.add(POPUP_ON);
        h.w.poll(100);
        h.add(POPUP_OFF);
        h.w.poll(200);
        assert.strictEqual(h.w.shown(0x322, 200), true);
        assert.strictEqual(h.w.shown(0x322, 200 + HOLD - 1), true);
        assert.strictEqual(h.w.shown(0x322, 200 + HOLD), false);
    },
    'a second content in the slot keeps it showing when the first goes'() {
        const h = fresh();
        h.add(POPUP_ON);
        h.add('2026-11-05 08:58:45.500 I dcsm: slot 0x322 status 2 content 0x1000252 class 512 map 1\n');
        h.add(POPUP_OFF);
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x322, 100 + HOLD + 1), true);
    },
    'a pop-up already up when the app starts is found'() {
        const h = fresh(POPUP_ON);
        assert.strictEqual(h.w.shown(0x322, 0), true);
    },
    'a pop-up that has already gone when the app starts is not held for'() {
        const h = fresh(POPUP_ON + POPUP_OFF);
        assert.strictEqual(h.w.shown(0x322, 0), false);
    },
    'a line still being written waits for its end'() {
        const h = fresh();
        h.add(POPUP_ON.slice(0, 40));
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x322, 100), false);
        h.add(POPUP_ON.slice(40));
        h.w.poll(200);
        assert.strictEqual(h.w.shown(0x322, 200), true);
    },
    'a rotated log is read from its start'() {
        const h = fresh('x'.repeat(4000) + '\n');
        fs.writeFileSync(h.file, POPUP_ON);
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x322, 100), true);
    },
    'losing the display manager clears the table, and holds nothing'() {
        const h = fresh();
        h.add(POPUP_ON);
        h.w.poll(100);
        h.add('2026-11-05 08:58:50.000 I dcsm: Dcsm2 not available\n');
        h.w.poll(200);
        assert.strictEqual(h.w.shown(0x322, 200), false);
    },
    'a service restart clears the table too'() {
        const h = fresh();
        h.add(POPUP_ON);
        h.w.poll(100);
        h.add('2026-11-05 08:58:50.000 I dcsm: waiting for Dcsm2\n');
        h.w.poll(200);
        assert.strictEqual(h.w.shown(0x322, 200), false);
    },
    'other log lines change nothing'() {
        const h = fresh();
        h.add('2026-11-05 08:58:46.099 I target hud: asking for scene 0x1000400 709 ms after its release\n');
        h.add('2026-11-05 08:58:46.399 I dcsm: content 0x1000251 map status 0 -> 1\n');
        h.w.poll(100);
        assert.strictEqual(h.w.shown(0x322, 100), false);
    },
    'a log it cannot read means no pop-ups, and is said once'() {
        const said = [];
        const w = new PopupWatch({ path: '/nonexistent/cluster-render.log', holdMs: HOLD, pollMs: 0, log: { warn: (s) => said.push(s) } });
        w.poll(0);
        w.poll(100);
        assert.strictEqual(w.shown(0x322, 100), false);
        assert.strictEqual(said.length, 1);
    },
    'it reads no more often than asked'() {
        const h = fresh();
        const w = new PopupWatch({ path: h.file, holdMs: HOLD, pollMs: 100 });
        w.poll(1000);
        h.add(POPUP_ON);
        w.poll(1050);
        assert.strictEqual(w.shown(0x322, 1050), false);
        w.poll(1100);
        assert.strictEqual(w.shown(0x322, 1100), true);
    },
    'at start it reads only the end of a long log'() {
        const h = fresh('2026-11-05 08:00:00.000 I filler line\n'.repeat(30000) + POPUP_ON);
        assert.ok(fs.statSync(h.file).size > 1024 * 1024);
        assert.strictEqual(h.w.shown(0x322, 0), true);
        assert.ok(h.w.bytesRead < 128 * 1024, h.w.bytesRead + ' bytes');
    },
};

let failed = 0;
Object.keys(tests).forEach((name) => {
    try { tests[name](); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
});
console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
