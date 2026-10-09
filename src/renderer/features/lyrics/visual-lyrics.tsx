import { openModal } from '@mantine/modals';
import DOMPurify from 'dompurify';
import { CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import fluentLicense from './aesthetics/FLUENT-NOTICE.md?raw';
import fontLicense from './aesthetics/fonts/OFL.txt?raw';
import { subscribeIconAssets } from './aesthetics/icons/raster';
import aestheticsLicense from './aesthetics/LICENSE?raw';
import { buildAestheticsLyricsModel } from './aesthetics/lyrics-model';
import { DEFAULT_PALETTE } from './aesthetics/palette-defaults';
import stageStyles from './aesthetics/stage.module.css';
import { createStyle } from './aesthetics/styles/registry';
import {
    buildVisualLyricCues,
    getVisualLyricPosition,
    getVisualPlaybackTime,
} from './api/visual-lyrics-timeline';
import { useSynchronizedLyricsBase } from './hooks/use-synchronized-lyrics-base';
import { LyricSideVisualizer, LyricSideVisualizerSettings } from './side-visualizer';
import styles from './visual-lyrics.module.css';

import {
    useFullScreenPlayerStore,
    useSetFullScreenPlayerStore,
    VisualLyricStyle,
} from '/@/renderer/store/full-screen-player.store';
import {
    subscribePlayerSeekToTimestamp,
    subscribePlayerSpeed,
    subscribePlayerStatus,
    usePlayerStoreBase,
} from '/@/renderer/store/player.store';
import { subscribePlayerProgress, useTimestampStoreBase } from '/@/renderer/store/timestamp.store';
import { SynchronizedLyrics } from '/@/shared/types/domain-types';
import { PlayerStatus } from '/@/shared/types/types';

const STYLES: VisualLyricStyle[] = ['ship', 'shipVisual', 'fisheye', 'fisheyeVisual', 'visual'];
export const VisualLyrics = ({
    lyrics,
    offsetMs = 0,
    settingsKey = 'default',
    timingLabel,
}: {
    lyrics: SynchronizedLyrics;
    offsetMs?: number;
    settingsKey?: string;
    timingLabel?: string;
}) => {
    const { t } = useTranslation();
    const storedStyle = useFullScreenPlayerStore((state) => state.visualLyricStyle);
    const style = STYLES.includes(storedStyle) ? storedStyle : 'ship';
    const setStore = useSetFullScreenPlayerStore();
    const { handleSeek } = useSynchronizedLyricsBase(settingsKey, offsetMs);
    const stageRef = useRef<HTMLDivElement>(null);
    const viewportRef = useRef<HTMLDivElement>(null);
    const { cues, model } = useMemo(() => {
        const decoder = document.createElement('textarea');
        const sanitize = (text: string) => {
            decoder.innerHTML = DOMPurify.sanitize(text, { ALLOWED_ATTR: [], ALLOWED_TAGS: [] });
            return decoder.value;
        };
        return {
            cues: buildVisualLyricCues(lyrics).map((cue) => ({ ...cue, text: sanitize(cue.text) })),
            model: buildAestheticsLyricsModel(lyrics, sanitize),
        };
    }, [lyrics]);
    const [position, setPosition] = useState(() => getVisualLyricPosition(cues, 0));

    useEffect(() => {
        const root = stageRef.current;
        const viewport = viewportRef.current;
        if (!root || !viewport) return;
        const renderer = createStyle(
            style === 'fisheyeVisual'
                ? 'fisheye-visual'
                : style === 'shipVisual'
                  ? 'ship-visual'
                  : style,
        );
        renderer.mount(root);
        renderer.setMode('always');
        renderer.setPalette({ ...DEFAULT_PALETTE });
        renderer.setLyrics(model);
        let disposed = false;
        let width = viewport.clientWidth;
        let height = viewport.clientHeight;
        const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
        let frame: number | undefined;
        let anchorMs = useTimestampStoreBase.getState().timestamp * 1000;
        let anchorTime = performance.now();
        let { speed, status } = usePlayerStoreBase.getState().player;
        let previous = { active: false, index: -2 };
        const clock = () =>
            getVisualPlaybackTime(
                anchorMs,
                performance.now() - anchorTime,
                status === PlayerStatus.PLAYING,
                speed,
                offsetMs,
            );
        const update = () => {
            const songMs = clock();
            const next = getVisualLyricPosition(cues, songMs);
            root.hidden = cues[Math.max(0, next.index)]?.wordTimed === false;
            if (!root.hidden && width > 0 && height > 0 && !document.hidden)
                renderer.frame({
                    height,
                    // A paused seek must show a settled word without advancing song time.
                    reducedMotion: motion.matches || status !== PlayerStatus.PLAYING,
                    songMs,
                    wallMs:
                        motion.matches || status !== PlayerStatus.PLAYING ? 0 : performance.now(),
                    width,
                });
            if (next.index !== previous.index || next.active !== previous.active) {
                previous = next;
                setPosition(next);
            }
        };
        const unsubscribeIcons = subscribeIconAssets(update);
        const unsubscribeInvalidation = renderer.onInvalidate?.(update);
        const tick = () => {
            update();
            if (!document.hidden && status === PlayerStatus.PLAYING)
                frame = requestAnimationFrame(tick);
        };
        const cancel = () => {
            if (frame !== undefined) cancelAnimationFrame(frame);
            frame = undefined;
        };
        const reanchor = (timestamp: number) => {
            anchorMs = timestamp * 1000;
            anchorTime = performance.now();
            update();
        };
        const unsubscribeProgress = subscribePlayerProgress(({ timestamp }) => reanchor(timestamp));
        const unsubscribeSeek = subscribePlayerSeekToTimestamp(({ timestamp }) =>
            reanchor(timestamp),
        );
        const unsubscribeStatus = subscribePlayerStatus(({ status: nextStatus }) => {
            // Freeze the interpolated position on pause; never include paused wall time on resume.
            anchorMs = clock() - offsetMs;
            anchorTime = performance.now();
            status = nextStatus;
            cancel();
            update();
            if (status === PlayerStatus.PLAYING && !document.hidden) tick();
        });
        const unsubscribeSpeed = subscribePlayerSpeed(({ speed: nextSpeed }) => {
            anchorMs = clock() - offsetMs;
            anchorTime = performance.now();
            speed = nextSpeed;
            update();
        });
        const visibility = () => {
            cancel();
            update();
            if (status === PlayerStatus.PLAYING && !document.hidden) tick();
        };
        const resize = new ResizeObserver(() => {
            width = viewport.clientWidth;
            height = viewport.clientHeight;
            update();
        });
        resize.observe(viewport);
        document.addEventListener('visibilitychange', visibility);
        motion.addEventListener('change', update);
        void Promise.all([
            renderer.ready?.(),
            document.fonts.load('700 100px "Feishin Aesthetics Inter"'),
        ])
            .then(() => {
                if (!disposed) update();
            })
            .catch(() => {
                if (!disposed) update();
            });
        update();
        if (status === PlayerStatus.PLAYING && !document.hidden) tick();
        return () => {
            disposed = true;
            resize.disconnect();
            document.removeEventListener('visibilitychange', visibility);
            motion.removeEventListener('change', update);
            unsubscribeIcons();
            unsubscribeInvalidation?.();
            renderer.destroy();
            cancel();
            unsubscribeProgress();
            unsubscribeSeek();
            unsubscribeStatus();
            unsubscribeSpeed();
        };
    }, [cues, model, offsetMs, style]);

    const center = Math.max(0, position.index);
    const isLine = cues[center]?.wordTimed === false;
    const radius = 1;
    const visibleCues = cues.slice(Math.max(0, center - radius), center + radius + 1);
    return (
        <div className={styles.container} data-style={style}>
            <div
                aria-label={t('page.fullscreenPlayer.visualStyle')}
                className={styles.styleControls}
                role="group"
            >
                {STYLES.map((value) => (
                    <button
                        aria-pressed={style === value}
                        key={value}
                        onClick={() => setStore({ visualLyricStyle: value })}
                        type="button"
                    >
                        {t(`page.fullscreenPlayer.visualStyles.${value}`)}
                    </button>
                ))}
                <LyricSideVisualizerSettings />
            </div>
            <div
                aria-label={t('page.fullscreenPlayer.lyricVisual')}
                className={styles.stage}
                data-line={isLine}
            >
                <LyricSideVisualizer side="left" />
                <div className={styles.lyricViewport} ref={viewportRef}>
                    <div aria-hidden="true" className={stageStyles.root} ref={stageRef} />
                    <div
                        className={isLine ? styles.lineCues : styles.seekCues}
                        data-visual-controls={!isLine || undefined}
                    >
                        {visibleCues.map((cue, index) => {
                            const cueIndex = Math.max(0, center - radius) + index;
                            const distance = cueIndex - center;
                            const active = cueIndex === position.index && position.active;
                            return (
                                <button
                                    aria-current={active ? 'true' : undefined}
                                    className={styles.cue}
                                    data-active={active}
                                    data-distance={distance}
                                    data-word={cue.wordTimed}
                                    key={`${cueIndex}-${cue.startMs}`}
                                    onClick={() =>
                                        handleSeek(Math.max(0, cue.startMs - offsetMs) / 1000)
                                    }
                                    style={
                                        {
                                            '--depth': Math.abs(distance),
                                            '--distance': distance,
                                        } as CSSProperties
                                    }
                                    type="button"
                                >
                                    <span dir="auto">{cue.text}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
                <LyricSideVisualizer side="right" />
            </div>
            <div className={styles.caption} data-visual-controls>
                {timingLabel ??
                    t(
                        cues.some((cue) => cue.wordTimed)
                            ? 'page.fullscreenPlayer.visualWordTiming'
                            : 'page.fullscreenPlayer.visualLineTiming',
                    )}
                <button
                    className={styles.credits}
                    onClick={() =>
                        openModal({
                            children: (
                                <pre
                                    className={styles.license}
                                >{`${aestheticsLicense}\n\n${fluentLicense}\n\n${fontLicense}`}</pre>
                            ),
                            size: 'lg',
                            title: t('page.fullscreenPlayer.visualCredits'),
                        })
                    }
                    type="button"
                >
                    {t('page.fullscreenPlayer.visualCredits')}
                </button>
            </div>
        </div>
    );
};
