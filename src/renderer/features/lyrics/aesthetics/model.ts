/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
import type { TimedLine, TimedLyrics } from './types';

export interface FlatWord {
    end: number;
    global: number;
    indexInLine: number;
    line: number;
    start: number;
    text: string;
}

export interface LyricsModel {
    lines: TimedLine[];
    words: FlatWord[];
}

export function buildModel(lyrics: TimedLyrics): LyricsModel {
    const words: FlatWord[] = [];
    lyrics.lines.forEach((line, lineIndex) => {
        line.words.forEach((w, indexInLine) => {
            words.push({
                end: w.end,
                global: words.length,
                indexInLine,
                line: lineIndex,
                start: w.start,
                text: w.text,
            });
        });
    });
    return { lines: lyrics.lines, words };
}

/** Index of the last item whose start is <= t (binary search); -1 before the first. */
function lastStartedBefore(items: { start: number }[], t: number): number {
    let lo = 0;
    let hi = items.length - 1;
    let found = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (items[mid]!.start <= t) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

/** The word being sung (or last sung, through gaps); -1 before the first word. */
export const activeWordIndex = (model: LyricsModel, t: number): number =>
    lastStartedBefore(model.words, t);

export const activeLineIndex = (model: LyricsModel, t: number): number =>
    lastStartedBefore(model.lines, t);

/** Milliseconds until the next word starts (Infinity when no word follows), so frames can land on time. */
export function msUntilNextWord(model: LyricsModel, t: number): number {
    const next = model.words[activeWordIndex(model, t) + 1];
    return next ? next.start - t : Number.POSITIVE_INFINITY;
}
