import {
    useFullScreenPlayerStore,
    usePlaybackSettings,
    useShowVisualizerInSidebar,
} from '/@/renderer/store';
import { useLyricSideVisualizerStore } from '/@/renderer/store/lyric-side-visualizer.store';

export function useIsLocalVisualizerSurfaceVisible(): boolean {
    const { webAudio: webAudioEnabled } = usePlaybackSettings();
    const showVisualizerInSidebar = useShowVisualizerInSidebar();
    const { activeTab, expanded, visualizerExpanded, visualizerPresentation } =
        useFullScreenPlayerStore();
    const sideEnabled = useLyricSideVisualizerStore((state) => state.activeSurfaces > 0);

    const sidebarVisualizer = showVisualizerInSidebar && webAudioEnabled;
    const fullScreenPlayerVisualizerTab = expanded && activeTab === 'visualizer' && webAudioEnabled;
    const fullScreenVisualizerOverlay =
        visualizerExpanded &&
        webAudioEnabled &&
        (visualizerPresentation === 'visualizer' || sideEnabled);

    return sidebarVisualizer || fullScreenPlayerVisualizerTab || fullScreenVisualizerOverlay;
}
