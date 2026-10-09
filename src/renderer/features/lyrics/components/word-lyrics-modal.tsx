import { closeModal, openModal } from '@mantine/modals';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import DOMPurify from 'dompurify';
import formatDuration from 'format-duration';
import isElectron from 'is-electron';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './word-lyrics-modal.module.css';

import i18n from '/@/i18n/i18n';
import { api } from '/@/renderer/api';
import {
    clearLocalWordLyrics,
    fetchPublicWordLyrics,
    fetchUnisonWordLyrics,
    LocalWordLyrics,
    publicWordCatalogQuery,
    saveLocalWordLyrics,
    searchUnisonWordLyrics,
    UnisonWordLyric,
} from '/@/renderer/features/lyrics/api/word-lyrics-api';
import {
    exportEnhancedLrc,
    parseWordLyricsFileWithWarnings,
    WORD_LYRICS_MAX_BYTES,
} from '/@/renderer/features/lyrics/api/word-lyrics-parser';
import { getServerById, usePlayerSong, usePlayerStoreBase } from '/@/renderer/store';
import { normalizeServerUrl } from '/@/renderer/utils/normalize-server-url';
import { Button } from '/@/shared/components/button/button';
import { Group } from '/@/shared/components/group/group';
import { Progress } from '/@/shared/components/progress/progress';
import { Select } from '/@/shared/components/select/select';
import { Stack } from '/@/shared/components/stack/stack';
import { TextInput } from '/@/shared/components/text-input/text-input';
import { Text } from '/@/shared/components/text/text';
import { QueueSong, SynchronizedLyrics } from '/@/shared/types/domain-types';
import { NetEaseWordLyricsSong, WordLyricsStatus } from '/@/shared/types/word-lyrics';

type Props = {
    currentRecord?: LocalWordLyrics | null;
    lines: null | SynchronizedLyrics;
    modalId: string;
    onChange: (record: LocalWordLyrics | null) => void;
    song: QueueSong;
};

const wordsCount = (lyrics: SynchronizedLyrics) =>
    lyrics.reduce(
        (total, line) =>
            total + (line.cueLines?.reduce((count, cue) => count + cue.words.length, 0) ?? 0),
        0,
    );
const normalizeSearch = (value: string) =>
    value
        .normalize('NFKD')
        .replace(/\p{Mark}/gu, '')
        .toLowerCase()
        .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
        .trim();

const WordLyricsModal = ({ currentRecord, lines, modalId, onChange, song }: Props) => {
    const { t } = useTranslation();
    const playingSong = usePlayerSong();
    const isCurrent = playingSong?.id === song.id && playingSong?._serverId === song._serverId;
    const isTrackCurrent = () => {
        const current = usePlayerStoreBase.getState().getCurrentSong();
        return current?.id === song.id && current?._serverId === song._serverId;
    };
    const wordApi = isElectron() ? window.api.wordLyrics : null;
    const [mode, setMode] = useState<'generate' | 'import' | 'online'>('online');
    const [title, setTitle] = useState(song.name);
    const [artist, setArtist] = useState(song.artistName ?? '');
    const queryClient = useQueryClient();
    const [provider, setProvider] = useState<'amll' | 'netease' | 'unison'>('amll');
    const [searchSnapshot, setSearchSnapshot] = useState<null | { artist: string; title: string }>(
        null,
    );
    const [unisonResults, setUnisonResults] = useState<UnisonWordLyric[]>([]);
    const [neteaseResults, setNeteaseResults] = useState<NetEaseWordLyricsSong[]>([]);
    const [searching, setSearching] = useState(false);
    const [searched, setSearched] = useState(false);
    const [language, setLanguage] = useState('en');
    const [status, setStatus] = useState<null | WordLyricsStatus>(
        wordApi ? null : { available: false, message: t('wordTiming.desktopOnly') },
    );
    const [candidate, setCandidate] = useState<LocalWordLyrics | null>(currentRecord ?? null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState({ message: '', progress: 0 });
    const job = useRef<null | string>(null);
    const request = useRef<AbortController | null>(null);
    const cancelNetEase = useRef<(() => Promise<void>) | null>(null);
    const mounted = useRef(true);

    const catalog = useQuery({
        ...publicWordCatalogQuery(),
        enabled: searched && mode === 'online' && provider === 'amll' && isCurrent && !busy,
        retry: false,
    });
    const titleTokens = normalizeSearch(searchSnapshot?.title ?? '')
        .split(' ')
        .filter(Boolean);
    const artistTokens = normalizeSearch(searchSnapshot?.artist ?? '')
        .split(' ')
        .filter(Boolean);
    const matches = (catalog.data ?? []).filter(
        (entry) =>
            titleTokens.length > 0 &&
            titleTokens.every((token) => normalizeSearch(entry.name).includes(token)) &&
            artistTokens.every((token) => normalizeSearch(entry.artists).includes(token)),
    );

    useEffect(() => {
        mounted.current = true;
        wordApi
            ?.status()
            .then((value) => {
                if (mounted.current) setStatus(value);
            })
            .catch(() => {
                if (mounted.current)
                    setStatus({ available: false, message: t('wordTiming.statusFailed') });
            });
        const unsubscribe = wordApi?.onProgress((value) => {
            if (mounted.current && value.jobId === job.current) setProgress(value);
        });
        return () => {
            mounted.current = false;
            request.current?.abort();
            if (job.current) void wordApi?.cancel(job.current);
            unsubscribe?.();
        };
    }, [wordApi, t]);

    useEffect(() => {
        if (isCurrent) return;
        request.current?.abort();
        if (job.current) void wordApi?.cancel(job.current);
        setCandidate(null);
        setSearched(false);
        setSearchSnapshot(null);
        setUnisonResults([]);
        setNeteaseResults([]);
        setError(t('wordTiming.songChanged'));
    }, [isCurrent, t, wordApi]);

    useEffect(() => {
        if (mode !== 'online' || provider !== 'amll' || !isCurrent)
            void queryClient.cancelQueries({ queryKey: publicWordCatalogQuery().queryKey });
    }, [mode, provider, isCurrent, queryClient]);

    const durationLabel = (durationMs: number) => {
        if (durationMs <= 0) return t('wordTiming.durationUnknown');
        return song.duration
            ? t('wordTiming.durationMatch', {
                  difference: ((durationMs - song.duration) / 1000).toFixed(1),
                  duration: formatDuration(durationMs),
              })
            : t('wordTiming.durationOnly', { duration: formatDuration(durationMs) });
    };

    const runNetEaseRequest = async <T,>(
        signal: AbortSignal,
        operation: (requestId: string) => Promise<T>,
    ): Promise<T> => {
        if (!wordApi) throw Error(t('wordTiming.neteaseDesktopOnly'));
        signal.throwIfAborted();
        const requestId = crypto.randomUUID();
        let cancellation: null | Promise<void> = null;
        const stop = () => (cancellation ??= wordApi.cancelNetEase(requestId));
        cancelNetEase.current = stop;
        const onAbort = () => {
            void stop().catch(() => {
                if (mounted.current && request.current?.signal === signal)
                    setError(t('wordTiming.neteaseCancelFailed'));
            });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        try {
            return await operation(requestId);
        } finally {
            signal.removeEventListener('abort', onAbort);
            if (cancelNetEase.current === stop) cancelNetEase.current = null;
        }
    };

    const findOnline = async () => {
        if (busy || !isTrackCurrent()) return;
        setSearchSnapshot({ artist, title });
        setSearched(true);
        setCandidate(null);
        setError('');
        if (provider === 'amll') {
            if (searched && catalog.error) void catalog.refetch();
            return;
        }
        const controller = new AbortController();
        request.current = controller;
        setBusy(true);
        setSearching(true);
        setUnisonResults([]);
        setNeteaseResults([]);
        try {
            if (provider === 'netease') {
                const results = await runNetEaseRequest(controller.signal, (requestId) =>
                    wordApi!.searchNetEase({ artist, requestId, title }),
                );
                if (
                    mounted.current &&
                    request.current === controller &&
                    !controller.signal.aborted &&
                    isTrackCurrent()
                )
                    setNeteaseResults(results);
            } else {
                const results = await searchUnisonWordLyrics(title, artist, controller.signal);
                if (
                    mounted.current &&
                    request.current === controller &&
                    !controller.signal.aborted &&
                    isTrackCurrent()
                )
                    setUnisonResults(results);
            }
        } catch (failure) {
            if (mounted.current && request.current === controller && isTrackCurrent())
                setError(
                    controller.signal.aborted
                        ? t('wordTiming.cancelled')
                        : failure instanceof Error
                          ? failure.message
                          : t('wordTiming.failed'),
                );
        } finally {
            if (request.current === controller) {
                request.current = null;
                if (mounted.current) {
                    setBusy(false);
                    setSearching(false);
                }
            }
        }
    };

    const run = async (operation: (signal: AbortSignal) => Promise<LocalWordLyrics>) => {
        if (busy || !isTrackCurrent()) return;
        setBusy(true);
        setError('');
        setCandidate(null);
        const controller = new AbortController();
        request.current = controller;
        try {
            const result = await operation(controller.signal);
            if (!wordsCount(result.lyrics)) throw Error(t('wordTiming.noAlignedWords'));
            const fallbackLines = result.lyrics.filter(
                (line) => line.text.trim() && !line.cueLines?.some((cue) => cue.words.length),
            ).length;
            if (fallbackLines)
                result.warnings = [
                    ...result.warnings,
                    t('wordTiming.partialLines', { count: fallbackLines }),
                ];
            if (mounted.current && !controller.signal.aborted && isTrackCurrent())
                setCandidate(result);
        } catch (failure) {
            if (mounted.current && isTrackCurrent())
                setError(
                    controller.signal.aborted
                        ? t('wordTiming.cancelled')
                        : failure instanceof Error
                          ? failure.message
                          : t('wordTiming.failed'),
                );
        } finally {
            if (request.current === controller) request.current = null;
            job.current = null;
            if (mounted.current) setBusy(false);
        }
    };

    const cancel = async () => {
        const stopNetEase = cancelNetEase.current;
        request.current?.abort();
        try {
            if (stopNetEase) await stopNetEase();
            if (job.current) await wordApi?.cancel(job.current);
            return true;
        } catch {
            if (mounted.current)
                setError(
                    t(stopNetEase ? 'wordTiming.neteaseCancelFailed' : 'wordTiming.cancelFailed'),
                );
            return false;
        }
    };

    const generate = () =>
        run(async () => {
            if (!wordApi || !lines?.length) throw Error(t('wordTiming.needLines'));
            const server = getServerById(song._serverId);
            if (!server || !song.duration || song.duration > 15 * 60 * 1000)
                throw Error(t('wordTiming.durationLimit'));
            const decoder = document.createElement('textarea');
            const timedLines = lines
                .map((line, index) => {
                    decoder.innerHTML = DOMPurify.sanitize(line.text, {
                        ALLOWED_ATTR: [],
                        ALLOWED_TAGS: [],
                    });
                    return {
                        endMs: lines[index + 1]?.startMs ?? song.duration!,
                        startMs: line.startMs,
                        text: decoder.value,
                    };
                })
                .filter((line) => line.text.trim());
            if (
                timedLines.some(
                    (line) => line.endMs <= line.startMs || line.endMs - line.startMs > 120000,
                )
            )
                throw Error(t('wordTiming.lineLimit'));
            job.current = crypto.randomUUID();
            setProgress({ message: t('wordTiming.starting'), progress: 0 });
            const result = await wordApi.generate({
                audioUrl: api.controller.getDownloadUrl({
                    apiClientProps: { serverId: song._serverId },
                    query: { id: song.id },
                }),
                durationMs: song.duration,
                jobId: job.current,
                language,
                lines: timedLines,
                serverUrl: normalizeServerUrl(server.url),
            });
            return {
                artist: song.artistName ?? '',
                createdAt: new Date().toISOString(),
                lyrics: result.lyrics,
                name: song.name,
                quality: t('wordTiming.generatedCounts', {
                    aligned: result.alignedWords,
                    rough: result.estimatedWords ?? 0,
                    total: result.totalWords,
                }),
                source: 'generated',
                warnings: result.warnings,
            };
        });

    const apply = async () => {
        if (!candidate || !isTrackCurrent()) return;
        setBusy(true);
        try {
            await saveLocalWordLyrics(song._serverId, song.id, candidate);
            if (mounted.current) {
                onChange(candidate);
                closeModal(modalId);
            }
        } catch {
            if (mounted.current) setError(t('wordTiming.saveFailed'));
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    const clear = async () => {
        if (!isTrackCurrent()) return;
        setBusy(true);
        try {
            await clearLocalWordLyrics(song._serverId, song.id);
            if (mounted.current) {
                onChange(null);
                closeModal(modalId);
            }
        } catch {
            if (mounted.current) setError(t('wordTiming.saveFailed'));
        } finally {
            if (mounted.current) setBusy(false);
        }
    };

    const exportFile = () => {
        if (!candidate) return;
        const url = URL.createObjectURL(
            new Blob([exportEnhancedLrc(candidate.lyrics)], { type: 'text/plain;charset=utf-8' }),
        );
        const link = document.createElement('a');
        link.href = url;
        link.download = `${song.name.replace(/[<>:"/\\|?*]/g, '_')}.lrc`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    return (
        <Stack gap="md">
            <Text size="sm">{t('wordTiming.description')}</Text>
            <Text fw={600}>
                {song.name} - {song.artistName}
            </Text>
            <Group gap="xs">
                {(['online', 'generate', 'import'] as const).map((value) => (
                    <Button
                        disabled={busy || !isCurrent}
                        key={value}
                        onClick={() => {
                            setMode(value);
                            setCandidate(null);
                            setError('');
                        }}
                        variant={mode === value ? 'filled' : 'default'}
                    >
                        {t(`wordTiming.modes.${value}`)}
                    </Button>
                ))}
            </Group>
            {mode === 'online' && (
                <Stack gap="xs">
                    <Text isMuted size="sm">
                        {t(
                            provider === 'amll'
                                ? 'wordTiming.onlineNote'
                                : provider === 'netease'
                                  ? 'wordTiming.neteaseNote'
                                  : 'wordTiming.unisonNote',
                        )}
                    </Text>
                    <Select
                        data={[
                            { label: 'AMLL', value: 'amll' },
                            { label: 'Unison', value: 'unison' },
                            { disabled: !wordApi, label: 'NetEase', value: 'netease' },
                        ]}
                        disabled={(busy && !searching) || !isCurrent}
                        label={t('wordTiming.provider')}
                        onChange={(value) => {
                            if (value !== 'amll' && value !== 'unison' && value !== 'netease')
                                return;
                            if (value === 'netease' && !wordApi) return;
                            if (searching) {
                                request.current?.abort();
                                request.current = null;
                                setBusy(false);
                                setSearching(false);
                            }
                            setProvider(value);
                            setSearched(false);
                            setSearchSnapshot(null);
                            setUnisonResults([]);
                            setNeteaseResults([]);
                            setCandidate(null);
                            setError('');
                        }}
                        value={provider}
                    />
                    {!wordApi && (
                        <Text isMuted size="xs">
                            {t('wordTiming.neteaseDesktopOnly')}
                        </Text>
                    )}
                    <TextInput
                        disabled={busy}
                        label={t('wordTiming.songTitle')}
                        onChange={(event) => setTitle(event.currentTarget.value)}
                        value={title}
                    />
                    <TextInput
                        disabled={busy}
                        label={t('wordTiming.artist')}
                        onChange={(event) => setArtist(event.currentTarget.value)}
                        value={artist}
                    />
                    <Button
                        disabled={
                            busy ||
                            !isCurrent ||
                            !title.trim() ||
                            (provider === 'netease' && !wordApi)
                        }
                        loading={provider === 'amll' ? catalog.isFetching : searching}
                        onClick={() => void findOnline()}
                    >
                        {t('wordTiming.find')}
                    </Button>
                    {provider === 'amll' && catalog.error && (
                        <Text role="alert">{t('wordTiming.catalogFailed')}</Text>
                    )}
                    {isCurrent && searched && (provider !== 'amll' ? !searching : catalog.data) && (
                        <Text size="sm">
                            {t('wordTiming.results', {
                                count:
                                    provider === 'amll'
                                        ? matches.length
                                        : provider === 'netease'
                                          ? neteaseResults.length
                                          : unisonResults.length,
                            })}
                        </Text>
                    )}
                    <div className={styles.results}>
                        {isCurrent &&
                            provider === 'amll' &&
                            searched &&
                            matches.slice(0, 50).map((entry) => (
                                <button
                                    disabled={busy || !isCurrent}
                                    key={entry.filename}
                                    onClick={() =>
                                        void run(async (signal) => ({
                                            ...parseWordLyricsFileWithWarnings(
                                                await fetchPublicWordLyrics(entry.filename, signal),
                                                entry.filename,
                                            ),
                                            album: entry.album,
                                            artist: entry.artists,
                                            createdAt: new Date().toISOString(),
                                            name: entry.name,
                                            origin: entry.filename,
                                            quality: 'source',
                                            source: 'amll',
                                        }))
                                    }
                                    type="button"
                                >
                                    <strong>{entry.name}</strong>
                                    <span>
                                        {entry.artists} - {entry.album}
                                    </span>
                                    <small>{entry.filename}</small>
                                </button>
                            ))}
                        {isCurrent &&
                            provider === 'unison' &&
                            unisonResults.map((entry) => (
                                <button
                                    disabled={busy}
                                    key={entry.id}
                                    onClick={() =>
                                        void run(async (signal) => {
                                            const record = await fetchUnisonWordLyrics(
                                                entry.id,
                                                signal,
                                            );
                                            return {
                                                album: record.album,
                                                artist: record.artist,
                                                createdAt: new Date().toISOString(),
                                                ...parseWordLyricsFileWithWarnings(
                                                    record.text,
                                                    `${record.id}.ttml`,
                                                ),
                                                name: record.name,
                                                origin: `https://unison.boidu.dev/lyrics/${record.id}`,
                                                quality: 'source',
                                                source: 'unison',
                                            };
                                        })
                                    }
                                    type="button"
                                >
                                    <strong>{entry.name}</strong>
                                    <span>
                                        {entry.artist} - {entry.album}
                                    </span>
                                    <small>
                                        #{entry.id} {entry.confidence}
                                    </small>
                                </button>
                            ))}
                        {isCurrent &&
                            provider === 'netease' &&
                            neteaseResults.map((entry) => (
                                <button
                                    disabled={busy}
                                    key={entry.id}
                                    onClick={() =>
                                        void run(async (signal) => {
                                            const result = await runNetEaseRequest(
                                                signal,
                                                (requestId) =>
                                                    wordApi!.getNetEase({
                                                        id: entry.id,
                                                        requestId,
                                                    }),
                                            );
                                            return {
                                                album: entry.album,
                                                artist: entry.artist,
                                                createdAt: new Date().toISOString(),
                                                durationMs: entry.durationMs,
                                                lyrics: result.lyrics,
                                                name: entry.name,
                                                origin: `https://music.163.com/song?id=${entry.id}`,
                                                quality: 'source',
                                                source: 'netease',
                                                warnings: result.warnings ?? [],
                                            };
                                        })
                                    }
                                    type="button"
                                >
                                    <strong>{entry.name}</strong>
                                    <span>
                                        {entry.artist} - {entry.album}
                                    </span>
                                    <small>{durationLabel(entry.durationMs)}</small>
                                </button>
                            ))}
                    </div>
                </Stack>
            )}
            {mode === 'generate' && (
                <Stack gap="xs">
                    <Text size="sm">{t('wordTiming.generationNote')}</Text>
                    {!lines?.length && <Text role="alert">{t('wordTiming.needLines')}</Text>}
                    <Text isMuted size="sm">
                        {status?.message ?? t('wordTiming.checkingEngine')}
                    </Text>
                    <Select
                        data={[
                            { label: 'English', value: 'en' },
                            { label: 'French', value: 'fr' },
                            { label: 'German', value: 'de' },
                            { label: 'Spanish', value: 'es' },
                            { label: 'Italian', value: 'it' },
                        ]}
                        disabled={busy}
                        label={t('wordTiming.language')}
                        onChange={(value) => setLanguage(value ?? 'en')}
                        value={language}
                    />
                    <Button
                        disabled={!lines?.length || !status?.available || !isCurrent}
                        loading={busy}
                        onClick={() => void generate()}
                    >
                        {t('wordTiming.generate')}
                    </Button>
                </Stack>
            )}
            {mode === 'import' && (
                <Stack gap="xs">
                    <Text size="sm">{t('wordTiming.importNote')}</Text>
                    <input
                        accept=".lrc,.ttml"
                        aria-label={t('wordTiming.importFile')}
                        disabled={busy || !isCurrent}
                        onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = '';
                            if (file)
                                void run(async () => {
                                    if (file.size > WORD_LYRICS_MAX_BYTES)
                                        throw Error(t('wordTiming.fileTooLarge'));
                                    return {
                                        artist: song.artistName ?? '',
                                        createdAt: new Date().toISOString(),
                                        ...parseWordLyricsFileWithWarnings(
                                            await file.text(),
                                            file.name,
                                        ),
                                        name: file.name,
                                        origin: file.name,
                                        quality: 'source',
                                        source: 'imported',
                                    };
                                });
                        }}
                        type="file"
                    />
                </Stack>
            )}
            {busy && request.current && (
                <Stack gap="xs">
                    <Progress
                        aria-label={t('wordTiming.progress')}
                        value={Math.max(0, Math.min(100, progress.progress))}
                    />
                    <Text size="sm">{progress.message || t('wordTiming.working')}</Text>
                    <Button onClick={() => void cancel()} variant="default">
                        {t('wordTiming.cancelJob')}
                    </Button>
                </Stack>
            )}
            {error && (
                <Text c="red" role="alert">
                    {error}
                </Text>
            )}
            {candidate && (
                <Stack gap="xs">
                    <Text size="sm">
                        {candidate.name} - {candidate.artist} {candidate.album}
                    </Text>
                    {candidate.durationMs !== undefined && (
                        <Text isMuted size="sm">
                            {durationLabel(candidate.durationMs)}
                        </Text>
                    )}
                    {candidate.origin && (
                        <Text isMuted size="xs">
                            {candidate.origin}
                        </Text>
                    )}
                    <Text fw={600}>
                        {t(`wordTiming.sources.${candidate.source}`)} -{' '}
                        {wordsCount(candidate.lyrics)} {t('wordTiming.words')}
                    </Text>
                    <Text size="sm">
                        {candidate.source === 'generated'
                            ? t('wordTiming.estimatedQuality', { quality: candidate.quality })
                            : t('wordTiming.sourceQuality')}
                    </Text>
                    {candidate.warnings.map((warning, index) => (
                        <Text key={index} size="sm">
                            {warning}
                        </Text>
                    ))}
                    <div className={styles.preview}>
                        {candidate.lyrics.map((line, index) => (
                            <div key={index}>
                                <strong>
                                    {(line.startMs / 1000).toFixed(2)}s: {line.text}
                                </strong>
                                <small>
                                    {line.cueLines
                                        ?.flatMap((cue) => cue.words)
                                        .map(
                                            (word) =>
                                                `${word.text} [${(word.startMs / 1000).toFixed(2)}-${(word.endMs / 1000).toFixed(2)}s]`,
                                        )
                                        .join(' ')}
                                </small>
                            </div>
                        ))}
                    </div>
                </Stack>
            )}
            <Group justify="space-between">
                <Button disabled={busy || !isCurrent} onClick={() => void clear()} variant="subtle">
                    {t('wordTiming.clear')}
                </Button>
                <Group gap="xs">
                    <Button
                        disabled={busy && !request.current}
                        onClick={async () => {
                            if (await cancel()) closeModal(modalId);
                        }}
                        variant="default"
                    >
                        {busy ? t('wordTiming.cancelAndClose') : t('common.close')}
                    </Button>
                    <Button disabled={!candidate || busy} onClick={exportFile} variant="default">
                        {t('wordTiming.export')}
                    </Button>
                    <Button
                        disabled={!candidate || busy || !isCurrent}
                        onClick={() => void apply()}
                    >
                        {t('wordTiming.save')}
                    </Button>
                </Group>
            </Group>
            {currentRecord && (
                <Text isMuted size="xs">
                    {t('wordTiming.savedRecord', {
                        date: currentRecord.createdAt,
                        quality: currentRecord.quality,
                        source: t(`wordTiming.sources.${currentRecord.source}`),
                    })}
                </Text>
            )}
        </Stack>
    );
};

export const openWordLyricsModal = (props: Omit<Props, 'modalId'>) => {
    const modalId = `word-lyrics-${crypto.randomUUID()}`;
    openModal({
        children: <WordLyricsModal {...props} modalId={modalId} />,
        closeOnClickOutside: false,
        closeOnEscape: false,
        modalId,
        size: 'xl',
        title: i18n.t('wordTiming.title'),
        withCloseButton: false,
    });
};
