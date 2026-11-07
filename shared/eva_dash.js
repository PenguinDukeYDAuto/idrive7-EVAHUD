'use strict';
/**
 * The EVA dash: the design of the EVA HUD on the instrument cluster, at the same time as the HUD and from the same app.
 *
 * It is an EvaHud with a connection of its own (cluster-render allows a client 8 layers: 5 normal, 3 in an alert) and
 * its own layouts, hud/layouts/dash_eva.json and dash_alert.json. The car data, the engine unit and the alert rules
 * stay with the HUD, so both screens read the same values and show the same alert. The app's hud.dash points back here.
 *
 * Needs cluster-render's panel target on a scene of its own (panel_scene_id in its local conf): with the default, the
 * shared scene means the HUD and the cluster can't show together, and on this car the HUD can't come back afterwards.
 *
 * The black background (hud/layouts/dash_eva.json, "keepInAlert") hides BMW's gauges and stays through an alert. It stops
 * at y=640, so BMW's own bottom row shows; BMW's seat belt warning and gear also show above it (seen on the car). *
 * The service counts every image twice against 16 MiB (Compositor::add_image, "the service's pixel memory is full"). The
 * dash's big images don't all fit, so it holds either its normal images or its alert's: an alert drops the gear and the
 * text and the alert's end brings them back. The car found this; the HUD's images are small enough to keep.
 *
 * The menu picks a design. The centre designs (A, B, C1, C2, E1, E2) draw on cluster-render's map target, the 1088x480 window under
 * BMW's gauges, so everything of BMW's stays on top and works: the panel over the gauges took BMW's own content away (its on-board
 * computer area, seen on the car). They keep to the shape BMW's digital speed and G meter leave clear (tools/eva_layout.py CLEAR_SHAPE),
 * small enough to keep their images through an alert, so an alert's end sends nothing, and they have a slot of their own, so a BMW
 * pop-up draws over them and they never have to give way.
 * D, C3 and E3, like the original, cover the whole cluster on the panel, with the same alert and the same care for memory and pop-ups.
 *   contend:    takes the slot from BMW's map in Map view (Off leaves the slot free).
 *   guide_hold: 0 keeps cluster-render from holding a second slot to hide BMW's CarPlay turn box. It shows over us.
 */
const EvaHud = require('./eva_hud');

const POPUP_SLOT = 0x202;
const CENTRE_DESIGNS = ['a', 'b', 'c1', 'c2', 'e1', 'e2'];
const WHOLE_DESIGNS = ['d', 'c3', 'e3'];     // besides the original, 'eva'
const TEXT_MS = 250;     // its text rectangles are about four times the HUD's, and share one upload budget with it

class EvaDash extends EvaHud {
    constructor(ctx, primary) {
        super(ctx, { primary, target: 'panel', statusName: 'DASH', clientName: ctx.spec.id + '_dash', textRateMs: TEXT_MS });
        this.primary = primary;
        this.readings = primary.readings;
    }

    _layoutName() {
        const s = this._screens();
        if (s !== 'dash' && s !== 'both') return 'off';
        const design = this._dashDesign();
        if (design === 'off') return 'off';
        return CENTRE_DESIGNS.indexOf(design) >= 0 || WHOLE_DESIGNS.indexOf(design) >= 0 ? design : 'eva';
    }
    _layoutFile(name) {
        if (name === 'off') return name;
        return name === 'alert' && this._isCentre() ? 'dash_centre_alert' : 'dash_' + name;
    }
    _layoutLabel(name) { return name === 'eva' ? 'EVA' : 'Design ' + name.toUpperCase(); }
    _isCentre() { return CENTRE_DESIGNS.indexOf(this._layoutName()) >= 0; }
    _followsDriveMode() { const s = this._screens(); return s === 'dash' || s === 'both'; }
    _layerFields() { return this.target === 'map' ? { contend: 1, guide_hold: 0 } : {}; }
    _popupSlot() { return POPUP_SLOT; }

    /* what the HUD owns */
    _setupVehicleData() {
        this.car = this.view.primary.car;
        this.score = this.view.primary.score;
    }
    _startDme() {}
    _startReads() {}
    _liveSetting() {}
    _pedal() { return this.primary._pedal(); }
    _boost() { return this.primary._boost(); }
    _range() { return this.primary._range(); }
    _alertNow() { return this.primary.alertShow; }

    _isBigImage(w) { return w.type === 'evagear' || w.type === 'evacanvas'; }

    _yieldToPopup(now) { return this.target === 'map' ? false : super._yieldToPopup(now); }

    _showAlert(key, now) {
        if (this._isCentre()) { super._showAlert(key, now); return; }
        if (key && !this.alertLayers) {
            this.freedWidgets = [];
            this.widgets.forEach((x, id) => {
                if (!this._isBigImage(x.w)) return;
                this.client.drop(x.ref);
                this.layerStates.delete(x.ref);
                this.widgets.delete(id);
                this.freedWidgets.push(x.w);
            });
        } else if (!key && this.alertLayers) {
            const a = this.alertLayers;
            [a.canvas.ref, a.colour, a.white].forEach((ref) => this.client.drop(ref));
            this.alertLayers = null;
            (this.freedWidgets || []).forEach((w) => this._guard('widget ' + w.id, () => this._create(w)));
            this.freedWidgets = [];
        }
        super._showAlert(key, now);
    }

    _rebuildInner() {
        const target = this._isCentre() ? 'map' : 'panel';
        if (target !== this.target) { this.target = target; this.targetState = null; }
        this.freedWidgets = [];
        super._rebuildInner();
    }

    /** The drive mode arrives on the HUD's signals. */
    _tick() {
        const mode = this.primary.driveMode;
        if (mode !== this.driveMode) {
            this.driveMode = mode;
            if (this._layoutName() !== this.activeName) this._rebuild(); else this._status();
        }
        super._tick();
    }
}

module.exports = EvaDash;
