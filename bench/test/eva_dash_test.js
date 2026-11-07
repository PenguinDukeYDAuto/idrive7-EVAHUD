'use strict';
/**
 * The EVA app on two screens at once: the real app, built and run on the head-unit stub, with cluster-render replaced
 * by a record of what each connection asked for. Run after any change to shared/eva_hud.js or shared/eva_dash.js.
 *   node bench/test/eva_dash_test.js
 */
const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const STAGE = path.join(ROOT, 'dist', 'eva_hud');
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const TPMS = 'de.bmw.infotainment.vehicle.TPMS';

/**
 * Stands in for cluster-render's client: layers are records, refused as on the car when a connection has 8, or when the
 * service's 16 MiB of pixel memory is full, which counts every image twice (Compositor::add_image).
 */
class FakeClient {
    constructor(name) {
        this.name = name;
        this.ready = false;
        this.backend = 'test';
        this.layers = new Map();
        this.handlers = {};
        this.nextRef = 1;
        this.refused = [];
        this.writes = 0;
        this.uniformCalls = 0;
        this.sent = [];
        FakeClient.all.push(this);
    }
    on(ev, fn) { this.handlers[ev] = fn; return this; }
    emit(ev, ...a) { if (this.handlers[ev]) this.handlers[ev](...a); }
    connect() { setImmediate(() => { this.ready = true; this.emit('ready'); }); }
    close() { this.ready = false; }
    _add(kind, o) {
        const ref = this.nextRef++;
        if (this.layers.size >= 8) { this.refused.push(o.target + ': too many layers'); return ref; }
        const bytes = kind === 'image' ? o.iw * o.ih * 4 * 2 : 0;
        if (FakeClient.memory() + bytes > 16 * 1024 * 1024) { this.refused.push(o.target + ': pixel memory is full'); return ref; }
        this.layers.set(ref, Object.assign({ kind, visible: 1, bytes }, o));
        return ref;
    }
    image(o) { return this._add('image', o); }
    effect(o) { return this._add('effect', o); }
    set(ref, o) { Object.assign(this.layers.get(ref) || {}, o); }
    uniform(ref, name, v) { this.uniformCalls++; const l = this.layers.get(ref); if (l) (l.uniforms = l.uniforms || {})[name] = v; }
    uniformsOf(test) { const l = Array.from(this.layers.values()).find(test); return (l && l.uniforms) || {}; }
    pixels(ref, rects, px) { this.writes++; this.sent.push({ ref, rects, px }); }
    drop(ref) { this.layers.delete(ref); }
    targets() { return Array.from(new Set(Array.from(this.layers.values()).map((l) => l.target))); }
    shown() { return Array.from(this.layers.values()).filter((l) => l.visible); }
    alertLayers() { return this.shown().filter((l) => l.klass === 'alert'); }
}
FakeClient.all = [];
FakeClient.memory = () => FakeClient.all.reduce((n, c) => n + Array.from(c.layers.values()).reduce((m, l) => m + l.bytes, 0), 0);

const counts = { cars: 0, evas: [] };
const wrappers = new WeakMap();
let dashThrows = false;
const realLoad = Module._load;
Module._load = function (req) {
    if (/cluster_render_client(\.js)?$/.test(req)) return { ClusterRender: FakeClient, DEFAULT_PATH: '/nonexistent' };
    const m = realLoad.apply(this, arguments);
    if (req === './kit/car') return class extends m { constructor(...a) { super(...a); counts.cars++; } };
    if (req === './eva_dash' && dashThrows) return class { constructor() { throw new Error('test: no dash'); } };
    if (req === './eva_hud') {
        if (!wrappers.has(m)) wrappers.set(m, class extends m { constructor(...a) { super(...a); counts.evas.push(this); } });
        return wrappers.get(m);
    }
    return m;
};

/** The app as the car runs it, on a fresh data folder. */
function startApp(values, opts) {
    FakeClient.all.forEach((c) => { c.ready = false; });     // the last test's app stops drawing, so it can't slow this one
    FakeClient.all.length = 0;
    counts.cars = 0;
    counts.evas = [];
    dashThrows = !!(opts && opts.dashThrows);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eva-dash-'));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(Object.assign({ demo: 'on' }, values)));
    Object.keys((opts && opts.layouts) || {}).forEach((name) => {
        fs.mkdirSync(path.join(dataDir, 'layouts'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'layouts', name + '.json'), JSON.stringify(opts.layouts[name]));
    });
    const quiet = () => {};
    const lines = [];
    const log = { info: quiet, warn: (s) => lines.push(String(s)), error: (s) => lines.push('ERROR ' + (s && s.stack || s)), debug: quiet };
    const { headUnit } = require(path.join(ROOT, 'kit', 'tools', 'hu-stub.js'));
    const hu = headUnit(STAGE, { live: true, dataDir, log, image: () => Promise.resolve() });
    Object.keys(require.cache).filter((k) => k.indexOf(STAGE) === 0).forEach((k) => delete require.cache[k]);
    popupLog = path.join(dataDir, 'cluster-render.log');
    fs.writeFileSync(popupLog, '');
    process.env.EVA_POPUP_LOG = popupLog;
    const watches = [];
    const watch = hu.ctx.signals.watch;
    hu.ctx.signals.watch = (iface, inst, handlers, l, o) => {
        watches.push({ iface, fields: Object.keys(handlers || {}), opts: o });
        return watch(iface, inst, handlers, l, o);
    };
    let status = '';
    const text = hu.ui.text;
    hu.ui.text = (n, t, row, cell) => { if (n === 'STATUS' && !row) status = String(t); return text(n, t, row, cell); };
    hu.start();
    return { hu, lines, watches, status: () => status, hud: () => FakeClient.all[0], dash: () => FakeClient.all[1], set: (k, v) => { const many = /^(dashDesign|bothDash)$/.test(k) ? ['Comfort', 'Sport', 'Eco'].map((m) => (k === 'dashDesign' ? 'dash' : 'bothDash') + m) : [k]; many.forEach((n) => hu.settings.set(n, v)); } };
}

let popupLog = null;
const popup = (slot, on) => fs.appendFileSync(popupLog, '2026-11-05 08:58:45.390 I dcsm: slot 0x' + slot + ' status ' + (on ? 2 : 0) + ' content 0x1000251 class 512 map ' + (on ? 1 : 0) + '\n');

// macOS reports a new data folder's layouts directory as changed some 300 ms after the app starts watching it, and the
// app rebuilds once. A test that counts writes or layer ids starts counting after that.
const SETTLE_MS = 700;

const drive = (app, mode) => app.hu.feed('de.bmw.infotainment.drivingexcitement.FES', 'statusFESVehicleDynamicSwitchHMI', { actualValueModeDrivingExperience: mode });

/** One image layer as the service holds it: every write the app sent, in order. */
function imageOf(client, ref) {
    const l = client.layers.get(ref), out = Buffer.alloc(l.iw * l.ih * 4);
    client.sent.filter((s) => s.ref === ref).forEach((s) => {
        if (!s.rects) { s.px.copy(out); return; }
        let off = 0;
        s.rects.forEach((r) => {
            for (let y = 0; y < r.h; y++) {
                s.px.copy(out, ((r.y + y) * l.iw + r.x) * 4, off, off + r.w * 4);
                off += r.w * 4;
            }
        });
    });
    return out;
}
const WORD_SETTLE = 500;       // longer than a fade out and a fade in
const wordLayer = (a) => Array.from(a.hud().layers.values()).find((l) => l.sy === 1.5);
const wordWrites = (a) => { const w = wordLayer(a); return a.hud().sent.filter((s) => a.hud().layers.get(s.ref) === w); };
/** The app in HUD Only with real data off, in that drive mode, with the car's data under the test's hand. */
async function everyday(mode, settings) {
    const a = startApp(Object.assign({ screens: 'hud', demo: 'off' }, settings));
    await wait(SETTLE_MS);
    const hud = counts.evas[0], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000 };
    hud.car.data = () => data;
    drive(a, mode);
    await wait(150);
    return { a, data };
}

const tests = {
    async 'one app opens one connection per screen, each drawing on its own'() {
        const a = startApp({ screens: 'both' });
        await wait(150);
        assert.strictEqual(FakeClient.all.length, 2);
        assert.notStrictEqual(a.hud().name, a.dash().name);
        assert.deepStrictEqual(a.hud().targets(), ['hud']);
        assert.deepStrictEqual(a.dash().targets(), ['panel']);
    },
    async 'neither connection is refused a layer, normal or in an alert'() {
        const a = startApp({ screens: 'both', alertPreview: 'knock' });
        await wait(300);
        assert.ok(a.hud().alertLayers().length > 0);
        assert.deepStrictEqual(a.hud().refused, []);
        assert.deepStrictEqual(a.dash().refused, []);
        assert.ok(a.hud().layers.size <= 8 && a.dash().layers.size <= 8);
    },
    async 'HUD only draws the HUD, with its own richer layout'() {
        const a = startApp({ screens: 'hud', hudComfort: 'sport' });
        await wait(150);
        assert.strictEqual(a.dash().layers.size, 0);
        assert.strictEqual(a.hud().layers.size, 5);
        assert.ok(a.hud().shown().some((l) => l.fs && /u_pedal/.test(l.fs)), 'no instruments');
    },
    async 'Dash only draws the dash'() {
        const a = startApp({ screens: 'dash' });
        await wait(150);
        assert.strictEqual(a.hud().layers.size, 0);
        assert.strictEqual(a.dash().layers.size, 5);
    },
    async 'HUD + Dash draws both, the HUD without the instruments'() {
        const a = startApp({ screens: 'both' });
        await wait(150);
        assert.strictEqual(a.hud().layers.size, 4);
        assert.strictEqual(a.dash().layers.size, 5);
    },
    async 'off draws nothing'() {
        const a = startApp({ screens: 'off' });
        await wait(150);
        assert.strictEqual(a.hud().layers.size, 0);
        assert.strictEqual(a.dash().layers.size, 0);
    },
    async 'the mode can change while running, and the HUD changes layout with it'() {
        const a = startApp({ screens: 'both', hudComfort: 'sport' });
        await wait(150);
        a.set('screens', 'hud');
        await wait(100);
        assert.strictEqual(a.hud().layers.size, 5);
        assert.strictEqual(a.dash().layers.size, 0);
        a.set('screens', 'dash');
        await wait(100);
        assert.strictEqual(a.hud().layers.size, 0);
        assert.strictEqual(a.dash().layers.size, 5);
    },
    async 'going from Dash only to both leaves the dash\'s layers alone'() {
        const a = startApp({ screens: 'dash' });
        await wait(150);
        const before = a.dash().nextRef;
        a.set('screens', 'both');
        await wait(100);
        assert.strictEqual(a.dash().nextRef, before);
        assert.strictEqual(a.hud().layers.size, 4);
    },
    async 'the HUD\'s calibration grid still works'() {
        const a = startApp({ screens: 'grid' });
        await wait(150);
        assert.ok(a.hud().layers.size > 0 && a.hud().layers.size <= 2);
        assert.strictEqual(a.dash().layers.size, 0);
    },
    async 'settings saved by an older version are ignored: the HUD alone, in every drive mode'() {
        const a = startApp({ hudLayout: 'eva', dashLayout: 'off', byMode: true, inComfort: 'dash', inSport: 'both', inEco: 'off', dashInSport: 'eva' });
        await wait(150);
        for (const mode of ['COMFORT', 'SPORT', 'ECO_PRO']) {
            drive(a, mode);
            await wait(150);
            assert.ok(a.hud().layers.size > 0, mode);
            assert.strictEqual(a.dash().layers.size, 0, mode);
        }
    },
    async 'the drive mode never changes which screens are on'() {
        for (const [screens, hudOn, dashOn] of [['hud', true, false], ['dash', false, true], ['both', true, true], ['off', false, false]]) {
            const a = startApp({ screens });
            await wait(150);
            for (const mode of ['SPORT', 'COMFORT', 'ECO_PRO']) {
                drive(a, mode);
                await wait(120);
                assert.strictEqual(a.hud().layers.size > 0, hudOn, screens + ' ' + mode + ' HUD');
                assert.strictEqual(a.dash().layers.size > 0, dashOn, screens + ' ' + mode + ' dash');
            }
        }
    },
    async 'in HUD only, each drive mode has its own layout, and Comfort stands in until the car says'() {
        const a = startApp({ screens: 'hud' });
        await wait(150);
        const hud = counts.evas[0];
        assert.strictEqual(hud.activeName, 'hud_only_comfort');
        for (const [mode, name] of [['COMFORT', 'hud_only_comfort'], ['ECO_PRO', 'hud_only_eco'], ['SPORT', 'hud_only_sport']]) {
            drive(a, mode);
            await wait(150);
            assert.strictEqual(hud.activeName, name, mode);
            assert.deepStrictEqual(a.hud().refused, [], mode);
        }
    },
    async 'in HUD + Dash the drive mode changes nothing yet'() {
        const a = startApp({ screens: 'both' });
        await wait(SETTLE_MS);
        const before = a.hud().nextRef;
        drive(a, 'COMFORT');
        await wait(150);
        assert.strictEqual(a.hud().nextRef, before);
        assert.strictEqual(counts.evas[0].activeName, 'eva');
    },
    async 'the same drive mode again does not redraw the screen'() {
        const a = startApp({ screens: 'hud' });
        await wait(SETTLE_MS);
        drive(a, 'COMFORT');
        await wait(150);
        const before = a.hud().nextRef;
        drive(a, 'COMFORT');
        await wait(150);
        assert.strictEqual(a.hud().nextRef, before);
    },
    async 'Comfort and Eco Pro stay still at the shift point: nothing that flashes'() {
        for (const mode of ['COMFORT', 'ECO_PRO']) {
            const a = startApp({ screens: 'hud' });
            await wait(150);
            drive(a, mode);
            await wait(200);
            const hud = counts.evas[0];
            hud._shift = () => ({ now: true, rpm: 1000, oilCold: false, cold: false });
            await wait(400);
            assert.strictEqual(a.hud().layers.size, mode === 'COMFORT' ? 4 : 3, mode);
            assert.ok(!Array.from(a.hud().layers.values()).some((l) => l.fs && /u_strobe/.test(l.fs)), mode + ' has a strobe');
            assert.deepStrictEqual(a.hud().refused, [], mode);
        }
    },
    async 'Sport still flashes at the shift point'() {
        const a = startApp({ screens: 'hud' });
        await wait(150);
        drive(a, 'SPORT');
        await wait(200);
        const hud = counts.evas[0];
        hud._shift = () => ({ now: true, rpm: 1000, oilCold: false, cold: false });
        let strobed = false;
        for (let i = 0; i < 12; i++) {
            await wait(50);
            const u = a.hud().uniformsOf((l) => l.fs && /u_strobe/.test(l.fs));
            strobed = strobed || (u.u_strobe && u.u_strobe[0] === 1);
        }
        assert.ok(strobed);
    },
    async 'the corners draw in as the car slows and open up with speed, sending only when they move'() {
        const { a, data } = await everyday('COMFORT');
        const ins = () => a.hud().uniformsOf((l) => l.fs && /u_ins/.test(l.fs)).u_ins[0];
        const u = a.hud().uniformsOf((l) => l.fs && /u_ins/.test(l.fs));
        assert.ok(u.u_size && u.u_arm && u.u_color && u.u_lowerLeft, 'not placed');
        data.speed = 0;
        await wait(120);
        assert.strictEqual(ins(), 5);
        data.speed = 55;
        await wait(120);
        assert.ok(ins() >= 2 && ins() <= 3, String(ins()));
        data.speed = 110;
        await wait(120);
        assert.strictEqual(ins(), 0);
        data.speed = 200;
        await wait(120);
        assert.strictEqual(ins(), 0, 'not past the edge');
        const before = a.hud().uniformCalls;
        await wait(200);
        assert.strictEqual(a.hud().uniformCalls, before, 'sent again with nothing changed');
        data.speed = undefined;
        await wait(120);
        assert.strictEqual(ins(), 5, 'no speed: drawn in');
    },
    async 'P, R and N each show their own big word, and driving shows none, even stopped at a light'() {
        const { a, data } = await everyday('COMFORT');
        const word = () => wordLayer(a);
        assert.ok(word(), 'no word layer');
        for (const [stage, gear] of [['P', 0], ['N', 0], ['R', -1]]) {
            data.stage = stage; data.gear = gear; data.speed = 0;
            await wait(WORD_SETTLE);
            assert.strictEqual(word().opacity, 1, stage + ' shows');
            data.stage = 'D'; data.gear = 1; data.speed = 60;
            await wait(WORD_SETTLE);
            assert.strictEqual(word().opacity, 0, 'driving after ' + stage);
        }
        data.stage = 'D'; data.gear = 1; data.speed = 0;
        await wait(WORD_SETTLE);
        assert.strictEqual(word().opacity, 0, 'D at a red light');
    },
    async 'the big word is scaled tall and narrow, and has pixels for every gear'() {
        const { a, data } = await everyday('COMFORT');
        const w = wordLayer(a);
        assert.strictEqual(w.sx, 0.86);
        assert.strictEqual(w.sy, 1.5);
        assert.ok(w.iw === w.w && w.ih === w.h, 'one image pixel to one layer pixel');
        for (const stage of ['P', 'R', 'N']) {
            data.stage = stage; data.speed = 0; data.gear = stage === 'R' ? -1 : 0;
            await wait(WORD_SETTLE);
            const px = wordWrites(a).pop().px;
            let lit = 0;
            for (let o = 3; o < px.length; o += 4) if (px[o] > 128) lit++;
            assert.ok(lit > 2000, stage + ' has ' + lit + ' lit pixels');
            data.stage = 'D'; data.speed = 40;
            await wait(WORD_SETTLE);
        }
    },
    async 'when a pop-up ends nothing unchanged goes up again: the service kept the pixels'() {
        const { a } = await everyday('COMFORT');
        await wait(300);
        popup('322', true);
        await wait(250);
        const writes = a.hud().writes;
        popup('322', false);
        await wait(1800);
        assert.ok(a.hud().shown().length > 0, 'the HUD has come back');
        assert.ok(a.hud().writes - writes < 3, (a.hud().writes - writes) + ' writes');    // the clock may turn over
    },
    async 'when an alert ends nothing unchanged goes up again'() {
        const { a, data } = await everyday('COMFORT');
        data.speed = 0;
        await wait(300);
        a.set('alertPreview', 'heat');
        await wait(250);
        assert.strictEqual(a.hud().alertLayers().length, 3, 'the alert shows');
        const writes = a.hud().writes;
        a.set('alertPreview', 'off');
        await wait(250);
        assert.strictEqual(a.hud().alertLayers().length, 0);
        assert.ok(a.hud().writes - writes < 3, (a.hud().writes - writes) + ' writes');
    },
    async 'when a pop-up ends the dash sends no gear or text again either, however big they are'() {
        const a = startApp({ screens: 'dash', demo: 'off' });
        await wait(SETTLE_MS);
        const writes = a.dash().writes;
        popup('202', true);
        await wait(250);
        popup('202', false);
        await wait(1800);
        assert.ok(a.dash().shown().length > 0, 'the dash has come back');
        assert.ok(a.dash().writes - writes < 3, (a.dash().writes - writes) + ' writes');
    },
    async 'a new gear sends only the rectangle around what changed, and the image stays right'() {
        const { a, data } = await everyday('SPORT');
        const hud = counts.evas[0], x = hud.widgets.get('gear');
        assert.ok(x, 'no gear layer in Sport');
        await wait(100);
        const before = a.hud().sent.filter((s) => s.ref === x.ref).length;
        data.gear = 4;
        await wait(200);
        const after = a.hud().sent.filter((s) => s.ref === x.ref);
        assert.strictEqual(after.length, before + 1, 'one write for one new gear');
        const last = after[after.length - 1];
        assert.ok(last.rects && last.rects.length === 1, 'a rectangle, not the whole image');
        assert.ok(last.px.length < x.w.w * x.w.h * 4, last.px.length + ' bytes');
        const want = hud._paintGear(x.w, hud._gearState(), false);
        assert.strictEqual(imageOf(a.hud(), x.ref).compare(want), 0, 'what the service holds is not the new gear');
        let paints = 0;
        const paint = hud._paintGear;
        hud._paintGear = function () { paints++; return paint.apply(this, arguments); };
        await wait(200);
        assert.strictEqual(paints, 0, 'the same gear is not painted again');
        data.gear = 3;
        await wait(200);
        const back = hud._paintGear(x.w, hud._gearState(), false);
        assert.strictEqual(imageOf(a.hud(), x.ref).compare(back), 0, 'going back to a gear does not bring its picture back');
        assert.strictEqual(x.px.compare(back), 0, 'the next change has to be measured from the last picture');
    },
    async 'the text image is exactly what painting every part again would draw'() {
        const { a, data } = await everyday('ECO_PRO');
        const hud = counts.evas[0], x = hud.widgets.get('text');
        for (const speed of [61, 72, 100, 8, 137]) {
            data.speed = speed;
            hud._reading('burn', speed / 10, Date.now());
            await wait(300);
        }
        const image = imageOf(a.hud(), x.ref), now = Date.now(), W = x.w.w;
        x.w.parts.forEach((p) => {
            const want = hud._partPixels(p, hud._partLook(p, now));
            for (let y = 0; y < p.h; y++) {
                const at = ((p.y + y) * W + p.x) * 4;
                assert.strictEqual(image.compare(want, y * p.w * 4, (y + 1) * p.w * 4, at, at + p.w * 4), 0, p.id + ' row ' + y);
            }
        });
    },
    async 'the last row of the menu names this app and who made it'() {
        const strings = JSON.parse(fs.readFileSync(path.join(STAGE, 'rhmiData/strings/en_US.json'), 'utf8'));
        assert.strictEqual(strings.SID_EVA_HUD_REPO_CREDITS_TITLE, 'EVA HUD APP');
        assert.strictEqual(strings.SID_EVA_HUD_REPO_CREDITS_LINK, 'Free and open source by DukeAPenguin, based on Bimmer-Lab and idrive-apps');
    },
    async 'the clock\'s colon breathes in Comfort: slowly, between dim and full, with one upload and no more'() {
        const { a } = await everyday('COMFORT');
        const hud = counts.evas[0], x = hud.widgets.get('colon');
        assert.ok(x, 'no colon layer');
        const client = a.hud(), set = client.set, sets = [];
        client.set = function (ref, o) { if (ref === x.ref) sets.push(o); return set.call(this, ref, o); };
        const writes = client.sent.filter((s) => s.ref === x.ref).length;
        assert.strictEqual(writes, 1, 'its pixels go up once');
        const seen = [];
        for (let i = 0; i < 90; i++) { await wait(50); seen.push(client.layers.get(x.ref).opacity); }
        assert.ok(Math.min.apply(null, seen) <= 0.35, 'not dim enough: ' + Math.min.apply(null, seen));
        assert.ok(Math.max.apply(null, seen) >= 0.95, 'not full: ' + Math.max.apply(null, seen));
        assert.ok(Math.min.apply(null, seen) >= 0.25, 'gone too far: ' + Math.min.apply(null, seen));
        assert.ok(new Set(seen).size >= 8, 'it jumps: ' + Array.from(new Set(seen)).join(' '));
        for (let i = 1; i < seen.length; i++) assert.ok(Math.abs(seen[i] - seen[i - 1]) <= 0.15, 'a jump: ' + seen[i - 1] + ' to ' + seen[i]);
        assert.ok(sets.every((o) => Object.keys(o).join() === 'opacity'), 'only its opacity changes');
        assert.ok(sets.length < 15 * 4.5, sets.length + ' sets in 4.5 s');
        assert.strictEqual(client.sent.filter((s) => s.ref === x.ref).length, 1, 'breathing sent pixels');
    },
    async 'the clock looks as it did: hours, colon and minutes land where one string would'() {
        const { a } = await everyday('COMFORT');
        const hud = counts.evas[0], text = require(path.join(STAGE, 'source/javascript/hud_text.js'));
        hud._now = () => ({ getHours: () => 12, getMinutes: () => 34 });
        await wait(300);
        const c = hud.widgets.get('text'), colon = hud.widgets.get('colon');
        const hh = c.w.parts.find((p) => p.id === 'hh'), mm = c.w.parts.find((p) => p.id === 'mm');
        const W = 260, H = hh.h, full = text.drawText(W, H, '12:34', { font: hh.font, color: [255, 255, 255, 255], glow: hud.theme.glow, x: hh.textX, offsetY: hh.offsetY });
        const image = imageOf(a.hud(), c.ref), dots = imageOf(a.hud(), colon.ref);
        const lit = (ax, ay) => {   // on the glass, relative to the hours' part
            const inCanvas = (p) => ax >= p.x && ax < p.x + p.w;
            const y = hh.y + ay;
            const canvasOn = (inCanvas(hh) || inCanvas(mm)) && image[(y * c.w.w + ax) * 4 + 3] > 200;
            const cx = c.w.x + ax - colon.w.x, cy = c.w.y + y - colon.w.y;
            const colonOn = cx >= 0 && cx < colon.w.w && cy >= 0 && cy < colon.w.h && dots[(cy * colon.w.w + cx) * 4 + 3] > 200;
            return canvasOn || colonOn;
        };
        let wrong = 0, ink = 0;
        for (let y = 0; y < H; y++) {
            for (let x = hh.x; x < mm.x + mm.w; x++) {
                const want = full[(y * W + x - hh.x) * 4 + 3] > 200;
                if (want) ink++;
                if (want !== lit(x, y)) wrong++;
            }
        }
        assert.ok(ink > 3000, ink + ' lit pixels');
        assert.ok(wrong < ink * 0.01, wrong + ' of ' + ink + ' pixels differ');
    },
    async 'the colon hides with the rest for an alert and a pop-up, and is the only part of the clock that breathes'() {
        const { a, data } = await everyday('COMFORT');
        const hud = counts.evas[0], ref = hud.widgets.get('colon').ref;
        data.speed = 0;
        a.set('alertPreview', 'heat');
        await wait(250);
        assert.strictEqual(a.hud().layers.get(ref).visible, 0, 'under the alert');
        a.set('alertPreview', 'off');
        await wait(250);
        assert.strictEqual(a.hud().layers.get(ref).visible, 1, 'after the alert');
        popup('322', true);
        await wait(250);
        assert.strictEqual(a.hud().layers.get(ref).visible, 0, 'under the pop-up');
        popup('322', false);
        await wait(1800);
        assert.strictEqual(a.hud().layers.get(ref).visible, 1, 'after the pop-up');
    },
    async 'Eco Pro and Sport keep their one-piece clock, with no colon layer'() {
        for (const mode of ['ECO_PRO', 'SPORT']) {
            await everyday(mode);
            assert.ok(!counts.evas[0].widgets.has('colon'), mode);
        }
    },
    async 'the big word is hidden, not just see-through, whenever it is gone: a layer at opacity 0 is still drawn'() {
        const { a, data } = await everyday('COMFORT');
        assert.strictEqual(wordLayer(a).visible, 0, 'from the start, while driving');
        data.stage = 'P'; data.gear = 0; data.speed = 0;
        await wait(WORD_SETTLE);
        assert.strictEqual(wordLayer(a).visible, 1, 'in P');
        data.stage = 'D'; data.gear = 1; data.speed = 60;
        await wait(WORD_SETTLE);
        assert.strictEqual(wordLayer(a).opacity, 0);
        assert.strictEqual(wordLayer(a).visible, 0, 'hidden again when the fade ends');
    },
    async 'a pop-up or an alert that ends while driving does not bring the hidden word back'() {
        const { a, data } = await everyday('COMFORT');
        data.speed = 0;      // a preview alert only shows when stopped; still in D, so still no word
        popup('322', true);
        await wait(250);
        popup('322', false);
        await wait(1800);
        assert.ok(a.hud().shown().length > 0, 'the HUD has come back');
        assert.strictEqual(wordLayer(a).visible, 0, 'after the pop-up');
        a.set('alertPreview', 'heat');
        await wait(250);
        assert.strictEqual(a.hud().alertLayers().length, 3, 'the alert shows');
        a.set('alertPreview', 'off');
        await wait(250);
        assert.strictEqual(a.hud().alertLayers().length, 0);
        assert.strictEqual(wordLayer(a).visible, 0, 'after the alert');
    },
    async 'a pop-up that ends in P brings the word straight back'() {
        const { a, data } = await everyday('COMFORT');
        data.stage = 'P'; data.gear = 0; data.speed = 0;
        await wait(WORD_SETTLE);
        const writes = wordWrites(a).length;
        popup('322', true);
        await wait(250);
        assert.strictEqual(wordLayer(a).visible, 0, 'gives way');
        popup('322', false);
        await wait(1800);
        assert.strictEqual(wordLayer(a).visible, 1);
        assert.strictEqual(wordLayer(a).opacity, 1);
        assert.strictEqual(wordWrites(a).length, writes, 'the same word is not sent again');
    },
    async 'the big word fades in and out instead of popping'() {
        const { a, data } = await everyday('COMFORT');
        data.stage = 'P'; data.gear = 0; data.speed = 0;
        const seen = new Set();
        for (let i = 0; i < 14; i++) { await wait(50); seen.add(wordLayer(a).opacity); }
        assert.ok(Array.from(seen).some((o) => o > 0 && o < 1), 'in: ' + Array.from(seen).join(' '));
        assert.ok(seen.has(1), 'ends fully in');
        seen.clear();
        data.stage = 'D'; data.speed = 60;
        for (let i = 0; i < 14; i++) { await wait(50); seen.add(wordLayer(a).opacity); }
        assert.ok(Array.from(seen).some((o) => o > 0 && o < 1), 'out: ' + Array.from(seen).join(' '));
        assert.strictEqual(wordLayer(a).opacity, 0);
    },
    async 'the big word goes up once: leaving and coming back to the same gear sends no pixels'() {
        const { a, data } = await everyday('COMFORT');
        data.stage = 'P'; data.gear = 0; data.speed = 0;
        await wait(WORD_SETTLE);
        assert.strictEqual(wordWrites(a).length, 1);
        data.stage = 'D'; data.speed = 40;
        await wait(WORD_SETTLE);
        data.stage = 'P'; data.speed = 0;
        await wait(WORD_SETTLE);
        assert.strictEqual(wordWrites(a).length, 1);
        assert.strictEqual(wordLayer(a).opacity, 1);
    },
    async 'nothing is sent for the big word until there is one to show'() {
        const { a } = await everyday('COMFORT');
        await wait(WORD_SETTLE);
        assert.strictEqual(wordWrites(a).length, 0);
        assert.strictEqual(wordLayer(a).opacity, 0);
    },
    async 'going straight from one gear to another fades the old word out before the new one shows'() {
        const { a, data } = await everyday('COMFORT');
        data.stage = 'P'; data.gear = 0; data.speed = 0;
        await wait(WORD_SETTLE);
        data.stage = 'R'; data.gear = -1;
        await wait(60);
        assert.strictEqual(wordWrites(a).length, 1, 'painted over at full brightness');
        await wait(WORD_SETTLE);
        assert.strictEqual(wordWrites(a).length, 2);
        assert.strictEqual(wordLayer(a).opacity, 1);
    },
    async 'reverse is amber; park and neutral are the layout\'s own colour'() {
        const { a, data } = await everyday('COMFORT');
        const colour = () => {
            const px = wordWrites(a).pop().px;
            for (let o = 0; o < px.length; o += 4) if (px[o + 3] > 240) return [px[o], px[o + 1], px[o + 2]].join();
            return '';
        };
        data.stage = 'P'; data.gear = 0; data.speed = 0;
        await wait(WORD_SETTLE);
        assert.strictEqual(colour(), '255,176,122');
        data.stage = 'R'; data.gear = -1;
        await wait(WORD_SETTLE);
        assert.strictEqual(colour(), '255,176,0');
    },
    async 'the small line goes with the word: its text, nothing when driving, amber in reverse'() {
        const { a, data } = await everyday('ECO_PRO');
        const hud = counts.evas[0];
        const sub = (stage, gear) => { data.stage = stage; data.gear = gear; data.speed = 0; return hud._token('wordsub'); };
        assert.strictEqual(sub('P', 0), 'SORTIE STANDBY // 拘束具固定');
        assert.strictEqual(sub('R', -1), 'RETREAT // 総員退避');
        assert.strictEqual(sub('N', 0), 'SYNCHRO CUT // 駆動系切離');
        assert.strictEqual(sub('D', 3), '');
        assert.strictEqual(hud._warn('reverse'), false);
        sub('R', -1);
        assert.strictEqual(hud._warn('reverse'), true);
        sub('P', 0);
        assert.strictEqual(hud._warn('reverse'), false);
    },
    async 'the big word comes back as it was after an alert, and shows no alert colours'() {
        const { a, data } = await everyday('COMFORT');
        data.stage = 'P'; data.gear = 0; data.speed = 0;
        await wait(WORD_SETTLE);
        const shownBefore = a.hud().shown().length;
        a.set('alertPreview', 'heat');
        await wait(250);
        assert.strictEqual(a.hud().alertLayers().length, 3);
        assert.strictEqual(wordLayer(a).visible, 0, 'hidden under the alert');
        a.set('alertPreview', 'off');
        await wait(250);
        assert.strictEqual(a.hud().shown().length, shownBefore);
        assert.strictEqual(wordLayer(a).visible, 1);
        assert.strictEqual(wordLayer(a).opacity, 1);
    },
    async 'Comfort has NERV\'s motto where the tyres were, drawn once'() {
        const { a } = await everyday('COMFORT');
        const x = counts.evas[0].widgets.get('text'), W = x.w.w, image = imageOf(a.hud(), x.ref);
        for (const id of ['motto1', 'motto2']) {
            const p = x.w.parts.find((q) => q.id === id);
            let ink = 0;
            for (let j = p.y; j < p.y + p.h; j++) {
                for (let i = p.x; i < p.x + p.w; i++) if (image[(j * W + i) * 4 + 3] > 200) ink++;
            }
            assert.ok(ink > 200, id + ' has ' + ink + ' lit pixels');
        }
        const later = a.hud().sent.length;
        await wait(400);
        const row = x.w.parts.find((q) => q.id === 'motto1');
        a.hud().sent.slice(later).filter((s) => s.ref === x.ref && s.rects).forEach((s) => {
            const r = s.rects[0];
            assert.ok(r.y + r.h <= row.y || r.y >= row.y + row.h, 'the motto was written again');
        });
    },
    async 'the menu offers six lines for Comfort, NERV\'s motto first, and each can be drawn and fits'() {
        const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/eva_hud/app.json'), 'utf8')).settings.find((x) => x.key === 'motto');
        assert.ok(spec, 'no menu item');
        assert.strictEqual(spec.type, 'choice');
        assert.strictEqual(spec.options.length, 6);
        assert.strictEqual(spec.default, spec.options[0][0]);
        const f = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/eva_hud/hud/fonts/motto.json'), 'utf8'));
        const seen = new Set();
        for (const [key] of spec.options) {
            await everyday('COMFORT', { motto: key });
            const hud = counts.evas[0], parts = hud.widgets.get('text').w.parts;
            ['motto1', 'motto2'].forEach((id) => {
                const line = hud._token(id), part = parts.find((q) => q.id === id);
                assert.ok(line, key + ' has no ' + id);
                let w = 0;
                Array.from(line).forEach((ch) => { assert.ok(f.glyphs[ch], key + ': no glyph for ' + ch); w += f.glyphs[ch].advance; });
                assert.ok(w <= part.w, key + ': ' + line + ' is ' + w + ' wide in ' + part.w);
            });
            seen.add(hud._token('motto1') + '/' + hud._token('motto2'));
        }
        assert.strictEqual(seen.size, 6, 'two choices show the same thing');
    },
    async 'with nothing chosen, or a choice this version does not know, Comfort shows NERV\'s motto'() {
        for (const settings of [{}, { motto: 'gone' }]) {
            await everyday('COMFORT', settings);
            const hud = counts.evas[0];
            assert.strictEqual(hud._token('motto1'), '神ハ天ニ在リ', JSON.stringify(settings));
            assert.strictEqual(hud._token('motto2'), '世ハ全テ事モ無シ', JSON.stringify(settings));
        }
    },
    async 'changing the line redraws only its two rows, without making the layers again'() {
        const { a } = await everyday('COMFORT');
        const hud = counts.evas[0], x = hud.widgets.get('text'), ref = x.ref, colon = hud.widgets.get('colon').ref;
        await wait(300);
        const rows = ['motto1', 'motto2'].map((id) => x.w.parts.find((q) => q.id === id));
        const ink = () => { const im = imageOf(a.hud(), ref); return rows.map((p) => { const out = []; for (let j = p.y; j < p.y + p.h; j++) out.push(im.slice((j * x.w.w + p.x) * 4, (j * x.w.w + p.x + p.w) * 4).toString('hex')); return out.join(''); }); };
        const was = ink(), before = a.hud().sent.length;
        a.set('motto', 'run');
        await wait(700);
        assert.strictEqual(hud.widgets.get('text').ref, ref, 'the layers were made again');
        assert.strictEqual(hud.widgets.get('colon').ref, colon);
        assert.strictEqual(hud._token('motto1'), '逃ゲチャダメダ');
        const now = ink();
        assert.notStrictEqual(now[0], was[0], 'the first row is still the old line');
        assert.notStrictEqual(now[1], was[1], 'the second row is still the old line');
        const writes = a.hud().sent.slice(before).filter((w) => w.ref === ref);
        assert.ok(writes.length >= 2, writes.length + ' writes');
        const inRow = writes.filter((w) => w.rects && rows.some((p) => { const r = w.rects[0]; return r.x >= p.x && r.y >= p.y && r.x + r.w <= p.x + p.w && r.y + r.h <= p.y + p.h; }));
        assert.strictEqual(inRow.length, 2, 'each row once');
        const after = a.hud().sent.length;
        await wait(400);
        assert.ok(!a.hud().sent.slice(after).some((w) => w.ref === ref && w.rects && rows.some((p) => { const r = w.rects[0]; return r.y < p.y + p.h && p.y < r.y + r.h; })), 'the line is written again and again');
    },
    async 'the fuel use is litres per hour over the speed, as L/100km'() {
        const { a, data } = await everyday('ECO_PRO');
        const hud = counts.evas[0];
        data.stage = 'D'; data.gear = 6; data.speed = 100;
        hud._reading('burn', 8, Date.now());
        assert.strictEqual(hud._token('burn'), '8.0');
        data.speed = 60;
        hud._reading('burn', 12, Date.now());
        assert.strictEqual(hud._token('burn'), '20.0');
        assert.ok(a);
    },
    async 'a fuel cut reads 0.0, and a crawl never runs off the box'() {
        const { a, data } = await everyday('ECO_PRO');
        const hud = counts.evas[0];
        data.stage = 'D'; data.gear = 6; data.speed = 80;
        hud._reading('burn', 0, Date.now());
        assert.strictEqual(hud._token('burn'), '0.0');
        data.speed = 5;
        hud._reading('burn', 30, Date.now());
        assert.strictEqual(hud._token('burn'), '99.9');
        assert.ok(a);
    },
    async 'no fuel use under 5 km/h, in P, R or N, or from an old reading: dashes'() {
        const { a, data } = await everyday('ECO_PRO');
        const hud = counts.evas[0];
        data.stage = 'D'; data.gear = 1; data.speed = 4.9;
        assert.strictEqual(hud._token('burn'), '--', 'nothing read yet');
        hud._reading('burn', 8, Date.now());
        assert.strictEqual(hud._token('burn'), '--', 'too slow');
        data.speed = 50;
        assert.strictEqual(hud._token('burn'), '16.0');
        for (const [stage, gear] of [['P', 0], ['R', -1], ['N', 0]]) {
            data.stage = stage; data.gear = gear;
            assert.strictEqual(hud._token('burn'), '--', stage);
        }
        data.stage = 'D'; data.gear = 3;
        hud._reading('burn', 8, Date.now() - 6000);
        assert.strictEqual(hud._token('burn'), '--', 'an old reading');
        assert.ok(a);
    },
    async 'the demo makes up a fuel use only under the demo setting'() {
        const a = startApp({ screens: 'hud', demo: 'on' });
        await wait(100);
        const hud = counts.evas[0];
        hud.car.data = () => ({ demo: true, stage: 'D', gear: 3, speed: 80, throttle: 0.3 });
        assert.ok(/^\d+\.\d$/.test(hud._token('burn')), hud._token('burn'));
    },
    async 'the engine unit is asked for the fuel use only while Eco Pro shows it'() {
        const { a, data } = await everyday('ECO_PRO');
        const hud = counts.evas[0];
        data.rpm = 2000; data.stage = 'D'; data.gear = 3; data.speed = 60;
        assert.strictEqual(hud._wantDiag().burn, true, 'driving in Eco Pro');
        data.stage = 'P'; data.gear = 0; data.speed = 0;
        const parked = hud._wantDiag();
        assert.ok(!parked || !parked.burn, 'parked');
        data.stage = 'D'; data.gear = 3; data.speed = 60;
        drive(a, 'COMFORT');
        await wait(200);
        assert.ok(!hud._wantDiag().burn, 'in Comfort');
        assert.ok(a);
    },
    async 'the range comes from the car, and is dashes when it says nothing useful'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        assert.strictEqual(hud._token('u:range'), 'KM');
        assert.strictEqual(hud._token('range'), '--');
        a.hu.feed('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', { range: 412 });
        await wait(50);
        assert.strictEqual(hud._token('range'), '412');
        a.hu.feed('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', { range: 4095 });
        await wait(50);
        assert.strictEqual(hud._token('range'), '--', '4095 means no value');
    },
    async 'a parked car that says nothing new keeps its range: it is read, not notified'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        a.hu.feed('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', { range: 300 });
        await wait(50);
        hud.car.lastCar = Date.now() - 600000;      // the engine signals have been quiet for ten minutes
        assert.strictEqual(hud._token('range'), '300');
    },
    async 'the range goes to dashes only when the reads have stopped'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        a.hu.feed('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', { range: 300 });
        await wait(50);
        hud.rangeAt -= 120000;
        assert.strictEqual(hud._token('range'), '--');
    },
    async 'the range is read every 10 s without being asked for by a screen, and the tyres are not read at all'() {
        const a = startApp({ screens: 'off', demo: 'off' });
        await wait(100);
        const polled = a.watches.filter((w) => w.opts && w.opts.pollMs === 10000);
        const has = (iface, field) => polled.some((w) => w.iface === iface && w.fields.indexOf(field) >= 0);
        assert.ok(has('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus'), 'range');
        assert.ok(!a.watches.some((w) => w.iface === TPMS), 'the tyres are still read');
    },
    async 'the clock follows the GMT offset in the menu, whatever zone the head unit is in'() {
        const pad = (n) => String(n).padStart(2, '0');
        const at = (hours) => { const d = new Date(Date.now() + hours * 3600000); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
        for (const off of [8, 14, -12, 0, -5]) {
            const a = startApp({ screens: 'hud', demo: 'off', gmtOffset: String(off) });
            await wait(50);
            const hud = counts.evas[0], want = at(off), got = hud._token('time');
            assert.ok(got === want || got === at(off), off + ': ' + got + ' not ' + want);   // the minute may turn over
            assert.strictEqual(got.split(':')[0], hud._token('hh'));
            assert.strictEqual(a.hud().refused.length, 0);
        }
    },
    async 'a new install is on GMT-5, and the head unit\'s own clock is still a choice'() {
        const pad = (n) => String(n).padStart(2, '0');
        let a = startApp({ screens: 'hud', demo: 'off' });
        await wait(50);
        let d = new Date(Date.now() - 5 * 3600000);
        assert.strictEqual(counts.evas[0]._token('hh'), pad(d.getUTCHours()));
        assert.strictEqual(counts.evas[0].setting('gmtOffset'), '-5');
        a = startApp({ screens: 'hud', demo: 'off', gmtOffset: 'unit' });
        await wait(50);
        d = new Date();
        assert.strictEqual(counts.evas[0]._token('hh'), pad(d.getHours()));
        const spec = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/eva_hud/app.json'), 'utf8')).settings.find((x) => x.key === 'gmtOffset');
        assert.strictEqual(spec.options.length, 28, 'the head unit, and GMT-12 to GMT+14');
        assert.deepStrictEqual(spec.options[1], ['-12', 'GMT-12']);
        assert.deepStrictEqual(spec.options[27], ['14', 'GMT+14']);
        assert.deepStrictEqual(spec.options[13], ['0', 'GMT+0']);
    },
    async 'changing the GMT offset moves the clock without redrawing the layers'() {
        const { a } = await everyday('COMFORT');
        const hud = counts.evas[0], ref = hud.widgets.get('text').ref, colon = hud.widgets.get('colon').ref;
        await wait(300);
        const before = a.hud().sent.length;
        const other = hud._token('hh') === '00' ? '6' : '9';
        a.set('gmtOffset', other);
        await wait(700);
        assert.strictEqual(hud.widgets.get('text').ref, ref, 'the layers were made again');
        assert.strictEqual(hud.widgets.get('colon').ref, colon);
        const pad = (n) => String(n).padStart(2, '0');
        assert.strictEqual(hud._token('hh'), pad(new Date(Date.now() + Number(other) * 3600000).getUTCHours()));
        const writes = a.hud().sent.slice(before).filter((w) => w.ref === ref);
        assert.ok(writes.length >= 1 && writes.length <= 3, writes.length + ' writes');
    },
    async 'the clock is 24-hour'() {
        const a = startApp({ screens: 'hud' });
        await wait(100);
        const hud = counts.evas[0];
        hud._now = () => ({ getHours: () => 15, getMinutes: () => 7 });
        assert.strictEqual(hud._token('time'), '15:07');
        hud._now = () => ({ getHours: () => 3, getMinutes: () => 14 });
        assert.strictEqual(hud._token('time'), '03:14');
        assert.strictEqual(hud._token('hh'), '03');
        assert.strictEqual(hud._token('mm'), '14');
        assert.ok(a);
    },
    async 'an alert in Comfort is still the full red one, and Comfort comes back after it'() {
        const a = startApp({ screens: 'hud' });
        await wait(150);
        drive(a, 'COMFORT');
        await wait(200);
        const normal = a.hud().shown().length;
        a.set('alertPreview', 'heat');
        await wait(250);
        assert.strictEqual(a.hud().alertLayers().length, 3);
        a.set('alertPreview', 'off');
        await wait(250);
        assert.strictEqual(a.hud().alertLayers().length, 0);
        assert.strictEqual(a.hud().shown().length, normal);
        assert.deepStrictEqual(a.hud().refused, []);
    },
    async 'a pop-up in Comfort still hides the HUD'() {
        const a = startApp({ screens: 'hud' });
        await wait(150);
        drive(a, 'COMFORT');
        await wait(200);
        popup('322', true);
        await wait(250);
        assert.strictEqual(a.hud().shown().length, 0);
    },
    async 'the status row names the drive mode only where it picks the layout'() {
        const a = startApp({ screens: 'hud' });
        await wait(150);
        drive(a, 'SPORT');
        await wait(700);
        assert.ok(/EVA HUD on \(Sport\)/.test(a.status()), a.status());
        assert.ok(!/DASH[^/]*\(Sport\)/.test(a.status()), a.status());
    },
    async 'the instruments follow the car'() {
        const a = startApp({ screens: 'hud', hudComfort: 'sport' });
        await wait(300);
        const u = a.hud().uniformsOf((l) => l.fs && /u_pedal/.test(l.fs));
        assert.ok(u.u_pedal && u.u_pedal.length === 1, 'no pedal');
        assert.ok(u.u_bar, 'not placed');
        assert.ok(!u.u_g && !u.u_ring, 'the G ring is still fed');
        assert.ok(u.u_pedal[0] >= 0 && u.u_pedal[0] <= 1);
    },
    async 'the NERV mark reaches the HUD alone, in red, once, without an error'() {
        const part = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/eva_hud/hud/layouts/hud_only_sport.json'), 'utf8'))
            .widgets.find((w) => w.type === 'evacanvas').parts.find((p) => p.id === 'logo');
        const a = startApp({ screens: 'hud', hudComfort: 'sport' });
        await wait(800);
        const logos = a.hud().sent.filter((w) => {
            const r = w.rects && w.rects[0];
            return a.hud().layers.has(w.ref) && r && r.x === part.x && r.y === part.y && r.w === part.w && r.h === part.h;
        });
        assert.strictEqual(logos.length, 1, logos.length + ' writes to the layer showing now');
        const px = logos[0].px;
        let lit = 0, red = 0;
        for (let o = 0; o < px.length; o += 4) { if (px[o + 3] > 128) { lit++; if (px[o] === 255 && px[o + 1] === 17 && px[o + 2] === 0) red++; } }
        assert.ok(lit > 0.3 * part.w * part.h, lit + ' lit pixels');
        assert.strictEqual(red, lit, 'not all red');
        assert.ok(!a.lines.some((l) => /part logo/.test(l)), a.lines.join(' | ').slice(0, 200));
    },
    async 'an alert shows on both screens at once'() {
        const a = startApp({ screens: 'both', alertPreview: 'heat' });
        await wait(300);
        assert.strictEqual(a.hud().alertLayers().length, 3);
        assert.strictEqual(a.dash().alertLayers().length, 3);
    },
    async 'with the HUD off, an alert still shows on the dash and draws nothing on the HUD'() {
        const a = startApp({ screens: 'dash', alertPreview: 'heat' });
        await wait(300);
        assert.strictEqual(a.hud().layers.size, 0);
        assert.strictEqual(a.dash().alertLayers().length, 3);
        assert.deepStrictEqual(a.lines.filter((l) => /^ERROR/.test(l)).map((l) => l.slice(0, 120)), []);
    },
    async 'with the dash off, an alert draws nothing on the cluster'() {
        const a = startApp({ screens: 'hud', alertPreview: 'heat' });
        await wait(300);
        assert.strictEqual(a.dash().layers.size, 0);
        assert.strictEqual(a.hud().alertLayers().length, 3);
    },
    async 'the black background stays through an alert, so BMW\'s gauges never show behind it'() {
        const a = startApp({ screens: 'both', alertPreview: 'heat' });
        await wait(300);
        const shown = a.dash().shown();
        assert.ok(shown.some((l) => l.klass === 'ambient'), 'the background is hidden');
        assert.strictEqual(shown.length, 4, 'the background and the 3 alert layers');
    },
    async 'when the alert ends the normal layers come back on both screens'() {
        const a = startApp({ screens: 'both', alertPreview: 'heat' });
        await wait(300);
        a.set('alertPreview', 'off');
        await wait(200);
        assert.strictEqual(a.hud().alertLayers().length, 0);
        assert.strictEqual(a.dash().alertLayers().length, 0);
        assert.strictEqual(a.dash().shown().length, 5);
        assert.strictEqual(a.dash().layers.size, 5, 'the alert\'s layers should be gone, their memory free');
        assert.strictEqual(a.hud().shown().length, 4);
        assert.deepStrictEqual(a.dash().refused, []);
    },
    async 'one alert after another on the dash needs no more memory'() {
        const a = startApp({ screens: 'both', alertPreview: 'heat' });
        await wait(300);
        ['knock', 'off', 'multi', 'fuel', 'off', 'afr'].forEach((v, i) => setTimeout(() => a.set('alertPreview', v), i * 120));
        await wait(1000);
        assert.deepStrictEqual(a.hud().refused.concat(a.dash().refused), []);
        assert.strictEqual(a.dash().alertLayers().length, 3);
    },
    async 'changing a setting during an alert leaves the dash whole'() {
        const a = startApp({ screens: 'both', alertPreview: 'heat' });
        await wait(300);
        a.set('redline', 6500);
        await wait(200);
        a.set('alertPreview', 'off');
        await wait(200);
        assert.deepStrictEqual(a.dash().refused, []);
        assert.strictEqual(a.dash().shown().length, 5);
    },
    async 'both screens read one set of car data'() {
        const a = startApp({ screens: 'both' });
        await wait(150);
        assert.strictEqual(counts.cars, 1);
        assert.ok(!a.lines.some((l) => /^ERROR/.test(l)), a.lines.filter((l) => /^ERROR/.test(l)).join(' | ').slice(0, 300));
    },
    async 'the center screen\'s status row names both screens'() {
        const a = startApp({ screens: 'both' });
        await wait(700);
        assert.ok(/HUD/.test(a.status()) && /DASH/.test(a.status()), a.status());
    },
    async 'a pop-up on the HUD hides the HUD\'s layers and leaves the dash alone'() {
        const a = startApp({ screens: 'both' });
        await wait(200);
        popup('322', true);
        await wait(250);
        assert.strictEqual(a.hud().shown().length, 0);
        assert.strictEqual(a.dash().shown().length, 5);
    },
    async 'the HUD comes back only some time after the pop-up goes'() {
        const a = startApp({ screens: 'both' });
        await wait(200);
        popup('322', true);
        await wait(250);
        popup('322', false);
        await wait(400);
        assert.strictEqual(a.hud().shown().length, 0, 'too soon');
        await wait(1400);
        assert.strictEqual(a.hud().shown().length, 4);
    },
    async 'a pop-up on the cluster hides the dash, background too, and leaves the HUD alone'() {
        const a = startApp({ screens: 'both' });
        await wait(200);
        popup('202', true);
        await wait(250);
        assert.strictEqual(a.dash().shown().length, 0);
        assert.strictEqual(a.hud().shown().length, 4);
    },
    async 'nothing is uploaded for a screen while it gives way'() {
        const a = startApp({ screens: 'both' });
        await wait(SETTLE_MS);
        popup('322', true);
        await wait(250);
        const before = a.hud().writes;
        await wait(500);
        assert.strictEqual(a.hud().writes, before);
    },
    async 'an alert waits out a pop-up, then shows, with the normal layers still hidden'() {
        const a = startApp({ screens: 'both' });
        await wait(200);
        popup('322', true);
        await wait(250);
        a.set('alertPreview', 'heat');
        await wait(250);
        assert.strictEqual(a.hud().shown().length, 0, 'the HUD should still give way');
        assert.strictEqual(a.dash().alertLayers().length, 3, 'the dash should show the alert');
        popup('322', false);
        await wait(1800);
        assert.strictEqual(a.hud().alertLayers().length, 3);
        assert.strictEqual(a.hud().shown().length, 3);
    },
    async 'a pop-up during an alert hides the alert, and the alert comes back'() {
        const a = startApp({ screens: 'both', alertPreview: 'heat' });
        await wait(300);
        popup('322', true);
        await wait(250);
        assert.strictEqual(a.hud().shown().length, 0);
        popup('322', false);
        await wait(1800);
        assert.strictEqual(a.hud().alertLayers().length, 3);
        assert.strictEqual(a.hud().shown().length, 3);
    },
    async 'a setting changed during a pop-up does not bring the layers back early'() {
        const a = startApp({ screens: 'both' });
        await wait(200);
        popup('322', true);
        await wait(250);
        a.set('redline', 6500);
        await wait(200);
        assert.strictEqual(a.hud().shown().length, 0);
        popup('322', false);
        await wait(1800);
        assert.strictEqual(a.hud().shown().length, 4);
    },
    async 'the status row says why a screen is empty'() {
        const a = startApp({ screens: 'both' });
        await wait(200);
        popup('322', true);
        await wait(800);
        assert.ok(/pop-up/.test(a.status()), a.status());
    },
    async 'the NERV mark flickers between red and amber, sending only its own rectangle'() {
        const layout = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps/eva_hud/hud/layouts/hud_only_sport.json'), 'utf8'));
        const canvas = layout.widgets.find((w) => w.type === 'evacanvas'), part = canvas.parts.find((p) => p.id === 'logo');
        part.flicker.gapMs = [100, 100];        // a layout in the data folder replaces the shipped one: no 20 s wait here
        const a = startApp({ hudComfort: 'sport', screens: 'hud' }, { layouts: { hud_only_sport: layout } });
        await wait(1200);
        const mine = a.hud().sent.filter((w) => {
            const r = w.rects && w.rects[0];
            return a.hud().layers.has(w.ref) && r && r.x === part.x && r.y === part.y && r.w === part.w && r.h === part.h;
        });
        const colour = (px) => { for (let o = 0; o < px.length; o += 4) if (px[o + 3] > 200) return [px[o], px[o + 1], px[o + 2]].join(); return ''; };
        const seen = mine.map((w) => colour(w.px));
        assert.ok(seen.indexOf('255,17,0') >= 0, 'no red: ' + seen.join(' '));
        assert.ok(seen.indexOf('255,176,0') >= 0, 'no amber: ' + seen.join(' '));
        assert.ok(mine.every((w) => w.px.length === part.w * part.h * 4));
        assert.ok(!a.lines.some((l) => /part logo/.test(l)), a.lines.join(' | ').slice(0, 200));
    },
    async 'pressure is always PSI and power always HP, whatever an old settings file says'() {
        for (const units of ['metric', 'us']) {
            const a = startApp({ screens: 'both', units, demo: 'off' });
            await wait(100);
            const hud = counts.evas[0];
            hud.boostFes = 1; hud.boostFesAt = Date.now();
            hud._raw = ((raw) => (n) => (n === 'torque' ? 400 : n === 'rpm' ? 5000 : raw.call(hud, n)))(hud._raw);
            assert.strictEqual(hud._token('u:boost'), 'PSI', units);
            assert.strictEqual(hud._token('boost'), '14.5', units);
            assert.strictEqual(hud._token('u:power'), 'HP', units);
            assert.strictEqual(hud._token('power'), '281', units);
        }
    },
    async 'the other units stay metric, whatever an old settings file says'() {
        const a = startApp({ screens: 'both', units: 'us', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        hud._raw = ((raw) => (n) => (n === 'torque' ? 400 : n === 'coolant' ? 90 : n === 'speed' ? 100 : raw.call(hud, n)))(hud._raw);
        assert.strictEqual(hud._token('u:torque'), 'NM');
        assert.strictEqual(hud._token('torque'), '400');
        assert.strictEqual(hud._token('u:temp'), '°C');
        assert.strictEqual(hud._token('coolant'), '90');
        assert.strictEqual(hud._token('u:speed'), 'KM/H');
        assert.strictEqual(hud._token('speed'), '100');
    },
    async 'no boost reading shows dashes, not a converted nothing'() {
        const a = startApp({ screens: 'both', demo: 'off' });
        await wait(100);
        assert.strictEqual(counts.evas[0]._token('boost'), '--');
        assert.ok(a);
    },
    async 'an alert shows pressure in PSI, its limits staying in bar inside'() {
        const a = startApp({ screens: 'both' });
        await wait(100);
        const hud = counts.evas[0];
        hud.alertKey = 'boost'; hud.alertShow = { kind: 'single', id: 'boost', value: 2 };
        assert.strictEqual(hud._alertValue(), '29.0');
        assert.strictEqual(hud._token('a:unit'), 'PSI');
        hud.alertKey = 'fuel'; hud.alertShow = { kind: 'single', id: 'fuel', value: 30 };
        assert.strictEqual(hud._alertValue(), '435');
        assert.strictEqual(hud._token('a:unit'), 'PSI');
        hud.alertKey = 'heat'; hud.alertShow = { kind: 'single', id: 'heat', value: 118 };
        assert.strictEqual(hud._alertValue(), '118');
        assert.strictEqual(hud._token('a:deg'), '°C');
        assert.strictEqual(hud.alerts.thresholds.boost, 2, 'the limit is in bar');
        assert.ok(a);
    },
    async 'the dash stays on the whole cluster unless the menu picks design A'() {
        const a = startApp({ screens: 'dash' });
        await wait(150);
        assert.deepStrictEqual(a.dash().targets(), ['panel']);
    },
    async 'design A draws under BMW\'s gauges on the map target, asking for the slot and leaving BMW\'s turn box alone'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a' });
        await wait(150);
        assert.deepStrictEqual(a.dash().targets(), ['map']);
        assert.strictEqual(a.dash().layers.size, 5);
        assert.deepStrictEqual(a.dash().refused, []);
        assert.strictEqual(a.hud().layers.size, 0);
        Array.from(a.dash().layers.values()).forEach((l) => {
            assert.strictEqual(l.contend, 1, 'a map layer must contend to take the slot from the stock map');
            assert.strictEqual(l.guide_hold, 0, 'it should not hold another slot');
        });
    },
    async 'the whole cluster asks for nothing new'() {
        const a = startApp({ screens: 'dash' });
        await wait(150);
        Array.from(a.dash().layers.values()).forEach((l) => {
            assert.strictEqual(l.contend, undefined);
            assert.strictEqual(l.guide_hold, undefined);
        });
    },
    async 'changing the design redraws the dash on its new target and leaves the HUD alone'() {
        const a = startApp({ screens: 'both' });
        await wait(SETTLE_MS);
        const hudLayers = Array.from(a.hud().layers.keys()).join();
        a.set('bothDash', 'a');
        await wait(200);
        assert.deepStrictEqual(a.dash().targets(), ['map']);
        assert.strictEqual(a.dash().layers.size, 5);
        assert.strictEqual(Array.from(a.hud().layers.keys()).join(), hudLayers, 'the HUD was redrawn');
        a.set('bothDash', 'whole');
        await wait(200);
        assert.deepStrictEqual(a.dash().targets(), ['panel']);
        assert.deepStrictEqual(a.dash().refused, []);
    },
    async 'turning the dash off after design A leaves nothing behind'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a' });
        await wait(SETTLE_MS);
        a.set('screens', 'hud');
        await wait(200);
        assert.strictEqual(a.dash().layers.size, 0);
        assert.ok(/cluster/.test(counts.evas[1].statusText()), counts.evas[1].statusText());
    },
    async 'design A shows all six alerts on the map target, with nothing refused'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a' });
        await wait(SETTLE_MS);
        for (const id of ['knock', 'fuel', 'afr', 'heat', 'boost', 'multi']) {
            a.set('alertPreview', id);
            await wait(150);
            assert.strictEqual(a.dash().alertLayers().length, 3, id);
            assert.deepStrictEqual(a.dash().targets(), ['map'], id);
            assert.strictEqual(counts.evas[1].alertLayout.name, 'EVA centre alert', id);
        }
        assert.deepStrictEqual(a.dash().refused, []);
        assert.ok(a.dash().layers.size <= 8, a.dash().layers.size + ' layers');
        assert.deepStrictEqual(a.lines.filter((l) => /^ERROR/.test(l)).map((l) => l.slice(0, 160)), []);
    },
    async 'design A keeps its images through an alert, and sends them only once'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], gearRef = dash.widgets.get('gear').ref, textRef = dash.widgets.get('text').ref;
        a.set('alertPreview', 'heat');
        await wait(200);
        assert.ok(a.dash().layers.has(gearRef) && a.dash().layers.has(textRef), 'an image was dropped for the alert');
        assert.strictEqual(a.dash().layers.size, 8);
        const before = a.dash().sent.length;
        a.set('alertPreview', 'off');
        await wait(300);
        assert.strictEqual(a.dash().alertLayers().length, 0);
        assert.strictEqual(a.dash().shown().length, 5);
        assert.strictEqual(a.dash().layers.size, 8, 'the alert\'s layers stay, hidden, for the next one');
        const big = a.dash().sent.slice(before).reduce((n, s) => n + s.px.length, 0);
        assert.ok(big < 200 * 1024, big + ' bytes sent when the alert ended');
        const sent = a.dash().sent.length;
        a.set('alertPreview', 'heat');
        await wait(200);
        const again = a.dash().sent.slice(sent).reduce((n, s) => n + s.px.length, 0);
        const t = dash.alertLayout.title;
        assert.strictEqual(a.dash().alertLayers().length, 3);
        assert.ok(again >= 0 && again <= 2 * t.w * t.h * 4 + 700 * 1024, again + ' bytes for the same alert again');
    },
    async 'design A\'s hex pattern goes dark in an alert and comes back'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a' });
        await wait(SETTLE_MS);
        const hex = (l) => l.fs && /u_cell/.test(l.fs), lit = () => a.dash().uniformsOf(hex).u_alpha[0];
        const on = lit();
        assert.ok(on > 0, 'the pattern is dark');
        a.set('alertPreview', 'heat');
        await wait(200);
        assert.ok(a.dash().shown().some(hex), 'the ground went away in the alert');
        assert.strictEqual(lit(), 0);
        a.set('alertPreview', 'off');
        await wait(200);
        assert.strictEqual(lit(), on);
    },
    async 'a BMW pop-up does not hide a centre design: BMW draws over the map target'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a', demo: 'off' });
        await wait(SETTLE_MS);
        const shown = a.dash().shown().length;
        popup('202', true);
        await wait(250);
        assert.strictEqual(a.dash().shown().length, shown);
        assert.strictEqual(counts.evas[1].givingWay, false);
    },
    async 'design A\'s gear frame shows the owner\'s words in P, R and N, and a digit on the move'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        const x = dash.widgets.get('gear'), state = () => dash._gearFor(x.w);
        assert.deepStrictEqual([state().kind, state().text], ['digit', '3']);
        [['P', '出撃待命'], ['R', '緊急撤退'], ['N', '同期解除']].forEach(([stage, word]) => {
            data.stage = stage;
            assert.deepStrictEqual([state().kind, state().text], ['word', word], stage);
        });
        data.stage = 'R';
        await wait(150);
        assert.strictEqual(imageOf(a.dash(), x.ref).compare(dash._paintGear(x.w, state(), false)), 0, 'the service does not hold the word');
        assert.strictEqual(x.op, 1, 'a word should hold still, not breathe');
    },
    async 'a digit is drawn in the middle of design A\'s frame'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], w = dash.widgets.get('gear').w;
        ['3', '6', '8'].forEach((text) => {
            const px = dash._paintGear(w, { kind: 'digit', text }, false);
            let top = w.h, bottom = -1;
            for (let y = 0; y < w.h; y++) for (let i = 0; i < w.w; i++) if (px[(y * w.w + i) * 4 + 3] > 200) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
            assert.ok(Math.abs((top + bottom) / 2 - w.h / 2) <= 8, text + ' ink runs ' + top + ' to ' + bottom + ' of ' + w.h);
        });
    },
    async 'other designs keep their gear words as they were'() {
        const a = startApp({ screens: 'dash', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 0, stage: 'R', gear: -1, rpm: 800 };
        dash.car.data = () => data;
        const x = dash.widgets.get('gear');
        assert.strictEqual(dash._gearFor(x.w).kind, 'reverse');
        data.stage = 'P'; data.gear = 0;
        assert.strictEqual(dash._gearFor(x.w).kind, 'standby');
    },
    async 'MAGI follows the car: warming up, unanimous, then rejecting with its reason'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000, oil: 42, coolant: 48 };
        dash.car.data = () => data;
        const say = () => [dash._token('magi:word'), dash._token('magi:sub')];
        assert.deepStrictEqual(say(), ['審議中', 'DELIBERATING // 暖機中']);
        data.oil = 100; data.coolant = 90;
        assert.deepStrictEqual(say(), ['全会一致', 'UNANIMOUS // 出撃承認']);
        data.oil = 132;
        assert.deepStrictEqual(say(), ['否決', 'REJECTED // 油温上昇']);
        data.oil = 100; data.stage = 'P';
        assert.deepStrictEqual(say(), ['審議中', 'DELIBERATING // 待機中']);
    },
    async 'a MAGI plate is painted only when its vote changes, and differently for each vote'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        await wait(400);
        const textRef = dash.widgets.get('text').ref, plate = dash.widgets.get('text').w.parts.find((p) => p.id === 'plate_m');
        const looks = ['ok', 'wait', 'no'].map((v) => dash._partPixels(plate, 'plate|' + v));
        assert.ok(looks[0].compare(looks[1]) !== 0 && looks[1].compare(looks[2]) !== 0, 'the votes look the same');
        looks.forEach((px) => assert.strictEqual(px.length, plate.w * plate.h * 4));
        const count = () => a.dash().sent.filter((s) => s.ref === textRef && s.rects && s.rects[0].x >= plate.x && s.rects[0].x < plate.x + plate.w && s.rects[0].y >= plate.y && s.rects[0].y < plate.y + plate.h).length;
        const n = count();
        await wait(500);
        assert.strictEqual(count(), n, 'a steady vote was sent again');
        data.oil = 132;
        await wait(400);
        assert.strictEqual(count(), n + 1, 'a new vote should send one rectangle');
    },
    async 'the oil and coolant readouts turn red with their vote, and only then'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        const parts = dash.widgets.get('text').w.parts, oil = parts.find((p) => p.id === 'oil_v'), water = parts.find((p) => p.id === 'water_v');
        const look = (p) => dash._partLook(p, Date.now()).split('|')[0];
        const normal = look(oil);
        data.oil = 132;
        assert.notStrictEqual(look(oil), normal);
        assert.strictEqual(look(water), normal);
        data.oil = 100; data.coolant = 112;
        assert.strictEqual(look(oil), normal);
        assert.notStrictEqual(look(water), normal);
    },
    async 'every design can be picked in the menu in any order, with nothing refused or left behind'() {
        const a = startApp({ screens: 'dash' });
        await wait(SETTLE_MS);
        for (const [design, target, n] of [['a', 'map', 5], ['b', 'map', 3], ['d', 'panel', 5], ['whole', 'panel', 5], ['c1', 'map', 4], ['c2', 'map', 3], ['c3', 'panel', 6], ['e1', 'map', 4], ['e2', 'map', 4], ['e3', 'panel', 6], ['b', 'map', 3], ['e2', 'map', 4], ['d', 'panel', 5]]) {
            a.set('dashDesign', design);
            await wait(200);
            assert.deepStrictEqual(a.dash().targets(), [target], design);
            assert.strictEqual(a.dash().layers.size, n, design);
            assert.deepStrictEqual(a.dash().refused, [], design);
        }
        assert.deepStrictEqual(a.lines.filter((l) => /^ERROR|unusable/.test(l)).map((l) => l.slice(0, 160)), []);
    },
    async 'design B shows all six alerts on the map target, and its stripes go dark under them'() {
        const a = startApp({ screens: 'dash', dashDesign: 'b' });
        await wait(SETTLE_MS);
        const stripes = (l) => l.fs && /u_stripe/.test(l.fs), lit = () => a.dash().uniformsOf(stripes).u_alpha[0];
        assert.strictEqual(lit(), 1);
        for (const id of ['knock', 'fuel', 'afr', 'heat', 'boost', 'multi']) {
            a.set('alertPreview', id);
            await wait(150);
            assert.strictEqual(a.dash().alertLayers().length, 3, id);
            assert.strictEqual(counts.evas[1].alertLayout.name, 'EVA centre alert', id);
        }
        assert.strictEqual(lit(), 0);
        assert.ok(a.dash().shown().some(stripes), 'the ground went away');
        a.set('alertPreview', 'off');
        await wait(200);
        assert.strictEqual(lit(), 1);
        assert.strictEqual(a.dash().shown().length, 3);
        assert.deepStrictEqual(a.dash().refused, []);
    },
    async 'design B\'s middle shows the range, and with no range only its dim segments'() {
        const a = startApp({ screens: 'dash', dashDesign: 'b', demo: 'off' });
        await wait(SETTLE_MS);
        const hud = counts.evas[0], seven = () => a.dash().uniformsOf((l) => l.fs && /u_digits/.test(l.fs));
        assert.deepStrictEqual(seven().u_digits, [-1, -1, -1, -1]);
        assert.deepStrictEqual(seven().u_sepOn, [0]);
        hud.rangeNow = 412; hud.rangeAt = Date.now();
        await wait(150);
        assert.deepStrictEqual(seven().u_digits, [4, 1, 2, 0]);
        assert.deepStrictEqual(seven().u_sepAfter, [2]);
        assert.deepStrictEqual(seven().u_colon, [0]);
        assert.deepStrictEqual(seven().u_sepOn, [1]);
        hud.rangeNow = 87; hud.rangeAt = Date.now();
        await wait(150);
        assert.deepStrictEqual(seven().u_digits, [-1, 8, 7, 0], 'no leading zero');
    },
    async 'design B\'s middle shows the time when the menu says so, at once, with the colon beating'() {
        const a = startApp({ screens: 'dash', dashDesign: 'b', demo: 'off', gmtOffset: '0' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], seven = () => a.dash().uniformsOf((l) => l.fs && /u_digits/.test(l.fs));
        const layers = Array.from(a.dash().layers.keys()).join();
        a.set('dashCenter', 'time');
        await wait(150);
        assert.strictEqual(Array.from(a.dash().layers.keys()).join(), layers, 'it should not redraw the layers');
        const n = new Date(), want = [Math.floor(n.getUTCHours() / 10), n.getUTCHours() % 10, Math.floor(n.getUTCMinutes() / 10), n.getUTCMinutes() % 10];
        assert.deepStrictEqual(seven().u_digits, want);
        assert.deepStrictEqual(seven().u_sepAfter, [1]);
        assert.deepStrictEqual(seven().u_colon, [1]);
        assert.strictEqual(dash._token('b:title'), '現在時刻');
        assert.strictEqual(dash._token('b:en'), 'LOCAL TIME');
        assert.strictEqual(dash._token('b:unit'), '');
        const beats = new Set();
        for (let i = 0; i < 24; i++) { beats.add(seven().u_sepOn[0]); await wait(100); }
        assert.deepStrictEqual(Array.from(beats).sort(), [0, 1], 'the colon should beat');
        a.set('dashCenter', 'range');
        await wait(150);
        assert.strictEqual(dash._token('b:title'), '活動限界まで');
        assert.strictEqual(dash._token('b:unit'), 'KM');
    },
    async 'design B sends its digits as a uniform, only when they change'() {
        const a = startApp({ screens: 'dash', dashDesign: 'b', demo: 'off' });
        await wait(SETTLE_MS);
        counts.evas[0].rangeNow = 412; counts.evas[0].rangeAt = Date.now();
        await wait(150);
        const n = a.dash().uniformCalls;
        await wait(500);
        assert.ok(a.dash().uniformCalls - n <= 2, (a.dash().uniformCalls - n) + ' uniforms for a steady range');
    },
    async 'design B\'s lamps follow the gear and the drive mode'() {
        const a = startApp({ screens: 'dash', dashDesign: 'b', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        drive(a, 'SPORT');
        await wait(150);
        const parts = dash.widgets.get('text').w.parts, on = () => parts.filter((p) => p.type === 'lamp' && dash._partLook(p, Date.now()).indexOf('lamp|on') === 0 && p.when !== 'always').map((p) => p.when).join();
        assert.strictEqual(on(), 'sport');
        data.stage = 'P';
        drive(a, 'COMFORT');
        await wait(150);
        assert.strictEqual(on(), 'comfort');
        data.stage = 'R';
        drive(a, 'ECO PRO');
        await wait(150);
        assert.strictEqual(on(), 'eco');
        const lamp = parts.find((p) => p.when === 'eco');
        assert.notStrictEqual(dash._partPixels(lamp, 'lamp|on').compare(dash._partPixels(lamp, 'lamp|off')), 0);
    },
    async 'design B\'s small gear shows a letter or a digit, and its stripes turn red with a rejected temperature'() {
        const a = startApp({ screens: 'dash', dashDesign: 'b', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        const stripes = () => a.dash().uniformsOf((l) => l.fs && /u_stripe/.test(l.fs)).u_stripe;
        await wait(100);
        assert.strictEqual(dash._token('gearshort'), '3');
        const normal = stripes().join();
        data.oil = 132;
        await wait(100);
        assert.notStrictEqual(stripes().join(), normal);
        data.oil = 100; data.speed = 0;
        await wait(100);
        assert.strictEqual(stripes().join(), normal);
        assert.strictEqual(dash._token('gearshort'), 'D');
        ['P', 'R', 'N'].forEach((k) => { data.stage = k; assert.strictEqual(dash._token('gearshort'), k); });
    },
    async 'design D covers the cluster and shows the alert as the original does'() {
        const a = startApp({ screens: 'dash', dashDesign: 'd', alertPreview: 'heat' });
        await wait(300);
        assert.deepStrictEqual(a.dash().targets(), ['panel']);
        assert.strictEqual(a.dash().alertLayers().length, 3);
        assert.deepStrictEqual(a.dash().refused, []);
        assert.strictEqual(counts.evas[1].alertLayout.name, 'EVA dash alert');
        a.set('alertPreview', 'off');
        await wait(300);
        assert.strictEqual(a.dash().alertLayers().length, 0);
        assert.strictEqual(a.dash().shown().length, 5);
        assert.deepStrictEqual(a.dash().refused, []);
    },
    async 'design D gives way to a BMW pop-up, as the whole cluster has to'() {
        const a = startApp({ screens: 'dash', dashDesign: 'd', demo: 'off' });
        await wait(SETTLE_MS);
        popup('202', true);
        await wait(250);
        assert.strictEqual(counts.evas[1].givingWay, true);
        assert.strictEqual(a.dash().shown().length, 0);
    },
    async 'design D\'s gear frame has the owner\'s words, and its revs follow the car'() {
        const a = startApp({ screens: 'dash', dashDesign: 'd', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'R', gear: -1, rpm: 3200, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        const x = dash.widgets.get('gear');
        assert.deepStrictEqual([dash._gearFor(x.w).kind, dash._gearFor(x.w).text], ['word', '緊急撤退']);
        await wait(600);
        assert.strictEqual(dash._token('rpm'), String(dash.rpmShown));
        assert.ok(/^\d+$/.test(dash._token('rpm')), dash._token('rpm'));
    },
    async 'with a drive mode set to off, no alert shows and the engine unit is left alone'() {
        const a = startApp({ screens: 'drive', comfortScreens: 'hud', ecoScreens: 'off', alertPreview: 'heat' });
        await wait(SETTLE_MS);
        drive(a, 'ECO PRO');
        await wait(300);
        assert.strictEqual(a.hud().alertLayers().length + a.dash().alertLayers().length, 0);
        assert.strictEqual(counts.evas[0]._wantDiag(), null);
    },
    async 'the status names the drive mode under By drive mode'() {
        const a = startApp({ screens: 'drive', sportScreens: 'dash', sportDash: 'a' });
        await wait(SETTLE_MS);
        drive(a, 'SPORT');
        await wait(200);
        assert.ok(/Sport/i.test(counts.evas[1].statusText()), counts.evas[1].statusText());
    },
    async 'any other Mode ignores the drive modes\' choices'() {
        const a = startApp({ screens: 'dash', dashDesign: 'a', sportScreens: 'off', sportDash: 'b' });
        await wait(SETTLE_MS);
        drive(a, 'SPORT');
        await wait(200);
        assert.deepStrictEqual(a.dash().targets(), ['map']);
        assert.strictEqual(a.dash().layers.size, 5);
    },
    async 'the everyday designs\' ground is plain black, and design A keeps its hex lines'() {
        const a = startApp({ screens: 'dash', dashDesign: 'c1' });
        await wait(SETTLE_MS);
        const lines = () => a.dash().uniformsOf((l) => l.fs && /u_cell/.test(l.fs)).u_alpha[0];
        assert.strictEqual(lines(), 0);
        a.set('dashDesign', 'a');
        await wait(200);
        assert.ok(lines() > 0);
    },
    async 'design B\'s power lamp says where the power comes from'() {
        const a = startApp({ screens: 'dash', dashDesign: 'b', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        const lamp = dash.widgets.get('text').w.parts.find((p) => p.when === 'always');
        const look = () => dash._partLook(lamp, Date.now());
        assert.strictEqual(look(), 'lamp|on|内部電源');
        const moving = dash._partPixels(lamp, look());
        data.stage = 'P';
        assert.strictEqual(look(), 'lamp|on|外部電源');
        assert.notStrictEqual(dash._partPixels(lamp, look()).compare(moving), 0, 'the two states look the same');
    },
    async 'E1\'s bar follows the fuel use and not the revs, and stays empty where there is no reading'() {
        const a = startApp({ screens: 'dash', dashDesign: 'e1', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 100, stage: 'D', gear: 6, rpm: 6900, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        dash.readings.burn = { v: 10, at: Date.now() };
        await wait(150);
        const seg = () => a.dash().uniformsOf((l) => l.fs && /u_strobe/.test(l.fs));
        assert.deepStrictEqual(seg().u_value, [0.5], '10 L/100km is half of the bar');
        assert.deepStrictEqual(seg().u_strobe, [0], 'it should not strobe at the shift point');
        data.stage = 'P';
        await wait(150);
        assert.deepStrictEqual(seg().u_value, [0]);
    },
    async 'E2\'s rings light outward with the fuel use, by uniform, and go out with no reading'() {
        const a = startApp({ screens: 'dash', dashDesign: 'e2', demo: 'off' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 100, stage: 'D', gear: 6, rpm: 2000, oil: 100, coolant: 90 };
        dash.car.data = () => data;
        const lit = () => a.dash().uniformsOf((l) => l.fs && /u_lit/.test(l.fs)).u_lit[0];
        assert.strictEqual(lit(), 0);
        dash.readings.burn = { v: 10, at: Date.now() };
        await wait(150);
        assert.strictEqual(lit(), 4);
        dash.readings.burn = { v: 40, at: Date.now() };
        await wait(150);
        assert.strictEqual(lit(), 7);
        const n = a.dash().uniformCalls;
        await wait(400);
        assert.ok(a.dash().uniformCalls - n <= 2, 'a steady fuel use keeps sending');
        data.stage = 'P';
        await wait(150);
        assert.strictEqual(lit(), 0);
    },
    async 'the fuel use is read while a design shows it, and only then, on the move'() {
        const a = startApp({ screens: 'dash', dashDesign: 'e1', demo: 'off' });
        await wait(SETTLE_MS);
        const hud = counts.evas[0], data = { speed: 100, stage: 'D', gear: 6, rpm: 2000, oil: 100, coolant: 90 };
        hud.car.data = () => data;
        assert.strictEqual(hud._wantDiag().burn, true);
        data.stage = 'P';
        assert.strictEqual(hud._wantDiag().burn, false);
        data.stage = 'D';
        for (const [design, want] of [['e2', true], ['e3', true], ['a', false], ['c1', false]]) {
            a.set('dashDesign', design);
            await wait(200);
            assert.strictEqual(hud._wantDiag().burn, want, design);
        }
    },
    async 'E3 shows the range even when design B\'s middle is set to the time'() {
        const a = startApp({ screens: 'dash', dashDesign: 'e3', dashCenter: 'time', demo: 'off' });
        await wait(SETTLE_MS);
        const hud = counts.evas[0];
        hud.rangeNow = 412; hud.rangeAt = Date.now();
        await wait(150);
        const seven = a.dash().uniformsOf((l) => l.fs && /u_digits/.test(l.fs));
        assert.deepStrictEqual(seven.u_digits, [4, 1, 2, 0]);
        assert.deepStrictEqual(seven.u_colon, [0]);
    },
    async 'C2 draws each line in the font that fills the shape with it'() {
        const a = startApp({ screens: 'dash', dashDesign: 'c2', demo: 'off', motto: 'run' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], p = dash.widgets.get('text').w.parts.find((q) => q.id === 'row1');
        const look = dash._partLook(p, Date.now());
        const big = dash._partPixels(p, look);
        a.set('motto', 'heaven');
        await wait(150);
        assert.notStrictEqual(dash._partPixels(p, look).compare(big), 0, 'the same words should be sized for this line');
        assert.deepStrictEqual(a.dash().refused, []);
    },
    async 'in P, R and N the line steps aside for the big word, and its small line says what the word means'() {
        const a = startApp({ screens: 'dash', dashDesign: 'c1', demo: 'off', motto: 'heaven' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], data = { speed: 60, stage: 'D', gear: 3, rpm: 2000 };
        dash.car.data = () => data;
        const parts = dash.widgets.get('text').w.parts, row = parts.find((p) => p.id === 'motto1');
        const says = () => dash._partLook(row, Date.now()).split('|')[1];
        assert.strictEqual(says(), '神ハ天ニ在リ');
        assert.strictEqual(dash._token('msub'), "GOD'S IN HIS HEAVEN // ALL'S RIGHT WITH THE WORLD");
        data.stage = 'P';
        assert.strictEqual(says(), '');
        assert.strictEqual(dash._token('msub'), 'SORTIE STANDBY // 拘束具固定');
    },
    async 'C3 gives its vertical cells one character each, with the long vowel mark standing up'() {
        const a = startApp({ screens: 'dash', dashDesign: 'c3', demo: 'off', motto: 'field' });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], at = (r, i) => dash._token('mv:' + r + ':' + i);
        assert.strictEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8'].map((i) => at(1, i)).join(''), 'A.T.フィ｜ルド');
        assert.strictEqual(at(1, 9), '');
        a.set('motto', 'project');
        assert.strictEqual(['0', '1', '2', '3', '4', '5', '6'].map((i) => at(2, i)).join(''), '第3段階進行中', 'the space is left out');
    },
    async 'every design shows every alert with nothing refused, and comes back to the same layers'() {
        for (const design of ['c1', 'c2', 'c3', 'e1', 'e2', 'e3']) {
            const a = startApp({ screens: 'dash', dashDesign: design });
            await wait(SETTLE_MS);
            const n = a.dash().shown().length;
            for (const id of ['knock', 'multi']) {
                a.set('alertPreview', id);
                await wait(120);
                assert.strictEqual(a.dash().alertLayers().length, 3, design + ' ' + id);
                assert.ok(a.dash().layers.size <= 8, design + ': ' + a.dash().layers.size + ' layers');
            }
            a.set('alertPreview', 'off');
            await wait(250);
            assert.strictEqual(a.dash().shown().length, n, design);
            assert.deepStrictEqual(a.dash().refused, [], design);
            assert.deepStrictEqual(a.lines.filter((l) => /^ERROR|unusable/.test(l)).map((l) => l.slice(0, 160)), [], design);
            counts.evas.forEach((e) => e.stop && e.stop());
        }
    },
    async 'HUD only: each drive mode shows the HUD picked for it, and Off leaves it to BMW'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(SETTLE_MS);
        const hud = counts.evas[0], at = async (mode) => { drive(a, mode); await wait(200); return hud.activeName; };
        assert.strictEqual(await at('SPORT'), 'hud_only_sport');
        assert.strictEqual(await at('COMFORT'), 'hud_only_comfort');
        assert.strictEqual(await at('ECO PRO'), 'hud_only_eco', 'by default each drive mode has its own');
        a.set('hudEco', 'sport');
        a.set('hudSport', 'comfort');
        await wait(200);
        assert.strictEqual(hud.activeName, 'hud_only_sport');
        assert.strictEqual(await at('SPORT'), 'hud_only_comfort');
        a.set('hudComfort', 'off');
        assert.strictEqual(await at('COMFORT'), 'off');
        assert.strictEqual(a.hud().layers.size, 0);
        assert.strictEqual(a.dash().layers.size, 0);
    },
    async 'Dash only: each drive mode shows the dash picked for it, and Off leaves it to BMW'() {
        const a = startApp({ screens: 'dash', dashComfort: 'c2', dashSport: 'a', dashEco: 'e2', _menuV: 2 });
        await wait(SETTLE_MS);
        const dash = counts.evas[1], at = async (mode) => { drive(a, mode); await wait(200); return dash.activeName; };
        assert.strictEqual(await at('SPORT'), 'a');
        assert.deepStrictEqual(a.dash().targets(), ['map']);
        assert.strictEqual(await at('COMFORT'), 'c2');
        assert.strictEqual(await at('ECO PRO'), 'e2');
        assert.strictEqual(a.hud().layers.size, 0);
        a.set('dashEco', 'off');
        await wait(200);
        assert.strictEqual(dash.activeName, 'off');
        assert.strictEqual(a.dash().layers.size, 0);
        assert.strictEqual(a.hud().layers.size, 0);
    },
    async 'HUD + Dash: each drive mode has its own pair, separate from the other modes\' choices'() {
        const a = startApp({ screens: 'both', demo: 'off', _menuV: 2, hudSport: 'eco', dashSport: 'c2',
            bothHudComfort: 'comfort', bothDashComfort: 'c1', bothHudSport: 'eva', bothDashSport: 'a', bothHudEco: 'off', bothDashEco: 'e3' });
        await wait(SETTLE_MS);
        const hud = counts.evas[0], dash = counts.evas[1];
        const at = async (mode) => { drive(a, mode); await wait(250); return [hud.activeName, dash.activeName]; };
        assert.deepStrictEqual(await at('SPORT'), ['eva', 'a']);
        assert.deepStrictEqual(a.hud().targets(), ['hud']);
        assert.deepStrictEqual(a.dash().targets(), ['map']);
        assert.deepStrictEqual(await at('COMFORT'), ['hud_only_comfort', 'c1']);
        assert.deepStrictEqual(await at('ECO PRO'), ['off', 'e3']);
        assert.strictEqual(a.hud().layers.size, 0);
        assert.deepStrictEqual(a.dash().targets(), ['panel']);
        assert.deepStrictEqual(a.hud().refused.concat(a.dash().refused), []);
    },
    async 'changing one screen\'s picture leaves the other screen alone'() {
        const a = startApp({ screens: 'both', demo: 'off', _menuV: 2 });
        await wait(SETTLE_MS);
        drive(a, 'SPORT');
        await wait(250);
        const hudLayers = Array.from(a.hud().layers.keys()).join();
        a.set('bothDashSport', 'a');
        await wait(200);
        assert.strictEqual(counts.evas[1].activeName, 'a');
        assert.strictEqual(Array.from(a.hud().layers.keys()).join(), hudLayers, 'changing the dash redrew the HUD');
        const dashLayers = Array.from(a.dash().layers.keys()).join();
        a.set('bothHudSport', 'sport');
        await wait(200);
        assert.strictEqual(counts.evas[0].activeName, 'hud_only_sport');
        assert.strictEqual(Array.from(a.dash().layers.keys()).join(), dashLayers, 'changing the HUD redrew the dash');
    },
    async 'before the car names a drive mode, Comfort\'s picture shows'() {
        const a = startApp({ screens: 'both', demo: 'off', _menuV: 2, bothHudComfort: 'comfort', bothDashComfort: 'c2', bothHudSport: 'sport', bothDashSport: 'a' });
        await wait(SETTLE_MS);
        assert.strictEqual(counts.evas[0].activeName, 'hud_only_comfort');
        assert.strictEqual(counts.evas[1].activeName, 'c2');
    },
    async 'a picture for another mode or drive mode changes nothing on the screens'() {
        const a = startApp({ screens: 'hud', demo: 'off', _menuV: 2 });
        await wait(SETTLE_MS);
        drive(a, 'COMFORT');
        await wait(250);
        const layers = Array.from(a.hud().layers.keys()).join();
        ['bothHudComfort', 'hudSport', 'hudEco'].forEach((k) => a.set(k, 'sport'));
        a.set('dashComfort', 'a');
        a.set('bothDashComfort', 'b');
        await wait(200);
        assert.strictEqual(Array.from(a.hud().layers.keys()).join(), layers);
        assert.strictEqual(a.dash().layers.size, 0);
    },
    async 'the menu shows only the rows the Mode asks for, at the start and at each change'() {
        const a = startApp({ screens: 'dash', _menuV: 2, dashComfort: 'a' });
        await wait(SETTLE_MS);
        const hud = counts.evas[0], rows = () => hud._menuRows();
        ['SET_DASHCOMFORT', 'SET_DASHSPORT', 'SET_DASHECO'].forEach((k) => assert.strictEqual(rows()[k], true, k));
        ['SET_HUDCOMFORT', 'SET_HUDECO', 'SET_BOTHHUDSPORT', 'SET_BOTHDASHECO', 'SET_DASHCENTER'].forEach((k) => assert.strictEqual(rows()[k], false, k));
        assert.strictEqual(rows().SET_MOTTO, undefined, 'a row with no rule is left alone');
        const seen = {}, real = hud.ctx.ui.visible;
        hud.ctx.ui.visible = (name, on) => { seen[name] = on; return real.call(hud.ctx.ui, name, on); };
        a.set('dashEco', 'b');
        assert.deepStrictEqual(seen, { SET_DASHCENTER: true }, 'only the row that changed is sent');
        Object.keys(seen).forEach((k) => delete seen[k]);
        a.set('screens', 'both');
        assert.strictEqual(seen.SET_BOTHHUDECO, true);
        assert.strictEqual(seen.SET_BOTHDASHECO, true);
        assert.strictEqual(seen.SET_DASHECO, false);
        assert.strictEqual(seen.SET_DASHCENTER, false);
    },
    async 'settings from 0.5.0 carry over once: the Dash only design and the HUD + Dash pair fill every drive mode'() {
        const a = startApp({ screens: 'dash', dashDesign: 'b', hudDesign: 'comfort', bothHud: 'follow', bothDash: 'e2' });
        await wait(SETTLE_MS);
        const get = (k) => counts.evas[0].ctx.settings.get(k);
        ['Comfort', 'Sport', 'Eco'].forEach((m) => {
            assert.strictEqual(get('dash' + m), 'b', m);
            assert.strictEqual(get('hud' + m), 'comfort', m);
            assert.strictEqual(get('bothDash' + m), 'e2', m);
        });
        assert.deepStrictEqual(['Comfort', 'Sport', 'Eco'].map((m) => get('bothHud' + m)), ['comfort', 'sport', 'eco'], 'follow means each its own');
        assert.strictEqual(counts.evas[1].activeName, 'b');
        a.set('dashSport', 'a');
        const hud = counts.evas[0];
        hud._migrateMenu();
        assert.strictEqual(get('dashSport'), 'a', 'a later choice is not undone');
    },
    async 'By drive mode from 0.5.0 carries over as HUD + Dash with the same result in each drive mode'() {
        const a = startApp({ screens: 'drive', comfortScreens: 'hud', sportScreens: 'dash', sportDash: 'a', ecoScreens: 'both', ecoDash: 'e2' });
        await wait(SETTLE_MS);
        const hud = counts.evas[0], dash = counts.evas[1], get = (k) => hud.ctx.settings.get(k);
        assert.strictEqual(get('screens'), 'both');
        const at = async (mode) => { drive(a, mode); await wait(250); return [hud.activeName, dash.activeName]; };
        assert.deepStrictEqual(await at('COMFORT'), ['hud_only_comfort', 'off']);
        assert.deepStrictEqual(await at('SPORT'), ['off', 'a']);
        assert.deepStrictEqual(await at('ECO PRO'), ['eva', 'e2']);
    },
    async 'the demo goes through every alert on its screens, as a real alert looks, and starts over'() {
        const a = startApp({ screens: 'both', demo: 'on', _menuV: 2 });
        await wait(SETTLE_MS);
        const hud = counts.evas[0], dash = counts.evas[1], sim = hud.car.sim, at = async (ms) => { sim.t0 = Date.now() - ms; await wait(130); };
        assert.strictEqual(typeof sim.alertAt, 'function', 'not the EVA demo drive');
        await at(1000);
        assert.strictEqual(hud.alertKey, null, 'no alert while it drives');
        for (const [ms, id] of [[10100, 'knock'], [12100, 'fuel'], [14100, 'afr'], [16100, 'heat'], [18100, 'boost'], [20100, 'multi']]) {
            await at(ms);
            assert.strictEqual(hud.alertKey, id, ms + ' ms');
            assert.strictEqual(dash.alertKey, id, 'the dash at ' + ms + ' ms');
            assert.strictEqual(hud._token('a:tag'), 'MAGI SYSTEM WARNING', 'it should look real, not a preview');
            assert.ok(hud._token('a:value') !== '', id + ' has no value');
        }
        await at(100);
        assert.strictEqual(hud.alertKey, null, 'the round starts over');
        assert.deepStrictEqual(a.hud().refused.concat(a.dash().refused), []);
    },
    async 'the demo\'s alerts obey the alerts switch, and a preview comes first'() {
        const a = startApp({ screens: 'hud', demo: 'on', _menuV: 2, alertsOn: false });
        await wait(SETTLE_MS);
        const hud = counts.evas[0];
        hud.car.sim.t0 = Date.now() - 10100;
        await wait(130);
        assert.strictEqual(hud.alertKey, null, 'Full-screen alerts is off');
        a.set('alertsOn', true);
        await wait(130);
        assert.strictEqual(hud.alertKey, 'knock');
        a.set('alertPreview', 'boost');
        await wait(130);
        assert.strictEqual(hud.alertKey, 'boost');
        assert.strictEqual(hud._token('a:tag'), 'PREVIEW');
    },
    async 'with the demo off a real car shows no demo alert'() {
        const a = startApp({ screens: 'hud', demo: 'off', _menuV: 2 });
        await wait(SETTLE_MS);
        const hud = counts.evas[0];
        hud.car.sim.t0 = Date.now() - 10100;
        await wait(130);
        assert.strictEqual(hud.alertKey, null);
    },
    async 'a dash that cannot start leaves the HUD running and says so'() {
        const a = startApp({ screens: 'both' }, { dashThrows: true });
        await wait(700);
        assert.strictEqual(FakeClient.all.length, 1);
        assert.ok(a.hud().layers.size > 0);
        assert.ok(/HUD/.test(a.status()), a.status());
        assert.ok(a.lines.some((l) => /dash/i.test(l)), 'nothing logged');
    },
};

(async () => {
    execSync('python3 kit/tools/build.py eva_hud', { cwd: ROOT, stdio: 'ignore' });
    let failed = 0;
    for (const name of Object.keys(tests)) {
        try { await tests[name](); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
    }
    console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
    process.exit(failed ? 1 : 0);
})();
