import importlib.util
from pathlib import Path
import queue
import threading
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
        self.segmenter.feed(self.silence * 43)
        self.assertEqual(self.jobs, [])
        self.segmenter.feed(self.silence)
        self.assertEqual(len(self.jobs), 1)
        self.assertTrue(self.jobs[0]['audio'].startswith(self.speech * 30))
        self.assertEqual(len(self.jobs[0]['audio']), len(self.speech) * 30 + 5120)
        self.segmenter.commit()
        self.assertEqual(len(self.jobs), 1)

    def test_one_second_mid_sentence_pause_does_not_dispatch(self):
        self.segmenter.feed(self.speech * 30)
        self.segmenter.feed(self.silence * 32)
        self.assertEqual(self.jobs, [])
        self.segmenter.feed(self.speech * 30)
        self.segmenter.feed(self.silence * 44)
        self.assertEqual(len(self.jobs), 1)
        self.assertIn(self.speech * 30 + self.silence * 32 + self.speech * 30, self.jobs[0]['audio'])

    def test_push_to_talk_waits_for_release_across_long_pauses(self):
        self.segmenter.begin()
        audio = self.speech * 30 + self.silence * 100 + self.speech * 30
        self.segmenter.feed(audio)
        self.assertEqual(self.jobs, [])
        self.segmenter.commit()
        self.assertEqual(len(self.jobs), 1)
        self.assertEqual(self.jobs[0]['audio'], audio)
        self.segmenter.commit()
        self.assertEqual(len(self.jobs), 1)
        self.segmenter.feed(self.speech * 30 + self.silence * 44)
        self.assertEqual(len(self.jobs), 2)

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

    def enable_predecode(self):
        self.provisional = []
        self.cancellations = []
        self.segmenter.predecode = self.provisional.append
        self.segmenter.cancel_predecode = lambda: self.cancellations.append(True)

    def test_predecode_has_identical_pcm_but_cannot_end_turn_early(self):
        self.enable_predecode()
        self.segmenter.feed(self.speech * 30 + self.silence * 15)
        self.assertEqual(len(self.provisional), 1)
        self.assertEqual(self.jobs, [])
        self.assertEqual([event['type'] for event in self.events], ['speech_start'])
        self.segmenter.feed(self.silence * 29)
        self.assertEqual(self.jobs, self.provisional)

    def test_resumed_speech_invalidates_once_attempted_predecode(self):
        self.enable_predecode()
        self.segmenter.feed(self.speech * 30 + self.silence * 20)
        self.assertEqual(len(self.provisional), 1)
        self.segmenter.feed(self.speech * 30)
        self.assertTrue(self.cancellations)
        self.segmenter.feed(self.silence * 44)
        self.assertEqual(len(self.provisional), 1)
        self.assertEqual(len(self.jobs), 1)
        self.assertNotEqual(self.jobs[0]['audio'], self.provisional[0]['audio'])
        self.assertIn(self.speech * 30 + self.silence * 20 + self.speech * 30, self.jobs[0]['audio'])

    def test_predecode_skips_manual_turns_noise_and_short_endpoints(self):
        self.enable_predecode()
        self.segmenter.begin()
        self.segmenter.feed(self.speech * 30 + self.silence * 100)
        self.assertEqual(self.provisional, [])
        self.segmenter.commit()
        self.segmenter.feed(self.speech + self.silence * 44)
        self.assertEqual(self.provisional, [])
        self.segmenter.silence_samples = worker.FRAME_SAMPLES * 10
        self.segmenter.feed(self.speech * 30 + self.silence * 10)
        self.assertEqual(self.provisional, [])

    def test_predecode_budget_resets_for_next_utterance_and_can_be_disabled(self):
        self.enable_predecode()
        self.segmenter.feed((self.speech * 30 + self.silence * 44) * 2)
        self.assertEqual(len(self.provisional), 2)
        self.segmenter.predecode_samples = 0
        self.segmenter.feed(self.speech * 30 + self.silence * 44)
        self.assertEqual(len(self.provisional), 2)
        self.assertEqual(len(self.jobs), 3)


class SchedulerTest(unittest.TestCase):
    def setUp(self):
        self.calls = queue.Queue()
        self.events = queue.Queue()
        self.releases = []
        self.fail_next = False

        def transcribe(audio, cancelled):
            release = threading.Event()
            self.releases.append(release)
            self.calls.put((audio, cancelled, release))
            if not release.wait(3):
                raise RuntimeError('Test did not release transcription')
            if self.fail_next:
                self.fail_next = False
                raise RuntimeError('Test decode failure')
            return audio.decode('ascii')

        self.scheduler = worker.TranscriptionScheduler(transcribe, self.events.put)
        self.thread = threading.Thread(target=self.scheduler.run, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.scheduler.close()
        for release in self.releases:
            release.set()
        self.thread.join(3)
        self.assertFalse(self.thread.is_alive())

    def payload(self, audio=b'complete', utterance_id=1):
        return {'audio': audio, 'utterance_id': utterance_id, 't0': 0.0, 't1': 1.0}

    def wait_complete(self):
        with self.scheduler.condition:
            self.assertTrue(self.scheduler.condition.wait_for(lambda: self.scheduler.active is None, timeout=3))

    def test_completed_provisional_result_is_private_until_identical_commit(self):
        payload = self.payload()
        self.scheduler.prepare(payload)
        _, _, release = self.calls.get(timeout=3)
        release.set()
        self.wait_complete()
        self.assertEqual(self.events.get(timeout=3), {'type': 'provisional', 'text': 'complete', 'utterance_id': 1})
        self.assertTrue(self.events.empty())
        self.scheduler.submit(dict(payload))
        self.scheduler.cancel_predecode()
        self.assertEqual(self.events.get(timeout=3), {'type': 'final', 'text': 'complete', 'utterance_id': 1, 't0': 0.0, 't1': 1.0})
        self.assertTrue(self.calls.empty())
        self.assertTrue(self.events.empty())

    def test_in_flight_result_is_promoted_without_second_decode(self):
        payload = self.payload()
        self.scheduler.prepare(payload)
        _, cancelled, release = self.calls.get(timeout=3)
        self.scheduler.submit(dict(payload))
        self.scheduler.cancel_predecode()
        self.assertFalse(cancelled.is_set())
        release.set()
        self.assertEqual(self.events.get(timeout=3)['text'], 'complete')
        self.assertTrue(self.calls.empty())

    def test_resumed_speech_cancels_stale_result_and_decodes_full_request(self):
        self.scheduler.prepare(self.payload(b'prefix'))
        _, cancelled, release = self.calls.get(timeout=3)
        self.scheduler.cancel_predecode()
        self.assertTrue(cancelled.is_set())
        self.scheduler.submit(self.payload(b'prefix and continuation'))
        release.set()
        audio, _, final_release = self.calls.get(timeout=3)
        self.assertEqual(audio, b'prefix and continuation')
        self.assertTrue(self.events.empty())
        final_release.set()
        self.assertEqual(self.events.get(timeout=3)['text'], 'prefix and continuation')
        self.assertTrue(self.events.empty())

    def test_even_identical_text_audio_is_not_reused_across_utterances(self):
        self.scheduler.prepare(self.payload())
        _, cancelled, release = self.calls.get(timeout=3)
        self.scheduler.submit(self.payload(utterance_id=2))
        self.assertTrue(cancelled.is_set())
        release.set()
        _, _, final_release = self.calls.get(timeout=3)
        final_release.set()
        self.assertEqual(self.events.get(timeout=3)['utterance_id'], 2)

    def test_speculative_failure_falls_back_to_authoritative_decode(self):
        self.fail_next = True
        self.scheduler.prepare(self.payload())
        _, _, release = self.calls.get(timeout=3)
        release.set()
        self.wait_complete()
        self.assertTrue(self.events.empty())
        self.assertFalse(self.scheduler.stopped.is_set())
        self.scheduler.submit(self.payload())
        _, _, final_release = self.calls.get(timeout=3)
        final_release.set()
        self.assertEqual(self.events.get(timeout=3)['type'], 'final')

    def test_queue_is_bounded_and_speculation_never_displaces_confirmed_work(self):
        self.scheduler.submit(self.payload(utterance_id=1))
        _, _, release = self.calls.get(timeout=3)
        self.scheduler.submit(self.payload(utterance_id=2))
        self.scheduler.submit(self.payload(utterance_id=3))
        self.scheduler.prepare(self.payload(b'provisional', utterance_id=4))
        self.assertIsNone(self.scheduler.provisional)
        with self.assertRaisesRegex(RuntimeError, 'queue is full'):
            self.scheduler.submit(self.payload(utterance_id=4))
        self.scheduler.close()
        release.set()
        self.thread.join(3)
        self.assertTrue(self.events.empty())

    def test_confirmed_failure_is_fatal_and_empty_transcript_is_no_speech(self):
        self.scheduler.submit(self.payload(b''))
        _, _, release = self.calls.get(timeout=3)
        release.set()
        self.assertEqual(self.events.get(timeout=3)['type'], 'no_speech')
        self.fail_next = True
        self.scheduler.submit(self.payload())
        _, _, release = self.calls.get(timeout=3)
        release.set()
        event = self.events.get(timeout=3)
        self.assertEqual(event['type'], 'error')
        self.assertTrue(event['fatal'])
        self.assertTrue(self.scheduler.stopped.is_set())


if __name__ == '__main__':
    unittest.main()