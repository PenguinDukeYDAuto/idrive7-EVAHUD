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
 */
const EvaHud = require('./eva_hud');

const POPUP_SLOT = 0x202;
const TEXT_MS = 250;     // its text rectangles are about four times the HUD's, and share one upload budget with it

class EvaDash extends EvaHud {
    constructor(ctx, primary) {
        super(ctx, { primary, target: 'panel', statusName: 'DASH', clientName: ctx.spec.id + '_dash', textRateMs: TEXT_MS });
        this.primary = primary;
        this.readings = primary.readings;
    }

    _layoutName() {
        const s = this._screens();
        return s === 'dash' || s === 'both' ? 'eva' : 'off';
    }
    _layoutFile(name) { return name === 'off' ? name : 'dash_' + name; }
    _followsDriveMode() { return false; }     // no layouts per drive mode yet
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

    _showAlert(key, now) {
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
