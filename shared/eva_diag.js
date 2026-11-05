'use strict';
/**
 * The values only the engine unit has: knock retard, rail pressure, lambda, the fuel flow, and boost when the sport
 * display sends none. One round reads the channels asked for, one at a time, through the kit's DidReader on the
 * read-only diagnostic link (app.json config.dme lists the candidates).
 *
 *   const d = new EvaDiag({ reader, config, onReading: (name, value, atMs) => {} });
 *   await d.round({ knock: true, fuel: true, afr: true, boost: false });
 *   d.unavailable()     channels this car refused outright, e.g. ['knock']
 *   d.linkOk()          the unit has answered something in the last 5 s
 *
 * Units out: knock in degrees (a size, whichever sign the unit uses), fuel in bar, afr as an air-fuel ratio,
 * boost in bar above the outside air, burn in litres an hour. A channel the unit refuses (NRC 31, 11, 12) is left alone for 30 s:
 * asking again every round would only slow the others down.
 */
const STOICH = 14.7;
const RETRY_REFUSED_MS = 30000;
const BARO_EVERY_MS = 60000;
const LINK_UP_MS = 5000;
const SOURCE = { knock: 'knock', fuel: 'fuel', afr: 'lambda', boost: 'boost', burn: 'burn' };
const ORDER = ['knock', 'fuel', 'afr', 'boost', 'burn'];

class EvaDiag {
    constructor(opts) {
        this.reader = opts.reader;
        this.config = opts.config || {};
        this.onReading = opts.onReading;
        this.now = opts.now || Date.now;
        this.skipUntil = {};
        this.refused = {};
        this.lastAnswer = null;
        this.baro = 101.3;
        this.baroAt = null;
    }

    unavailable() { return ORDER.filter((n) => this.refused[n]); }

    linkOk() { return this.lastAnswer !== null && this.now() - this.lastAnswer < LINK_UP_MS; }

    /** After reading a list: note whether the unit answered, and whether every candidate was refused. */
    _replies(list) {
        const raws = list.map((c) => this.reader.raws[this.reader.key(c)]).filter(Boolean);
        if (raws.some((r) => r.bytes)) this.lastAnswer = this.now();
        return raws.length === list.length && raws.every((r) => /^NRC (31|11|12)\b/.test(r.why));
    }

    _convert(name, v) {
        if (name === 'knock') return Math.abs(v);
        if (name === 'afr') return v * STOICH;
        if (name === 'boost') return (v - this.baro) / 100;
        return v;
    }

    async _channel(name) {
        const list = this.config[SOURCE[name]];
        if (!Array.isArray(list) || !list.length) return;
        if (this.skipUntil[name] && this.now() < this.skipUntil[name]) return;
        const v = await this.reader.value(name, list);
        const allRefused = this._replies(list);
        if (allRefused) {
            this.refused[name] = true;
            this.skipUntil[name] = this.now() + RETRY_REFUSED_MS;
        } else {
            delete this.refused[name];
            delete this.skipUntil[name];
        }
        if (v !== null) this.onReading(name, this._convert(name, v), this.now());
    }

    async _baro() {
        const list = this.config.baro;
        if (!Array.isArray(list) || !list.length) return;
        if (this.baroAt !== null && this.now() - this.baroAt < BARO_EVERY_MS) return;
        this.baroAt = this.now();
        const b = await this.reader.value('baro', list);
        this._replies(list);
        if (b !== null) this.baro = b;
    }

    async round(want) {
        for (const name of ORDER) {
            if (!want[name]) continue;
            if (name === 'boost') await this._baro();
            await this._channel(name);
        }
    }
}

module.exports = { EvaDiag };
