'use strict';
/**
 * The app's data folder hud/ (fonts, built-in layouts). The kit's build packs it into
 * hud.pack next to this file; kit/pack.js reads the pack, or the plain folder when there
 * is none (running from apps/ on the Mac). json(rel) returns {} for a missing file.
 */
const path = require('path');

module.exports = require('./kit/pack').open(path.join(__dirname, 'hud'));
