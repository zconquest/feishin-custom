/*
 * YRC syllable merging adapted from theaestheticslyrics at
 * https://github.com/darshanseenivasakumar/theaestheticslyrics
 * commit 499161944ce1af965398ce038073dcd890bf5f66 (src/main/lyrics/yrc.ts).
 *
 * MIT License
 * Copyright (c) 2026 darshanseenivasakumar
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { SyncedWordCue, SynchronizedLyrics } from '/@/shared/types/domain-types';

const MAX_TIME_MS = 3 * 60 * 60 * 1000;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff66-\uff9f\uac00-\ud7af]/u;
const invalid = () => new Error('NetEase returned invalid word timings. Try another recording.');

/** Native YRC times are absolute milliseconds. No timings are interpolated or subdivided. */
export function parseNetEaseYrc(text: string): SynchronizedLyrics {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1024 * 1024) {
        throw invalid();
    }
    const lyrics: SynchronizedLyrics = [];
    let previousStart = -1;
    let totalWords = 0;
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        if (line.startsWith('{')) {
            try {
                const metadata = JSON.parse(line);
                if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
                    throw invalid();
                }
            } catch {
                throw invalid();
            }
            continue;
        }
        const head = /^\[(\d+),(\d+)\]/.exec(line);
        if (!head) {
            throw invalid();
        }
        const startMs = Number(head[1]);
        const endMs = startMs + Number(head[2]);
        if (
            !Number.isSafeInteger(startMs) ||
            !Number.isSafeInteger(endMs) ||
            endMs > MAX_TIME_MS ||
            endMs <= startMs ||
            startMs < previousStart ||
            lyrics.length >= 2000
        ) {
            throw invalid();
        }
        previousStart = startMs;
        const body = line.slice(head[0].length);
        const stamps = [...body.matchAll(/\((\d+),(\d+),(-?\d+)\)/g)];
        if (!stamps.length || body.slice(0, stamps[0].index).trim() || stamps.length > 1000) {
            throw invalid();
        }
        const words: SyncedWordCue[] = [];
        const pieces: string[] = [];
        let pending: SyncedWordCue | undefined;
        let leadingWhitespace = '';
        let previousEnd = startMs;
        const flush = () => {
            if (pending) {
                words.push(pending);
                pending = undefined;
            }
        };
        stamps.forEach((stamp, index) => {
            const pieceStart = Number(stamp[1]);
            const pieceEnd = pieceStart + Number(stamp[2]);
            const flag = Number(stamp[3]);
            const piece = body.slice(
                stamp.index! + stamp[0].length,
                stamps[index + 1]?.index ?? body.length,
            );
            // A malformed timing tuple must never be mistaken for sung text.
            if (
                piece.length > 2000 ||
                /\([^)]*,[^)]*,[^)]*\)/.test(piece) ||
                !Number.isSafeInteger(pieceStart) ||
                !Number.isSafeInteger(pieceEnd) ||
                !Number.isSafeInteger(flag) ||
                Math.abs(flag) > 10000 ||
                pieceStart < previousEnd ||
                pieceEnd > endMs ||
                pieceEnd < pieceStart
            ) {
                throw invalid();
            }
            previousEnd = pieceEnd;
            pieces.push(piece);
            const word = piece.trim();
            if (!word) {
                if (pending) {
                    pending.text += piece;
                } else if (words.length) {
                    words[words.length - 1].text += piece;
                } else {
                    leadingWhitespace += piece;
                }
                flush();
                return;
            }
            if (/^\s/u.test(piece)) {
                flush();
            }
            if (CJK.test(word)) {
                flush();
                words.push({
                    endMs: pieceEnd,
                    startMs: pieceStart,
                    text: leadingWhitespace + piece,
                });
                leadingWhitespace = '';
            } else if (pending) {
                pending.text += piece;
                pending.endMs = pieceEnd;
            } else {
                pending = { endMs: pieceEnd, startMs: pieceStart, text: leadingWhitespace + piece };
                leadingWhitespace = '';
            }
            if (/\s$/u.test(piece)) {
                flush();
            }
        });
        flush();
        if (!words.length) {
            throw invalid();
        }
        const usable = words.every((word) => word.endMs > word.startMs);
        totalWords += usable ? words.length : 0;
        if (totalWords > 25000) {
            throw invalid();
        }
        const value = pieces.join('').trim();
        if (
            !value ||
            value.length > 20000 ||
            words
                .map((word) => word.text)
                .join('')
                .trim() !== value
        ) {
            throw invalid();
        }
        // Zero-duration syllables may belong to a word with a genuine positive interval.
        // A standalone zero-duration word cannot be animated honestly, so retain its whole line.
        lyrics.push({
            ...(usable
                ? { cueLines: [{ endMs, index: lyrics.length, startMs, value, words }] }
                : {}),
            startMs,
            text: value,
        });
    }
    if (!totalWords) {
        throw new Error(
            'This recording has no individual word timings on NetEase. Try another recording or generate timings locally.',
        );
    }
    return lyrics;
}
