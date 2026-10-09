/* eslint-disable @typescript-eslint/explicit-function-return-type -- JavaScript test doubles cannot carry TypeScript return annotations. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('vite'))('esbuild');
const source = readFileSync('src/renderer/store/settings.store.ts', 'utf8');
const schemaSource = source.slice(
    source.indexOf('const AudioMotionAnalyzerSettingsSchema'),
    source.indexOf('export enum HomeFeatureStyle'),
);
const defaults = source.slice(
    source.indexOf('    visualizer: {', source.indexOf('const initialState')),
    source.indexOf(
        '    window: {',
        source.indexOf('    visualizer: {', source.indexOf('const initialState')),
    ),
);
const fixture = new Function('audiomotionanalyzerPresets', `return ({${defaults}}).visualizer;`)(
    [],
);
globalThis.sideGlobal = { visualizer: structuredClone(fixture) };
const saved = new Map();
globalThis.localStorage = {
    getItem: (key) => saved.get(key) ?? null,
    removeItem: (key) => saved.delete(key),
    setItem: (key, value) => saved.set(key, value),
};
globalThis.window = { localStorage: globalThis.localStorage };

async function load(entry, mocks = {}) {
    const result = await build({
        bundle: true,
        entryPoints: [entry],
        format: 'cjs',
        platform: 'node',
        plugins: [
            {
                name: 'isolated-side-settings',
                setup(api) {
                    api.onResolve({ filter: /.*/ }, (args) => {
                        if (args.path in mocks) return { namespace: 'mock', path: args.path };
                    });
                    api.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
                        contents: mocks[args.path],
                        loader: 'tsx',
                        resolveDir: process.cwd(),
                    }));
                },
            },
        ],
        write: false,
    });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', result.outputFiles[0].text)(
        require,
        module,
        module.exports,
    );
    return module.exports;
}
const settingsMock = `import {z} from 'zod'; ${schemaSource} export const useSettingsStore = {getState:()=>globalThis.sideGlobal};`;
const { useLyricSideVisualizerStore: store } = await load(
    'src/renderer/store/lyric-side-visualizer.store.ts',
    { '/@/renderer/store/settings.store': settingsMock },
);
const original = structuredClone(fixture);
const actions = store.getState().actions;
assert.equal(store.getState().left.enabled, false);
assert.equal(store.getState().right.enabled, false);
actions.setLayout('left', { enabled: true, width: 200 });
assert.equal(store.getState().left.width, 25);
assert.notEqual(store.getState().left.visualizer, fixture);
actions.setLayout('right', { enabled: true });
actions.setVisualizer('left', {
    visualizer: {
        audiomotionanalyzer: {
            customGradients: [
                { colorStops: [{ color: '#ff0000' }, { color: '#0000ff' }], name: 'custom' },
            ],
            mode: 8,
            presets: [{ id: 'left-only', name: 'Left', value: { mode: 8 } }],
        },
        type: 'butterchurn',
    },
});
assert.equal(store.getState().left.visualizer.type, 'audiomotionanalyzer');
assert.equal(store.getState().left.visualizer.audiomotionanalyzer.mode, 8);
assert.deepEqual(store.getState().right.visualizer, original);
assert.deepEqual(globalThis.sideGlobal.visualizer, original);
actions.setVisualizer('left', {
    visualizer: { audiomotionanalyzer: { customGradients: [], presets: [] } },
});
assert.deepEqual(store.getState().left.visualizer.audiomotionanalyzer.presets, []);
assert.deepEqual(store.getState().left.visualizer.audiomotionanalyzer.customGradients, []);
const release = actions.acquireSurface();
assert.equal(store.getState().activeSurfaces, 1);
assert.equal(JSON.parse(saved.get('store_lyric_side_visualizers')).state.activeSurfaces, undefined);
release();
release();
assert.equal(store.getState().activeSurfaces, 0);
const persisted = JSON.parse(saved.get('store_lyric_side_visualizers'));
store.setState({ left: { ...store.getState().left, width: 5 } });
saved.set('store_lyric_side_visualizers', JSON.stringify(persisted));
await store.persist.rehydrate();
assert.equal(store.getState().left.width, 25);
saved.set(
    'store_lyric_side_visualizers',
    JSON.stringify({
        state: { left: { ...persisted.state.left, width: 999 }, right: persisted.state.right },
        version: 1,
    }),
);
await store.persist.rehydrate();
assert.equal(store.getState().left.enabled, false);
assert.equal(store.getState().left.width, 15);
assert.equal(store.getState().right.enabled, true);
actions.disableAll();
assert.equal(store.getState().right.enabled, false);

const { applySideVisualizerOptions } = await load(
    'src/renderer/features/lyrics/side-visualizer-options.ts',
);
const calls = [];
const analyzer = {
    registerGradient: (name, value) => calls.push(['gradient', name, value]),
    setOptions: (options) => calls.push(['options', options]),
};
applySideVisualizerOptions(analyzer, {
    ...fixture.audiomotionanalyzer,
    customGradients: [
        {
            colorStops: [
                { color: '#ff0000', pos: 0.2, positionEnabled: true },
                { color: '#0000ff', level: 0.8, levelEnabled: true },
            ],
            dir: 'h',
            name: 'custom',
        },
    ],
    gradient: 'custom',
    gradientLeft: 'missing',
    maxFPS: 120,
    weightingFilter: 'Z',
});
assert.equal(calls[0][0], 'gradient');
assert.equal(calls[1][1].gradient, 'custom');
assert.equal(calls[1][1].gradientLeft, 'classic');
assert.equal(calls[1][1].maxFPS, 60);
assert.equal(calls[1][1].weightingFilter, '');
assert.equal(calls[1][1].customGradients, undefined);
assert.equal(calls[1][1].presets, undefined);
assert.equal(calls[1][1].opacity, undefined);

// A minimal hook runner exercises asynchronous capture lifetime without a DOM or new dependency.
let cursor = 0,
    pendingEffects = [],
    slots = [];
const same = (a, b) =>
    a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
globalThis.sideHookRuntime = {
    useCallback(fn, deps) {
        const index = cursor++;
        if (!same(slots[index]?.deps, deps)) slots[index] = { deps, value: fn };
        return slots[index].value;
    },
    useEffect(fn, deps) {
        const index = cursor++;
        if (!same(slots[index]?.deps, deps))
            pendingEffects.push(() => {
                slots[index]?.cleanup?.();
                slots[index] = { cleanup: fn(), deps, fn };
            });
    },
    useRef(initial) {
        const index = cursor++;
        return (slots[index] ??= { current: initial });
    },
};
globalThis.captureState = { audio: undefined, denied: 0, local: true, requests: [], success: 0 };
globalThis.captureSetAudio = (audio) => {
    globalThis.captureState.audio = audio;
};
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        mediaDevices: {
            getDisplayMedia: () =>
                new Promise((resolve, reject) =>
                    globalThis.captureState.requests.push({ reject, resolve }),
                ),
        },
    },
});
globalThis.window = { api: { utils: { isMacOS: () => false } }, AudioContext: true };
const contexts = [];
globalThis.AudioContext = class {
    constructor() {
        this.state = 'running';
        contexts.push(this);
    }
    async close() {
        this.state = 'closed';
    }
    createMediaStreamSource() {
        return {
            disconnect() {
                return undefined;
            },
        };
    }
    async resume() {
        return undefined;
    }
};
const { useVisualizerSystemAudio } = await load(
    'src/renderer/features/player/hooks/use-visualizer-system-audio.ts',
    {
        '/@/i18n/i18n': 'export default {t:()=>"capture error"};',
        '/@/renderer/features/player/hooks/use-webaudio':
            'export const useWebAudio=()=>({webAudio:globalThis.captureState.audio,setWebAudio:globalThis.captureSetAudio});',
        '/@/renderer/store/settings.store':
            'export const usePlaybackType=()=>globalThis.captureState.local?"local":"web";',
        '/@/shared/components/toast/toast':
            'export const toast={error:()=>{throw Error("unexpected capture error")}};',
        '/@/shared/types/types': 'export const PlayerType={LOCAL:"local",WEB:"web"};',
        'is-electron': 'export default ()=>true;',
        react: 'export const {useRef,useCallback,useEffect}=globalThis.sideHookRuntime;',
    },
);
const render = (visible) => {
    cursor = 0;
    pendingEffects = [];
    useVisualizerSystemAudio({
        onSystemAudioCaptureDenied: () => globalThis.captureState.denied++,
        onSystemAudioCaptureSuccess: () => globalThis.captureState.success++,
        shouldAttemptConnection: visible,
    });
    for (const effect of pendingEffects) effect();
};
const settle = async () => {
    for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
};
const stream = () => {
    const track = {
        stop() {
            this.stops++;
        },
        stops: 0,
    };
    return { getAudioTracks: () => [track], getTracks: () => [track], track };
};
render(true);
assert.equal(globalThis.captureState.requests.length, 1);
render(false);
render(true);
const obsolete = stream();
globalThis.captureState.requests[0].resolve(obsolete);
await settle();
assert.equal(obsolete.track.stops, 1);
assert.equal(globalThis.captureState.success, 0);
assert.equal(globalThis.captureState.requests.length, 2);
const current = stream();
globalThis.captureState.requests[1].resolve(current);
await settle();
assert.equal(globalThis.captureState.success, 1);
assert.equal(globalThis.captureState.audio.visualizerInputs.length, 1);
render(true);
for (const slot of slots) slot?.cleanup?.();
assert.equal(current.track.stops, 1);
assert.equal(globalThis.captureState.audio, undefined);
assert.equal(contexts[0].state, 'closed');
// A permission result arriving after unmount must be stopped and must not notify denial/success.
slots = [];
render(true);
const lastRequest = globalThis.captureState.requests.at(-1);
for (const slot of slots) slot?.cleanup?.();
const late = stream();
lastRequest.resolve(late);
await settle();
assert.equal(late.track.stops, 1);
assert.equal(globalThis.captureState.success, 1);
assert.equal(globalThis.captureState.denied, 0);

// StrictMode replays setup/cleanup without another render. Eligibility must recover in setup.
slots = [];
render(true);
const strictObsoleteRequest = globalThis.captureState.requests.at(-1);
for (const slot of slots) slot?.cleanup?.();
for (const slot of slots) if (slot?.fn) slot.cleanup = slot.fn();
const strictObsolete = stream();
strictObsoleteRequest.resolve(strictObsolete);
await settle();
assert.equal(strictObsolete.track.stops, 1);
const strictCurrent = stream();
globalThis.captureState.requests.at(-1).resolve(strictCurrent);
await settle();
assert.equal(globalThis.captureState.success, 2);
for (const slot of slots) slot?.cleanup?.();
assert.equal(strictCurrent.track.stops, 1);

console.log(
    'PASS: isolated side snapshots, presets/gradients, bounded widths, persistence recovery, transient/idempotent surface registration, gradient ordering/FPS cap, capture disable/reopen race, late unmount cleanup and StrictMode replay',
);
