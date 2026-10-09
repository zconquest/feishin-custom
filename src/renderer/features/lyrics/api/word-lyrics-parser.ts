import type { SyncedWordCue, SynchronizedLyrics } from '/@/shared/types/domain-types';

export const WORD_LYRICS_BACKGROUND_WARNING =
    'Background vocals omitted. Only the foreground vocal stream is shown; source timestamps are unchanged.';

export const WORD_LYRICS_MAX_BYTES = 2 * 1024 * 1024;

export const parseWordTime = (value: string): number => {
    const clock = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
    if (clock) {
        const [, hours, minutes, seconds, fraction = '0'] = clock;
        if (Number(seconds) >= 60 || (hours && Number(minutes) >= 60))
            throw Error('Invalid lyric timestamp');
        return (
            (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 +
            Number(fraction.padEnd(3, '0'))
        );
    }
    const offset = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(value);
    if (offset) return Number(offset[1]) * (offset[2] === 's' ? 1000 : 1);
    throw Error('Unsupported lyric timestamp: use clock times or seconds');
};

const validateWords = (words: SyncedWordCue[]) => {
    for (const word of words) {
        if (
            !Number.isFinite(word.startMs) ||
            !Number.isFinite(word.endMs) ||
            word.startMs < 0 ||
            word.endMs <= word.startMs
        ) {
            throw Error('Word cues must have valid increasing start and end times');
        }
    }
};

const hasCompleteText = (words: SyncedWordCue[], text: string) =>
    words
        .map((word) => word.text)
        .join('')
        .replace(/\s+/g, '') === text.replace(/\s+/g, '');

const requireWords = (lyrics: SynchronizedLyrics) => {
    if (!lyrics.some((line) => line.cueLines?.some((cue) => cue.words.length))) {
        throw Error('This file has no word timing. Choose a word-timed TTML or Enhanced LRC file.');
    }
    return lyrics.sort((a, b) => a.startMs - b.startMs);
};

export const parseEnhancedLrc = (source: string): SynchronizedLyrics => {
    const offset = /\[offset:([+-]?\d+)\]/i.exec(source);
    if (offset && Number(offset[1]) !== 0)
        throw Error(
            'Import requires timestamps with any LRC offset already applied. Nonzero offset metadata is not supported.',
        );
    const lyrics: SynchronizedLyrics = [];
    for (const raw of source.split(/\r?\n/)) {
        const match = /^\[(\d+:\d{2}(?:\.\d{1,3})?)\](.*)$/.exec(raw.trim());
        if (!match) continue;
        const startMs = parseWordTime(match[1]);
        const markers = [...match[2].matchAll(/<(\d+:\d{2}(?:\.\d{1,3})?)>/g)];
        const words: SyncedWordCue[] = [];
        for (let index = 0; index < markers.length; index += 1) {
            const marker = markers[index];
            const next = markers[index + 1];
            const text = match[2].slice(marker.index! + marker[0].length, next?.index);
            if (!text.trim()) continue;
            if (!next)
                throw Error(
                    'The final word needs an end timestamp marker. No word durations will be guessed.',
                );
            words.push({ endMs: parseWordTime(next[1]), startMs: parseWordTime(marker[1]), text });
        }
        validateWords(words);
        lyrics.push({
            startMs,
            text: match[2].replace(/<\d+:\d{2}(?:\.\d{1,3})?>/g, ''),
            ...(words.length &&
            hasCompleteText(words, match[2].replace(/<\d+:\d{2}(?:\.\d{1,3})?>/g, ''))
                ? {
                      cueLines: [
                          {
                              endMs: words.at(-1)!.endMs,
                              index: 0,
                              startMs: words[0].startMs,
                              value: words.map((word) => word.text).join(''),
                              words,
                          },
                      ],
                  }
                : {}),
        });
    }
    return requireWords(lyrics);
};

const role = (element: Element) =>
    Array.from(element.attributes).find((attribute) => attribute.localName === 'role')?.value ?? '';
const isAnnotation = (element: Element) => /translation|roman|pronunciation/i.test(role(element));

const isBackground = (element: Element) =>
    role(element)
        .split(/\s+/)
        .some((token) => ['background', 'bg', 'x-bg'].includes(token.toLowerCase()));

const parseWordTtmlWithWarnings = (source: string) => {
    if (/<!DOCTYPE|<!ENTITY/i.test(source))
        throw Error('TTML document types and entities are not supported');
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (document.getElementsByTagName('parsererror').length)
        throw Error('The TTML file is not valid XML');
    const elements = Array.from(document.getElementsByTagName('*'));
    const omittedBackground = elements.some(isBackground);
    // Project onto the foreground stream before extracting text or validating its timing.
    for (const element of elements)
        if (isBackground(element) || isAnnotation(element))
            element.parentNode?.removeChild(element);
    const lyrics: SynchronizedLyrics = [];
    for (const line of Array.from(document.getElementsByTagName('*')).filter(
        (element) => element.localName === 'p',
    )) {
        const text = (line.textContent ?? '').trim();
        if (!text) continue;
        const begin = line.getAttribute('begin');
        if (!begin) throw Error('TTML lines must contain absolute begin timestamps');
        const startMs = parseWordTime(begin);
        const words: SyncedWordCue[] = [];
        const spans = Array.from(line.getElementsByTagName('*')).filter(
            (element) => element.localName === 'span',
        );
        for (const span of spans) {
            if (!span.hasAttribute('begin')) continue;
            if (
                Array.from(span.getElementsByTagName('*')).some((child) =>
                    child.hasAttribute('begin'),
                )
            )
                continue;
            const end = span.getAttribute('end');
            if (!end) throw Error('Each TTML word must have an end timestamp');
            words.push({
                endMs: parseWordTime(end),
                startMs: parseWordTime(span.getAttribute('begin')!),
                text: span.textContent ?? '',
            });
        }
        validateWords(words);
        const endMs = line.getAttribute('end')
            ? parseWordTime(line.getAttribute('end')!)
            : Infinity;
        if (words.some((word) => word.startMs < startMs || word.endMs > endMs))
            throw Error('TTML word times must lie inside their absolute line timestamps');
        lyrics.push({
            startMs,
            text,
            ...(words.length && hasCompleteText(words, text)
                ? {
                      cueLines: [
                          {
                              endMs: Math.max(...words.map((word) => word.endMs)),
                              index: 0,
                              startMs: words[0].startMs,
                              value: text,
                              words,
                          },
                      ],
                  }
                : {}),
        });
    }
    if (omittedBackground && !lyrics.some((line) => line.cueLines?.some((cue) => cue.words.length)))
        throw Error(
            'This TTML has no foreground word timing after background vocals are omitted. Choose another lyric version.',
        );
    return {
        lyrics: requireWords(lyrics),
        warnings: omittedBackground ? [WORD_LYRICS_BACKGROUND_WARNING] : [],
    };
};

export const parseWordTtml = (source: string): SynchronizedLyrics =>
    parseWordTtmlWithWarnings(source).lyrics;

export const parseWordLyricsFileWithWarnings = (source: string, filename: string) => {
    if (!/\.(lrc|ttml)$/i.test(filename)) throw Error('Choose a .lrc or .ttml lyric file');
    if (new TextEncoder().encode(source).byteLength > WORD_LYRICS_MAX_BYTES)
        throw Error('Lyric files must be smaller than 2 MB');
    return filename.toLowerCase().endsWith('.ttml')
        ? parseWordTtmlWithWarnings(source)
        : { lyrics: parseEnhancedLrc(source), warnings: [] };
};

export const parseWordLyricsFile = (source: string, filename: string) =>
    parseWordLyricsFileWithWarnings(source, filename).lyrics;

const formatTime = (time: number) => {
    const milliseconds = Math.round(time);
    return `${Math.floor(milliseconds / 60000)
        .toString()
        .padStart(2, '0')}:${Math.floor((milliseconds % 60000) / 1000)
        .toString()
        .padStart(2, '0')}.${(milliseconds % 1000).toString().padStart(3, '0')}`;
};

export const exportEnhancedLrc = (lyrics: SynchronizedLyrics) =>
    lyrics
        .map((line) => {
            const words = line.cueLines?.flatMap((cue) => cue.words) ?? [];
            return `[${formatTime(line.startMs)}]${words.length ? words.map((word) => `<${formatTime(word.startMs)}>${word.text}<${formatTime(word.endMs)}>`).join('') : line.text}`;
        })
        .join('\n');
