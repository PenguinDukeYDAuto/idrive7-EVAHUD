'use strict';
/**
 * Bench: a stand-in for cluster-render on the Mac, for the apps that draw through it.
 *
 *   node bench/server.js [app_id]   then open http://localhost:8078
 *
 * app_id: eva_hud, the only app in this repository.
 * The page draws the target the app's app.json config.target names.
 *
 * - Listens on a Unix socket speaking cluster-render protocol v1 (the framing
 *   and ops the vendored client sends: u32 LE length, u8 type 'J'/'F'/'M').
 * - Builds the app with the kit (kit/tools/build.py, the build the Store runs on the car),
 *   then runs the built dist/ in the kit's stubbed head unit (bench/run-app.js), pointed at
 *   that socket. The center-screen settings go through the stub's RHMI components.
 * - Streams every layer, pixel push and uniform to a browser page that draws
 *   app's target. Effect layers run the app's real GLSL shader in
 *   WebGL. Layers stack by class, then z, as cluster-render orders them.
 * - Rebuilds and restarts the app when a file under its apps/<id>/, shared/ or kit/ changes. A layout
 *   saved into bench/.data/<id>/layouts/ (the data-folder override) is left to the app's own
 *   fs.watch, so that path gets tested too.
 * - Flags protocol mistakes (bad sizes, unknown refs, ops before hello) in
 *   the log instead of silently drawing something.
 *
 * Bench only, never shipped to the car. No dependencies beyond Node.
 * The app runs on Node 8.16.2 (the car's version) from .cache/node8 when it's
 * there; BENCH_NODE=/path/to/node overrides.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { fork, execFileSync } = require('child_process');

const PORT = Number(process.env.BENCH_PORT) || 8078;
const SOCK = path.join(os.tmpdir(), 'hud-bench-' + process.pid + '.sock');
const ROOT = path.join(__dirname, '..');
const APP_ID = process.argv[2] || process.env.BENCH_APP || 'eva_hud';
const APP_DIR = path.join(ROOT, 'apps', APP_ID);
if (!fs.existsSync(path.join(APP_DIR, 'app.json'))) { console.error('no app ' + APP_ID + ' under apps/'); process.exit(2); }
const DATA_DIR = path.join(__dirname, '.data', APP_ID);   // the app's data/ on the bench (settings.json, layouts/)
const STAGE = path.join(ROOT, 'dist', APP_ID);
const TARGETS = { hud: [800, 480], map: [1088, 480], panel: [1920, 720] };
const CLASSES = ['ambient', 'content', 'overlay', 'alert'];
const MAX_MSG = 5529664;
// cluster-render refuses a client's 9th layer (CompositorLimits.per_client); BENCH_LAYER_LIMIT=0 turns this off
const LAYER_LIMIT = process.env.BENCH_LAYER_LIMIT === undefined ? 8 : Number(process.env.BENCH_LAYER_LIMIT);
const TOTAL_LAYER_LIMIT = 32;     // CompositorLimits.layers: across every client
// The car runs Node 8.16.2, so run the app on that by default when it's in the drive cache.
const NODE8 = path.join(ROOT, '..', '..', '.cache', 'node8', 'node-v8.16.2-darwin-x64', 'bin', 'node');
const APP_NODE = process.env.BENCH_NODE || (fs.existsSync(NODE8) ? NODE8 : null);
/** The target the page draws: the app's config.target (read again on each restart). */
function appView() {
    if (TARGETS[process.env.BENCH_VIEW]) return process.env.BENCH_VIEW;    // an app on two screens: which one this page shows
    try { const t = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8')).config.target; return TARGETS[t] ? t : 'hud'; } catch (e) { return 'hud'; }
}

/** The hello for the page: the app's target, and any manual signals its app.json adds (config.benchSignals). */
function helloMsg() {
    let extra = [];
    try { extra = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'app.json'), 'utf8')).config.benchSignals || []; } catch (e) { /* none */ }
    return { t: 'hello', targets: TARGETS, view: appView(), app: APP_ID, extra };
}

/* ---------- browser side: Server-Sent Events out, small POSTs in ---------- */

const clients = new Set();
const logLines = [];
function send(obj, only) {
    const line = 'data: ' + JSON.stringify(obj) + '\n\n';
    (only ? [only] : Array.from(clients)).forEach((res) => res.write(line));
}
function log(level, text) {
    const entry = { t: 'log', level, text: new Date().toTimeString().slice(0, 8) + '  ' + text };
    logLines.push(entry);
    if (logLines.length > 400) logLines.shift();
    send(entry);
    (level === 'error' ? console.error : console.log)(entry.text);
}

/* ---------- the fake cluster-render ---------- */

const layers = new Map();   // key "conn:ref" -> layer
let nextConn = 1;

function sceneMeta() {
    return Array.from(layers.values()).map((l) => ({
        key: l.key, conn: l.conn, ref: l.ref, app: l.app, kind: l.kind, target: l.target,
        class: l.class, z: l.z, x: l.x, y: l.y, w: l.w, h: l.h, visible: l.visible, opacity: l.opacity,
        exclusive: l.exclusive, iw: l.iw, ih: l.ih, fs: l.fs, time: l.time, uniforms: l.uniforms, sx: l.sx, sy: l.sy, rotate: l.rotate,
    }));
}
let sceneTimer = null;
function sceneChanged() {
    if (sceneTimer) return;
    sceneTimer = setTimeout(() => { sceneTimer = null; send({ t: 'scene', layers: sceneMeta() }); }, 16);
}
function sendPixels(l, only) {
    if (!l.image) return;
    send({ t: 'px', key: l.key, iw: l.iw, ih: l.ih, b64: l.image.toString('base64') }, only);
}

function writeEv(sock, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const m = Buffer.alloc(5 + body.length);
    m.writeUInt32LE(body.length + 1, 0);
    m[4] = 0x4a;
    body.copy(m, 5);
    sock.write(m);
}

const renderServer = net.createServer((sock) => {
    const conn = nextConn++;
    const st = { conn, app: '?', hello: false, buf: Buffer.alloc(0) };
    const bad = (why) => { log('error', 'protocol [' + st.app + ']: ' + why); };
    const refuse = (op, ref, reason) => { bad(op + ' ref ' + ref + ': ' + reason); writeEv(sock, { ev: 'error', op, ref, reason }); };

    sock.on('data', (d) => {
        st.buf = st.buf.length ? Buffer.concat([st.buf, d]) : d;
        let off = 0;
        while (st.buf.length - off >= 5) {
            const len = st.buf.readUInt32LE(off);
            if (len < 1 || len > MAX_MSG) { bad('message length ' + len + ' out of range, closing'); sock.destroy(); return; }
            if (st.buf.length - off < 4 + len) break;
            const type = st.buf[off + 4];
            const body = st.buf.slice(off + 5, off + 4 + len);
            off += 4 + len;
            try { handle(type, body); } catch (e) { bad('handler threw: ' + e.stack); }
        }
        st.buf = st.buf.slice(off);
    });
    sock.on('error', () => {});
    sock.on('close', () => {
        let n = 0;
        layers.forEach((l, k) => { if (l.conn === conn) { layers.delete(k); n++; } });
        log('info', 'renderer: ' + st.app + ' disconnected, dropped its ' + n + ' layer(s)');
        sceneChanged();
    });

    function handle(type, body) {
        if (type === 0x4a) return onJson(body);
        if (!st.hello) return bad('binary message before hello');
        if (type === 0x46) return onFrame(body);
        if (type === 0x4d) return bad('mesh geometry received; the bench does not draw meshes');
        bad('unknown message type 0x' + type.toString(16));
    }

    function onJson(body) {
        let m;
        try { m = JSON.parse(body.toString('utf8')); } catch (e) { return bad('JSON message does not parse: ' + e.message); }
        if (m.op === 'hello') {
            st.hello = true;
            st.app = m.app || '?';
            if (m.proto !== 1) bad('hello proto ' + m.proto + ', service speaks 1');
            log('info', 'renderer: hello from ' + st.app + ' (proto ' + m.proto + ')');
            writeEv(sock, { ev: 'hello', backend: 'bench', targets: Object.keys(TARGETS).join(',') });
            return;
        }
        if (!st.hello) return bad(m.op + ' before hello');
        const key = conn + ':' + m.ref;
        const l = layers.get(key);
        switch (m.op) {
            case 'layer': {
                if (!TARGETS[m.target]) return refuse('layer', m.ref, 'unknown target ' + m.target);
                if (m.class && CLASSES.indexOf(m.class) < 0) return refuse('layer', m.ref, 'unknown class ' + m.class);
                if (m.z !== undefined && (m.z < -1000 || m.z > 1000)) return refuse('layer', m.ref, 'z out of -1000..1000');
                if (layers.size >= TOTAL_LAYER_LIMIT) return refuse('layer', m.ref, 'too many layers');
                if (LAYER_LIMIT && Array.from(layers.values()).filter((x) => x.conn === conn).length >= LAYER_LIMIT) return refuse('layer', m.ref, 'too many layers');
                const [tw, th] = TARGETS[m.target];
                const nl = {
                    key, conn, ref: m.ref, app: st.app, kind: m.kind, target: m.target,
                    class: m.class || 'content', z: m.z || 0, x: m.x || 0, y: m.y || 0, w: m.w || 0, h: m.h || 0,
                    visible: m.visible === undefined ? 1 : m.visible, opacity: m.opacity === undefined ? 1 : m.opacity,
                    exclusive: m.exclusive || 0, uniforms: {},
                    sx: m.sx === undefined ? 1 : m.sx, sy: m.sy === undefined ? 1 : m.sy, rotate: m.rotate || 0,
                };
                if (nl.x + nl.w > tw || nl.y + nl.h > th || nl.x < 0 || nl.y < 0) {
                    log('warn', 'layer ' + m.ref + ' (' + nl.x + ',' + nl.y + ' ' + nl.w + 'x' + nl.h + ') runs off the ' + tw + 'x' + th + ' ' + m.target + ' target');
                }
                if (nl.exclusive) log('warn', 'layer ' + m.ref + ' is exclusive: it hides everything under it (CarPlay/AA map too)');
                if (m.kind === 'image') {
                    nl.iw = m.iw; nl.ih = m.ih;
                    if (!(m.iw > 0 && m.ih > 0 && m.iw <= 1920 && m.ih <= 720)) return refuse('layer', m.ref, 'image iw/ih out of range');
                    nl.image = Buffer.alloc(m.iw * m.ih * 4);
                } else if (m.kind === 'effect') {
                    if (!m.fs) return refuse('layer', m.ref, 'effect without fs');
                    nl.fs = m.fs; nl.time = !!m.time;
                } else {
                    log('warn', 'layer ' + m.ref + ': kind ' + m.kind + ' is not drawn by the bench');
                }
                layers.set(key, nl);
                writeEv(sock, { ev: 'layer', ref: m.ref, state: 'shown' });
                sceneChanged();
                return;
            }
            case 'set': {
                if (!l) return refuse('set', m.ref, 'no such layer');
                ['class', 'z', 'x', 'y', 'w', 'h', 'visible', 'exclusive', 'opacity', 'sx', 'sy', 'rotate'].forEach((k) => { if (m[k] !== undefined) l[k] = m[k]; });
                sceneChanged();
                return;
            }
            case 'drop': {
                if (!l) return refuse('drop', m.ref, 'no such layer');
                layers.delete(key);
                sceneChanged();
                return;
            }
            case 'uniform': {
                if (!l) return refuse('uniform', m.ref, 'no such layer');
                if (l.kind !== 'effect') return refuse('uniform', m.ref, 'uniform on a ' + l.kind + ' layer');
                const v = String(m.v).trim().split(/\s+/).map(Number);
                if (v.some((n) => !isFinite(n))) return refuse('uniform', m.ref, 'non-numeric value "' + m.v + '"');
                l.uniforms[m.name] = v;
                sceneChanged();
                return;
            }
            case 'status':
                writeEv(sock, { ev: 'status', text: 'bench: ' + layers.size + ' layers' });
                return;
            default:
                bad('op "' + m.op + '" not handled by the bench');
        }
    }

    function onFrame(body) {
        if (body.length < 14) return bad('frame message too short');
        const ref = body.readUInt32LE(0);
        const n = body.readUInt16LE(12);
        const l = layers.get(conn + ':' + ref);
        if (!l) return bad('frame for unknown ref ' + ref);
        if (l.kind !== 'image') return bad('frame for a ' + l.kind + ' layer (ref ' + ref + ')');
        const head = 14 + n * 8;
        const px = body.slice(head);
        if (n === 0) {
            if (px.length !== l.image.length) return bad('whole frame for ref ' + ref + ' is ' + px.length + ' bytes, layer needs ' + l.image.length);
            px.copy(l.image);
        } else {
            let o = 0;
            for (let i = 0; i < n; i++) {
                const x = body.readUInt16LE(14 + i * 8), y = body.readUInt16LE(16 + i * 8);
                const w = body.readUInt16LE(18 + i * 8), h = body.readUInt16LE(20 + i * 8);
                if (x + w > l.iw || y + h > l.ih) return bad('dirty rect off the image on ref ' + ref);
                for (let r = 0; r < h; r++) { px.copy(l.image, ((y + r) * l.iw + x) * 4, o, o + w * 4); o += w * 4; }
            }
            if (o !== px.length) return bad('dirty rects for ref ' + ref + ' carry ' + px.length + ' bytes, expected ' + o);
        }
        sendPixels(l);
    }
});

/* ---------- the app child ---------- */

let child = null;
let signals = { t: 'signals', mode: 'demo', values: {} };
let drive = { t: 'drive', value: null };   // the drive mode buttons (FES actualValueModeDrivingExperience), null = car hasn't said
let restartTimer = null;
let stopping = false;

function build() {
    // The kit's build needs an oap-sdk folder; on the Mac that is a stub (see bench/README.md).
    const sdk = path.join(ROOT, 'oap-sdk');
    if (!fs.existsSync(path.join(sdk, 'index.js'))) {
        fs.mkdirSync(sdk, { recursive: true });
        fs.writeFileSync(path.join(sdk, 'index.js'), "'use strict';\n// BENCH_STUB: stands in for BMW's oap-sdk so kit/tools/build.py runs on the Mac. Never ship this.\nthrow new Error('BENCH_STUB oap-sdk');\n");
        fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: 'oap-sdk', version: '0.0.0-bench-stub', main: 'index.js' }) + '\n');
    }
    try {
        const out = execFileSync('python3', [path.join(ROOT, 'kit', 'tools', 'build.py'), APP_ID], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
        String(out).split('\n').filter(Boolean).forEach((ln) => log('info', 'build: ' + ln.trim()));
        return true;
    } catch (e) {
        log('error', 'build failed: ' + String(e.stderr || e.message).trim());
        return false;
    }
}

// A failed build is often only another build writing dist/ at the same time (a test, another bench): try again.
const BUILD_TRIES = 3;
let buildTries = 0, buildRetry = null;

function startApp() {
    clearTimeout(buildRetry);
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* there */ }
    send(helloMsg());
    if (!build()) {
        buildTries++;
        if (buildTries < BUILD_TRIES) {
            log('warn', 'trying the build again in 2 s (' + buildTries + ' of ' + (BUILD_TRIES - 1) + ')');
            buildRetry = setTimeout(startApp, 2000);
            return;
        }
        buildTries = 0;
        send({ t: 'app', state: 'stopped' });
        return;
    }
    buildTries = 0;
    const opts = { cwd: DATA_DIR, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: Object.assign({}, process.env, { HUD_CLUSTER_SOCKET: SOCK }) };
    if (APP_NODE) opts.execPath = APP_NODE;
    child = fork(path.join(__dirname, 'run-app.js'), [STAGE, DATA_DIR], opts);
    const c = child;
    if (drive.value !== null) c.send(drive);
    const pipe = (stream, level) => {
        let rest = '';
        stream.on('data', (d) => {
            const lines = (rest + d).split('\n');
            rest = lines.pop();
            lines.forEach((ln) => ln && log(/WARN|Error|error/.test(ln) ? 'warn' : level, 'app: ' + ln));
        });
    };
    pipe(c.stdout, 'info');
    pipe(c.stderr, 'warn');
    c.on('message', (m) => {
        if (m && m.t === 'settings') lastSettings = m;
        if (m && m.t === 'status') { lastStatus = m; log('info', 'center screen status: ' + m.s); }
        if (m && (m.t === 'values' || m.t === 'settings' || m.t === 'status')) send(m);
    });
    c.on('exit', (code, sig) => {
        if (c !== child) return;
        child = null;
        send({ t: 'app', state: 'stopped' });
        if (!stopping) log('error', 'app exited (code ' + code + (sig ? ', ' + sig : '') + '); fix and save to restart');
    });
    c.send(signals);
    send({ t: 'app', state: 'running' });
    log('info', 'app started on ' + (APP_NODE ? APP_NODE.replace(/^.*\/(node-v[^/]+)\/.*$/, '$1') : 'node ' + process.version + ' (not the car\'s Node 8)'));
}

function restartApp(why) {
    log('info', 'restarting app: ' + why);
    if (child) {
        const old = child;
        child = null;
        stopping = true;
        old.once('exit', () => { stopping = false; startApp(); });
        old.kill('SIGTERM');
        setTimeout(() => { try { old.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1500);
    } else startApp();
}

[APP_DIR, path.join(ROOT, 'shared'), path.join(ROOT, 'kit')].forEach((dir) => fs.watch(dir, { recursive: true }, (ev, file) => {
    if (!file || /(^|\/)\./.test(file) || /__pycache__/.test(file)) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => restartApp(path.basename(dir) + '/' + file + ' changed'), 300);
}));
let lastSettings = null;
let lastStatus = null;

/* ---------- HTTP ---------- */

function body(req) {
    return new Promise((resolve) => {
        let s = '';
        req.on('data', (d) => { s += d; if (s.length > 1e5) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
    });
}

const web = http.createServer(async (req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    if (host !== 'localhost' && host !== '127.0.0.1') { res.writeHead(403); return res.end(); }
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return fs.createReadStream(path.join(__dirname, 'page.html')).pipe(res);
    }
    if (req.method === 'GET' && url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        clients.add(res);
        req.on('close', () => clients.delete(res));
        send(helloMsg(), res);
        logLines.forEach((e) => send(e, res));
        send({ t: 'scene', layers: sceneMeta() }, res);
        layers.forEach((l) => sendPixels(l, res));
        if (lastSettings) send(lastSettings, res);
        if (lastStatus) send(lastStatus, res);
        send({ t: 'app', state: child ? 'running' : 'stopped' }, res);
        return;
    }
    if (req.method === 'POST' && url === '/signals') {
        const b = await body(req);
        signals = { t: 'signals', mode: b.mode === 'manual' ? 'manual' : 'demo', values: b.values || {} };
        if (child) child.send(signals);
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/drive') {
        const b = await body(req);
        drive = { t: 'drive', value: b.value === null || b.value === undefined ? null : b.value };
        if (child) child.send(drive);
        log('info', 'bench: drive mode ' + JSON.stringify(drive.value));
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/restart') {
        restartApp('restart button');
        res.writeHead(204); return res.end();
    }
    if (req.method === 'POST' && url === '/setting') {
        // Pressed on the stub's RHMI components, as the car's settings page sends it (run-app.js).
        const b = await body(req);
        if (!child) { res.writeHead(409); return res.end('app not running'); }
        child.send({ t: 'set', key: b.key, value: b.value });
        log('info', 'bench: setting ' + b.key + ' = ' + JSON.stringify(b.value));
        res.writeHead(204); return res.end();
    }
    res.writeHead(404); res.end();
});

try { fs.unlinkSync(SOCK); } catch (e) { /* not there */ }
renderServer.listen(SOCK, () => {
    web.listen(PORT, '127.0.0.1', () => {
        log('info', 'bench renderer on ' + SOCK);
        log('info', 'open http://localhost:' + PORT);
        startApp();
    });
});
function shutdown() {
    stopping = true;
    if (child) child.kill('SIGTERM');
    try { fs.unlinkSync(SOCK); } catch (e) { /* gone */ }
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
