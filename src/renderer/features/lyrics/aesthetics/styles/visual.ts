import type { Palette, ShowOn } from '../types';
import type { FrameInfo, StageStyle } from './types';

import { fluentSvg, resolveIcon } from '../icons/resolve';
import { activeWordIndex, type LyricsModel } from '../model';
/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
import { DEFAULT_PALETTE } from '../palette-defaults';
import { setStyle } from '../style-cache';
import { clamp, easeOutBack, easeOutCubic, FONT_STACK, lerp } from '../util';

const WEIGHT = 700;
const POP_MS = 280;
const ICON_DELAY_MS = 70;
const ICON_POP_MS = 340;
const EXIT_MS = 240;
const PREVIEW_MS = 1200;
const TOP: Record<ShowOn, number> = { always: 0.52, lock: 0.6 };

interface Slot {
    icon: HTMLSpanElement | null;
    iconColor: string;
    root: HTMLDivElement;
    word: HTMLSpanElement;
}

/**
 * Visual: one word at a time, large, with a matching Fluent icon or emoji popping in beside
 * it. The previous word lifts away as the next one lands.
 */
export function createVisual(): StageStyle {
    let layer: HTMLDivElement | null = null;
    let model: LyricsModel | null = null;
    let palette: Palette = { ...DEFAULT_PALETTE };
    let mode: ShowOn = 'lock';
    const slots = new Map<number, Slot>();
    const ctx = document.createElement('canvas').getContext('2d')!;

    const clear = (): void => {
        for (const s of slots.values()) s.root.remove();
        slots.clear();
    };

    function fontSize(text: string, W: number, H: number): number {
        const base = Math.min(H * 0.13, W * 0.1);
        ctx.font = `${WEIGHT} 100px ${FONT_STACK}`;
        const width = (ctx.measureText(text).width / 100) * base * 1.9; // word + icon + gap
        return width > W * 0.86 ? base * ((W * 0.86) / width) : base;
    }

    function slot(i: number, W: number, H: number): Slot {
        let s = slots.get(i);
        if (s) return s;
        const text = model!.words[i]!.text;
        const root = document.createElement('div');
        root.className = 'visual-word';
        root.style.fontSize = `${fontSize(text, W, H)}px`;
        const word = document.createElement('span');
        word.className = 'visual-text';
        word.textContent = text;
        root.append(word);
        let icon: HTMLSpanElement | null = null;
        const ref = resolveIcon(text);
        if (ref) {
            icon = document.createElement('span');
            icon.className = ref.kind === 'emoji' ? 'visual-icon emoji' : 'visual-icon';
            if (ref.kind === 'emoji') icon.textContent = ref.char;
            root.append(icon);
        }
        layer!.append(root);
        s = { icon, iconColor: '', root, word };
        slots.set(i, s);
        return s;
    }

    function paintIcon(i: number, s: Slot): void {
        if (!s.icon || s.iconColor === palette.highlight) return;
        const ref = resolveIcon(model!.words[i]!.text);
        if (ref?.kind === 'fluent') s.icon.innerHTML = fluentSvg(ref, palette.highlight);
        s.iconColor = palette.highlight;
    }

    return {
        destroy() {
            clear();
            layer?.remove();
            layer = null;
        },

        frame({ height: H, reducedMotion = false, songMs: t, width: W }: FrameInfo): boolean {
            if (!layer) return false;
            setStyle(layer, 'top', `${TOP[mode] * 100}%`);
            for (const [i, s] of slots)
                s.root.style.fontSize = `${fontSize(model!.words[i]!.text, W, H)}px`;
            const words = model?.words ?? [];
            let c = model ? activeWordIndex(model, t) : -1;
            const preview = c < 0 && !!words.length && t >= words[0]!.start - PREVIEW_MS;
            if (!words.length || (c < 0 && !preview)) {
                clear();
                return false;
            }
            if (preview) c = 0;

            const current = words[c]!;
            const next = words[c + 1];
            const since = t - current.start;
            const idle = preview ? 0 : t - current.end;
            const dim =
                clamp((idle - 2500) / 1500) *
                clamp(((next ? next.start - t : Number.POSITIVE_INFINITY) - 400) / 1200);
            const shown = new Set<number>();

            // The word being sung.
            const s = slot(c, W, H);
            shown.add(c);
            paintIcon(c, s);
            const p = preview ? 0 : reducedMotion ? 1 : clamp(since / POP_MS);
            const e = easeOutCubic(p);
            const scale = preview ? 0.9 : lerp(0.6, 1, easeOutBack(p));
            const previewFade = clamp((t - (current.start - PREVIEW_MS)) / 600);
            setStyle(
                s.root,
                'opacity',
                (preview ? 0.25 * previewFade : e * (1 - 0.6 * dim)).toFixed(3),
            );
            setStyle(
                s.root,
                'transform',
                `translate(-50%, -50%) translateY(${((1 - e) * 0.18).toFixed(4)}em) scale(${scale.toFixed(4)})`,
            );
            setStyle(s.root, 'filter', e < 0.999 ? `blur(${((1 - e) * 8).toFixed(2)}px)` : 'none');
            setStyle(s.word, 'color', preview ? palette.secondary : palette.lyric);
            if (s.icon) {
                const q = preview
                    ? 0
                    : reducedMotion
                      ? 1
                      : clamp((since - ICON_DELAY_MS) / ICON_POP_MS);
                setStyle(s.icon, 'opacity', easeOutCubic(q).toFixed(3));
                setStyle(
                    s.icon,
                    'transform',
                    `rotate(${((1 - easeOutCubic(q)) * -14).toFixed(2)}deg) scale(${easeOutBack(q).toFixed(4)})`,
                );
            }

            // The previous word lifts away.
            if (!reducedMotion && !preview && c > 0 && since < EXIT_MS) {
                const prev = slot(c - 1, W, H);
                shown.add(c - 1);
                paintIcon(c - 1, prev);
                const x = easeOutCubic(since / EXIT_MS);
                setStyle(prev.root, 'opacity', (1 - x).toFixed(3));
                setStyle(
                    prev.root,
                    'transform',
                    `translate(-50%, -50%) translateY(${(-0.45 * x).toFixed(4)}em) scale(${(1 - 0.08 * x).toFixed(4)})`,
                );
                setStyle(prev.root, 'filter', `blur(${(x * 6).toFixed(2)}px)`);
                setStyle(prev.word, 'color', palette.lyric);
                if (prev.icon) {
                    setStyle(prev.icon, 'opacity', '1');
                    setStyle(prev.icon, 'transform', 'none');
                }
            }

            for (const [i, sl] of slots) {
                if (!shown.has(i)) {
                    sl.root.remove();
                    slots.delete(i);
                }
            }

            const settleMs = Math.max(POP_MS, ICON_DELAY_MS + ICON_POP_MS, EXIT_MS) + 80;
            return preview ? previewFade < 1 : since < settleMs || (dim > 0.001 && dim < 0.999);
        },

        mount(root) {
            layer = document.createElement('div');
            layer.className = 'visual-layer';
            root.append(layer);
        },

        setLyrics(next) {
            clear();
            model = next;
        },

        setMode(next) {
            mode = next;
        },

        setPalette(next) {
            palette = next;
        },
    };
}
