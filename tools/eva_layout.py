#!/usr/bin/env python3
"""Fit EVA to the parts of the HUD and the cluster that are really visible: bakes its fonts and writes its layouts.

    uv run --no-project --with pillow python tools/eva_layout.py [x y w h]

x y w h is the visible area in HUD pixels, read off a photo of the Calibration grid layout (labels every 100 px).
Everything is designed on a 640x380 area and stretched to yours, with fonts scaled by the smaller side and never
under 14 px. After measuring the car this is the only thing to re-run. If it doesn't fit it says so and changes nothing.
The dash uses the same design on the cluster, in DASH_AREA below.

Writes apps/eva_hud/hud/fonts/*.json and hud/layouts/{eva,hud_only_sport,hud_only_comfort,hud_only_eco,alert,dash_eva,dash_alert,dash_a,dash_b,dash_d,dash_c1,dash_c2,dash_c3,dash_e1,dash_e2,dash_e3,dash_centre_alert}.json.

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
# The centre designs draw on cluster-render's map target, under BMW's gauges, so everything of BMW's stays on top and works. BMW's
# digital speed, its G meter or on-board computer, and the dark shading of its dial faces cover part of it, so they keep to the shape
# those leave bright (read off the owner's photos; the drive modes differ only in colour). l, t, r, b in the window's pixels.
MAP_SIZE = (1088, 480)
CLEAR_SHAPE = ((215, 14, 800, 100), (205, 100, 820, 340), (205, 340, 850, 452), (205, 452, 790, 466))
BMW_LINE = (0, 268, 268, 292)       # the white line BMW runs in from the left, under its digital speed
LOGO_CX = 540                       # the middle of BMW's model badge, over the window
# an alert keeps to the middle of that shape, its title's column cut to what its two rows need
MAP_ALERT_AREA = (216, 18, 584, 444)
MAP_TITLE_W = 286
# the seven-segment digits' block; shared/shaders.js EVASEVEN has the same sizes
SEVEN_W, SEVEN_H = 510, 180
# what MAGI says on design A: shared/eva_magi.js has the same strings
MAGI_WORDS = ('全会一致', '審議中', '否決')
MAGI_SUBS = ('UNANIMOUS // 出撃承認', 'DELIBERATING // 暖機中', 'DELIBERATING // 待機中', 'REJECTED // 油温上昇', 'REJECTED // 水温上昇', 'REJECTED // 回転数超過')
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
EVERYDAY = ('節電', '活動限界', '燃料消費')
PLACE = '第3新東京市'
# Comfort's lower right, picked in the menu (app.json's motto): same strings as shared/eva_hud.js. The first is NERV's motto,
# which the mark on the glass has cut out.
MOTTOS = {
    'heaven': ('神ハ天ニ在リ', '世ハ全テ事モ無シ'),
    'project': ('人類補完計画', '第3段階 進行中'),
    'angel': ('使徒反応無シ', 'パターン青 未検出'),
    'magi': ('MAGI 全会一致', '本日モ異常無シ'),
    'field': ('A.T.フィールド', '全周展開中'),
    'run': ('逃ゲチャダメダ', '逃ゲチャダメダ'),
}
# its English, from the menu's labels (shared/eva_hud.js has the same)
MOTTO_EN = {
    'heaven': "GOD'S IN HIS HEAVEN // ALL'S RIGHT WITH THE WORLD",
    'project': 'HUMAN INSTRUMENTALITY',
    'angel': 'NO ANGEL DETECTED',
    'magi': 'MAGI UNANIMOUS',
    'field': 'A.T. FIELD',
    'run': "MUSTN'T RUN AWAY",
}


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
        ('place', MATISSE, 28, chars(PLACE)),
        ('motto', MATISSE, 28, chars(*[line for m in MOTTOS.values() for line in m])),
        ('time70', MATISSE, 70, DIGITS + ':-'),
        ('num20', SEMI, 20, DIGITS + '- KM'),
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
        return [{'id': 'logo', 'type': 'logo', 'src': 'logos/nerv_small.json', 'color': 'dim', 'x': word_right - mark_w - 16, 'y': y + 22, 'w': mark_w, 'h': mark_h},
                at('wordsub', '{{wordsub}}', 'small', word_base - round(word_px * word_sy * 0.9) - 5, right=word_right, width=300, color='soft', warnWhen='reverse')]

    # Comfort, the one used most: the time, the range and the line from the menu. The time's colon breathes, so it has a layer of its
    # own and the digits go either side of it. This font's digits are all one width, so it never moves.
    pad = 4
    hours_w, colon_w = width('00', 'time70'), width(':', 'time70')
    clock_left = left - 2
    colon_pad = 8
    hh = at('hh', '{{hh}}', 'time70', y + 106, left=clock_left, width=hours_w + colon_pad, pad=pad)
    mm_pen = clock_left + hours_w + colon_w
    mm = at('mm', '{{mm}}', 'time70', y + 106, left=mm_pen, width=hours_w, pad=colon_pad)
    colon = {'id': 'colon', 'type': 'evacolon', 'x': clock_left + hours_w - colon_pad, 'y': hh['y'], 'w': colon_w + 2 * colon_pad, 'h': hh['h'], 'font': 'time70',
             'pad': colon_pad, 'offsetY': hh['offsetY'], 'class': 'overlay', 'z': 11}
    ps = everyday() + [
        at('place', PLACE, 'place', y + 36, left=left, width=width(PLACE, 'place'), color='soft'),
        hh,
        mm,
        at('range', '{{range}} KM', 'num20', y + 142, left=left, width=120, color='soft'),
    ]
    for i in range(2):
        ps.append(at('motto%d' % (i + 1), '{{motto%d}}' % (i + 1), 'motto', y + 241 + i * 31, left=low_x, width=max(width(m[i], 'motto') for m in MOTTOS.values()), color='soft'))
    if clashes(ps):
        refuse('Comfort: parts overlap: %r' % clashes(ps))
    comfort = {'schemaVersion': 2, 'name': 'HUD Only - COMFORT', 'theme': 'eva_calm', '_about': about, 'widgets': [corners(), word(), canvas('text', ps, 'overlay', 10), colon]}

    # Eco Pro: the range first, and the fuel use where Comfort has its line
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


def bake_table(fonts_dir, pre, table):
    """Bakes the fonts of a table, and gives their cell heights, baselines and glyphs."""
    cell, baseline, glyphs = {}, {}, {}
    for font, file, size, cs in table:
        bake_fonts.bake(fonts_dir, pre + font, file, size, cs)
        with open(os.path.join(fonts_dir, pre + font + '.json')) as f:
            meta = json.load(f)
        cell[font], baseline[font], glyphs[font] = meta['cellHeight'], meta['baseline'], meta['glyphs']
    return cell, baseline, glyphs


def build_alert(fonts_dir, refuse, alert_area, cell, pre, name, about, value_scale=1, title_w=None):
    """A screen's alert layout, its own fonts baked here. cell has the caller's fonts, among them its 'line'.
    title_w: the title's column in pixels, when the design's share of the width is too much for a narrow window."""
    ax, ay, aw, ah = alert_area
    akx, aky = aw / 640, ah / 380
    ak = min(akx, aky)
    AW = lambda v: max(1, round(v * akx))    # noqa: E731  design widths -> pixels
    AF = lambda px: max(MIN_FONT, round(px * ak))  # noqa: E731
    APad = lambda v: max(1, round(v * ak))   # noqa: E731
    two = chars(*[r for a in ALERTS.values() for r in a['rows'] if len(r) == 2])
    three = chars(*[r for a in ALERTS.values() for r in a['rows'] if len(r) == 3])
    four = chars(*[r for a in ALERTS.values() for r in a['rows'] if len(r) == 4])
    title_w = title_w or AW(352)    # the alert's left column
    title_px = {n: min(title_w // n, ah // 2) for n in (2, 3, 4)}
    own, _, _ = bake_table(fonts_dir, pre, [
        ('k2', MATISSE, title_px[2], two),
        ('k3', MATISSE, title_px[3], three),
        ('k4', MATISSE, title_px[4], four),
        ('atag', SEMI, AF(18), chars('MAGI SYSTEM WARNING PREVIEW')),
        ('aen', BOLD, AF(38), UPPER + ' '),
        ('alabel', MATISSE, AF(20), chars(PLAIN, *[a['label'] for a in ALERTS.values()])),
        ('avalue', BOLD, round(AF(113) * value_scale), DIGITS + '.-×'),
        ('aunit', SEMI, AF(38), chars('PSI°C')),
        ('alive', SEMI, AF(21), PLAIN),
    ])
    cell.update(own)
    text, _, rule = part_makers(cell, pre)

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
    return {'schemaVersion': 2, 'name': name, 'theme': 'eva', '_about': about, 'widgets': [canvas('text', aparts, 'alert', 7)], 'title': title, 'rows': rows}


def build(fonts_dir, refuse, area, alert_area=None, pre='', name='EVA', rev_inset=0, rev_gap=4, status_width=None,
          gear_scale=1, word_scale=1, speed_scale=1, num_scale=1, value_scale=1, background=None, weight=1):
    """One screen's two layouts, its fonts baked into fonts_dir with names starting with pre.
    rev_inset narrows the rev bar and status_width centres the status line, for a screen whose top corners are hidden."""
    x, y, w, h = area
    kx, ky = w / 640, h / 380
    k = min(kx, ky)
    W = lambda v: max(1, round(v * kx))      # noqa: E731  design widths -> HUD pixels
    F = lambda px: max(MIN_FONT, round(px * k))   # noqa: E731  font sizes, never too small to read on the glass
    Pad = lambda v: max(1, round(v * k))     # noqa: E731

    table = [
        # the normal layout
        ('gear', MATISSE, round(F(189) * gear_scale), DIGITS),
        ('gearjp', MATISSE, round(F(92) * word_scale), chars('予備', *[s for s, _ in WORDS.values()])),
        ('gearrev', BOLD, round(F(72) * word_scale), chars('REVERSE')),
        ('speed', BOLD, round(F(104) * speed_scale), DIGITS + '-'),
        ('num42', BOLD, round(F(42) * num_scale), DIGITS + '.-'),
        ('num38', BOLD, round(F(38) * num_scale), DIGITS + '.-'),
        ('unit', SEMI, F(16), PLAIN),
        ('label', MATISSE, F(15), chars(PLAIN, *LABELS)),
        ('line', MATISSE, F(16), chars(PLAIN, *STATUS_LINES, *[a['status'] for a in ALERTS.values()])),
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

    alert = build_alert(fonts_dir, refuse, alert_area or area, cell, pre, name + ' alert', about, value_scale)

    def width(s, font):
        with open(os.path.join(fonts_dir, pre + font + '.json')) as f:
            g = json.load(f)['glyphs']
        return sum(g[c]['advance'] for c in s)
    if max(width(s, 'line') for s in STATUS_LINES) > (status_width or w):
        refuse('a status line does not fit %d px' % (status_width or w))
    layers = len(widgets) + len(alert['widgets']) + 2
    if layers > LAYER_LIMIT:
        refuse('%d layers: cluster-render allows a client %d' % (layers, LAYER_LIMIT))
    print('%s fitted to %d %d %d %d (scale %.3f x %.3f): %d layers, %d + %d text parts' % (name, x, y, w, h, kx, ky, layers, len(parts), len(canvas_parts(alert))))
    return eva, alert


def kit(fonts_dir, pre, table):
    """A design's fonts, baked, and the functions that place its parts by their baselines."""
    cell, baseline, glyphs = bake_table(fonts_dir, pre, table)
    text, _, rule = part_makers(cell, pre)

    def at(id_, s, font, base, **kw):
        return text(id_, s, font, base - baseline[font], **kw)

    def tw(s, font):
        return sum(glyphs[font][c]['advance'] for c in s)
    return at, tw, rule, cell, baseline


def nerv(src, h, x, y, color='fg'):
    with Image.open(LOGO_MASK) as m:
        w = round(h * m.width / m.height)
    return {'id': 'logo', 'type': 'logo', 'src': 'logos/%s.json' % src, 'color': color, 'x': x, 'y': y, 'w': w, 'h': h}


def centre_ground(**more):
    return dict({'id': 'bg', 'type': 'evahex', 'x': 0, 'y': 0, 'w': MAP_SIZE[0], 'h': MAP_SIZE[1], 'r': 26, 'class': 'ambient', 'z': 0, 'keepInAlert': True}, **more)


def big_word(font, width, cell_h, cx, cy, pad=8):
    """The big word for P, R and N, as a layer of its own that fades in over where the line was. cx and cy: its middle."""
    w, h = width + 2 * pad, cell_h + 2 * pad
    return {'id': 'word', 'type': 'evaword', 'x': round(cx - w / 2), 'y': round(cy - h / 2), 'w': w, 'h': h, 'font': font, 'pad': pad, 'sx': 1, 'sy': 1, 'class': 'overlay', 'z': 8}


def in_shape(r):
    """Whether a rectangle, in the window's pixels, lies in the part of it BMW's gauges leave clear."""
    xs, ys = range(r['x'], r['x'] + r['w'] + 1, 4), range(r['y'], r['y'] + r['h'] + 1, 4)
    return all(any(a <= x <= c and b <= y <= d for a, b, c, d in CLEAR_SHAPE) for x in xs for y in ys)


def on_bmw_line(r):
    l, t, x2, b = BMW_LINE
    return r['x'] < x2 and r['x'] + r['w'] > l and r['y'] < b and r['y'] + r['h'] > t


def centre_design(name, theme, widgets, refuse):
    """Checks a centre design against what BMW's gauges leave clear."""
    for w in widgets:
        if w['id'] == 'bg':
            continue
        if w['type'] == 'evacanvas':
            if clashes(w['parts']):
                refuse('%s: parts overlap: %r' % (name, clashes(w['parts'])))
            for p in w['parts']:
                r = {'x': p['x'] + w['x'], 'y': p['y'] + w['y'], 'w': p['w'], 'h': p['h']}
                if not in_shape(r) or on_bmw_line(r):
                    refuse('%s: %s is outside what BMW leaves clear' % (name, p['id']))
            continue
        m = w.get('margin', 0)
        r = {'x': w['x'] + m, 'y': w['y'] + m, 'w': w['w'] - 2 * m, 'h': w['h'] - 2 * m}
        if not in_shape(r) or (w['type'] in ('evaseven', 'evaword', 'evacolon') and on_bmw_line(r)):
            refuse('%s: layer %s is outside what BMW leaves clear' % (name, w['id']))
    print('EVA dash %s fitted to the clear shape: %d layers' % (name, len(widgets)))
    about = 'Generated by tools/eva_layout.py for the clear shape between BMW\'s gauges. Re-run that rather than editing this.'
    return {'schemaVersion': 2, 'name': 'EVA dash ' + name, 'theme': theme, '_about': about, 'widgets': widgets}


def build_dash_a(fonts_dir, refuse):
    """Design A, in the clear shape: the status line and the rev bar across the top band, the gear and four readings in the
    narrow middle, MAGI's sortie check across the bottom band."""
    table = [
        ('gear', MATISSE, 216, DIGITS),
        ('gearjp', MATISSE, 88, chars('予備', *[s for s, _ in WORDS.values()])),
        ('status', MATISSE, 19, chars(PLAIN, *STATUS_LINES)),
        ('line', MATISSE, 17, chars(PLAIN, *[a['status'] for a in ALERTS.values()])),
        ('label', MATISSE, 23, chars('油温水温増圧出力', '主変速器待命状態後退操作')),
        ('cap', MATISSE, 19, chars('変速機 UNIT-01', 'MAGI SYSTEM // 出撃判定')),
        ('en', SEMI, 18, PLAIN),
        ('num', BOLD, 50, DIGITS + '.-'),
        ('magi', SEMI, 21, chars('BALTHASAR·2', 'CASPER·3', 'MELCHIOR·1')),
        ('vote', MATISSE, 40, chars('承認否決')),
        ('vote3', MATISSE, 36, chars('審議中')),
        ('watch', MATISSE, 20, chars('水温駆動油')),
        ('verdict', MATISSE, 50, chars(*MAGI_WORDS)),
        ('vsub', MATISSE, 16, chars(*MAGI_SUBS)),
    ]
    at, tw, rule, cell, baseline = kit(fonts_dir, 'm_', table)

    def plate(id_, magi, name, watch, px):
        h = 100
        return {'id': id_, 'type': 'plate', 'magi': magi, 'name': name, 'watch': watch, 'x': px, 'y': 366, 'w': 140, 'h': h, 'corner': 16,
                'fonts': {'name': 'm_magi', 'ok': 'm_vote', 'wait': 'm_vote3', 'watch': 'm_watch'},
                'offsets': {'name': 25 - baseline['magi'], 'ok': 66 - baseline['vote'], 'wait': 64 - baseline['vote3'], 'watch': h - 9 - baseline['watch']}}

    frame_x, frame_y, frame_w, frame_h = 206, 100, 296, 238
    parts = [
        at('status', '{{statusline}}', 'status', 40, left=218, width=580, hotWhen='now'),
        {'id': 'logo', 'type': 'logo', 'src': 'logos/nerv_small.json', 'color': 'fg', 'x': 752, 'y': 46, 'w': 44, 'h': 42},
        at('cap', '{{gearcapjp}}', 'label', 130, left=frame_x + 16, width=110, color='tag'),
        at('cap3', '変速機 UNIT-01', 'cap', 326, left=frame_x + 16, width=150, color='sub'),
        at('cap4', 'SYNC {{sync}}%', 'en', 326, right=frame_x + frame_w - 16, width=90, color='sub'),
        at('magi_t', 'MAGI SYSTEM // 出撃判定', 'cap', 358, left=210, width=400, color='sub'),
        plate('plate_m', 'melchior', 'MELCHIOR·1', '油温', 208),
        plate('plate_b', 'balthasar', 'BALTHASAR·2', '水温', 356),
        plate('plate_c', 'casper', 'CASPER·3', '駆動', 504),
        at('verdict', '{{magi:word}}', 'verdict', 412, cx=748, width=204, magiTone='main'),
        at('verdict_s', '{{magi:sub}}', 'vsub', 442, cx=748, width=204, magiTone='soft'),
    ]
    right_x, right_w, pad = 516, 300, 4
    for i, (id_, jp, en, value, unit, hot) in enumerate((
            ('oil', '油温', 'OIL', '{{oil}}', '{{u:temp}}', 'melchior'), ('water', '水温', 'WATER', '{{coolant}}', '{{u:temp}}', 'balthasar'),
            ('boost', '増圧', 'BOOST', '{{boost}}', '{{u:boost}}', None), ('power', '出力', 'POWER', '{{power}}', '{{u:power}}', None))):
        y = 94 + i * 58
        jw, ew = tw(jp, 'label'), tw(en, 'en')
        parts.append(at(id_ + '_l', jp, 'label', y + 38, left=right_x, width=jw, color='tag'))
        parts.append(at(id_ + '_e', en, 'en', y + 38, left=right_x + jw + 7, width=ew, color='sub'))
        vright = right_x + right_w - 36
        vleft = right_x + jw + 7 + ew + 4 + pad
        more = {'magiHot': hot} if hot else {}
        parts.append(at(id_ + '_v', value, 'num', y + 46, right=vright, width=vright - vleft, pad=pad, **more))
        parts.append(at(id_ + '_u', unit, 'en', y + 44, right=right_x + right_w, width=30, color='sub'))
        parts.append(rule(id_ + '_r', right_x, y + 54, right_w, 2, 'faint'))
    widgets = [
        centre_ground(),
        {'id': 'rev', 'type': 'evaseg', 'x': 218, 'y': 52, 'w': 526, 'h': 28, 'segments': 28, 'gap': 4, 'class': 'content', 'z': 5},
        {'id': 'frame', 'type': 'evaframe', 'x': frame_x, 'y': frame_y, 'w': frame_w, 'h': frame_h, 'class': 'content', 'z': 1, 'weight': 2, 'lineW': 2, 'inset': 6, 'corner': 24},
        {'id': 'gear', 'type': 'evagear', 'x': frame_x + 6, 'y': frame_y + 6, 'w': frame_w - 12, 'h': frame_h - 12, 'class': 'overlay', 'z': 8, 'fontPrefix': 'm_', 'words': True, 'wordPitch': 92},
        canvas('text', parts, 'overlay', 10),
    ]
    doc = centre_design('A', 'eva', widgets, refuse)
    about = 'Generated by tools/eva_layout.py for the middle of the window between BMW\'s gauges. Re-run that rather than editing this.'
    alert = build_alert(fonts_dir, refuse, MAP_ALERT_AREA, cell, 'm_', 'EVA centre alert', about, value_scale=1.15, title_w=MAP_TITLE_W)
    layers = len(widgets) + len(alert['widgets']) + 2
    if layers > LAYER_LIMIT:
        refuse('%d layers: cluster-render allows a client %d' % (layers, LAYER_LIMIT))
    return doc, alert


def lamp_part(id_, when, top, sub, px, py, w, h, tone, pre, baseline, top_font, sub_font='lampsub'):
    """A lamp: its colour when it is on, a faint outline when off. Its words can be tokens."""
    fonts = {'top': pre + top_font, 'sub': pre + sub_font}
    base = h / 2 + (2 if sub else 10)
    out = {'id': id_, 'type': 'lamp', 'when': when, 'top': top, 'tone': tone, 'x': px, 'y': py, 'w': w, 'h': h, 'corner': 12, 'fonts': fonts,
           'offsets': {'top': round(base) - baseline[top_font]}}
    if sub:
        out['sub'] = sub
        out['offsets']['sub'] = round(h / 2 + 30) - baseline[sub_font]
    return out


def build_dash_b(fonts_dir, refuse):
    """Design B, in the clear shape: the range or the time as the seven segments of the show's countdown in the middle, the
    lamps in what the top band and the upper left leave, the readings across the bottom band."""
    table = [
        ('title', MATISSE, 46, chars('活動限界まで', '現在時刻')),
        ('en', SEMI, 18, chars('ACTIVE RANGE REMAINING', 'LOCAL TIME')),
        ('unit', BOLD, 34, chars('KM')),
        ('gear', MATISSE, 74, chars(DIGITS, 'PRND-')),
        ('lamp', MATISSE, 28, chars('外部電源', '内部電源')),
        ('lampsub', SEMI, 18, chars('EXTERNAL', 'INTERNAL')),
        ('lampen', BOLD, 24, chars('SLOW', 'NORMAL', 'RACING')),
        ('label', MATISSE, 22, chars('油温水温増圧出力', '主変速器待命状態後退操作')),
        ('cen', SEMI, 15, PLAIN),
        ('num', BOLD, 50, DIGITS + '.-'),
        ('cunit', SEMI, 17, PLAIN),
    ]
    at, tw, rule, _, baseline = kit(fonts_dir, 'b_', table)
    lamp = lambda *a: lamp_part(*a, 'b_', baseline, 'lampen')    # noqa: E731
    digits_x, digits_y, margin = 272, 104, 18
    digits_w, digits_h = SEVEN_W, SEVEN_H
    parts = [
        at('title', '{{b:title}}', 'title', 88, left=218, width=280),
        at('title_e', '{{b:en}}', 'en', 38, right=798, width=230, color='sub'),
        at('unit', '{{b:unit}}', 'unit', digits_y + digits_h, right=820, width=38),
        lamp_part('lamp_power', 'always', '{{b:power}}', None, 272, 292, 136, 44, 'fg', 'b_', baseline, 'lamp'),
        lamp('lamp_s', 'eco', 'SLOW', None, 502, 48, 96, 38, 'blue'),
        lamp('lamp_n', 'comfort', 'NORMAL', None, 602, 48, 96, 38, 'ok'),
        lamp('lamp_r', 'sport', 'RACING', None, 702, 48, 96, 38, 'no'),
        at('cap', '{{gearcapjp}}', 'label', 374, left=208, width=92, color='tag'),
        at('gear', '{{gearshort}}', 'gear', 448, cx=254, width=90, hotWhen='now'),
    ]
    pad = 4
    for x, (id_, jp, en, value, unit, hot) in zip((306, 442, 578, 714), (
            ('oil', '油温', 'OIL', '{{oil}}', '{{u:temp}}', 'melchior'), ('water', '水温', 'WATER', '{{coolant}}', '{{u:temp}}', 'balthasar'),
            ('boost', '増圧', 'BOOST', '{{boost}}', '{{u:boost}}', None), ('power', '出力', 'POWER', '{{power}}', '{{u:power}}', None))):
        jw, ew = tw(jp, 'label'), tw(en, 'cen')
        parts.append(rule(id_ + '_s', x, 346, 2, 104, 'faint'))
        parts.append(at(id_ + '_l', jp, 'label', 374, left=x + 12, width=jw, color='tag'))
        parts.append(at(id_ + '_e', en, 'cen', 374, left=x + 12 + jw + 6, width=ew, color='sub'))
        more = {'magiHot': hot} if hot else {}
        parts.append(at(id_ + '_v', value, 'num', 444, right=x + 104, width=96, pad=pad, **more))
        parts.append(at(id_ + '_u', unit, 'cunit', 444, right=x + 134, width=26, color='sub'))
    widgets = [
        centre_ground(type='evahazard', stripe=20),
        {'id': 'seven', 'type': 'evaseven', 'x': digits_x - margin, 'y': digits_y - margin, 'w': digits_w + 2 * margin, 'h': digits_h + 2 * margin,
         'margin': margin, 'class': 'content', 'z': 5},
        canvas('text', parts, 'overlay', 10),
    ]
    del widgets[0]['r']
    return centre_design('B', 'eva', widgets, refuse)


def build_dash_c1(fonts_dir, refuse):
    """Comfort, the clock: the time fills the middle with its colon breathing, the wide bands hold the place, the range and the line."""
    all1, all2 = [m[0] for m in MOTTOS.values()], [m[1] for m in MOTTOS.values()]
    table = [
        ('place', MATISSE, 54, chars(PLACE)),
        ('time', BOLD, 240, DIGITS + ':-'),
        ('limit', MATISSE, 26, chars('活動限界')),
        ('range', BOLD, 54, DIGITS + '- KM'),
        ('motto', MATISSE, 44, chars(*all1, *all2)),
        ('sub', MATISSE, 17, chars(*MOTTO_EN.values(), *[s for _, s in WORDS.values()])),
        ('word', MATISSE, 86, chars(*[s for s, _ in WORDS.values()])),
    ]
    at, tw, rule, cell, baseline = kit(fonts_dir, 'c1_', table)
    hours_w, colon_w = tw('00', 'time'), tw(':', 'time')
    pad, colon_pad = 6, 8
    left = round(LOGO_CX - (2 * hours_w + colon_w) / 2)
    hh = at('hh', '{{hh}}', 'time', 320, left=left, width=hours_w + colon_pad, pad=pad, color='white')
    mm = at('mm', '{{mm}}', 'time', 320, left=left + hours_w + colon_w, width=hours_w, pad=colon_pad, color='white')
    colon = {'id': 'colon', 'type': 'evacolon', 'x': left + hours_w - colon_pad, 'y': hh['y'], 'w': colon_w + 2 * colon_pad, 'h': hh['h'], 'font': 'c1_time',
             'pad': colon_pad, 'offsetY': hh['offsetY'], 'class': 'overlay', 'z': 11}
    parts = [
        at('place', PLACE, 'place', 82, cx=LOGO_CX, width=tw(PLACE, 'place'), color='fg'),
        nerv('nerv_c', 58, 722, 26),
        hh,
        mm,
        at('limit', '活動限界', 'limit', 382, left=210, width=tw('活動限界', 'limit'), color='dim'),
        at('range', '{{range}} KM', 'range', 436, left=210, width=tw('999 KM', 'range') + 4, color='white'),
        at('motto1', '{{motto1}}', 'motto', 386, right=848, width=380, color='white', driving=True),
        at('motto2', '{{motto2}}', 'motto', 434, right=848, width=380, color='white', driving=True),
        at('msub', '{{msub}}', 'sub', 461, right=788, width=560, color='fg', warnWhen='reverse'),
    ]
    word_w = max(tw(s, 'word') for s, _ in WORDS.values())
    widgets = [centre_ground(lines=0), big_word('c1_word', word_w, cell['word'], 848 - word_w / 2 - 8, 392), canvas('text', parts, 'overlay', 10), colon]
    return centre_design('C1', 'eva_orange_white', widgets, refuse)


def motto_rows(fonts_dir, pre, row, width, most):
    """A font for one row of each line, as big as fits the width. Gives each one's name, cell height and baseline."""
    out = {}
    for key, m in MOTTOS.items():
        text = m[row]
        name = '%sr%d_%s' % (pre, row + 1, key)
        px = 100
        for _ in range(2):      # a font's advance grows a little unevenly with its size
            bake_fonts.bake(fonts_dir, name, MATISSE, px, chars(text))
            with open(os.path.join(fonts_dir, name + '.json')) as f:
                meta = json.load(f)
            wide = sum(meta['glyphs'][c]['advance'] for c in text)
            px = min(most, int(px * width / wide))
        bake_fonts.bake(fonts_dir, name, MATISSE, px, chars(text))
        with open(os.path.join(fonts_dir, name + '.json')) as f:
            meta = json.load(f)
        if sum(meta['glyphs'][c]['advance'] for c in text) > width:
            px -= 2
            bake_fonts.bake(fonts_dir, name, MATISSE, px, chars(text))
            with open(os.path.join(fonts_dir, name + '.json')) as f:
                meta = json.load(f)
        out[key] = {'font': name, 'cell': meta['cellHeight'], 'baseline': meta['baseline']}
    return out


def line_part(id_, text, rows, left, width, base):
    """One row of the line: its box takes in every line's font, and each font says where it starts in the box."""
    top = base - max(r['baseline'] for r in rows.values())
    bottom = max(base - r['baseline'] + r['cell'] for r in rows.values())
    by = {k: {'font': r['font'], 'offsetY': base - r['baseline'] - top} for k, r in rows.items()}
    return {'id': id_, 'type': 'text', 'text': text, 'font': rows['heaven']['font'], 'x': left, 'y': top, 'w': width, 'h': bottom - top, 'align': 'left',
            'color': 'white', 'driving': True, 'byMotto': by}


def build_dash_c2(fonts_dir, refuse):
    """Comfort, the title card: the line follows the clear shape, its first row in the middle and the second across the wide band."""
    table = [
        ('place', MATISSE, 36, chars(PLACE)),
        ('time', BOLD, 62, DIGITS + ':-'),
        ('range', BOLD, 38, DIGITS + '- KM'),
        ('sub', MATISSE, 17, chars(*MOTTO_EN.values(), *[s for _, s in WORDS.values()])),
        ('word', MATISSE, 146, chars(*[s for s, _ in WORDS.values()])),
    ]
    at, tw, rule, cell, baseline = kit(fonts_dir, 'c2_', table)
    first, second = motto_rows(fonts_dir, 'c2_', 0, 608, 112), motto_rows(fonts_dir, 'c2_', 1, 640, 108)
    parts = [
        at('range', '{{range}} KM', 'range', 70, left=218, width=tw('999 KM', 'range') + 4, color='white'),
        nerv('nerv_s', 46, 368, 28),
        at('place', PLACE, 'place', 70, cx=LOGO_CX, width=tw(PLACE, 'place'), color='fg'),
        at('time', '{{time}}', 'time', 72, right=798, width=tw('00:00', 'time') + 4, color='white'),
        line_part('row1', '{{motto1}}', first, 208, 608, 232),
        at('msub', '{{msub}}', 'sub', 312, left=274, width=544, color='fg', warnWhen='reverse'),
        line_part('row2', '{{motto2}}', second, 208, 640, 436),
    ]
    word_w = max(tw(s, 'word') for s, _ in WORDS.values())
    widgets = [centre_ground(lines=0), big_word('c2_word', word_w, cell['word'], 516, 190), canvas('text', parts, 'overlay', 10)]
    return centre_design('C2', 'eva_orange_white', widgets, refuse)


def build_dash_c3(fonts_dir, refuse):
    """Comfort, the whole cluster: the time and the range on the left, a giant speed in the middle, the line set vertically on
    the right. It stops above BMW's bottom row and clear of the hood, as design D does, and shows the original's alert."""
    upright = lambda s: s.replace(' ', '').replace('ー', '｜')    # noqa: E731
    table = [
        ('place', MATISSE, 62, chars(PLACE)),
        ('time', BOLD, 200, DIGITS + ':-'),
        ('limit', MATISSE, 36, chars('活動限界')),
        ('range', BOLD, 110, DIGITS + '-'),
        ('km', BOLD, 42, 'KM '),
        ('speed', BOLD, 360, DIGITS + '-'),
        ('small', BOLD, 42, DIGITS + '- KM/H'),
        ('kmh', SEMI, 36, 'KM/H '),
        ('v', MATISSE, 50, chars(*[upright(c) for m in MOTTOS.values() for c in m])),
        ('sub', MATISSE, 34, chars(*[s for _, s in WORDS.values()])),
        ('word', MATISSE, 160, chars(*[s for s, _ in WORDS.values()])),
    ]
    at, tw, rule, cell, baseline = kit(fonts_dir, 'c3_', table)
    hours_w, colon_w = tw('00', 'time'), tw(':', 'time')
    pad, colon_pad, left = 5, 6, 156
    hh = at('hh', '{{hh}}', 'time', 372, left=left, width=hours_w + colon_pad, pad=pad)
    mm = at('mm', '{{mm}}', 'time', 372, left=left + hours_w + colon_w, width=hours_w, pad=colon_pad)
    colon = {'id': 'colon', 'type': 'evacolon', 'x': left + hours_w - colon_pad, 'y': hh['y'], 'w': colon_w + 2 * colon_pad, 'h': hh['h'], 'font': 'c3_time',
             'pad': colon_pad, 'offsetY': hh['offsetY'], 'class': 'overlay', 'z': 11}
    range_w = tw('999', 'range')
    parts = [
        at('place', PLACE, 'place', 176, left=160, width=tw(PLACE, 'place'), color='fg'),
        nerv('nerv_l', 76, 1400, 112),
        hh,
        mm,
        at('limit', '活動限界', 'limit', 448, left=160, width=tw('活動限界', 'limit'), color='dim'),
        at('range', '{{range}}', 'range', 590, left=160, width=range_w, color='fg'),
        at('range_u', 'KM', 'km', 590, left=160 + range_w + 10, width=tw('KM', 'km'), color='dim'),
        at('sub', '{{wordsub}}', 'sub', 142, cx=960, width=760, color='soft', warnWhen='reverse'),
        at('speed', '{{speed}}', 'speed', 430, cx=960, width=640, pad=12, color='white', driving=True),
        at('kmh', 'KM/H', 'kmh', 486, cx=960, width=100, color='dim'),
        at('small', '{{speed}} KM/H', 'small', 606, cx=960, width=300, color='white', parked=True),
    ]
    cells = 9
    for r, x in ((1, 1700), (2, 1616)):
        for i in range(cells):
            parts.append(at('v%d_%d' % (r, i), '{{mv:%d:%d}}' % (r, i), 'v', 166 + i * 56, cx=x, width=60, color='white' if r == 1 else 'soft'))
    word_w = max(tw(s, 'word') for s, _ in WORDS.values())
    widgets = [
        {'id': 'bg', 'type': 'evahex', 'x': 0, 'y': 0, 'w': 1920, 'h': 640, 'r': 30, 'class': 'ambient', 'z': 0, 'keepInAlert': True, 'lines': 0},
        {'id': 'corners', 'type': 'evacorners', 'x': 130, 'y': 100, 'w': 1630, 'h': 526, 'class': 'content', 'z': 1, 'arm': 56, 'weight': 5, 'open': 0, 'lowerLeft': 526},
        {'id': 'rev', 'type': 'evaseg', 'x': 660, 'y': 526, 'w': 600, 'h': 22, 'segments': 28, 'gap': 4, 'class': 'content', 'z': 5},
        big_word('c3_word', word_w, cell['word'], 960, 320),
        canvas('text', parts, 'overlay', 10),
        colon,
    ]
    if clashes(parts):
        refuse('design C3: parts overlap: %r' % clashes(parts))
    about = 'Generated by tools/eva_layout.py for the whole cluster, down to y=640. Re-run that rather than editing this.'
    print('EVA dash C3 fitted to the cluster: %d layers, %d text parts' % (len(widgets), len(parts)))
    return {'schemaVersion': 2, 'name': 'EVA dash C3', 'theme': 'eva_orange_white', '_about': about, 'widgets': widgets}


def build_dash_e1(fonts_dir, refuse):
    """Eco Pro, the fuel use: the big number in the middle, a bar across the wide band that fills as it climbs, the rest under it."""
    table = [
        ('save', MATISSE, 56, chars('節電')),
        ('label', MATISSE, 36, chars('燃料消費')),
        ('sub', MATISSE, 14, chars(*[s for _, s in WORDS.values()])),
        ('burn', BOLD, 220, DIGITS + '.-'),
        ('unit', SEMI, 32, 'L/100KM '),
        ('limit', MATISSE, 24, chars('活動限界')),
        ('range', BOLD, 54, DIGITS + '-'),
        ('km', SEMI, 24, 'KM '),
        ('time', BOLD, 62, DIGITS + ':-'),
        ('motto', MATISSE, 34, chars(*[c for m in MOTTOS.values() for c in m])),
        ('word', MATISSE, 146, chars(*[s for s, _ in WORDS.values()])),
    ]
    at, tw, rule, cell, baseline = kit(fonts_dir, 'e1_', table)
    range_w = tw('999', 'range')
    parts = [
        at('save', '節電', 'save', 84, left=218, width=tw('節電', 'save')),
        at('burn_l', '燃料消費', 'label', 84, left=342, width=tw('燃料消費', 'label'), color='soft'),
        at('sub', '{{wordsub}}', 'sub', 84, left=494, width=232, color='soft', warnWhen='reverse'),
        nerv('nerv_c', 58, 736, 26),
        at('burn', '{{burn}}', 'burn', 326, right=636, width=360, pad=8, driving=True),
        at('burn_u', 'L/100KM', 'unit', 326, left=650, width=166, color='dim', driving=True),
        at('limit', '活動限界', 'limit', 402, left=210, width=tw('活動限界', 'limit'), color='soft'),
        at('range', '{{range}}', 'range', 458, left=210, width=range_w),
        at('range_u', 'KM', 'km', 458, left=210 + range_w + 8, width=tw('KM', 'km'), color='dim'),
        at('time', '{{time}}', 'time', 458, left=372, width=tw('00:00', 'time') + 4, color='soft'),
        at('motto1', '{{motto1}}', 'motto', 404, right=848, width=320, color='white', driving=True),
        at('motto2', '{{motto2}}', 'motto', 446, right=848, width=320, color='white', driving=True),
    ]
    word_w = max(tw(s, 'word') for s, _ in WORDS.values())
    widgets = [
        centre_ground(lines=0),
        {'id': 'bar', 'type': 'evaseg', 'source': 'burn', 'x': 208, 'y': 342, 'w': 640, 'h': 22, 'segments': 28, 'gap': 4, 'class': 'content', 'z': 5},
        big_word('e1_word', word_w, cell['word'], 516, 190),
        canvas('text', parts, 'overlay', 10),
    ]
    return centre_design('E1', 'eva_eco', widgets, refuse)


def build_dash_e2(fonts_dir, refuse):
    """Eco Pro, the rings: hexagons in the middle that light outward as the fuel use climbs, the range and the time in the band under them."""
    table = [
        ('save', MATISSE, 54, chars('節電')),
        ('limit', MATISSE, 24, chars('活動限界', '現在時刻')),
        ('burnl', MATISSE, 25, chars('燃料消費')),
        ('burn', BOLD, 92, DIGITS + '.-'),
        ('unit', SEMI, 21, 'L/100KM '),
        ('sub', MATISSE, 20, chars(*[s for _, s in WORDS.values()])),
        ('range', BOLD, 66, DIGITS + '-'),
        ('km', SEMI, 26, 'KM '),
        ('time', BOLD, 66, DIGITS + ':-'),
        ('motto', MATISSE, 30, chars(*[c for m in MOTTOS.values() for c in m])),
        ('lamp', MATISSE, 26, chars('外部電源', '内部電源')),
        ('lampsub', SEMI, 16, chars('EXTERNAL', 'INTERNAL')),
        ('word', MATISSE, 72, chars(*[s for s, _ in WORDS.values()])),
    ]
    at, tw, rule, cell, baseline = kit(fonts_dir, 'e2_', table)
    cx, cy = 516, 204
    r0, step, rings = 92, 19, 7
    outer = r0 + step * (rings - 1)
    rw, rh = 2 * outer + 12, round(outer * 1.7320508) + 12
    range_w = tw('999', 'range')
    parts = [
        at('save', '節電', 'save', 78, left=218, width=tw('節電', 'save')),
        nerv('nerv_c', 58, 736, 22),
        lamp_part('lamp_power', 'always', '{{b:power}}', None, 218, 96, 112, 44, 'fg', 'e2_', baseline, 'lamp'),
        at('burn_l', '燃料消費', 'burnl', cy - 48, cx=cx, width=130, color='soft', driving=True),
        at('burn', '{{burn}}', 'burn', cy + 34, cx=cx, width=176, pad=4, driving=True),
        at('burn_u', 'L/100KM', 'unit', cy + 66, cx=cx, width=110, color='dim', driving=True),
        at('sub', '{{wordsub}}', 'sub', cy + 122, cx=cx, width=420, color='soft', warnWhen='reverse'),
        at('limit', '活動限界', 'limit', 384, left=210, width=tw('活動限界', 'limit'), color='soft'),
        at('range', '{{range}}', 'range', 450, left=210, width=range_w),
        at('range_u', 'KM', 'km', 450, left=210 + range_w + 8, width=tw('KM', 'km'), color='dim'),
        at('now', '現在時刻', 'limit', 384, right=848, width=tw('現在時刻', 'limit'), color='soft'),
        at('time', '{{time}}', 'time', 450, right=848, width=tw('00:00', 'time') + 4),
        at('motto1', '{{motto1}}', 'motto', 418, cx=516, width=300, color='white', driving=True),
        at('motto2', '{{motto2}}', 'motto', 456, cx=516, width=300, color='white', driving=True),
    ]
    word_w = max(tw(s, 'word') for s, _ in WORDS.values())
    widgets = [
        centre_ground(lines=0),
        {'id': 'rings', 'type': 'evarings', 'x': cx - rw // 2, 'y': cy - rh // 2, 'w': rw, 'h': rh, 'r0': r0, 'step': step, 'class': 'content', 'z': 5},
        big_word('e2_word', word_w, cell['word'], cx, cy),
        canvas('text', parts, 'overlay', 10),
    ]
    return centre_design('E2', 'eva_eco', widgets, refuse)


def build_dash_e3(fonts_dir, refuse):
    """Eco Pro, the whole cluster: design D's skeleton, with the range in seven segments where the gear was and the fuel use under the
    speed. It stops above BMW's bottom row and clear of the hood, and shows the original's alert."""
    table = [
        ('line', MATISSE, 30, chars(PLAIN, *STATUS_LINES)),
        ('label', MATISSE, 30, chars('速度', '燃料消費', '現在時刻')),
        ('title', MATISSE, 40, chars('活動限界まで')),
        ('en', SEMI, 24, PLAIN),
        ('ten', SEMI, 21, chars('ACTIVE RANGE REMAINING')),
        ('save', MATISSE, 56, chars('節電')),
        ('speed', BOLD, 210, DIGITS + '-'),
        ('burn', BOLD, 150, DIGITS + '.-'),
        ('km', BOLD, 34, 'KM '),
        ('time', BOLD, 132, DIGITS + ':-'),
        ('motto', MATISSE, 58, chars(*[c for m in MOTTOS.values() for c in m])),
        ('sub', MATISSE, 24, chars(*[s for _, s in WORDS.values()])),
        ('word', MATISSE, 92, chars(*[s for s, _ in WORDS.values()])),
        ('lamp', MATISSE, 28, chars('外部電源', '内部電源')),
        ('lampsub', SEMI, 18, chars('EXTERNAL', 'INTERNAL')),
        ('lampen', BOLD, 28, chars('SLOW', 'NORMAL', 'RACING')),
    ]
    at, tw, rule, cell, baseline = kit(fonts_dir, 'e3_', table)
    left_x, left_r, value_r = 120, 574, 520
    frame_x, frame_y, frame_w, frame_h = 592, 126, 736, 512
    right_x, margin = 1370, 18
    digits_x, digits_y = 960 - SEVEN_W // 2, 210
    lamp = lambda id_, when, top, px, py, w, h, tone, sub=None: lamp_part(id_, when, top, sub, px, py, w, h, tone, 'e3_', baseline, 'lamp' if sub else 'lampen')    # noqa: E731
    parts = [
        at('status', '{{statusline}}', 'line', 56, cx=960, width=1100),
        nerv('nerv_d', 62, 509, 116),
        at('speed_l', '速度', 'label', 158, left=left_x, width=tw('速度', 'label'), color='soft'),
        at('speed_e', 'SPEED', 'en', 158, left=left_x + tw('速度', 'label') + 10, width=tw('SPEED', 'en'), color='dim'),
        at('speed_v', '{{speed}}', 'speed', 362, right=value_r, width=360, pad=8),
        at('speed_u', '{{u:speed}}', 'en', 372, right=left_r, width=46, color='dim'),
        rule('rule', left_x, 386, left_r - left_x, 2, 'wire'),
        at('burn_l', '燃料消費', 'label', 424, left=left_x, width=tw('燃料消費', 'label'), color='soft'),
        at('burn_v', '{{burn}}', 'burn', 590, right=486, width=360, pad=6),
        at('burn_u', 'L/100KM', 'en', 590, right=left_r, width=80, color='dim'),
        at('title', '活動限界まで', 'title', 192, left=frame_x + 28, width=tw('活動限界まで', 'title'), color='white'),
        at('title_e', 'ACTIVE RANGE REMAINING', 'ten', 188, right=frame_x + frame_w - 24, width=tw('ACTIVE RANGE REMAINING', 'ten'), color='dim'),
        at('unit', 'KM', 'km', digits_y + SEVEN_H, right=frame_x + frame_w - 24, width=50, color='dim'),
        at('motto1', '{{motto1}}', 'motto', 490, cx=960, width=680, color='white', driving=True),
        at('motto2', '{{motto2}}', 'motto', 564, cx=960, width=680, color='soft', driving=True),
        at('sub', '{{wordsub}}', 'sub', 612, cx=960, width=680, color='soft', warnWhen='reverse'),
        at('save', '節電', 'save', 192, left=right_x, width=tw('節電', 'save')),
        at('now', '現在時刻', 'label', 262, left=right_x, width=tw('現在時刻', 'label'), color='soft'),
        at('time', '{{time}}', 'time', 372, right=1800, width=tw('00:00', 'time') + 6),
        lamp('lamp_ext', 'parked', '外部電源', right_x, 396, 210, 92, 'amber', sub='EXTERNAL'),
        lamp('lamp_int', 'moving', '内部電源', right_x + 220, 396, 210, 92, 'fg', sub='INTERNAL'),
        lamp('lamp_s', 'eco', 'SLOW', right_x, 500, 136, 64, 'fg'),
        lamp('lamp_n', 'comfort', 'NORMAL', right_x + 147, 500, 136, 64, 'ok'),
        lamp('lamp_r', 'sport', 'RACING', right_x + 294, 500, 136, 64, 'no'),
    ]
    if clashes(parts):
        refuse('design E3: parts overlap: %r' % clashes(parts))
    word_w = max(tw(s, 'word') for s, _ in WORDS.values())
    widgets = [
        {'id': 'bg', 'type': 'evahex', 'x': 0, 'y': 0, 'w': 1920, 'h': 640, 'r': 30, 'class': 'ambient', 'z': 0, 'keepInAlert': True},
        {'id': 'rev', 'type': 'evaseg', 'x': 280, 'y': 72, 'w': 1360, 'h': 38, 'segments': 28, 'gap': 4, 'class': 'content', 'z': 5},
        {'id': 'frame', 'type': 'evaframe', 'x': frame_x, 'y': frame_y, 'w': frame_w, 'h': frame_h, 'class': 'content', 'z': 1, 'weight': 2, 'lineW': 2, 'inset': 8, 'corner': 40},
        {'id': 'seven', 'type': 'evaseven', 'rangeOnly': True, 'x': digits_x - margin, 'y': digits_y - margin, 'w': SEVEN_W + 2 * margin, 'h': SEVEN_H + 2 * margin, 'margin': margin, 'class': 'content', 'z': 5},
        big_word('e3_word', word_w, cell['word'], 960, 510),
        canvas('text', parts, 'overlay', 10),
    ]
    about = 'Generated by tools/eva_layout.py for the whole cluster, down to y=640. Re-run that rather than editing this.'
    print('EVA dash E3 fitted to the cluster: %d layers, %d text parts' % (len(widgets), len(parts)))
    return {'schemaVersion': 2, 'name': 'EVA dash E3', 'theme': 'eva_eco', '_about': about, 'widgets': widgets}


def build_dash_d(fonts_dir, refuse):
    """Design D of the dash, on the whole cluster, stopping above BMW's bottom row and clear of the hood: the speed and the
    live revs on the left, the giant gear in the middle, a column of readings on the right. It shows the original's alert."""
    table = [
        ('line', MATISSE, 30, chars(PLAIN, *STATUS_LINES)),
        ('label', MATISSE, 30, chars('速度回転数油温水温増圧出力活動限界', '主変速器待命状態後退操作')),
        ('cap', MATISSE, 25, chars('変速機 UNIT-01')),
        ('en', SEMI, 24, PLAIN),
        ('speed', BOLD, 210, DIGITS + '-'),
        ('rpm', BOLD, 150, DIGITS + '-'),
        ('num', BOLD, 72, DIGITS + '.-'),
    ]
    cell, baseline, glyphs = bake_table(fonts_dir, 'e_', table)
    text, _, rule = part_makers(cell, 'e_')

    def at(id_, s, font, base, **kw):
        return text(id_, s, font, base - baseline[font], **kw)

    def tw(s, font):
        return sum(glyphs[font][c]['advance'] for c in s)

    left_x, left_r, value_r = 120, 574, 520
    frame_x, frame_w, frame_y, frame_h = 592, 736, 126, 512
    right_x, right_w = 1370, 430
    with Image.open(LOGO_MASK) as m:
        logo_w = round(62 * m.width / m.height)

    def heading(id_, jp, en, base):
        jw = tw(jp, 'label')
        return [at(id_ + '_l', jp, 'label', base, left=left_x, width=jw, color='tag'), at(id_ + '_e', en, 'en', base, left=left_x + jw + 10, width=tw(en, 'en'), color='sub')]

    parts = [at('status', '{{statusline}}', 'line', 56, cx=960, width=1100, hotWhen='now'),
             {'id': 'logo', 'type': 'logo', 'src': 'logos/nerv_d.json', 'color': 'fg', 'x': left_r - logo_w, 'y': 116, 'w': logo_w, 'h': 62}]
    parts += heading('speed', '速度', 'SPEED', 158)
    parts += [
        at('speed_v', '{{speed}}', 'speed', 362, right=value_r, width=360, pad=8),
        at('speed_u', '{{u:speed}}', 'en', 372, right=left_r, width=46, color='sub'),
        rule('rule', left_x, 386, left_r - left_x, 2, 'wire'),
    ]
    parts += heading('rpm', '回転数', 'RPM', 424)
    parts += [
        at('rpm_v', '{{rpm}}', 'rpm', 590, right=value_r, width=360, pad=6),
        at('rpm_u', 'RPM', 'en', 590, right=left_r, width=46, color='sub'),
        at('cap', '{{gearcapjp}}', 'label', 176, left=frame_x + 28, width=170, color='tag'),
        at('cap3', '変速機 UNIT-01', 'cap', 616, left=frame_x + 28, width=210, color='sub'),
        at('cap4', 'SYNC {{sync}}%', 'en', 616, right=frame_x + frame_w - 24, width=150, color='sub'),
    ]
    pad = 6
    for i, (id_, jp, en, value, unit, hot) in enumerate((
            ('oil', '油温', 'OIL', '{{oil}}', '{{u:temp}}', 'melchior'), ('water', '水温', 'WATER', '{{coolant}}', '{{u:temp}}', 'balthasar'),
            ('boost', '増圧', 'BOOST', '{{boost}}', '{{u:boost}}', None), ('power', '出力', 'POWER', '{{power}}', '{{u:power}}', None),
            ('range', '活動限界', 'RANGE', '{{range}}', '{{u:range}}', None))):
        y = 132 + i * 100
        jw, ew = tw(jp, 'label'), tw(en, 'en')
        parts.append(at(id_ + '_l', jp, 'label', y + 56, left=right_x, width=jw, color='tag'))
        parts.append(at(id_ + '_e', en, 'en', y + 56, left=right_x + jw + 10, width=ew, color='sub'))
        vright = right_x + right_w - 52
        vleft = right_x + jw + 10 + ew + 8 + pad
        more = {'magiHot': hot} if hot else {}
        parts.append(at(id_ + '_v', value, 'num', y + 62, right=vright, width=vright - vleft, pad=pad, **more))
        parts.append(at(id_ + '_u', unit, 'en', y + 62, right=right_x + right_w, width=44, color='sub'))
        parts.append(rule(id_ + '_r', right_x, y + 76, right_w, 2, 'faint'))
    if clashes(parts):
        refuse('design D: parts overlap: %r' % clashes(parts))
    about = 'Generated by tools/eva_layout.py for the whole cluster, down to y=640. Re-run that rather than editing this.'
    widgets = [
        {'id': 'bg', 'type': 'evahex', 'x': 0, 'y': 0, 'w': 1920, 'h': 640, 'r': 30, 'class': 'ambient', 'z': 0, 'keepInAlert': True},
        {'id': 'rev', 'type': 'evaseg', 'x': 280, 'y': 72, 'w': 1360, 'h': 38, 'segments': 28, 'gap': 4, 'class': 'content', 'z': 5},
        {'id': 'frame', 'type': 'evaframe', 'x': frame_x, 'y': frame_y, 'w': frame_w, 'h': frame_h, 'class': 'content', 'z': 1, 'weight': 2, 'lineW': 2, 'inset': 8, 'corner': 40},
        {'id': 'gear', 'type': 'evagear', 'x': frame_x + 6, 'y': frame_y + 8, 'w': frame_w - 12, 'h': frame_h - 16, 'class': 'overlay', 'z': 8, 'fontPrefix': 'd_', 'words': True, 'wordPitch': 201},
        canvas('text', parts, 'overlay', 10),
    ]
    print('EVA dash D fitted to the cluster: %d layers, %d text parts' % (len(widgets), len(parts)))
    return {'schemaVersion': 2, 'name': 'EVA dash D', 'theme': 'eva', '_about': about, 'widgets': widgets}


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
    dash_a, centre_alert = build_dash_a(fonts_dir, refuse)
    dash_b = build_dash_b(fonts_dir, refuse)
    dash_d = build_dash_d(fonts_dir, refuse)
    dash_c1, dash_c2, dash_c3 = build_dash_c1(fonts_dir, refuse), build_dash_c2(fonts_dir, refuse), build_dash_c3(fonts_dir, refuse)
    dash_e1, dash_e2, dash_e3 = build_dash_e1(fonts_dir, refuse), build_dash_e2(fonts_dir, refuse), build_dash_e3(fonts_dir, refuse)
    for f in os.listdir(fonts_dir):
        shutil.move(os.path.join(fonts_dir, f), os.path.join(APP, 'fonts', f))
    shutil.rmtree(fonts_dir)
    os.makedirs(os.path.join(APP, 'logos'), exist_ok=True)
    for doc in (solo, comfort, eco, dash_d, dash_c1, dash_c2, dash_c3, dash_e1, dash_e2, dash_e3):
        for logo in (p for p in canvas_parts(doc) if p['type'] == 'logo'):
            with Image.open(LOGO_MASK) as m:
                small = m.convert('L').resize((logo['w'], logo['h']), Image.LANCZOS)
            with open(os.path.join(APP, logo['src']), 'w', encoding='utf8') as f:
                json.dump({'w': logo['w'], 'h': logo['h'], 'alpha': base64.b64encode(small.tobytes()).decode('ascii')}, f)
    for gone in ('fonts/speed.json', 'fonts/song.json', 'fonts/clock.json', 'fonts/c_gear.json', 'fonts/num21.json', 'logos/car_top.json'):      # nothing draws these any more
        stale = os.path.join(APP, gone)
        if os.path.exists(stale):
            os.remove(stale)
    for gone in ('eva_solo.json', 'dash_map_alert.json'):     # old names: hud_only_sport, dash_centre_alert
        stale_layout = os.path.join(APP, 'layouts', gone)
        if os.path.exists(stale_layout):
            os.remove(stale_layout)
    for layout, doc in (('eva', eva), ('hud_only_sport', solo), ('hud_only_comfort', comfort), ('hud_only_eco', eco), ('alert', alert), ('dash_eva', dash), ('dash_alert', dash_alert), ('dash_a', dash_a), ('dash_b', dash_b), ('dash_d', dash_d), ('dash_centre_alert', centre_alert), ('dash_c1', dash_c1), ('dash_c2', dash_c2), ('dash_c3', dash_c3), ('dash_e1', dash_e1), ('dash_e2', dash_e2), ('dash_e3', dash_e3)):
        with open(os.path.join(APP, 'layouts', layout + '.json'), 'w', encoding='utf8') as f:
            json.dump(doc, f, ensure_ascii=False, indent=1)
            f.write('\n')


if __name__ == '__main__':
    args = [int(v) for v in sys.argv[1:]]
    main(*(args if len(args) == 4 else DEFAULT_AREA))
