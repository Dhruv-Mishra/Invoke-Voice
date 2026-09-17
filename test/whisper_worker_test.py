import importlib.util
from pathlib import Path
import unittest


spec = importlib.util.spec_from_file_location('whisper_worker', Path(__file__).resolve().parents[1] / 'scripts' / 'whisper_worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SegmenterTest(unittest.TestCase):
    def setUp(self):
        self.jobs = []
        self.events = []
        self.segmenter = worker.SpeechSegmenter(lambda frame: 0.9 if frame[0] else 0.0,
                                                self.jobs.append, self.events.append)
        self.speech = b'\x01\x00' * worker.FRAME_SAMPLES
        self.silence = bytes(worker.FRAME_BYTES)

    def test_silence_is_bounded_and_never_transcribed(self):
        for _ in range(2000):
            self.segmenter.feed(self.silence)
        self.segmenter.commit()
        self.assertEqual(self.jobs, [])
        self.assertEqual(self.events, [])
        self.assertLessEqual(len(self.segmenter.preroll), 8)

    def test_short_command_commits_once_without_waiting_for_silence(self):
        self.segmenter.feed(self.silence * 20)
        self.segmenter.feed(self.speech * 6)
        self.segmenter.commit()
        self.segmenter.commit()
        self.assertEqual(len(self.jobs), 1)
        self.assertTrue(self.jobs[0]['audio'].endswith(self.speech * 6))
        self.assertEqual([event['type'] for event in self.events], ['speech_start', 'decoding'])

    def test_partial_pcm_frames_and_short_pauses_preserve_words(self):
        audio = self.speech * 8 + self.silence * 8 + self.speech * 8
        for offset in range(0, len(audio), 640):
            self.segmenter.feed(audio[offset:offset + 640])
        self.segmenter.commit()
        self.assertEqual(len(self.jobs), 1)
        self.assertEqual(self.jobs[0]['audio'], audio)

    def test_hands_free_endpoint_has_padding_and_no_duplicate_commit(self):
        self.segmenter.feed(self.speech * 30)
        self.segmenter.feed(self.silence * 20)
        self.assertEqual(self.jobs, [])
        self.segmenter.feed(self.silence)
        self.assertEqual(len(self.jobs), 1)
        self.assertTrue(self.jobs[0]['audio'].startswith(self.speech * 30))
        self.assertEqual(len(self.jobs[0]['audio']), len(self.speech) * 30 + 5120)
        self.segmenter.commit()
        self.assertEqual(len(self.jobs), 1)

    def test_clicks_and_overlong_speech_never_dispatch_truncated_commands(self):
        self.segmenter.feed(self.speech)
        self.segmenter.commit()
        self.assertEqual(self.jobs, [])
        for _ in range(1800):
            self.segmenter.feed(self.speech)
        self.segmenter.commit()
        self.assertEqual(self.jobs, [])
        self.assertEqual(len([event for event in self.events if event['type'] == 'error']), 1)
        self.segmenter.feed(self.speech * 10)
        self.segmenter.commit()
        self.assertEqual(len(self.jobs), 1)

    def test_rejects_incomplete_samples(self):
        with self.assertRaises(ValueError):
            self.segmenter.feed(b'\x01')


if __name__ == '__main__':
    unittest.main()