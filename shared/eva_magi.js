'use strict';
/**
 * What MAGI decides on the dash's design A: whether the car is ready to be driven hard. Only the rules, so
 * bench/test/eva_magi_test.js can run them by hand.
 *
 * A full-screen alert covers the whole window, so MAGI can't report what the alerts report: it looks at what they never
 * show. MELCHIOR watches the oil, which has no alert of its own. BALTHASAR watches the coolant and rejects before the
 * alert at its limit. CASPER watches the drive: it deliberates in P, R and N, and rejects at the shift point.
 *
 *   judge({ oil, water, driving, overRev }) -> { melchior, balthasar, casper, tone, word, sub }
 *
 * Each vote and the tone are 'ok', 'wait' or 'no'. A reading that isn't there is never an approval.
 * tools/eva_layout.py bakes the glyphs of the words and of every sub, so a new string belongs there too.
 */
const OIL_COLD = 80;        // shift_score's cold-engine guard starts here too (shared/hud.js oilCold)
const OIL_HOT = 130;
const WATER_COLD = 70;
const WATER_HOT = 110;      // before the OVERHEAT alert, 118 by default

const isNum = (v) => typeof v === 'number' && isFinite(v);

function vote(v, cold, hot) {
    if (!isNum(v) || v < cold) return 'wait';
    return v >= hot ? 'no' : 'ok';
}

function judge(s) {
    const melchior = vote(s.oil, OIL_COLD, OIL_HOT);
    const balthasar = vote(s.water, WATER_COLD, WATER_HOT);
    const casper = s.overRev ? 'no' : s.driving ? 'ok' : 'wait';
    const out = { melchior, balthasar, casper };
    if (melchior === 'no' || balthasar === 'no' || casper === 'no') {
        const why = melchior === 'no' ? '油温上昇' : balthasar === 'no' ? '水温上昇' : '回転数超過';
        return Object.assign(out, { tone: 'no', word: '否決', sub: 'REJECTED // ' + why });
    }
    if (melchior === 'wait' || balthasar === 'wait' || casper === 'wait') {
        const warming = (isNum(s.oil) && isNum(s.water)) && (melchior === 'wait' || balthasar === 'wait');
        return Object.assign(out, { tone: 'wait', word: '審議中', sub: 'DELIBERATING // ' + (warming ? '暖機中' : '待機中') });
    }
    return Object.assign(out, { tone: 'ok', word: '全会一致', sub: 'UNANIMOUS // 出撃承認' });
}

module.exports = { judge };
