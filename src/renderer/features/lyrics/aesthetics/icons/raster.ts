/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
import { fluentSvg, type IconRef, resolveIcon } from './resolve';

type FluentRef = Extract<IconRef, { kind: 'fluent' }>;

const images = new Map<string, HTMLImageElement>();
let loadedVersion = 0;
const listeners = new Set<() => void>();
export const subscribeIconAssets = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** Changes whenever another icon finishes loading (lets canvas styles know to redraw). */
export const iconVersion = (): number => loadedVersion;

/** A tinted Fluent icon ready for `drawImage`, or null while it is still loading. */
export function iconImage(ref: FluentRef, color: string): HTMLImageElement | null {
    const img = imageFor(ref, color);
    return img.complete && img.naturalWidth > 0 ? img : null;
}

/** Loads every icon a song needs up front (snapshot mode waits for this). */
export async function preloadIcons(words: readonly string[], color: string): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const word of new Set(words)) {
        const ref = resolveIcon(word);
        if (ref?.kind !== 'fluent') continue;
        const img = imageFor(ref, color);
        if (!img.complete) pending.push(img.decode().catch(() => undefined));
    }
    await Promise.all(pending);
}

function imageFor(ref: FluentRef, color: string): HTMLImageElement {
    const key = `${ref.name}|${color}`;
    let img = images.get(key);
    if (!img) {
        img = new Image();
        img.decoding = 'async';
        img.addEventListener(
            'load',
            () => {
                loadedVersion++;
                for (const listener of listeners) listener();
            },
            { once: true },
        );
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(fluentSvg(ref, color))}`;
        if (images.size >= 256) images.delete(images.keys().next().value!);
        images.set(key, img);
    }
    return img;
}
