'use strict';
/**
 * The EVA HUD draws all its text on one image layer (cluster-render allows a client 8 layers).
 * shared/eva_canvas.js decides which parts of that image to send again.
 *   node bench/test/eva_canvas_test.js
 */
const assert = require('assert');
const { TextCanvas, changes } = require('../../shared/eva_canvas');

const part = (id, x, y) => ({ id, x, y, w: 2, h: 2 });

function harness(parts) {
    const h = { looks: {}, painted: [], errors: [] };
    h.canvas = new TextCanvas(parts || [part('a', 0, 0), part('b', 10, 0)], {
        key: (p) => h.looks[p.id] || 'first',
        paint: (p, key) => { h.painted.push(p.id + ':' + key); return Buffer.alloc(p.w * p.h * 4, key.charCodeAt(0)); },
        onError: (p, e) => h.errors.push(p.id + ': ' + e.message),
    });
    return h;
}
const ids = (updates) => updates.map((u) => u.rect.x);

const tests = {
    'the first update paints every part'() {
        const h = harness();
        assert.deepStrictEqual(ids(h.canvas.updates(0)), [0, 10]);
    },
    'a part that has not changed is not sent again'() {
        const h = harness();
        h.canvas.updates(0);
        assert.deepStrictEqual(h.canvas.updates(1000), []);
    },
    'only the part that changed is sent, in its own rectangle with its own pixels'() {
        const h = harness();
        h.canvas.updates(0);
        h.looks.b = 'second';
        const u = h.canvas.updates(1000);
        assert.deepStrictEqual(u.map((x) => x.rect), [{ x: 10, y: 0, w: 2, h: 2 }]);
        assert.strictEqual(u[0].px.length, 16);
        assert.deepStrictEqual(h.painted.slice(-1), ['b:second']);
    },
    'a part repaints at most 5 times a second however fast it changes'() {
        const h = harness();
        h.canvas.updates(0);
        h.looks.a = 'second';
        assert.deepStrictEqual(h.canvas.updates(150), []);
        assert.deepStrictEqual(ids(h.canvas.updates(200)), [0]);
    },
    'force paints every part of a new canvas'() {
        const h = harness();
        assert.deepStrictEqual(ids(h.canvas.updates(0, true)), [0, 10]);
    },
    'force sends nothing that has not changed: the service kept the pixels'() {
        const h = harness();
        h.canvas.updates(0);
        const painted = h.painted.length;
        assert.deepStrictEqual(h.canvas.updates(10, true), []);
        assert.strictEqual(h.painted.length, painted, 'not even painted');
    },
    'force sends a change at once, whatever the rate'() {
        const h = harness();
        h.canvas.updates(0);
        h.looks.b = 'second';
        assert.deepStrictEqual(ids(h.canvas.updates(10, true)), [10]);
    },
    'after a force the rate counts from the forced paint'() {
        const h = harness();
        h.canvas.updates(0);
        h.looks.a = 'second';
        h.canvas.updates(1000, true);
        h.looks.a = 'third';
        assert.deepStrictEqual(h.canvas.updates(1100), []);
        assert.deepStrictEqual(ids(h.canvas.updates(1200)), [0]);
    },
    'a new look that paints the same pixels sends nothing, and is not painted again'() {
        const h = harness();
        h.canvas.updates(0);
        h.looks.a = 'free';      // the same first letter, so the same pixels here
        assert.deepStrictEqual(h.canvas.updates(1000), []);
        assert.deepStrictEqual(h.errors, []);
        const painted = h.painted.length;
        assert.deepStrictEqual(h.canvas.updates(2000), []);
        assert.strictEqual(h.painted.length, painted);
    },
    'only the rectangle around the changed pixels goes up, placed in the image'() {
        const W = 8, H = 6, was = Buffer.alloc(W * H * 4, 9), now = Buffer.from(was);
        now[(2 * W + 3) * 4] = 1;           // (3,2)
        now[(4 * W + 5) * 4 + 3] = 1;       // (5,4), only its alpha
        let px = was;
        const c = new TextCanvas([{ id: 'a', x: 20, y: 30, w: W, h: H }], { key: () => (px === was ? 'was' : 'now'), paint: () => px, rateMs: 0 });
        assert.deepStrictEqual(c.updates(0)[0].rect, { x: 20, y: 30, w: W, h: H }, 'the first paint is all of it');
        px = now;
        const u = c.updates(1);
        assert.deepStrictEqual(u[0].rect, { x: 23, y: 32, w: 3, h: 3 });
        assert.strictEqual(u[0].px.length, 3 * 3 * 4);
        assert.strictEqual(u[0].px[0], 1);
        assert.strictEqual(u[0].px[(2 * 3 + 2) * 4 + 3], 1);
    },
    'going back to an earlier picture sends it again: the image holds the last one, not the first'() {
        const a = Buffer.alloc(16, 1), b = Buffer.from(a);
        b[0] = 9;
        let px = a;
        const c = new TextCanvas([{ id: 'x', x: 0, y: 0, w: 2, h: 2 }], { key: () => (px === a ? 'a' : 'b'), paint: () => px, rateMs: 0 });
        c.updates(0);
        px = b;
        assert.strictEqual(c.updates(1)[0].px[0], 9);
        px = a;
        const u = c.updates(2);
        assert.strictEqual(u.length, 1, 'nothing sent going back');
        assert.strictEqual(u[0].px[0], 1);
    },
    'changes finds a change in any byte of any corner'() {
        const W = 5, H = 4;
        [[0, 0], [W - 1, 0], [0, H - 1], [W - 1, H - 1]].forEach(([x, y]) => {
            for (let byte = 0; byte < 4; byte++) {
                const was = Buffer.alloc(W * H * 4), now = Buffer.from(was);
                now[(y * W + x) * 4 + byte] = 7;
                const c = changes(was, now, W, H);
                assert.deepStrictEqual(c.rect, { x, y, w: 1, h: 1 }, x + ',' + y + ' byte ' + byte);
                assert.strictEqual(c.px.length, 4);
                assert.strictEqual(c.px[byte], 7);
            }
        });
    },
    'changes says nothing when the images are the same'() {
        assert.strictEqual(changes(Buffer.alloc(80, 3), Buffer.alloc(80, 3), 5, 4), null);
    },
    'what goes up rebuilds the image exactly, whatever changes'() {
        // a fixed random walk: edits of any size and place, on two parts with space around them
        let seed = 12345;
        const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
        const IW = 60, IH = 40, image = Buffer.alloc(IW * IH * 4);
        const parts = [{ id: 'a', x: 3, y: 2, w: 21, h: 13 }, { id: 'b', x: 30, y: 17, w: 17, h: 19 }];
        const truth = { a: Buffer.alloc(21 * 13 * 4), b: Buffer.alloc(17 * 19 * 4) };
        let turn = 0;
        const c = new TextCanvas(parts, { key: (p) => p.id + turn, paint: (p) => Buffer.from(truth[p.id]), rateMs: 0 });
        const apply = (u) => {
            for (let y = 0; y < u.rect.h; y++) u.px.copy(image, ((u.rect.y + y) * IW + u.rect.x) * 4, y * u.rect.w * 4, (y + 1) * u.rect.w * 4);
        };
        for (turn = 0; turn < 300; turn++) {
            parts.forEach((p) => {
                for (let n = rnd(4); n > 0; n--) {
                    const x = rnd(p.w), y = rnd(p.h), w = 1 + rnd(p.w - x), h = 1 + rnd(p.h - y), v = rnd(256);
                    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) truth[p.id][(j * p.w + i) * 4 + rnd(4)] = v;
                }
            });
            c.updates(turn).forEach(apply);
            parts.forEach((p) => {
                for (let y = 0; y < p.h; y++) {
                    const at = ((p.y + y) * IW + p.x) * 4;
                    assert.strictEqual(image.compare(truth[p.id], y * p.w * 4, (y + 1) * p.w * 4, at, at + p.w * 4), 0, 'turn ' + turn + ' part ' + p.id + ' row ' + y);
                }
            });
        }
    },
    'a part that fails to paint does not stop the others'() {
        const h = harness();
        const paint = h.canvas.paint;
        h.canvas.paint = (p, key) => { if (p.id === 'a') throw new Error('no font'); return paint(p, key); };
        assert.deepStrictEqual(ids(h.canvas.updates(0)), [10]);
        assert.deepStrictEqual(h.errors, ['a: no font']);
    },
    'a part that failed is tried again later'() {
        const h = harness();
        const paint = h.canvas.paint;
        h.canvas.paint = () => { throw new Error('no font'); };
        h.canvas.updates(0);
        h.canvas.paint = paint;
        assert.deepStrictEqual(ids(h.canvas.updates(1000)), [0, 10]);
    },
    'pixels of the wrong size are refused rather than sent'() {
        const h = harness();
        h.canvas.paint = () => Buffer.alloc(3);
        assert.deepStrictEqual(h.canvas.updates(0), []);
        assert.strictEqual(h.errors.length, 2);
    },
};

let failed = 0;
Object.keys(tests).forEach((name) => {
    try { tests[name](); console.log('ok    ' + name); } catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + e.message.split('\n')[0]); }
});
console.log('\n' + (Object.keys(tests).length - failed) + ' of ' + Object.keys(tests).length + ' passed');
process.exit(failed ? 1 : 0);
