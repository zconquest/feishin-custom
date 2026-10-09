import { useFullScreenPlayerStore, useSettingsStore } from '/@/renderer/store';
import { useLyricSideVisualizerStore } from '/@/renderer/store/lyric-side-visualizer.store';

export function closeLocalVisualizerSurfaces(): void {
    const fullScreen = useFullScreenPlayerStore.getState();
    fullScreen.actions.setStore({
        ...(fullScreen.expanded && fullScreen.activeTab === 'visualizer'
            ? { activeTab: 'queue' as const }
            : {}),
        ...(fullScreen.visualizerPresentation === 'visualizer'
            ? {
                  visualizerExpanded: false,
                  visualizerReturnToPlayer: false,
              }
            : {}),
    });

    useSettingsStore.getState().actions.setSettings({
        general: { showVisualizerInSidebar: false },
    });
    useLyricSideVisualizerStore.getState().actions.disableAll();
}
