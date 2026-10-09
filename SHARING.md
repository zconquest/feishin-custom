# Setup and optional local timing engine

## Playback and visual lyrics

Install the Windows build, add a supported music server, and sign in. The recipient needs their own server account. This package contains no music or profile data.

Word timings can come from supported lyric providers or imported timing files. Approximate timings are labeled as estimates. For side visualizers, enable Web Audio playback and configure each side from the fullscreen lyric viewer. MPV playback requires a separately installed MPV executable and may request Windows system-audio capture permission.

## Optional generation of local word timings

The worker aligns supplied synchronized lyric lines to audio; it does not transcribe songs. Python, PyTorch, FFmpeg, and model downloads are installed separately. This setup can consume several GB and takes longer on CPU.

1. Install Python 3.13 and FFmpeg. Create a dedicated Python virtual environment.
2. Using that environment's Python, install PyTorch 2.8.0 and torchaudio 2.8.0 (matching CPU or CUDA wheels), the included resources/word-lyrics-engine/requirements.txt, then whisperx==3.8.6 with --no-deps.
3. Close Feishin Custom and register the environment:

~~~powershell
powershell -ExecutionPolicy Bypass -File "C:\path\to\Feishin Custom\resources\Register-Word-Lyrics-Runtime.ps1" -PythonPath "C:\path\to\venv\Scripts\python.exe" -FfmpegPath "C:\path\to\ffmpeg.exe"
~~~

The script validates Python dependencies and FFmpeg, creates a per-user model cache, and writes runtime paths specific to this computer. Restart Feishin Custom afterward.

The first generation may download the official torchaudio alignment model, NLTK tokenizer, and optional Demucs vocal-separation model. Supported languages: English, French, German, Spanish, Italian. See the worker README for exact requirements and timing limitations.

## Updates

Download updates manually from this private repository's Releases page. Do not use an official Feishin updater on this custom build.
