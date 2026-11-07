'use strict';
/**
 * The EVA HUD: the drawing engine (hud.js) plus what only this app has. See docs/superpowers/specs/2026-11-05-eva-hud-design.md.
 *
 * cluster-render refuses a client's 9th layer ("too many layers"), so the whole app is 7 layers.
 *
 * The app has three modes, one setting ("screens"): HUD Only, Dash Only, HUD + Dash, each with its own layouts and its
 * own share of the renderer's memory. The drive mode never changes the mode: in each mode, each drive mode picks what the HUD
 * and the dash show, or that they show nothing ("hudSport", "dashSport", "bothHudSport", "bothDashSport").
 * BMW's own speed and limit sign can't be removed from the HUD, so the HUD draws no speed: its layouts leave that place
 * free and name BMW's speed.
 *
 * Normal state, 4 layers: hud/layouts/eva.json, or 5 in HUD Only - Sport (hud_only_sport.json), with widget types of its own:
 *   evaseg     effect layer; the 28-segment rev bar
 *   evaframe   effect layer; the gear's frame
 *   evagear    image layer; the giant gear, or 出撃待命 / 予備 / REVERSE
 *   evacanvas  image layer; every other text, a rule and the MAGI markers, as "parts" sent by rectangle (eva_canvas.js)
 *   evasolo    effect layer; the throttle bar, which costs no pixel memory and next to no upload
 *   evahex     effect layer; the opaque honeycomb ground of the dash's designs A and D
 *   evahazard  effect layer; design B's opaque ground, with hazard stripes along its edges
 *   evaseven   effect layer; design B's four seven-segment digits, which change by uniform and send no pixels
 *
 * HUD Only - Comfort and Eco Pro are the everyday ones, 3 layers: no gear, no revs, nothing that flashes.
 *   evacorners effect layer; four thin corners that open a little with speed, for one number
 *   evaword    image layer; a title card's big word in P, R and N. Each word goes up once, then only its opacity changes
 *   evacanvas  the time, the range, and the line picked in the menu (Comfort) or the fuel use (Eco Pro)
 *   evacolon   image layer, Comfort only; the clock's colon, which breathes. It goes up once, then only its opacity changes
 *
 * Alert state, 3 layers: when eva_alerts.js says so, the normal layers hide and hud/layouts/alert.json shows, with
 * the alert's own colour (theme role "alert"). The title is two image layers, the colour with its glow and a white
 * one on top, and it flashes by changing the white layer's opacity: nothing is uploaded again to flash.
 *
 * The same app can draw the same design on the cluster at the same time: shared/eva_dash.js, on a connection of its
 * own, with its own layouts. This class owns the car data, the engine unit and the alert rules for both.
 *
 * While a BMW pop-up shows a screen hides its layers, so the service doesn't ask for the slot again and push the pop-up
 * to the other screen (shared/eva_popups.js).
 *
 * Units are fixed, as the owner wants them: pressure in PSI, power in HP, torque in Nm, temperatures in °C, speed in km/h.
 * Inside, pressures stay in bar: the alert limits are in bar and the menu shows them in PSI.
 *
 * Anything that looks like car data is car data, except under the demo setting (shared/eva_demo.js). SYNC is decoration.
 */
const HudApp = require('./hud');
const textRaster = require('./hud_text');
const hudData = require('./hud_data');
const shaders = require('./shaders');
const { color } = require('./hud_themes');
const { TextCanvas, changes } = require('./eva_canvas');
const { AlertEngine } = require('./eva_alerts');
const { EvaDiag } = require('./eva_diag');
const { PopupWatch } = require('./eva_popups');
const { Flicker } = require('./eva_flicker');
const { judge } = require('./eva_magi');
const EvaDemo = require('./eva_demo');

// same strings as tools/eva_layout.py, which bakes their glyphs
const ALERTS = {
    knock: { en: 'EMERGENCY', jp: '非常事態', rgb: [255, 17, 0], label: '退点火  KNOCK RETARD', status: 'KNOCK DETECTED // 異常検出', preview: 5.2 },
    heat: { en: 'OVERHEAT', jp: '冷却過熱', rgb: [255, 68, 0], label: '冷却水  COOLANT', status: 'COOLANT ALERT // 臨界超過', preview: 121 },
    boost: { en: 'OVERBOOST', jp: '増圧限界', rgb: [0, 229, 255], label: '増圧  BOOST', status: 'LIMIT EXCEEDED // 限界突破', preview: 2.1 },
    fuel: { en: 'FUEL CRITICAL', jp: '燃圧喪失', rgb: [255, 0, 80], label: '高圧燃料  HPFP', status: 'SUPPLY FAILURE // 生命線断絶', preview: 18 },
    afr: { en: 'AFR ANOMALY', jp: '空燃比異常', rgb: [118, 255, 3], label: '空燃比  AFR', status: 'AFR DEVIATION // 混合気異常', preview: 18.8 },
    multi: { en: 'MULTIPLE ALERTS', jp: '多重警報発令', rgb: [255, 0, 51], label: '同時発生', status: '', preview: 3 },
};
const LIVE_SETTINGS = ['demo', 'gmtOffset', 'motto', 'dashCenter', 'alertsOn', 'dismissAlert', 'alertPreview', 'limitKnock', 'limitFuel', 'limitAfrLow', 'limitAfrHigh', 'limitHeat', 'limitBoost'];
const POPUP_SLOT_HUD = 0x322;
// the settings that choose what shows: a change redraws only if it changes that
const LAYOUT_SETTINGS = /^(screens|(hud|dash|bothHud|bothDash)(Comfort|Sport|Eco))$/;
const DRIVE_PROFILES = ['comfort', 'sport', 'eco'];
const PROFILE_KEY = { comfort: 'Comfort', sport: 'Sport', eco: 'Eco' };     // the end of a setting's name
const MENU_VERSION = 2;
// The everyday layouts' big word and the line over it, for P, R and N: same strings as tools/eva_layout.py.
const WORDS = {
    P: { text: '出撃待命', sub: 'SORTIE STANDBY // 拘束具固定' },
    R: { text: '緊急撤退', sub: 'RETREAT // 総員退避' },
    N: { text: '同期解除', sub: 'SYNCHRO CUT // 駆動系切離' },
};
// The line picked in the menu: same strings as tools/eva_layout.py, which bakes their glyphs.
const MOTTO_EN = {
    heaven: "GOD'S IN HIS HEAVEN // ALL'S RIGHT WITH THE WORLD",
    project: 'HUMAN INSTRUMENTALITY',
    angel: 'NO ANGEL DETECTED',
    magi: 'MAGI UNANIMOUS',
    field: 'A.T. FIELD',
    run: "MUSTN'T RUN AWAY",
};
const MOTTOS = {
    heaven: ['神ハ天ニ在リ', '世ハ全テ事モ無シ'],
    project: ['人類補完計画', '第3段階 進行中'],
    angel: ['使徒反応無シ', 'パターン青 未検出'],
    magi: ['MAGI 全会一致', '本日モ異常無シ'],
    field: ['A.T.フィールド', '全周展開中'],
    run: ['逃ゲチャダメダ', '逃ゲチャダメダ'],
};
const WORD_FADE_MS = 200;
const COLON_BREATH_MS = 4000;   // in and out
const COLON_LOW = 0.3;
const HEX_ALPHA = 0.065;        // the map-area ground's lines
// a MAGI vote, as colour roles and how much of a plate's inside it fills
const TONE = { ok: 'ok', wait: 'amber', no: 'no' };
const TONE_SOFT = { ok: 'okSoft', wait: 'waitSoft', no: 'noSoft' };
const PLATE_FILL = { ok: 0.09, wait: 0.1, no: 0.22 };
const VOTE = { ok: '承認', wait: '審議中', no: '否決' };
const LAMP_INK = [16, 8, 2, 255];
const COLON_STEPS = 20;         // of opacity: a send only when it reaches the next one, about 7 a second
const OPEN_AT_KMH = 110;        // the everyday corners are fully open from here
const BURN_FULL = 20;           // L/100km: the fuel use that fills design E1's bar and E2's rings
const RINGS = 7;                // design E2's, the same as its shader
const RINGS_HOT_FROM = 5;
const SHOWS_BURN = ['e1', 'e2', 'e3'];   // the dash's designs with the fuel use on them
// HUD Only's layout for each drive mode. Sport is the battle display; Comfort and Eco Pro are the everyday ones.
const HUD_ONLY = { sport: 'hud_only_sport', comfort: 'hud_only_comfort', eco: 'hud_only_eco' };
const RANGE_NONE = 4095;        // what the car sends with no range to give
const DEMO_RANGE = 412;
// The range may never be notified, so it is read every READ_MS, and holds until the reads stop: a parked car says
// nothing new for minutes, and the range doesn't change by the second.
const KOMBI = 'de.bmw.infotainment.KombiIF';
const READ_MS = 10000, READ_FRESH_MS = 60000;
const BURN_MIN_KMH = 5;                 // slower, L/100km says nothing
const BURN_MAX = 99.9;
const BURN_FRESH_MS = 5000;
const PSI_PER_BAR = 14.5038;
const HP_PER_KW = 1.34102;
const RUNNING_RPM = 500;
const CAR_ALIVE_MS = 3000;

const isNum = (v) => typeof v === 'number' && isFinite(v);
const rgb01 = (c) => [c[0] / 255, c[1] / 255, c[2] / 255];
const limit = (v) => { const n = Number(v); return v === 'off' || !isFinite(n) ? null : n; };

class EvaHud extends HudApp {
    constructor(ctx, view) {
        super(ctx, view);
        this.readings = {};              // knock, fuel, afr from the engine unit: { v, at }
        this.alerts = new AlertEngine({ thresholds: this._limits() });
        this.alertKey = null;            // what shows: an id of ALERTS, or null for the normal layout
        this.alertShow = null;           // eva_alerts.js's answer, for the {{a:...}} tokens
        this.alertLayout = null;
        this.alertLayers = null;         // the alert's three layers, made at the first one
        this.normalHidden = false;
        if (!(view && view.primary)) this._migrateMenu();
        this.popups = view && view.primary ? view.primary.popups : new PopupWatch({ log: this.log });
        this.givingWay = false;
        ctx.settings.onChange((key) => this._guard('setting ' + key, () => this._liveSetting(key)));
        if (!(view && view.primary)) {       // one screen's job: the HUD's
            this.menuShown = {};
            ctx.settings.onChange(() => this._guard('menu', () => this._updateMenu()));
            this._guard('menu', () => this._updateMenu());
        }
    }

    /* ---------------- settings ---------------- */

    /** The engine's own tokens (speed, temperatures) ask for this: an old settings file may still say 'us'. */
    setting(key) {
        if (key === 'units') return 'metric';
        if (key === 'clock') return '24h';
        if (key === 'byMode') return this._followsDriveMode();    // the engine's status line names the mode only then
        return super.setting(key);
    }

    _needsRebuild(key) {
        if (LAYOUT_SETTINGS.test(key)) return this._layoutName() !== this.activeName;
        return LIVE_SETTINGS.indexOf(key) < 0;
    }

    /** The drive mode whose choices apply: Comfort until the car has named one. */
    _driveProfile() { return DRIVE_PROFILES.indexOf(this.driveMode) >= 0 ? this.driveMode : 'comfort'; }

    /** The app's mode: off, hud, dash, both or grid. */
    _screens() { return this.setting('screens'); }

    /** What the Mode and the drive mode pick from the menu, for 'hud', 'dash', or with HUD + Dash 'bothHud' or 'bothDash'. */
    _picked(key) { return this.setting(key + PROFILE_KEY[this._driveProfile()]); }

    /** The dash's design now: a design, or off. */
    _dashDesign() { return this._picked(this._screens() === 'both' ? 'bothDash' : 'dash'); }

    _followsDriveMode() { const s = this._screens(); return s === 'hud' || s === 'both'; }

    _layoutName() {
        const s = this._screens();
        if (s === 'hud' || s === 'both') {
            const pick = this._picked(s === 'both' ? 'bothHud' : 'hud');
            return pick === 'eva' || pick === 'off' ? pick : HUD_ONLY[pick] || HUD_ONLY.comfort;
        }
        return s === 'grid' ? 'grid' : 'off';
    }

    /** Once, for settings from 0.5.0: it had one picture per Mode, or By drive mode. Its choices fill the rows that have one per drive mode. */
    _migrateMenu() {
        const st = this.ctx.settings, v = st.values;
        if (v._menuV === MENU_VERSION) return;
        const each = (key, value) => { if (value) DRIVE_PROFILES.forEach((m) => { v[key + PROFILE_KEY[m]] = value === 'follow' ? m : value; }); };
        each('hud', v.hudDesign);
        each('dash', v.dashDesign);
        each('bothHud', v.bothHud);
        each('bothDash', v.bothDash);
        if (v.screens === 'drive') {
            DRIVE_PROFILES.forEach((m) => {
                const mode = v[m + 'Screens'] || 'hud', dash = v[m + 'Dash'] || 'whole';
                v['bothHud' + PROFILE_KEY[m]] = mode === 'hud' ? m : mode === 'both' ? 'eva' : 'off';
                v['bothDash' + PROFILE_KEY[m]] = mode === 'dash' || mode === 'both' ? dash : 'off';
            });
            v.screens = 'both';
        }
        st.set('_menuV', MENU_VERSION);
    }

    /** Which rows of the menu show, by their names on the screen: app.json's "showWhen" lists settings that bring a row up, any one set of them is enough. */
    _menuRows() {
        const out = {}, get = (k) => this.ctx.settings.get(k);
        (this.ctx.spec.settings || []).filter((s) => s.showWhen).forEach((s) => {
            out['SET_' + s.key.toUpperCase()] = s.showWhen.some((w) => Object.keys(w).every((k) => get(k) === w[k]));
        });
        return out;
    }

    _updateMenu() {
        const rows = this._menuRows();
        Object.keys(rows).forEach((name) => {
            if (this.menuShown[name] === rows[name]) return;
            this.menuShown[name] = rows[name];
            this.ctx.ui.visible(name, rows[name]);
        });
    }

    _layoutLabel(name) { return name === 'grid' ? 'Calibration grid' : 'EVA'; }

    _isEva(name) { return !!name && name !== 'off' && name !== 'grid'; }

    /** Whether EVA shows on any screen: the alert rules and the engine unit serve them all. */
    _evaShowing() { return this._isEva(this.activeName) || !!(this.dash && this.dash._isEva(this.dash.activeName)); }

    _liveSetting(key) {
        if (key.indexOf('limit') === 0) this.alerts.setThresholds(this._limits());
        if (key === 'dismissAlert' && this.ctx.settings.get('dismissAlert') === true) {
            this.alerts.dismiss();
            this.log.info('alerts showing now hidden until they clear');
            setTimeout(() => this.ctx.settings.set('dismissAlert', false), 0);   // a button, not a switch
        }
    }

    _limits() {
        return {
            knock: limit(this.setting('limitKnock')), fuel: limit(this.setting('limitFuel')), heat: limit(this.setting('limitHeat')),
            boost: limit(this.setting('limitBoost')), afrLow: limit(this.setting('limitAfrLow')), afrHigh: limit(this.setting('limitAfrHigh')),
        };
    }

    /* ---------------- signals ---------------- */

    _moreSignals() {
        return {
            'de.bmw.powertrain.AcceleratorPedal': {
                AngleAcceleratorPedal: (v) => {
                    const pct = v && isNum(v.actualValueAngleAcceleratorPedal) ? v.actualValueAngleAcceleratorPedal * 0.025 : null;
                    if (pct !== null && pct >= -2 && pct <= 102) this.pedalNow = Math.max(0, Math.min(100, pct));
                },
            },
        };
    }

    /** The pedal in %. It is only notified on change, so a steady foot is still the last value while the car talks. */
    _pedal() {
        const d = this.car.data();
        if (d.demo) return isNum(d.throttle) ? d.throttle * 100 : null;
        return isNum(this.pedalNow) && Date.now() - this.car.lastCar < CAR_ALIVE_MS ? this.pedalNow : null;
    }

    start() {
        super.start();
        this._startReads();
    }

    _startReads() {
        Promise.resolve()
            .then(() => this.ctx.signals.watch(KOMBI, '1', { statusRangeTankStatus: (v) => this._onRange(v) }, this.log, { pollMs: READ_MS }))
            .catch((e) => this.log.info('KombiIF not read: ' + (e && e.message || e)));
    }

    _onRange(v) {
        const r = v && v.range;
        this.rangeNow = isNum(r) && r >= 0 && r < RANGE_NONE ? r : null;
        this.rangeAt = Date.now();
    }

    /** The range in km. */
    _range() {
        if (this.car.data().demo) return DEMO_RANGE;    // only ever under the demo setting
        return isNum(this.rangeNow) && Date.now() - this.rangeAt < READ_FRESH_MS ? this.rangeNow : null;
    }

    /** Replaces the engine's boost-only link: one read-only link for every channel. */
    _startDme() {
        const dme = this.config.dme;
        if (!dme) return;
        try {
            const { ReadOnlyDiag } = require('./kit/readonly-diag');
            const { DidReader } = require('./kit/dids');
            const link = new ReadOnlyDiag(this.ctx.signals, this.log);
            Promise.resolve().then(() => link.init()).catch((e) => this.log.info('engine unit link not available: ' + (e && e.message || e)));
            this.diag = new EvaDiag({
                reader: new DidReader(link, { ecu: dme.ecu || 18 }), config: dme,
                onReading: (name, v, at) => this._reading(name, v, at),
            });
        } catch (e) { this.log.info('engine unit readings off: ' + (e && e.message || e)); return; }
        let busy = false;
        this.dmeTimer = setInterval(() => this._guard('engine unit', () => {
            const want = busy ? null : this._wantDiag();
            if (!want) return;
            busy = true;
            this.diag.round(want).catch((e) => this.log.info('engine unit: ' + (e && e.message || e))).then(() => { busy = false; });
        }), 500);
    }

    _reading(name, v, at) {
        if (name === 'boost') { this.boostDme = v; this.boostDmeAt = at; } else this.readings[name] = { v, at };
    }

    /** Which channels to read this round, or null: nothing while the engine is off or the HUD isn't ours. */
    _wantDiag() {
        const d = this.car.data();
        if (d.demo || !this._evaShowing() || !isNum(d.rpm) || d.rpm < RUNNING_RPM) return null;
        const on = this.setting('alertsOn') !== false, t = this.alerts.thresholds;
        const want = {
            knock: on && t.knock !== null, fuel: on && t.fuel !== null, afr: on && (t.afrLow !== null || t.afrHigh !== null),
            boost: Date.now() - this.boostFesAt >= 3000,
            burn: (this.activeName === HUD_ONLY.eco || !!(this.dash && SHOWS_BURN.indexOf(this.dash.activeName) >= 0)) && !this._wordKey(),      // only on the move
        };
        return want.knock || want.fuel || want.afr || want.boost || want.burn ? want : null;
    }

    _boost() {
        const d = this.car.data();
        if (d.demo) return isNum(d.torque) && d.torque > 100 ? 0.4 + d.torque / 600 : 0.02;    // only ever under the demo setting
        return super._boost();
    }

    /* ---------------- the demo ---------------- */

    /** The demo setting runs EVA's own round, which shows all there is to see, rather than the kit's long drive. */
    _setupVehicleData() {
        super._setupVehicleData();
        this.car.sim = new EvaDemo();
        this.car.setRedline(this.setting('redline'));
        this.car.simData = this.car.sim.sample();
    }

    /* ---------------- tokens ---------------- */

    _gearState() {
        const d = this.car.data();
        if (d.stage === 'R' || d.gear === -1) return { kind: 'reverse', text: 'REVERSE' };
        if (d.stage === 'P' || d.stage === 'N' || !isNum(d.speed)) return { kind: 'standby', text: '出撃待命' };
        if (d.speed < 1 || !isNum(d.gear) || d.gear <= 0) return { kind: 'ready', text: '予備' };
        return { kind: 'digit', text: String(Math.min(9, d.gear)) };
    }

    /** The time here. The head unit's clock runs on UTC and nothing an app can read says its zone, so the owner picks it. */
    _now() {
        const off = this.setting('gmtOffset');
        if (off === 'unit') return super._now();
        const d = new Date(Date.now() + Number(off) * 3600000);
        return { getHours: () => d.getUTCHours(), getMinutes: () => d.getUTCMinutes() };
    }

    /** Which big word the everyday layouts show: P, R or N, and none in D, even stopped at a light. */
    _wordKey() {
        const d = this.car.data();
        if (d.stage === 'R' || d.gear === -1) return 'R';
        return d.stage === 'P' || d.stage === 'N' ? d.stage : null;
    }

    /** The fuel use in L/100km, or null where it says nothing: a crawl, P, R and N, or an old reading. */
    _burn() {
        const d = this.car.data();
        if (this._wordKey() || !isNum(d.speed) || d.speed < BURN_MIN_KMH) return null;
        let lph = null;
        if (d.demo) lph = isNum(d.throttle) ? 2 + d.throttle * 40 : null;      // only ever under the demo setting
        else {
            const r = this.readings.burn;
            if (r && Date.now() - r.at < BURN_FRESH_MS) lph = r.v;
        }
        return isNum(lph) ? Math.min(BURN_MAX, lph / d.speed * 100) : null;
    }

    /** A part's reason to go amber. */
    _warn(name) {
        return name === 'reverse' && this._wordKey() === 'R';
    }

    _statusLine() {
        const kind = this._gearState().kind;
        if (kind === 'standby') return 'SYSTEM STATUS: STANDBY // 待命状態';
        if (kind === 'reverse') return 'SYSTEM STATUS: CAUTION // 後退操作';
        if (this._shift().now) return 'SYSTEM STATUS: OVER REV // 回転数超過';
        const pedal = this._pedal();
        if (isNum(pedal) && pedal > 90) return 'SYSTEM STATUS: FULL THROTTLE // 全力全開';
        return 'SYSTEM STATUS: SYNCHRONIZATION ACTIVE // 同期中';
    }

    _alertValue() {
        const s = this.alertShow;
        if (!s) return '';
        if (s.kind === 'multi') return '×' + s.count;
        const v = s.value;
        switch (s.id) {
            case 'knock': return '-' + v.toFixed(1);
            case 'heat': return v.toFixed(0);
            case 'boost': return (v * PSI_PER_BAR).toFixed(1);
            case 'fuel': return (v * PSI_PER_BAR).toFixed(0);
            default: return v.toFixed(1);
        }
    }

    _token(tok) {
        if (tok.indexOf('mv:') === 0) {      // one character of the line, set vertically: its long vowel mark stands up, and a space takes no cell
            const [, row, i] = tok.split(':');
            const line = (MOTTOS[this.setting('motto')] || MOTTOS.heaven)[Number(row) - 1];
            return Array.from(line.replace(/ /g, '').replace(/ー/g, '｜'))[Number(i)] || '';
        }
        const a = this.alertKey ? ALERTS[this.alertKey] : null;
        switch (tok) {
            case 'statusline': return this._statusLine();
            case 'b:title': return this.setting('dashCenter') === 'time' ? '現在時刻' : '活動限界まで';
            case 'b:en': return this.setting('dashCenter') === 'time' ? 'LOCAL TIME' : 'ACTIVE RANGE REMAINING';
            case 'b:unit': return this.setting('dashCenter') === 'time' ? '' : 'KM';
            case 'b:power': return this._wordKey() === 'P' ? '外部電源' : '内部電源';
            case 'b:powersub': return this._wordKey() === 'P' ? 'EXTERNAL' : 'INTERNAL';
            case 'msub': { const k = this._wordKey(); return k ? WORDS[k].sub : MOTTO_EN[this.setting('motto')] || MOTTO_EN.heaven; }
            case 'gearshort': {
                const k = this._wordKey(), st = this._gearState();
                return k || (st.kind === 'digit' ? st.text : st.kind === 'ready' ? 'D' : '-');
            }
            case 'magi:word': return this._magi().word;
            case 'magi:sub': return this._magi().sub;
            case 'wordsub': { const k = this._wordKey(); return k ? WORDS[k].sub : ''; }
            case 'motto1': return (MOTTOS[this.setting('motto')] || MOTTOS.heaven)[0];
            case 'motto2': return (MOTTOS[this.setting('motto')] || MOTTOS.heaven)[1];
            case 'hh': return this._token('time').split(':')[0];
            case 'mm': return this._token('time').split(':')[1];
            case 'burn': { const b = this._burn(); return isNum(b) ? b.toFixed(1) : '--'; }
            case 'range': { const r = this._range(); return isNum(r) ? r.toFixed(0) : '--'; }
            case 'u:range': return 'KM';
            case 'gearcap': { const k = this._gearState().kind; return k === 'standby' ? 'STANDBY MODE' : k === 'reverse' ? 'REVERSE GEAR' : 'CURRENT GEAR'; }
            case 'gearcapjp': { const k = this._gearState().kind; return k === 'standby' ? '待命状態' : k === 'reverse' ? '後退操作' : '主変速器'; }
            case 'sync': { const r = this._raw('rpm'); return isNum(r) ? Math.min(99.9, 40 + r / 200).toFixed(1) : '--'; }
            case 'torque': { const t = this._raw('torque'); return isNum(t) ? t.toFixed(0) : '--'; }
            case 'u:torque': return 'NM';
            case 'boost': { const b = this._raw('boost'); return isNum(b) ? (b * PSI_PER_BAR).toFixed(1) : '--'; }
            case 'u:boost': return 'PSI';
            case 'power': {
                const t = this._raw('torque'), r = this._raw('rpm');
                if (!isNum(t) || !isNum(r)) return '--';
                return (t * r / 9549 * HP_PER_KW).toFixed(0);
            }
            case 'u:power': return 'HP';
            case 'pedal': { const p = this._pedal(); return isNum(p) ? p.toFixed(0) : '--'; }
            case 'a:tag': return this.alertShow && this.alertShow.preview ? 'PREVIEW' : 'MAGI SYSTEM WARNING';
            case 'a:en': return a ? a.en : '';
            case 'a:label': return a ? a.label : '';
            case 'a:status':
                if (!a) return '';
                return this.alertKey === 'multi' ? this.alertShow.ids.slice(0, 3).map((id) => ALERTS[id].jp).join(' / ') : a.status;
            case 'a:value': return this._alertValue();
            case 'a:unit': {        // sits low, beside the number
                const id = this.alertKey;
                return id === 'boost' || id === 'fuel' ? 'PSI' : '';
            }
            case 'a:deg': {         // sits high, as a degree sign does
                const id = this.alertKey;
                if (id === 'knock') return '°';
                return id === 'heat' ? '°C' : '';
            }
            case 'a:live': return super._token('speed') + ' ' + super._token('u:speed') + '   ' + super._token('gear') + '   ' + super._token('rpm') + ' RPM';
            default: return super._token(tok);
        }
    }

    /* ---------------- normal layers ---------------- */

    _create(w) {
        if (['evaseg', 'evaframe', 'evagear', 'evacanvas', 'evasolo', 'evacorners', 'evaword', 'evacolon', 'evahex', 'evahazard', 'evaseven', 'evarings'].indexOf(w.type) < 0) { super._create(w); return; }
        const base = Object.assign({ target: this.target, klass: w.class || 'content', z: w.z || 0, x: w.x, y: w.y, w: w.w, h: w.h }, this._layerFields());
        const image = ['evagear', 'evacanvas', 'evaword', 'evacolon'].indexOf(w.type) >= 0;
        if (w.type === 'evaword') Object.assign(base, { sx: w.sx, sy: w.sy, opacity: 0 });
        const ref = image ? this.client.image(Object.assign({ iw: w.w, ih: w.h }, base)) : this.client.effect(Object.assign({ fs: shaders[w.type] }, base));
        if (!ref) { this.log.warn('widget "' + w.id + '": layer refused'); return; }
        const x = { w, ref, last: null, lastPaint: 0, op: 0, fade: 0, fadeAt: 0 };
        this.widgets.set(w.id, x);
        const t = this.theme;
        if (w.type === 'evaseg') {
            this.client.uniform(ref, 'u_size', [w.w, w.h]);
            this.client.uniform(ref, 'u_segs', [w.segments || 28]);
            this.client.uniform(ref, 'u_low', rgb01(t.bar.low));
            this.client.uniform(ref, 'u_mid', rgb01(t.bar.mid));
            this.client.uniform(ref, 'u_high', rgb01(t.bar.high));
            this.client.uniform(ref, 'u_midAt', [t.bar.midAt]);
            this.client.uniform(ref, 'u_highAt', [0.85]);
            this.client.uniform(ref, 'u_off', [0.1]);
            this.client.uniform(ref, 'u_gap', [w.gap || 2]);
        } else if (w.type === 'evaframe') {
            this.client.uniform(ref, 'u_size', [w.w, w.h]);
            this.client.uniform(ref, 'u_color', rgb01(t.fg));
            this.client.uniform(ref, 'u_lineA', [0.42]);
            this.client.uniform(ref, 'u_cornerA', [0.9]);
            this.client.uniform(ref, 'u_inset', [w.inset || 4]);
            this.client.uniform(ref, 'u_corner', [w.corner || 18]);
            this.client.uniform(ref, 'u_weight', [w.weight || 1]);
            this.client.uniform(ref, 'u_lineW', [w.lineW || 2 * (w.weight || 1)]);
        } else if (w.type === 'evahex') {
            this.client.uniform(ref, 'u_size', [w.w, w.h]);
            this.client.uniform(ref, 'u_color', rgb01(t.fg));
            this.client.uniform(ref, 'u_cell', [w.r]);
            this.client.uniform(ref, 'u_alpha', [this.normalHidden ? 0 : this._hexAlpha(w)]);
        } else if (w.type === 'evahazard') {
            this.client.uniform(ref, 'u_size', [w.w, w.h]);
            this.client.uniform(ref, 'u_h', [w.stripe]);
            this.client.uniform(ref, 'u_alpha', [this.normalHidden ? 0 : 1]);
        } else if (w.type === 'evaseven') {
            this.client.uniform(ref, 'u_size', [w.w, w.h]);
            this.client.uniform(ref, 'u_color', rgb01(t.fg));
            this.client.uniform(ref, 'u_off', [0.07]);
            this.client.uniform(ref, 'u_margin', [w.margin]);
        } else if (w.type === 'evarings') {
            this.client.uniform(ref, 'u_size', [w.w, w.h]);
            this.client.uniform(ref, 'u_color', rgb01(t.fg));
            this.client.uniform(ref, 'u_hot', rgb01(t.amber));
            this.client.uniform(ref, 'u_hotFrom', [RINGS_HOT_FROM]);
            this.client.uniform(ref, 'u_r0', [w.r0]);
            this.client.uniform(ref, 'u_step', [w.step]);
        } else if (w.type === 'evasolo') {
            this.client.uniform(ref, 'u_size', [w.w, w.h]);
            this.client.uniform(ref, 'u_color', rgb01(t.fg));
            this.client.uniform(ref, 'u_bar', w.bar);
        } else if (w.type === 'evacorners') {
            this.client.uniform(ref, 'u_size', [w.w, w.h]);
            this.client.uniform(ref, 'u_color', rgb01(t.fg));
            this.client.uniform(ref, 'u_alpha', [0.75]);
            this.client.uniform(ref, 'u_arm', [w.arm]);
            this.client.uniform(ref, 'u_weight', [w.weight]);
            this.client.uniform(ref, 'u_lowerLeft', [w.lowerLeft]);
        } else if (w.type === 'evacanvas') {
            x.canvas = this._textCanvas(w.parts);
        } else if (w.type === 'evacolon') {
            this.client.pixels(ref, null, textRaster.drawText(w.w, w.h, ':', { font: w.font, color: color(t, 'fg'), glow: t.glow, x: w.pad, offsetY: w.offsetY }));
        }
        this._update(x, Date.now(), true);
    }

    _update(x, now, force) {
        const type = x.w.type;
        if (type === 'evaseg') this._updateSeg(x, now, force);
        else if (type === 'evagear') this._updateGear(x, now);
        else if (type === 'evacanvas') this._updateCanvas(x, now, force);
        else if (type === 'evasolo') this._updateSolo(x, force);
        else if (type === 'evacorners') this._updateCorners(x, force);
        else if (type === 'evaword') this._updateWord(x, now, force);
        else if (type === 'evacolon') this._updateColon(x, now);
        else if (type === 'evaseven') this._updateSeven(x, now, force);
        else if (type === 'evahazard') this._updateHazard(x, force);
        else if (type === 'evarings') this._updateRings(x, force);
        else if (type !== 'evaframe' && type !== 'evahex') super._update(x, now, force);
    }

    /** Design B's middle: the range with its tenths, or the time with its colon beating. Blank digits show only their dim segments. */
    _updateSeven(x, now, force) {
        const clock = !x.w.rangeOnly && this.setting('dashCenter') === 'time';
        let digits, on;
        if (clock) {
            digits = this._token('time').replace(':', '').split('').map(Number);
            on = Math.floor(now / 1000) % 2 === 0 ? 1 : 0;
        } else {
            const r = this._range(), n = isNum(r) ? String(Math.min(999, Math.max(0, Math.round(r)))) : null;
            digits = n ? [n.length > 2 ? Number(n[n.length - 3]) : -1, n.length > 1 ? Number(n[n.length - 2]) : -1, Number(n[n.length - 1]), 0] : [-1, -1, -1, -1];
            on = n ? 1 : 0;
        }
        const key = digits.join() + '|' + on + '|' + clock;
        if (!force && key === x.last) return;
        x.last = key;
        this.client.uniform(x.ref, 'u_digits', digits);
        this.client.uniform(x.ref, 'u_sepAfter', [clock ? 1 : 2]);
        this.client.uniform(x.ref, 'u_colon', [clock ? 1 : 0]);
        this.client.uniform(x.ref, 'u_sepOn', [on]);
    }

    /** Design B's stripes: its colour, or MAGI's red while it rejects a temperature. */
    _updateHazard(x, force) {
        const m = this._magi(), hot = m.melchior === 'no' || m.balthasar === 'no';
        if (!force && hot === x.last) return;
        x.last = hot;
        this.client.uniform(x.ref, 'u_stripe', rgb01(this.theme[hot ? 'no' : 'fg']));
    }

    /** Design E2's rings: how many are lit, out of RINGS. None with no fuel use to show. */
    _updateRings(x, force) {
        const b = this._burn(), lit = isNum(b) ? Math.max(1, Math.ceil(Math.min(1, b / BURN_FULL) * RINGS)) : 0;
        if (!force && lit === x.last) return;
        x.last = lit;
        this.client.uniform(x.ref, 'u_lit', [lit]);
    }

    _updateSolo(x, force) {
        const pedal = this._pedal();
        const p = isNum(pedal) ? Math.max(0, Math.min(1, Math.round(pedal / 2) / 50)) : 0;
        if (!force && p === x.last) return;
        x.last = p;
        this.client.uniform(x.ref, 'u_pedal', [p]);
    }

    /** Drawn in at a standstill, fully open at speed: a pixel at a time, so it is sent a few times a drive. */
    _updateCorners(x, force) {
        const speed = this._raw('speed');
        const ins = Math.round(x.w.open * (1 - Math.min(1, isNum(speed) ? Math.max(0, speed) / OPEN_AT_KMH : 0)));
        if (!force && ins === x.last) return;
        x.last = ins;
        this.client.uniform(x.ref, 'u_ins', [ins]);
    }

    /** The clock's colon breathing: bright at the top of each breath, and only the layer's opacity goes up. */
    _updateColon(x, now) {
        const breath = 0.5 + 0.5 * Math.cos(2 * Math.PI * now / COLON_BREATH_MS);
        const op = Math.round((COLON_LOW + (1 - COLON_LOW) * breath) * COLON_STEPS) / COLON_STEPS;
        if (op === x.op) return;
        x.op = op;
        this.client.set(x.ref, { opacity: op });
    }

    /** The big word: one upload per word, then only the layer's opacity. A different word waits for the old one to fade out. */
    _updateWord(x, now, force) {
        const want = this._wordKey();
        const target = want && (x.word === want || force) ? 1 : 0;
        const step = (now - x.fadeAt) / WORD_FADE_MS;
        x.fadeAt = now;
        x.fade = force ? target : x.fade < target ? Math.min(target, x.fade + step) : Math.max(target, x.fade - step);
        if (want && x.word !== want && (force || x.fade === 0)) {
            x.word = want;
            this.client.pixels(x.ref, null, this._paintWord(x.w, want));
        }
        const op = Math.round(x.fade * 10) / 10;
        if (op !== x.op || force) {
            x.op = op;
            this.client.set(x.ref, { opacity: op, visible: op > 0 ? 1 : 0 });   // at opacity 0 a shown layer is still drawn
        }
    }

    _paintWord(w, key) {
        const m = textRaster.mask(w.w, w.h, WORDS[key].text, { font: w.font, align: 'right', x: -w.pad, offsetY: w.pad });
        return textRaster.tint(m, w.w, w.h, { color: color(this.theme, key === 'R' ? 'amber' : 'fg'), glow: this.theme.glow, font: w.font });
    }

    _updateSeg(x, now, force) {
        if (x.w.source === 'burn') { this._updateBurnBar(x, force); return; }
        const rpm = this._raw('rpm'), segs = x.w.segments || 28;
        const v = isNum(rpm) ? Math.min(1, Math.max(0, rpm / this._barMax())) : 0;
        const q = Math.round(v * segs * 2) / (segs * 2);
        const strobe = this._shift().now && Math.floor(now / 200) % 2 === 0;    // 2.5 flashes a second
        const key = q + (strobe ? 's' : '');
        if (!force && key === x.last) return;
        x.last = key;
        this.client.uniform(x.ref, 'u_value', [q]);
        this.client.uniform(x.ref, 'u_strobe', [strobe ? 1 : 0]);
    }

    /** Design E1's bar: the fuel use, in whole segments. */
    _updateBurnBar(x, force) {
        const b = this._burn(), segs = x.w.segments || 28;
        const q = isNum(b) ? Math.round(Math.min(1, b / BURN_FULL) * segs) / segs : 0;
        if (!force && q === x.last) return;
        x.last = q;
        this.client.uniform(x.ref, 'u_value', [q]);
        this.client.uniform(x.ref, 'u_strobe', [0]);
    }

    /** What the gear's layer shows. A layout with "words" has the owner's words in P, R and N, the same as the HUD's big word. */
    _gearFor(w) {
        const k = w.words ? this._wordKey() : null;
        return k ? { kind: 'word', key: k, text: WORDS[k].text } : this._gearState();
    }

    _updateGear(x, now) {
        const st = this._gearFor(x.w);
        const hot = st.kind === 'reverse' || (st.kind === 'digit' && this._shift().now);
        const key = st.kind + st.text + (hot ? 'h' : '');
        if (key !== x.last) {
            if (x.lastText !== undefined && st.kind === 'digit' && x.lastText !== st.text) x.popAt = now;
            x.lastText = st.text;
            x.last = key;
            const px = this._paintGear(x.w, st, hot);
            const c = x.px ? changes(x.px, px, x.w.w, x.w.h) : { rect: null, px };
            x.px = px;
            if (c) this.client.pixels(x.ref, c.rect && [c.rect], c.px);
        }
        // slow breathing in park and reverse, a faster blink at the shift point: no pixels, only the layer's opacity
        let op = 1;
        if (st.kind === 'standby' || st.kind === 'reverse') op = Math.floor(now / 400) % 2 === 0 ? 0.95 : 0.55;
        else if (hot) op = Math.floor(now / 200) % 2 === 0 ? 1 : 0.6;
        const e = x.popAt ? now - x.popAt : Infinity;
        const scale = e < 300 ? Math.round((1 + 0.12 * Math.exp(-e / 90) * Math.cos(e / 38)) * 100) / 100 : 1;
        if (op !== x.op || scale !== x.scale) {
            x.op = op; x.scale = scale;
            this.client.set(x.ref, { opacity: op, sx: scale, sy: scale });
        }
    }

    _paintGear(w, st, hot) {
        const W = w.w, H = w.h, t = this.theme;
        const line = (text, font, cy) => textRaster.mask(W, H, text, { font, align: 'center', offsetY: Math.round(cy - textRaster.loadFont(font).metrics.cellHeight / 2) });
        const pre = w.fontPrefix || '';
        const fonts = { digit: pre + 'gear', ready: pre + 'gearjp', reverse: pre + 'gearrev' };
        let m, font;
        if (st.kind === 'standby' || st.kind === 'word') {
            font = pre + 'gearjp';
            const half = w.wordPitch ? w.wordPitch / 2 : textRaster.loadFont(font).metrics.cellHeight / 2 + 2;
            const rows = st.kind === 'word' ? st.text : '出撃待命';
            m = line(rows.slice(0, 2), font, H / 2 - half);
            const b = line(rows.slice(2), font, H / 2 + half);
            for (let i = 0; i < m.length; i++) if (b[i] > m[i]) m[i] = b[i];
        } else {
            font = fonts[st.kind];
            m = line(st.text, font, H / 2);
        }
        const c = st.kind === 'word' && st.key === 'R' ? t.amber : hot ? t.hot : t.fg;
        return textRaster.tint(m, W, H, { color: c, glow: t.glow, font });
    }

    /* ---------------- the text canvas ---------------- */

    _textCanvas(parts) {
        return new TextCanvas(parts, {
            key: (p, now) => this._partLook(p, now),
            paint: (p, look) => this._partPixels(p, look),
            onError: (p, e) => this.log.warn('part ' + p.id + ': ' + (e && e.message || e)),
            rateMs: this.view.textRateMs,
        });
    }

    _updateCanvas(x, now, force) {
        x.canvas.updates(now, force).forEach((u) => this.client.pixels(x.ref, [u.rect], u.px));
    }

    /** What a part should look like now, as a string: the same string is not painted again. */
    _partLook(p, now) {
        if (p.type === 'magi') return this._magiOk(p.source, now) ? 'on' : 'off';
        if (p.type === 'plate') return 'plate|' + this._magi()[p.magi];
        if (p.type === 'wires') return color(this.theme, p.color).join();
        if (p.type === 'lamp') return 'lamp|' + (this._lampOn(p) ? 'on' : 'off') + (p.when === 'always' ? '|' + this._resolve(p.top) + (p.sub ? '|' + this._resolve(p.sub) : '') : '');
        if (p.type === 'logo') {
            if (p.flicker && !p.flickerNow) p.flickerNow = new Flicker(p.flicker);
            return color(this.theme, p.flickerNow && p.flickerNow.on(now) ? p.flicker.color : p.color).join();
        }
        let role = p.color || 'fg';
        if (p.hotWhen && this._shift()[p.hotWhen]) role = 'hot';
        if (p.warnWhen && this._warn(p.warnWhen)) role = 'amber';
        if (p.magiTone) role = (p.magiTone === 'soft' ? TONE_SOFT : TONE)[this._magi().tone];
        if (p.magiHot && this._magi()[p.magiHot] === 'no') role = 'no';
        const c = color(this.theme, role).join();
        if (p.type === 'rule') return c;
        const hidden = (p.driving && this._wordKey()) || (p.parked && !this._wordKey());     // these give way to, or come with, the big word
        return c + '|' + (hidden ? '' : this._resolve(p.text));
    }

    _partPixels(p, look) {
        if (p.type === 'magi') return this._paintMagi(p, look === 'on');
        if (p.type === 'plate') return this._paintPlate(p, look.split('|')[1]);
        if (p.type === 'wires') return this._paintWires(p, look.split(',').map(Number));
        if (p.type === 'lamp') return this._paintLamp(p, look.split('|')[1] === 'on');
        if (p.type === 'logo') return this._paintLogo(p, look.split(',').map(Number));
        const cut = look.indexOf('|');
        const c = (cut < 0 ? look : look.slice(0, cut)).split(',').map(Number);
        if (p.type === 'rule') {
            const buf = Buffer.alloc(p.w * p.h * 4);
            for (let o = 0; o < buf.length; o += 4) { buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = c[3]; }
            return buf;
        }
        const by = p.byMotto && (p.byMotto[this.setting('motto')] || p.byMotto.heaven);     // a line sized to fill its row
        return textRaster.drawText(p.w, p.h, look.slice(cut + 1), {
            font: by ? by.font : p.font, color: c, align: p.align, spacing: p.spacing, glow: p.glow ? this.theme.glow : 0, x: p.textX, offsetY: by ? by.offsetY : p.offsetY,
        });
    }

    /** A one-colour picture: hud/logos/<name>.json holds its alpha, at exactly the part's size. */
    _paintLogo(p, c) {
        const m = hudData.json(p.src);
        const a = Buffer.from(m.alpha || '', 'base64');
        if (m.w !== p.w || m.h !== p.h || a.length !== p.w * p.h) throw new Error(p.src + ' is not ' + p.w + 'x' + p.h);
        const buf = Buffer.alloc(a.length * 4);
        for (let i = 0; i < a.length; i++) {
            const o = i * 4;
            buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = Math.round(a[i] * c[3] / 255);
        }
        return buf;
    }

    _magiOk(source, now) {
        if (source === 'render') return this.client.ready && !this.refused;
        const d = this.car.data();
        if (d.demo) return true;
        if (source === 'car') return now - this.car.lastCar < CAR_ALIVE_MS;
        const fresh = Object.keys(this.readings).some((k) => now - this.readings[k].at < 5000);
        return fresh || !!(this.diag && this.diag.linkOk());
    }

    /** A framed marker, bright while its source is healthy. All one layer, so dimming means new pixels. */
    _paintMagi(p, on) {
        const W = p.w, H = p.h, c = this.theme.fg, dim = on ? 1 : 0.22;
        const cell = textRaster.loadFont(p.font).metrics.cellHeight;
        const buf = textRaster.drawText(W, H, p.text, { font: p.font, color: c, align: 'center', offsetY: Math.round((H - cell) / 2) });
        for (let y = 0; y < H; y++) {
            for (let px = 0; px < W; px++) {
                const o = (y * W + px) * 4;
                if (y < 2 || y >= H - 2 || px < 2 || px >= W - 2) { buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = 150; }
                buf[o + 3] = Math.round(buf[o + 3] * dim);
            }
        }
        return buf;
    }

    /** MAGI's sortie check on the dash's design A: see eva_magi.js. */
    _magi() {
        const d = this.car.data();
        return judge({ oil: d.oil, water: d.coolant, driving: !this._wordKey() && this._gearState().kind !== 'standby', overRev: this._shift().now });
    }

    /** A shape with cut corners, in the colour c: a 2 px border, and inside it that colour at the alpha "fill". */
    _cutCorners(p, c, fill) {
        const W = p.w, H = p.h, cut = p.corner, r2 = Math.SQRT1_2, buf = Buffer.alloc(W * H * 4);
        for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
                const l = x + 0.5, r = W - x - 0.5, u = y + 0.5, b = H - y - 0.5;
                const edge = Math.min(l, r, u, b, (l + u - cut) * r2, (r + u - cut) * r2, (l + b - cut) * r2, (r + b - cut) * r2);
                if (edge <= 0) continue;
                const o = (y * W + x) * 4, a = (edge < 2 ? 1 : fill) * Math.min(1, edge);
                buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = Math.round(a * 255);
            }
        }
        return buf;
    }

    /** A text over what's there in buf, centred across the part. */
    _inkOver(buf, p, text, c, font, offsetY) {
        const m = textRaster.mask(p.w, p.h, text, { font, align: 'center', offsetY });
        for (let i = 0; i < m.length; i++) {
            if (!m[i]) continue;
            const o = i * 4, sa = m[i] / 255, da = buf[o + 3] / 255, oa = sa + da * (1 - sa);
            for (let k = 0; k < 3; k++) buf[o + k] = Math.round((c[k] * sa + buf[o + k] * da * (1 - sa)) / oa);
            buf[o + 3] = Math.round(oa * 255);
        }
    }

    /** One vote: a plate with cut corners, its name, its vote and what it watches. */
    _paintPlate(p, state) {
        const t = this.theme, c = t[TONE[state]], voteFont = state === 'wait' ? 'wait' : 'ok';
        const buf = this._cutCorners(p, c, PLATE_FILL[state]);
        this._inkOver(buf, p, p.name, c, p.fonts.name, p.offsets.name);
        this._inkOver(buf, p, VOTE[state], c, p.fonts[voteFont], p.offsets[voteFont]);
        this._inkOver(buf, p, p.watch, t[TONE_SOFT[state]], p.fonts.watch, p.offsets.watch);
        return buf;
    }

    /** Design B's lamps: the car on external power in P, internal otherwise, and the drive mode. */
    _lampOn(p) {
        if (p.when === 'always') return true;
        if (p.when === 'parked') return this._wordKey() === 'P';
        if (p.when === 'moving') return this._wordKey() !== 'P';
        return this.driveMode === p.when;
    }

    /** A lamp: filled with dark text while it is on, only a faint outline while it is off. */
    _paintLamp(p, on) {
        const t = this.theme, ink = on ? LAMP_INK : t.wire;
        const buf = this._cutCorners(p, on ? t[p.tone] : t.faint, on ? 1 : 0);
        this._inkOver(buf, p, this._resolve(p.top), ink, p.fonts.top, p.offsets.top);
        if (p.sub) this._inkOver(buf, p, this._resolve(p.sub), ink, p.fonts.sub, p.offsets.sub);
        return buf;
    }

    /** Thin lines between the plates. Their coordinates may run off the part: only what's inside it is drawn. */
    _paintWires(p, c) {
        const buf = Buffer.alloc(p.w * p.h * 4);
        for (let y = 0; y < p.h; y++) {
            for (let x = 0; x < p.w; x++) {
                let near = Infinity;
                p.lines.forEach((l) => {
                    const dx = l[2] - l[0], dy = l[3] - l[1], u = Math.max(0, Math.min(1, ((x + 0.5 - l[0]) * dx + (y + 0.5 - l[1]) * dy) / (dx * dx + dy * dy)));
                    near = Math.min(near, Math.hypot(x + 0.5 - l[0] - u * dx, y + 0.5 - l[1] - u * dy));
                });
                if (near >= 1.5) continue;
                const o = (y * p.w + x) * 4;
                buf[o] = c[0]; buf[o + 1] = c[1]; buf[o + 2] = c[2]; buf[o + 3] = Math.round(Math.min(1, 1.5 - near) * c[3]);
            }
        }
        return buf;
    }

    /* ---------------- alerts ---------------- */

    /** The alert the demo's round has reached, as the rules would show it: only ever under the demo setting. */
    _demoAlert(now) {
        const id = this.car.sim.alertAt(now);
        if (!id) return null;
        if (id === 'multi') return { kind: 'multi', ids: ['knock', 'heat', 'fuel'], count: 3 };
        return { kind: 'single', id, value: ALERTS[id].preview };
    }

    /** What should show now: a preview while parked, else what the rules say. */
    _alertNow(now) {
        if (!this._evaShowing()) return null;
        const d = this.car.data(), preview = this.setting('alertPreview');
        if (preview !== 'off' && (d.demo || !isNum(d.speed) || d.speed < 1)) {
            if (preview === 'multi') return { kind: 'multi', ids: ['knock', 'heat', 'fuel'], count: 3, preview: true };
            return { kind: 'single', id: preview, value: ALERTS[preview].preview, preview: true };
        }
        if (this.setting('alertsOn') === false) return null;
        if (d.demo) return this._demoAlert(now);
        const values = { knock: this.readings.knock, fuel: this.readings.fuel, afr: this.readings.afr };
        if (isNum(d.coolant)) values.heat = { v: d.coolant, at: this.car.lastCar };
        const boost = this._boost();
        if (isNum(boost)) values.boost = { v: boost, at: now };
        return this.alerts.update(now, { rpm: d.rpm, pedal: this._pedal(), values });
    }

    _hexAlpha(w) { return w.lines === 0 ? 0 : HEX_ALPHA; }

    _setNormalVisible(on) {
        if (this.normalHidden === !on) return;
        this.normalHidden = !on;
        this.widgets.forEach((x) => {
            if (!x.w.keepInAlert) this.client.set(x.ref, { visible: on ? 1 : 0 });
            if (x.w.type === 'evahex') this.client.uniform(x.ref, 'u_alpha', [on ? this._hexAlpha(x.w) : 0]);     // an alert's ground is plain black
            if (x.w.type === 'evahazard') this.client.uniform(x.ref, 'u_alpha', [on ? 1 : 0]);
        });
    }

    /** The alert layout with this alert's rows, or null: a bad file must not leave the HUD blank. */
    _alertLayoutFor(key) {
        if (!key || this.alertBroken) return null;
        try {
            const layout = this.alertLayout || this.layouts.load(this._layoutFile('alert'));
            if (!layout.title) throw new Error('layout "alert" has no title');
            if (!layout.rows || !Array.isArray(layout.rows[key])) throw new Error('layout "alert" has no rows for ' + key);
            this.alertLayout = layout;
            return layout;
        } catch (e) {
            this.alertBroken = e.message;     // until the next rebuild, which a fixed file causes
            this.log.warn('alerts off: ' + e.message);
            this._statusSoon();
            return null;
        }
    }

    /** Three layers, made at the first alert and kept hidden after it: the text, and the title in colour and white. */
    _makeAlertLayers() {
        const L = this.alertLayout, t = L.title, w = L.widgets[0];
        const base = (r) => Object.assign({ target: this.target, klass: 'alert', x: r.x, y: r.y, w: r.w, h: r.h, iw: r.w, ih: r.h }, this._layerFields());
        this.alertLayers = {
            canvas: { w, ref: this.client.image(Object.assign({ z: 7 }, base(w))), canvas: this._textCanvas(w.parts) },
            colour: this.client.image(Object.assign({ z: 5 }, base(t))),
            white: this.client.image(Object.assign({ z: 6, opacity: 0 }, base(t))),
            op: null,
        };
    }

    /** The title's pixels go up again at each change of alert: at most every 2 s, about 1 MB. */
    _paintTitle(key) {
        const L = this.alertLayout, t = L.title, rows = L.rows[key];
        const m = Buffer.alloc(t.w * t.h, 0);
        rows.forEach((r) => {
            const one = textRaster.mask(t.w, t.h, r.text, { font: r.font, x: t.pad, offsetY: r.y });
            for (let i = 0; i < m.length; i++) if (one[i] > m[i]) m[i] = one[i];
        });
        const font = rows[rows.length - 1].font;
        this.client.pixels(this.alertLayers.colour, null, textRaster.tint(m, t.w, t.h, { color: ALERTS[key].rgb.concat(255), glow: 0.8, font }));
        this.client.pixels(this.alertLayers.white, null, textRaster.tint(m, t.w, t.h, { color: [255, 255, 255, 255], font }));
    }

    _showAlert(key, now) {
        this.alertKey = key;
        this._statusSoon();
        const a = this.alertLayers;
        if (!key) {
            if (a) [a.canvas.ref, a.colour, a.white].forEach((ref) => this.client.set(ref, { visible: 0 }));
            this._setNormalVisible(true);
            this.widgets.forEach((x) => this._guard('widget ' + x.w.id, () => this._update(x, now, true)));
            return;
        }
        this._setNormalVisible(false);
        this.theme.alert = ALERTS[key].rgb.concat(255);
        if (!a) this._makeAlertLayers();
        const l = this.alertLayers;
        this._paintTitle(key);
        this._updateCanvas(l.canvas, now, true);
        [l.canvas.ref, l.colour, l.white].forEach((ref) => this.client.set(ref, { visible: 1 }));
        l.op = null;
        this.log.info('alert: ' + ALERTS[key].en + (this.alertShow.preview ? ' (preview)' : ''));
    }

    /** 1.25 times a second, colour to white and back, in 0.1 steps. */
    _flashAlert(now) {
        const s = Math.sin(now / 1000 * 2 * Math.PI * 1.25), e = Math.max(0, Math.min(1, (s + 0.25) / 0.5));
        const op = Math.round(e * e * (3 - 2 * e) * 10) / 10, l = this.alertLayers;
        if (l.op === op) return;
        l.op = op;
        this.client.set(l.white, { opacity: op });
    }

    /** Fields every layer of this screen asks for, on top of the usual ones. */
    _layerFields() { return {}; }

    /* ---------------- BMW's pop-ups ---------------- */

    _popupSlot() { return POPUP_SLOT_HUD; }

    /** Whether this screen hides for a pop-up now. Its layers stay as they are, ready to come straight back. */
    _yieldToPopup(now) {
        this.popups.poll(now);
        const way = !!this.activeName && this.activeName !== 'off' && this.popups.shown(this._popupSlot(), now);
        if (way !== this.givingWay) {
            this.givingWay = way;
            this._showForPopup(way, now);
            this.log.info(way ? 'giving way to a BMW pop-up' : 'the BMW pop-up has gone');
            this._statusSoon();
        }
        return way;
    }

    _showForPopup(hide, now) {
        this.widgets.forEach((x) => this.client.set(x.ref, { visible: hide || (this.normalHidden && !x.w.keepInAlert) ? 0 : 1 }));
        const a = this.alertLayers;
        if (a) [a.canvas.ref, a.colour, a.white].forEach((ref) => this.client.set(ref, { visible: !hide && this.alertKey ? 1 : 0 }));
        if (!hide) this.widgets.forEach((x) => this._guard('widget ' + x.w.id, () => this._update(x, now, true)));
    }

    /* ---------------- the tick and the status line ---------------- */

    _tick() {
        const now = Date.now();
        this._smoothRpm(now);
        if (!this.client.ready) return;
        this.alertShow = this._alertNow(now);
        if (this._yieldToPopup(now)) return;
        const s = this._isEva(this.activeName) ? this.alertShow : null;
        let key = s ? (s.kind === 'multi' ? 'multi' : s.id) : null;
        if (key && !this._alertLayoutFor(key)) key = null;
        if (key !== this.alertKey) this._showAlert(key, now);
        if (key) {
            this._flashAlert(now);
            this._updateCanvas(this.alertLayers.canvas, now, false);
            return;
        }
        this.widgets.forEach((x) => this._guard('widget ' + x.w.id, () => this._update(x, now, false)));
    }

    _rebuildInner() {
        const a = this.alertLayers;
        if (this.client.ready && a) [a.canvas.ref, a.colour, a.white].forEach((ref) => this.client.drop(ref));
        this.alertLayers = null; this.alertLayout = null; this.alertKey = null; this.normalHidden = false; this.alertBroken = null;
        this.givingWay = false;      // the new layers show until the next tick hides them, if the pop-up is still up
        super._rebuildInner();
    }

    /** While an alert shows, the normal layers are hidden on purpose: not worth a note. */
    _drawnNote() { return this.alertKey || this.givingWay ? '' : super._drawnNote(); }

    statusText() {
        let s = super.statusText();
        if (this.alertKey && ALERTS[this.alertKey]) s += ', ALERT ' + ALERTS[this.alertKey].en;
        if (this.givingWay) s += ', giving way to a BMW pop-up';
        const no = this.diag && this._isEva(this.activeName) ? this.diag.unavailable() : [];
        if (no.length) s += ', no reading from this car: ' + no.join(', ');
        if (this.alertBroken) s += ', alerts off: ' + this.alertBroken;
        return s;
    }
}

module.exports = EvaHud;
