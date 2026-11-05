'use strict';
/**
 * Sunrise / sunset for the Auto theme, from date and location alone (no car
 * signal needed). NOAA's solar position equations, worked in UTC epoch time, so
 * the head unit's time zone setting doesn't matter, only that its clock is right.
 *
 *   sunTimes(dateMs, lat, lon) -> { sunrise, sunset } (epoch ms) or null (polar day/night)
 *   isNight(nowMs, lat, lon)   -> true between sunset and the next sunrise
 */
const RAD = Math.PI / 180;

function sunTimes(dateMs, lat, lon) {
    // Julian day at 0h UTC of this UTC date
    const d = new Date(dateMs);
    const day0 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    // solar noon is roughly 12:00 local solar time: start near it for the equations
    const jd = day0 / 86400000 + 2440587.5 + 0.5 - lon / 360;
    const T = (jd - 2451545) / 36525;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
        Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
    const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;
    const y = Math.pow(Math.tan(eps / 2 * RAD), 2);
    const eqTime = 4 / RAD * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD) +
        4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) - 0.5 * y * y * Math.sin(4 * L0 * RAD) -
        1.25 * e * e * Math.sin(2 * M * RAD)); // minutes
    const cosH = (Math.cos(90.833 * RAD) - Math.sin(lat * RAD) * Math.sin(decl * RAD)) /
        (Math.cos(lat * RAD) * Math.cos(decl * RAD));
    if (cosH > 1 || cosH < -1) return null;
    const ha = Math.acos(cosH) / RAD;                    // degrees
    const noonMin = 720 - 4 * lon - eqTime;              // minutes after 0h UTC
    return {
        sunrise: day0 + (noonMin - 4 * ha) * 60000,
        sunset: day0 + (noonMin + 4 * ha) * 60000,
    };
}

function isNight(nowMs, lat, lon) {
    // the local solar day can straddle the UTC date line: check yesterday, today and tomorrow
    for (const off of [-1, 0, 1]) {
        const t = sunTimes(nowMs + off * 86400000, lat, lon);
        if (!t) continue;
        if (nowMs >= t.sunrise && nowMs < t.sunset) return false;
    }
    return true;
}

module.exports = { sunTimes, isNight };
