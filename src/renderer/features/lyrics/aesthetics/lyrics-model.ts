import type { SynchronizedLyrics } from '/@/shared/types/domain-types';

import { normalizeLyrics } from '../api/lyrics-utils';
import { buildModel } from './model';

/** A foreground model with genuine source word intervals; untimed lines remain empty. */
export const buildAestheticsLyricsModel = (
    lyrics: SynchronizedLyrics,
    sanitize: (text: string) => string,
) => {
    const lines = normalizeLyrics(lyrics)
        .filter((line) => Number.isFinite(line.startMs) && line.startMs >= 0)
        .map((line) => {
            const words = (line.cueLines?.flatMap((cue) => cue.words) ?? [])
                .filter(
                    (word) =>
                        Number.isFinite(word.startMs) &&
                        Number.isFinite(word.endMs) &&
                        word.startMs >= 0 &&
                        word.endMs > word.startMs,
                )
                .map((word) => ({
                    end: word.endMs,
                    start: word.startMs,
                    text: sanitize(word.text),
                }))
                .filter((word) => word.text.trim());
            return {
                end: words.reduce((end, word) => Math.max(end, word.end), line.startMs),
                start: line.startMs,
                text: sanitize(line.text),
                words,
            };
        })
        .sort((a, b) => a.start - b.start);
    const model = buildModel({ lines, wordTiming: 'native' });
    model.words.sort((a, b) => a.start - b.start);
    model.words.forEach((word, index) => {
        word.global = index;
    });
    return model;
};
