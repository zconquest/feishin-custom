import type {
    NetEaseWordLyricsGetRequest,
    NetEaseWordLyricsSearchRequest,
    NetEaseWordLyricsSong,
} from '/@/shared/types/word-lyrics';

import axios from 'axios';
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { join } from 'path';
import { pathToFileURL } from 'url';

import { parseNetEaseYrc } from './netease-parser';

// Public endpoint parameters follow the MIT reference pinned in netease-parser.ts.
const HOST = 'https://music.163.com';
const MAX_BYTES = 1024 * 1024;
const requests = new Map<WebContents, Map<string, AbortController>>();
const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const safeText = (value: unknown): value is string =>
    typeof value === 'string' && value.length <= 500;

export async function getNetEaseWords(query: NetEaseWordLyricsGetRequest, signal: AbortSignal) {
    if (
        !query ||
        typeof query.id !== 'string' ||
        !/^[1-9]\d{0,15}$/.test(query.id) ||
        !Number.isSafeInteger(Number(query.id))
    ) {
        throw new Error('Choose a valid NetEase search result.');
    }
    const body = await requestNetEase(
        '/api/song/lyric/v1',
        { id: query.id, kv: '-1', lv: '-1', rv: '-1', tv: '-1', yrv: '-1', ytv: '-1', yv: '-1' },
        signal,
    );
    if (!record(body.yrc) || typeof body.yrc.lyric !== 'string' || !body.yrc.lyric.trim()) {
        throw new Error(
            'This recording has no individual word timings on NetEase. Try another recording or generate timings locally.',
        );
    }
    const lyrics = parseNetEaseYrc(body.yrc.lyric);
    const fallbackLines = lyrics.filter(
        (line) => !line.cueLines?.some((cue) => cue.words.length),
    ).length;
    return {
        lyrics,
        warnings: fallbackLines
            ? [`${fallbackLines} lines have no usable NetEase word timing and retain line timing.`]
            : [],
    };
}

export function registerNetEaseWordLyrics() {
    ipcMain.handle('word-lyrics-netease-search', (event, query: NetEaseWordLyricsSearchRequest) => {
        assertTrustedSender(event);
        return ownedRequest(event.sender, query?.requestId, (signal) =>
            searchNetEaseWords(query, signal),
        );
    });
    ipcMain.handle('word-lyrics-netease-get', (event, query: NetEaseWordLyricsGetRequest) => {
        assertTrustedSender(event);
        return ownedRequest(event.sender, query?.requestId, (signal) =>
            getNetEaseWords(query, signal),
        );
    });
    ipcMain.handle('word-lyrics-netease-cancel', (event, requestId: unknown) => {
        assertTrustedSender(event);
        if (typeof requestId === 'string') {
            requests.get(event.sender)?.get(requestId)?.abort();
        }
    });
    app.on('before-quit', () => {
        for (const pending of requests.values()) {
            for (const controller of pending.values()) {
                controller.abort();
            }
        }
    });
}

export async function searchNetEaseWords(
    query: NetEaseWordLyricsSearchRequest,
    signal: AbortSignal,
): Promise<NetEaseWordLyricsSong[]> {
    if (
        !query ||
        typeof query.title !== 'string' ||
        !query.title.trim() ||
        query.title.length > 200 ||
        typeof query.artist !== 'string' ||
        query.artist.length > 200
    ) {
        throw new Error('Enter a song title and artist to search NetEase.');
    }
    const body = await requestNetEase(
        '/api/cloudsearch/pc',
        {
            limit: '20',
            offset: '0',
            s: `${query.title.trim()} ${query.artist.trim()}`.trim(),
            type: '1',
        },
        signal,
    );
    const songs = record(body.result) && Array.isArray(body.result.songs) ? body.result.songs : [];
    const result: NetEaseWordLyricsSong[] = [];
    for (const song of songs.slice(0, 100)) {
        if (
            !record(song) ||
            !Number.isSafeInteger(song.id) ||
            (song.id as number) <= 0 ||
            !safeText(song.name) ||
            !song.name.trim()
        ) {
            continue;
        }
        const artists = Array.isArray(song.ar)
            ? song.ar
            : Array.isArray(song.artists)
              ? song.artists
              : [];
        const artist = artists
            .slice(0, 20)
            .flatMap((item) => (record(item) && safeText(item.name) ? [item.name] : []))
            .join(', ');
        const album = record(song.al) ? song.al : record(song.album) ? song.album : undefined;
        const duration = song.dt ?? song.duration;
        if (
            typeof duration !== 'number' ||
            !Number.isSafeInteger(duration) ||
            duration <= 0 ||
            duration > 10800000 ||
            artist.length > 2000
        ) {
            continue;
        }
        result.push({
            album: album && safeText(album.name) ? album.name : '',
            artist,
            durationMs: duration,
            id: String(song.id),
            name: song.name,
        });
        if (result.length === 20) {
            break;
        }
    }
    return result;
}

function assertTrustedSender(event: IpcMainInvokeEvent) {
    try {
        const expected =
            !app.isPackaged && process.env.ELECTRON_RENDERER_URL
                ? new URL(process.env.ELECTRON_RENDERER_URL)
                : pathToFileURL(join(app.getAppPath(), 'out/renderer/index.html'));
        const actual = new URL(event.senderFrame?.url ?? '');
        if (
            event.senderFrame !== event.sender.mainFrame ||
            actual.protocol !== expected.protocol ||
            actual.host !== expected.host ||
            actual.pathname !== expected.pathname
        ) {
            throw new Error('Untrusted frame');
        }
    } catch {
        throw new Error('NetEase lyric requests must come from the Feishin player.');
    }
}

async function ownedRequest<T>(
    owner: WebContents,
    requestId: unknown,
    operation: (signal: AbortSignal) => Promise<T>,
) {
    if (typeof requestId !== 'string' || !/^[\w-]{1,100}$/.test(requestId) || owner.isDestroyed()) {
        throw new Error('Invalid NetEase lyric request.');
    }
    let pending = requests.get(owner);
    if (!pending) {
        pending = new Map();
        requests.set(owner, pending);
    }
    if (pending.has(requestId) || pending.size >= 4) {
        throw new Error(
            'Another NetEase lookup is already running. Cancel it or wait for it to finish.',
        );
    }
    const controller = new AbortController();
    pending.set(requestId, controller);
    const destroyed = () => controller.abort();
    owner.once('destroyed', destroyed);
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
        return await operation(controller.signal);
    } finally {
        clearTimeout(timeout);
        owner.removeListener('destroyed', destroyed);
        pending.delete(requestId);
        if (!pending.size) {
            requests.delete(owner);
        }
    }
}

async function requestNetEase(path: string, params: Record<string, string>, signal: AbortSignal) {
    try {
        const response = await axios.get(`${HOST}${path}`, {
            headers: {
                Accept: 'application/json',
                Referer: `${HOST}/`,
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
            },
            maxContentLength: MAX_BYTES,
            maxRedirects: 0,
            params,
            responseType: 'text',
            signal,
            timeout: 20000,
        });
        if (typeof response.data !== 'string' || Buffer.byteLength(response.data) > MAX_BYTES) {
            throw new Error('Invalid response');
        }
        const body: unknown = JSON.parse(response.data);
        if (!record(body) || body.code !== 200) {
            throw new Error('Service refused request');
        }
        return body;
    } catch {
        if (signal.aborted) {
            throw new Error('NetEase lyric lookup was cancelled.');
        }
        throw new Error(
            'NetEase word lyrics are unavailable right now. Try again later or generate timings locally.',
        );
    }
}
