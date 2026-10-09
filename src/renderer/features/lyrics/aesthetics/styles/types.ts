import type { LyricsModel } from '../model';
/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
import type { Palette, ShowOn } from '../types';

export interface FrameInfo {
    height: number;
    reducedMotion?: boolean;
    /** Song time in ms (already offset-corrected). */
    songMs: number;
    /** Monotonic wall time in ms, for ambient motion that continues while paused. */
    wallMs: number;
    width: number;
}

/**
 * A display style. `frame` must be a pure function of its inputs plus the lyrics,
 * palette and size, so seeking, pausing and snapshots always render correctly.
 */
export interface StageStyle {
    destroy(): void;
    /**
     * Draws one frame. Returns true while a transition is running (needs full frame rate);
     * false when only slow ambient motion is left, so the stage can save power.
     */
    frame(frame: FrameInfo): boolean;
    mount(root: HTMLElement): void;
    /** One-frame invalidation for asynchronous assets or GPU fallback while paused. */
    onInvalidate?(listener: () => void): () => void;
    /** Resolves once async assets (icons, fonts) are loaded; snapshot mode waits for it. */
    ready?(): Promise<void>;
    setLyrics(model: LyricsModel | null): void;
    setMode(mode: ShowOn): void;
    setPalette(palette: Palette): void;
}
