const DEG_MAX = 75;
const DEG_STEP = 5;
const PERCENT_MAX = 100;

/** WMS internal percent used by the stick library (-100 … 100, maps to ±75°). */
const ANGLE_FULLY_OPEN = -100;
const ANGLE_FULLY_CLOSED = 100;

function percentToDegrees(percent) {
    return Math.round(percent / PERCENT_MAX * DEG_MAX);
}

function degreesToPercent(degrees) {
    const snapped = Math.round(degrees / DEG_STEP) * DEG_STEP;
    const clamped = Math.min(DEG_MAX, Math.max(-DEG_MAX, snapped));
    return Math.round(clamped / DEG_MAX * PERCENT_MAX);
}

module.exports = {
    DEG_MAX,
    DEG_STEP,
    ANGLE_FULLY_OPEN,
    ANGLE_FULLY_CLOSED,
    percentToDegrees,
    degreesToPercent,
};
