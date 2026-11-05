#!/usr/bin/env python3
"""Fit EVA to the parts of the HUD and the cluster that are really visible: bakes its fonts and writes its layouts.

    uv run --no-project --with pillow python tools/eva_layout.py [x y w h]

x y w h is the visible area in HUD pixels, read off a photo of the Calibration grid layout (labels every 100 px).
Everything is designed on a 640x380 area and stretched to yours, with fonts scaled by the smaller side and never
under 14 px. After measuring the car this is the only thing to re-run. If it doesn't fit it says so and changes nothing.
The dash uses the same design on the cluster, in DASH_AREA below.

Writes apps/eva_hud/hud/fonts/*.json and hud/layouts/{eva,hud_only_sport,hud_only_comfort,hud_only_eco,alert,dash_eva,dash_alert}.json.

The fonts need MatissePro-EB.otf (MATISSE below, or the MATISSE environment variable): a commercial typeface,
so these atlases stay on the owner's machine and car. Never publish this app's hud/fonts/.
"""
import base64
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bake_fonts  # noqa: E402
from PIL import Image  # noqa: E402

APP = os.path.join(HERE, '..', 'apps', 'eva_hud', 'hud')
MATISSE = os.environ.get('MATISSE', os.path.expanduser('~/Projects/eva_hud_app/assets/fonts/MatissePro-EB.otf'))
BOLD, SEMI = 'BarlowCondensed-Bold.ttf', 'BarlowCondensed-SemiBold.ttf'
# the owner's car: the grid's 100/100 label reads 0/100, so the left edge is near x=122; the right edge assumes the
# area is centred on 400; a track title with its top at y=380 was cut off, so the bottom edge is above about 395
DEFAULT_AREA = (124, 100, 552, 280)
SHOW_MAGI = False                      # the owner took the three MAGI markers off for now; they use up the bottom row
MIN_FONT = 14                          # px: smaller doesn't read on the glass
LAYER_LIMIT = 8                        # cluster-render refuses a client's 9th layer
W_FRAME = 204                          # px: the gear's frame on the HUD

# BMW's own HUD content, x y w h, which nothing can remove and which draws over us: its speed with three digits, the red
# line above it and the limit sign to its left, read off photos of the owner's HUD with EVA's known layout beside them
BMW_ZONE = (132, 316, 216, 66)
# the NERV mark and leaf, from the owner's own image with its small curved motto taken out: stays on the owner's machine and car
LOGO_MASK = os.path.join(HERE, 'assets', 'nerv_mask.png')

# the owner's cluster (photo of the calibration grid): the hood hides the top corners, and BMW's own bottom row
# (range, time, temperature) stays open under y=640. The alert sits lower, where the hood leaves its full width.
DASH_AREA = (120, 36, 1680, 600)
DASH_ALERT_AREA = (120, 100, 1650, 515)
DASH_BG = {'id': 'bg', 'type': 'fill', 'x': 0, 'y': 0, 'w': 1920, 'h': 640, 'class': 'ambient', 'z': 0, 'color': 'black', 'keepInAlert': True}

UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
DIGITS = '0123456789'
PLAIN = UPPER + DIGITS + ' :/.-%·°'

# the alerts' texts; shared/eva_hud.js has the same strings
ALERTS = {
    'knock': {'rows': ['非常', '事態'], 'label': '退点火  KNOCK RETARD', 'status': 'KNOCK DETECTED // 異常検出'},
    'heat': {'rows': ['冷却', '過熱'], 'label': '冷却水  COOLANT', 'status': 'COOLANT ALERT // 臨界超過'},
    'boost': {'rows': ['増圧', '限界'], 'label': '増圧  BOOST', 'status': 'LIMIT EXCEEDED // 限界突破'},
    'fuel': {'rows': ['燃圧', '喪失'], 'label': '高圧燃料  HPFP', 'status': 'SUPPLY FAILURE // 生命線断絶'},
    'afr': {'rows': ['空燃比', '異常'], 'label': '空燃比  AFR', 'status': 'AFR DEVIATION // 混合気異常'},
    'multi': {'rows': ['多重警報', '発令'], 'label': '同時発生', 'status': '非常事態 / 冷却過熱 / 燃圧喪失 / 空燃比異常 / 増圧限界'},
}
STATUS_LINES = ('SYSTEM STATUS: STANDBY // 待命状態', 'SYSTEM STATUS: CAUTION // 後退操作', 'SYSTEM STATUS: OVER REV // 回転数超過',
                'SYSTEM STATUS: FULL THROTTLE // 全力全開', 'SYSTEM STATUS: SYNCHRONIZATION ACTIVE // 同期中', 'PREVIEW')
LABELS = ('SPEED  速度', 'BOOST  増圧', 'OIL  油温', 'WATER  水温', 'TORQUE  トルク', 'POWER  出力',
          'CURRENT GEAR', '主変速器', 'STANDBY MODE', '待命状態', 'REVERSE GEAR', '後退操作', '変速機 UNIT-01',
          'PEDAL  油門')
# the everyday layouts: the big word for P, R and N with the line over it (shared/eva_hud.js has the same), and their labels
WORDS = {'P': ('出撃待命', 'SORTIE STANDBY // 拘束具固定'), 'R': ('緊急撤退', 'RETREAT // 総員退避'), 'N': ('同期解除', 'SYNCHRO CUT // 駆動系切離')}
EVERYDAY = ('第3新東京市', '節電', '活動限界', '燃料消費', '左前', '右前', '左後', '右後')


def chars(*parts):
    """The characters of the strings, each once, always with a space (the fallback for a missing glyph)."""
    seen = {' '}
    for p in parts:
        seen.update(p)
    return ''.join(sorted(seen))


def canvas_parts(layout):
    return next(w for w in layout['widgets'] if w['type'] == 'evacanvas')['parts']


def clashes(parts):
    out = []
    for i, a in enumerate(parts):
        for b in parts[i + 1:]:
            if a['x'] < b['x'] + b['w'] and b['x'] < a['x'] + a['w'] and a['y'] < b['y'] + b['h'] and b['y'] < a['y'] + a['h']:
                out.append(a['id'] + '/' + b['id'])
    return out


def canvas(id_, parts, klass, z):
    """One image layer around the parts; their coordinates become relative to it."""
    left, top = min(p['x'] for p in parts), min(p['y'] for p in parts)
    right, bottom = max(p['x'] + p['w'] for p in parts), max(p['y'] + p['h'] for p in parts)
    for p in parts:
        p['x'] -= left
        p['y'] -= top
    return {'id': id_, 'type': 'evacanvas', 'x': left, 'y': top, 'w': right - left, 'h': bottom - top, 'class': klass, 'z': z, 'parts': parts}


def part_makers(cell, pre=''):
    """The functions that make a canvas's parts, given the fonts' cell heights."""
    def text(id_, s, font, top, left=None, right=None, cx=None, width=200, color='fg', pad=0, **more):
        """A text part placed by its top and its left edge, right edge or centre. pad grows the box for the glow."""
        if left is not None:
            bx, align = left, 'left'
        elif right is not None:
            bx, align = right - width, 'right'
        else:
            bx, align = round(cx - width / 2), 'center'
        out = {'id': id_, 'type': 'text', 'text': s, 'font': pre + font, 'x': round(bx - pad), 'y': round(top - pad),
               'w': round(width + 2 * pad), 'h': cell[font] + 2 * pad, 'align': align, 'color': color}
        if pad:
            out['offsetY'] = pad
            out['textX'] = {'left': pad, 'right': -pad, 'center': 0}[align]
            out['glow'] = True
        out.update(more)
        return out

    def label(id_, s, top, **kw):
        return text(id_, s, 'label', top, color='dim', **kw)

    def rule(id_, rx, ry, rw, rh, color):
        return {'id': id_, 'type': 'rule', 'x': round(rx), 'y': round(ry), 'w': round(rw), 'h': rh, 'color': color}

    return text, label, rule


def build_hud(fonts_dir, refuse, area, zone):
    """The HUD's three layouts, built around BMW's own speed in zone: the gear's frame to its right, the numbers above
    it, and the alert's title to its right. The HUD draws no speed: BMW's is the one on the glass, and a label names it."""
    x, y, w, h = area
    zx, zy, zw, zh = zone
    kx, ky = w / 640, h / 380
    k = min(kx, ky)
    F = lambda px: max(MIN_FONT, round(px * k))   # noqa: E731
    Pad = lambda v: max(1, round(v * k))     # noqa: E731
    right_edge = x + w
    tpad = Pad(14)
    title_x = zx + zw + 2 + tpad
    title_w = right_edge - title_x
    title_px = {n: min(title_w // n, h // 2) for n in (2, 3, 4)}
    rows_of = lambda n: chars(*[r for a in ALERTS.values() for r in a['rows'] if len(r) == n])  # noqa: E731
    table = [
        ('gear', MATISSE, round(F(189) * 1.45), DIGITS),
        ('gearjp', MATISSE, round(F(92) * 1.4), chars('予備出撃待命')),
        ('gearrev', BOLD, F(72), chars('REVERSE')),
        ('num42', BOLD, round(F(42) * 1.3), DIGITS + '.-'),
        ('num38', BOLD, round(F(38) * 1.15), DIGITS + '.-%:'),
        ('unit', SEMI, F(16), PLAIN),
        ('label', MATISSE, F(15), chars(PLAIN, *LABELS)),
        ('line', MATISSE, F(16), chars(PLAIN, *STATUS_LINES, *[a['status'] for a in ALERTS.values()])),
        ('k2', MATISSE, title_px[2], rows_of(2)),
        ('k3', MATISSE, title_px[3], rows_of(3)),
        ('k4', MATISSE, title_px[4], rows_of(4)),
        ('atag', SEMI, F(18), chars('MAGI SYSTEM WARNING PREVIEW')),
        ('aen', BOLD, F(38), UPPER + ' '),
        ('alabel', MATISSE, F(20), chars(PLAIN, *[a['label'] for a in ALERTS.values()])),
        ('avalue', BOLD, round(F(113) * 0.8), DIGITS + '.-×'),
        ('aunit', SEMI, F(38), chars('PSI°C')),
        ('alive', SEMI, F(21), PLAIN),
        # the everyday layouts, at the sizes the design has them on the glass
        ('word', MATISSE, 76, chars(*[s for s, _ in WORDS.values()])),
        ('small', MATISSE, MIN_FONT, chars(*EVERYDAY, *[sub for _, sub in WORDS.values()])),
        ('time70', MATISSE, 70, DIGITS + ':-'),
        ('num20', SEMI, 20, DIGITS + '- KM'),
        ('num21', BOLD, 21, DIGITS + '-'),
        ('num24', SEMI, 24, DIGITS + ':-'),
        ('num36', BOLD, 36, DIGITS + '.-'),
        ('num72', BOLD, 72, DIGITS + '-'),
    ]
    cell, baseline, glyphs = {}, {}, {}
    for font, file, size, cs in table:
        bake_fonts.bake(fonts_dir, font, file, size, cs)
        with open(os.path.join(fonts_dir, font + '.json')) as f:
            meta = json.load(f)
        cell[font], baseline[font], glyphs[font] = meta['cellHeight'], meta['baseline'], meta['glyphs']
    text, label, rule = part_makers(cell)

    def width(s, font):
        return sum(glyphs[font][c]['advance'] for c in s)

    rev_y = y + cell['line'] + 1
    rev_h = max(14, round(26 * ky))
    body_y = rev_y + rev_h + 4
    fx = zx + zw + 8
    fw = W_FRAME
    fh = y + h - body_y
    rx = fx + fw + 8
    rw = right_edge - rx
    lw = zx + zw - x
    spd_y = zy - cell['label'] - 2
    if rw < 90:
        refuse('the right column has only %d px' % rw)

    def shared():
        return [
            text('status', '{{statusline}}', 'line', y, left=x, width=w, hotWhen='now'),
            text('cap1', '{{gearcap}}', 'unit', body_y + 7, left=fx + 9, width=100, color='dim'),
            label('cap2', '{{gearcapjp}}', body_y + 7 + cell['unit'], left=fx + 9, width=100),
            label('cap3', '変速機 UNIT-01', body_y + fh - 7 - cell['label'], left=fx + 9, width=112),
            text('cap4', 'SYNC {{sync}}%', 'unit', body_y + fh - 7 - cell['unit'], right=fx + fw - 9, width=70, color='dim'),
            label('spd_l', 'SPEED  速度', spd_y, left=zx, width=zw),
            rule('spd_r', zx, zy - 2, zw, 1, 'rule'),
        ]

    def number(parts, id_, title, value, unit, top, left, width, font='num38', vw=66, vid=None):
        """A label with a value under it and the unit after the value."""
        pad = Pad(3)
        parts.append(label(id_ + '_l', title, top, left=left, width=width))
        vtop = top + cell['label'] + pad
        vid = vid or ('boost' if id_ == 'boost' else id_ + '_v')
        parts.append(text(vid, value, font, vtop, left=left + pad, width=vw, pad=pad))
        if unit:
            parts.append(text(id_ + '_u', unit, 'unit', vtop + cell[font] - cell['unit'], left=left + vw + 2 * pad + 2, width=width - vw - 2 * pad - 2, color='dim'))
        return top + cell['label'] + cell[font] + 2 * pad

    half = (lw - 8) // 2
    second = x + half + 8
    boost = lambda parts: number(parts, 'boost', 'BOOST  増圧', '{{boost}}', '{{u:boost}}', body_y, x, lw, 'num42', 90)  # noqa: E731

    # HUD + Dash: the temperatures in the right column
    parts = shared()
    t = boost(parts) + 6
    number(parts, 'torque', 'TRQ  トルク', '{{torque}}', '{{u:torque}}', t, x, half)
    number(parts, 'power', 'POWER  出力', '{{power}}', '{{u:power}}', t, second, half)
    row = fh / 2
    for i, (id_, title, value) in enumerate((('oil', 'OIL  油温', '{{oil}}'), ('water', 'WATER  水温', '{{coolant}}'))):
        number(parts, id_, title, value, '{{u:temp}}', round(body_y + i * row), rx, rw, 'num38', 60)

    # the HUD alone: every number on the left, and the instruments on the right
    solo_parts = shared()
    t = boost(solo_parts)
    t2 = number(solo_parts, 'oil', 'OIL  油温', '{{oil}}', '{{u:temp}}', t, x, half)
    number(solo_parts, 'water', 'WATER  水温', '{{coolant}}', '{{u:temp}}', t, second, half)
    t3 = number(solo_parts, 'torque', 'TRQ  トルク', '{{torque}}', '{{u:torque}}', t2, x, half)
    number(solo_parts, 'power', 'POWER  出力', '{{power}}', '{{u:power}}', t2, second, half)
    if t3 > spd_y - 1:
        refuse('the numbers on the left end at %d, the label of BMW speed starts at %d' % (t3, spd_y))
    # the right column: the pedal at the bottom, the NERV mark centred in what's left above it
    bar_h = 14
    pedal_y = y + h - cell['num38']
    bar_y = pedal_y - 3 - bar_h
    throttle_y = bar_y - 2 - cell['label']
    solo_parts.append(label('throttle_l', 'PEDAL  油門', throttle_y, left=rx, width=rw))
    solo_parts.append(text('pedal_v', '{{pedal}}%', 'num38', pedal_y, left=rx, width=rw))
    with Image.open(LOGO_MASK) as m:
        logo_h = round(rw * m.height / m.width)
    if body_y + logo_h + 4 > throttle_y:
        refuse('the NERV mark does not fit the right column')
    solo_parts.append({'id': 'logo', 'type': 'logo', 'src': 'logos/nerv.json', 'color': 'hot', 'x': rx,
                       'y': body_y + (throttle_y - body_y - logo_h) // 2, 'w': rw, 'h': logo_h,
                       'flicker': {'color': 'amber', 'gapMs': [20000, 45000], 'flashes': 3, 'phaseMs': 250}})
    instruments = {'id': 'inst', 'type': 'evasolo', 'x': rx, 'y': bar_y, 'w': rw, 'h': bar_h, 'class': 'content', 'z': 3, 'bar': [0, 0, rw, bar_h]}

    for ps in (parts, solo_parts):
        if clashes(ps):
            refuse('parts overlap: %r' % clashes(ps))
    about = 'Generated by tools/eva_layout.py for the visible area %d %d %d %d, around BMW speed at %d %d %d %d. Re-run that rather than editing this.' % (x, y, w, h, zx, zy, zw, zh)
    common = lambda: [  # noqa: E731
        {'id': 'rev', 'type': 'evaseg', 'x': x, 'y': rev_y, 'w': w, 'h': rev_h, 'segments': 28, 'class': 'content', 'z': 5},
        {'id': 'frame', 'type': 'evaframe', 'x': fx, 'y': body_y, 'w': fw, 'h': fh, 'class': 'content', 'z': 1},
        {'id': 'gear', 'type': 'evagear', 'x': fx + 6, 'y': body_y + 4, 'w': fw - 12, 'h': fh - 8, 'class': 'overlay', 'z': 8},
    ]
    eva = {'schemaVersion': 2, 'name': 'EVA', 'theme': 'eva', '_about': about, 'widgets': common() + [canvas('text', parts, 'overlay', 10)]}
    solo = {'schemaVersion': 2, 'name': 'HUD Only - SPORT', 'theme': 'eva', '_about': about, 'widgets': common() + [instruments, canvas('text', solo_parts, 'overlay', 10)]}

    # Comfort and Eco Pro, the everyday ones: nothing of the battle. Four corners, one big thing on the left, a little more
    # at the lower right, and a title card's big word in the empty right side while the car is in P, R or N.
    left, word_right = x + 12, right_edge - 12
    low_x = zx + zw + 24
    word_base = y + 200
    word_px = 76
    word_sx, word_sy = 0.86, 1.5

    def at(id_, s, font, base, **kw):
        """A text part placed by its baseline, as the design is."""
        return text(id_, s, font, base - baseline[font], **kw)

    def corners():
        return {'id': 'corners', 'type': 'evacorners', 'x': x, 'y': y + 2, 'w': w, 'h': h - 4, 'class': 'content', 'z': 1,
                'arm': 24, 'weight': 2, 'open': 5, 'lowerLeft': zy - 10 - (y + 2)}

    def word():
        """Its layer is scaled about its centre, so it is placed for where the text lands on the glass."""
        pad = 8
        iw = max(width(s, 'word') for s, _ in WORDS.values()) + 2 * pad
        ih = cell['word'] + 2 * pad
        cx = word_right - (iw / 2 - pad) * word_sx
        cy = word_base - (pad + baseline['word'] - ih / 2) * word_sy
        return {'id': 'word', 'type': 'evaword', 'x': round(cx - iw / 2), 'y': round(cy - ih / 2), 'w': iw, 'h': ih, 'font': 'word', 'pad': pad,
                'sx': word_sx, 'sy': word_sy, 'class': 'overlay', 'z': 8}

    def everyday():
        """What both have: the small mark, and the line over the big word."""
        mark_w = 44
        with Image.open(LOGO_MASK) as m:
            mark_h = round(mark_w * m.height / m.width)
        return [{'id': 'logo', 'type': 'logo', 'src': 'logos/nerv_small.json', 'color': 'dim', 'x': word_right - mark_w, 'y': y + 8, 'w': mark_w, 'h': mark_h},
                at('wordsub', '{{wordsub}}', 'small', word_base - round(word_px * word_sy * 0.9) - 5, right=word_right, width=300, color='soft', warnWhen='reverse')]

    # Comfort, the one used most: the time, the range and the tyres
    pad = 4
    ps = everyday() + [
        at('place', '第3新東京市', 'small', y + 36, left=left, width=100, color='dim'),
        at('time', '{{time}}', 'time70', y + 106, left=left - 2, width=width('00:00', 'time70') + 4, pad=pad),
        at('range', '{{range}} KM', 'num20', y + 142, left=left, width=120, color='soft'),
    ]
    for i, (corner, name) in enumerate((('fl', '左前'), ('fr', '右前'), ('rl', '左後'), ('rr', '右後'))):
        cx, cy = low_x + (i % 2) * 150, y + 246 + (i // 2) * 25
        warn = 'tyreLow:' + corner.upper()
        ps.append(at('tn_' + corner, name, 'small', cy, left=cx, width=28, color='dim', warnWhen=warn))
        ps.append(at('tp_' + corner, '{{tyreP:%s}}' % corner.upper(), 'num21', cy + 1, left=cx + 30, width=25, warnWhen=warn))
        ps.append(at('tt_' + corner, '{{tyreT:%s}}' % corner.upper(), 'unit', cy, left=cx + 56, width=44, color='dim', warnWhen=warn))
    if clashes(ps):
        refuse('Comfort: parts overlap: %r' % clashes(ps))
    comfort = {'schemaVersion': 2, 'name': 'HUD Only - COMFORT', 'theme': 'eva_calm', '_about': about, 'widgets': [corners(), word(), canvas('text', ps, 'overlay', 10)]}

    # Eco Pro: the range first, and the fuel use where Comfort has the tyres
    range_w = max(width(d * 3, 'num72') for d in DIGITS)
    ps = everyday() + [
        at('save', '節電', 'small', y + 29, left=left, width=60, color='soft'),
        at('limit', '活動限界', 'small', y + 49, left=left, width=80, color='dim'),
        at('range', '{{range}}', 'num72', y + 113, left=left - 2, width=range_w, pad=2),
        at('range_u', 'KM', 'num20', y + 113, left=left + range_w + 2, width=40, color='soft'),
        at('time', '{{time}}', 'num24', y + 148, left=left, width=80, color='soft'),
        at('burn_l', '燃料消費', 'small', y + 238, left=low_x, width=70, color='soft'),
        at('burn', '{{burn}}', 'num36', y + 272, left=low_x, width=56, pad=2),
        at('burn_u', 'L/100KM', 'unit', y + 272, left=low_x + 62, width=70, color='dim'),
    ]
    if clashes(ps):
        refuse('Eco Pro: parts overlap: %r' % clashes(ps))
    eco = {'schemaVersion': 2, 'name': 'HUD Only - ECO PRO', 'theme': 'eva_eco', '_about': about, 'widgets': [corners(), word(), canvas('text', ps, 'overlay', 10)]}

    # the alert: the numbers above BMW's speed, the title to its right
    ah = spd_y + cell['label'] - y
    at = lambda f, font: y + ah * f - cell[font] / 2  # noqa: E731
    cx = x + lw / 2
    uw = 44
    vbox = lw - uw - 4
    pad_en, pad_val = Pad(6), Pad(8)
    aparts = [
        text('tag', '{{a:tag}}', 'atag', at(0.05, 'atag'), cx=cx, width=lw, color='alert'),
        text('en', '{{a:en}}', 'aen', at(0.18, 'aen'), cx=cx, width=lw - 2 * pad_en, color='white', pad=pad_en),
        rule('r1', x, y + ah * 0.28, lw, max(1, round(3 * k)), 'alert'),
        text('lab', '{{a:label}}', 'alabel', at(0.35, 'alabel'), cx=cx, width=lw, color='alert'),
        text('val', '{{a:value}}', 'avalue', at(0.59, 'avalue'), cx=x + vbox / 2, width=vbox - 2 * pad_val, color='white', pad=pad_val),
        text('uni', '{{a:unit}}', 'aunit', at(0.59, 'aunit') + round(24 * k), left=x + lw - uw, width=uw, color='alert'),
        text('deg', '{{a:deg}}', 'aunit', at(0.59, 'aunit') - round(26 * k), left=x + lw - uw, width=uw, color='alert'),
        rule('r2', x, y + ah * 0.79, lw, max(1, round(2 * k)), 'alert'),
        text('sta', '{{a:status}}', 'line', at(0.86, 'line'), cx=cx, width=lw, color='alert'),
        text('liv', '{{a:live}}', 'alive', at(0.95, 'alive'), cx=cx, width=lw, color='live'),
    ]
    if clashes(aparts):
        refuse('alert parts overlap: %r' % clashes(aparts))
    title = {'x': title_x - tpad, 'y': y - tpad, 'w': title_w + 2 * tpad, 'h': h + 2 * tpad, 'pad': tpad}
    rows = {}
    for id_, a in ALERTS.items():
        sizes = [title_px[len(r_)] for r_ in a['rows']]
        top = tpad + (h - sum(sizes)) / 2
        placed = []
        for r_, size in zip(a['rows'], sizes):
            font = 'k%d' % len(r_)
            placed.append({'text': r_, 'font': font, 'y': round(top + (size - cell[font]) / 2)})
            top += size
        rows[id_] = placed
    alert = {'schemaVersion': 2, 'name': 'EVA alert', 'theme': 'eva', '_about': about, 'widgets': [canvas('text', aparts, 'alert', 7)], 'title': title, 'rows': rows}

    fixed = [(a['status'], 'line') for i, a in ALERTS.items() if i != 'multi'] + [(a['label'], 'alabel') for a in ALERTS.values()]
    fixed += [('非常事態 / 燃圧喪失 / 空燃比異常', 'line'), ('MULTIPLE ALERTS', 'aen'), ('FUEL CRITICAL', 'aen')]
    too_wide = [(s_, width(s_, f)) for s_, f in fixed if width(s_, f) > lw]
    if too_wide:
        refuse('these do not fit the %d px column: %r' % (lw, too_wide))
    if max(width(s_, 'line') for s_ in STATUS_LINES) > w:
        refuse('a status line does not fit %d px' % w)
    layers = len(solo['widgets']) + len(alert['widgets']) + 2
    if layers > LAYER_LIMIT:
        refuse('%d layers: cluster-render allows a client %d' % (layers, LAYER_LIMIT))
    print('EVA HUD fitted to %d %d %d %d around BMW speed: %d layers alone, %d + %d + %d text parts' % (x, y, w, h, layers, len(parts), len(solo_parts), len(aparts)))
    return eva, solo, alert, comfort, eco


def build(fonts_dir, refuse, area, alert_area=None, pre='', name='EVA', rev_inset=0, rev_gap=4, status_width=None,
          gear_scale=1, word_scale=1, speed_scale=1, num_scale=1, value_scale=1, background=None, weight=1):
    """One screen's two layouts, its fonts baked into fonts_dir with names starting with pre.
    rev_inset narrows the rev bar and status_width centres the status line, for a screen whose top corners are hidden."""
    x, y, w, h = area
    ax, ay, aw, ah = alert_area or area
    kx, ky = w / 640, h / 380
    k = min(kx, ky)
    akx, aky = aw / 640, ah / 380
    ak = min(akx, aky)
    W = lambda v: max(1, round(v * kx))      # noqa: E731  design widths -> HUD pixels
    F = lambda px: max(MIN_FONT, round(px * k))   # noqa: E731  font sizes, never too small to read on the glass
    Pad = lambda v: max(1, round(v * k))     # noqa: E731
    AW = lambda v: max(1, round(v * akx))    # noqa: E731  the same, for the alert's area
    AF = lambda px: max(MIN_FONT, round(px * ak))  # noqa: E731
    APad = lambda v: max(1, round(v * ak))   # noqa: E731

    two = chars(*[r for a in ALERTS.values() for r in a['rows'] if len(r) == 2])
    three = chars(*[r for a in ALERTS.values() for r in a['rows'] if len(r) == 3])
    four = chars(*[r for a in ALERTS.values() for r in a['rows'] if len(r) == 4])
    title_w = AW(352)    # the alert's left column
    title_px = {n: min(title_w // n, ah // 2) for n in (2, 3, 4)}
    table = [
        # the normal layout
        ('gear', MATISSE, round(F(189) * gear_scale), DIGITS),
        ('gearjp', MATISSE, round(F(92) * word_scale), chars('予備出撃待命')),
        ('gearrev', BOLD, round(F(72) * word_scale), chars('REVERSE')),
        ('speed', BOLD, round(F(104) * speed_scale), DIGITS + '-'),
        ('num42', BOLD, round(F(42) * num_scale), DIGITS + '.-'),
        ('num38', BOLD, round(F(38) * num_scale), DIGITS + '.-'),
        ('unit', SEMI, F(16), PLAIN),
        ('label', MATISSE, F(15), chars(PLAIN, *LABELS)),
        ('line', MATISSE, F(16), chars(PLAIN, *STATUS_LINES, *[a['status'] for a in ALERTS.values()])),
        # the alerts
        ('k2', MATISSE, title_px[2], two),
        ('k3', MATISSE, title_px[3], three),
        ('k4', MATISSE, title_px[4], four),
        ('atag', SEMI, AF(18), chars('MAGI SYSTEM WARNING PREVIEW')),
        ('aen', BOLD, AF(38), UPPER + ' '),
        ('alabel', MATISSE, AF(20), chars(PLAIN, *[a['label'] for a in ALERTS.values()])),
        ('avalue', BOLD, round(AF(113) * value_scale), DIGITS + '.-×'),
        ('aunit', SEMI, AF(38), chars('PSI°C')),
        ('alive', SEMI, AF(21), PLAIN),
    ]
    cell = {}
    for font, file, size, cs in table:
        bake_fonts.bake(fonts_dir, pre + font, file, size, cs)
        with open(os.path.join(fonts_dir, pre + font + '.json')) as f:
            cell[font] = json.load(f)['cellHeight']

    text, label, rule = part_makers(cell, pre)

    # top to bottom: status line, rev bar, the three columns, the MAGI row
    rev_y = y + cell['line'] + 1
    rev_h = max(14, round(26 * ky))
    bottom = y + h + 4
    magi_h = max(cell['unit'] + 6, round(26 * ky))
    magi_y = bottom - 2 - magi_h
    body_y = rev_y + rev_h + rev_gap
    body_h = (magi_y if SHOW_MAGI else bottom) - 4 - body_y
    fw = W(280)
    fx = x + (w - fw) // 2
    right_edge = x + w

    parts = [
        text('status', '{{statusline}}', 'line', y, cx=x + w / 2, width=status_width, hotWhen='now') if status_width
        else text('status', '{{statusline}}', 'line', y, left=x, width=w, hotWhen='now'),
        text('cap1', '{{gearcap}}', 'unit', body_y + 7, left=fx + 9, width=W(120), color='dim'),
        label('cap2', '{{gearcapjp}}', body_y + 7 + cell['unit'], left=fx + 9, width=W(120)),
        label('cap3', '変速機 UNIT-01', body_y + body_h - 7 - cell['label'], left=fx + 9, width=W(130)),
        text('cap4', 'SYNC {{sync}}%', 'unit', body_y + body_h - 7 - cell['unit'], right=fx + fw - 9, width=W(100), color='dim'),
    ]
    # left column, stacked
    lw = fx - 8 - x
    t = body_y
    parts.append(label('speed_l', 'SPEED  速度', t, left=x, width=lw))
    t += cell['label']
    pad = Pad(6)
    parts.append(text('speed', '{{speed}}', 'speed', t + pad, cx=x + lw / 2, width=lw - 2 * pad, pad=pad))
    t += cell['speed'] + 2 * pad
    parts.append(text('speed_u', '{{u:speed}}', 'unit', t, cx=x + lw / 2, width=lw, color='dim'))
    t += cell['unit'] + 3
    parts.append(rule('rule', x, t, lw, max(1, round(2 * k)), 'rule'))
    t += 5
    parts.append(label('boost_l', 'BOOST  増圧', t, left=x, width=lw))
    t += cell['label']
    pad = Pad(3)
    vw = W(92)
    parts.append(text('boost', '{{boost}}', 'num42', t + pad, left=x + pad, width=vw, pad=pad))
    parts.append(text('boost_u', '{{u:boost}}', 'unit', t + pad + cell['num42'] - cell['unit'], left=x + vw + 2 * pad + 2, width=lw - vw - 2 * pad - 2, color='dim'))
    if t + 2 * pad + cell['num42'] > body_y + body_h:
        refuse('the left column does not fit %d px' % body_h)
    # right column, four rows
    row_h = body_h / 4
    uw = W(38)
    pad = Pad(2)
    if cell['label'] + cell['num38'] + 2 * pad > row_h:
        refuse('a row of the right column does not fit %d px' % row_h)
    for i, (id_, title, value, unit) in enumerate((('oil', 'OIL  油温', '{{oil}}', '{{u:temp}}'), ('water', 'WATER  水温', '{{coolant}}', '{{u:temp}}'),
                                                   ('torque', 'TORQUE  トルク', '{{torque}}', '{{u:torque}}'), ('power', 'POWER  出力', '{{power}}', '{{u:power}}'))):
        top = round(body_y + i * row_h)
        parts.append(label(id_ + '_l', title, top, right=right_edge, width=right_edge - (fx + fw + 8)))
        vtop = top + cell['label'] + pad
        parts.append(text(id_ + '_v', value, 'num38', vtop, right=right_edge - uw - pad - 1, width=W(90), pad=pad))
        parts.append(text(id_ + '_u', unit, 'unit', vtop + cell['num38'] - cell['unit'], right=right_edge, width=uw, color='dim'))
    for i, (magi, source) in enumerate((('MELCHIOR·1', 'car'), ('BALTHASAR·2', 'diag'), ('CASPER·3', 'render')) if SHOW_MAGI else ()):
        cw = W(120)
        cx = x + w / 2 + (i - 1) * W(136)
        parts.append({'id': 'magi%d' % (i + 1), 'type': 'magi', 'text': magi, 'font': pre + 'unit', 'source': source,
                      'x': round(cx - cw / 2), 'y': magi_y, 'w': cw, 'h': magi_h})
    if clashes(parts):
        refuse('parts overlap: %r' % clashes(parts))
    about = 'Generated by tools/eva_layout.py for the visible area %d %d %d %d. Re-run that rather than editing this.' % (x, y, w, h)
    rev = {'id': 'rev', 'type': 'evaseg', 'x': x + rev_inset, 'y': rev_y, 'w': w - 2 * rev_inset, 'h': rev_h, 'segments': 28, 'class': 'content', 'z': 5}
    frame = {'id': 'frame', 'type': 'evaframe', 'x': fx, 'y': body_y, 'w': fw, 'h': body_h, 'class': 'content', 'z': 1}
    gear = {'id': 'gear', 'type': 'evagear', 'x': fx + 6, 'y': body_y + 4, 'w': fw - 12, 'h': body_h - 8, 'class': 'overlay', 'z': 8}
    if weight != 1:
        rev['gap'] = 2 * weight
        frame.update(weight=weight, inset=4 * weight, corner=18 * weight)
    if pre:
        gear['fontPrefix'] = pre
    widgets = ([dict(background)] if background else []) + [rev, frame, gear, canvas('text', parts, 'overlay', 10)]
    eva = {'schemaVersion': 2, 'name': name, 'theme': 'eva', '_about': about, 'widgets': widgets}

    # the alert: the title on the left, the numbers in a column on the right. Colours are the alert's own ('alert').
    col_x = ax + title_w + AW(19)
    col_w = ax + aw - col_x
    col_cx = col_x + col_w / 2
    at = lambda f, font: ay + ah * f - cell[font] / 2  # noqa: E731
    uw = AW(60)
    vbox = col_w - uw - AW(6)
    pad_en, pad_val = APad(6), APad(8)
    aparts = [
        text('tag', '{{a:tag}}', 'atag', at(0.05, 'atag'), cx=col_cx, width=col_w, color='alert'),
        text('en', '{{a:en}}', 'aen', at(0.16, 'aen'), cx=col_cx, width=col_w - 2 * pad_en, color='white', pad=pad_en),
        rule('r1', col_x, ay + ah * 0.245, col_w, max(1, round(3 * ak)), 'alert'),
        text('lab', '{{a:label}}', 'alabel', at(0.305, 'alabel'), cx=col_cx, width=col_w, color='alert'),
        text('val', '{{a:value}}', 'avalue', at(0.53, 'avalue'), cx=col_x + vbox / 2, width=vbox - 2 * pad_val, color='white', pad=pad_val),
        text('uni', '{{a:unit}}', 'aunit', at(0.53, 'aunit') + round(24 * ak), left=col_x + col_w - uw, width=uw, color='alert'),
        text('deg', '{{a:deg}}', 'aunit', at(0.53, 'aunit') - round(26 * ak), left=col_x + col_w - uw, width=uw, color='alert'),
        rule('r2', col_x, ay + ah * 0.735, col_w, max(1, round(2 * ak)), 'alert'),
        text('sta', '{{a:status}}', 'line', at(0.795, 'line'), cx=col_cx, width=col_w, color='alert'),
        text('liv', '{{a:live}}', 'alive', at(0.93, 'alive'), cx=col_cx, width=col_w, color='live'),
    ]
    if clashes(aparts):
        refuse('alert parts overlap: %r' % clashes(aparts))
    tpad = min(APad(14), ax, ay)
    title = {'x': ax - tpad, 'y': ay - tpad, 'w': title_w + 2 * tpad, 'h': ah + 2 * tpad, 'pad': tpad}
    rows = {}
    for id_, a in ALERTS.items():
        sizes = [title_px[len(r)] for r in a['rows']]
        top = tpad + (ah - sum(sizes)) / 2
        placed = []
        for r, size in zip(a['rows'], sizes):
            font = 'k%d' % len(r)
            placed.append({'text': r, 'font': pre + font, 'y': round(top + (size - cell[font]) / 2)})
            top += size
        rows[id_] = placed
    alert = {'schemaVersion': 2, 'name': name + ' alert', 'theme': 'eva', '_about': about, 'widgets': [canvas('text', aparts, 'alert', 7)], 'title': title, 'rows': rows}

    # a text that doesn't fit is cut off on the HUD: refuse it here rather than find it on the glass
    def width(s, font):
        with open(os.path.join(fonts_dir, pre + font + '.json')) as f:
            g = json.load(f)['glyphs']
        return sum(g[c]['advance'] for c in s)
    fixed = [(a['status'], 'line') for i, a in ALERTS.items() if i != 'multi'] + [(a['label'], 'alabel') for a in ALERTS.values()]
    fixed += [('非常事態 / 燃圧喪失 / 空燃比異常', 'line'), ('MULTIPLE ALERTS', 'aen'), ('FUEL CRITICAL', 'aen')]
    too_wide = [(s, width(s, f)) for s, f in fixed if width(s, f) > col_w]
    if too_wide:
        refuse('these do not fit the %d px column: %r' % (col_w, too_wide))
    if max(width(s, 'line') for s in STATUS_LINES) > (status_width or w):
        refuse('a status line does not fit %d px' % (status_width or w))
    layers = len(widgets) + len(alert['widgets']) + 2
    if layers > LAYER_LIMIT:
        refuse('%d layers: cluster-render allows a client %d' % (layers, LAYER_LIMIT))
    print('%s fitted to %d %d %d %d (scale %.3f x %.3f): %d layers, %d + %d text parts' % (name, x, y, w, h, kx, ky, layers, len(parts), len(aparts)))
    return eva, alert


def main(x, y, w, h):
    # baked aside and only moved into place once everything fits: a failed run leaves the app as it was
    fonts_dir = tempfile.mkdtemp(prefix='eva_fonts_')
    os.makedirs(os.path.join(APP, 'fonts'), exist_ok=True)
    os.makedirs(os.path.join(APP, 'layouts'), exist_ok=True)

    def refuse(why):
        shutil.rmtree(fonts_dir)
        sys.exit('nothing changed: ' + why)

    eva, solo, alert, comfort, eco = build_hud(fonts_dir, refuse, (x, y, w, h), BMW_ZONE)
    dash, dash_alert = build(fonts_dir, refuse, DASH_AREA, DASH_ALERT_AREA, pre='d_', name='EVA dash', rev_inset=160, rev_gap=24,
                             status_width=1100, gear_scale=1.7, word_scale=1.33, speed_scale=1.6, num_scale=1.45, value_scale=1.4,
                             background=DASH_BG, weight=2)
    for f in os.listdir(fonts_dir):
        shutil.move(os.path.join(fonts_dir, f), os.path.join(APP, 'fonts', f))
    shutil.rmtree(fonts_dir)
    os.makedirs(os.path.join(APP, 'logos'), exist_ok=True)
    for doc in (solo, comfort, eco):
        for logo in (p for p in canvas_parts(doc) if p['type'] == 'logo'):
            with Image.open(LOGO_MASK) as m:
                small = m.convert('L').resize((logo['w'], logo['h']), Image.LANCZOS)
            with open(os.path.join(APP, logo['src']), 'w', encoding='utf8') as f:
                json.dump({'w': logo['w'], 'h': logo['h'], 'alpha': base64.b64encode(small.tobytes()).decode('ascii')}, f)
    for gone in ('fonts/speed.json', 'fonts/song.json', 'fonts/clock.json', 'fonts/c_gear.json', 'logos/car_top.json'):      # nothing draws these any more
        stale = os.path.join(APP, gone)
        if os.path.exists(stale):
            os.remove(stale)
    stale_layout = os.path.join(APP, 'layouts', 'eva_solo.json')     # the old name of hud_only_sport
    if os.path.exists(stale_layout):
        os.remove(stale_layout)
    for layout, doc in (('eva', eva), ('hud_only_sport', solo), ('hud_only_comfort', comfort), ('hud_only_eco', eco), ('alert', alert), ('dash_eva', dash), ('dash_alert', dash_alert)):
        with open(os.path.join(APP, 'layouts', layout + '.json'), 'w', encoding='utf8') as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
            f.write('\n')


if __name__ == '__main__':
    args = [int(v) for v in sys.argv[1:]]
    main(*(args if len(args) == 4 else DEFAULT_AREA))
