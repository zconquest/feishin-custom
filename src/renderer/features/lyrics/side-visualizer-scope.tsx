import { createContext, ReactNode, useContext } from 'react';

import {
    SettingsSlice,
    SettingsState,
    useSettingsStoreActions,
    useVisualizerSettings,
} from '/@/renderer/store/settings.store';

type VisualizerScope = {
    setSettings: SettingsSlice['actions']['setSettings'];
    visualizer: SettingsState['visualizer'];
};

const ScopeContext = createContext<null | VisualizerScope>(null);

export const VisualizerSettingsScope = ({
    children,
    value,
}: {
    children: ReactNode;
    value: VisualizerScope;
}) => <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;

export function useScopedVisualizerActions() {
    const global = useSettingsStoreActions();
    return useContext(ScopeContext) ?? global;
}

export function useScopedVisualizerSettings() {
    const global = useVisualizerSettings();
    return useContext(ScopeContext)?.visualizer ?? global;
}
