/**
 * The events the parts of the widget send each other. A module of its own, that imports nothing,
 * so that a part listening for one never has to load the part that sends it, nor make a cycle
 * of imports with it.
 */

/**
 * The event the capsule of the dock hears when a capture starts and hides its controls (FRU-303).
 * The list of the detached notes, which opens above its chip, folds on it.
 */
export const CAPTURE_START = 'fruitback-capture-start';
