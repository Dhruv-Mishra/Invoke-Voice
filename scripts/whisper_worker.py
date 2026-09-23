import argparse
import base64
import collections
import json
import sys
import threading


SAMPLE_RATE = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
MAX_SAMPLES = SAMPLE_RATE * 55


class SpeechSegmenter:
    def __init__(self, probability, submit, emit, silence_ms=1400,
                 predecode=None, cancel_predecode=None, predecode_ms=480):
        self.probability = probability
        self.submit = submit
        self.emit = emit
        self.silence_samples = int(SAMPLE_RATE * silence_ms / 1000)
        self.predecode = predecode
        self.cancel_predecode = cancel_predecode
        self.predecode_samples = int(SAMPLE_RATE * predecode_ms / 1000)
        self.predecode_attempted = False
        self.pending = bytearray()
        self.preroll = collections.deque(maxlen=8)
        self.samples = 0
        self.utterance_id = 0
        self.audio = None
        self.speech_samples = 0
        self.silent_samples = 0
        self.overlong = False
        self.start_sample = 0
        self.manual = False

    def feed(self, pcm):
        if len(pcm) % 2:
            raise ValueError('PCM must contain complete 16-bit samples')
        self.pending.extend(pcm)
        while len(self.pending) >= FRAME_BYTES:
            frame = bytes(self.pending[:FRAME_BYTES])
            del self.pending[:FRAME_BYTES]
            self.process(frame)

    def process(self, frame):
        self.samples += FRAME_SAMPLES
        probability = self.probability(frame)
        self.preroll.append(frame)
        speaking = probability >= (0.35 if self.audio is not None or self.overlong else 0.5)
        self.silent_samples = 0 if speaking else self.silent_samples + FRAME_SAMPLES
        if speaking and self.predecode_attempted and self.cancel_predecode:
            self.cancel_predecode()
        if self.overlong:
            if not self.manual and self.silent_samples >= self.silence_samples:
                self.finish()
            return
        if self.audio is None:
            if not speaking:
                return
            self.utterance_id += 1
            self.audio = bytearray(b''.join(self.preroll))
            self.start_sample = self.samples - len(self.audio) // 2
            self.speech_samples = FRAME_SAMPLES
            self.emit({'type': 'speech_start', 'utterance_id': self.utterance_id})
        else:
            self.audio.extend(frame)
            if speaking:
                self.speech_samples += FRAME_SAMPLES
        if len(self.audio) // 2 > MAX_SAMPLES:
            self.audio = None
            self.overlong = True
            if self.cancel_predecode:
                self.cancel_predecode()
            self.emit({'type': 'error', 'message': 'Long utterance reached the STT cap. Please repeat a shorter complete request.', 'fatal': False})
        elif not self.manual and self.silent_samples >= self.silence_samples:
            self.finish()
        elif (not self.manual and self.predecode and not self.predecode_attempted
              and self.predecode_samples > 0 and self.silent_samples >= self.predecode_samples
              and self.speech_samples >= FRAME_SAMPLES * 3):
            self.predecode_attempted = True
            self.predecode(self.snapshot())

    def snapshot(self):
        trim_samples = max(0, self.silent_samples - int(SAMPLE_RATE * 0.16))
        audio = bytes(self.audio[:len(self.audio) - trim_samples * 2])
        return {'audio': audio, 'utterance_id': self.utterance_id,
                't0': self.start_sample / SAMPLE_RATE,
                't1': (self.start_sample + len(audio) // 2) / SAMPLE_RATE}

    def finish(self):
        if self.audio is not None and self.speech_samples >= FRAME_SAMPLES * 3:
            job = self.snapshot()
            self.emit({'type': 'decoding', 'utterance_id': self.utterance_id})
            self.submit(job)
        elif self.audio is not None or self.overlong:
            self.emit({'type': 'no_speech', 'utterance_id': self.utterance_id})
        self.clear()

    def clear(self):
        if self.cancel_predecode:
            self.cancel_predecode()
        self.predecode_attempted = False
        self.audio = None
        self.speech_samples = 0
        self.silent_samples = 0
        self.overlong = False
        self.preroll.clear()

    def begin(self):
        self.clear()
        self.pending.clear()
        self.manual = True

    def commit(self):
        if self.pending:
            frame = bytes(self.pending).ljust(FRAME_BYTES, b'\0')
            self.pending.clear()
            self.process(frame)
        self.finish()
        self.manual = False


class DecodeJob:
    def __init__(self, payload, committed=False):
        self.payload = payload
        self.committed = committed
        self.cancelled = threading.Event()
        self.complete = False
        self.text = ''
        self.error = None


class TranscriptionScheduler:
    def __init__(self, transcribe, emit):
        self.transcribe = transcribe
        self.emit = emit
        self.condition = threading.Condition()
        self.pending = collections.deque()
        self.active = None
        self.provisional = None
        self.stopped = threading.Event()

    def prepare(self, payload):
        with self.condition:
            if self.stopped.is_set() or self.active or self.pending or self.provisional:
                return
            self.provisional = DecodeJob(payload)
            self.pending.append(self.provisional)
            self.condition.notify()

    def cancel_predecode(self):
        with self.condition:
            if self.provisional:
                self.provisional.cancelled.set()
                if self.provisional in self.pending:
                    self.pending.remove(self.provisional)
                self.provisional = None

    def submit(self, payload):
        with self.condition:
            if self.stopped.is_set():
                raise RuntimeError('Whisper decoder has stopped. Reconnect voice.')
            candidate = self.provisional
            if candidate and candidate.payload == payload and candidate.error is None:
                candidate.committed = True
                self.provisional = None
                if candidate.complete:
                    self.publish(candidate)
                return
            self.cancel_predecode()
            if len(self.pending) >= 2:
                raise RuntimeError('Whisper transcription queue is full. Reconnect voice and use shorter requests.')
            self.pending.append(DecodeJob(payload, committed=True))
            self.condition.notify()

    def publish(self, job):
        metadata = {key: value for key, value in job.payload.items() if key != 'audio'}
        self.emit({'type': 'final' if job.text else 'no_speech', 'text': job.text, **metadata})

    def run(self):
        while not self.stopped.is_set():
            with self.condition:
                self.condition.wait_for(lambda: self.pending or self.stopped.is_set())
                if self.stopped.is_set():
                    return
                job = self.pending.popleft()
                self.active = job
            try:
                job.text = self.transcribe(job.payload['audio'], job.cancelled)
            except Exception as error:
                job.error = error
            with self.condition:
                job.complete = True
                self.active = None
                if job.cancelled.is_set():
                    continue
                if job.committed:
                    if job.error is not None:
                        self.close()
                        self.emit({'type': 'error', 'message': f'Whisper transcription failed: {job.error}', 'fatal': True})
                    else:
                        self.publish(job)
                elif job.error is None and job.text:
                    self.emit({'type': 'provisional', 'text': job.text, 'utterance_id': job.payload['utterance_id']})
                self.condition.notify_all()

    def close(self):
        with self.condition:
            self.stopped.set()
            self.cancel_predecode()
            if self.active:
                self.active.cancelled.set()
            self.pending.clear()
            self.condition.notify_all()


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--language', default='en')
    parser.add_argument('--silence-ms', type=int, default=1400)
    parser.add_argument('--predecode-ms', type=int, default=480)
    args = parser.parse_args()
    if not 1 <= args.threads <= 128 or not 200 <= args.silence_ms <= 3000:
        raise ValueError('Invalid Whisper thread count or silence threshold')
    if args.predecode_ms != 0 and not 160 <= args.predecode_ms <= 3000:
        raise ValueError('Whisper predecode pause must be 0 (off) or 160 to 3000 ms')

    import numpy as np
    from faster_whisper import WhisperModel
    from faster_whisper.vad import get_vad_model

    model = WhisperModel(args.model, device='cpu', compute_type='int8',
                         cpu_threads=args.threads, num_workers=1, local_files_only=True)
    vad = get_vad_model()
    hidden = np.zeros((1, 1, 128), dtype=np.float32)
    cell = np.zeros((1, 1, 128), dtype=np.float32)
    context = np.zeros(64, dtype=np.float32)
    output_lock = threading.Lock()

    def emit(event):
        with output_lock:
            print(json.dumps(event, ensure_ascii=True), flush=True)

    def probability(frame):
        nonlocal hidden, cell, context
        audio = np.frombuffer(frame, dtype='<i2').astype(np.float32) / 32768.0
        inputs = np.concatenate((context, audio))[None, :]
        output, hidden, cell = vad.session.run(None, {'input': inputs, 'h': hidden, 'c': cell})
        context = audio[-64:]
        return float(output.reshape(-1)[0])

    def transcribe(pcm, cancelled):
        if cancelled.is_set():
            return ''
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
        segments, _ = model.transcribe(audio, language=None if args.language == 'auto' else args.language,
                                       beam_size=5, temperature=0.0, condition_on_previous_text=False,
                                       vad_filter=False, word_timestamps=False)
        if cancelled.is_set():
            return ''
        parts = []
        for segment in segments:
            if cancelled.is_set():
                return ''
            parts.append(segment.text.strip())
        return ' '.join(parts).strip()

    warm_segments, _ = model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language='en',
                                       beam_size=1, temperature=0.0, condition_on_previous_text=False)
    list(warm_segments)
    probability(bytes(FRAME_BYTES))
    scheduler = TranscriptionScheduler(transcribe, emit)
    decoder = threading.Thread(target=scheduler.run, daemon=True)
    decoder.start()
    segmenter = SpeechSegmenter(probability, scheduler.submit, emit, args.silence_ms,
                                scheduler.prepare, scheduler.cancel_predecode, args.predecode_ms)
    emit({'type': 'ready', 'model': 'small', 'compute_type': model.model.compute_type})
    try:
        while not scheduler.stopped.is_set():
            line = sys.stdin.buffer.readline(45001)
            if not line:
                break
            if len(line) > 45000 or not line.endswith(b'\n'):
                raise ValueError('Whisper input frame exceeded its limit')
            event = json.loads(line)
            if event.get('type') == 'begin':
                segmenter.begin()
            elif event.get('type') == 'commit':
                segmenter.commit()
            elif event.get('type') == 'audio':
                pcm = base64.b64decode(event['data'], validate=True)
                if len(pcm) > 30000:
                    raise ValueError('Whisper PCM frame exceeded its limit')
                segmenter.feed(pcm)
            else:
                raise ValueError('Unsupported Whisper input event')
    finally:
        scheduler.close()


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        print(json.dumps({'type': 'error', 'message': f'Whisper failed: {error}', 'fatal': True}), flush=True)
        sys.exit(1)