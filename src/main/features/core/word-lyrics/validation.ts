import type {
    WordLyricsGenerationRequest,
    WordLyricsGenerationResult,
} from '/@/shared/types/word-lyrics';

const finiteTime = (value: unknown, duration: number): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= duration;

export function validateRequest(value: WordLyricsGenerationRequest) {
    if (
        !value ||
        typeof value.jobId !== 'string' ||
        !/^[\w-]{1,100}$/.test(value.jobId) ||
        !['de', 'en', 'es', 'fr', 'it'].includes(value.language) ||
        !finiteTime(value.durationMs, 900_000) ||
        value.durationMs === 0 ||
        !Array.isArray(value.lines) ||
        value.lines.length === 0 ||
        value.lines.length > 2_000
    ) {
        throw new Error(
            'Invalid alignment request. Choose a supported language and a song under 15 minutes.',
        );
    }
    let characters = 0;
    let previousStart = -1;
    for (const line of value.lines) {
        if (
            !line ||
            typeof line.text !== 'string' ||
            line.text.length > 2_000 ||
            !finiteTime(line.startMs, value.durationMs) ||
            !finiteTime(line.endMs, value.durationMs) ||
            line.endMs <= line.startMs ||
            line.startMs < previousStart ||
            (line.text.trim() && line.endMs - line.startMs > 120_000)
        ) {
            throw new Error(
                'The lyric line timings are invalid. Select synchronized lyrics first.',
            );
        }
        previousStart = line.startMs;
        characters += line.text.length;
    }
    if (characters > 100_000 || !value.lines.some((line) => line.text.trim())) {
        throw new Error('The lyric text is empty or too large to align.');
    }
    let audio: URL;
    let server: URL;
    try {
        audio = new URL(value.audioUrl);
        server = new URL(value.serverUrl);
    } catch {
        throw new Error('The music server audio address is invalid.');
    }
    if (!['http:', 'https:'].includes(audio.protocol) || audio.origin !== server.origin) {
        throw new Error('Audio must come from the configured music server.');
    }
    return audio;
}

export function validateResult(
    value: WordLyricsGenerationResult,
    request: WordLyricsGenerationRequest,
) {
    // Older installed workers have no estimate count or cue provenance.
    const estimatedWords = value?.estimatedWords === undefined ? 0 : value.estimatedWords;
    const legacyResult = value?.estimatedWords === undefined;
    const expectedWords = request.lines.reduce((count, line) => {
        const primaryText = line.text.split('_BREAK_', 1)[0].trim();
        return count + (primaryText ? primaryText.split(/\s+/).length : 0);
    }, 0);
    if (
        !value ||
        !Array.isArray(value.lyrics) ||
        value.lyrics.length !== request.lines.length ||
        !Number.isInteger(value.alignedWords) ||
        value.alignedWords < 0 ||
        !Number.isInteger(estimatedWords) ||
        estimatedWords < 0 ||
        !Number.isInteger(value.totalWords) ||
        value.totalWords < value.alignedWords + estimatedWords ||
        value.totalWords !== expectedWords ||
        value.totalWords > 25_000 ||
        !Array.isArray(value.warnings) ||
        value.warnings.length > 100 ||
        value.warnings.some((warning) => typeof warning !== 'string' || warning.length > 1_000)
    ) {
        throw new Error('The local alignment engine returned invalid lyrics.');
    }
    let alignedCount = 0;
    let estimatedCount = 0;
    value.lyrics.forEach((line, index) => {
        const original = request.lines[index];
        if (
            !line ||
            line.startMs !== original.startMs ||
            line.text !== original.text ||
            (line.cueLines !== undefined &&
                (!Array.isArray(line.cueLines) || line.cueLines.length > 1))
        ) {
            throw new Error('The local alignment engine changed the lyric text or line timing.');
        }
        for (const cue of line.cueLines ?? []) {
            const primaryText = original.text.split('_BREAK_', 1)[0].trim();
            const primaryWords = primaryText ? primaryText.split(/\s+/) : [];
            if (
                !cue ||
                cue.value !== line.text ||
                cue.index !== index ||
                cue.startMs !== original.startMs ||
                cue.endMs !== original.endMs ||
                !Array.isArray(cue.words) ||
                cue.words.length === 0 ||
                cue.words.length !== primaryWords.length ||
                cue.words.length > 1_000
            ) {
                throw new Error('The local alignment engine returned an invalid lyric cue.');
            }
            let previousEnd = original.startMs;
            for (const word of cue.words) {
                if (
                    !word ||
                    typeof word.text !== 'string' ||
                    !word.text.trim() ||
                    word.text.length > 5_000 ||
                    !finiteTime(word.startMs, original.endMs) ||
                    !finiteTime(word.endMs, original.endMs) ||
                    word.startMs < previousEnd ||
                    word.endMs <= word.startMs ||
                    (word.timingSource !== 'aligned' &&
                        word.timingSource !== 'estimated' &&
                        !(legacyResult && word.timingSource === undefined))
                ) {
                    throw new Error('The local alignment engine returned invalid word timings.');
                }
                previousEnd = word.endMs;
                if (word.timingSource === 'estimated') {
                    estimatedCount += 1;
                } else {
                    alignedCount += 1;
                }
            }
            if (cue.words.some((word, wordIndex) => word.text.trim() !== primaryWords[wordIndex])) {
                throw new Error('The local alignment engine omitted part of a lyric line.');
            }
        }
    });
    if (alignedCount !== value.alignedWords || estimatedCount !== estimatedWords) {
        throw new Error('The local alignment engine returned inconsistent word counts.');
    }
    // Only documented data crosses the bridge; engine diagnostics never reach the renderer.
    return {
        alignedWords: alignedCount,
        estimatedWords: estimatedCount,
        lyrics: value.lyrics.map((line) => ({
            ...(line.cueLines
                ? {
                      cueLines: line.cueLines.map((cue) => ({
                          endMs: cue.endMs,
                          index: cue.index,
                          startMs: cue.startMs,
                          value: cue.value,
                          words: cue.words.map((word) => ({
                              endMs: word.endMs,
                              startMs: word.startMs,
                              text: word.text,
                              timingSource: word.timingSource ?? 'aligned',
                          })),
                      })),
                  }
                : {}),
            startMs: line.startMs,
            text: line.text,
        })),
        totalWords: value.totalWords,
        warnings: value.warnings.map(safeWarning),
    };
}

function safeWarning(warning: string) {
    if (
        warning ===
            'Generated timings are model estimates; singing, backing vocals and incorrect line lyrics can reduce accuracy.' ||
        warning === 'CUDA is unavailable; alignment is running on CPU and may take longer.' ||
        /^\d{1,4} lyric lines could not be fully aligned and retain line timing\.$/.test(warning) ||
        /^\d{1,5} words use approximate line-based timing\.$/.test(warning) ||
        /^\d{1,4} lyric lines have no usable audio window and retain line timing\.$/.test(
            warning,
        ) ||
        /^\d{1,4} lyric lines could not be processed by the alignment model and use approximate timing\.$/.test(
            warning,
        )
    ) {
        return warning;
    }
    if (
        /^Vocal isolation failed \([A-Za-z]{1,80}\); aligned against the original mix\.$/.test(
            warning,
        )
    ) {
        return 'Vocal isolation was unavailable; aligned against the original mix.';
    }
    return 'The local alignment engine reported a processing limitation.';
}
