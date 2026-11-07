'use strict';
/**
 * HUD colour themes. Layouts name colour *roles* ("fg", "dim", "arc", ...) and
 * the active theme fills them in, so every layout works in every theme.
 *
 * Colours are [r, g, b, a] 0-255. On the HUD, black is see-through glass, so a
 * theme only ever adds light. Dark blue is the weakest colour on a HUD in sun;
 * M's mid blue is kept brighter than the paint-chip M blue for that reason.
 *
 * bar: the shift bar's three zones. lowColor up to midAt, midColor up to the
 * red zone, highColor from there. midAt: 'shift' = where the shift zone starts
 * (redline - 1500), or a fraction of the bar (M climbs light blue -> blue at 50%).
 */
const THEMES = {
    classic: {
        name: 'Classic',
        fg: [243, 246, 250, 255], dim: [243, 246, 250, 148], track: [243, 246, 250, 36], arc: [243, 246, 250, 255],
        glow: 0.35, stripe: false,
        bar: { low: [243, 246, 250], mid: [255, 154, 60], high: [255, 75, 62], midAt: 'shift' },
        rev: { from: [120, 128, 140], to: [243, 246, 250] },
    },
    m: {
        name: 'M',
        fg: [243, 246, 250, 255], dim: [170, 205, 255, 158], track: [80, 150, 255, 41], arc: [79, 180, 255, 255],
        glow: 0.4, stripe: true,
        bar: { low: [79, 180, 255], mid: [51, 102, 255], high: [232, 38, 45], midAt: 0.5 },
        rev: { from: [51, 102, 255], to: [110, 170, 255] },
    },
    night: {
        name: 'Night',
        fg: [255, 179, 71, 255], dim: [255, 179, 71, 140], track: [255, 179, 71, 36], arc: [255, 179, 71, 255],
        glow: 0.3, stripe: false,
        bar: { low: [255, 179, 71], mid: [255, 179, 71], high: [255, 75, 62], midAt: 'shift' },
        rev: { from: [150, 95, 35], to: [255, 179, 71] },
    },
    // Cluster theme (a layout's own "theme"). The cluster is an LCD, not glass: black is solid black there,
    // and it covers BMW's gauges under it. Extra roles: bg (the screen), panel (box inside), line (box
    // frame), head (box header strip), ink (text on a header), accent (a highlighted header).
    gt3: {
        name: 'GT3',
        fg: [244, 244, 244, 255], dim: [150, 154, 160, 255], track: [255, 255, 255, 26], arc: [244, 244, 244, 255],
        glow: 0, stripe: false,
        bar: { low: [57, 222, 72], mid: [255, 196, 0], high: [255, 42, 42], midAt: 'shift' },
        rev: { from: [57, 222, 72], to: [57, 222, 72] },
        bg: [0, 0, 0, 255], panel: [8, 9, 11, 255], line: [205, 208, 214, 255], head: [226, 228, 232, 255],
        ink: [12, 12, 14, 255], accent: [255, 196, 0, 255], well: [20, 22, 26, 255],
    },
    // EVA HUD (a layout's own "theme"). Extra roles: rule (thin dividers), white, live (the small readout on an
    // alert), and alert, which shared/eva_hud.js sets to the colour of the alert showing.
    eva: {
        name: 'EVA',
        fg: [255, 136, 0, 255], dim: [255, 136, 0, 190], track: [255, 136, 0, 26], arc: [255, 136, 0, 255],
        glow: 0.55, stripe: false,
        bar: { low: [255, 136, 0], mid: [255, 221, 0], high: [255, 17, 0], midAt: 0.6 },
        rev: { from: [255, 136, 0], to: [255, 136, 0] },
        rule: [255, 136, 0, 110], black: [0, 0, 0, 255], amber: [255, 176, 0, 255], white: [255, 255, 255, 255], live: [255, 255, 255, 215], alert: [255, 17, 0, 255],
        // the dash's designs on the map area: labels, and MAGI's three votes
        tag: [255, 180, 92, 255], sub: [192, 138, 72, 255], faint: [58, 36, 16, 255], wire: [122, 74, 24, 255],
        ok: [84, 224, 143, 255], okSoft: [159, 217, 184, 255], waitSoft: [255, 217, 138, 255], no: [255, 59, 47, 255], noSoft: [255, 177, 170, 255], blue: [111, 182, 255, 255],
    },
    // the EVA HUD's everyday looks: Comfort's dusk and Eco Pro's night
    eva_calm: {
        name: 'EVA Comfort',
        fg: [255, 176, 122, 255], soft: [255, 176, 122, 205], dim: [255, 176, 122, 165], track: [255, 176, 122, 26], arc: [255, 176, 122, 255],
        glow: 0.5, stripe: false,
        bar: { low: [255, 176, 122], mid: [255, 176, 122], high: [255, 200, 90], midAt: 0.7 },
        rev: { from: [255, 176, 122], to: [255, 176, 122] },
        rule: [255, 176, 122, 90], black: [0, 0, 0, 255], amber: [255, 176, 0, 255], white: [255, 255, 255, 255], live: [255, 255, 255, 215], alert: [255, 17, 0, 255],
    },
    eva_eco: {
        name: 'EVA Eco Pro',
        fg: [120, 205, 255, 255], soft: [120, 205, 255, 205], dim: [120, 205, 255, 165], track: [120, 205, 255, 26], arc: [120, 205, 255, 255],
        glow: 0.5, stripe: false,
        bar: { low: [120, 205, 255], mid: [120, 205, 255], high: [255, 200, 90], midAt: 0.7 },
        rev: { from: [120, 205, 255], to: [120, 205, 255] },
        // for the dash's Eco Pro designs: labels and lamps, as the battle display has them
        tag: [120, 205, 255, 235], sub: [120, 205, 255, 165], faint: [120, 205, 255, 46], wire: [120, 205, 255, 120],
        ok: [84, 224, 143, 255], okSoft: [159, 217, 184, 255], waitSoft: [255, 217, 138, 255], no: [255, 59, 47, 255], noSoft: [255, 177, 170, 255], blue: [120, 205, 255, 255],
        rule: [120, 205, 255, 90], black: [0, 0, 0, 255], amber: [255, 176, 0, 255], white: [255, 255, 255, 255], live: [255, 255, 255, 215], alert: [255, 17, 0, 255],
    },
};
// every theme: the shift-point red, used by "hot" (the gear and SHIFT at the shift point, the rev bar past it)
Object.keys(THEMES).forEach((k) => { THEMES[k].hot = [255, 42, 42, 255]; });
THEMES.eva.hot = [255, 17, 0, 255];
// the dash's Comfort designs: the battle display's orange for labels and lines, white for what is read
const ORANGE = [255, 136, 0];
THEMES.eva_orange_white = Object.assign({}, THEMES.eva, {
    name: 'EVA Orange and White', soft: [255, 136, 0, 215],
    bar: { low: ORANGE, mid: ORANGE, high: ORANGE, midAt: 0.7 }, rev: { from: ORANGE, to: ORANGE },
});

// Redline layout (after cauliflowermossgrape's Redline app): rev bar segments ramp rev.from -> rev.to up to
// the shift point; the shift lights run green -> yellow -> red in every theme; grade badges by verdict.
const LIGHTS = { green: [47, 210, 122], yellow: [255, 194, 26], red: [255, 42, 42], blue: [40, 110, 255] };
const VERDICT = {
    'SPOT ON': [47, 210, 122, 255], EARLY: [255, 194, 26, 255], LATE: [255, 138, 26, 255],
    LIMITER: [255, 42, 42, 255], 'COLD REV': [61, 139, 255, 255], COLD: [61, 139, 255, 255],
};

// The M tricolour stripe: light blue, dark blue, red (brightened for the HUD).
const M_STRIPE = [[79, 180, 255, 255], [47, 91, 216, 255], [232, 38, 45, 255]];

/** A colour from a role name ("fg") or a literal [r,g,b,a]. */
function color(theme, c) {
    if (Array.isArray(c)) return c;
    return theme[c] || theme.fg;
}

module.exports = { THEMES, M_STRIPE, LIGHTS, VERDICT, color };
