'use strict';
/**
 * EVA: the NERV battle display on the iDrive 7 windshield HUD and instrument cluster, drawn through cluster-render.
 *
 * The center screen is the app's settings page: a status line, then each screen's layout, units, redline, the alert
 * limits and an alert preview. The drawing keeps running after the page is closed, so the page is only needed for
 * changes. The HUD is in shared/eva_hud.js and the cluster in shared/eva_dash.js. A dash that can't start leaves the HUD.
 */
const mgu = require('./kit/mgu');
const EvaHud = require('./eva_hud');

mgu.run({
    start(ctx) {
        let hud, dash = null;
        try {
            hud = new EvaHud(ctx);
        } catch (e) {
            // no HUD, but stay up: an exit here would count as a crash on the car
            ctx.log.error('HUD failed to start: ' + (e && e.stack || e));
            ctx.ui.text('STATUS', 'HUD failed to start: ' + (e && e.message || e));
            return;
        }
        try {
            const EvaDash = require('./eva_dash');
            dash = new EvaDash(ctx, hud);
            hud.dash = dash;
        } catch (e) {
            dash = null;
            ctx.log.error('dash failed to start, the HUD carries on: ' + (e && e.stack || e));
        }
        const show = () => ctx.ui.text('STATUS', [hud.lastStatus, dash && dash.lastStatus].filter(Boolean).join('  /  '));
        hud.onStatus(show);
        if (dash) dash.onStatus(show);
        hud.start();
        if (dash) dash.start();
        process.on('exit', () => {
            try { hud.stop(); } catch (e) { /* exiting anyway */ }
            try { if (dash) dash.stop(); } catch (e) { /* exiting anyway */ }
        });
    },
});
