'use strict';
/**
 * What the generated EVA layouts must hold on the car, checked from the files themselves
 * (tools/eva_layout.py writes them). The renderer allows a client 8 layers, and refuses the rest with
 * "too many layers": a limit the car found and the bench did not.
 *   node bench/test/eva_layout_test.js
 */
const assert = require('assert');
const shaders = require('../../shared/shaders');
const themes = require('../../shared/hud_themes').THEMES;
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
// the dash's centre designs, on the map target under BMW's gauges, in the clear shape read off the owner's photo in Sport Plus:
// BMW's digital speed and its G meter are either side of its middle, and a white line runs in from the left
const dashA = () => load('layouts/dash_a.json');
const centreAlert = () => load('layouts/dash_centre_alert.json');
const WIN = { x: 0, y: 0, w: 1088, h: 480 };
const BMW_LINE = { x: 0, y: 268, w: 268, h: 24 };
const LOGO_CX = 540;        // the middle of BMW's model badge over the window
const SHAPE_LOCAL = [[215, 14, 800, 100], [205, 100, 820, 340], [205, 340, 850, 452], [205, 452, 790, 466]];
const SHAPE = SHAPE_LOCAL.map(([l, t, r, b]) => ({ l: l + WIN.x, t: t + WIN.y, r: r + WIN.x, b: b + WIN.y }));
const inShape = (r) => {
    for (let y = r.y; y <= r.y + r.h; y += Math.min(4, Math.max(1, r.h))) {
        for (let x = r.x; x <= r.x + r.w; x += Math.min(4, Math.max(1, r.w))) {
            if (!SHAPE.some((s) => x >= s.l && x <= s.r && y >= s.t && y <= s.b)) return false;
        }
    }
    return true;
};
const dashB = () => load('layouts/dash_b.json');
const dashD = () => load('layouts/dash_d.json');
const CENTRE = ['a', 'b', 'c1', 'c2', 'e1', 'e2'].map((n) => [n, () => load('layouts/dash_' + n + '.json')]);
const ALL_NEW = CENTRE.concat(['c3', 'e3'].map((n) => [n, () => load('layouts/dash_' + n + '.json')]));
const MOTTOS = { heaven: ['神ハ天ニ在リ', '世ハ全テ事モ無シ'], project: ['人類補完計画', '第3段階 進行中'], angel: ['使徒反応無シ', 'パターン青 未検出'],
    magi: ['MAGI 全会一致', '本日モ異常無シ'], field: ['A.T.フィールド', '全周展開中'], run: ['逃ゲチャダメダ', '逃ゲチャダメダ'] };
const MOTTO_EN = ["GOD'S IN HIS HEAVEN // ALL'S RIGHT WITH THE WORLD", 'HUMAN INSTRUMENTALITY', 'NO ANGEL DETECTED', 'MAGI UNANIMOUS', 'A.T. FIELD', "MUSTN'T RUN AWAY"];
const STATUS_TEXTS = ['SYSTEM STATUS: STANDBY // 待命状態', 'SYSTEM STATUS: CAUTION // 後退操作', 'SYSTEM STATUS: OVER REV // 回転数超過',
    'SYSTEM STATUS: FULL THROTTLE // 全力全開', 'SYSTEM STATUS: SYNCHRONIZATION ACTIVE // 同期中'];
const MAGI_WORDS = ['全会一致', '審議中', '否決'];
const MAGI_SUBS = ['UNANIMOUS // 出撃承認', 'DELIBERATING // 暖機中', 'DELIBERATING // 待機中', 'REJECTED // 油温上昇', 'REJECTED // 水温上昇', 'REJECTED // 回転数超過'];
const partOf = (l, id) => canvasOf(l).parts.find((p) => p.id === id);
const hasGlyphs = (f, s) => Array.from(s).forEach((c) => assert.ok(f.glyphs[c], 'no glyph for ' + c + ' in ' + s));
const SAYS = {
    '{{statusline}}': STATUS_TEXTS, '{{magi:word}}': MAGI_WORDS, '{{magi:sub}}': MAGI_SUBS, '{{gearcapjp}}': ['主変速器', '待命状態', '後退操作'],
    '{{oil}}': ['132', '--'], '{{coolant}}': ['118', '--'], '{{boost}}': ['-14.5', '29.0', '--'], '{{power}}': ['430', '--'], '{{range}}': ['999', '--'],
    '{{u:temp}}': ['°C'], '{{u:boost}}': ['PSI'], '{{u:power}}': ['HP'], '{{u:range}}': ['KM'], '{{u:speed}}': ['KM/H'], 'SYNC {{sync}}%': ['SYNC 99.9%'],
    '{{hh}}': ['00', '23'], '{{mm}}': ['00', '59'], '{{time}}': ['23:59', '08:08'], '{{burn}}': ['99.9', '6.6', '--'], '{{speed}}': ['299', '--'], '{{rpm}}': ['7200', '--'],
    '{{motto1}}': Object.values(MOTTOS).map((m) => m[0]), '{{motto2}}': Object.values(MOTTOS).map((m) => m[1]),
    '{{msub}}': MOTTO_EN.concat(SUBS),
    '{{wordsub}}': SUBS, '{{b:title}}': ['活動限界まで', '現在時刻'], '{{b:en}}': ['ACTIVE RANGE REMAINING', 'LOCAL TIME'], '{{b:unit}}': ['KM'],
    '{{gearshort}}': ['P', 'R', 'N', 'D', '8', '-'], '{{range}} KM': ['999 KM', '-- KM'], '{{speed}} KM/H': ['299 KM/H', '-- KM/H'],
};
for (let i = 0; i < 12; i++) { SAYS['{{mv:1:' + i + '}}'] = ['']; SAYS['{{mv:2:' + i + '}}'] = ['']; }
const dash = () => load('layouts/dash_eva.json');
const dashAlert = () => load('layouts/dash_alert.json');
const STATUS_ROW_Y = 640;      // BMW's own bottom row (range, time, temperature) stays open under the dash
// what the hood leaves visible, read off the owner's photo of the calibration grid (labels every 100 px)
const leftEdge = (y) => (y < 100 ? 480 - 3.6 * y : y < 200 ? 120 - 1.1 * (y - 100) : 10);
const rightEdge = (y) => (y < 100 ? 1420 + 3.45 * y : y < 200 ? 1765 + 1.25 * (y - 100) : 1890);
const visible = (r) => r.x >= leftEdge(r.y) && r.x + r.w <= rightEdge(r.y);
const onScreen = (c, p) => ({ x: c.x + p.x, y: c.y + p.y, w: p.w, h: p.h });
// the service counts every image twice (Compositor::add_image)
const imageBytes = (w) => (['evagear', 'evacanvas', 'evaword', 'evacolon'].indexOf(w.type) >= 0 ? w.w * w.h * 4 * 2 : 0);
const normalBytes = (l) => l.widgets.reduce((n, w) => n + imageBytes(w), 0);
const alertBytes = (al) => normalBytes(al) + 2 * al.title.w * al.title.h * 4 * 2;

function overlaps(parts) {
    const out = [];
    parts.forEach((a, i) => parts.slice(i + 1).forEach((b) => { if (clash(a, b)) out.push(a.id + '/' + b.id); }));
    return out;
}

const tests = {
    'the app icon is a 140x140 PNG with an alpha channel, the size the head unit menu uses'() {
        const png = fs.readFileSync(path.join(HUD, '../icon.png'));
        assert.strictEqual(png.toString('latin1', 1, 4), 'PNG');
        assert.strictEqual(png.readUInt32BE(16), 140);
        assert.strictEqual(png.readUInt32BE(20), 140);
        assert.strictEqual(png[25], 6, 'colour type 6 is RGBA');
    },
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
    'the menu starts with the Mode, then what each of its choices shows in each drive mode, and only then the rest'() {
        const spec = JSON.parse(fs.readFileSync(path.join(HUD, '..', 'app.json'), 'utf8')), keys = spec.settings.map((s) => s.key);
        assert.deepStrictEqual(keys.slice(0, 14), ['screens', 'hudComfort', 'hudSport', 'hudEco', 'dashComfort', 'dashSport', 'dashEco',
            'bothHudComfort', 'bothDashComfort', 'bothHudSport', 'bothDashSport', 'bothHudEco', 'bothDashEco', 'dashCenter']);
        const s = (k) => spec.settings.find((x) => x.key === k);
        assert.deepStrictEqual(s('screens').options.map((o) => o[0]), ['off', 'hud', 'dash', 'both', 'grid']);
        assert.strictEqual(s('screens').default, 'hud');
        [['Comfort', 'comfort'], ['Sport', 'sport'], ['Eco', 'eco']].forEach(([m, own]) => {
            assert.deepStrictEqual(s('hud' + m).options.map((o) => o[0]), ['comfort', 'sport', 'eco', 'off'], m);
            assert.strictEqual(s('hud' + m).default, own, 'HUD only: each drive mode has its own by default');
            assert.deepStrictEqual(s('bothHud' + m).options.map((o) => o[0]), ['eva', 'comfort', 'sport', 'eco', 'off'], m);
            assert.strictEqual(s('bothHud' + m).default, 'eva', 'HUD + Dash: the battle display made for sharing');
        });
        ['byMode', 'inComfort', 'inSport', 'inEco', 'dashLayout', 'hudLayout', 'hudDesign', 'dashDesign', 'bothHud', 'bothDash', 'comfortScreens', 'comfortDash'].forEach((k) => assert.ok(!spec.settings.some((x) => x.key === k), k + ' is still in the menu'));
    },
    'each choice of the Mode brings up only its own rows'() {
        const spec = JSON.parse(fs.readFileSync(path.join(HUD, '..', 'app.json'), 'utf8')), s = (k) => spec.settings.find((x) => x.key === k);
        const shows = (k, values) => s(k).showWhen.some((w) => Object.keys(w).every((n) => values[n] === w[n]));
        const rows = ['hudComfort', 'hudSport', 'hudEco', 'dashComfort', 'dashSport', 'dashEco', 'bothHudComfort', 'bothDashComfort', 'bothHudSport', 'bothDashSport', 'bothHudEco', 'bothDashEco'];
        const on = (screens) => rows.filter((k) => shows(k, { screens }));
        assert.deepStrictEqual(on('off'), []);
        assert.deepStrictEqual(on('grid'), []);
        assert.deepStrictEqual(on('hud'), ['hudComfort', 'hudSport', 'hudEco']);
        assert.deepStrictEqual(on('dash'), ['dashComfort', 'dashSport', 'dashEco']);
        assert.deepStrictEqual(on('both'), ['bothHudComfort', 'bothDashComfort', 'bothHudSport', 'bothDashSport', 'bothHudEco', 'bothDashEco']);
        assert.ok(shows('dashCenter', { screens: 'dash', dashSport: 'b' }));
        assert.ok(!shows('dashCenter', { screens: 'dash', dashSport: 'a', bothDashSport: 'b' }), 'B is not what shows');
        assert.ok(shows('dashCenter', { screens: 'both', bothDashEco: 'b' }));
        assert.ok(!shows('dashCenter', { screens: 'hud', dashSport: 'b' }));
        assert.ok(!spec.settings.find((x) => x.key === 'motto').showWhen, 'the rest of the menu stays');
    },
    'whatever the owner picks, the HUD and the dash fit the pixel memory together'() {
        const huds = [eva, solo(), comfort(), eco()];
        const centre = CENTRE.map(([, get]) => normalBytes(get()) + alertBytes(centreAlert()));
        const whole = ['dash_eva', 'dash_d', 'dash_c3', 'dash_e3'].map((n) => Math.max(normalBytes(load('layouts/' + n + '.json')), alertBytes(dashAlert())));
        const dash = Math.max.apply(null, centre.concat(whole));
        huds.forEach((h) => {
            const bytes = normalBytes(h) + alertBytes(alert) + dash;
            assert.ok(bytes <= MIB(16), h.name + ': ' + (bytes / MIB(1)).toFixed(1) + ' MiB');
        });
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
    'Comfort is four layers with its colon, Eco Pro three, and with an alert they stay within the 8'() {
        assert.deepStrictEqual(comfort().widgets.map((w) => w.type), ['evacorners', 'evaword', 'evacanvas', 'evacolon']);
        CALM().filter((l) => l.name !== comfort().name).forEach((l) => assert.ok(!l.widgets.some((w) => w.type === 'evacolon'), l.name));
        CALM().forEach((l) => {
            assert.ok(l.widgets.length + alert.widgets.length + 2 <= 7, l.name + ': ' + l.widgets.length);
        });
    },
    'Comfort\'s clock is laid out as before, with the colon on a layer of its own between the digits'() {
        const c = canvasOf(comfort()), hh = c.parts.find((p) => p.id === 'hh'), mm = c.parts.find((p) => p.id === 'mm');
        const colon = comfort().widgets.find((w) => w.type === 'evacolon'), f = font(hh.font);
        assert.strictEqual(hh.text, '{{hh}}');
        assert.strictEqual(mm.text, '{{mm}}');
        assert.ok(!c.parts.some((p) => p.id === 'time'), 'the clock is still one part');
        assert.ok(colon.z > c.z, 'under the text');
        const digits = '0123456789'.split('').map((d) => f.glyphs[d].advance);
        assert.ok(digits.every((a) => a === digits[0]), 'digits of different widths would move the colon');
        const penHh = c.x + hh.x + hh.textX, penColon = colon.x + colon.pad, penMm = c.x + mm.x + mm.textX;
        assert.strictEqual(penColon, penHh + 2 * digits[0], 'the colon follows the hours');
        assert.strictEqual(penMm, penColon + f.glyphs[':'].advance, 'the minutes follow the colon');
        assert.strictEqual(colon.y + colon.offsetY, c.y + hh.y + hh.offsetY, 'on the same line');
        assert.strictEqual(colon.font, hh.font);
        assert.ok(imageBytes(colon) < 32 * 1024, imageBytes(colon) + ' bytes');
        const r = onGlass(colon);
        assert.ok(r.x >= 0 && r.y >= 0, 'off the glass');
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
        assert.strictEqual(part('range').text, '{{range}} KM');
        assert.strictEqual(font(part('hh').font).source, 'MatissePro-EB.otf');
        assert.ok(font(part('hh').font).size >= 66, 'giant');
        assert.ok(part('place').y < part('hh').y && part('hh').y < part('range').y, 'top to bottom');
        c.parts.filter((p) => p.type === 'text' && p.id !== 'hh' && p.id !== 'mm').forEach((p) => assert.ok(font(p.font).size < font(part('hh').font).size, p.id + ' outshouts the time'));
    },
    'Comfort has no tyres: the line picked in the menu is where they were, in the title type and big enough to read'() {
        const c = canvasOf(comfort()), part = (id) => c.parts.find((p) => p.id === id);
        assert.strictEqual(part('motto1').text, '{{motto1}}');
        assert.strictEqual(part('motto2').text, '{{motto2}}');
        ['motto1', 'motto2'].forEach((id) => {
            const r = onScreen(c, part(id));
            assert.strictEqual(font(part(id).font).source, 'MatissePro-EB.otf');
            assert.ok(font(part(id).font).size >= 28, id + ' is too small to read');
            assert.strictEqual(part(id).color, 'soft');
            assert.strictEqual(r.x, onScreen(canvasOf(eco()), canvasOf(eco()).parts.find((p) => p.id === 'burn_l')).x, 'starts where Eco Pro\'s fuel use starts');
            assert.ok(r.x >= BMW.x + BMW.w, 'beside BMW\'s speed');
            assert.ok(r.y + r.h <= 378, 'above the corners\' bottom edge');
        });
        assert.ok(part('motto1').y < part('motto2').y);
        c.parts.forEach((p) => assert.ok(!/^t[npt]_/.test(p.id) && !/tyre/.test(p.text || '') && !p.warnWhen || p.warnWhen === 'reverse', p.id + ' is about the tyres'));
        assert.ok(!c.parts.some((p) => p.id === 'car'), 'the little car is back');
        assert.ok(!fs.existsSync(path.join(HUD, 'fonts/num21.json')), 'the tyres\' digits are still baked');
    },
    'Comfort\'s place name is big enough to read, inside its corner and clear of the clock'() {
        const c = canvasOf(comfort()), corners = comfort().widgets.find((w) => w.type === 'evacorners');
        const place = c.parts.find((p) => p.id === 'place'), hh = c.parts.find((p) => p.id === 'hh'), r = onScreen(c, place), f = font(place.font);
        assert.strictEqual(f.source, 'MatissePro-EB.otf');
        assert.ok(f.size >= 26, 'still small: ' + f.size);
        assert.strictEqual(place.color, 'soft');
        assert.ok(r.x >= corners.x + 12 && r.y >= corners.y + 4, 'on the corner: ' + [r.x, r.y]);
        const digitTop = hh.y + hh.offsetY + font(hh.font).baseline - Math.round(font(hh.font).size * 0.8);
        assert.ok(place.y + f.baseline < digitTop, 'on the clock');
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
            const r = onScreen(c, p), corners = l.widgets.find((w) => w.type === 'evacorners');
            assert.ok(corners.x + corners.w - (r.x + r.w) >= 28, 'too near the right edge: ' + (corners.x + corners.w - (r.x + r.w)));
            assert.ok(r.y - corners.y >= 18, 'too near the top edge: ' + (r.y - corners.y));
            assert.ok(r.x > 580 && r.y < 150, 'no longer in the top right: ' + [r.x, r.y]);
        });
    },
    'the app does not ask for the tyres, and knows where the fuel use comes from'() {
        const spec = JSON.parse(fs.readFileSync(path.join(HUD, '..', 'app.json'), 'utf8'));
        assert.ok(!spec.signals['de.bmw.infotainment.vehicle.TPMS'], 'TPMS is still in app.json');
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
    'a centre design and an alert together stay within the 8 layers a client may have'() {
        CENTRE.forEach(([name, get]) => assert.ok(get().widgets.length + centreAlert().widgets.length + 2 <= 8, name + ': ' + get().widgets.length));
    },
    'every centre design draws only where BMW\'s gauges leave it clear'() {
        CENTRE.forEach(([name, get]) => {
            const d = get(), c = canvasOf(d);
            d.widgets.filter((w) => w.id !== 'bg' && w.type !== 'evacanvas').forEach((w) => {
                const m = w.margin || 0;    // a shader's room for its glow may run over
                assert.ok(inShape({ x: w.x + m, y: w.y + m, w: w.w - 2 * m, h: w.h - 2 * m }), name + ' ' + w.id);
            });
            c.parts.forEach((p) => assert.ok(inShape(onScreen(c, p)), name + ' ' + p.id));
        });
    },
    'a centre design\'s ground fills the window and stays through an alert'() {
        CENTRE.forEach(([name, get]) => {
            const bg = get().widgets.find((w) => w.id === 'bg');
            assert.ok(bg && (bg.type === 'evahex' || bg.type === 'evahazard'), name + ' has no ground');
            assert.deepStrictEqual([bg.x, bg.y, bg.w, bg.h], [WIN.x, WIN.y, WIN.w, WIN.h], name);
            assert.strictEqual(bg.keepInAlert, true, name);
        });
    },
    'nothing a centre design says lies under the white line BMW runs in from the left'() {
        CENTRE.forEach(([name, get]) => {
            const d = get(), c = canvasOf(d);
            c.parts.forEach((p) => assert.ok(!clash(onScreen(c, p), BMW_LINE), name + ' ' + p.id));
            d.widgets.filter((w) => ['evaseven', 'evaword', 'evacolon'].indexOf(w.type) >= 0).forEach((w) => {
                const m = w.margin || 0;
                assert.ok(!clash({ x: w.x + m, y: w.y + m, w: w.w - 2 * m, h: w.h - 2 * m }, BMW_LINE), name + ' ' + w.id);
            });
        });
    },
    'Tokyo-3\'s name sits right under BMW\'s model badge on Comfort\'s clock, and its mark clear of BMW\'s shading'() {
        const d = load('layouts/dash_c1.json'), c = canvasOf(d), place = onScreen(c, partOf(d, 'place')), logo = onScreen(c, partOf(d, 'logo'));
        assert.ok(Math.abs(place.x + place.w / 2 - LOGO_CX) <= 2, 'it is ' + (place.x + place.w / 2));
        assert.ok(logo.x >= 215 && logo.x + logo.w <= 800, 'the mark is in the shading');
        assert.ok(Math.abs(d.widgets.find((w) => w.type === 'evacolon').x + d.widgets.find((w) => w.type === 'evacolon').w / 2 - LOGO_CX) <= 2, 'the clock is not under the badge');
    },
    'the power lamp has moved out of the shading on the left'() {
        ['b', 'e2'].forEach((n) => {
            const d = load('layouts/dash_' + n + '.json'), c = canvasOf(d), lamp = onScreen(c, c.parts.find((p) => p.when === 'always'));
            assert.ok(lamp.x >= 205, n + ': x ' + lamp.x);
        });
    },
    'the centre alert stays in the middle, where BMW\'s digital speed and G meter cannot cover it'() {
        const a = centreAlert(), c = canvasOf(a), t = a.title;
        c.parts.forEach((p) => {
            const r = onScreen(c, p);
            assert.ok(r.x >= 205 && r.x + r.w <= 820 && inShape(r), p.id + ' is outside the middle');
        });
        const title = { x: t.x + t.pad, y: t.y + t.pad, w: t.w - 2 * t.pad, h: t.h - 2 * t.pad };
        assert.ok(title.x >= 205 && title.x + title.w <= 820 && inShape(title), 'the title is outside the middle');
        assert.ok(a.rows.knock.every((r) => font(r.font).cellHeight >= 120), 'the title should still be huge');
    },
    'parts of every centre design never overlap and lie inside their canvases'() {
        CENTRE.concat([['alert', centreAlert]]).forEach(([name, get]) => {
            const c = canvasOf(get());
            assert.deepStrictEqual(overlaps(c.parts), [], name);
            c.parts.forEach((p) => assert.ok(fits(p, c.w, c.h), name + ' ' + p.id + ' is off the canvas'));
        });
    },
    'everything any new design can say has its glyphs and fits its box'() {
        ALL_NEW.forEach(([name, get]) => canvasOf(get()).parts.filter((p) => p.type === 'text').forEach((p) => {
            const list = SAYS[p.text] || (p.text.indexOf('{{') < 0 ? [p.text] : null);
            if (p.byMotto) return;
            assert.ok(list, name + ': nothing lists what ' + p.text + ' says');
            list.forEach((s) => {
                hasGlyphs(font(p.font), s);
                assert.ok(width(s, font(p.font)) <= p.w, name + ' ' + p.id + ': ' + s + ' is ' + width(s, font(p.font)) + ', its box ' + p.w);
            });
        }));
    },
    'the new designs\' big words have their glyphs and fit their layers'() {
        ALL_NEW.forEach(([name, get]) => get().widgets.filter((w) => w.type === 'evaword').forEach((w) => WORDS.forEach((s) => {
            hasGlyphs(font(w.font), s);
            assert.ok(width(s, font(w.font)) <= w.w - 2 * w.pad, name + ': ' + s);
        })));
    },
    'the new designs\' lamps have their glyphs and fit'() {
        ALL_NEW.forEach(([name, get]) => canvasOf(get()).parts.filter((p) => p.type === 'lamp').forEach((p) => {
            const tops = p.top === '{{b:power}}' ? ['外部電源', '内部電源'] : [p.top], subs = p.sub === '{{b:powersub}}' ? ['EXTERNAL', 'INTERNAL'] : p.sub ? [p.sub] : [];
            tops.forEach((s) => { hasGlyphs(font(p.fonts.top), s); assert.ok(width(s, font(p.fonts.top)) <= p.w - 6, name + ' ' + s); });
            subs.forEach((s) => { hasGlyphs(font(p.fonts.sub), s); assert.ok(width(s, font(p.fonts.sub)) <= p.w - 6, name + ' ' + s); });
        }));
    },
    'the new designs\' logos are the size of the files they draw'() {
        ALL_NEW.forEach(([name, get]) => canvasOf(get()).parts.filter((p) => p.type === 'logo').forEach((p) => {
            const m = load(p.src);
            assert.deepStrictEqual([m.w, m.h], [p.w, p.h], name);
        }));
    },
    'each drive mode\'s designs are in its colours: orange, orange and white, and blue'() {
        const theme = (n) => load('layouts/dash_' + n + '.json').theme;
        ['a', 'b', 'd'].forEach((n) => assert.strictEqual(theme(n), 'eva', n));
        ['c1', 'c2', 'c3'].forEach((n) => assert.strictEqual(theme(n), 'eva_orange_white', n));
        ['e1', 'e2', 'e3'].forEach((n) => assert.strictEqual(theme(n), 'eva_eco', n));
        const t = themes.eva_orange_white;
        assert.deepStrictEqual(t.fg, themes.eva.fg, 'its orange is the battle display\'s');
        assert.deepStrictEqual(t.white.slice(0, 3), [255, 255, 255]);
        [t, themes.eva_eco].forEach((x) => ['tag', 'sub', 'faint', 'wire', 'white', 'amber', 'ok', 'no', 'blue'].forEach((r) => assert.ok(x[r], x.name + ' has no ' + r)));
    },
    'Comfort\'s numbers are white and its labels orange'() {
        const is = (n, id, role) => assert.strictEqual(partOf(load('layouts/dash_' + n + '.json'), id).color, role, n + ' ' + id);
        is('c1', 'hh', 'white'); is('c1', 'mm', 'white'); is('c1', 'range', 'white'); is('c1', 'place', 'fg');
        is('c2', 'time', 'white'); is('c2', 'range', 'white'); is('c2', 'row1', 'white'); is('c2', 'row2', 'white');
        is('c3', 'speed', 'white'); is('c3', 'place', 'fg'); is('c3', 'hh', 'fg');
    },
    'design C2 fills the shape with each line: every row has a font of its own, at most the shape wide'() {
        const d = load('layouts/dash_c2.json');
        [['row1', 0, 610], ['row2', 1, 642]].forEach(([id, i, max]) => {
            const p = partOf(d, id);
            Object.keys(MOTTOS).forEach((k) => {
                const m = p.byMotto[k], f = font(m.font), s = MOTTOS[k][i];
                assert.ok(m, k);
                hasGlyphs(f, s);
                assert.ok(width(s, f) <= max && width(s, f) <= p.w, k + ': ' + width(s, f));
                assert.ok(m.offsetY + f.cellHeight <= p.h, k + ' runs off its box');
            });
        });
        const heaven = partOf(d, 'row2').byMotto.heaven;
        assert.ok(width(MOTTOS.heaven[1], font(heaven.font)) > 600, 'the line is not as big as it can be');
    },
    'the lines are hidden behind the big word in P, R and N'() {
        ['c1', 'e1'].forEach((n) => canvasOf(load('layouts/dash_' + n + '.json')).parts.filter((p) => /motto/.test(p.text)).forEach((p) => assert.strictEqual(p.driving, true, n + ' ' + p.id)));
        assert.strictEqual(partOf(load('layouts/dash_c2.json'), 'row1').driving, true);
        assert.strictEqual(partOf(load('layouts/dash_c2.json'), 'row2').driving, true);
    },
    'design C3 sets the line vertically, a cell for each character'() {
        const d = load('layouts/dash_c3.json');
        [1, 2].forEach((row) => {
            const cells = canvasOf(d).parts.filter((p) => new RegExp('^\\{\\{mv:' + row + ':').test(p.text));
            const longest = Math.max.apply(null, Object.values(MOTTOS).map((m) => m[row - 1].replace(/ /g, '').length));
            assert.ok(cells.length >= longest, 'column ' + row + ' has ' + cells.length + ' cells for ' + longest + ' characters');
            cells.forEach((p) => {
                const f = font(p.font);
                Object.values(MOTTOS).forEach((m) => Array.from(m[row - 1].replace(/ /g, '').replace(/ー/g, '｜')).forEach((ch) => {
                    hasGlyphs(f, ch);
                    assert.ok(width(ch, f) <= p.w, ch + ' is wider than its cell');
                }));
            });
            const xs = new Set(cells.map((p) => p.x + p.w / 2));
            assert.strictEqual(xs.size, 1, 'a column should be straight');
        });
    },
    'the whole-cluster designs stay on the cluster, clear of BMW\'s row and the hood, and fit an alert'() {
        [['c3', load('layouts/dash_c3.json')], ['e3', load('layouts/dash_e3.json')]].forEach(([name, d]) => {
            d.widgets.forEach((w) => assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= 1920 && w.y + w.h <= STATUS_ROW_Y, name + ' ' + w.id));
            const c = canvasOf(d);
            assert.deepStrictEqual(overlaps(c.parts), [], name);
            c.parts.forEach((p) => {
                assert.ok(fits(p, c.w, c.h), name + ' ' + p.id + ' is off the canvas');
                assert.ok(visible(onScreen(c, p)), name + ' ' + p.id + ' goes under the hood');
            });
            const big = d.widgets.filter((w) => w.type === 'evagear' || w.type === 'evacanvas').length;
            assert.ok(d.widgets.length - big + 3 <= 8, name + ': ' + (d.widgets.length - big + 3) + ' layers in an alert');
        });
    },
    'E1\'s bar follows the fuel use, E2 has its rings, and E3 always shows the range in its seven segments'() {
        const bar = load('layouts/dash_e1.json').widgets.find((w) => w.type === 'evaseg');
        assert.strictEqual(bar.source, 'burn');
        assert.ok(load('layouts/dash_e2.json').widgets.find((w) => w.type === 'evarings'), 'no rings');
        assert.strictEqual(load('layouts/dash_e3.json').widgets.find((w) => w.type === 'evaseven').rangeOnly, true);
    },
    'the colons that breathe have layers of their own in Comfort\'s big clocks'() {
        ['c1', 'c3'].forEach((n) => assert.ok(load('layouts/dash_' + n + '.json').widgets.find((w) => w.type === 'evacolon'), n));
    },
    'the seven segments stay out of the separator\'s column'() {
        // a digit drawn with the separator's unshifted x lands its left side in the gap: 299.0 read like 29910 on the car
        assert.ok(/clamp\(floor\([^;]*u_sepAfter/.test(shaders.evaseven) || /u_sepAfter[^;]*clamp\(floor/.test(shaders.evaseven), 'the digit index is not held to its side of the separator');
    },
    'a gear digit of design A sits in the middle of its frame, not low in it'() {
        const d = dashA(), g = d.widgets.find((w) => w.type === 'evagear'), fr = d.widgets.find((w) => w.type === 'evaframe'), f = font(g.fontPrefix + 'gear');
        assert.ok(f.cellHeight <= g.h, 'the digit is taller than its layer');
        assert.strictEqual(g.y + g.h / 2, fr.y + fr.h / 2, 'the gear is not centred up and down in its frame');
        ['0', '3', '6', '8'].forEach((c) => assert.ok(f.glyphs[c].h >= f.cellHeight - 4, c + ' is not as tall as the cell'));
    },
    'the owner\'s words for P, R and N fit the gear\'s layer of design A'() {
        const g = dashA().widgets.find((w) => w.type === 'evagear'), f = font(g.fontPrefix + 'gearjp');
        ['出撃', '待命', '緊急', '撤退', '同期', '解除', '予備'].forEach((s) => {
            hasGlyphs(f, s);
            assert.ok(width(s, f) <= g.w, s + ' is too wide');
        });
        assert.ok(g.wordPitch + f.cellHeight <= g.h, 'two rows do not fit');
        assert.strictEqual(g.words, true);
    },
    'the MAGI plates of design A name what they watch, in a row, in fonts that have the glyphs'() {
        const d = dashA(), got = {};
        ['plate_m', 'plate_b', 'plate_c'].forEach((id) => {
            const p = partOf(d, id);
            got[p.magi] = p.name + ' ' + p.watch;
            hasGlyphs(font(p.fonts.name), p.name);
            hasGlyphs(font(p.fonts.ok), '承認否決');
            hasGlyphs(font(p.fonts.wait), '審議中');
            hasGlyphs(font(p.fonts.watch), p.watch);
            ['承認', '否決'].forEach((s) => assert.ok(width(s, font(p.fonts.ok)) <= p.w, s + ' does not fit a plate'));
            assert.ok(width('審議中', font(p.fonts.wait)) <= p.w - 8, '審議中 does not fit a plate');
            assert.ok(width(p.name, font(p.fonts.name)) <= p.w - 8, p.name + ' does not fit a plate');
        });
        assert.deepStrictEqual(got, { balthasar: 'BALTHASAR·2 水温', casper: 'CASPER·3 駆動', melchior: 'MELCHIOR·1 油温' });
        const ys = ['plate_m', 'plate_b', 'plate_c'].map((id) => partOf(d, id).y);
        assert.strictEqual(new Set(ys).size, 1, 'the plates should be in one row');
    },
    'all six alerts have their rows in the centre alert, inside the title layer'() {
        const a = centreAlert();
        ['knock', 'heat', 'boost', 'fuel', 'afr', 'multi'].forEach((id) => {
            assert.ok(a.rows[id] && a.rows[id].length === 2, id);
            a.rows[id].forEach((r) => {
                const f = font(r.font);
                hasGlyphs(f, r.text);
                assert.ok(r.y >= 0 && r.y + f.cellHeight <= a.title.h, id + ' row runs off the title layer');
                assert.ok(width(r.text, f) <= a.title.w, id + ' row is too wide');
            });
        });
    },
    'a centre design keeps its normal images and an alert\'s at once, even beside the HUD at its peak'() {
        CENTRE.forEach(([name, get]) => {
            const alone = normalBytes(get()) + alertBytes(centreAlert());
            assert.ok(alone <= MIB(12), name + ': ' + (alone / MIB(1)).toFixed(1) + ' MiB');
            const both = alone + normalBytes(eva) + alertBytes(alert);
            assert.ok(both <= MIB(16), name + ' with the HUD: ' + (both / MIB(1)).toFixed(1) + ' MiB');
        });
    },
    'a whole-cluster design holds its normal images or its alert\'s, within the budget'() {
        [dashD(), load('layouts/dash_c3.json'), load('layouts/dash_e3.json')].forEach((d) => {
            const bytes = Math.max(normalBytes(d), alertBytes(dashAlert()));
            assert.ok(bytes <= MIB(16), d.name + ': ' + (bytes / MIB(1)).toFixed(1) + ' MiB');
        });
    },
    'each drive mode can pick any of the ten designs or none, with the whole cluster as the default'() {
        const spec = JSON.parse(fs.readFileSync(path.join(HUD, '..', 'app.json'), 'utf8'));
        const all = ['whole', 'a', 'b', 'd', 'c1', 'c2', 'c3', 'e1', 'e2', 'e3', 'off'];
        ['dashComfort', 'dashSport', 'dashEco', 'bothDashComfort', 'bothDashSport', 'bothDashEco'].forEach((key) => {
            const s = spec.settings.find((x) => x.key === key);
            assert.ok(s, 'no ' + key);
            assert.deepStrictEqual(s.options.map((o) => o[0]), all, key);
            assert.strictEqual(s.default, 'whole', key);
        });
        const c = spec.settings.find((x) => x.key === 'dashCenter');
        assert.deepStrictEqual(c.options.map((o) => o[0]), ['range', 'time']);
        assert.strictEqual(c.default, 'range');
        assert.ok(spec.shared.indexOf('eva_magi.js') >= 0, 'eva_magi.js is not shipped');
    },
    'design B stays small: three layers'() {
        assert.strictEqual(dashB().widgets.length, 3);
    },
    'design B has its seven segments in the middle, drawn by a shader, and hazard stripes as its ground'() {
        const d = dashB(), seven = d.widgets.find((w) => w.type === 'evaseven'), bg = d.widgets.find((w) => w.type === 'evahazard');
        assert.ok(seven && bg, 'a layer is missing');
        const c = canvasOf(d), lamps = c.parts.filter((p) => p.type === 'lamp').map((p) => onScreen(c, p));
        assert.strictEqual(lamps.length, 4);
        lamps.forEach((l) => assert.ok(!clash(l, { x: seven.x + seven.margin, y: seven.y + seven.margin, w: seven.w - 2 * seven.margin, h: seven.h - 2 * seven.margin }), 'a lamp is under the digits'));
    },
    'design B\'s power lamp shows only the state it is in, and its drive-mode lamps what the owner picked'() {
        const parts = canvasOf(dashB()).parts.filter((p) => p.type === 'lamp');
        assert.deepStrictEqual(parts.map((p) => p.when), ['always', 'eco', 'comfort', 'sport']);
        assert.deepStrictEqual(parts.map((p) => p.top), ['{{b:power}}', 'SLOW', 'NORMAL', 'RACING']);
    },
    'design D stays within the 8 layers with an alert, on the cluster and clear of BMW\'s bottom row'() {
        const d = dashD();
        assert.ok(d.widgets.length + dashAlert().widgets.length + 2 <= 8, d.widgets.length + ' layers');
        d.widgets.forEach((w) => assert.ok(w.x >= 0 && w.y >= 0 && w.x + w.w <= 1920 && w.y + w.h <= STATUS_ROW_Y, w.id));
    },
    'nothing of design D goes under the hood, and its parts never overlap'() {
        const d = dashD(), c = canvasOf(d);
        assert.deepStrictEqual(overlaps(c.parts), []);
        c.parts.forEach((p) => {
            assert.ok(fits(p, c.w, c.h), p.id + ' is off the canvas');
            assert.ok(visible(onScreen(c, p)), p.id + ' goes under the hood');
        });
        d.widgets.filter((w) => w.type === 'evaseg').forEach((w) => assert.ok(visible(w), w.id + ' goes under the hood'));
    },
    'design D has no MAGI: its place shows the live revs, as large as the design allows'() {
        const d = dashD(), parts = canvasOf(d).parts;
        assert.ok(!parts.some((p) => p.type === 'plate' || p.type === 'wires' || /magi/i.test(p.text || '')), 'MAGI is still there');
        const r = partOf(d, 'rpm_v'), s = partOf(d, 'speed_v'), f = font(r.font);
        assert.strictEqual(r.text, '{{rpm}}');
        ['6999', '--'].forEach((t) => { hasGlyphs(f, t); assert.ok(width(t, f) <= r.w, t + ' does not fit'); });
        assert.ok(r.y > s.y + s.h - 1, 'the revs should be under the speed');
        assert.ok(f.cellHeight >= 90, 'the revs are too small to read: ' + f.cellHeight);
    },
    'everything design D can say has its glyphs and fits its box'() {
        const d = dashD(), fit = (id, list) => {
            const p = partOf(d, id), f = font(p.font);
            list.forEach((s) => { hasGlyphs(f, s); assert.ok(width(s, f) <= p.w, s + ' does not fit ' + p.w); });
        };
        fit('status', STATUS_TEXTS);
        fit('cap', ['主変速器', '待命状態', '後退操作']);
        fit('speed_v', ['299', '--']);
        fit('oil_v', ['132', '--']);
        fit('water_v', ['118', '--']);
        fit('boost_v', ['-14.5', '29.0', '--']);
        fit('power_v', ['430', '--']);
        fit('range_v', ['999', '--']);
        canvasOf(d).parts.filter((p) => p.type === 'text' && p.text.indexOf('{{') < 0).forEach((p) => {
            hasGlyphs(font(p.font), p.text);
            assert.ok(width(p.text, font(p.font)) <= p.w, p.id + ' does not fit');
        });
    },
    'design D\'s gear sits in the middle of its frame, with the owner\'s words in its own font'() {
        const d = dashD(), f = d.widgets.find((w) => w.type === 'evaframe'), g = d.widgets.find((w) => w.type === 'evagear');
        assert.strictEqual(f.x + f.w / 2, 960);
        assert.strictEqual(g.x + g.w / 2, 960);
        assert.strictEqual(g.y + g.h / 2, f.y + f.h / 2);
        assert.strictEqual(g.words, true);
        const jp = font(g.fontPrefix + 'gearjp');
        ['出撃', '待命', '緊急', '撤退', '同期', '解除', '予備'].forEach((s) => { hasGlyphs(jp, s); assert.ok(width(s, jp) <= g.w, s); });
        assert.ok(g.wordPitch + jp.cellHeight <= g.h, 'two rows do not fit');
    },
    'design D\'s logo stays clear of the rev bar and the speed'() {
        const d = dashD(), c = canvasOf(d), logo = onScreen(c, partOf(d, 'logo')), rev = d.widgets.find((w) => w.type === 'evaseg');
        assert.ok(logo.y >= rev.y + rev.h, 'the logo starts at ' + logo.y + ', the rev bar ends at ' + (rev.y + rev.h));
    },
    'design D\'s logo is the size of the file it draws'() {
        const p = partOf(dashD(), 'logo'), m = load(p.src);
        assert.deepStrictEqual([m.w, m.h], [p.w, p.h]);
    },
    'designs B and D fit the pixel memory at their peaks'() {
        const b = normalBytes(dashB()) + alertBytes(centreAlert());
        assert.ok(b <= MIB(12), (b / MIB(1)).toFixed(1) + ' MiB');
        const d = Math.max(normalBytes(dashD()), alertBytes(dashAlert()));
        assert.ok(d <= MIB(16), (d / MIB(1)).toFixed(1) + ' MiB');
        const both = normalBytes(eva) + alertBytes(alert) + Math.max(b, d);
        assert.ok(both <= MIB(16), (both / MIB(1)).toFixed(1) + ' MiB with the HUD');
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
