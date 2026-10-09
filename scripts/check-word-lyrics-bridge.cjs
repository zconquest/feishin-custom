/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Node-only harness isolates compiled IPC modules with mocked CommonJS dependencies. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Readable } = require('node:stream');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function load(file, dependencies, globals = {}) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const code = ts.transpileModule(source, {
        compilerOptions: {
            esModuleInterop: true,
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
        },
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(code, {
        AbortController,
        Buffer,
        clearTimeout,
        console,
        exports: module.exports,
        module,
        require: (name) => (name in dependencies ? dependencies[name] : require(name)),
        setTimeout,
        URL,
        ...globals,
    });
    return module.exports;
}

const validation = load('src/main/features/core/word-lyrics/validation.ts', {});
const request = {
    audioUrl: 'https://music.test/audio?secret=private',
    durationMs: 10_000,
    jobId: 'test-1',
    language: 'en',
    lines: [{ endMs: 5_000, startMs: 0, text: 'Hello world' }],
    serverUrl: 'https://music.test',
};
function result() {
    return {
        alignedWords: 2,
        lyrics: [
            {
                cueLines: [
                    {
                        endMs: 5_000,
                        index: 0,
                        startMs: 0,
                        value: 'Hello world',
                        words: [
                            { endMs: 500, startMs: 100, text: 'Hello' },
                            { endMs: 1000, startMs: 600, text: 'world' },
                        ],
                    },
                ],
                startMs: 0,
                text: 'Hello world',
            },
        ],
        totalWords: 2,
        warnings: [],
    };
}
assert.equal(validation.validateRequest(request).origin, 'https://music.test');
for (const mutation of [
    { language: 'xx' },
    { durationMs: 900_001 },
    { jobId: '../unsafe' },
    { audioUrl: 'https://other.test/audio' },
    { audioUrl: 'file:///private' },
    { lines: [{ endMs: 11_000, startMs: 0, text: 'Too long' }] },
]) {
    assert.throws(() => validation.validateRequest({ ...request, ...mutation }));
}
assert.equal(validation.validateResult(result(), request).alignedWords, 2);
const legacyValidated = validation.validateResult(result(), request);
assert.equal(legacyValidated.estimatedWords, 0);
assert.equal(legacyValidated.lyrics[0].cueLines[0].words[0].timingSource, 'aligned');
const mixed = result();
mixed.alignedWords = 1;
mixed.estimatedWords = 1;
mixed.lyrics[0].cueLines[0].words[0].timingSource = 'aligned';
mixed.lyrics[0].cueLines[0].words[1].timingSource = 'estimated';
mixed.lyrics[0].cueLines[0].words[1].privateDiagnostic = 'must not cross bridge';
const mixedValidated = validation.validateResult(mixed, request);
assert.equal(mixedValidated.alignedWords, 1);
assert.equal(mixedValidated.estimatedWords, 1);
assert.equal(mixedValidated.lyrics[0].cueLines[0].words[1].timingSource, 'estimated');
assert.equal(mixedValidated.lyrics[0].cueLines[0].words[1].privateDiagnostic, undefined);
const entirelyEstimated = result();
entirelyEstimated.alignedWords = 0;
entirelyEstimated.estimatedWords = 2;
for (const word of entirelyEstimated.lyrics[0].cueLines[0].words) word.timingSource = 'estimated';
assert.equal(validation.validateResult(entirelyEstimated, request).estimatedWords, 2);
for (const mutation of [
    { estimatedWords: -1 },
    { estimatedWords: null },
    { estimatedWords: NaN },
    { estimatedWords: 3 },
    { alignedWords: 2 },
    { totalWords: 3 },
]) {
    assert.throws(() => validation.validateResult({ ...mixed, ...mutation }, request));
}
for (const source of [undefined, 'unknown', null]) {
    const missingProvenance = result();
    missingProvenance.estimatedWords = 0;
    for (const word of missingProvenance.lyrics[0].cueLines[0].words) word.timingSource = source;
    assert.throws(() => validation.validateResult(missingProvenance, request));
}
let invalid = result();
invalid.lyrics[0].cueLines[0].words[1].startMs = 200;
assert.throws(() => validation.validateResult(invalid, request));
invalid = result();
invalid.lyrics[0].cueLines[0].words.pop();
invalid.alignedWords = 1;
assert.throws(() => validation.validateResult(invalid, request));
const translated = {
    ...request,
    lines: [{ ...request.lines[0], text: 'Hello world_BREAK_Bonjour monde' }],
};
const translatedResult = result();
translatedResult.lyrics[0].text = translated.lines[0].text;
translatedResult.lyrics[0].cueLines[0].value = translated.lines[0].text;
assert.equal(validation.validateResult(translatedResult, translated).alignedWords, 2);
const changedWordBoundaries = result();
changedWordBoundaries.lyrics[0].cueLines[0].words[0].text = 'Hellowo';
changedWordBoundaries.lyrics[0].cueLines[0].words[1].text = 'rld';
assert.throws(() => validation.validateResult(changedWordBoundaries, request));
const warned = result();
warned.warnings = [
    'Generated timings are model estimates; singing, backing vocals and incorrect line lyrics can reduce accuracy.',
    'CUDA is unavailable; alignment is running on CPU and may take longer.',
    '2 lyric lines could not be fully aligned and retain line timing.',
    'Vocal isolation failed (RuntimeError); aligned against the original mix.',
    'private diagnostic https://music.test?secret=private',
];
const safeWarnings = validation.validateResult(warned, request).warnings;
assert.equal(safeWarnings[0], warned.warnings[0]);
assert.equal(safeWarnings[1], warned.warnings[1]);
assert.equal(safeWarnings[2], warned.warnings[2]);
assert.equal(safeWarnings[3], 'Vocal isolation was unavailable; aligned against the original mix.');
assert.equal(safeWarnings[4], 'The local alignment engine reported a processing limitation.');
const roughWarnings = result();
roughWarnings.warnings = [
    '2 words use approximate line-based timing.',
    '1 lyric lines have no usable audio window and retain line timing.',
    '1 lyric lines could not be processed by the alignment model and use approximate timing.',
    '2 words use approximate line-based timing. https://private.test?secret=private',
];
const roughSafe = validation.validateResult(roughWarnings, request).warnings;
assert.equal(roughSafe[0], roughWarnings.warnings[0]);
assert.equal(roughSafe[1], roughWarnings.warnings[1]);
assert.equal(roughSafe[2], roughWarnings.warnings[2]);
assert.equal(roughSafe[3], 'The local alignment engine reported a processing limitation.');

async function main() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'feishin-bridge-test-'));
    const handlers = new Map();
    const app = new EventEmitter();
    app.getPath = () => temp;
    let quitCalls = 0;
    app.quit = () => {
        quitCalls += 1;
    };
    const runtime = {
        ffmpegPath: path.join(temp, 'ffmpeg'),
        modelCache: temp,
        pythonPath: path.join(temp, 'python'),
        scriptPath: path.join(temp, 'runner.py'),
    };
    for (const key of ['ffmpegPath', 'pythonPath', 'scriptPath']) {
        fs.writeFileSync(runtime[key], 'fixture');
    }
    fs.writeFileSync(path.join(temp, 'word-lyrics-runtime.json'), JSON.stringify(runtime));
    let mode = 'success';
    let redirect = false;
    let child;
    let engineInput;
    const sender = new EventEmitter();
    sender.isDestroyed = () => false;
    const progressEvents = [];
    sender.send = (_channel, progress) => progressEvents.push(progress);
    const stranger = new EventEmitter();
    stranger.isDestroyed = () => false;
    const axios = {
        get: async () =>
            redirect
                ? {
                      data: Readable.from([]),
                      headers: { location: 'https://other.test/private' },
                      status: 302,
                  }
                : { data: Readable.from([Buffer.from('audio-fixture')]), headers: {}, status: 200 },
        isAxiosError: () => false,
    };
    const spawn = () => {
        child = new EventEmitter();
        child.pid = 123;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new PassThrough();
        child.kill = () => {
            setImmediate(() => child.emit('close', 1));
            return true;
        };
        let inputText = '';
        child.stdin.on('data', (chunk) => {
            inputText += chunk.toString();
        });
        child.stdin.once('finish', () => {
            engineInput = JSON.parse(inputText);
            if (mode === 'wait') {
                return;
            }
            setImmediate(() => {
                child.stdout.write(
                    mode === 'invalid'
                        ? 'not-json\n'
                        : JSON.stringify({
                              message: 'Aligning words',
                              progress: mode === 'bad-progress' ? 101 : 5,
                              type: 'progress',
                          }) +
                              '\n' +
                              JSON.stringify({
                                  message: 'Finishing alignment',
                                  progress: 95,
                                  type: 'progress',
                              }) +
                              '\n' +
                              JSON.stringify({ result: result(), type: 'result' }) +
                              '\n',
                );
                if (mode === 'success') {
                    child.emit('close', 0);
                }
            });
        });
        return child;
    };
    load(
        'src/main/features/core/word-lyrics/index.ts',
        {
            './netease': { registerNetEaseWordLyrics: () => {} },
            './validation': validation,
            '/@/main/logger': { error: () => {} },
            axios,
            child_process: { spawn },
            electron: { app, ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
        },
        { process: { env: process.env, platform: 'linux', resourcesPath: temp } },
    );
    const generate = (jobId = request.jobId) =>
        handlers.get('word-lyrics-generate')({ sender }, { ...request, jobId });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 20));
    try {
        assert.equal((await handlers.get('word-lyrics-status')()).available, true);
        assert.equal((await generate()).alignedWords, 2);
        assert.equal(engineInput.tempRoot, path.dirname(engineInput.audioPath));
        assert.equal(path.dirname(engineInput.tempRoot), temp);
        assert.equal(
            progressEvents.some((event) => event.progress === 9.75),
            true,
        );
        assert.equal(
            progressEvents.some((event) => event.progress === 95.25),
            true,
        );
        assert.equal(
            progressEvents.every((event) => event.progress >= 0 && event.progress <= 100),
            true,
        );
        assert.equal(
            fs.readdirSync(temp).some((name) => name.startsWith('feishin-word-lyrics-')),
            false,
        );
        redirect = true;
        await assert.rejects(generate(), /redirected away/);
        redirect = false;
        mode = 'invalid';
        await assert.rejects(generate(), /invalid word timings/);
        mode = 'bad-progress';
        await assert.rejects(generate(), /invalid message/);
        mode = 'wait';
        const waiting = generate('owned-job');
        const rejection = assert.rejects(waiting, /cancelled/);
        await pause();
        await assert.rejects(generate('second-job'), /already being aligned/);
        handlers.get('word-lyrics-cancel')({ sender: stranger }, 'owned-job');
        assert.equal(child.listenerCount('close'), 1);
        handlers.get('word-lyrics-cancel')({ sender }, 'owned-job');
        await rejection;
        const destroyed = generate('destroyed-job');
        const destroyedResult = assert.rejects(destroyed, /cancelled/);
        await pause();
        sender.emit('destroyed');
        await destroyedResult;
        assert.equal(sender.listenerCount('destroyed'), 0);
        mode = 'success';
        assert.equal((await generate()).alignedWords, 2);
        fs.unlinkSync(runtime.pythonPath);
        assert.equal((await handlers.get('word-lyrics-status')()).available, false);
        fs.writeFileSync(runtime.pythonPath, 'fixture');
        mode = 'wait';
        const onQuit = generate('quit-job');
        const quitResult = assert.rejects(onQuit, /cancelled/);
        await pause();
        let prevented = 0;
        app.emit('before-quit', {
            preventDefault: () => {
                prevented += 1;
            },
        });
        assert.equal(prevented, 1);
        assert.equal(quitCalls, 0);
        await quitResult;
        assert.equal(quitCalls, 1);
        assert.equal(
            fs.readdirSync(temp).some((name) => name.startsWith('feishin-word-lyrics-')),
            false,
        );
        await assert.rejects(generate(), /closing/);
        console.log(
            'PASS: request/result validation, full-line fidelity, same-origin redirects, IPC ownership, cancellation, owner disposal, recovery, runtime readiness, temporary audio cleanup',
        );
    } finally {
        fs.rmSync(temp, { force: true, recursive: true });
    }
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
