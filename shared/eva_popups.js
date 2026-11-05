'use strict';
/**
 * Which BMW pop-ups are showing, read from cluster-render's log.
 *
 * BMW's media and list pop-ups show in slot 0x322 on the HUD and 0x202 on the cluster, and the display takes our layers
 * down for them. If we ask for our slot again while one shows, the display moves the pop-up to the other screen; with
 * EVA on both screens it then moves back, every 3 s, for as long as it stays up (seen on the car). So a screen gives way
 * while a pop-up shows and for a moment after, as cluster-render's unreleased hud_yield_slots does for the HUD.
 *
 * Only uid 5000 may ask the display manager, so this reads the slot table's changes from the service's log:
 *   dcsm: slot 0x322 status 2 content 0x1000251 class 512 map 1
 * A row shows while its map status is 1 (foreground) or 2 (background). Without a readable log nothing ever counts as
 * showing, and the pop-ups behave as they do without this.
 */
const fs = require('fs');

const LOG = '/var/opt/cluster-render/log/cluster-render.log';
const ROW = /dcsm: slot 0x([0-9a-f]+) status \d+ content 0x([0-9a-f]+) class \d+ map (\d+)/;
const TABLE_GONE = /dcsm: (waiting for Dcsm2|Dcsm2 not available)/;
const START_BYTES = 64 * 1024;

class PopupWatch {
    constructor(opts) {
        const o = opts || {};
        this.path = o.path || process.env.EVA_POPUP_LOG || LOG;
        this.holdMs = o.holdMs === undefined ? 1500 : o.holdMs;
        this.pollMs = o.pollMs === undefined ? 100 : o.pollMs;
        this.log = o.log;
        this.rows = new Map();      // slot -> Map(content -> shown)
        this.goneAt = new Map();    // slot -> when its last row stopped showing
        this.pos = null;
        this.tail = '';
        this.lastPoll = null;
        this.bytesRead = 0;
        this.complained = false;
    }

    poll(now) {
        if (this.lastPoll !== null && now - this.lastPoll < this.pollMs) return;
        this.lastPoll = now;
        let fd = null;
        try {
            fd = fs.openSync(this.path, 'r');
            const size = fs.fstatSync(fd).size;
            const starting = this.pos === null;
            if (starting) this.pos = Math.max(0, size - START_BYTES);
            else if (size < this.pos) { this.pos = 0; this.tail = ''; }     // rotated
            if (size > this.pos) {
                const b = Buffer.alloc(size - this.pos);
                fs.readSync(fd, b, 0, b.length, this.pos);
                this.bytesRead += b.length;
                this.pos = size;
                this._lines(b.toString('utf8'), now, starting);
            }
        } catch (e) {
            if (!this.complained && this.log) this.log.warn('pop-ups not watched: ' + e.message);
            this.complained = true;
        } finally {
            if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* nothing more to do */ } }
        }
    }

    _lines(text, now, starting) {
        const all = (this.tail + text).split('\n');
        this.tail = all.pop();
        all.forEach((line) => {
            if (TABLE_GONE.test(line)) { this.rows.clear(); this.goneAt.clear(); return; }
            const m = ROW.exec(line);
            if (m) this._row(parseInt(m[1], 16), m[2], m[3], now, starting);
        });
    }

    _row(slot, content, map, now, starting) {
        if (parseInt(content, 16) === 0) return;
        if (!this.rows.has(slot)) this.rows.set(slot, new Map());
        const rows = this.rows.get(slot);
        const was = this._any(rows);
        rows.set(content, map === '1' || map === '2');
        if (was && !this._any(rows) && !starting) this.goneAt.set(slot, now);
        if (this._any(rows) || starting) this.goneAt.delete(slot);
    }

    _any(rows) {
        let on = false;
        rows.forEach((v) => { on = on || v; });
        return on;
    }

    /** Whether a screen should give way to this slot now. */
    shown(slot, now) {
        const rows = this.rows.get(slot);
        if (rows && this._any(rows)) return true;
        const gone = this.goneAt.get(slot);
        return gone !== undefined && now - gone < this.holdMs;
    }
}

module.exports = { PopupWatch };
