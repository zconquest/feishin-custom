/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
import { FLUENT_ICONS } from './fluent.gen';
import { lemmaCandidates } from './lemma';
import { WORD_ICONS } from './word-map';

export type IconRef =
    | { body: string; kind: 'fluent'; name: string; size: number }
    | { char: string; kind: 'emoji' };

const cache = new Map<string, IconRef | null>();

/** Standalone SVG markup for a Fluent icon filled with `color`. */
export function fluentSvg(icon: { body: string; size: number }, color: string): string {
    const body = icon.body.replace(/currentColor/g, color);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${icon.size} ${icon.size}" width="${icon.size}" height="${icon.size}" fill="${color}">${body}</svg>`;
}

/** The icon for a sung word, or null when the word has none. */
export function resolveIcon(word: string): IconRef | null {
    if (word.length > 1000) return null;
    const key = word.toLowerCase();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    let ref: IconRef | null = null;
    for (const candidate of lemmaCandidates(word)) {
        const value = WORD_ICONS[candidate];
        if (!value) continue;
        if (value.startsWith('e:')) {
            ref = { char: value.slice(2), kind: 'emoji' };
            break;
        }
        const icon = FLUENT_ICONS[value.slice(2)];
        if (icon) {
            ref = { kind: 'fluent', name: value.slice(2), ...icon };
            break;
        }
    }
    if (cache.size >= 2048) cache.delete(cache.keys().next().value!);
    cache.set(key, ref);
    return ref;
}
