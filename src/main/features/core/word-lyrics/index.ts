import type {
    WordLyricsGenerationRequest,
    WordLyricsGenerationResult,
    WordLyricsStatus,
} from '/@/shared/types/word-lyrics';

import axios from 'axios';
import { type ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { app, ipcMain, type WebContents } from 'electron';
import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { dirname, isAbsolute, join } from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import { registerNetEaseWordLyrics } from './netease';
import { validateRequest, validateResult } from './validation';

import log from '/@/main/logger';

type Job = {
    completion: Promise<void>;
    controller: AbortController;
    id: string;
    owner: WebContents;
    process?: ChildProcessWithoutNullStreams;
    termination?: Promise<void>;
};
type Runtime = { ffmpegPath: string; modelCache: string; pythonPath: string; scriptPath: string };

const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
registerNetEaseWordLyrics();
const MAX_ENGINE_OUTPUT_BYTES = 8 * 1024 * 1024;
let activeJob: Job | undefined;
let quitRequested = false;
let shutdownReady = false;

function cancelJob(job: Job) {
    job.controller.abort();
    void stopEngine(job);
}

async function downloadAudio(job: Job, initialUrl: URL, audioPath: string) {
    let url = initialUrl;
    const timeout = setTimeout(() => job.controller.abort(), 60_000);
    try {
        for (let redirects = 0; redirects <= 5; redirects += 1) {
            const response = await axios.get(url.href, {
                maxRedirects: 0,
                responseType: 'stream',
                signal: job.controller.signal,
                timeout: 60_000,
                validateStatus: (status) =>
                    (status >= 200 && status < 300) || [301, 302, 303, 307, 308].includes(status),
            });
            if (response.status >= 300) {
                response.data.destroy();
                const redirect = response.headers.location;
                if (typeof redirect !== 'string' || redirects === 5) {
                    throw new Error('The music server returned an invalid audio redirect.');
                }
                const destination = new URL(redirect, url);
                if (destination.origin !== initialUrl.origin) {
                    throw new Error(
                        'The audio download redirected away from the configured music server.',
                    );
                }
                url = destination;
                continue;
            }
            const declaredSize = Number(response.headers['content-length']);
            if (Number.isFinite(declaredSize) && declaredSize > MAX_AUDIO_BYTES) {
                response.data.destroy();
                throw new Error('The audio file exceeds the 128 MB alignment limit.');
            }
            let bytes = 0;
            const limiter = new Transform({
                transform(chunk: Buffer, _encoding, callback) {
                    bytes += chunk.length;
                    callback(
                        bytes > MAX_AUDIO_BYTES ? new Error('Audio size limit exceeded') : null,
                        chunk,
                    );
                },
            });
            await pipeline(response.data, limiter, createWriteStream(audioPath, { flags: 'wx' }), {
                signal: job.controller.signal,
            });
            if (bytes === 0) {
                throw new Error('The music server returned an empty audio file.');
            }
            return;
        }
    } finally {
        clearTimeout(timeout);
    }
}

async function getRuntime(): Promise<Runtime> {
    try {
        const configPath = join(process.resourcesPath, 'word-lyrics-runtime.json');
        if ((await stat(configPath)).size > 16_384) {
            throw new Error('Invalid runtime configuration');
        }
        const runtime: Runtime = JSON.parse(await readFile(configPath, 'utf8'));
        for (const key of ['pythonPath', 'scriptPath', 'ffmpegPath', 'modelCache'] as const) {
            if (typeof runtime[key] !== 'string' || !isAbsolute(runtime[key])) {
                throw new Error('Invalid runtime path');
            }
            const metadata = await stat(runtime[key]);
            if (key === 'modelCache' ? !metadata.isDirectory() : !metadata.isFile()) {
                throw new Error('Missing runtime component');
            }
        }
        return runtime;
    } catch {
        throw new Error(
            'Local lyric alignment is not installed. Install the supplied word-lyrics runtime, then restart Feishin.',
        );
    }
}

function report(job: Job, progress: number, message: string) {
    if (!job.owner.isDestroyed() && !job.controller.signal.aborted) {
        job.owner.send('word-lyrics-progress', { jobId: job.id, message, progress });
    }
}

function runEngine(
    job: Job,
    runtime: Runtime,
    audioPath: string,
    request: WordLyricsGenerationRequest,
) {
    return new Promise<WordLyricsGenerationResult>((resolve, reject) => {
        const child = spawn(runtime.pythonPath, [runtime.scriptPath], {
            env: {
                ...process.env,
                HF_HUB_OFFLINE: '1',
                PYTHONIOENCODING: 'utf-8',
                PYTHONUNBUFFERED: '1',
                TRANSFORMERS_OFFLINE: '1',
            },
            shell: false,
            windowsHide: true,
        });
        job.process = child;
        let pending = '';
        let outputBytes = 0;
        let result: undefined | WordLyricsGenerationResult;
        let failure: Error | undefined;
        const fail = (message: string) => {
            failure ??= new Error(message);
            void stopEngine(job);
        };
        child.on('error', () => {
            reject(
                new Error(
                    'The local alignment engine could not start. Reinstall the alignment runtime.',
                ),
            );
        });
        // Consume diagnostics without exposing paths, URLs, or credentials to the renderer or logs.
        let diagnosticBytes = 0;
        child.stderr.on('data', (chunk: Buffer) => {
            diagnosticBytes += chunk.length;
            if (diagnosticBytes > 1024 * 1024) {
                fail('The local alignment engine exceeded its diagnostic output limit.');
            }
        });
        child.stdin.on('error', () => fail('The local alignment engine stopped unexpectedly.'));
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            outputBytes += Buffer.byteLength(chunk);
            if (outputBytes > MAX_ENGINE_OUTPUT_BYTES) {
                fail('The local alignment engine exceeded its output limit.');
                return;
            }
            pending += chunk;
            if (Buffer.byteLength(pending) > MAX_ENGINE_OUTPUT_BYTES) {
                fail('The local alignment engine returned an oversized message.');
                return;
            }
            let newline: number;
            while ((newline = pending.indexOf('\n')) !== -1 && !failure) {
                const line = pending.slice(0, newline).trim();
                pending = pending.slice(newline + 1);
                if (!line) {
                    continue;
                }
                try {
                    const event = JSON.parse(line);
                    if (
                        event.type === 'progress' &&
                        typeof event.progress === 'number' &&
                        Number.isFinite(event.progress) &&
                        event.progress >= 0 &&
                        event.progress <= 100 &&
                        typeof event.message === 'string' &&
                        event.message.length <= 200
                    ) {
                        const safeMessage = /^[\w\s.,()%-]+$/.test(event.message)
                            ? event.message
                            : 'Aligning lyric words locally';
                        report(job, 5 + event.progress * 0.95, safeMessage);
                    } else if (event.type === 'result' && !result) {
                        result = validateResult(event.result, request);
                    } else if (event.type === 'error') {
                        fail(
                            'Local alignment failed. Check the selected language and lyric text, or reinstall the model runtime.',
                        );
                    } else {
                        fail('The local alignment engine returned an invalid message.');
                    }
                } catch {
                    fail('The local alignment engine returned invalid word timings.');
                }
            }
        });
        child.on('close', (code) => {
            job.process = undefined;
            if (job.controller.signal.aborted) {
                reject(new Error('Word lyric generation was cancelled or timed out.'));
            } else if (failure) {
                reject(failure);
            } else if (code !== 0 || !result || pending.trim()) {
                reject(
                    new Error(
                        'The local alignment engine stopped before producing complete lyrics.',
                    ),
                );
            } else {
                resolve(result);
            }
        });
        if (job.controller.signal.aborted) {
            void stopEngine(job);
        } else {
            child.stdin.end(
                JSON.stringify({
                    audioPath,
                    ffmpegPath: runtime.ffmpegPath,
                    isolateVocals: true,
                    language: request.language,
                    lines: request.lines,
                    modelCache: runtime.modelCache,
                    tempRoot: dirname(audioPath),
                }),
            );
        }
    });
}

function stopEngine(job: Job): Promise<void> {
    if (job.termination) {
        return job.termination;
    }
    const child = job.process;
    if (!child?.pid) {
        return Promise.resolve();
    }
    if (process.platform !== 'win32') {
        child.kill();
        return Promise.resolve();
    }
    // Kill the owned tree so cancellation during FFmpeg decoding leaves no orphan process.
    job.termination = new Promise((resolve) => {
        const killer = spawn(
            join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
            ['/PID', String(child.pid), '/T', '/F'],
            { shell: false, stdio: 'ignore', windowsHide: true },
        );
        killer.once('error', () => {
            child.kill();
            resolve();
        });
        killer.once('close', (code) => {
            if (code !== 0) {
                child.kill();
            }
            resolve();
        });
    });
    return job.termination;
}

ipcMain.handle('word-lyrics-status', async (): Promise<WordLyricsStatus> => {
    try {
        await getRuntime();
        return { available: true, message: 'Local word alignment is ready.' };
    } catch (error) {
        return { available: false, message: (error as Error).message };
    }
});

ipcMain.handle('word-lyrics-cancel', (event, jobId: unknown) => {
    if (activeJob && activeJob.owner === event.sender && activeJob.id === jobId) {
        cancelJob(activeJob);
    }
});

ipcMain.handle('word-lyrics-generate', async (event, request: WordLyricsGenerationRequest) => {
    if (quitRequested) {
        throw new Error('Feishin is closing. Restart it before generating word lyrics.');
    }
    const audioUrl = validateRequest(request);
    if (activeJob) {
        throw new Error(
            'Another song is already being aligned. Cancel it or wait for it to finish.',
        );
    }
    let completed!: () => void;
    const completion = new Promise<void>((resolve) => {
        completed = resolve;
    });
    const job: Job = {
        completion,
        controller: new AbortController(),
        id: request.jobId,
        owner: event.sender,
    };
    activeJob = job;
    const destroyed = () => cancelJob(job);
    event.sender.once('destroyed', destroyed);
    const timeout = setTimeout(() => cancelJob(job), 15 * 60_000);
    let directory: string | undefined;
    try {
        const runtime = await getRuntime();
        if (job.controller.signal.aborted) {
            throw new Error('cancelled');
        }
        directory = await mkdtemp(join(app.getPath('temp'), 'feishin-word-lyrics-'));
        const audioPath = join(directory, 'audio');
        report(job, 0, 'Downloading audio from your music server');
        await downloadAudio(job, audioUrl, audioPath);
        report(job, 5, 'Starting local word alignment');
        return await runEngine(job, runtime, audioPath, request);
    } catch (error) {
        if (job.controller.signal.aborted) {
            throw new Error('Word lyric generation was cancelled or timed out.');
        }
        if (axios.isAxiosError(error)) {
            throw new Error(
                'Could not download audio from your music server. Check the server connection and original file availability.',
            );
        }
        if (error instanceof Error && /^The |^Local |^Word |^Audio /.test(error.message)) {
            throw error;
        }
        throw new Error(
            'Word lyric generation failed. Check that the local runtime is installed and try again.',
        );
    } finally {
        clearTimeout(timeout);
        event.sender.removeListener('destroyed', destroyed);
        try {
            await job.termination;
            if (directory) {
                await rm(directory, {
                    force: true,
                    maxRetries: 5,
                    recursive: true,
                    retryDelay: 500,
                });
            }
        } catch {
            log.error(
                'Could not remove temporary alignment audio. Close Feishin and remove feishin-word-lyrics folders from the system temporary directory.',
            );
        } finally {
            if (activeJob === job) {
                activeJob = undefined;
            }
            completed();
        }
    }
});

app.on('before-quit', (event) => {
    if (!activeJob || shutdownReady) {
        return;
    }
    event.preventDefault();
    if (quitRequested) {
        return;
    }
    quitRequested = true;
    const job = activeJob;
    cancelJob(job);
    const timeout = setTimeout(() => {
        log.error('Local word alignment cleanup exceeded the shutdown timeout.');
        shutdownReady = true;
        app.quit();
    }, 15_000);
    void job.completion.then(() => {
        clearTimeout(timeout);
        if (shutdownReady) {
            return;
        }
        shutdownReady = true;
        app.quit();
    });
});
