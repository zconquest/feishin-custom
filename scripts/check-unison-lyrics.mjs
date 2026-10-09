import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const {
    DOMParser,
} = require('../node_modules/.pnpm/@xmldom+xmldom@0.8.13/node_modules/@xmldom/xmldom');
globalThis.DOMParser = class extends DOMParser {
    constructor() {
        const fail = assert.fail;
        super({ errorHandler: { error: fail, fatalError: fail, warning: fail } });
    }
};
const bundle = await build({
    bundle: true,
    entryPoints: ['src/renderer/features/lyrics/api/word-lyrics-api.ts'],
    format: 'esm',
    platform: 'node',
    plugins: [
        {
            name: 'isolated-idb',
            setup(buildApi) {
                buildApi.onResolve({ filter: /^idb-keyval$/ }, () => ({
                    namespace: 'test',
                    path: 'idb',
                }));
                buildApi.onLoad({ filter: /.*/, namespace: 'test' }, () => ({
                    contents: `
                export const get = async () => globalThis.testWordRecord;
                export const set = async (_key, value) => { globalThis.testWordRecord = value; };
                export const del = async () => { globalThis.testWordRecord = undefined; };
            `,
                    loader: 'js',
                }));
            },
        },
    ],
    write: false,
});
const api = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);
const parserBundle = await build({
    bundle: true,
    entryPoints: ['src/renderer/features/lyrics/api/word-lyrics-parser.ts'],
    format: 'esm',
    platform: 'node',
    write: false,
});
const parser = await import(
    `data:text/javascript;base64,${Buffer.from(parserBundle.outputFiles[0].text).toString('base64')}`
);
const row = {
    album: 'Album',
    artist: 'Artist',
    confidence: 'low',
    format: 'ttml',
    id: 31,
    song: 'Song',
    syncType: 'richsync',
};
const ttml =
    '<tt><body><p begin="1s" end="2s"><span begin="1s" end="2s">Hello</span></p></body></tt>';
assert.equal(
    api.parseUnisonSearch({
        data: [
            row,
            { ...row, format: 'lrc' },
            { ...row, syncType: 'linesync' },
            { ...row, format: 'plain' },
        ],
        success: true,
    }).length,
    1,
);
for (const envelope of [
    null,
    [],
    {},
    { data: [], success: false },
    { data: {}, success: true },
    { data: Array(51).fill(row), success: true },
])
    assert.throws(() => api.parseUnisonSearch(envelope));
for (const id of [0, -1, 1.5, '31', Number.MAX_SAFE_INTEGER + 1, '../escape'])
    assert.throws(() => api.parseUnisonSearch({ data: [{ ...row, id }], success: true }));
assert.throws(() =>
    api.parseUnisonSearch({ data: [{ ...row, song: 'x'.repeat(1001) }], success: true }),
);
assert.throws(
    () => api.parseUnisonRecord({ data: { ...row, lyrics: ttml }, success: true }, 32),
    /different/,
);
assert.throws(
    () =>
        api.parseUnisonRecord(
            { data: { ...row, lyrics: 'x'.repeat(2 * 1024 * 1024 + 1) }, success: true },
            31,
        ),
    /oversized/,
);
assert.equal(
    parser.parseWordTtml(
        api.parseUnisonRecord({ data: { ...row, lyrics: ttml }, success: true }, 31).text,
    )[0].cueLines[0].words.length,
    1,
);
assert.throws(
    () => parser.parseWordTtml('<tt><body><p begin="1s">Plain line</p></body></tt>'),
    /word/,
);
let requests = 0;
globalThis.fetch = async (url, options) => {
    requests++;
    const endpoint = new URL(url);
    assert.equal(endpoint.origin + endpoint.pathname, 'https://unison.boidu.dev/lyrics/search');
    assert.equal(endpoint.searchParams.get('q'), 'Song Artist');
    assert.equal(endpoint.searchParams.get('limit'), '50');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ data: [row], success: true }));
};
assert.equal(
    (await api.searchUnisonWordLyrics('Song', 'Artist', new AbortController().signal))[0].id,
    31,
);
assert.equal(requests, 1);
globalThis.fetch = async (url) => {
    assert.equal(url, 'https://unison.boidu.dev/lyrics/31');
    return new Response(JSON.stringify({ data: { ...row, lyrics: ttml }, success: true }));
};
assert.equal((await api.fetchUnisonWordLyrics(31, new AbortController().signal)).name, 'Song');
for (const status of [429, 404]) {
    requests = 0;
    globalThis.fetch = async () => {
        requests++;
        return new Response('', { status });
    };
    await assert.rejects(
        api.fetchUnisonWordLyrics(31, new AbortController().signal),
        status === 429 ? /rate limiting/ : /not found/,
    );
    assert.equal(requests, 1);
}
globalThis.fetch = async () => new Response('x'.repeat(2 * 1024 * 1024 + 1));
await assert.rejects(api.fetchUnisonWordLyrics(31, new AbortController().signal), /size limit/);
const controller = new AbortController();
controller.abort();
globalThis.fetch = async (_url, options) => {
    options.signal.throwIfAborted();
    assert.fail('Cancelled requests must not return data');
};
await assert.rejects(api.searchUnisonWordLyrics('Song', 'Artist', controller.signal), /abort/i);
if (existsSync('../unison-6060.json')) {
    const record = api.parseUnisonRecord(
        JSON.parse(readFileSync('../unison-6060.json', 'utf8')),
        6060,
    );
    const lines = parser.parseWordTtml(record.text);
    assert.equal(lines.length, 49);
    assert.equal(
        lines.flatMap((line) => line.cueLines ?? []).flatMap((cue) => cue.words).length,
        436,
    );
}
assert.equal(
    JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8')).wordTiming.sources.unison,
    'Lyrics from Unison (https://unison.boidu.dev)',
);
console.log(
    'PASS: Unison envelopes, format filtering, metadata/id/body limits, exact version, fixed URLs, cancellation, 429/404 without retry, and real word cues',
);

const saved = {
    createdAt: '2026-10-06T00:00:00Z',
    lyrics: parser.parseWordTtml(ttml),
    name: 'Song',
    quality: 'source',
    source: 'unison',
    warnings: [],
};
for (const source of ['unison', 'amll', 'generated', 'imported']) {
    await api.saveLocalWordLyrics('server', 'song', { ...saved, source });
    assert.equal((await api.readLocalWordLyrics('server', 'song')).source, source);
}
await api.saveLocalWordLyrics('server', 'song', { ...saved, source: 'unknown' });
await assert.rejects(api.readLocalWordLyrics('server', 'song'), /invalid/);
await api.clearLocalWordLyrics('server', 'song');
assert.equal(await api.readLocalWordLyrics('server', 'song'), null);
console.log(
    'PASS: Unison and previous sources persist and load; invalid source rejected; clear restores empty record',
);

for (const [filename, id] of [
    ['unison-live-record.json', 31],
    ['unison-1133.json', 1133],
    ['unison-550.json', 550],
    ['unison-2204.json', 2204],
    ['unison-7998.json', 7998],
]) {
    if (!existsSync('../' + filename)) continue;
    const record = api.parseUnisonRecord(JSON.parse(readFileSync('../' + filename, 'utf8')), id);
    const parsed = parser.parseWordLyricsFileWithWarnings(record.text, `${id}.ttml`);
    assert.ok(parsed.lyrics.some((line) => line.cueLines?.some((cue) => cue.words.length)));
    assert.equal(parsed.warnings.length, 1);
    assert.match(parsed.warnings[0], /Background vocals omitted/);
    await api.saveLocalWordLyrics('server', 'song', { ...saved, ...parsed });
    assert.deepEqual((await api.readLocalWordLyrics('server', 'song')).warnings, parsed.warnings);
    console.log(`PASS: Real Unison ${id} foreground projection and persistent omission warning`);
}
