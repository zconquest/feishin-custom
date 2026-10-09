"""Dependency-free tests for input validation, cue conversion and protocol isolation."""

import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import runner


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.folder = Path(self.temporary.name)
        audio, ffmpeg = self.folder / "song.flac", self.folder / "ffmpeg.exe"
        audio.write_bytes(b"audio")
        ffmpeg.write_bytes(b"executable")
        self.request = {"audioPath": str(audio), "ffmpegPath": str(ffmpeg),
                        "modelCache": str(self.folder / "models"),
                        "lines": [{"startMs": 1000, "endMs": 5000, "text": "Hello world"}]}

    def test_validation_normalizes_primary_lyrics_and_retains_original(self):
        self.request["lines"][0]["text"] = " Hello  world _BREAK_Translation text"
        line = runner.validate_request(self.request).lines[0]
        self.assertEqual(line.alignment_text, "Hello world")
        self.assertIn("_BREAK_", line.text)

    def test_rejects_missing_file_and_remote_paths(self):
        for path in ["relative.flac", "https://example.test/music", "//server/share/song.flac",
                     str(self.folder / "missing.flac")]:
            with self.subTest(path=path), self.assertRaises(runner.AlignmentError):
                runner.validate_request({**self.request, "audioPath": path})

    def test_rejects_invalid_language_and_line_timing(self):
        for language in ["auto", "xx", [], None]:
            with self.subTest(language=language), self.assertRaises(runner.AlignmentError):
                runner.validate_request({**self.request, "language": language})
        for start, end in [(True, 5000), (float("nan"), 5000), (-1, 5000), (6000, 5000), (0, 900001)]:
            with self.subTest(start=start), self.assertRaises(runner.AlignmentError):
                runner.validate_request({**self.request, "lines": [{"startMs": start, "endMs": end, "text": "hello"}]})

    def test_temporary_job_directory_requires_existing_local_directory(self):
        request = runner.validate_request({**self.request, "tempRoot": str(self.folder)})
        self.assertEqual(request.temp_root, self.folder.resolve())
        self.assertIsNone(runner.validate_request(self.request).temp_root)
        for root in [str(self.folder / "missing"), self.request["audioPath"], "relative", "//server/jobs"]:
            with self.subTest(root=root), self.assertRaises(runner.AlignmentError):
                runner.validate_request({**self.request, "tempRoot": root})

    def test_actual_complete_words_become_domain_cues(self):
        line = runner.validate_request(self.request).lines[0]
        result = {"word_segments": [{"word": "Hello", "start": 1.25, "end": 2, "score": .8},
                                    {"word": "world", "start": 2.1, "end": 3, "score": .7}]}
        mapped, count, estimates = runner.convert_line(line, result, 7, 8000)
        self.assertEqual((count, estimates), (2, 0))
        self.assertEqual(mapped["startMs"], 1000)
        self.assertEqual(mapped["cueLines"][0]["index"], 7)
        self.assertEqual(mapped["cueLines"][0]["words"][0],
                         {"startMs": 1250, "endMs": 2000, "text": "Hello ", "timingSource": "aligned"})

    def test_missing_or_invalid_timing_is_estimated_without_losing_valid_anchor(self):
        line = runner.validate_request(self.request).lines[0]
        first = {"word": "Hello", "start": 1.25, "end": 2, "score": .8}
        invalid_seconds = [
            {"word": "world"}, {"word": "world", "start": 2, "end": 2},
            {"word": "world", "start": 1.9, "end": 3},
            {"word": "world", "start": 4, "end": 6},
            {"word": "world", "start": float("nan"), "end": 3},
            {"word": "world", "start": 2, "end": 3, "score": 0},
            {"word": "changed", "start": 2, "end": 3},
        ]
        for second in invalid_seconds:
            with self.subTest(second=second):
                mapped, count, estimates = runner.convert_line(line, {"word_segments": [first, second]}, 0, 8000)
                self.assertEqual((count, estimates), (1, 1))
                words = mapped["cueLines"][0]["words"]
                self.assertEqual((words[0]["startMs"], words[0]["endMs"]), (1250, 2000))
                self.assertEqual(words[0]["timingSource"], "aligned")
                self.assertEqual(words[1], {"startMs": 2000, "endMs": 5000, "text": "world", "timingSource": "estimated"})

    def test_prefix_middle_and_suffix_gaps_preserve_model_anchors(self):
        line = runner.LyricLine(1000, 5000, "a b c d e", "a b c d e")
        result = {"word_segments": [{"word": "a"}, {"word": "b", "start": 1.7, "end": 1.8},
                                    {"word": "c"}, {"word": "d", "start": 2.5, "end": 3}, {"word": "e"}]}
        mapped, aligned, estimated = runner.convert_line(line, result, 0, 6000)
        self.assertEqual((aligned, estimated), (2, 3))
        self.assertEqual([(word["startMs"], word["endMs"]) for word in mapped["cueLines"][0]["words"]],
                         [(1000, 1700), (1700, 1800), (1800, 2500), (2500, 3000), (3000, 5000)])

    def test_crowded_anchor_is_demoted_to_keep_positive_missing_word_intervals(self):
        line = runner.LyricLine(1000, 5000, "a b c", "a b c")
        result = {"word_segments": [{"word": "a", "start": 1, "end": 2}, {"word": "b"},
                                    {"word": "c", "start": 2, "end": 3}]}
        mapped, aligned, estimated = runner.convert_line(line, result, 0, 6000)
        self.assertEqual((aligned, estimated), (1, 2))
        self.assertEqual([(word["startMs"], word["endMs"]) for word in mapped["cueLines"][0]["words"]],
                         [(1000, 2000), (2000, 3500), (3500, 5000)])
        result["word_segments"][0]["end"] = 5
        mapped, aligned, estimated = runner.convert_line(line, result, 0, 6000)
        self.assertEqual((aligned, estimated), (1, 2))
        self.assertEqual(mapped["cueLines"][0]["words"][2]["timingSource"], "aligned")

    def test_failed_line_estimates_are_capped_by_actual_audio_end(self):
        line = runner.validate_request(self.request).lines[0]
        mapped, aligned, estimated = runner.convert_line(line, {}, 0, 2500.9)
        self.assertEqual((aligned, estimated), (0, 2))
        self.assertEqual(mapped["cueLines"][0]["words"][-1]["endMs"], 2500)
        self.assertEqual(mapped["cueLines"][0]["endMs"], 5000)

    def test_empty_outside_audio_and_impossible_windows_keep_line_fallback(self):
        for line, duration in [(runner.LyricLine(0, 1000, "", ""), 1000),
                               (runner.LyricLine(1000, 2000, "hello", "hello"), 1000),
                               (runner.LyricLine(1000, 1002, "a b c", "a b c"), 2000)]:
            with self.subTest(line=line):
                mapped, aligned, estimated = runner.convert_line(line, {}, 0, duration)
                self.assertNotIn("cueLines", mapped)
                self.assertEqual((aligned, estimated), (0, 0))

    def test_short_model_word_list_preserves_monotonic_matching_anchors(self):
        line = runner.LyricLine(0, 5000, "a b c", "a b c")
        mapped, aligned, estimated = runner.convert_line(
            line, {"word_segments": [{"word": "b", "start": 1, "end": 2}]}, 0, 5000)
        self.assertEqual((aligned, estimated), (1, 2))
        self.assertEqual(mapped["cueLines"][0]["words"][1]["timingSource"], "aligned")

    def test_translation_primary_only_receives_estimated_words(self):
        self.request["lines"][0]["text"] = " Hello  world _BREAK_Bonjour monde"
        line = runner.validate_request(self.request).lines[0]
        mapped, aligned, estimated = runner.convert_line(line, {}, 0, 5000)
        self.assertEqual((aligned, estimated), (0, 2))
        self.assertEqual(mapped["text"], line.text)
        self.assertEqual([word["text"].strip() for word in mapped["cueLines"][0]["words"]], ["Hello", "world"])

    def test_protocol_keeps_external_stdout_off_json_stream(self):
        class Input:
            buffer = io.BytesIO(json.dumps(self.request).encode())
        output, errors = io.StringIO(), io.StringIO()
        def fake_alignment(request, emit):
            print("third-party model loading output")
            emit({"type": "progress", "progress": 30, "message": "Loading"})
            return {"type": "result", "result": {"lyrics": [], "alignedWords": 2, "totalWords": 2, "warnings": []}}
        with patch("sys.stdin", Input()), patch("sys.stdout", output), patch("sys.stderr", errors), \
                patch.object(runner, "run_alignment", fake_alignment):
            self.assertEqual(runner.main(), 0)
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual([event["type"] for event in events], ["progress", "result"])
        self.assertIn("third-party", errors.getvalue())

    def test_invalid_json_outputs_error_and_failure_status(self):
        class Input:
            buffer = io.BytesIO(b"bad JSON")
        output = io.StringIO()
        with patch("sys.stdin", Input()), patch("sys.stdout", output):
            self.assertEqual(runner.main(), 1)
        self.assertEqual(json.loads(output.getvalue())["type"], "error")

    def test_alignment_uses_real_model_output_and_estimates_unmatched_lines(self):
        self.request["isolateVocals"] = False
        self.request["lines"].append({"startMs": 5000, "endMs": 8000, "text": "Missing timing"})
        request = runner.validate_request({**self.request, "tempRoot": str(self.folder)})
        torch, nltk, whisperx = Mock(), Mock(), Mock()
        torch.cuda.is_available.return_value = False
        whisperx.load_align_model.return_value = ("model", "metadata")
        whisperx.align.side_effect = [
            {"word_segments": [{"word": "Hello", "start": 1.25, "end": 2},
                                {"word": "world", "start": 2.1, "end": 3}]},
            {"word_segments": [{"word": "Missing"}, {"word": "timing"}]},
        ]
        events = []
        def decode_in_owned_directory(request, folder, sample_rate, channels):
            self.assertEqual(folder.parent, self.folder.resolve())
            self.assertTrue(folder.is_dir())
            return [range(160000)]
        with patch.dict("sys.modules", {"torch": torch, "nltk": nltk, "whisperx": whisperx}), \
                patch.object(runner, "decode_audio", side_effect=decode_in_owned_directory):
            result = runner.run_alignment(request, events.append)["result"]
        self.assertEqual((result["alignedWords"], result["estimatedWords"], result["totalWords"]), (2, 2, 4))
        self.assertEqual(result["lyrics"][1]["cueLines"][0]["words"][0]["timingSource"], "estimated")
        self.assertIn("2 words use approximate line-based timing.", result["warnings"])
        self.assertEqual(whisperx.align.call_args.kwargs["interpolate_method"], "ignore")
        self.assertEqual(events[-1]["progress"], 95)

    def test_all_unmatched_lines_succeed_with_honest_estimated_counts(self):
        self.request["isolateVocals"] = False
        torch, nltk, whisperx = Mock(), Mock(), Mock()
        torch.cuda.is_available.return_value = False
        whisperx.load_align_model.return_value = ("model", "metadata")
        whisperx.align.return_value = {"word_segments": []}
        with patch.dict("sys.modules", {"torch": torch, "nltk": nltk, "whisperx": whisperx}), \
                patch.object(runner, "decode_audio", return_value=[range(160000)]):
            result = runner.run_alignment(runner.validate_request(self.request), lambda event: None)["result"]
        self.assertEqual((result["alignedWords"], result["estimatedWords"]), (0, 2))

    def test_per_line_model_exception_continues_and_estimates_failed_line(self):
        self.request["isolateVocals"] = False
        self.request["lines"].append({"startMs": 5000, "endMs": 8000, "text": "Next line"})
        torch, nltk, whisperx = Mock(), Mock(), Mock()
        torch.cuda.is_available.return_value = False
        whisperx.load_align_model.return_value = ("model", "metadata")
        whisperx.align.side_effect = [RuntimeError("line inference failed"),
            {"word_segments": [{"word": "Next", "start": 5.1, "end": 6},
                                {"word": "line", "start": 6.1, "end": 7}]}]
        with patch.dict("sys.modules", {"torch": torch, "nltk": nltk, "whisperx": whisperx}), \
                patch.object(runner, "decode_audio", return_value=[range(160000)]), \
                patch("sys.stderr", io.StringIO()):
            result = runner.run_alignment(runner.validate_request(self.request), lambda event: None)["result"]
        self.assertEqual((result["alignedWords"], result["estimatedWords"]), (2, 2))
        self.assertEqual(whisperx.align.call_count, 2)
        self.assertIn("1 lyric lines could not be processed by the alignment model and use approximate timing.", result["warnings"])

    def test_global_model_failure_still_fails(self):
        self.request["isolateVocals"] = False
        torch, nltk, whisperx = Mock(), Mock(), Mock()
        torch.cuda.is_available.return_value = False
        whisperx.load_align_model.side_effect = RuntimeError("model unavailable")
        with patch.dict("sys.modules", {"torch": torch, "nltk": nltk, "whisperx": whisperx}), \
                patch.object(runner, "decode_audio", return_value=[range(160000)]), \
                self.assertRaisesRegex(RuntimeError, "model unavailable"):
            runner.run_alignment(runner.validate_request(self.request), lambda event: None)

    def test_no_usable_audio_window_fails_instead_of_success_with_empty_cues(self):
        self.request["isolateVocals"] = False
        torch, nltk, whisperx = Mock(), Mock(), Mock()
        torch.cuda.is_available.return_value = False
        whisperx.load_align_model.return_value = ("model", "metadata")
        with patch.dict("sys.modules", {"torch": torch, "nltk": nltk, "whisperx": whisperx}), \
                patch.object(runner, "decode_audio", return_value=[range(100)]), \
                self.assertRaisesRegex(runner.AlignmentError, "No lyric words could be timed"):
            runner.run_alignment(runner.validate_request(self.request), lambda event: None)


if __name__ == "__main__":
    unittest.main()
