import type { SynchronizedLyrics } from '/@/shared/types/domain-types';

import { normalizeLyrics } from './lyrics-utils';

export type VisualLyricCue = { endMs: number; startMs: number; text: string; wordTimed: boolean };

/** Keep source timings intact. A line without word cues stays a whole line. */
export const buildVisualLyricCues = (lyrics: SynchronizedLyrics): VisualLyricCue[] => {
    const lines = normalizeLyrics(lyrics);
    return lines
        .flatMap((line, index) => {
            const words = line.cueLines?.flatMap((cue) => cue.words) ?? [];
            if (words.length) {
                return words.map((word) => ({ ...word, wordTimed: true }));
            }
            return [
                {
                    endMs: lines[index + 1]?.startMs ?? Infinity,
                    startMs: line.startMs,
                    text: line.text,
                    wordTimed: false,
                },
            ];
        })
        .filter((cue) => cue.text.trim() && Number.isFinite(cue.startMs) && cue.endMs > cue.startMs)
        .sort((a, b) => a.startMs - b.startMs);
};

/** Anchor the stack to the latest cue, but only light it during its real interval. */
export const getVisualLyricPosition = (cues: VisualLyricCue[], timeMs: number) => {
    let low = 0;
    let high = cues.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (cues[middle].startMs <= timeMs) low = middle + 1;
        else high = middle;
    }
    const index = low - 1;
    return { active: index >= 0 && timeMs < cues[index].endMs, index };
};

export const getVisualPlaybackTime = (
    anchorMs: number,
    elapsedMs: number,
    playing: boolean,
    speed: number,
    offsetMs: number,
) => anchorMs + (playing ? Math.max(0, elapsedMs) * speed : 0) + offsetMs;
