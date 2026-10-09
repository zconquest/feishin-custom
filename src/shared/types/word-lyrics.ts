import type { SynchronizedLyrics } from './domain-types';

export type NetEaseWordLyricsGetRequest = { id: string; requestId: string };

export type NetEaseWordLyricsResult = { lyrics: SynchronizedLyrics; warnings?: string[] };

export type NetEaseWordLyricsSearchRequest = { artist: string; requestId: string; title: string };
export type NetEaseWordLyricsSong = {
    album: string;
    artist: string;
    durationMs: number;
    id: string;
    name: string;
};

export type WordLyricsGenerationRequest = {
    audioUrl: string;
    durationMs: number;
    jobId: string;
    language: string;
    lines: { endMs: number; startMs: number; text: string }[];
    serverUrl: string;
};
export type WordLyricsGenerationResult = {
    alignedWords: number;
    estimatedWords?: number;
    lyrics: SynchronizedLyrics;
    totalWords: number;
    warnings: string[];
};
/** Progress is a percentage from 0 to 100. */
export type WordLyricsProgress = { jobId: string; message: string; progress: number };
export type WordLyricsStatus = { available: boolean; message: string };
