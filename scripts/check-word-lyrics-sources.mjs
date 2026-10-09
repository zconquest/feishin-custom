import i18next from 'i18next';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const result = await build({
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
            export const get = async () => globalThis.savedWordLyrics;
            export const set = async (key, record) => { globalThis.savedWordLyrics = structuredClone(record); globalThis.savedWordLyricsKey = key; };
            export const del = async () => { globalThis.savedWordLyrics = undefined; };
        `,
                    loader: 'js',
                }));
            },
        },
    ],
    write: false,
});
const api = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);
const word = { endMs: 1500, startMs: 1000, text: 'Hello' };
const record = {
    album: 'Album',
    artist: 'Artist',
    createdAt: '2026-10-06T00:00:00Z',
    durationMs: 200000,
    lyrics: [{ cueLines: [{ words: [word] }], startMs: 1000, text: 'Hello' }],
    name: 'Song',
    origin: 'https://music.163.com/song?id=123456',
    quality: 'source',
    source: 'netease',
    warnings: [],
};
await api.saveLocalWordLyrics('server', 'track', record);
assert.deepEqual(await api.readLocalWordLyrics('server', 'track'), record);
assert.equal(globalThis.savedWordLyricsKey, 'word-lyrics:v1:["server","track"]');
for (const source of ['amll', 'unison', 'imported', 'generated']) {
    await api.saveLocalWordLyrics('server', 'track', { ...record, source });
    assert.equal((await api.readLocalWordLyrics('server', 'track')).source, source);
}
await api.saveLocalWordLyrics('server', 'track', { ...record, source: 'unknown' });
await assert.rejects(api.readLocalWordLyrics('server', 'track'), /invalid/);
await api.saveLocalWordLyrics('server', 'track', { ...record, durationMs: Infinity });
await assert.rejects(api.readLocalWordLyrics('server', 'track'), /invalid/);
const mixed = {
    ...record,
    lyrics: [
        {
            cueLines: [
                {
                    words: [
                        { ...word, timingSource: 'aligned' },
                        { endMs: 2000, startMs: 1600, text: 'world', timingSource: 'estimated' },
                    ],
                },
            ],
            startMs: 1000,
            text: 'Hello world',
        },
    ],
    source: 'generated',
};
await api.saveLocalWordLyrics('server', 'track', mixed);
assert.deepEqual(
    (await api.readLocalWordLyrics('server', 'track')).lyrics[0].cueLines[0].words.map(
        (cue) => cue.timingSource,
    ),
    ['aligned', 'estimated'],
);
const english = JSON.parse(readFileSync('src/i18n/locales/en.json', 'utf8'));
const instance = i18next.createInstance();
await instance.init({
    interpolation: { escapeValue: false },
    lng: 'en',
    resources: { en: { translation: english } },
    showSupportNotice: false,
});
const quality = instance.t('wordTiming.generatedCounts', { aligned: 7, rough: 3, total: 10 });
assert.equal(quality, '7 aligned, 3 rough estimates, 10 total words');
assert.equal(
    instance.t('wordTiming.estimatedQuality', { quality }),
    'Estimated timing: 7 aligned, 3 rough estimates, 10 total words. Review before using.',
);
assert.equal(
    instance.t('wordTiming.estimatedQuality', { quality: '7/10' }),
    'Estimated timing: 7/10. Review before using.',
);
assert.equal(instance.t('wordTiming.sources.netease'), 'NetEase native word timing');
assert.ok(instance.t('wordTiming.neteaseNote').includes('unofficial'));
assert.equal(
    instance.t('wordTiming.durationMatch', { difference: '-1.5', duration: '3:20' }),
    '3:20 duration | -1.5s compared with this track',
);
await api.saveLocalWordLyrics('server', 'track', {
    ...record,
    warnings: ['One line retains original line timing.'],
});
assert.deepEqual((await api.readLocalWordLyrics('server', 'track')).warnings, [
    'One line retains original line timing.',
]);
await api.clearLocalWordLyrics('server', 'track');
assert.equal(await api.readLocalWordLyrics('server', 'track'), null);
console.log(
    'PASS: NetEase metadata/source persistence, previous sources and invalid-record checks, aligned/estimated marker preservation, honest count and legacy quality labels, recording duration comparison',
);
