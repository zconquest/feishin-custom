import type { Palette, ShowOn } from '../types';
import type { FrameInfo, StageStyle } from './types';

import { shipScale } from '../emphasis';
import { fluentSvg, type IconRef, resolveIcon } from '../icons/resolve';
import { activeWordIndex, type LyricsModel } from '../model';
/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
import { DEFAULT_PALETTE } from '../palette-defaults';
import { setStyle } from '../style-cache';
import { clamp, easeOutBack, easeOutCubic, FONT_STACK, hashSigned, lerp, mixHex } from '../util';

const WEIGHT = 700;
const TRACKING_EM = -0.03;
const PAD_X_EM = 0.12;
const ICON_EM = 0.9;
const ICON_GAP_EM = 0.24;
/** Rendered height of a word element (line box + vertical padding in stage.css). */
const BOX_EM = 1.16;
/** Row advance as a share of font size: rows sit tight, like a wall. */
const ROW_EM = 0.96;
/** The next word tucks up behind the highlight box by this much. */
const UPCOMING_OVERLAP_EM = 0.16;
const LINE_GAP_EM = 0.18;
const HISTORY = 6;
const LOOKAHEAD = 2;
/** Where the word being sung sits, as a share of the screen height (lower on the lock screen, under the clock). */
const FOCUS_Y: Record<ShowOn, number> = { always: 0.6, lock: 0.66 };
const ENTER_MS = 240;
const WIPE_MS = 150;
/** The first words fade in this long before they are sung. */
const PREVIEW_MS = 3000;
/** Lock screen: words fade out between these heights (share of screen) as they near the clock. */
const CLOCK_FADE_TOP = 0.17;
const CLOCK_FADE_SPAN = 0.2;

interface Measure {
    icon: IconRef | null;
    size: number;
    /** Text width at a 1 px font size. */
    unit: number;
}

interface WordNode {
    box: HTMLDivElement;
    icon: HTMLSpanElement | null;
    iconColor: string;
    root: HTMLDivElement;
    text: HTMLSpanElement;
}

/**
 * Ship: words stack into a wall that drifts in three dimensions. The word being sung
 * pops forward on a highlight box, sung words recede into the wall, and the next word
 * waits faintly behind.
 */
export function createShip(withIcons = false): StageStyle {
    let scene: HTMLDivElement | null = null;
    let wall: HTMLDivElement | null = null;
    let model: LyricsModel | null = null;
    let palette: Palette = { ...DEFAULT_PALETTE };
    let mode: ShowOn = 'lock';
    let viewW = 0;
    let viewH = 0;
    const measures = new Map<number, Measure>();
    const nodes = new Map<number, WordNode>();
    const ctx = document.createElement('canvas').getContext('2d')!;

    const clearNodes = (): void => {
        for (const n of nodes.values()) n.root.remove();
        nodes.clear();
    };

    function measure(i: number): Measure {
        let m = measures.get(i);
        if (m) return m;
        const text = model!.words[i]!.text;
        ctx.font = `${WEIGHT} 100px ${FONT_STACK}`;
        ctx.letterSpacing = `${TRACKING_EM * 100}px`;
        const icon = withIcons ? resolveIcon(text) : null;
        const unit = ctx.measureText(text).width / 100 + (icon ? ICON_EM + ICON_GAP_EM : 0);
        let size = Math.min(viewH * 0.24, viewW * 0.2) * shipScale(text);
        const width = size * (unit + 2 * PAD_X_EM);
        if (width > viewW * 0.84) size *= (viewW * 0.84) / width;
        m = { icon, size, unit };
        measures.set(i, m);
        return m;
    }

    function node(i: number): WordNode {
        let n = nodes.get(i);
        if (n) return n;
        const root = document.createElement('div');
        root.className = withIcons ? 'ship-word ship-visual-word' : 'ship-word';
        const box = document.createElement('div');
        box.className = 'ship-box';
        const text = document.createElement('span');
        text.className = 'ship-text';
        text.textContent = model!.words[i]!.text;
        root.append(box, text);
        const ref = measure(i).icon;
        let icon: HTMLSpanElement | null = null;
        if (ref) {
            icon = document.createElement('span');
            icon.className = ref.kind === 'emoji' ? 'ship-icon emoji' : 'ship-icon';
            icon.setAttribute('aria-hidden', 'true');
            if (ref.kind === 'emoji') icon.textContent = ref.char;
            root.append(icon);
        }
        root.style.fontSize = `${measure(i).size}px`;
        wall!.append(root);
        n = { box, icon, iconColor: '', root, text };
        nodes.set(i, n);
        return n;
    }

    /** Row centres relative to the focused row, for words `from…to`. */
    function layout(focus: number, from: number, to: number): Map<number, number> {
        const words = model!.words;
        const rowH = (i: number): number => measure(i).size * ROW_EM;
        const gap = (a: number, b: number): number =>
            words[a]!.line !== words[b]!.line
                ? LINE_GAP_EM * Math.min(measure(a).size, measure(b).size)
                : 0;
        const ys = new Map<number, number>([[focus, 0]]);
        for (let i = focus - 1; i >= from; i--) {
            ys.set(i, ys.get(i + 1)! - (rowH(i + 1) / 2 + rowH(i) / 2 + gap(i, i + 1)));
        }
        for (let i = focus + 1; i <= to; i++) {
            const overlap = UPCOMING_OVERLAP_EM * measure(i).size;
            ys.set(i, ys.get(i - 1)! + (rowH(i - 1) / 2 + rowH(i) / 2 + gap(i - 1, i) - overlap));
        }
        return ys;
    }

    return {
        destroy() {
            clearNodes();
            scene?.remove();
            scene = null;
            wall = null;
        },

        frame({
            height: H,
            reducedMotion = false,
            songMs: t,
            wallMs,
            width: W,
        }: FrameInfo): boolean {
            if (!wall) return false;
            if (W !== viewW || H !== viewH) {
                viewW = W;
                viewH = H;
                clearNodes();
                measures.clear();
            }

            // The whole wall drifts slowly in 3D, independent of the song, so it keeps breathing while paused.
            const tau = Math.PI * 2;
            const ry = reducedMotion
                ? 0
                : 11 * Math.sin((tau * wallMs) / 17_000) + 4 * Math.sin((tau * wallMs) / 7_300);
            const rx = reducedMotion ? 0 : 6 * Math.sin((tau * wallMs) / 13_000 + 1);
            const tx = reducedMotion ? 0 : 0.015 * W * Math.sin((tau * wallMs) / 23_000);
            const focusY = H * FOCUS_Y[mode];
            setStyle(wall, 'transform-origin', `0px ${focusY}px`);
            setStyle(
                wall,
                'transform',
                `translate3d(${tx.toFixed(2)}px, 0, 0) rotateX(${rx.toFixed(3)}deg) rotateY(${ry.toFixed(3)}deg)`,
            );

            const words = model?.words ?? [];
            let c = model ? activeWordIndex(model, t) : -1;
            const preview = c < 0;
            if (!words.length || (preview && t < words[0]!.start - PREVIEW_MS)) {
                clearNodes();
                return false;
            }
            if (preview) c = 0;

            const current = words[c]!;
            const enterMs = Math.min(ENTER_MS, Math.max(90, (current.end - current.start) * 0.8));
            const p = preview ? 0 : reducedMotion ? 1 : clamp((t - current.start) / enterMs);
            const e = easeOutCubic(p);
            const from = Math.max(0, c - HISTORY);
            const to = Math.min(words.length - 1, c + LOOKAHEAD);
            const target = layout(c, from, to);
            const before =
                !preview && c > 0 ? layout(c - 1, Math.max(0, c - 1 - HISTORY), to) : null;

            // Dim the wall during long instrumental gaps; wake it just before singing resumes.
            const next = words[c + 1];
            const idle = preview ? 0 : t - current.end;
            const nextIn = next ? next.start - t : Number.POSITIVE_INFINITY;
            const dim = clamp((idle - 2500) / 1500) * clamp((nextIn - 400) / 1200);
            const previewFade = preview ? clamp((t - (words[0]!.start - PREVIEW_MS)) / 800) : 1;

            const shown = new Set<number>();
            for (let i = from; i <= to; i++) {
                const n = node(i);
                const m = measure(i);
                shown.add(i);
                const yTarget = target.get(i)!;
                const y = lerp(before?.get(i) ?? yTarget, yTarget, e);
                const x = hashSigned(i + 1) * W * 0.035 - (m.size * (m.unit + 2 * PAD_X_EM)) / 2;

                let z = 0;
                let scale = 1;
                let opacity = 1;
                let color = palette.lyric;
                let boxOpacity = 0;
                let boxScale = 1;

                if (preview) {
                    const k = i - c;
                    color = palette.secondary;
                    opacity = (k === 0 ? 0.66 : k === 1 ? 0.3 : 0.12) * previewFade;
                    z = -40 - 30 * k;
                } else if (i === c) {
                    scale = lerp(0.82, 1, easeOutBack(p));
                    z = lerp(-80, 0, e);
                    boxOpacity = t < current.end ? 1 : 0;
                    boxScale = reducedMotion ? 1 : easeOutCubic((t - current.start) / WIPE_MS);
                    // Text turns light in step with the box wiping in, so it never floats without its box.
                    color =
                        t < current.end
                            ? mixHex(palette.secondary, palette.highlightText, boxScale)
                            : palette.lyric;
                } else if (i < c) {
                    const age = c - i - 1 + e;
                    z = -70 * age;
                    if (i === c - 1) {
                        color = mixHex(palette.highlightText, palette.lyric, e);
                        boxOpacity = 1 - clamp(p * 1.8);
                    }
                    // On black, lowering opacity doubles as depth fog.
                    opacity =
                        (1 - Math.min(0.55, 0.11 * age)) * clamp(HISTORY - age) * (1 - 0.65 * dim);
                } else {
                    const k = i - c;
                    color = palette.secondary;
                    const entering = before && before.has(i) ? 1 : e;
                    opacity = (k === 1 ? 0.66 : 0.3) * entering * (1 - 0.5 * dim);
                    z = -40 - 30 * (k - 1);
                }

                // On the lock screen, words dissolve as they rise toward the clock.
                if (mode === 'lock')
                    opacity *= clamp((focusY + y - H * CLOCK_FADE_TOP) / (H * CLOCK_FADE_SPAN));

                const top = focusY + y - (m.size * BOX_EM) / 2;
                setStyle(
                    n.root,
                    'transform',
                    `translate3d(${x.toFixed(1)}px, ${top.toFixed(1)}px, ${z.toFixed(1)}px) scale(${scale.toFixed(4)})`,
                );
                setStyle(n.root, 'opacity', opacity.toFixed(3));
                setStyle(n.text, 'color', color);
                if (n.icon && n.iconColor !== color) {
                    if (m.icon?.kind === 'fluent') n.icon.innerHTML = fluentSvg(m.icon, color);
                    setStyle(n.icon, 'color', color);
                    n.iconColor = color;
                }
                setStyle(n.box, 'background', palette.highlight);
                setStyle(n.box, 'opacity', boxOpacity.toFixed(3));
                setStyle(n.box, 'transform', `scaleX(${boxScale.toFixed(4)})`);
            }

            for (const [i, n] of nodes) {
                if (!shown.has(i)) {
                    n.root.remove();
                    nodes.delete(i);
                }
            }

            const since = t - current.start;
            return preview
                ? previewFade < 1
                : since < Math.max(enterMs, WIPE_MS) + 80 || (dim > 0.001 && dim < 0.999);
        },

        mount(root) {
            scene = document.createElement('div');
            scene.className = 'ship-scene';
            wall = document.createElement('div');
            wall.className = 'ship-wall';
            scene.append(wall);
            root.append(scene);
        },

        async ready() {
            await document.fonts.load('700 100px "Feishin Aesthetics Inter"');
            if (wall) {
                clearNodes();
                measures.clear();
            }
        },

        setLyrics(next) {
            clearNodes();
            measures.clear();
            model = next;
        },

        setMode(next: ShowOn) {
            mode = next;
        },

        setPalette(next) {
            palette = next;
        },
    };
}
