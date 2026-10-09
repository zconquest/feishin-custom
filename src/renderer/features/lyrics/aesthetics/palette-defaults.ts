/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
import type { ColorRole, Palette } from './types';

/** Sampled from Verci's Ship style: red sung words, pink-red highlight box, soft pink upcoming words. */
export const DEFAULT_COLORS: Readonly<Record<ColorRole, string>> = Object.freeze({
    highlight: '#ca415e',
    lyric: '#dc372a',
    secondary: '#e7b9c2',
});

export const DEFAULT_HIGHLIGHT_TEXT = '#fff1f3';

export const DEFAULT_PALETTE: Readonly<Palette> = Object.freeze({
    ...DEFAULT_COLORS,
    highlightText: DEFAULT_HIGHLIGHT_TEXT,
});

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
