'use strict';
/**
 * Layouts ({ schemaVersion: 2, name, theme?, widgets[] }), for the HUD or the cluster. The built-in ones are
 * hud/layouts/<name>.json (packed into hud.pack by the build). A file of the same
 * name in the app's data folder, <data>/layouts/<name>.json, overrides it: that is
 * where scripts/deploy.sh pushes an edited layout, and the folder is watched, so
 * the HUD picks it up without a restart. Which layout shows is the "hudLayout"
 * setting. Every layout is checked before use; a bad one is refused with the reason.
 */
const fs = require('fs');
const path = require('path');
const data = require('./hud_data');

const TYPES = {
    text: ['text', 'font'],
    scale: ['font'],
    stripe: [],
    shiftbar: [],
    arc: ['signal', 'min', 'max'],
    revbar: ['barH'],
    lights: [],
    badge: ['text', 'font', 'tone'],
    fill: [],
    box: [],
    grid: [],
    gridlabels: ['font'],
    evaseg: [],
    evaframe: [],
    evagear: [],
    evacanvas: ['parts'],
    evasolo: ['bar'],
    evacorners: ['lowerLeft'],
    evaword: ['font'],
    evacolon: ['font'],
    evahex: ['r'],
    evahazard: ['stripe'],
    evaseven: ['margin'],
    evarings: ['r0', 'step'],
};
const CLASSES = ['ambient', 'content', 'overlay', 'alert'];

class Layouts {
    /** size: the target's [w, h] (800x480 HUD, 1920x720 cluster); widgets must fit on it. */
    constructor(dataDir, log, size) {
        this.size = size || [800, 480];
        this.dir = path.join(dataDir, 'layouts');
        this.log = log;
        this.changeListeners = [];
        this._watch();
    }

    /** The layout called `name`, checked; throws with the reason when it can't be used. */
    load(name) {
        if (!/^[a-z0-9_-]+$/i.test(String(name))) throw new Error('bad layout name "' + name + '"');
        const own = path.join(this.dir, name + '.json');
        let raw;
        if (fs.existsSync(own)) {
            try {
                raw = JSON.parse(fs.readFileSync(own, 'utf8'));
            } catch (e) {
                throw new Error('layouts/' + name + '.json is not valid JSON (' + e.message + ')');
            }
        } else {
            raw = data.json('layouts/' + name + '.json');
            if (!raw || !Object.keys(raw).length) throw new Error('there is no layout "' + name + '"');
        }
        this._validate(raw, name);
        return raw;
    }

    _validate(p, name) {
        const bad = (why) => { throw new Error('layout "' + name + '": ' + why); };
        if (!p || typeof p !== 'object') bad('not an object');
        if (p.schemaVersion !== 2) bad('schemaVersion must be 2 (got ' + p.schemaVersion + ')');
        if (!Array.isArray(p.widgets)) bad('missing widgets array');
        const ids = {};
        p.widgets.forEach((w, i) => {
            const at = 'widgets[' + i + '] ("' + w.id + '")';
            if (!w.id) bad('widgets[' + i + '] has no id');
            if (ids[w.id]) bad('two widgets are called "' + w.id + '"');
            ids[w.id] = true;
            if (!TYPES[w.type]) bad(at + ' has unknown type "' + w.type + '"');
            ['x', 'y', 'w', 'h'].forEach((k) => { if (typeof w[k] !== 'number' || w[k] < 0) bad(at + ' needs a number ' + k); });
            if (w.x + w.w > this.size[0] || w.y + w.h > this.size[1]) bad(at + ' runs off the ' + this.size[0] + 'x' + this.size[1] + ' display');
            if (w.class && CLASSES.indexOf(w.class) < 0) bad(at + ' has unknown class "' + w.class + '"');
            if (w.exclusive) bad(at + ' sets exclusive, which would hide everything under it (the CarPlay / Android Auto map too)');
            if (w.toggle !== undefined && !/^!?[a-zA-Z0-9_]+$/.test(String(w.toggle))) bad(at + ' has a bad toggle "' + w.toggle + '"');
            if (w.hole !== undefined && !(Array.isArray(w.hole) && w.hole.length === 4 && w.hole.every((n) => typeof n === 'number'))) bad(at + ' "hole" must be [x, y, w, h]');
            TYPES[w.type].forEach((k) => { if (w[k] === undefined) bad(at + ' (' + w.type + ') needs "' + k + '"'); });
        });
    }

    /** cb() after <data>/layouts/ changes on disk. */
    onChange(cb) { this.changeListeners.push(cb); }

    _watch() {
        try { fs.mkdirSync(this.dir); } catch (e) { /* there already, or the data folder is read-only */ }
        try {
            fs.watch(this.dir, { persistent: false }, () => {
                // debounce: an rsync push touches several files in quick succession
                clearTimeout(this._timer);
                this._timer = setTimeout(() => {
                    this.log.info('layouts/ changed on disk, reloading');
                    this.changeListeners.forEach((cb) => { try { cb(); } catch (e) { this.log.warn('layouts listener: ' + e); } });
                }, 300);
            });
        } catch (e) {
            this.log.warn('layouts: cannot watch ' + this.dir + ' (' + e.message + '); a pushed layout shows after an app restart');
        }
    }
}

module.exports = Layouts;
