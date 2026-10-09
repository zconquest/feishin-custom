import { z } from 'zod';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import {
    SettingsSlice,
    SettingsState,
    useSettingsStore,
    VisualizerSettingsSchema,
} from '/@/renderer/store/settings.store';

export type LyricVisualizerDirection = 'inward' | 'outward' | 'upward';
export type LyricVisualizerSide = 'left' | 'right';
export type SideVisualizerSettings = z.infer<typeof SideSchema>;

const SideSchema = z
    .object({
        direction: z.enum(['inward', 'outward', 'upward']),
        enabled: z.boolean(),
        visualizer: VisualizerSettingsSchema.nullable(),
        width: z.number().finite().min(5).max(25),
    })
    .refine((side) => !side.enabled || side.visualizer !== null);

const initialSide = (): SideVisualizerSettings => ({
    direction: 'inward',
    enabled: false,
    visualizer: null,
    width: 15,
});

type SideVisualizerState = {
    actions: {
        acquireSurface: () => () => void;
        disableAll: () => void;
        setLayout: (
            side: LyricVisualizerSide,
            patch: Partial<Pick<SideVisualizerSettings, 'direction' | 'enabled' | 'width'>>,
        ) => void;
        setVisualizer: (
            side: LyricVisualizerSide,
            update: Parameters<SettingsSlice['actions']['setSettings']>[0],
        ) => void;
    };
    activeSurfaces: number;
    left: SideVisualizerSettings;
    right: SideVisualizerSettings;
};

function snapshot(visualizer: SettingsState['visualizer']): SettingsState['visualizer'] {
    return structuredClone({ ...visualizer, type: 'audiomotionanalyzer' });
}

export const useLyricSideVisualizerStore = create<SideVisualizerState>()(
    persist(
        (set) => ({
            actions: {
                acquireSurface: () => {
                    set((state) => ({ activeSurfaces: state.activeSurfaces + 1 }));
                    let released = false;
                    return () => {
                        if (released) return;
                        released = true;
                        set((state) => ({ activeSurfaces: Math.max(0, state.activeSurfaces - 1) }));
                    };
                },
                disableAll: () =>
                    set((state) => ({
                        left: { ...state.left, enabled: false },
                        right: { ...state.right, enabled: false },
                    })),
                setLayout: (side, patch) =>
                    set((state) => {
                        const current = state[side];
                        const next = SideSchema.parse({
                            ...current,
                            ...patch,
                            visualizer:
                                current.visualizer ??
                                (patch.enabled
                                    ? snapshot(useSettingsStore.getState().visualizer)
                                    : null),
                            width:
                                patch.width === undefined
                                    ? current.width
                                    : Math.min(25, Math.max(5, patch.width)),
                        });
                        return { [side]: next };
                    }),
                setVisualizer: (side, update) =>
                    set((state) => {
                        const current = state[side];
                        const base =
                            current.visualizer ?? snapshot(useSettingsStore.getState().visualizer);
                        // Form updates replace complete preset/gradient arrays rather than merging indices.
                        const visualizer = VisualizerSettingsSchema.parse({
                            ...base,
                            audiomotionanalyzer: {
                                ...base.audiomotionanalyzer,
                                ...update.visualizer?.audiomotionanalyzer,
                            },
                            type: 'audiomotionanalyzer',
                        });
                        return { [side]: { ...current, visualizer: structuredClone(visualizer) } };
                    }),
            },
            activeSurfaces: 0,
            left: initialSide(),
            right: initialSide(),
        }),
        {
            merge: (persisted, current) => {
                const saved = persisted as Record<string, unknown> | undefined;
                const recover = (side: LyricVisualizerSide) => {
                    const parsed = SideSchema.safeParse(saved?.[side]);
                    if (!parsed.success) return initialSide();
                    return {
                        ...parsed.data,
                        visualizer: parsed.data.visualizer
                            ? snapshot(parsed.data.visualizer)
                            : null,
                    };
                };
                return { ...current, left: recover('left'), right: recover('right') };
            },
            name: 'store_lyric_side_visualizers',
            partialize: ({ left, right }) => ({ left, right }),
            version: 1,
        },
    ),
);
