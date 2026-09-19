import argparse
import base64
import collections
import json
import queue
import sys
import threading


SAMPLE_RATE = 16000
FRAME_SAMPLES = 512
FRAME_BYTES = FRAME_SAMPLES * 2
MAX_SAMPLES = SAMPLE_RATE * 55


class SpeechSegmenter:
    def __init__(self, probability, submit, emit, silence_ms=1400):
        self.probability = probability
        self.submit = submit
        self.emit = emit
        self.silence_samples = int(SAMPLE_RATE * silence_ms / 1000)
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
            self.emit({'type': 'error', 'message': 'Long utterance reached the STT cap. Please repeat a shorter complete request.', 'fatal': False})
        elif not self.manual and self.silent_samples >= self.silence_samples:
            self.finish()

    def finish(self):
        if self.audio is not None and self.speech_samples >= FRAME_SAMPLES * 3:
            trim_samples = max(0, self.silent_samples - int(SAMPLE_RATE * 0.16))
            audio = bytes(self.audio[:len(self.audio) - trim_samples * 2])
            job = {'audio': audio, 'utterance_id': self.utterance_id,
                   't0': self.start_sample / SAMPLE_RATE,
                   't1': (self.start_sample + len(audio) // 2) / SAMPLE_RATE}
            self.emit({'type': 'decoding', 'utterance_id': self.utterance_id})
            self.submit(job)
        elif self.audio is not None or self.overlong:
            self.emit({'type': 'no_speech', 'utterance_id': self.utterance_id})
        self.clear()

    def clear(self):
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


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--language', default='auto')
    parser.add_argument('--silence-ms', type=int, default=1400)
    args = parser.parse_args()
    if not 1 <= args.threads <= 128 or not 200 <= args.silence_ms <= 3000:
        raise ValueError('Invalid Whisper thread count or silence threshold')

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
    stopped = threading.Event()
    jobs = queue.Queue(maxsize=2)

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

    def submit(job):
        try:
            jobs.put_nowait(job)
        except queue.Full:
            raise RuntimeError('Whisper transcription queue is full. Reconnect voice and use shorter requests.') from None

    def decode():
        while not stopped.is_set():
            job = jobs.get()
            if job is None:
                return
            try:
                audio = np.frombuffer(job.pop('audio'), dtype='<i2').astype(np.float32) / 32768.0
                segments, _ = model.transcribe(audio, language=None if args.language == 'auto' else args.language,
                                               beam_size=5, temperature=0.0, condition_on_previous_text=False,
                                               vad_filter=False, word_timestamps=False)
                text = ' '.join(segment.text.strip() for segment in segments).strip()
                emit({'type': 'final' if text else 'no_speech', 'text': text, **job})
            except Exception as error:
                stopped.set()
                emit({'type': 'error', 'message': f'Whisper transcription failed: {error}', 'fatal': True})

    warm_segments, _ = model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), language='en',
                                       beam_size=1, temperature=0.0, condition_on_previous_text=False)
    list(warm_segments)
    probability(bytes(FRAME_BYTES))
    decoder = threading.Thread(target=decode, daemon=True)
    decoder.start()
    segmenter = SpeechSegmenter(probability, submit, emit, args.silence_ms)
    emit({'type': 'ready', 'model': 'small', 'compute_type': model.model.compute_type})
    try:
        while not stopped.is_set():
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
        stopped.set()


if __name__ == '__main__':
    try:
        run()
    except Exception as error:
        print(json.dumps({'type': 'error', 'message': f'Whisper failed: {error}', 'fatal': True}), flush=True)
        sys.exit(1)