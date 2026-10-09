export type ColorRole = 'highlight' | 'lyric' | 'secondary';

export type LyricsStatus = 'error' | 'found' | 'idle' | 'instrumental' | 'not-found' | 'searching';

/** All colours are lowercase `#rrggbb`. */
export interface Palette {
    highlight: string;
    /** Text drawn on top of the highlight box. */
    highlightText: string;
    lyric: string;
    secondary: string;
}

/**
 * Song position `positionMs` was true at wall-clock `atEpochMs`.
 * While `playing`, the current position is extrapolated from that anchor.
 */
export interface PlaybackAnchor {
    atEpochMs: number;
    playing: boolean;
    positionMs: number;
    rate: number;
    trackKey: string;
}

/** Where the words show: the lock-style screen, or an always-on overlay. */
export type ShowOn = 'always' | 'lock';

/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
/** The lyric display styles, including icon-enhanced variants. */
export type StyleId = 'fisheye' | 'fisheye-visual' | 'ship' | 'ship-visual' | 'visual';

export interface TimedLine {
    end: number;
    start: number;
    text: string;
    words: TimedWord[];
}

export interface TimedLyrics {
    lines: TimedLine[];
    /** `native` when the source carried per-word tags, `estimated` otherwise. */
    wordTiming: 'estimated' | 'native';
}

/** Times are integer milliseconds of song time. */
export interface TimedWord {
    end: number;
    start: number;
    text: string;
}

export interface TrackInfo {
    album: string;
    app: string;
    artist: string;
    /** 0 when the player does not report a duration. */
    durationMs: number;
    /** Stable identity of the track within one player session. */
    key: string;
    title: string;
}

export const STYLE_IDS: readonly StyleId[] = [
    'ship',
    'ship-visual',
    'fisheye',
    'fisheye-visual',
    'visual',
];

export const STYLE_LABELS: Record<StyleId, string> = {
    fisheye: 'Fisheye',
    'fisheye-visual': 'Fisheye Visual',
    ship: 'Ship',
    'ship-visual': 'Ship + Visual',
    visual: 'Visual',
};
