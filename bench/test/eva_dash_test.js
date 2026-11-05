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
    return { hu, lines, watches, status: () => status, hud: () => FakeClient.all[0], dash: () => FakeClient.all[1], set: (k, v) => hu.settings.set(k, v) };
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
async function everyday(mode) {
    const a = startApp({ screens: 'hud', demo: 'off' });
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
        const a = startApp({ screens: 'hud' });
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
        const a = startApp({ screens: 'both' });
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
    async 'in HUD only, each drive mode has its own layout, and Sport stands in until the car says'() {
        const a = startApp({ screens: 'hud' });
        await wait(150);
        const hud = counts.evas[0];
        assert.strictEqual(hud.activeName, 'hud_only_sport');
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
    async 'Comfort and Eco Pro stay still at the shift point: three layers, nothing that flashes'() {
        for (const mode of ['COMFORT', 'ECO_PRO']) {
            const a = startApp({ screens: 'hud' });
            await wait(150);
            drive(a, mode);
            await wait(200);
            const hud = counts.evas[0];
            hud._shift = () => ({ now: true, rpm: 1000, oilCold: false, cold: false });
            await wait(400);
            assert.strictEqual(a.hud().layers.size, 3, mode);
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
    async 'a tyre well under its target turns amber'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        a.hu.feed(TPMS, 'statusTargetTyrePressure', { targetPressureTyreFLH: 26, targetPressureTyreFRH: 26, targetPressureTyreRLH: 65532, targetPressureTyreRRH: 28 });
        a.hu.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 23, actualValuePressureTyreFRH: 24, actualValuePressureTyreRLH: 21, actualValuePressureTyreRRH: 65532 });
        await wait(50);
        assert.strictEqual(hud._warn('tyreLow:FL'), true, '0.3 bar under its target is low');
        assert.strictEqual(hud._warn('tyreLow:FR'), false, '0.2 bar under is not');
        assert.strictEqual(hud._warn('tyreLow:RL'), false, 'no target: 2.0 bar is the line, and 2.1 is above it');
        assert.strictEqual(hud._warn('tyreLow:RR'), false, 'no reading is not low');
        a.hu.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreRLH: 19 });
        await wait(50);
        assert.strictEqual(hud._warn('tyreLow:RL'), true, 'no target, under 2.0 bar');
    },
    async 'an old target is no target'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        a.hu.feed(TPMS, 'statusTargetTyrePressure', { targetPressureTyreFLH: 30 });
        a.hu.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 25 });
        await wait(50);
        assert.strictEqual(hud._warn('tyreLow:FL'), true);
        hud.tyres.FL.targetAt -= 120000;
        assert.strictEqual(hud._warn('tyreLow:FL'), false, '2.5 bar is fine with no target to compare');
    },
    async 'a low tyre\'s name, pressure and temperature go up in amber, each write inside its own part'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(150);
        drive(a, 'COMFORT');
        await wait(SETTLE_MS);
        a.hu.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 15 });
        a.hu.feed(TPMS, 'statusTyreTemperature', { actualValueTemperatureTyreFLH: 65 });
        await wait(400);
        const x = counts.evas[0].widgets.get('text'), W = x.w.w, image = imageOf(a.hud(), x.ref);
        for (const id of ['tn_fl', 'tp_fl', 'tt_fl']) {
            const p = x.w.parts.find((q) => q.id === id);
            let amber = 0;
            for (let j = p.y; j < p.y + p.h; j++) {
                for (let i = p.x; i < p.x + p.w; i++) {
                    const o = (j * W + i) * 4;
                    if (image[o + 3] > 200 && image[o] === 255 && image[o + 1] === 176 && image[o + 2] === 0) amber++;
                }
            }
            assert.ok(amber > 0, id + ' is not amber');
        }
        a.hud().sent.filter((s) => s.ref === x.ref && s.rects).forEach((s) => {
            const r = s.rects[0];
            assert.ok(x.w.parts.some((p) => r.x >= p.x && r.y >= p.y && r.x + r.w <= p.x + p.w && r.y + r.h <= p.y + p.h), JSON.stringify(r) + ' crosses a part');
        });
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
    async 'a parked car that says nothing new keeps its range and tyres: they are read, not notified'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        a.hu.feed('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', { range: 300 });
        a.hu.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 23 });
        await wait(50);
        hud.car.lastCar = Date.now() - 600000;      // the engine signals have been quiet for ten minutes
        assert.strictEqual(hud._token('range'), '300');
        assert.strictEqual(hud._token('tyreP:FL'), '33');
    },
    async 'range and tyres go to dashes only when the reads have stopped'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        a.hu.feed('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', { range: 300 });
        a.hu.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 23 });
        await wait(50);
        hud.rangeAt -= 120000;
        hud.tyres.FL.pAt -= 120000;
        assert.strictEqual(hud._token('range'), '--');
        assert.strictEqual(hud._token('tyreP:FL'), '--');
    },
    async 'range and tyres are read every 10 s, without being asked for by a screen'() {
        const a = startApp({ screens: 'off', demo: 'off' });
        await wait(100);
        const polled = a.watches.filter((w) => w.opts && w.opts.pollMs === 10000);
        const has = (iface, field) => polled.some((w) => w.iface === iface && w.fields.indexOf(field) >= 0);
        assert.ok(has(TPMS, 'statusTyrePressure'), 'pressure');
        assert.ok(has(TPMS, 'statusTyreTemperature'), 'temperature');
        assert.ok(has(TPMS, 'statusTargetTyrePressure'), 'target pressure');
        assert.ok(has('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus'), 'range');
    },
    async 'tyre pressure is in PSI, from 0.1 bar steps, and nonsense is dashes'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        assert.strictEqual(hud._token('tyreP:RR'), '--');
        a.hu.feed(TPMS, 'statusTyrePressure', { actualValuePressureTyreFLH: 23, actualValuePressureTyreFRH: 24, actualValuePressureTyreRLH: 65532, actualValuePressureTyreRRH: 65535 });
        await wait(50);
        assert.strictEqual(hud._token('tyreP:FL'), '33');
        assert.strictEqual(hud._token('tyreP:FR'), '35');
        assert.strictEqual(hud._token('tyreP:RL'), '--', '65532 and up means no value');
        assert.strictEqual(hud._token('tyreP:RR'), '--');
    },
    async 'tyre temperature is in °C, 40 below the raw number, and nonsense is dashes'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        assert.strictEqual(hud._token('tyreT:FL'), '--');
        a.hu.feed(TPMS, 'statusTyreTemperature', { actualValueTemperatureTyreFLH: 65, actualValueTemperatureTyreFRH: 0, actualValueTemperatureTyreRLH: 65535, actualValueTemperatureTyreRRH: 200 });
        await wait(50);
        assert.strictEqual(hud._token('tyreT:FL'), '25°');
        assert.strictEqual(hud._token('tyreT:FR'), '-40°');
        assert.strictEqual(hud._token('tyreT:RL'), '--', '65535 means no value');
        assert.strictEqual(hud._token('tyreT:RR'), '--', '160 °C is not a tyre');
    },
    async 'wire numbers that arrive as names or nothing do not break the tyres'() {
        const a = startApp({ screens: 'hud', demo: 'off' });
        await wait(100);
        const hud = counts.evas[0];
        a.hu.feed(TPMS, 'statusTyrePressure', null);
        a.hu.feed(TPMS, 'statusTyreTemperature', {});
        await wait(50);
        assert.strictEqual(hud._token('tyreP:FL'), '--');
        assert.strictEqual(hud._token('tyreT:FL'), '--');
        assert.ok(!a.lines.some((l) => /^ERROR/.test(l)), a.lines.join(' | ').slice(0, 200));
    },
    async 'the demo shows made-up tyres only under the demo setting'() {
        const a = startApp({ screens: 'hud', demo: 'on' });
        await wait(100);
        const hud = counts.evas[0];
        assert.ok(/^\d\d$/.test(hud._token('tyreP:FL')), hud._token('tyreP:FL'));
        assert.ok(/^\d\d°$/.test(hud._token('tyreT:RR')), hud._token('tyreT:RR'));
    },
    async 'the clock is 24-hour'() {
        const a = startApp({ screens: 'hud' });
        await wait(100);
        const hud = counts.evas[0];
        hud._now = () => ({ getHours: () => 15, getMinutes: () => 7 });
        assert.strictEqual(hud._token('time'), '15:07');
        hud._now = () => ({ getHours: () => 3, getMinutes: () => 14 });
        assert.strictEqual(hud._token('time'), '03:14');
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
        const a = startApp({ screens: 'hud' });
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
        const a = startApp({ screens: 'hud' });
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
        const a = startApp({ screens: 'hud' }, { layouts: { hud_only_sport: layout } });
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
