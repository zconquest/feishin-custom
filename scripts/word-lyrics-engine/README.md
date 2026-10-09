# Local word alignment worker

`runner.py` reads one UTF-8 JSON object from stdin (then EOF) and writes only UTF-8 JSONL events to stdout. Module diagnostics go to stderr. This process performs forced alignment against existing synchronized lyric lines and fills missing word timings with explicitly marked approximations; it does not transcribe songs.

Request:

```json
{"audioPath":"C:/Music/song.flac","ffmpegPath":"C:/Tools/ffmpeg.exe","modelCache":"C:/Models/Feishin","language":"en","isolateVocals":true,"lines":[{"startMs":1000,"endMs":5000,"text":"Hello world"}]}
```

Events are `{ "type": "progress", "progress": 0, "message": "..." }`, `{ "type": "result", "result": { "lyrics": [], "alignedWords": 0, "estimatedWords": 0, "totalWords": 0, "warnings": [] } }`, or `{ "type": "error", "message": "..." }`. Errors exit with status 1; success exits with status 0. Counts distinguish retained model timings from rough gap subdivisions; every generated word includes `timingSource: "aligned" | "estimated"`. The main application owns downloading/caching song audio and persisting results. Cancellation must terminate the worker process tree, including FFmpeg if decoding is in progress.

The application also supplies optional `tempRoot`, an absolute existing local job directory. Decoded audio is staged inside that directory so the application's job cleanup removes it even if Python is force-terminated. Standalone requests without `tempRoot` use a normal system temporary directory and should exit normally to ensure cleanup.

Use an isolated Python 3.13 environment. Install PyTorch 2.8.0 and torchaudio 2.8.0 CUDA wheels for GPU use, then `pip install -r requirements.txt` and `pip install --no-deps whisperx==3.8.6`. WhisperX's aligner is imported lazily; ASR, diarization, faster-whisper, pyannote and torchcodec are not required. Run `python -m unittest discover -s scripts/word-lyrics-engine -v` from the repository for dependency-free checks.

Supported languages are English (`en`), French (`fr`), German (`de`), Spanish (`es`) and Italian (`it`), using WhisperX's default torchaudio models. The first run downloads the relevant alignment model and NLTK tokenizer. Optional vocal separation uses Demucs' official `htdemucs` model with its upstream hash verification, no user-supplied checkpoints. All caches are kept beneath `modelCache`. Audio stays local; FFmpeg is restricted to local file/pipe inputs. Songs are limited to 15 minutes and nonempty line windows to two minutes.

The worker passes `interpolate_method="ignore"` to WhisperX and retains feasible, finite, positive model word intervals within the real lyric/audio window. Missing word runs are distributed evenly between retained model anchors or the line boundaries, capped by the actual audio end. Anchor selection reserves at least one millisecond per missing token; a conflicting candidate becomes estimated while retained anchors stay unchanged. A wholly unmatched line receives rough word subdivisions within its real line window. Empty lines, lines outside the audio and windows too small for positive word intervals retain line timing. `_BREAK_` secondary/translated text is retained in the original line but excluded from alignment. Lyrics are limited to 1000 words per line and 25000 words per song.

CUDA is preferred, with CPU fallback when unavailable. Failed optional vocal isolation emits a warning and aligns the original mix. A per-line model inference failure emits a warning, estimates that line and continues. Global decoding or model-loading failures remain errors. Results with zero model-aligned words can succeed when approximate cues are available; a result with no usable word intervals is rejected. Warnings explicitly disclose approximate word counts. All generated timings need judgment for singing or incorrect lyric lines, and rough subdivisions do not detect sung word boundaries.

Upstream interfaces: [WhisperX 3.8.6 alignment](https://github.com/m-bain/whisperX/blob/v3.8.6/whisperx/alignment.py), [Demucs 4.0.1 model loading](https://github.com/facebookresearch/demucs/blob/v4.0.1/demucs/repo.py).
