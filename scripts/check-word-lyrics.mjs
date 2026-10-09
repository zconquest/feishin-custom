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
const result = await build({
    bundle: true,
    entryPoints: ['src/renderer/features/lyrics/api/word-lyrics-parser.ts'],
    format: 'esm',
    platform: 'node',
    write: false,
});
const parser = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);
const { exportEnhancedLrc, parseEnhancedLrc, parseWordLyricsFile, parseWordTime, parseWordTtml } =
    parser;
assert.equal(parseWordTime('01:02.30'), 62300);
assert.equal(parseWordTime('00:01:02.345'), 62345);
assert.equal(parseWordTime('1.5s'), 1500);
assert.throws(() => parseWordTime('00:61.00'));
assert.throws(() => parseWordTime('garbage'));
const lrc = '[00:01.000]<00:01.000>Hello <00:01.500>world<00:02.000>\n[00:03.000]Line fallback';
const lyrics = parseEnhancedLrc(lrc);
assert.deepEqual(lyrics[0].cueLines[0].words, [
    { endMs: 1500, startMs: 1000, text: 'Hello ' },
    { endMs: 2000, startMs: 1500, text: 'world' },
]);
assert.equal(lyrics[1].cueLines, undefined);
assert.deepEqual(parseEnhancedLrc(exportEnhancedLrc(lyrics)), lyrics);
assert.throws(() => parseEnhancedLrc('[00:01.000]<00:01.000>Hello'));
assert.throws(() => parseEnhancedLrc('[00:01.000]No words'));
assert.throws(() => parseEnhancedLrc('[offset:500]\n' + lrc), /offset/);
assert.throws(() => parseEnhancedLrc('[00:01.000]<00:02.000>backward<00:01.000>'));
const partial = parseEnhancedLrc('[00:01.000]Hello <00:02.000>world<00:03.000>\n' + lrc);
assert.equal(partial[0].cueLines, undefined);
const ttml =
    '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="00:01.000" end="00:02.000"><span begin="00:01.000" end="00:01.500">Hello </span><span begin="00:01.500" end="00:02.000">world</span><span ttm:role="x-translation">translated</span><span ttm:role="x-roman">romanized</span></p><p begin="00:03.000">Whole line</p></div></body></tt>';
const xmlLyrics = parseWordTtml(ttml);
assert.equal(xmlLyrics[0].text, 'Hello world');
assert.equal(xmlLyrics[0].cueLines[0].words.length, 2);
assert.equal(xmlLyrics[1].cueLines, undefined);
const partialXml = parseWordTtml(
    ttml.replace(
        '<p begin="00:03.000">Whole line</p>',
        '<p begin="00:03.000">Hello <span begin="00:04.000" end="00:05.000">world</span></p>',
    ),
);
assert.equal(partialXml[1].cueLines, undefined);
assert.equal(parseWordTtml(ttml.replace('x-translation', 'x-bg'))[0].text, 'Hello world');
assert.throws(
    () => parseWordTtml('<!DOCTYPE tt [<!ENTITY x SYSTEM "file:///secret">]><tt/>'),
    /entities/,
);
assert.throws(() => parseWordTtml('<tt><body>'), /unclosed|end|tag/i);
assert.throws(
    () => parseWordTtml(ttml.replace('end="00:01.500"', 'end="00:00.900"')),
    /increasing/,
);
assert.throws(
    () => parseWordTtml(ttml.replace('begin="00:01.500"', 'begin="00:00.500"')),
    /absolute/,
);
assert.throws(() => parseWordLyricsFile('a'.repeat(2 * 1024 * 1024 + 1), 'too-big.lrc'), /2 MB/);
assert.throws(() => parseWordLyricsFile(lrc, 'wrong.txt'), /\.lrc/);
const apiResult = await build({
    bundle: true,
    entryPoints: ['src/renderer/features/lyrics/api/word-lyrics-api.ts'],
    format: 'esm',
    platform: 'node',
    write: false,
});
const api = await import(
    `data:text/javascript;base64,${Buffer.from(apiResult.outputFiles[0].text).toString('base64')}`
);
const row = JSON.stringify({
    metadata: [
        ['musicName', ['Song']],
        ['artists', ['Artist']],
        ['album', ['Album']],
    ],
    rawLyricFile: '1234-author-abcd.ttml',
});
assert.deepEqual(api.parsePublicWordCatalog(row), [
    { album: 'Album', artists: 'Artist', filename: '1234-author-abcd.ttml', name: 'Song' },
]);
assert.deepEqual(
    api.parsePublicWordCatalog(row.replace('1234-author-abcd.ttml', '../escape.ttml')),
    [],
);
assert.throws(() => api.parsePublicWordCatalog('invalid JSON'));
assert.throws(() => api.parsePublicWordCatalog(Array(30001).fill(row).join('\n')), /entry limit/);
if (existsSync('../amll-catalog.jsonl'))
    assert.ok(
        api.parsePublicWordCatalog(readFileSync('../amll-catalog.jsonl', 'utf8')).length > 1000,
    );
assert.throws(
    () => api.fetchPublicWordLyrics('../escape.ttml', new AbortController().signal),
    /filename/,
);
globalThis.fetch = async (url, options) => {
    assert.equal(
        url,
        'https://raw.githubusercontent.com/amll-dev/amll-ttml-db/main/raw-lyrics/1234-author-abcd.ttml',
    );
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response(ttml);
};
assert.equal(
    await api.fetchPublicWordLyrics('1234-author-abcd.ttml', new AbortController().signal),
    ttml,
);
globalThis.fetch = async () => new Response('a'.repeat(2 * 1024 * 1024 + 1));
await assert.rejects(
    api.fetchPublicWordLyrics('1234-author-abcd.ttml', new AbortController().signal),
    /size limit/,
);
const english = readFileSync('src/i18n/locales/en.json', 'utf8');
assert.ok(JSON.parse(english).wordTiming.title);
assert.ok(!english.includes('\uFFFD'));
console.log(
    'PASS: Enhanced LRC round trip, complete coverage, line fallback, TTML annotations, strict timing, unsafe XML and size limits',
);

const foreground =
    '<p begin="1s" end="2s"><span begin="1s" end="1.5s">Hello </span><span begin="1.5s" end="2s">world</span></p>';
const background =
    '<span role="x-bg" begin="garbage" end="bad">Backing<span begin="bad">nested</span></span>';
const nestedSource =
    '<tt xmlns:custom="urn:test"><body><div>' +
    foreground.replace('Hello </span>', 'Hello ' + background + '</span>') +
    '<p custom:role="bg"><span>invalid background line</span></p><div custom:role="other background"><p>also omitted</p></div></div></body></tt>';
const projected = parser.parseWordLyricsFileWithWarnings(nestedSource, 'nested.ttml');
assert.equal(projected.lyrics.length, 1);
assert.equal(projected.lyrics[0].text, 'Hello world');
assert.deepEqual(projected.lyrics[0].cueLines[0].words, [
    { endMs: 1500, startMs: 1000, text: 'Hello ' },
    { endMs: 2000, startMs: 1500, text: 'world' },
]);
assert.equal(projected.warnings.length, 1);
assert.match(projected.warnings[0], /Background vocals omitted/);
assert.deepEqual(parser.parseWordLyricsFile(nestedSource, 'nested.ttml'), projected.lyrics);
assert.throws(
    () =>
        parser.parseWordLyricsFileWithWarnings(
            '<tt><body><div role="x-bg">' + foreground + '</div></body></tt>',
            'bg.ttml',
        ),
    /foreground word timing/,
);
assert.throws(
    () =>
        parser.parseWordLyricsFileWithWarnings(
            nestedSource.replace('begin="1s" end="1.5s"', 'begin="bad" end="1.5s"'),
            'bad.ttml',
        ),
    /timestamp/,
);
const ordinary = parser.parseWordLyricsFileWithWarnings(
    '<tt><body>' +
        foreground.replace('<p ', '<p role="x-bg-extra backgroundish foreground" ') +
        '</body></tt>',
    'ordinary.ttml',
);
assert.equal(ordinary.lyrics[0].text, 'Hello world');
assert.deepEqual(ordinary.warnings, []);
const annotations = parser.parseWordLyricsFileWithWarnings(
    '<tt><body><div role="x-translation"><p>untimed annotation</p></div>' +
        foreground.replace('Hello </span>', 'Hello <span role="x-roman">annotation</span></span>') +
        '</body></tt>',
    'annotations.ttml',
);
assert.equal(annotations.lyrics[0].text, 'Hello world');
assert.deepEqual(annotations.warnings, []);
assert.deepEqual(parser.parseWordLyricsFileWithWarnings(lrc, 'plain.lrc').warnings, []);
console.log(
    'PASS: Nested and ancestor background projection, preserved foreground times, warning propagation, role tokens, annotations and invalid foreground rejection',
);

const emptyProjection = parser.parseWordLyricsFileWithWarnings(
    '<tt><body><p><span role="x-bg"><span>backing only</span></span></p>' +
        foreground +
        '</body></tt>',
    'empty.ttml',
);
assert.equal(emptyProjection.lyrics.length, 1);
assert.equal(emptyProjection.lyrics[0].startMs, 1000);
assert.equal(emptyProjection.warnings.length, 1);
console.log(
    'PASS: Empty projected background-only paragraphs do not create fallback lines or require timestamps',
);
