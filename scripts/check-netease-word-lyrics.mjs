import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parserBuild = await build({
    bundle: true,
    entryPoints: [path.join(root, 'src/main/features/core/word-lyrics/netease-parser.ts')],
    format: 'esm',
    platform: 'node',
    write: false,
});
const { parseNetEaseYrc } = await import(
    `data:text/javascript;base64,${Buffer.from(parserBuild.outputFiles[0].text).toString('base64')}`
);

const sample =
    '{"t":0,"c":[{"tx":"Original test credits"}]}\n[1000,2000](1000,200,0)Hel(1200,300,0)lo (1800,600,0)world';
const parsed = parseNetEaseYrc(sample);
assert.equal(parsed[0].text, 'Hello world');
assert.deepEqual(parsed[0].cueLines[0].words, [
    { endMs: 1500, startMs: 1000, text: 'Hello ' },
    { endMs: 2400, startMs: 1800, text: 'world' },
]);
assert.equal(parsed[0].cueLines[0].value, parsed[0].text);
const unicode = parseNetEaseYrc('[0,1000](0,200,0)你(200,200,0)好(400,200,0) café (600,300,0)✨');
assert.deepEqual(
    unicode[0].cueLines[0].words.map((word) => word.text),
    ['你', '好', ' café ', '✨'],
);
for (const line of [...parsed, ...unicode]) {
    assert.equal(
        line.cueLines[0].words
            .map((word) => word.text)
            .join('')
            .trim(),
        line.text,
    );
}
const spacing = parseNetEaseYrc(
    '[0,1000](0,0,0) (0,200,0)Hel(200,100,0)lo(300,0,0)  (400,200,0) world(600,0,0) ',
);
assert.equal(
    spacing[0].cueLines[0].words
        .map((word) => word.text)
        .join('')
        .trim(),
    spacing[0].text,
);
assert.deepEqual(spacing[0].cueLines[0].words, [
    { endMs: 300, startMs: 0, text: ' Hello  ' },
    { endMs: 600, startMs: 400, text: ' world' },
]);
for (const invalid of [
    '[0,0](0,1,0)zero',
    '[0,1000](0,500,0)over (400,200,0)lap',
    '[0,500](0,600,0)beyond',
    '[0,500](0,no,0)malformed',
    '[0,500]lost(0,200,0)text',
    '[1000,500](1000,200,0)first\n[0,500](0,200,0)reverse',
    '[0,500](0,200,0)first(200,no,0)lost',
    '[99999999999999999999,10](1,1,0)overflow',
    '{invalid}',
    'plain untimed lyrics',
]) {
    assert.throws(() => parseNetEaseYrc(invalid), /invalid word timings/);
}
assert.throws(() => parseNetEaseYrc('{"t":0}'), /no individual word timings/);
assert.throws(() => parseNetEaseYrc('[0,1000](0,0,0)zero'), /no individual word timings/);
assert.equal(parseNetEaseYrc('[0,1000](0,200,0)Hel(200,0,0)lo')[0].cueLines[0].words[0].endMs, 200);
const mixed = parseNetEaseYrc('[0,1000](0,500,0)good\n[1000,1000](1000,0,0)untimed');
assert.equal(mixed[1].text, 'untimed');
assert.equal(mixed[1].cueLines, undefined);

const handlers = new Map();
const app = new EventEmitter();
app.isPackaged = true;
app.getAppPath = () => root;
let response = { code: 200, result: { songs: [] } };
let waiting = false;
const calls = [];
const axios = {
    get: async (url, options) => {
        calls.push({ options, url });
        if (waiting) {
            await new Promise((_resolve, reject) =>
                options.signal.addEventListener('abort', () => reject(new Error('aborted')), {
                    once: true,
                }),
            );
        }
        if (response instanceof Error) {
            throw response;
        }
        return { data: JSON.stringify(response) };
    },
};
const serviceBuild = await build({
    bundle: true,
    entryPoints: [path.join(root, 'src/main/features/core/word-lyrics/netease.ts')],
    external: ['axios', 'electron'],
    format: 'cjs',
    platform: 'node',
    write: false,
});
const module = { exports: {} };
vm.runInNewContext(serviceBuild.outputFiles[0].text, {
    AbortController,
    Buffer,
    clearTimeout,
    exports: module.exports,
    module,
    process,
    require: (name) =>
        name === 'axios'
            ? axios
            : name === 'electron'
              ? { app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } }
              : require(name),
    setTimeout,
    URL,
});
const { getNetEaseWords, registerNetEaseWordLyrics, searchNetEaseWords } = module.exports;
const signal = new AbortController().signal;
assert.equal(
    (
        await searchNetEaseWords(
            { artist: 'Fixtures', requestId: 'search', title: 'Original' },
            signal,
        )
    ).length,
    0,
);
response = {
    code: 200,
    result: {
        songs: Array.from({ length: 25 }, (_, index) => ({
            al: { name: 'Test album' },
            ar: [{ name: 'Test artist' }],
            dt: 12345,
            id: index + 1,
            name: 'Fixture song',
        })),
    },
};
const songs = await searchNetEaseWords(
    { artist: '', requestId: 'search', title: 'Original' },
    signal,
);
assert.equal(songs.length, 20);
assert.equal(songs[0].durationMs, 12345);
assert.equal(calls[0].url, 'https://music.163.com/api/cloudsearch/pc');
assert.equal(calls[0].options.maxContentLength, 1024 * 1024);
assert.equal(calls[0].options.maxRedirects, 0);
assert.equal(calls[0].options.timeout, 20000);
assert.equal('Cookie' in calls[0].options.headers, false);
response = { code: 200, yrc: { lyric: sample } };
assert.equal(
    (await getNetEaseWords({ id: '123', requestId: 'get' }, signal)).lyrics[0].text,
    'Hello world',
);
assert.equal(calls.at(-1).options.params.yv, '-1');
await assert.rejects(
    getNetEaseWords({ id: 'https://untrusted.test', requestId: 'bad' }, signal),
    /valid NetEase search result/,
);
response = { code: 200, lrc: { lyric: '[00:01]Line only' } };
await assert.rejects(
    getNetEaseWords({ id: '123', requestId: 'get' }, signal),
    /no individual word timings/,
);
response = { code: -460 };
await assert.rejects(
    getNetEaseWords({ id: '123', requestId: 'get' }, signal),
    /unavailable right now/,
);
response = new Error('private remote failure details');
await assert.rejects(
    getNetEaseWords({ id: '123', requestId: 'get' }, signal),
    /unavailable right now/,
);

registerNetEaseWordLyrics();
const sender = new EventEmitter();
sender.isDestroyed = () => false;
sender.mainFrame = { url: pathToFileURL(path.join(root, 'out/renderer/index.html')).href };
const event = { sender, senderFrame: sender.mainFrame };
assert.throws(
    () =>
        handlers.get('word-lyrics-netease-search')(
            { ...event, senderFrame: { url: 'https://untrusted.test' } },
            {},
        ),
    /Feishin player/,
);
waiting = true;
const lookup = handlers.get('word-lyrics-netease-get')(event, { id: '123', requestId: 'owned' });
const cancellation = assert.rejects(lookup, /cancelled/);
const stranger = new EventEmitter();
stranger.mainFrame = sender.mainFrame;
handlers.get('word-lyrics-netease-cancel')(
    { sender: stranger, senderFrame: stranger.mainFrame },
    'owned',
);
assert.equal(calls.at(-1).options.signal.aborted, false);
handlers.get('word-lyrics-netease-cancel')(event, 'owned');
await cancellation;
const disposed = handlers.get('word-lyrics-netease-get')(event, {
    id: '123',
    requestId: 'disposed',
});
const disposal = assert.rejects(disposed, /cancelled/);
sender.emit('destroyed');
await disposal;
assert.equal(sender.listenerCount('destroyed'), 0);

const fixturePath = process.argv.slice(2).find((argument) => argument !== '--live');
if (fixturePath) {
    const live = parseNetEaseYrc(fs.readFileSync(fixturePath, 'utf8'));
    for (const line of live) {
        if (line.cueLines) {
            assert.equal(
                line.cueLines[0].words
                    .map((word) => word.text)
                    .join('')
                    .trim(),
                line.text,
            );
        }
    }
    console.log(
        `Live YRC parser PASS: ${live.length} lines, ${live.reduce((count, line) => count + (line.cueLines?.[0].words.length ?? 0), 0)} native word cues, ${live.filter((line) => !line.cueLines).length} fallback lines`,
    );
}
if (process.argv.includes('--live')) {
    axios.get = require('axios').get;
    const found = await searchNetEaseWords(
        { artist: 'Kanye West', requestId: 'live-search', title: 'Hey Mama' },
        signal,
    );
    assert.equal(
        found.some((song) => song.id === '18969097'),
        true,
    );
    const native = await getNetEaseWords({ id: '18969097', requestId: 'live-get' }, signal);
    console.log(
        `Live provider PASS: ${found.length} search results; ${native.lyrics.length} lines; ${native.lyrics.reduce((count, line) => count + (line.cueLines?.[0].words.length ?? 0), 0)} native word cues; ${native.warnings.length} fallback warning`,
    );
    await assert.rejects(
        getNetEaseWords({ id: '26936668', requestId: 'live-no-word' }, signal),
        /no individual word timings/,
    );
    console.log('Live provider PASS: matching recording without YRC produces clear no-word result');
}
console.log(
    'PASS: native absolute YRC timings, syllable merging, Unicode/CJK, gaps, malformed/overlap/zero bounds, metadata, no-word/service errors, bounded fixed-host requests, trusted frame and cancellation ownership',
);
