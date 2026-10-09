import type { SynchronizedLyrics } from '/@/shared/types/domain-types';

import { queryOptions } from '@tanstack/react-query';
import { del, get, set } from 'idb-keyval';

import { WORD_LYRICS_MAX_BYTES } from './word-lyrics-parser';

export type LocalWordLyrics = {
    album?: string;
    artist?: string;
    createdAt: string;
    durationMs?: number;
    lyrics: SynchronizedLyrics;
    name: string;
    origin?: string;
    quality: string;
    source: 'amll' | 'generated' | 'imported' | 'netease' | 'unison';
    warnings: string[];
};

const recordKey = (serverId: string, songId: string) =>
    `word-lyrics:v1:${JSON.stringify([serverId, songId])}`;
export const readLocalWordLyrics = async (serverId: string, songId: string) => {
    const record = await get<LocalWordLyrics>(recordKey(serverId, songId));
    if (!record) return null;
    if (
        !Array.isArray(record.lyrics) ||
        typeof record.name !== 'string' ||
        typeof record.quality !== 'string' ||
        typeof record.createdAt !== 'string' ||
        (record.durationMs !== undefined &&
            (!Number.isFinite(record.durationMs) || record.durationMs < 0)) ||
        !['amll', 'generated', 'imported', 'netease', 'unison'].includes(record.source) ||
        !Array.isArray(record.warnings) ||
        !record.lyrics.every(
            (line) =>
                line &&
                typeof line.text === 'string' &&
                Number.isFinite(line.startMs) &&
                line.startMs >= 0 &&
                (!line.cueLines ||
                    (Array.isArray(line.cueLines) &&
                        line.cueLines.every(
                            (cue) =>
                                cue &&
                                Array.isArray(cue.words) &&
                                cue.words.every(
                                    (word) =>
                                        word &&
                                        typeof word.text === 'string' &&
                                        Number.isFinite(word.startMs) &&
                                        Number.isFinite(word.endMs) &&
                                        word.startMs >= 0 &&
                                        word.endMs > word.startMs,
                                ),
                        ))),
        )
    ) {
        throw Error(
            'Stored word lyrics are invalid. Clear the local word timing and import again.',
        );
    }
    return record;
};
export const saveLocalWordLyrics = (serverId: string, songId: string, record: LocalWordLyrics) =>
    set(recordKey(serverId, songId), record);
export const clearLocalWordLyrics = (serverId: string, songId: string) =>
    del(recordKey(serverId, songId));

const RAW_ROOT = 'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/';
const CATALOG_URL = `${RAW_ROOT}metadata/raw-lyrics-index.jsonl`;
const FILE_PATTERN = /^[a-zA-Z0-9_-]+\.ttml$/;

const fetchBoundedText = async (
    url: string,
    externalSignal?: AbortSignal,
    maxBytes = WORD_LYRICS_MAX_BYTES,
) => {
    const signal = externalSignal
        ? AbortSignal.any([externalSignal, AbortSignal.timeout(25000)])
        : AbortSignal.timeout(25000);
    const response = await fetch(url, { credentials: 'omit', redirect: 'error', signal });
    if (response.status === 429)
        throw Error('The lyric provider is rate limiting requests. Wait before searching again.');
    if (response.status === 404)
        throw Error('The selected lyrics were not found. Search again for another version.');
    if (!response.ok || !response.body)
        throw Error(`Public lyric download failed (${response.status})`);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBytes) throw Error('Public lyric response exceeds its size limit');
            chunks.push(value);
        }
    } finally {
        await reader.cancel();
        reader.releaseLock();
    }
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
};

export type PublicWordLyric = { album: string; artists: string; filename: string; name: string };
export const parsePublicWordCatalog = (text: string): PublicWordLyric[] => {
    const rows = text.split(/\r?\n/).filter(Boolean);
    if (rows.length > 30000) throw Error('Public lyric catalog exceeds its entry limit');
    return rows.flatMap((row) => {
        const value: unknown = JSON.parse(row);
        if (
            !value ||
            typeof value !== 'object' ||
            !('metadata' in value) ||
            !('rawLyricFile' in value) ||
            !Array.isArray(value.metadata) ||
            typeof value.rawLyricFile !== 'string' ||
            !FILE_PATTERN.test(value.rawLyricFile)
        )
            return [];
        const metadata = value.metadata;
        if (metadata.length > 100 || value.rawLyricFile.length > 200) return [];
        const field = (key: string) =>
            metadata
                .filter(
                    (item: unknown) =>
                        Array.isArray(item) && item[0] === key && Array.isArray(item[1]),
                )
                .flatMap((item: [string, unknown[]]) =>
                    item[1].filter(
                        (entry): entry is string =>
                            typeof entry === 'string' && entry.length <= 1000,
                    ),
                )
                .join(', ');
        const name = field('musicName');
        return name
            ? [
                  {
                      album: field('album'),
                      artists: field('artists'),
                      filename: value.rawLyricFile,
                      name,
                  },
              ]
            : [];
    });
};

export const publicWordCatalogQuery = () =>
    queryOptions({
        gcTime: 24 * 60 * 60 * 1000,
        queryFn: async ({ signal }) =>
            parsePublicWordCatalog(await fetchBoundedText(CATALOG_URL, signal, 8 * 1024 * 1024)),
        queryKey: ['public-word-lyrics', 'amll', 'catalog'],
        staleTime: 24 * 60 * 60 * 1000,
    });

export const fetchPublicWordLyrics = (filename: string, signal: AbortSignal) => {
    if (!FILE_PATTERN.test(filename)) throw Error('Invalid public lyric filename');
    return fetchBoundedText(`${RAW_ROOT}raw-lyrics/${filename}`, signal);
};

const UNISON_ROOT = 'https://unison.boidu.dev';
export type UnisonWordLyric = {
    album: string;
    artist: string;
    confidence: string;
    id: number;
    name: string;
};

const objectValue = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('Invalid Unison response');
    return value as Record<string, unknown>;
};
const unisonId = (id: unknown): number => {
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
        throw Error('Invalid Unison lyric id');
    return id;
};
const metadataText = (value: unknown, required = false): string => {
    if (value === undefined || value === null) {
        if (required) throw Error('Unison lyric metadata is missing');
        return '';
    }
    if (typeof value !== 'string' || value.length > 1000 || (required && !value.trim()))
        throw Error('Invalid Unison lyric metadata');
    return value;
};
const unisonEnvelope = (value: unknown): unknown => {
    const envelope = objectValue(value);
    if (envelope.success !== true || !('data' in envelope))
        throw Error('Unison did not return successful lyric data');
    return envelope.data;
};
const unisonCandidate = (value: unknown): null | UnisonWordLyric => {
    const row = objectValue(value);
    const id = unisonId(row.id);
    const name = metadataText(row.song, true);
    const artist = metadataText(row.artist, true);
    const album = metadataText(row.album);
    const confidence = metadataText(row.confidence);
    if (row.format !== 'ttml' || row.syncType !== 'richsync') return null;
    return { album, artist, confidence, id, name };
};

export const parseUnisonSearch = (value: unknown): UnisonWordLyric[] => {
    const data = unisonEnvelope(value);
    if (!Array.isArray(data) || data.length > 50) throw Error('Invalid Unison search results');
    return data.flatMap((row) => {
        const candidate = unisonCandidate(row);
        return candidate ? [candidate] : [];
    });
};

export const parseUnisonRecord = (value: unknown, requestedId: number) => {
    unisonId(requestedId);
    const row = objectValue(unisonEnvelope(value));
    const candidate = unisonCandidate(row);
    if (!candidate || candidate.id !== requestedId)
        throw Error('Unison returned a different lyric version or unsupported timing');
    if (
        typeof row.lyrics !== 'string' ||
        !row.lyrics.trim() ||
        new TextEncoder().encode(row.lyrics).byteLength > WORD_LYRICS_MAX_BYTES
    )
        throw Error('Invalid or oversized Unison lyric body');
    return { ...candidate, text: row.lyrics };
};

export const searchUnisonWordLyrics = async (
    title: string,
    artist: string,
    signal: AbortSignal,
) => {
    if (!title.trim() || title.length > 500 || artist.length > 500)
        throw Error('Enter a song title and artist shorter than 500 characters');
    const params = new URLSearchParams({
        limit: '50',
        q: [title.trim(), artist.trim()].filter(Boolean).join(' '),
    });
    return parseUnisonSearch(
        JSON.parse(await fetchBoundedText(`${UNISON_ROOT}/lyrics/search?${params}`, signal)),
    );
};

export const fetchUnisonWordLyrics = async (id: number, signal: AbortSignal) => {
    unisonId(id);
    return parseUnisonRecord(
        JSON.parse(await fetchBoundedText(`${UNISON_ROOT}/lyrics/${id}`, signal)),
        id,
    );
};
