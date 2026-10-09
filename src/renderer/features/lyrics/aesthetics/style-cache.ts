/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
const written = new WeakMap<HTMLElement, Map<string, string>>();

/**
 * Writes an inline style only when its value changed. Rewriting identical values every
 * frame still invalidates style in Chromium, which costs power on an always-on screen.
 */
export function setStyle(el: HTMLElement, property: string, value: string): void {
    let values = written.get(el);
    if (!values) {
        values = new Map();
        written.set(el, values);
    }
    if (values.get(property) === value) return;
    values.set(property, value);
    el.style.setProperty(property, value);
}
