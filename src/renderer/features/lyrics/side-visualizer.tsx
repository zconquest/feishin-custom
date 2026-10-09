import type AudioMotionAnalyzer from 'audiomotion-analyzer';

import { useReducedMotion } from '@mantine/hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import styles from './side-visualizer.module.css';

import { applySideVisualizerOptions } from '/@/renderer/features/lyrics/side-visualizer-options';
import { VisualizerSettingsScope } from '/@/renderer/features/lyrics/side-visualizer-scope';
import { useWebAudio } from '/@/renderer/features/player/hooks/use-webaudio';
import { getVisualizerAudioNodes } from '/@/renderer/features/player/utils/get-visualizer-audio-nodes';
import { VisualizerSettingsForm } from '/@/renderer/features/visualizer/components/audiomotionanalyzer/visualizer-settings-form';
import { usePlaybackSettings, usePlaybackType } from '/@/renderer/store';
import {
    LyricVisualizerDirection,
    LyricVisualizerSide,
    useLyricSideVisualizerStore,
} from '/@/renderer/store/lyric-side-visualizer.store';
import { usePlayerStatus } from '/@/renderer/store/player.store';
import { useVisualizerSettings } from '/@/renderer/store/settings.store';
import { Button } from '/@/shared/components/button/button';
import { Checkbox } from '/@/shared/components/checkbox/checkbox';
import { openModal } from '/@/shared/components/modal/modal';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Slider } from '/@/shared/components/slider/slider';
import { Stack } from '/@/shared/components/stack/stack';
import { Text } from '/@/shared/components/text/text';
import { PlayerStatus } from '/@/shared/types/types';

export function LyricSideVisualizer({ side }: { side: LyricVisualizerSide }) {
    const pane = useLyricSideVisualizerStore((state) => state[side]);
    const { webAudio: enabled } = usePlaybackSettings();
    if (!pane.enabled || !enabled || !pane.visualizer) return null;
    return <SideVisualizerCanvas side={side} />;
}

export function LyricSideVisualizerSettings() {
    const { t } = useTranslation();
    return (
        <Button
            onClick={() =>
                openModal({
                    children: <SideVisualizerEditor />,
                    size: 'xl',
                    title: t('lyricVisual.sideVisualizer'),
                })
            }
            size="xs"
            variant="subtle"
        >
            {t('lyricVisual.sideVisualizer')}
        </Button>
    );
}

function SideVisualizerCanvas({ side }: { side: LyricVisualizerSide }) {
    const { t } = useTranslation();
    const pane = useLyricSideVisualizerStore((state) => state[side]);
    const settings = pane.visualizer!.audiomotionanalyzer;
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    const host = useRef<HTMLDivElement>(null);
    const container = useRef<HTMLDivElement>(null);
    const analyzer = useRef<AudioMotionAnalyzer | null>(null);
    const [size, setSize] = useState({ height: 0, width: 0 });
    const [visible, setVisible] = useState(!document.hidden);
    const [failed, setFailed] = useState(false);
    const reducedMotion = useReducedMotion();
    const { webAudio } = useWebAudio();
    const playbackType = usePlaybackType();
    const playing = usePlayerStatus() === PlayerStatus.PLAYING;
    const inputs = useMemo(
        () => getVisualizerAudioNodes(webAudio, playbackType),
        [webAudio, playbackType],
    );
    const acquireSurface = useLyricSideVisualizerStore((state) => state.actions.acquireSurface);
    const context = webAudio?.context;

    useEffect(() => {
        if (visible && !reducedMotion) return acquireSurface();
        return undefined;
    }, [acquireSurface, reducedMotion, visible]);

    useEffect(() => {
        const update = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);

    useEffect(() => {
        if (!container.current) return;
        const observer = new ResizeObserver(([entry]) => {
            setSize({ height: entry.contentRect.height, width: entry.contentRect.width });
        });
        observer.observe(container.current);
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        setFailed(false);
    }, [settings]);

    useEffect(() => {
        if (!playing || !visible || reducedMotion || failed || !context || !inputs.length) return;
        let cancelled = false;
        let owned: AudioMotionAnalyzer | undefined;
        void import('audiomotion-analyzer')
            .then(({ default: Analyzer }) => {
                if (cancelled || !host.current) return;
                try {
                    owned = new Analyzer(host.current, {
                        audioCtx: context,
                        connectSpeakers: false,
                        start: false,
                    });
                    applySideVisualizerOptions(owned, settingsRef.current);
                    for (const input of new Set(inputs)) owned.connectInput(input);
                    owned.toggleAnalyzer(true);
                    analyzer.current = owned;
                } catch (error) {
                    console.error(`Failed to start ${side} lyric visualizer:`, error);
                    owned?.destroy();
                    owned = undefined;
                    if (!cancelled) setFailed(true);
                }
            })
            .catch((error: unknown) => {
                console.error('Failed to load lyric visualizer:', error);
                if (!cancelled) setFailed(true);
            });
        return () => {
            cancelled = true;
            if (owned) {
                owned.destroy();
                if (analyzer.current === owned) analyzer.current = null;
            }
        };
    }, [context, failed, inputs, playing, reducedMotion, side, visible]);

    useEffect(() => {
        if (!analyzer.current) return;
        try {
            applySideVisualizerOptions(analyzer.current, settings);
        } catch (error) {
            console.error(`Invalid ${side} lyric visualizer settings:`, error);
            setFailed(true);
        }
    }, [settings, side]);

    const rotated = pane.direction !== 'upward';
    const inwardRotation = side === 'left' ? 90 : -90;
    const rotation = rotated ? inwardRotation * (pane.direction === 'outward' ? -1 : 1) : 0;
    return (
        <div className={styles.pane} ref={container} style={{ flexBasis: `${pane.width}%` }}>
            <div
                className={styles.canvas}
                ref={host}
                style={{
                    height: rotated ? size.width : size.height,
                    opacity: settings.opacity,
                    transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                    width: rotated ? size.height : size.width,
                }}
            />
            {(failed || reducedMotion) && (
                <Text className={styles.notice} role={failed ? 'alert' : undefined} size="xs">
                    {t(failed ? 'lyricVisual.sideError' : 'lyricVisual.sideReducedMotion')}
                </Text>
            )}
        </div>
    );
}

function SideVisualizerEditor() {
    const { t } = useTranslation();
    const [side, setSide] = useState<LyricVisualizerSide>('left');
    const pane = useLyricSideVisualizerStore((state) => state[side]);
    const actions = useLyricSideVisualizerStore((state) => state.actions);
    const global = useVisualizerSettings();
    const { webAudio } = usePlaybackSettings();
    const scope = useMemo(
        () => ({
            setSettings: (update: Parameters<typeof actions.setVisualizer>[1]) =>
                actions.setVisualizer(side, update),
            visualizer: pane.visualizer ?? { ...global, type: 'audiomotionanalyzer' as const },
        }),
        [actions, global, pane.visualizer, side],
    );

    return (
        <Stack>
            <SegmentedControl
                data={[
                    { label: t('lyricVisual.leftVisualizer'), value: 'left' },
                    { label: t('lyricVisual.rightVisualizer'), value: 'right' },
                ]}
                onChange={(value) => setSide(value as LyricVisualizerSide)}
                value={side}
            />
            <Checkbox
                checked={pane.enabled}
                disabled={!webAudio}
                label={t('lyricVisual.sideEnabled')}
                onChange={(event) =>
                    actions.setLayout(side, { enabled: event.currentTarget.checked })
                }
            />
            {!webAudio && <Text size="sm">{t('lyricVisual.sideRequiresWebAudio')}</Text>}
            <Text size="sm">
                {t('lyricVisual.sideWidth')}: {pane.width}
            </Text>
            <Slider
                max={25}
                min={5}
                onChange={(width) => actions.setLayout(side, { width })}
                value={pane.width}
            />
            <Text size="sm">{t('lyricVisual.sideDirection')}</Text>
            <SegmentedControl
                data={[
                    { label: t('lyricVisual.sideInward'), value: 'inward' },
                    { label: t('lyricVisual.sideOutward'), value: 'outward' },
                    { label: t('lyricVisual.sideUpward'), value: 'upward' },
                ]}
                onChange={(value) =>
                    actions.setLayout(side, { direction: value as LyricVisualizerDirection })
                }
                value={pane.direction}
            />
            <VisualizerSettingsScope key={side} value={scope}>
                <VisualizerSettingsForm lockAudioMotion />
            </VisualizerSettingsScope>
        </Stack>
    );
}
