/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript test doubles cannot carry TypeScript return annotations. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const load = async (file) => {
    const result = await build({
        bundle: true,
        entryPoints: ['src/renderer/features/lyrics/aesthetics/' + file],
        format: 'esm',
        platform: 'node',
        write: false,
    });
    return import(
        `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    );
};
for (const [file, symbol, count, hash] of [
    [
        'icons/word-map.ts',
        'WORD_ICONS',
        1059,
        '23b7befa580411dea20109a0230adca662f03aac5d8fc5b355274fde29d487e0',
    ],
    [
        'icons/fluent.gen.ts',
        'FLUENT_ICONS',
        116,
        '9b124187a30c65416e33aa19b7eaf7fc5d94474e99834b1afc5a985868c38bb0',
    ],
]) {
    const data = (await load(file))[symbol];
    const sorted = JSON.stringify(
        Object.fromEntries(
            Object.keys(data)
                .sort()
                .map((key) => [
                    key,
                    typeof data[key] === 'object'
                        ? { body: data[key].body, size: data[key].size }
                        : data[key],
                ]),
        ),
    );
    assert.equal(Object.keys(data).length, count);
    assert.equal(createHash('sha256').update(sorted).digest('hex'), hash);
}
const { buildAestheticsLyricsModel } = await load('lyrics-model.ts');
const lyrics = [
    {
        cueLines: [
            {
                words: [
                    { endMs: 1250, startMs: 1000, text: 'Love' },
                    { endMs: 1500, startMs: 1300, text: 'you' },
                ],
            },
        ],
        startMs: 1000,
        text: 'Love you',
    },
    { startMs: 1800, text: 'Whole line fallback' },
    {
        cueLines: [{ words: [{ endMs: 3200, startMs: 3000, text: 'Fire' }] }],
        startMs: 3000,
        text: 'Fire',
    },
];
const model = buildAestheticsLyricsModel(lyrics, (text) => text);
assert.deepEqual(
    model.words.map(({ end, line, start, text }) => ({ end, line, start, text })),
    [
        { end: 1250, line: 0, start: 1000, text: 'Love' },
        { end: 1500, line: 0, start: 1300, text: 'you' },
        { end: 3200, line: 2, start: 3000, text: 'Fire' },
    ],
);
assert.deepEqual(model.lines[1].words, []);
const { resolveIcon } = await load('icons/resolve.ts');
assert.ok(resolveIcon('love'));
assert.deepEqual(resolveIcon('LOVE!'), resolveIcon('love'));
assert.equal(resolveIcon('x'.repeat(1001)), null);
const makeGl = (link = true) => {
    const deleted = { buffer: 0, program: 0, shader: 0, texture: 0 };
    const gl = new Proxy(
        {
            createBuffer: () => ({}),
            createProgram: () => ({}),
            createShader: () => ({}),
            createTexture: () => ({}),
            deleteBuffer: () => {
                deleted.buffer++;
            },
            deleted,
            deleteProgram: () => {
                deleted.program++;
            },
            deleteShader: () => {
                deleted.shader++;
            },
            deleteTexture: () => {
                deleted.texture++;
            },
            getAttribLocation: () => 0,
            getExtension: () => ({
                loseContext() {
                    return undefined;
                },
            }),
            getParameter: (key) =>
                key === 'MAX_VIEWPORT_DIMS' ? new Int32Array([4096, 2048]) : 1024,
            getProgramParameter: () => link,
            getShaderParameter: () => true,
            getUniformLocation: () => ({}),
        },
        {
            get: (target, key) =>
                key in target ? target[key] : key.toUpperCase() === key ? key : () => undefined,
        },
    );
    return gl;
};
class Node extends EventTarget {
    children = [];
    height = 0;
    parentNode = null;
    style = {
        setProperty(key, value) {
            this.values.set(key, value);
        },
        values: new Map(),
    };
    width = 0;
    constructor(gl = null) {
        super();
        this.gl = gl;
    }
    append(...nodes) {
        for (const node of nodes) {
            node.remove();
            this.children.push(node);
            node.parentNode = this;
        }
    }
    getContext(kind) {
        return kind === 'webgl'
            ? this.gl
            : new Proxy(
                  { measureText: (text) => ({ width: text.length * 60 }) },
                  {
                      get: (target, key) => (key in target ? target[key] : () => undefined),
                      set: (target, key, value) => {
                          target[key] = value;
                          return true;
                      },
                  },
              );
    }
    remove() {
        if (this.parentNode)
            this.parentNode.children = this.parentNode.children.filter((node) => node !== this);
        this.parentNode = null;
    }
    setAttribute(key, value) {
        this[key] = value;
    }
}
const { LensRenderer } = await load('styles/lens.ts');
const gl = makeGl();
const canvas = new Node(gl);
let invalidations = 0;
const lens = new LensRenderer(canvas, () => {
    invalidations++;
});
assert.ok(lens.ok);
assert.equal(lens.maxDimension, 1024);
lens.resize(9000, 9000);
assert.equal(canvas.width, 1024);
assert.equal(canvas.height, 1024);
canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
assert.equal(lens.ok, false);
assert.equal(invalidations, 1);
lens.dispose();
assert.deepEqual(gl.deleted, { buffer: 1, program: 1, shader: 2, texture: 1 });
canvas.dispatchEvent(new Event('webglcontextlost'));
assert.equal(invalidations, 1);
const failedGl = makeGl(false);
const failed = new LensRenderer(new Node(failedGl), () => undefined);
assert.equal(failed.ok, false);
assert.deepEqual(failedGl.deleted, { buffer: 0, program: 1, shader: 2, texture: 0 });
assert.equal(new LensRenderer(new Node(), () => undefined).ok, false);
globalThis.document = { createElement: () => new Node(), fonts: { load: async () => [] } };
globalThis.window = { devicePixelRatio: 10 };
const { createFisheye } = await load('styles/fisheye.ts');
const stage = createFisheye(false);
const host = new Node();
stage.mount(host);
stage.setLyrics(model);
const frame = { height: 8000, reducedMotion: true, songMs: 1200, wallMs: 0, width: 10000 };
stage.frame(frame);
const fallback = host.children[0].children[0];
assert.ok(fallback.width <= 4096 && fallback.height <= 4096);
await stage.ready();
stage.destroy();
assert.equal(host.children.length, 0);
const wrapper = readFileSync('src/renderer/features/lyrics/visual-lyrics.tsx', 'utf8');
assert.ok(
    wrapper.includes('fluentLicense') &&
        wrapper.includes('aestheticsLicense') &&
        wrapper.includes('fontLicense'),
);
console.log(
    'PASS: Exact pinned icon map/Fluent bodies, source cue intervals and line identity, lexical resolution, GPU limits/failure cleanup/context-loss listener disposal, high-DPR 2D fallback and runtime notices',
);

let assetInvalidations = 0;
const images = [];
globalThis.Image = class extends EventTarget {
    complete = false;
    naturalWidth = 0;
    constructor() {
        super();
        images.push(this);
    }
};
const raster = await load('icons/raster.ts');
const ref = ['heart', 'star', 'fire', 'music']
    .map(resolveIcon)
    .find((icon) => icon?.kind === 'fluent');
assert.ok(ref);
const unsubscribeAssets = raster.subscribeIconAssets(() => {
    assetInvalidations++;
});
assert.equal(raster.iconImage(ref, '#ca415e'), null);
images[0].complete = true;
images[0].naturalWidth = 24;
images[0].dispatchEvent(new Event('load'));
assert.equal(assetInvalidations, 1);
assert.ok(raster.iconImage(ref, '#ca415e'));
unsubscribeAssets();
raster.iconImage(ref, '#dc372a');
images[1].dispatchEvent(new Event('load'));
assert.equal(assetInvalidations, 1);
const liveGl = makeGl();
globalThis.document.createElement = () => new Node(liveGl);
const gpuStage = createFisheye(false);
const gpuHost = new Node();
gpuStage.mount(gpuHost);
gpuStage.setLyrics(model);
gpuStage.frame(frame);
const gpuCanvas = gpuHost.children[0].children[0];
let gpuInvalidations = 0;
const stopInvalidation = gpuStage.onInvalidate(() => {
    gpuInvalidations++;
    gpuStage.frame(frame);
});
gpuCanvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
assert.equal(gpuInvalidations, 1);
assert.equal(gpuCanvas.style.display, 'none');
assert.equal(gpuHost.children[0].children.length, 2);
stopInvalidation();
gpuStage.destroy();
gpuCanvas.dispatchEvent(new Event('webglcontextlost'));
assert.equal(gpuInvalidations, 1);
console.log(
    'PASS: Paused icon readiness and context loss invalidate once; fallback appears immediately and owned listeners detach',
);

const { createShip } = await load('styles/ship.ts');
const ship = createShip();
const shipHost = new Node();
ship.mount(shipHost);
ship.setLyrics(model);
ship.setMode('always');
ship.frame({ ...frame, songMs: 1000 });
const wall = shipHost.children[0].children[0];
assert.equal(wall.children[0].children[0].style.values.get('opacity'), '1.000');
assert.equal(wall.children[0].children[0].style.values.get('transform'), 'scaleX(1.0000)');
const settledTransform = wall.style.values.get('transform');
ship.frame({ ...frame, songMs: 1000, wallMs: 50000 });
assert.equal(wall.style.values.get('transform'), settledTransform);
ship.frame({ ...frame, songMs: 1250 });
assert.equal(wall.children[0].children[0].style.values.get('opacity'), '0.000');
ship.destroy();
assert.equal(shipHost.children.length, 0);
console.log(
    'PASS: Paused/reduced-motion exact cue starts settled, ambient remains static, and highlight ends at source boundary',
);

const { WORD_ICONS } = await load('icons/word-map.ts');
const fluentWord = Object.keys(WORD_ICONS).find((word) => resolveIcon(word)?.kind === 'fluent');
const emojiWord = Object.keys(WORD_ICONS).find((word) => resolveIcon(word)?.kind === 'emoji');
assert.ok(fluentWord && emojiWord);
const hybridTexts = [fluentWord, emojiWord, 'qzxqzx'.repeat(40)];
const hybridModel = buildAestheticsLyricsModel(
    [
        {
            cueLines: [
                {
                    words: hybridTexts.map((text, i) => ({
                        endMs: 1500 + i * 1000,
                        startMs: 1000 + i * 1000,
                        text,
                    })),
                },
            ],
            startMs: 1000,
            text: hybridTexts.join(' '),
        },
    ],
    (text) => text,
);
const hybrid = createShip(true);
const hybridHost = new Node();
hybrid.mount(hybridHost);
hybrid.setLyrics(hybridModel);
hybrid.setMode('always');
const hybridFrame = { ...frame, height: 400, songMs: 1000, width: 240 };
hybrid.frame(hybridFrame);
const hybridWall = hybridHost.children[0].children[0];
assert.equal(hybridWall.children.length, 3);
const [fluentNode, emojiNode, unknownNode] = hybridWall.children;
assert.equal(fluentNode.children.length, 3);
assert.equal(fluentNode.children[2]['aria-hidden'], 'true');
assert.match(fluentNode.children[2].innerHTML, /^<svg /);
assert.equal(emojiNode.children[2].textContent, resolveIcon(emojiWord).char);
assert.equal(unknownNode.children.length, 2);
for (const [i, row] of hybridWall.children.entries()) {
    const iconWidth = resolveIcon(hybridTexts[i]) ? 1.14 : 0;
    const renderedWidth =
        parseFloat(row.style.fontSize) * (hybridTexts[i].length * 0.6 + iconWidth + 0.24);
    assert.ok(renderedWidth <= hybridFrame.width * 0.84 + 0.001);
    const x = Number(row.style.values.get('transform').match(/translate3d\(([-\d.]+)px/)[1]);
    // Centering includes the same icon/gap width that was used by the width cap.
    assert.ok(Math.abs(x + renderedWidth / 2) <= hybridFrame.width * 0.035 + 0.05);
}
hybrid.setPalette({
    highlight: '#123456',
    highlightText: '#abcdef',
    lyric: '#fedcba',
    secondary: '#654321',
});
hybrid.frame(hybridFrame);
assert.match(fluentNode.children[2].innerHTML, /rgb\(171, 205, 239\)/);
assert.equal(fluentNode.children[0].style.values.get('background'), '#123456');
const hybridTransform = fluentNode.style.values.get('transform');
hybrid.frame({ ...hybridFrame, wallMs: 50000 });
assert.equal(fluentNode.style.values.get('transform'), hybridTransform);
hybrid.frame({ ...hybridFrame, songMs: 1500 });
assert.match(fluentNode.children[2].innerHTML, /#fedcba/);
hybrid.frame({ ...hybridFrame, width: 480 });
assert.equal(fluentNode.parentNode, null);
await hybrid.ready();
assert.equal(hybridWall.children.length, 0);
hybrid.frame(hybridFrame);
hybrid.setLyrics(null);
assert.equal(hybridWall.children.length, 0);
hybrid.destroy();
assert.equal(hybridHost.children.length, 0);
assert.equal(hybrid.frame(hybridFrame), false);
const { createStyle } = await load('styles/registry.ts');
assert.ok(createStyle('ship-visual'));
console.log(
    'PASS: Ship + Visual resolves Fluent/emoji icons, preserves unknown words, caps and centers total width, tracks highlight colors, stays static with reduced motion, and clears owned nodes',
);
