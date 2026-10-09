"""One-request, JSONL local forced-alignment worker. Stdout is protocol only."""

from __future__ import annotations

import contextlib
from collections import defaultdict, deque
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import traceback

SAMPLE_RATE = 16000
MAX_DURATION_SECONDS = 900
MAX_REQUEST_BYTES = 1024 * 1024
SUPPORTED_LANGUAGES = frozenset({"en", "fr", "de", "es", "it"})


class AlignmentError(ValueError):
    """Actionable input or processing failure."""


@dataclass(frozen=True)
class LyricLine:
    start_ms: float
    end_ms: float
    text: str
    alignment_text: str


@dataclass(frozen=True)
class Request:
    audio_path: Path
    ffmpeg_path: Path
    model_cache: Path
    language: str
    isolate_vocals: bool
    lines: tuple[LyricLine, ...]
    temp_root: Path | None


def finite_number(value, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise AlignmentError(f"{label} must be a finite number.")
    return float(value)


def absolute_path(value, label: str, *, existing: bool) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise AlignmentError(f"{label} must be an absolute local path.")
    path = Path(value)
    if not path.is_absolute() or value.startswith(("\\\\", "//")):
        raise AlignmentError(f"{label} must be an absolute local path.")
    if existing and not path.is_file():
        raise AlignmentError(f"{label} was not found or is not a file.")
    return path.resolve()


def validate_request(data) -> Request:
    if not isinstance(data, dict):
        raise AlignmentError("Request must be a JSON object.")
    audio = absolute_path(data.get("audioPath"), "Audio file", existing=True)
    ffmpeg = absolute_path(data.get("ffmpegPath"), "FFmpeg executable", existing=True)
    cache = absolute_path(data.get("modelCache"), "Model cache", existing=False)
    temp_root = None
    if "tempRoot" in data:
        temp_root = absolute_path(data["tempRoot"], "Temporary job directory", existing=False)
        if not temp_root.is_dir():
            raise AlignmentError("Temporary job directory must be an existing local directory.")
    if audio.stat().st_size == 0 or audio.stat().st_size > 2 * 1024**3:
        raise AlignmentError("Audio file must be nonempty and smaller than 2 GB.")
    language = data.get("language", "en")
    if not isinstance(language, str) or language not in SUPPORTED_LANGUAGES:
        raise AlignmentError("Supported alignment languages: English, French, German, Spanish, Italian.")
    isolate = data.get("isolateVocals", True)
    if not isinstance(isolate, bool):
        raise AlignmentError("isolateVocals must be a boolean.")
    raw_lines = data.get("lines")
    if not isinstance(raw_lines, list) or not 1 <= len(raw_lines) <= 2048:
        raise AlignmentError("Provide between 1 and 2048 synchronized lyric lines.")
    lines = []
    total_words = 0
    previous_start = -1.0
    for index, raw in enumerate(raw_lines):
        if not isinstance(raw, dict):
            raise AlignmentError(f"Lyric line {index + 1} must be an object.")
        start = finite_number(raw.get("startMs"), "Line start")
        end = finite_number(raw.get("endMs"), "Line end")
        text = raw.get("text")
        if not isinstance(text, str) or len(text) > 2000:
            raise AlignmentError(f"Lyric line {index + 1} has invalid text.")
        alignment_text = " ".join(text.split("_BREAK_", 1)[0].split())
        word_count = len(alignment_text.split())
        total_words += word_count
        if word_count > 1000 or total_words > 25000:
            raise AlignmentError("Lyrics exceed the 1000 words per line or 25000 words per song limit.")
        if start < 0 or start < previous_start or end <= start or end > MAX_DURATION_SECONDS * 1000:
            raise AlignmentError(f"Lyric line {index + 1} has invalid or unordered timestamps.")
        if alignment_text and end - start > 120000:
            raise AlignmentError(f"Lyric line {index + 1} spans more than two minutes; correct its line timing first.")
        previous_start = start
        lines.append(LyricLine(start, end, text, alignment_text))
    if not any(line.alignment_text for line in lines):
        raise AlignmentError("No lyric words were supplied for alignment.")
    return Request(audio, ffmpeg, cache, language, isolate, tuple(lines), temp_root)


def decode_audio(request: Request, folder: Path, sample_rate: int, channels: int):
    import numpy as np

    output = folder / f"decoded-{sample_rate}-{channels}.f32"
    command = [str(request.ffmpeg_path), "-nostdin", "-hide_banner", "-loglevel", "error",
               "-protocol_whitelist", "file,pipe", "-i", str(request.audio_path),
               "-t", str(MAX_DURATION_SECONDS + 1), "-vn", "-ac", str(channels),
               "-ar", str(sample_rate), "-f", "f32le", "-y", str(output)]
    try:
        subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                       timeout=120, check=True,
                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    except subprocess.TimeoutExpired as exc:
        raise AlignmentError("FFmpeg audio decoding exceeded two minutes.") from exc
    except (subprocess.CalledProcessError, OSError) as exc:
        # Do not expose source paths or metadata from decoder diagnostics in the UI.
        raise AlignmentError("FFmpeg could not decode the local audio file. Check its format and the FFmpeg installation.") from exc
    audio = np.fromfile(output, dtype="<f4")
    if not audio.size or audio.size % channels or not np.isfinite(audio).all():
        raise AlignmentError("The decoded audio is empty or invalid.")
    audio = audio.reshape(-1, channels).T.copy()
    if audio.shape[1] / sample_rate > MAX_DURATION_SECONDS:
        raise AlignmentError("Local word alignment supports songs up to 15 minutes long.")
    return audio


def separate_vocals(audio, device: str):
    import torch
    from demucs.apply import apply_model
    from demucs.audio import convert_audio
    from demucs.pretrained import get_model

    # Only Demucs' fixed official, hash-checked model is loaded, never a user model path.
    model = get_model("htdemucs").to(device)
    waveform = convert_audio(torch.from_numpy(audio), 44100, model.samplerate, model.audio_channels)
    reference = waveform.mean(0)
    mean, deviation = reference.mean(), reference.std()
    if not torch.isfinite(deviation) or deviation <= 1e-8:
        raise AlignmentError("Audio has no usable signal for vocal separation.")
    with torch.inference_mode():
        sources = apply_model(model, ((waveform - mean) / deviation)[None], device=device,
                              shifts=0, split=True, overlap=0.25, progress=False, num_workers=0)[0]
        vocals = sources[model.sources.index("vocals")].cpu() * deviation + mean
        result = convert_audio(vocals, model.samplerate, SAMPLE_RATE, 1)[0].numpy()
    del sources, waveform, model
    if device == "cuda":
        torch.cuda.empty_cache()
    return result


def model_word_slots(expected: list[str], result: dict) -> list[dict | None]:
    """Match model words to primary lyric tokens without reordering either sequence."""
    slots = [None] * len(expected)
    raw_words = result.get("word_segments", []) if isinstance(result, dict) else []
    if not isinstance(raw_words, list):
        return slots
    if len(raw_words) == len(expected):
        for index, (text, word) in enumerate(zip(expected, raw_words)):
            if isinstance(word, dict) and isinstance(word.get("word"), str) and word["word"].strip() == text:
                slots[index] = word
        return slots
    positions = defaultdict(deque)
    for index, text in enumerate(expected):
        positions[text].append(index)
    next_index = 0
    for word in raw_words:
        if not isinstance(word, dict) or not isinstance(word.get("word"), str):
            continue
        candidates = positions[word["word"].strip()]
        while candidates and candidates[0] < next_index:
            candidates.popleft()
        if candidates:
            index = candidates.popleft()
            slots[index] = word
            next_index = index + 1
    return slots


def model_interval(word: dict | None):
    if word is None:
        return None
    start, end = word.get("start"), word.get("end")
    if (isinstance(start, bool) or isinstance(end, bool)
            or not isinstance(start, (int, float)) or not isinstance(end, (int, float))
            or not math.isfinite(start) or not math.isfinite(end)
            or not 0 <= start < end <= MAX_DURATION_SECONDS):
        return None
    score = word.get("score")
    if score is not None and (isinstance(score, bool) or not isinstance(score, (int, float))
                              or not math.isfinite(score) or score < 0.01):
        return None
    interval = round(start * 1000), round(end * 1000)
    return interval if interval[1] > interval[0] else None


def convert_line(line: LyricLine, result: dict, index: int, duration_ms: float):
    """Keep feasible model anchors and estimate missing runs inside their bounded gaps."""
    output = {"startMs": line.start_ms, "text": line.text}
    expected = line.alignment_text.split()
    window_start = math.ceil(line.start_ms)
    window_end = math.floor(min(line.end_ms, duration_ms))
    if not expected or window_end - window_start < len(expected):
        return output, 0, 0
    intervals = [None] * len(expected)
    previous_index, previous_end = -1, window_start
    for word_index, word in enumerate(model_word_slots(expected, result)):
        interval = model_interval(word)
        if interval is None:
            continue
        start_ms, end_ms = interval
        missing_before = word_index - previous_index - 1
        remaining_words = len(expected) - word_index - 1
        # Reserve at least 1 ms per untimed token. Conflicting anchors become estimates;
        # intervals of retained anchors are never moved to make room.
        if start_ms < previous_end + missing_before or end_ms > window_end - remaining_words:
            continue
        intervals[word_index] = (start_ms, end_ms, "aligned")
        previous_index, previous_end = word_index, end_ms
    aligned_words = sum(interval is not None for interval in intervals)
    previous_end, cursor = window_start, 0
    while cursor < len(intervals):
        if intervals[cursor] is not None:
            previous_end = intervals[cursor][1]
            cursor += 1
            continue
        run_start = cursor
        while cursor < len(intervals) and intervals[cursor] is None:
            cursor += 1
        run_end = intervals[cursor][0] if cursor < len(intervals) else window_end
        count, span = cursor - run_start, run_end - previous_end
        for offset in range(count):
            intervals[run_start + offset] = (previous_end + span * offset // count,
                                              previous_end + span * (offset + 1) // count,
                                              "estimated")
    cues = [{"startMs": interval[0], "endMs": interval[1], "timingSource": interval[2],
             "text": text + " "} for text, interval in zip(expected, intervals)]
    cues[-1]["text"] = cues[-1]["text"].rstrip()
    output["cueLines"] = [{"index": index, "startMs": line.start_ms,
                           "endMs": line.end_ms, "value": line.text, "words": cues}]
    return output, aligned_words, len(cues) - aligned_words


def run_alignment(request: Request, emit):
    import torch
    import whisperx

    request.model_cache.mkdir(parents=True, exist_ok=True)
    torch.hub.set_dir(str(request.model_cache / "torch"))
    os.environ["HF_HOME"] = str(request.model_cache / "huggingface")
    import nltk
    nltk.data.path.insert(0, str(request.model_cache / "nltk"))
    os.environ["NLTK_DATA"] = str(request.model_cache / "nltk")
    try:
        nltk.data.find("tokenizers/punkt_tab")
    except LookupError:
        if not nltk.download("punkt_tab", download_dir=str(request.model_cache / "nltk"), quiet=True):
            raise AlignmentError("The alignment tokenizer could not be downloaded. Check the network connection and retry.")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    warnings = []
    if device == "cpu":
        warnings.append("CUDA is unavailable; alignment is running on CPU and may take longer.")
    emit({"type": "progress", "progress": 5, "message": "Decoding audio locally"})
    # Nest decoded audio under the caller's job directory so its cleanup also works after force cancellation.
    with tempfile.TemporaryDirectory(prefix="feishin-word-lyrics-", dir=request.temp_root) as folder:
        folder_path = Path(folder)
        if request.isolate_vocals:
            emit({"type": "progress", "progress": 10, "message": "Isolating vocals (first use downloads a model)"})
            stereo = decode_audio(request, folder_path, 44100, 2)
            try:
                audio = separate_vocals(stereo, device)
            except Exception as exc:
                # Vocal separation improves singing alignment but is optional: keep a usable original-audio path.
                traceback.print_exc(file=sys.stderr)
                warnings.append(f"Vocal isolation failed ({type(exc).__name__}); aligned against the original mix.")
                if device == "cuda":
                    torch.cuda.empty_cache()
                audio = decode_audio(request, folder_path, SAMPLE_RATE, 1)[0]
            del stereo
        else:
            audio = decode_audio(request, folder_path, SAMPLE_RATE, 1)[0]
        emit({"type": "progress", "progress": 30, "message": "Loading word alignment model (first use downloads a model)"})
        model, metadata = whisperx.load_align_model(language_code=request.language, device=device,
                                                   model_dir=str(request.model_cache / "alignment"))
        duration_ms = len(audio) * 1000 / SAMPLE_RATE
        lyrics, aligned_words, estimated_words, fallback_lines, failed_lines = [], 0, 0, 0, 0
        total_words = sum(len(line.alignment_text.split()) for line in request.lines)
        for index, line in enumerate(request.lines):
            if line.alignment_text and line.start_ms < duration_ms:
                transcript = [{"start": line.start_ms / 1000,
                               "end": min(line.end_ms, duration_ms) / 1000,
                               "text": line.alignment_text}]
                try:
                    result = whisperx.align(transcript, model, metadata, audio, device,
                                            interpolate_method="ignore", return_char_alignments=False,
                                            print_progress=False)
                except Exception:
                    # A single model inference failure can still use the existing real line window.
                    traceback.print_exc(file=sys.stderr)
                    failed_lines += 1
                    result = {}
                    if device == "cuda":
                        torch.cuda.empty_cache()
                mapped, count, estimated_count = convert_line(line, result, index, duration_ms)
            else:
                mapped, count, estimated_count = convert_line(line, {}, index, duration_ms)
            lyrics.append(mapped)
            aligned_words += count
            estimated_words += estimated_count
            if line.alignment_text and count + estimated_count == 0:
                fallback_lines += 1
            emit({"type": "progress", "progress": round(30 + 65 * (index + 1) / len(request.lines)),
                  "message": f"Aligning lyric line {index + 1} of {len(request.lines)}"})
        if not aligned_words + estimated_words:
            raise AlignmentError("No lyric words could be timed within the audio. Check the lyric line timestamps and song duration.")
        if estimated_words:
            warnings.append(f"{estimated_words} words use approximate line-based timing.")
        if fallback_lines:
            warnings.append(f"{fallback_lines} lyric lines have no usable audio window and retain line timing.")
        if failed_lines:
            warnings.append(f"{failed_lines} lyric lines could not be processed by the alignment model and use approximate timing.")
        warnings.append("Generated timings are model estimates; singing, backing vocals and incorrect line lyrics can reduce accuracy.")
        return {"type": "result", "result": {"lyrics": lyrics, "alignedWords": aligned_words,
                "estimatedWords": estimated_words, "totalWords": total_words, "warnings": warnings}}


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    protocol_stdout = sys.stdout

    def emit(event):
        protocol_stdout.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
        protocol_stdout.flush()

    try:
        raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
        if len(raw) > MAX_REQUEST_BYTES:
            raise AlignmentError("Alignment request exceeds 1 MB.")
        request = validate_request(json.loads(raw.decode("utf-8")))
        with contextlib.redirect_stdout(sys.stderr):
            result = run_alignment(request, emit)
        emit(result)
        return 0
    except (AlignmentError, json.JSONDecodeError, UnicodeDecodeError) as exc:
        emit({"type": "error", "message": str(exc)})
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit({"type": "error", "message": f"Local alignment failed ({type(exc).__name__}). Check the engine installation and model download, then retry."})
    return 1


if __name__ == "__main__":
    sys.exit(main())
