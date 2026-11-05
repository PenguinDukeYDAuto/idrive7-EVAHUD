'use strict';
/**
 * Something that shows steadily and now and then flashes a few times: the NERV mark, red to amber.
 * on(now) says whether it is in its other colour at that moment. A gap between bursts is drawn afresh each time.
 */
class Flicker {
    /** gapMs [shortest, longest] between bursts, flashes per burst, phaseMs each on and each off. */
    constructor(o) {
        this.gapMs = o.gapMs;
        this.flashes = o.flashes;
        this.phaseMs = o.phaseMs;
        this.random = o.random || Math.random;
        this.next = null;
    }

    _gap() {
        const [a, b] = this.gapMs;
        return a + (b - a) * this.random();
    }

    on(now) {
        if (!Array.isArray(this.gapMs) || !(this.flashes > 0) || !(this.phaseMs > 0)) return false;
        if (this.next === null) this.next = now + this._gap();
        if (now < this.next) return false;
        const t = now - this.next;
        if (t >= this.flashes * 2 * this.phaseMs) {       // also after a long time unseen: no catching up
            this.next = now + this._gap();
            return false;
        }
        return Math.floor(t / this.phaseMs) % 2 === 0;
    }
}

module.exports = { Flicker };
