import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Use Vite's existing compiler dependency without adding a package.
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');

const result = await build({
    bundle: true,
    entryPoints: ['src/renderer/features/lyrics/api/visual-lyrics-timeline.ts'],
    format: 'esm',
    platform: 'node',
    write: false,
});
const { buildVisualLyricCues, getVisualLyricPosition, getVisualPlaybackTime } = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
);

const wordLyrics = [
    {
        cueLines: [
            {
                endMs: 2000,
                index: 0,
                startMs: 1000,
                value: 'hello world',
                words: [
                    { endMs: 1200, startMs: 1000, text: 'hello' },
                    { endMs: 2000, startMs: 1500, text: 'world' },
                ],
            },
        ],
        startMs: 1000,
        text: 'hello world',
    },
];
const cues = buildVisualLyricCues(wordLyrics);
assert.deepEqual(
    cues.map(({ endMs, startMs }) => [startMs, endMs]),
    [
        [1000, 1200],
        [1500, 2000],
    ],
);
assert.deepEqual(getVisualLyricPosition(cues, 999), { active: false, index: -1 });
assert.deepEqual(getVisualLyricPosition(cues, 1000), { active: true, index: 0 });
assert.deepEqual(getVisualLyricPosition(cues, 1200), { active: false, index: 0 });
assert.deepEqual(getVisualLyricPosition(cues, 1700), { active: true, index: 1 });
assert.deepEqual(getVisualLyricPosition(cues, 2000), { active: false, index: 1 });
assert.deepEqual(getVisualLyricPosition(cues, 1050), { active: true, index: 0 }); // backward seek
const lines = buildVisualLyricCues([
    [100, 'a whole line'],
    [1000, 'another line'],
]);
assert.equal(lines.length, 2);
assert.equal(lines[0].text, 'a whole line');
assert.equal(lines[0].wordTimed, false);
assert.equal(lines[0].endMs, 1000);
assert.equal(buildVisualLyricCues([]).length, 0);
assert.deepEqual(getVisualLyricPosition([], 1000), { active: false, index: -1 });
assert.equal(getVisualPlaybackTime(1000, 250, true, 2, -100), 1400);
assert.equal(getVisualPlaybackTime(1000, 60000, false, 1, 100), 1100); // pause freezes
assert.equal(getVisualPlaybackTime(1000, 0, true, 1, 0), 1000); // resume anchor
assert.equal(getVisualPlaybackTime(300, 0, false, 1, 0), 300); // paused seek
console.log('PASS: source cue boundaries, gaps, line fallback, seeking, pause, speed and offset');
