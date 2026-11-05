'use strict';
/**
 * Draws text into a widget's RGBA buffer from the pre-baked bitmap fonts in
 * hud/fonts/ (made on the Mac by tools/bake_fonts.py; the car does no font
 * rasterizing). Each font is JSON: glyph metrics plus the atlas as one alpha
 * byte per pixel (base64). We tint the coverage with the requested colour.
 *
 *   drawText(boxW, boxH, text, { font, color, align, spacing, glow }) -> RGBA Buffer (boxW*boxH*4)
 *
 * align: 'left' | 'center' | 'right' within the box; x shifts the start (px). The text's cell top sits at
 * the box top (y = 0). spacing: extra px between characters. glow: 0..1, a soft
 * halo in the same colour under the text (the HUD look); 0 = none.
 * Output is straight (non-premultiplied) RGBA, as cluster-render image layers take it.
 */
const data = require('./hud_data');

const loadedFonts = new Map();
const warnedMissing = new Set();

function loadFont(name) {
    if (loadedFonts.has(name)) return loadedFonts.get(name);
    const metrics = data.json('fonts/' + name + '.json');
    if (!metrics || !metrics.glyphs || !metrics.alpha) throw new Error('font "' + name + '" is missing from hud/fonts');
    const alpha = Buffer.from(metrics.alpha, 'base64');
    if (alpha.length !== metrics.width * metrics.height) throw new Error('font "' + name + '": atlas size does not match');
    const font = { width: metrics.width, alpha, metrics: { size: metrics.size, cellHeight: metrics.cellHeight, baseline: metrics.baseline, glyphs: metrics.glyphs } };
    loadedFonts.set(name, font);
    return font;
}

function glyphOf(font, ch) {
    const g = font.metrics.glyphs[ch];
    if (g) return g;
    if (!warnedMissing.has(ch)) { warnedMissing.add(ch); console.warn('[hud_text] font has no glyph for ' + JSON.stringify(ch)); }
    return font.metrics.glyphs[' '] || { x: 0, y: 0, w: 0, h: 0, ox: 0, advance: 0 };
}

/** Width in px of `text` in `fontName` with `spacing`. */
function measure(text, fontName, spacing) {
    const font = loadFont(fontName);
    const chars = String(text).split('');
    let w = 0;
    chars.forEach((ch, i) => { w += glyphOf(font, ch).advance + (i < chars.length - 1 ? (spacing || 0) : 0); });
    return w;
}

/** Coverage mask (boxW*boxH bytes) of the text laid out in the box. */
function mask(boxW, boxH, text, opts) {
    const font = loadFont(opts.font);
    const spacing = opts.spacing || 0;
    const out = Buffer.alloc(boxW * boxH, 0);
    const width = measure(text, opts.font, spacing);
    let pen = (opts.x || 0) + (opts.align === 'right' ? boxW - width : opts.align === 'center' ? Math.round((boxW - width) / 2) : 0);
    const offY = opts.offsetY || 0;
    for (const ch of String(text)) {
        const g = glyphOf(font, ch);
        const x0 = Math.round(pen + g.ox);       // spacing can be fractional: snap each glyph to a pixel
        for (let y = 0; y < g.h; y++) {
            const dy = y + offY;
            if (dy < 0 || dy >= boxH) continue;
            const srcRow = (g.y + y) * font.width + g.x;
            const dstRow = dy * boxW;
            for (let x = 0; x < g.w; x++) {
                const dx = x0 + x;
                if (dx < 0 || dx >= boxW) continue;
                const a = font.alpha[srcRow + x];
                if (a > out[dstRow + dx]) out[dstRow + dx] = a; // overlapping cells: keep the stronger ink
            }
        }
        pen += g.advance + spacing;
    }
    return out;
}

/** Separable box blur on a coverage mask, radius r, `passes` times (~gaussian at 3). */
function blur(src, w, h, r, passes) {
    let a = Buffer.from(src);
    let b = Buffer.alloc(a.length);
    const n = 2 * r + 1;
    for (let p = 0; p < passes; p++) {
        for (let y = 0; y < h; y++) {           // horizontal
            const row = y * w;
            let sum = 0;
            for (let x = -r; x <= r; x++) sum += a[row + Math.min(w - 1, Math.max(0, x))];
            for (let x = 0; x < w; x++) {
                b[row + x] = (sum / n) | 0;
                sum += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
            }
        }
        for (let x = 0; x < w; x++) {           // vertical
            let sum = 0;
            for (let y = -r; y <= r; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x];
            for (let y = 0; y < h; y++) {
                a[y * w + x] = (sum / n) | 0;
                sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
            }
        }
    }
    return a;
}

function drawText(boxW, boxH, text, opts) {
    return tint(mask(boxW, boxH, text, opts), boxW, boxH, opts);
}

/** Colour a coverage mask (plus optional glow) into straight RGBA. opts: color, glow, font. */
function tint(m, boxW, boxH, opts) {
    const color = opts.color || [255, 255, 255, 255];
    let halo = null;
    const glow = opts.glow || 0;
    if (glow > 0) {
        const r = Math.max(2, Math.round(loadFont(opts.font).metrics.size / 24));
        halo = blur(m, boxW, boxH, r, 2);
    }
    const out = Buffer.alloc(boxW * boxH * 4, 0);
    const ca = color[3] / 255;
    for (let i = 0; i < m.length; i++) {
        let a = m[i] / 255;
        if (halo) a = a + (1 - a) * (halo[i] / 255) * glow; // glyph over its own halo
        if (a <= 0) continue;
        const o = i * 4;
        out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2];
        out[o + 3] = Math.round(a * ca * 255);
    }
    return out;
}

module.exports = { drawText, mask, tint, measure, loadFont };
