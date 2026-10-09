import type {
    NetEaseWordLyricsGetRequest,
    NetEaseWordLyricsResult,
    NetEaseWordLyricsSearchRequest,
    NetEaseWordLyricsSong,
    WordLyricsGenerationRequest,
    WordLyricsGenerationResult,
    WordLyricsProgress,
    WordLyricsStatus,
} from '/@/shared/types/word-lyrics';

import { ipcRenderer } from 'electron';

export const wordLyrics = {
    cancel: (jobId: string): Promise<void> => ipcRenderer.invoke('word-lyrics-cancel', jobId),
    cancelNetEase: (requestId: string): Promise<void> =>
        ipcRenderer.invoke('word-lyrics-netease-cancel', requestId),
    generate: (request: WordLyricsGenerationRequest): Promise<WordLyricsGenerationResult> =>
        ipcRenderer.invoke('word-lyrics-generate', request),
    getNetEase: (request: NetEaseWordLyricsGetRequest): Promise<NetEaseWordLyricsResult> =>
        ipcRenderer.invoke('word-lyrics-netease-get', request),
    onProgress: (callback: (progress: WordLyricsProgress) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, progress: WordLyricsProgress) =>
            callback(progress);
        ipcRenderer.on('word-lyrics-progress', listener);
        return () => ipcRenderer.removeListener('word-lyrics-progress', listener);
    },
    searchNetEase: (request: NetEaseWordLyricsSearchRequest): Promise<NetEaseWordLyricsSong[]> =>
        ipcRenderer.invoke('word-lyrics-netease-search', request),
    status: (): Promise<WordLyricsStatus> => ipcRenderer.invoke('word-lyrics-status'),
};
