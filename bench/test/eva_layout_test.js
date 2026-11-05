'use strict';
/**
 * What the generated EVA layouts must hold on the car, checked from the files themselves
 * (tools/eva_layout.py writes them). The renderer allows a client 8 layers, and refuses the rest with
 * "too many layers": a limit the car found and the bench did not.
 *   node bench/test/eva_layout_test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const HUD = path.join(__dirname, '../../apps/eva_hud/hud');
const load = (rel) => JSON.parse(fs.readFileSync(path.join(HUD, rel), 'utf8'));
const eva = load('layouts/eva.json');
const alert = load('layouts/alert.json');
const canvasOf = (layout) => layout.widgets.find((w) => w.type === 'evacanvas');
const font = (name) => load('fonts/' + name + '.json');
const width = (s, f) => Array.from(s).reduce((n, c) => n + (f.glyphs[c] ? f.glyphs[c].advance : 0), 0);
const fits = (p, x, y) => p.x >= 0 && p.y >= 0 && p.x + p.w <= x && p.y + p.h <= y;
const clash = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// the dash, on the 1920x720 cluster. Loaded when a test asks, so a missing file fails that test alone.
const solo = () => load('layouts/hud_only_sport.json');
// BMW's own speed, its red line and the limit sign, which nothing can remove: read off the owner's photos of the HUD
const BMW = { x: 132, y: 316, w: 216, h: 66 };
const HUD_SEEN = { x: 124, y: 100, w: 552, h: 280 };
const inside = (r, a) => r.x >= a.x && r.y >= a.y && r.x + r.w <= a.x + a.w && r.y + r.h <= a.y + a.h;
// a layer's place on the glass: sx and sy scale it about its centre
const onGlass = (w) => {
    const sx = w.sx || 1, sy = w.sy || 1, cx = w.x + w.w / 2, cy = w.y + w.h / 2;
    return Object.assign({}, w, { x: cx - w.w * sx / 2, y: cy - w.h * sy / 2, w: w.w * sx, h: w.h * sy });
};
const hudThings = (l) => {
    const out = l.widgets.filter((w) => w.type !== 'evacanvas').map(onGlass);
    const c = canvasOf(l);
    return out.concat(c.parts.map((p) => Object.assign(onScreen(c, p), { id: p.id, part: p })));
};
const comfort = () => load('layouts/hud_only_comfort.json');
const eco = () => load('layouts/hud_only_eco.json');
const CALM = () => [comfort(), eco()];
const WORDS = ['出撃待命', '緊急撤退', '同期解除'];
const SUBS = ['SORTIE STANDBY // 拘束具固定', 'RETREAT // 総員退避', 'SYNCHRO CUT // 駆動系切離'];
const MIB = (n) => n * 1024 * 1024;
const dash = () => load('layouts/dash_eva.json');
const dashAlert = () => load('layouts/dash_alert.json');
const STATUS_ROW_Y = 640;      // BMW's own bottom row (range, time, temperature) stays open under the dash
// what the hood leaves visible, read off the owner's photo of the calibration grid (labels every 100 px)
const leftEdge = (y) => (y < 100 ? 480 - 3.6 * y : y < 200 ? 120 - 1.1 * (y - 100) : 10);
const rightEdge = (y) => (y < 100 ? 1420 + 3.45 * y : y < 200 ? 1765 + 1.25 * (y - 100) : 1890);
const visible = (r) => r.x >= leftEdge(r.y) && r.x + r.w <= rightEdge(r.y);
const onScreen = (c, p) => ({ x: c.x + p.x, y: c.y + p.y, w: p.w, h: p.h });
// the service counts every image twice (Compositor::add_image)
const imageBytes = (w) => (w.type === 'evagear' || w.type === 'evacanvas' || w.type === 'evaword' ? w.w * w.h * 4 * 2 : 0);
const normalBytes = (l) => l.widgets.reduce((n, w) => n + imageBytes(w), 0);
const alertBytes = (al) => normalBytes(al) + 2 * al.title.w * al.title.h * 4 * 2;

function overlaps(parts) {
    const out = [];
    parts.forEach((a, i) => parts.slice(i + 1).forEach((b) => { if (clash(a, b)) out.push(a.id + '/' + b.id); }));
    return out;
}

const tests = {
    'the normal layout and an alert together stay within the 8 layers a client may have'() {
        const alertLayers = alert.widgets.length + 2;     // the title: a colour layer and a white one
        assert.ok(eva.widgets.length + alertLayers <= 8, eva.widgets.length + ' + ' + alertLayers);
    },
    'parts of the normal canvas never overlap: each is sent as its own rectangle'() {
        assert.deepStrictEqual(overlaps(canvasOf(eva).parts), []);
    },
    'parts of the alert canvas never overlap'() {
        assert.deepStrictEqual(overlaps(canvasOf(alert).parts), []);
    },
    'every part lies inside its canvas'() {
        [eva, alert].forEach((l) => {
            const c = canvasOf(l);
            c.parts.forEach((p) => assert.ok(fits(p, c.w, c.h), p.id + ' is off the canvas'));
        });
    },
    'every layer lies on the 800x480 HUD'() {
        [eva, alert].forEach((l) => l.widgets.forEach((w) => assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= 800 && w.y + w.h <= 480, w.id)));
        assert.ok(alert.title.x >= 0 && alert.title.y >= 0 && alert.title.x + alert.title.w <= 800 && alert.title.y + alert.title.h <= 480);
    },
    'every alert has its title rows, inside the title layer'() {
        ['knock', 'heat', 'boost', 'fuel', 'afr', 'multi'].forEach((id) => {
            assert.ok(alert.rows[id] && alert.rows[id].length === 2, id);
            alert.rows[id].forEach((r) => {
                const f = font(r.font);
                assert.ok(r.y >= 0 && r.y + f.cellHeight <= alert.title.h, id + ' row runs off the title layer');
                assert.ok(width(r.text, f) <= alert.title.w, id + ' row is too wide');
            });
        });
    },
    'the menu chooses the app\'s mode once, and nothing there follows the drive mode'() {
        const spec = JSON.parse(fs.readFileSync(path.join(HUD, '..', 'app.json'), 'utf8'));
        const screens = spec.settings.find((x) => x.key === 'screens');
        assert.deepStrictEqual(screens.options.map((o) => o[0]), ['off', 'hud', 'dash', 'both', 'grid']);
        assert.strictEqual(screens.default, 'hud');
        ['byMode', 'inComfort', 'inSport', 'inEco', 'dashLayout', 'hudLayout'].forEach((k) => assert.ok(!spec.settings.some((x) => x.key === k), k + ' is still in the menu'));
    },
    'the menu has no units setting, and shows pressure limits in PSI'() {
        const spec = JSON.parse(fs.readFileSync(path.join(HUD, '..', 'app.json'), 'utf8'));
        assert.ok(!spec.settings.some((x) => x.key === 'units'), 'units is still in the menu');
        ['limitBoost', 'limitFuel'].forEach((k) => {
            const o = spec.settings.find((x) => x.key === k).options.filter((v) => v[0] !== 'off');
            o.forEach((v) => assert.ok(/ PSI$/.test(v[1]), k + ' ' + v[1]));
            o.forEach((v) => {
                const psi = Number(v[0]) * 14.5038;
                assert.ok(Math.abs(Number(v[1].replace(' PSI', '')) - psi) <= 0.51, k + ': ' + v[0] + ' bar is ' + psi.toFixed(1) + ' PSI, not ' + v[1]);
            });
        });
    },
    'the longest values in PSI and HP fit their boxes, on both screens'() {
        const fit = (l, id, s) => {
            const p = canvasOf(l).parts.find((x) => x.id === id);
            assert.ok(width(s, font(p.font)) <= p.w - 2, l.name + ' ' + id + ': ' + s + ' is ' + width(s, font(p.font)) + ' of ' + p.w);
        };
        [eva, solo(), dash()].forEach((l) => { fit(l, 'boost', '-14.5'); fit(l, 'power_v', '999'); fit(l, 'torque_v', '999'); });
        [alert, dashAlert()].forEach((l) => { fit(l, 'val', '4351'); fit(l, 'val', '43.5'); fit(l, 'uni', 'PSI'); });
    },
    'the fixed texts have all their glyphs in their fonts'() {
        [eva, alert].forEach((l) => canvasOf(l).parts.filter((p) => p.type === 'text' && p.text.indexOf('{{') < 0).forEach((p) => {
            const f = font(p.font);
            Array.from(p.text).forEach((c) => assert.ok(f.glyphs[c], p.id + ' has no glyph for ' + c));
        }));
    },
    'the fixed texts fit their boxes'() {
        [eva, alert].forEach((l) => canvasOf(l).parts.filter((p) => p.type === 'text' && p.text.indexOf('{{') < 0).forEach((p) => {
            assert.ok(width(p.text, font(p.font)) <= p.w, p.id + ' does not fit');
        }));
    },
    'the HUD on its own, with its instruments and an alert, stays within the 8 layers'() {
        assert.ok(solo().widgets.length + alert.widgets.length + 2 <= 8, solo().widgets.length + ' + ' + (alert.widgets.length + 2));
    },
    'nothing of the HUD sits on BMW\'s speed or limit sign'() {
        [eva, solo(), alert].forEach((l) => hudThings(l).forEach((t) => assert.ok(!clash(t, BMW), l.name + ': ' + t.id + ' is on BMW\'s speed')));
        assert.ok(!clash(alert.title, BMW), 'the alert title is on BMW\'s speed');
    },
    'the HUD draws no speed of its own: BMW\'s is the one on the glass'() {
        [eva, solo()].forEach((l) => canvasOf(l).parts.forEach((p) => assert.ok(!/\{\{speed\}\}/.test(p.text || ''), p.id)));
    },
    'a label names BMW\'s speed, just above it'() {
        const c = canvasOf(eva), p = c.parts.find((x) => x.id === 'spd_l');
        assert.ok(p, 'no label');
        const r = onScreen(c, p);
        assert.ok(r.y + r.h <= BMW.y && BMW.y - (r.y + r.h) < 8 && r.x >= BMW.x, 'at ' + r.x + ',' + r.y);
    },
    'everything of the HUD lies in the part of the glass the owner can see'() {
        [eva, solo(), alert].forEach((l) => hudThings(l).forEach((t) => assert.ok(inside(t, HUD_SEEN), l.name + ': ' + t.id + ' at ' + [t.x, t.y, t.w, t.h])));
    },
    'the solo layout has what the other has not, and neither loses a number'() {
        assert.strictEqual(eva.widgets.filter((w) => w.type === 'evasolo').length, 0);
        const inst = solo().widgets.filter((w) => w.type === 'evasolo');
        assert.strictEqual(inst.length, 1);
        assert.ok(inst[0].bar && !inst[0].ring, 'a throttle bar, and no G ring');
        [eva, solo()].forEach((l) => {
            const ids = canvasOf(l).parts.map((p) => p.id);
            ['boost', 'oil_v', 'water_v', 'torque_v', 'power_v', 'status'].forEach((id) => assert.ok(ids.indexOf(id) >= 0, l.name + ' has no ' + id));
        });
    },
    'there is no track title: the owner never saw one, and its font was the largest file'() {
        [eva, solo(), alert, dash(), dashAlert()].forEach((l) => canvasOf(l).parts.forEach((p) => assert.ok(!/\{\{song\}\}/.test(p.text || ''), l.name + ': ' + p.id)));
        assert.ok(!fs.existsSync(path.join(HUD, 'fonts/song.json')), 'the font is still there');
    },
    'the gear\'s frame runs to the bottom of what the owner can see'() {
        const f = eva.widgets.find((w) => w.type === 'evaframe');
        assert.ok(f.y + f.h >= HUD_SEEN.y + HUD_SEEN.h - 4, 'ends at ' + (f.y + f.h));
    },
    'the HUD-only layout is named as the owner named it for now'() {
        assert.strictEqual(solo().name, 'HUD Only - SPORT');
    },
    'the solo layout\'s parts never overlap, lie inside their canvas and have their glyphs'() {
        const l = solo(), c = canvasOf(l);
        assert.deepStrictEqual(overlaps(c.parts), []);
        c.parts.forEach((p) => assert.ok(fits(p, c.w, c.h), p.id + ' is off the canvas'));
        c.parts.filter((p) => p.type === 'text' && p.text.indexOf('{{') < 0).forEach((p) => {
            const f = font(p.font);
            Array.from(p.text).forEach((ch) => assert.ok(f.glyphs[ch], p.id + ' has no glyph for ' + ch));
            assert.ok(width(p.text, f) <= p.w, p.id + ' does not fit');
        });
    },
    'the throttle bar lies inside its own layer'() {
        const w = solo().widgets.find((x) => x.type === 'evasolo');
        const [bx, by, bw, bh] = w.bar;
        assert.ok(bx >= 0 && by >= 0 && bx + bw <= w.w && by + bh <= w.h, 'the bar');
    },
    'the HUD alone shows the NERV mark, and nothing is left of the G ring'() {
        const c = canvasOf(solo()), p = c.parts.find((x) => x.id === 'logo');
        assert.ok(p, 'no mark');
        assert.strictEqual(p.type, 'logo');
        assert.strictEqual(p.color, 'hot');
        assert.ok(!c.parts.some((x) => x.id === 'g_l'), 'the G label is still there');
    },
    'the mark flickers now and then, red to amber, under the 3 flashes a second the design allows'() {
        const p = canvasOf(solo()).parts.find((x) => x.id === 'logo');
        assert.ok(p.flicker, 'no flicker');
        assert.strictEqual(p.flicker.color, 'amber');
        assert.ok(1000 / (2 * p.flicker.phaseMs) < 3, p.flicker.phaseMs + ' ms');
        assert.ok(p.flicker.flashes >= 2 && p.flicker.flashes <= 5);
        assert.ok(p.flicker.gapMs[0] >= 10000 && p.flicker.gapMs[1] > p.flicker.gapMs[0], 'now and then, not all the time');
    },
    'the mark\'s file matches its place and keeps its proportions'() {
        const p = canvasOf(solo()).parts.find((x) => x.id === 'logo');
        const m = load(p.src);
        assert.strictEqual(m.w, p.w);
        assert.strictEqual(m.h, p.h);
        assert.strictEqual(Buffer.from(m.alpha, 'base64').length, m.w * m.h);
        assert.ok(Math.abs(m.w / m.h - 1270 / 1214) < 0.02, m.w + 'x' + m.h);
    },
    'the mark is drawn: about half of it is lit, as in the source'() {
        const p = canvasOf(solo()).parts.find((x) => x.id === 'logo');
        const a = Buffer.from(load(p.src).alpha, 'base64');
        let lit = 0;
        for (let i = 0; i < a.length; i++) if (a[i] > 128) lit++;
        assert.ok(lit / a.length > 0.3 && lit / a.length < 0.6, (lit / a.length).toFixed(2));
    },
    'the HUD + Dash layout has no mark: its right column holds the temperatures'() {
        assert.ok(!canvasOf(eva).parts.some((x) => x.id === 'logo'));
    },
    'the dash and an alert together stay within the 8 layers a client may have'() {
        assert.ok(dash().widgets.length + dashAlert().widgets.length + 2 <= 8, dash().widgets.length + ' + ' + (dashAlert().widgets.length + 2));
    },
    'parts of the dash canvases never overlap and lie inside them'() {
        [dash(), dashAlert()].forEach((l) => {
            const c = canvasOf(l);
            assert.deepStrictEqual(overlaps(c.parts), []);
            c.parts.forEach((p) => assert.ok(fits(p, c.w, c.h), p.id + ' is off the canvas'));
        });
    },
    'every dash layer lies on the 1920x720 cluster'() {
        [dash(), dashAlert()].forEach((l) => l.widgets.forEach((w) => assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= 1920 && w.y + w.h <= 720, w.id)));
    },
    'nothing of the dash reaches BMW\'s bottom status row'() {
        [dash(), dashAlert()].forEach((l) => l.widgets.forEach((w) => assert.ok(w.y + w.h <= STATUS_ROW_Y, w.id + ' ends at ' + (w.y + w.h))));
        const t = dashAlert().title;
        assert.ok(t.y + t.h <= STATUS_ROW_Y, 'the title ends at ' + (t.y + t.h));
    },
    'the black background covers the gauges down to the status row and stays through an alert'() {
        const bg = dash().widgets.find((w) => w.type === 'fill');
        assert.ok(bg, 'no background');
        assert.deepStrictEqual([bg.x, bg.y, bg.w, bg.h], [0, 0, 1920, STATUS_ROW_Y]);
        assert.strictEqual(bg.keepInAlert, true);
        assert.strictEqual(bg.color, 'black');
    },
    'the dash\'s readouts lie where the cluster\'s hood does not hide them'() {
        const d = dash(), c = canvasOf(d);
        d.widgets.filter((w) => w.type === 'evaseg' || w.type === 'evaframe').forEach((w) => assert.ok(visible(w), w.id + ' is under the hood'));
        c.parts.forEach((p) => assert.ok(visible(onScreen(c, p)), p.id + ' is under the hood'));
        const a = canvasOf(dashAlert());
        a.parts.forEach((p) => assert.ok(visible(onScreen(a, p)), 'alert ' + p.id + ' is under the hood'));
    },
    'the dash has the numbers the HUD has, and a bigger gear'() {
        const ids = canvasOf(dash()).parts.map((p) => p.id);
        ['speed', 'boost', 'oil_v', 'water_v', 'torque_v', 'power_v', 'status'].forEach((id) => assert.ok(ids.indexOf(id) >= 0, id));
        assert.ok(font('d_gear').cellHeight > 2 * font('gear').cellHeight, 'the gear should be giant');
    },
    'every dash alert has its title rows, inside the title layer'() {
        const a = dashAlert();
        ['knock', 'heat', 'boost', 'fuel', 'afr', 'multi'].forEach((id) => {
            assert.ok(a.rows[id] && a.rows[id].length === 2, id);
            a.rows[id].forEach((r) => {
                const f = font(r.font);
                assert.ok(r.y >= 0 && r.y + f.cellHeight <= a.title.h, id + ' row runs off the title layer');
                assert.ok(width(r.text, f) <= a.title.w, id + ' row is too wide');
            });
        });
    },
    'the dash\'s fixed texts have their glyphs and fit their boxes'() {
        [dash(), dashAlert()].forEach((l) => canvasOf(l).parts.filter((p) => p.type === 'text' && p.text.indexOf('{{') < 0).forEach((p) => {
            const f = font(p.font);
            Array.from(p.text).forEach((c) => assert.ok(f.glyphs[c], p.id + ' has no glyph for ' + c));
            assert.ok(width(p.text, f) <= p.w, p.id + ' does not fit');
        }));
    },
    'the gear layer names the dash\'s own fonts'() {
        const g = dash().widgets.find((w) => w.type === 'evagear');
        assert.strictEqual(g.fontPrefix, 'd_');
        ['d_gear', 'd_gearjp', 'd_gearrev'].forEach((n) => assert.ok(font(n).glyphs));
    },
    'Comfort and Eco Pro are named, and have their own colours'() {
        assert.strictEqual(comfort().name, 'HUD Only - COMFORT');
        assert.strictEqual(eco().name, 'HUD Only - ECO PRO');
        assert.strictEqual(comfort().theme, 'eva_calm');
        assert.strictEqual(eco().theme, 'eva_eco');
        const { THEMES } = require('../../shared/hud_themes');
        assert.deepStrictEqual(THEMES.eva_calm.fg, [255, 176, 122, 255], 'Comfort is dusk');
        assert.deepStrictEqual(THEMES.eva_eco.fg, [120, 205, 255, 255], 'Eco Pro is night');
        [THEMES.eva_calm, THEMES.eva_eco].forEach((t) => assert.deepStrictEqual(t.amber, [255, 176, 0, 255], 'the warning colour'));
    },
    'nothing of Comfort or Eco Pro sits on BMW\'s speed, and all of it can be seen'() {
        CALM().forEach((l) => hudThings(l).forEach((t) => {
            if (t.type !== 'evacorners') assert.ok(!clash(t, BMW), l.name + ': ' + t.id + ' is on BMW\'s speed');
            assert.ok(inside(t, HUD_SEEN), l.name + ': ' + t.id + ' at ' + [t.x, t.y, t.w, t.h]);
        }));
    },
    'the four corners frame the glass, and the lower left one stops above BMW\'s speed'() {
        CALM().forEach((l) => {
            const c = l.widgets.find((w) => w.type === 'evacorners');
            assert.ok(c, l.name + ' has no corners');
            assert.deepStrictEqual([c.x, c.y, c.w, c.h], [124, 102, 552, 276], l.name);
            assert.ok(c.y + c.lowerLeft <= BMW.y, 'the lower left corner ends at ' + (c.y + c.lowerLeft));
            assert.ok(c.y + c.lowerLeft >= BMW.y - 16, 'and sits just above it, not far away: ' + (c.y + c.lowerLeft));
            assert.strictEqual(c.arm, 24);
            assert.strictEqual(c.open, 5);
        });
    },
    'Comfort and Eco Pro are three layers, and with an alert stay well within the 8'() {
        CALM().forEach((l) => {
            assert.deepStrictEqual(l.widgets.map((w) => w.type), ['evacorners', 'evaword', 'evacanvas'], l.name);
            assert.ok(l.widgets.length + alert.widgets.length + 2 <= 7, l.name + ': ' + l.widgets.length);
        });
    },
    'their parts never overlap, lie inside their canvas, have their glyphs and fit'() {
        CALM().forEach((l) => {
            const c = canvasOf(l);
            assert.deepStrictEqual(overlaps(c.parts), []);
            c.parts.forEach((p) => assert.ok(fits(p, c.w, c.h), l.name + ' ' + p.id + ' is off the canvas'));
            c.parts.filter((p) => p.type === 'text' && p.text.indexOf('{{') < 0).forEach((p) => {
                const f = font(p.font);
                Array.from(p.text).forEach((ch) => assert.ok(f.glyphs[ch], l.name + ' ' + p.id + ' has no glyph for ' + ch));
                assert.ok(width(p.text, f) <= p.w, l.name + ' ' + p.id + ' does not fit');
            });
        });
    },
    'nothing of the battle is left in them: no frame, gear, revs or pedal bar, no sync, no speed of their own'() {
        CALM().forEach((l) => {
            ['evaframe', 'evagear', 'evaseg', 'evasolo'].forEach((t) => assert.ok(!l.widgets.some((w) => w.type === t), l.name + ' has a ' + t));
            canvasOf(l).parts.forEach((p) => assert.ok(!/\{\{(speed|sync|statusline|gearcap|gearcapjp|boost|torque|power|pedal|oil|coolant)\}\}|UNIT-01|SYNC/.test(p.text || ''), l.name + ' ' + p.id + ': ' + p.text));
        });
    },
    'nothing is left of the old everyday layouts'() {
        ['fonts/c_gear.json', 'fonts/clock.json', 'logos/car_top.json'].forEach((f) => assert.ok(!fs.existsSync(path.join(HUD, f)), f + ' is still there'));
    },
    'Comfort: the place, a giant time in the title type, and the range under it'() {
        const c = canvasOf(comfort()), part = (id) => c.parts.find((p) => p.id === id);
        assert.strictEqual(part('place').text, '第3新東京市');
        assert.strictEqual(part('time').text, '{{time}}');
        assert.strictEqual(part('range').text, '{{range}} KM');
        assert.strictEqual(font(part('time').font).source, 'MatissePro-EB.otf');
        assert.ok(font(part('time').font).size >= 66, 'giant');
        assert.ok(part('place').y < part('time').y && part('time').y < part('range').y, 'top to bottom');
        c.parts.filter((p) => p.type === 'text' && p.id !== 'time').forEach((p) => assert.ok(font(p.font).size < font(part('time').font).size, p.id + ' outshouts the time'));
    },
    'Comfort shows each tyre\'s name, pressure and temperature, each on its wheel\'s side, below the big word'() {
        const c = canvasOf(comfort()), part = (id) => c.parts.find((p) => p.id === id);
        const names = { fl: '左前', fr: '右前', rl: '左後', rr: '右後' };
        Object.keys(names).forEach((w) => {
            const k = w.toUpperCase();
            assert.strictEqual(part('tn_' + w).text, names[w]);
            assert.strictEqual(part('tp_' + w).text, '{{tyreP:' + k + '}}');
            assert.strictEqual(part('tt_' + w).text, '{{tyreT:' + k + '}}');
            ['tn_', 'tp_', 'tt_'].forEach((pre) => assert.strictEqual(part(pre + w).warnWhen, 'tyreLow:' + k, pre + w));
            assert.ok(part('tn_' + w).x < part('tp_' + w).x && part('tp_' + w).x < part('tt_' + w).x, 'name, pressure, temperature');
        });
        assert.ok(part('tn_fl').x < part('tn_fr').x && part('tn_rl').x < part('tn_rr').x, 'left wheels on the left');
        assert.ok(part('tn_fl').y < part('tn_rl').y && part('tn_fr').y < part('tn_rr').y, 'front wheels on top');
        assert.strictEqual(part('tn_fl').y, part('tn_fr').y);
        assert.strictEqual(part('tn_rl').y, part('tn_rr').y);
        assert.strictEqual(part('tn_fl').x, part('tn_rl').x);
        assert.ok(!c.parts.some((p) => p.id === 'car'), 'the little car is back');
    },
    'the tyres\' longest values fit, and every glyph is there'() {
        const c = canvasOf(comfort());
        ['fl', 'fr', 'rl', 'rr'].forEach((w) => {
            const p = c.parts.find((x) => x.id === 'tp_' + w), t = c.parts.find((x) => x.id === 'tt_' + w);
            Array.from('--0123456789').forEach((ch) => assert.ok(font(p.font).glyphs[ch], 'pressure glyph ' + ch));
            Array.from('--0123456789°').forEach((ch) => assert.ok(font(t.font).glyphs[ch], 'temperature glyph ' + ch));
            assert.ok(width('99', font(p.font)) <= p.w && width('--', font(p.font)) <= p.w, w + ' pressure');
            assert.ok(width('-40°', font(t.font)) <= t.w, w + ' temperature');
        });
    },
    'Eco Pro: the range first, the time under it, and the fuel use at the lower right, with no tyres'() {
        const c = canvasOf(eco()), part = (id) => c.parts.find((p) => p.id === id);
        assert.strictEqual(part('save').text, '節電');
        assert.strictEqual(part('limit').text, '活動限界');
        assert.strictEqual(part('range').text, '{{range}}');
        assert.strictEqual(part('range_u').text, 'KM');
        assert.strictEqual(part('time').text, '{{time}}');
        assert.strictEqual(part('burn_l').text, '燃料消費');
        assert.strictEqual(part('burn').text, '{{burn}}');
        assert.strictEqual(part('burn_u').text, 'L/100KM');
        assert.ok(part('range').y < part('time').y, 'the range on top');
        assert.ok(c.x + part('burn').x >= BMW.x + BMW.w, 'beside BMW\'s speed');
        assert.ok(c.y + part('burn').y >= c.y + part('time').y, 'low down');
        c.parts.filter((p) => p.type === 'text' && p.id !== 'range').forEach((p) => assert.ok(font(p.font).size < font(part('range').font).size, p.id + ' outshouts the range'));
        assert.ok(!c.parts.some((p) => /tyre/.test(p.text || '')), 'tyres');
    },
    'the big word of every gear fits its layer, right-aligned on the same line in both layouts'() {
        CALM().forEach((l) => {
            const w = l.widgets.find((x) => x.type === 'evaword'), f = font(w.font);
            assert.strictEqual(f.source, 'MatissePro-EB.otf');
            WORDS.forEach((s) => {
                Array.from(s).forEach((ch) => assert.ok(f.glyphs[ch], 'no glyph for ' + ch));
                assert.ok(width(s, f) + 2 * w.pad <= w.w, s + ' is too wide');
            });
            assert.strictEqual(w.sx, 0.86, 'narrow');
            assert.strictEqual(w.sy, 1.5, 'tall');
            assert.strictEqual(w.h, f.cellHeight + 2 * w.pad);
            const cx = w.x + w.w / 2, cy = w.y + w.h / 2;
            assert.ok(Math.abs(cx + (w.w / 2 - w.pad) * w.sx - 664) <= 1, 'the right edge of the text');
            assert.ok(Math.abs(cy + (w.pad + f.baseline - w.h / 2) * w.sy - 300) <= 1, 'the baseline');
        });
    },
    'the big word stays clear of everything else, and its small line sits right above it'() {
        CALM().forEach((l) => {
            const w = l.widgets.find((x) => x.type === 'evaword'), c = canvasOf(l), cy = w.y + w.h / 2;
            const inkTop = cy - (w.h / 2 - w.pad) * w.sy, inkBottom = cy + (w.h / 2 - w.pad) * w.sy, inkLeft = 664 - (w.w - 2 * w.pad) * w.sx;
            const sub = onScreen(c, c.parts.find((p) => p.id === 'wordsub'));
            assert.strictEqual(c.parts.find((p) => p.id === 'wordsub').text, '{{wordsub}}');
            assert.ok(sub.y + sub.h <= inkTop + 1, 'small line ends at ' + (sub.y + sub.h) + ', the word starts at ' + inkTop);
            assert.ok(inkTop - (sub.y + sub.h) < 12, 'and is right above it');
            c.parts.filter((p) => p.id !== 'wordsub').forEach((p) => {
                const r = onScreen(c, p), ink = { x: inkLeft, y: inkTop, w: 664 - inkLeft, h: inkBottom - inkTop };
                assert.ok(!clash(r, ink), l.name + ': ' + p.id + ' is under the big word');
            });
        });
    },
    'the small lines of the big words fit and have their glyphs'() {
        CALM().forEach((l) => {
            const p = canvasOf(l).parts.find((x) => x.id === 'wordsub'), f = font(p.font);
            SUBS.forEach((s) => {
                Array.from(s).forEach((ch) => assert.ok(f.glyphs[ch], 'no glyph for ' + ch));
                assert.ok(width(s, f) <= p.w, s + ' does not fit');
            });
            assert.strictEqual(p.warnWhen, 'reverse');
        });
    },
    'every value can be drawn in its font: the clock\'s colon, the dashes for no data, a decimal point'() {
        const samples = { time: '23:59', boost: '-14.5', oil_v: '--', water_v: '--', power_v: '--', torque_v: '--', pedal_v: '--', burn: '99.9' };
        CALM().concat([eva, solo()]).forEach((l) => canvasOf(l).parts.forEach((p) => {
            if (!samples[p.id]) return;
            Array.from(samples[p.id]).forEach((ch) => assert.ok(font(p.font).glyphs[ch], l.name + ' ' + p.id + ' has no glyph for ' + ch + ' in ' + p.font));
            assert.ok(width(samples[p.id], font(p.font)) <= p.w, l.name + ' ' + p.id + ' does not fit ' + samples[p.id]);
        }));
        const fit = (l, id, s) => {
            const p = canvasOf(l).parts.find((x) => x.id === id);
            Array.from(s).forEach((ch) => assert.ok(font(p.font).glyphs[ch], l.name + ' ' + id + ' has no glyph for ' + ch));
            assert.ok(width(s, font(p.font)) <= p.w, l.name + ' ' + id + ' does not fit ' + s);
        };
        fit(comfort(), 'range', '999 KM');
        fit(comfort(), 'range', '-- KM');
        fit(eco(), 'range', '999');
        fit(eco(), 'range', '--');
        fit(eco(), 'burn', '--');
    },
    'the small NERV mark is dim and still, in its own file at its own size'() {
        CALM().forEach((l) => {
            const p = canvasOf(l).parts.find((x) => x.id === 'logo'), c = canvasOf(l);
            assert.ok(p, l.name + ' has no mark');
            assert.strictEqual(p.color, 'dim');
            assert.ok(!p.flicker, l.name + ' flickers');
            const m = load(p.src);
            assert.deepStrictEqual([m.w, m.h], [p.w, p.h]);
            assert.ok(p.w < 70, 'small');
            assert.strictEqual(Buffer.from(m.alpha, 'base64').length, m.w * m.h);
            const r = onScreen(c, p);
            assert.ok(r.x + r.w <= 664 && r.x > 600 && r.y < 130, 'in the top right corner: ' + [r.x, r.y]);
        });
    },
    'the app reads the tyres\' target pressure, and knows where the fuel use comes from'() {
        const spec = JSON.parse(fs.readFileSync(path.join(HUD, '..', 'app.json'), 'utf8'));
        assert.ok(spec.signals['de.bmw.infotainment.vehicle.TPMS'].statusTargetTyrePressure, 'target pressure');
        const burn = spec.config.dme.burn, by = (k, v) => burn.find((c) => c[k] === v);
        assert.ok(by('did', '5656') && by('obd', '5E'), 'both candidates');
        assert.ok(Math.abs(by('did', '5656').factor - 0.00119209 * 3.6) < 1e-6, 'ml/s to L/h');
        assert.strictEqual(by('obd', '5E').factor, 0.05);
        burn.forEach((c) => { assert.strictEqual(c.bytes, 2); assert.strictEqual(c.min, 0, 'a fuel cut reads 0'); assert.ok(c.max > 50); });
    },
    'Comfort and Eco Pro use little of the renderer\'s pixel memory'() {
        CALM().forEach((l) => {
            const bytes = normalBytes(l) + alertBytes(alert);
            assert.ok(bytes <= MIB(6), l.name + ': ' + (bytes / MIB(1)).toFixed(1) + ' MiB');
            assert.ok(l.widgets.some((w) => w.type === 'evaword' && imageBytes(w) > 0), 'the word is an image and counts');
        });
    },
    'HUD Only fits the renderer\'s pixel memory with plenty to spare'() {
        const bytes = normalBytes(solo()) + alertBytes(alert);
        assert.ok(bytes <= MIB(6), (bytes / MIB(1)).toFixed(1) + ' MiB');
    },
    'Dash Only fits: the dash holds its normal images or its alert\'s, not both'() {
        const bytes = Math.max(normalBytes(dash()), alertBytes(dashAlert()));
        assert.ok(bytes <= MIB(16), (bytes / MIB(1)).toFixed(1) + ' MiB');
    },
    'HUD + Dash fits, with both screens at their peak at once'() {
        const bytes = normalBytes(eva) + alertBytes(alert) + Math.max(normalBytes(dash()), alertBytes(dashAlert()));
        assert.ok(bytes <= MIB(16), (bytes / MIB(1)).toFixed(1) + ' MiB');
    },
};

let failed = 0;
Object.keys(tests).forEach((name) => {
    try { tests[name](); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
});
console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
