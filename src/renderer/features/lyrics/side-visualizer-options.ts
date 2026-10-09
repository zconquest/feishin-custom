import type AudioMotionAnalyzer from 'audiomotion-analyzer';
import type { GradientOptions, Options } from 'audiomotion-analyzer';

import omit from 'lodash/omit';

import { SettingsState } from '/@/renderer/store/settings.store';

type AnalyzerSettings = SettingsState['visualizer']['audiomotionanalyzer'];

export function applySideVisualizerOptions(
    analyzer: AudioMotionAnalyzer,
    settings: AnalyzerSettings,
) {
    const registered = new Set(['classic', 'orangered', 'prism', 'rainbow', 'steelblue']);
    for (const gradient of settings.customGradients) {
        const config: GradientOptions = {
            colorStops: gradient.colorStops.map((stop) => ({
                color: stop.color,
                ...(stop.levelEnabled && stop.level !== undefined ? { level: stop.level } : {}),
                ...(stop.positionEnabled && stop.pos !== undefined ? { pos: stop.pos } : {}),
            })),
            ...(gradient.dir === 'h' ? { dir: 'h' as const } : {}),
        };
        analyzer.registerGradient(gradient.name, config);
        registered.add(gradient.name);
    }
    const safeGradient = (name: string | undefined) =>
        name && registered.has(name) ? name : 'classic';
    const rest = omit(settings, ['customGradients', 'opacity', 'presets', 'weightingFilter']);
    const { weightingFilter } = settings;
    const options: Options = {
        ...rest,
        bgAlpha: 0,
        gradient: safeGradient(settings.gradient),
        gradientLeft: safeGradient(settings.gradientLeft),
        gradientRight: safeGradient(settings.gradientRight),
        maxFPS: settings.maxFPS > 0 ? Math.min(60, settings.maxFPS) : 60,
        overlay: true,
        showBgColor: false,
        // AMA treats Z weighting as an unweighted spectrum.
        weightingFilter: weightingFilter === 'Z' ? '' : weightingFilter,
    };
    analyzer.setOptions(options);
}
