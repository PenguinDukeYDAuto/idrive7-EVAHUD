'use strict';
/**
 * The HUD's GLSL ES 1.00 fragment shaders for cluster-render "effect" layers, drawn on the
 * car's GPU. Kept as JS strings because the kit's build ships an app's top-level .js files
 * as they are (a data folder becomes a JSON-only pack). hud.js sends the uniforms.
 */
const SHIFTBAR = `// Segmented shift bar for a cluster-render "effect" layer (GLSL ES 1.00).
// v_uv is 0..1 across the layer, (0,0) at the top-left as on the car. Uniforms come from hud.js:
//   u_value   0..1, how much of the bar is lit (rpm / bar max)
//   u_size    layer size in px (w, h), for round corners and gaps in pixels
//   u_segs    segment count
//   u_low, u_mid, u_high   zone colours (rgb 0..1)
//   u_midAt, u_highAt      where the mid and high zones start (0..1 of the bar)
//   u_track   unlit segment colour (rgba, straight alpha)
//   u_flash   1 = at the redline: every lit segment shows the high colour
// Output is straight alpha. Whether cluster-render blends effect layers as
// straight or premultiplied alpha is not confirmed yet: check the edges on the car.
precision mediump float;
varying vec2 v_uv;
uniform float u_value;
uniform vec2 u_size;
uniform float u_segs;
uniform vec3 u_low;
uniform vec3 u_mid;
uniform vec3 u_high;
uniform float u_midAt;
uniform float u_highAt;
uniform vec4 u_track;
uniform float u_flash;

void main() {
    float gapPx = 3.0;
    float slot = u_size.x / u_segs;                 // px per segment incl. gap
    float px = v_uv.x * u_size.x;
    float idx = floor(px / slot);
    float inSeg = px - idx * slot;                  // px into this slot
    float segW = slot - gapPx;
    float py = v_uv.y * u_size.y;           // px from the top

    // rounded-rect coverage for this segment, radius 2px, 1px soft edge
    vec2 hs = vec2(segW, u_size.y) * 0.5;
    vec2 p = vec2(inSeg, py) - hs;
    vec2 q = abs(p) - (hs - vec2(2.0));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 2.0;
    float cover = clamp(0.5 - d, 0.0, 1.0);
    if (inSeg > segW) cover = 0.0;
    if (cover <= 0.0) { gl_FragColor = vec4(0.0); return; }

    float pos = (idx + 0.5) / u_segs;               // segment centre, 0..1
    bool lit = pos <= u_value;
    vec3 c = pos >= u_highAt ? u_high : (pos >= u_midAt ? u_mid : u_low);
    if (u_flash > 0.5) c = u_high;
    gl_FragColor = lit ? vec4(c, cover) : vec4(u_track.rgb, u_track.a * cover);
}
`;

const ARC = `// Thin open arc gauge for a cluster-render "effect" layer (GLSL ES 1.00).
// 270 degree sweep with the gap at the bottom, round ends, filled clockwise
// from the lower left. Uniforms from hud.js:
//   u_value  0..1 of the sweep
//   u_size   layer size in px (w, h)
//   u_color  lit arc (rgb 0..1)
//   u_track  unlit arc (rgba, straight alpha)
//   u_width  stroke width in px
// Output is straight alpha (same open question as the shift bar shader above).
precision mediump float;
varying vec2 v_uv;
uniform float u_value;
uniform vec2 u_size;
uniform vec3 u_color;
uniform vec4 u_track;
uniform float u_width;

const float PI = 3.14159265359;
const float SWEEP = 1.5 * PI;          // 270 degrees
const float START = 1.25 * PI;         // lower left, measured clockwise from 12 o'clock

// distance from point p (centred, px) to the arc from angle a0 sweeping s, radius r
float arcDist(vec2 p, float r, float a0, float s) {
    float a = atan(p.x, p.y);           // clockwise from 12 o'clock, -PI..PI
    float rel = mod(a - a0 + 4.0 * PI, 2.0 * PI);
    if (rel <= s) return abs(length(p) - r);
    vec2 e0 = r * vec2(sin(a0), cos(a0));
    vec2 e1 = r * vec2(sin(a0 + s), cos(a0 + s));
    return min(length(p - e0), length(p - e1));   // round end caps
}

void main() {
    vec2 p = vec2(v_uv.x - 0.5, 0.5 - v_uv.y) * u_size;   // px from centre, +y up (v_uv is top-left)
    float r = min(u_size.x, u_size.y) * 0.5 - u_width * 0.5 - 1.0;
    float hw = u_width * 0.5;
    float dTrack = arcDist(p, r, START, SWEEP) - hw;
    float lit = clamp(u_value, 0.0, 1.0) * SWEEP;
    float dLit = lit > 0.001 ? arcDist(p, r, START, lit) - hw : 1e5;
    float cLit = clamp(0.5 - dLit, 0.0, 1.0);
    float cTrack = clamp(0.5 - dTrack, 0.0, 1.0);
    if (cLit > 0.0) gl_FragColor = vec4(u_color, cLit);
    else gl_FragColor = vec4(u_track.rgb, u_track.a * cTrack);
}
`;

const REVBAR = `// G20 Live Cockpit style rev bar for a cluster-render "effect" layer (GLSL ES 1.00), after
// cauliflowermossgrape's Redline app (MIT). From the top of the layer: u_top px for the shift-point and
// redline marks, then the bar (u_barH px, slanted: its top edge is u_slant px right of its bottom
// edge), then the scale ticks. The bar fills left to right in 500 rpm segments; each lit segment
// takes the ramp colour of its position up to the shift point (u_from -> u_to), all u_hot from the
// shift point on. Unlit: u_track, and u_hot faint past the redline. A white needle leads the fill;
// a thin slanted line holds the peak. Uniforms (rpm values are rpm, not 0..1):
//   u_size, u_top, u_barH, u_slant   px
//   u_max, u_value, u_shift, u_red, u_peak   rpm
//   u_from, u_to, u_hot   rgb 0..1;  u_track, u_tick, u_fg   rgba (straight alpha)
//   u_shiftNow   1 = at or past the shift point
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_top;
uniform float u_barH;
uniform float u_slant;
uniform float u_max;
uniform float u_value;
uniform float u_shift;
uniform float u_red;
uniform float u_peak;
uniform vec3 u_from;
uniform vec3 u_to;
uniform vec3 u_hot;
uniform vec4 u_track;
uniform vec4 u_tick;
uniform vec4 u_fg;
uniform float u_shiftNow;

vec4 over(vec4 top, vec4 under) {           // straight-alpha "top over under"
    float a = top.a + under.a * (1.0 - top.a);
    if (a <= 0.0) return vec4(0.0);
    return vec4((top.rgb * top.a + under.rgb * under.a * (1.0 - top.a)) / a, a);
}

void main() {
    float px = v_uv.x * u_size.x;
    float py = v_uv.y * u_size.y;   // px from the top
    float bw = u_size.x - u_slant;            // bar length along the bottom edge
    float perRpm = bw / u_max;
    vec4 c = vec4(0.0);

    // marks above the bar: shift point (amber) and redline (red), at the bar's top edge
    if (py < u_top - 2.0) {
        float ds = abs(px - (u_shift * perRpm + u_slant));
        float dr = abs(px - (u_red * perRpm + u_slant));
        if (ds < 2.0) c = vec4(1.0, 0.76, 0.1, clamp(2.0 - ds, 0.0, 1.0));
        if (dr < 2.0) c = vec4(u_hot, clamp(2.0 - dr, 0.0, 1.0));
        gl_FragColor = c; return;
    }

    float by = py - u_top;                    // px down from the bar's top edge
    if (by <= u_barH) {
        float off = u_slant * (u_barH - by) / u_barH;
        float s = px - off;                   // px along the bar at this height
        float rpm = s / perRpm;
        float inside = clamp(s + 0.5, 0.0, 1.0) * clamp(bw - s + 0.5, 0.0, 1.0)
            * clamp(by + 0.5, 0.0, 1.0) * clamp(u_barH - by + 0.5, 0.0, 1.0);
        // slanted 3 px gap every 500 rpm
        float seg = floor(rpm / 500.0);
        float dGap = abs(s - floor(rpm / 500.0 + 0.5) * 500.0 * perRpm);
        float gap = rpm > 250.0 && rpm < u_max - 250.0 ? clamp(dGap - 1.0, 0.0, 1.0) : 1.0;
        vec4 bar;
        if (rpm <= u_value) {
            float f = clamp((seg * 500.0 + 250.0) / u_shift, 0.0, 1.0);
            vec3 col = u_shiftNow > 0.5 ? u_hot : mix(u_from, u_to, f);
            bar = vec4(col, 1.0);
        } else if (rpm >= u_red) bar = vec4(u_hot, 0.3);
        else bar = u_track;
        c = vec4(bar.rgb, bar.a * inside * gap);
        // peak: a thin slanted line where the rpm last peaked (only above the current rpm)
        if (u_peak > u_value + 60.0) {
            float dp = abs(s - u_peak * perRpm);
            vec3 pc = u_peak >= u_shift ? u_hot : mix(u_from, u_to, clamp(u_peak / u_shift, 0.0, 1.0));
            c = over(vec4(pc, clamp(1.5 - dp, 0.0, 1.0) * inside), c);
        }
        // needle: the bright leading edge of the fill
        if (u_value > 50.0) {
            float dn = abs(s - min(u_value, u_max) * perRpm);
            c = over(vec4(1.0, 1.0, 1.0, clamp(2.5 - dn, 0.0, 1.0) * clamp(by + 2.5, 0.0, 1.0) * clamp(u_barH - by + 2.5, 0.0, 1.0)), c);
        }
        gl_FragColor = c; return;
    }

    // scale ticks under the bar: every 500 rpm, longer every 1000, red from the redline
    float ty = by - u_barH - 4.0;
    if (ty >= 0.0) {
        float rpm = px / perRpm;
        float k = floor(rpm / 500.0 + 0.5);
        float d = abs(px - k * 500.0 * perRpm);
        bool major = mod(k, 2.0) < 0.5;
        float len = major ? 10.0 : 5.0;
        float hw = major ? 1.25 : 0.75;
        float a = clamp(hw + 0.5 - d, 0.0, 1.0) * (ty <= len ? 1.0 : 0.0);
        vec4 tc = k * 500.0 >= u_red ? vec4(u_hot, 1.0) : (major ? u_fg : u_tick);
        c = vec4(tc.rgb, tc.a * a);
    }
    gl_FragColor = c;
}
`;

const LIGHTS = `// Shift lights for a cluster-render "effect" layer (GLSL ES 1.00), after cauliflowermossgrape's Redline
// app (MIT): u_n rounded lights in a row, green -> yellow -> red from left to right. u_lit of them are
// on (they fill over the last 2000 rpm before the shift point); u_strobe 1 = at the shift point: all red.
// The last u_tail lights are blue instead (the GT3 dash look; 0 = none). u_round 1 = round lights.
//   u_size px, u_n count, u_lit count (0..u_n), u_tail count, u_strobe 0/1, u_green/u_yellow/u_red/u_blue rgb,
//   u_off (alpha when off)
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_n;
uniform float u_lit;
uniform float u_tail;
uniform float u_round;
uniform float u_strobe;
uniform vec3 u_green;
uniform vec3 u_yellow;
uniform vec3 u_red;
uniform vec3 u_blue;
uniform float u_off;

void main() {
    float gapPx = 6.0;
    float slot = (u_size.x + gapPx) / u_n;
    float px = v_uv.x * u_size.x;
    float py = v_uv.y * u_size.y;
    float idx = floor(px / slot);
    float inSeg = px - idx * slot;
    float segW = slot - gapPx;
    if (inSeg > segW || idx >= u_n) { gl_FragColor = vec4(0.0); return; }
    vec2 hs = vec2(segW, u_size.y) * 0.5;
    vec2 p = vec2(inSeg, py) - hs;
    float r = u_round > 0.5 ? min(hs.x, hs.y) : min(4.0, hs.y);
    if (u_round > 0.5) hs = vec2(r);
    p = vec2(inSeg, py) - vec2(segW, u_size.y) * 0.5;
    vec2 q = abs(p) - (hs - vec2(r));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    float cover = clamp(0.5 - d, 0.0, 1.0);
    float nMain = max(1.0, u_n - u_tail);
    float f = idx / max(1.0, nMain - 1.0);
    vec3 col = idx >= nMain ? u_blue : (f < 0.42 ? u_green : (f < 0.75 ? u_yellow : u_red));
    bool on = idx < u_lit;
    if (u_strobe > 0.5) { col = u_red; on = true; }
    gl_FragColor = vec4(col, cover * (on ? 1.0 : u_off));
}
`;

const FILL = `// Solid fill for a cluster-render "effect" layer (GLSL ES 1.00): u_color everywhere, except a
// see-through rounded hole u_hole (x, y, w, h px from the layer's top left; w = 0: no hole), radius u_holeR.
// On the cluster, an opaque fill hides BMW's own gauges under it; the hole lets the map window show.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_color;
uniform vec4 u_hole;
uniform float u_holeR;

void main() {
    vec2 p = vec2(v_uv.x * u_size.x, v_uv.y * u_size.y);
    float a = u_color.a;
    if (u_hole.z > 0.0) {
        vec2 hs = u_hole.zw * 0.5;
        vec2 q = abs(p - (u_hole.xy + hs)) - (hs - vec2(u_holeR));
        float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_holeR;
        a *= clamp(d + 0.5, 0.0, 1.0);
    }
    gl_FragColor = vec4(u_color.rgb, a);
}
`;

const BOX = `// Framed box for a cluster-render "effect" layer (GLSL ES 1.00), the race-dash readout box: a rounded
// frame u_border px wide in u_line, filled u_fill, with a header strip u_headH px tall in u_head across the
// top (0 = none). Colours rgba, straight alpha. u_size, u_border, u_headH, u_radius in px.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_fill;
uniform vec4 u_line;
uniform vec4 u_head;
uniform float u_headH;
uniform float u_border;
uniform float u_radius;

void main() {
    vec2 p = vec2(v_uv.x * u_size.x, v_uv.y * u_size.y);
    vec2 hs = u_size * 0.5;
    vec2 q = abs(p - hs) - (hs - vec2(u_radius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;   // < 0 inside
    float outer = clamp(0.5 - d, 0.0, 1.0);
    if (outer <= 0.0) { gl_FragColor = vec4(0.0); return; }
    vec4 c = p.y < u_headH ? u_head : u_fill;
    float edge = clamp(d + u_border + 0.5, 0.0, 1.0);                       // 1 within the frame
    vec4 col = mix(c, u_line, edge);
    gl_FragColor = vec4(col.rgb, col.a * outer);
}
`;

const GRID = `// Calibration grid for a cluster-render "effect" layer (GLSL ES 1.00): a line every u_step px, a brighter
// one every u_major steps, a frame round the edge. v_uv (0,0) is the top-left.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_step;
uniform float u_major;
uniform vec4 u_minor;
uniform vec4 u_majorC;

void main() {
    vec2 p = v_uv * u_size;
    vec2 m = mod(p, u_step);
    vec2 big = mod(p, u_step * u_major);
    bool edge = p.x < 2.0 || p.y < 2.0 || p.x > u_size.x - 2.0 || p.y > u_size.y - 2.0;
    if (edge || big.x < 2.0 || big.y < 2.0) gl_FragColor = u_majorC;
    else if (m.x < 1.0 || m.y < 1.0) gl_FragColor = u_minor;
    else gl_FragColor = vec4(0.0);
}
`;

const EVASEG = `// The EVA HUD's rev bar: hard-edged segments, three colour zones, the whole bar white while u_strobe is on.
//   u_gap px between segments, u_value 0..1 lit, u_segs count, u_low/u_mid/u_high colours, u_midAt/u_highAt zone starts, u_off unlit alpha
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform float u_value;
uniform float u_segs;
uniform vec3 u_low;
uniform vec3 u_mid;
uniform vec3 u_high;
uniform float u_midAt;
uniform float u_highAt;
uniform float u_off;
uniform float u_strobe;
uniform float u_gap;

void main() {
    float gap = u_gap;
    float slot = (u_size.x + gap) / u_segs;
    float px = v_uv.x * u_size.x;
    float idx = floor(px / slot);
    if (px - idx * slot > slot - gap) { gl_FragColor = vec4(0.0); return; }
    if (u_strobe > 0.5) { gl_FragColor = vec4(1.0); return; }
    float pos = idx / (u_segs - 1.0);
    vec3 c = pos < u_midAt ? u_low : (pos < u_highAt ? u_mid : u_high);
    bool lit = (idx + 0.5) / u_segs <= u_value;
    gl_FragColor = vec4(c, lit ? 1.0 : u_off);
}
`;

const EVAFRAME = `// The EVA HUD's gear frame: a thin line, inset, and heavy brackets on the outer corners.
//   u_color rgb, u_lineA line alpha, u_cornerA bracket alpha, u_inset px, u_corner bracket length px, u_weight the brackets' thickness x, u_lineW the line's thickness px
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec3 u_color;
uniform float u_lineA;
uniform float u_cornerA;
uniform float u_inset;
uniform float u_corner;
uniform float u_weight;
uniform float u_lineW;

void main() {
    vec2 p = v_uv * u_size;
    vec2 e = min(p, u_size - p);               // px from the nearest edge, per axis
    float a = 0.0;
    bool nearX = e.x < u_corner, nearY = e.y < u_corner;
    if ((e.x < 3.0 * u_weight && nearY) || (e.y < 3.0 * u_weight && nearX)) a = u_cornerA;
    else if (min(e.x, e.y) >= u_inset && min(e.x, e.y) < u_inset + u_lineW) a = u_lineA;
    gl_FragColor = vec4(u_color, a);
}
`;

const EVASOLO = `// What the EVA HUD adds when it has the head unit to itself: a segmented throttle bar.
//   u_bar x,y,w,h px, u_pedal 0..1, u_color rgb
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec3 u_color;
uniform vec4 u_bar;
uniform float u_pedal;

void main() {
    vec2 p = v_uv * u_size;
    vec4 c = vec4(0.0);
    vec2 q = p - u_bar.xy;
    if (q.x >= 0.0 && q.y >= 0.0 && q.x < u_bar.z && q.y < u_bar.w && mod(q.x, 8.0) < 6.0) {
        c = vec4(u_color, q.x / u_bar.z <= u_pedal ? 1.0 : 0.12);
    }
    gl_FragColor = c;
}
`;

const EVACORNERS = `// The EVA HUD's everyday frame: four thin corners, which cost no pixel memory, and move with one number.
//   u_ins px in from the layer's edge, u_arm and u_weight px, u_lowerLeft px from the top where the lower left corner ends:
//   it stops above BMW's own speed. u_color rgb, u_alpha.
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec3 u_color;
uniform float u_alpha;
uniform float u_arm;
uniform float u_weight;
uniform float u_ins;
uniform float u_lowerLeft;

float corner(vec2 p, vec2 at, vec2 dir) {
    vec2 q = (p - at) * dir;                   // px along the corner's two arms
    if (q.x < 0.0 || q.y < 0.0 || q.x >= u_arm || q.y >= u_arm) return 0.0;
    return (q.x < u_weight || q.y < u_weight) ? 1.0 : 0.0;
}

void main() {
    vec2 p = v_uv * u_size;
    float on = corner(p, vec2(u_ins, u_ins), vec2(1.0, 1.0))
             + corner(p, vec2(u_size.x - u_ins, u_ins), vec2(-1.0, 1.0))
             + corner(p, vec2(u_size.x - u_ins, u_size.y - u_ins), vec2(-1.0, -1.0))
             + corner(p, vec2(u_ins, u_lowerLeft), vec2(1.0, -1.0));
    gl_FragColor = vec4(u_color, on > 0.0 ? u_alpha : 0.0);
}
`;

const EVAHEX = `// The ground of the dash: black, with a faint honeycomb if asked, and opaque, so nothing shows through it.
//   u_color rgb, u_alpha the lines' strength (0: plain black), u_cell a hexagon's side px
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec3 u_color;
uniform float u_alpha;
uniform float u_cell;

void main() {
    vec2 p = v_uv * u_size / u_cell;
    vec2 s = vec2(1.7320508, 3.0);
    vec2 a = mod(p, s) - s * 0.5;
    vec2 b = mod(p - s * 0.5, s) - s * 0.5;
    vec2 g = abs(dot(a, a) < dot(b, b) ? a : b);     // from the nearest hexagon's centre
    float edge = 0.8660254 - max(g.x, g.x * 0.5 + g.y * 0.8660254);
    float line = 1.0 - smoothstep(0.75 / u_cell, 1.5 / u_cell, edge);
    gl_FragColor = vec4(u_color * line * u_alpha, 1.0);
}
`;

const EVAHAZARD = `// The ground of the dash's design B: black, opaque, with hazard stripes along the top and the bottom.
//   u_stripe rgb, u_alpha 1 or 0 (0 in an alert: plain black), u_h the stripes' height px
precision mediump float;
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec3 u_stripe;
uniform float u_alpha;
uniform float u_h;

void main() {
    vec2 p = v_uv * u_size;
    float on = p.y < u_h || p.y > u_size.y - u_h ? step(mod(p.x + p.y, 36.0), 18.0) : 0.0;
    gl_FragColor = vec4(u_stripe * on * u_alpha, 1.0);
}
`;

const EVASEVEN = `// Four seven-segment digits and a dot or a colon, as the show's countdown has them. The digits change by uniform: no pixels.
//   u_digits 0-9, or below 0 for only the dim segments. u_sepAfter the digit the separator follows, u_colon 0 a dot, 1 a colon,
//   u_sepOn 0 or 1, u_color rgb, u_off the dim segments' alpha, u_margin px around the digits for the glow
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec4 u_digits;
uniform float u_sepAfter;
uniform float u_colon;
uniform float u_sepOn;
uniform vec3 u_color;
uniform float u_off;
uniform float u_margin;
const float DW = 108.0, DH = 180.0, GAP = 18.0, T = 20.0, SEP = 24.0;

// segments a to g as the bits 1, 2, 4 ... 64
float codeOf(float d) {
    if (d < -0.5) return 0.0;
    if (d < 0.5) return 63.0;
    if (d < 1.5) return 6.0;
    if (d < 2.5) return 91.0;
    if (d < 3.5) return 79.0;
    if (d < 4.5) return 102.0;
    if (d < 5.5) return 109.0;
    if (d < 6.5) return 125.0;
    if (d < 7.5) return 7.0;
    if (d < 8.5) return 127.0;
    return 111.0;
}
float bitOf(float code, float value) { return mod(floor(code / value), 2.0); }
float flat_(vec2 q, float len) { return max(abs(q.y) - T * 0.5, abs(q.x) + abs(q.y) - len); }
float tall(vec2 q, float len) { return max(abs(q.x) - T * 0.5, abs(q.y) + abs(q.x) - len); }

void main() {
    vec2 p = v_uv * u_size - vec2(u_margin);
    float sepX = (u_sepAfter + 1.0) * (DW + GAP) - 8.0;
    bool after = p.x > sepX + T;
    float x = after ? p.x - SEP : p.x;
    // each side of the separator keeps to its own digits: the next digit's left side must not reach into the separator's column
    float i = clamp(floor((x + GAP * 0.5) / (DW + GAP)), after ? u_sepAfter + 1.0 : 0.0, after ? 3.0 : u_sepAfter);
    vec2 q = vec2(x - i * (DW + GAP), p.y);
    float digit = i < 0.5 ? u_digits.x : i < 1.5 ? u_digits.y : i < 2.5 ? u_digits.z : u_digits.w;
    float code = codeOf(digit);
    float hl = DW * 0.5 - 2.0, vl = DH * 0.25 - 2.0;
    float d[7];
    d[0] = flat_(q - vec2(DW * 0.5, T * 0.5), hl);
    d[1] = tall(q - vec2(DW - T * 0.5, DH * 0.25), vl);
    d[2] = tall(q - vec2(DW - T * 0.5, DH * 0.75), vl);
    d[3] = flat_(q - vec2(DW * 0.5, DH - T * 0.5), hl);
    d[4] = tall(q - vec2(T * 0.5, DH * 0.75), vl);
    d[5] = tall(q - vec2(T * 0.5, DH * 0.25), vl);
    d[6] = flat_(q - vec2(DW * 0.5, DH * 0.5), hl);
    float lit = 1000.0, dim = 1000.0, value = 1.0;
    for (int k = 0; k < 7; k++) {
        if (bitOf(code, value) > 0.5) lit = min(lit, d[k]); else dim = min(dim, d[k]);
        value *= 2.0;
    }
    float a = max(1.0 - smoothstep(-0.5, 0.5, dim), 0.0) * u_off;
    a = max(a, 1.0 - smoothstep(-0.5, 0.5, lit));
    a = max(a, exp(-max(lit, 0.0) / 8.0) * 0.45 * step(lit, 40.0));
    if (u_sepOn > 0.5) {
        vec2 c = p - vec2(sepX + T * 0.5, 0.0);
        float s = u_colon > 0.5 ? min(max(abs(c.x), abs(c.y - DH * 0.34)), max(abs(c.x), abs(c.y - DH * 0.72))) : max(abs(c.x), abs(c.y - (DH - T * 0.5)));
        s -= T * 0.5;
        a = max(a, 1.0 - smoothstep(-0.5, 0.5, s));
        a = max(a, exp(-max(s, 0.0) / 8.0) * 0.45 * step(s, 40.0));
    }
    gl_FragColor = vec4(u_color, a);
}
`;

const EVARINGS = `// Design E2's rings of hexagons, lit from the inside out as the fuel use climbs. They change by uniform: no pixels.
//   u_color rgb, u_hot rgb of the outer rings, u_hotFrom the first hot ring, u_lit how many are lit, u_r0 the inner ring's radius px, u_step px between rings
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 v_uv;
uniform vec2 u_size;
uniform vec3 u_color;
uniform vec3 u_hot;
uniform float u_hotFrom;
uniform float u_lit;
uniform float u_r0;
uniform float u_step;
const float COS30 = 0.8660254;

void main() {
    vec2 p = abs(v_uv * u_size - u_size * 0.5);
    float d = max(p.y, p.x * COS30 + p.y * 0.5);     // 0 at the middle, a hexagon's flat side at its own distance
    float i = clamp(floor((d / COS30 - u_r0) / u_step + 0.5), 0.0, 6.0);     // the nearest ring
    float e = abs(d - (u_r0 + i * u_step) * COS30);
    bool on = i + 0.5 < u_lit;
    float half_ = on ? 2.5 : 1.0;
    float a = (1.0 - smoothstep(half_ - 0.75, half_ + 0.75, e)) * (on ? 1.0 : 0.2);
    if (on) a = max(a, exp(-e / 4.0) * 0.4);
    gl_FragColor = vec4(on && i >= u_hotFrom ? u_hot : u_color, a);
}
`;

module.exports = { evarings: EVARINGS, evaseven: EVASEVEN, evahazard: EVAHAZARD, evahex: EVAHEX, evacorners: EVACORNERS, evasolo: EVASOLO, shiftbar: SHIFTBAR, arc: ARC, revbar: REVBAR, lights: LIGHTS, fill: FILL, box: BOX, grid: GRID, evaseg: EVASEG, evaframe: EVAFRAME };
