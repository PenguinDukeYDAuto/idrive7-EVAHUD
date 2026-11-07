'use strict';
/**
 * What MAGI decides on the dash's design A: whether the car is ready to be driven hard. Only the rules (shared/eva_magi.js).
 *   node bench/test/eva_magi_test.js
 */
const assert = require('assert');
const { judge } = require('../../shared/eva_magi');

const warm = (o) => Object.assign({ oil: 100, water: 90, driving: true, overRev: false }, o);
const votes = (m) => [m.melchior, m.balthasar, m.casper].join();

const tests = {
    'a warm car on the move is unanimous'() {
        const m = judge(warm());
        assert.strictEqual(votes(m), 'ok,ok,ok');
        assert.strictEqual(m.tone, 'ok');
        assert.strictEqual(m.word, '全会一致');
        assert.strictEqual(m.sub, 'UNANIMOUS // 出撃承認');
    },
    'a cold car in P deliberates on all three, because it is warming up'() {
        const m = judge({ oil: 42, water: 48, driving: false, overRev: false });
        assert.strictEqual(votes(m), 'wait,wait,wait');
        assert.strictEqual(m.tone, 'wait');
        assert.strictEqual(m.word, '審議中');
        assert.strictEqual(m.sub, 'DELIBERATING // 暖機中');
    },
    'a warm car in P deliberates because it is standing by'() {
        const m = judge(warm({ driving: false }));
        assert.strictEqual(votes(m), 'ok,ok,wait');
        assert.strictEqual(m.sub, 'DELIBERATING // 待機中');
    },
    'oil is approved from 80 up to 129, and rejected from 130'() {
        assert.strictEqual(judge(warm({ oil: 79.9 })).melchior, 'wait');
        assert.strictEqual(judge(warm({ oil: 80 })).melchior, 'ok');
        assert.strictEqual(judge(warm({ oil: 129.9 })).melchior, 'ok');
        assert.strictEqual(judge(warm({ oil: 130 })).melchior, 'no');
    },
    'coolant is approved from 70 up to 109, and rejected from 110'() {
        assert.strictEqual(judge(warm({ water: 69.9 })).balthasar, 'wait');
        assert.strictEqual(judge(warm({ water: 70 })).balthasar, 'ok');
        assert.strictEqual(judge(warm({ water: 109.9 })).balthasar, 'ok');
        assert.strictEqual(judge(warm({ water: 110 })).balthasar, 'no');
    },
    'the shift point rejects, on the move or not'() {
        assert.strictEqual(judge(warm({ overRev: true })).casper, 'no');
        assert.strictEqual(judge(warm({ driving: false, overRev: true })).casper, 'no');
    },
    'a rejection names its reason, and outranks a vote still deliberating'() {
        let m = judge(warm({ oil: 132, water: 50 }));
        assert.strictEqual(m.tone, 'no');
        assert.strictEqual(m.word, '否決');
        assert.strictEqual(m.sub, 'REJECTED // 油温上昇');
        m = judge(warm({ water: 112 }));
        assert.strictEqual(m.sub, 'REJECTED // 水温上昇');
        m = judge(warm({ overRev: true }));
        assert.strictEqual(m.sub, 'REJECTED // 回転数超過');
    },
    'no reading is never an approval, and is not called warming up'() {
        const m = judge({ oil: null, water: undefined, driving: true, overRev: false });
        assert.strictEqual(votes(m), 'wait,wait,ok');
        assert.strictEqual(m.tone, 'wait');
        assert.strictEqual(m.sub, 'DELIBERATING // 待機中');
        assert.strictEqual(judge({ oil: NaN, water: 90, driving: true, overRev: false }).melchior, 'wait');
    },
};

let failed = 0;
Object.keys(tests).forEach((name) => {
    try { tests[name](); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message); }
});
console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
