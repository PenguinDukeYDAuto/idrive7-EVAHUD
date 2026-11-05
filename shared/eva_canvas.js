'use strict';
/**
 * Which parts of a text canvas to send again. cluster-render allows a client 8 layers, so the EVA HUD draws all
 * its text on one image layer and updates it by rectangle: one part, one rectangle around its pixels that changed,
 * only when its look changed.
 *
 *   const c = new TextCanvas(parts, { key: (part, now) => look, paint: (part, look) => RGBA Buffer, onError });
 *   c.updates(nowMs, force) -> [{ rect: { x, y, w, h }, px }]
 *
 * key() says what a part should look like now; the same look isn't painted or sent again, even when forced: the
 * service keeps a hidden layer's pixels, and writes them all again itself if it has to make a new buffer. A part
 * repaints at most every rateMs (what BMW's own readouts do); force skips that wait, as when a layer comes back.
 * Parts must not overlap: each is written over what was there.
 * One part that can't paint is reported and tried again later; the others carry on.
 */
const BPP = 4;

/**
 * The one rectangle around what differs between two RGBA images of the same size, with its pixels, or null when
 * they are the same. A big readout that changes one digit then sends that digit: it is the link that is short.
 */
function changes(was, now, w, h) {
    const row = w * BPP;
    const sameRow = (y) => now.compare(was, y * row, (y + 1) * row, y * row, (y + 1) * row) === 0;
    const samePixel = (o) => now[o] === was[o] && now[o + 1] === was[o + 1] && now[o + 2] === was[o + 2] && now[o + 3] === was[o + 3];
    let top = 0;
    while (top < h && sameRow(top)) top++;
    if (top === h) return null;
    let bottom = h - 1;
    while (sameRow(bottom)) bottom--;
    let left = w, right = -1;
    for (let y = top; y <= bottom; y++) {
        if (sameRow(y)) continue;
        const o = y * row;
        for (let x = 0; x < left; x++) if (!samePixel(o + x * BPP)) { left = x; break; }
        for (let x = w - 1; x > right; x--) if (!samePixel(o + x * BPP)) { right = x; break; }
    }
    const rect = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
    const px = Buffer.allocUnsafe(rect.w * rect.h * BPP);
    for (let y = 0; y < rect.h; y++) {
        const o = (top + y) * row + left * BPP;
        now.copy(px, y * rect.w * BPP, o, o + rect.w * BPP);
    }
    return { rect, px };
}

class TextCanvas {
    constructor(parts, hooks) {
        this.parts = parts;
        this.key = hooks.key;
        this.paint = hooks.paint;
        this.onError = hooks.onError || (() => {});
        this.rateMs = hooks.rateMs === undefined ? 200 : hooks.rateMs;
        this.shown = new Map();      // part id -> { look, at, px }
    }

    updates(now, force) {
        const out = [];
        this.parts.forEach((p) => {
            const was = this.shown.get(p.id);
            if (!force && was && now - was.at < this.rateMs) return;
            try {
                const look = this.key(p, now);
                if (was && look === was.look) return;
                const px = this.paint(p, look);
                if (!px || px.length !== p.w * p.h * BPP) throw new Error('pixels of the wrong size for a ' + p.w + 'x' + p.h + ' part');
                this.shown.set(p.id, { look, at: now, px });
                if (!was) { out.push({ rect: { x: p.x, y: p.y, w: p.w, h: p.h }, px }); return; }
                const c = changes(was.px, px, p.w, p.h);
                if (c) out.push({ rect: { x: p.x + c.rect.x, y: p.y + c.rect.y, w: c.rect.w, h: c.rect.h }, px: c.px });
            } catch (e) {
                this.onError(p, e);
            }
        });
        return out;
    }
}

module.exports = { TextCanvas, changes };
