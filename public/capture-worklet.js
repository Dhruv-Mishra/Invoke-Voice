// AudioWorklet for 16kHz mono PCM16 recording and resampling
class CaptureWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.chunkDurationMs = 60; // 60ms chunks = 960 samples at 16kHz
    this.targetChunkSize = Math.floor((this.targetSampleRate * this.chunkDurationMs) / 1000);
    this.buffer = new Int16Array(this.targetChunkSize);
    this.bufferIndex = 0;
    this.resamplePhase = 0;
    this.lastSample = 0;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'flush') {
        this.flush();
        this.port.postMessage({ type: 'flushed' });
      } else if (event.data?.type === 'reset') {
        this.bufferIndex = 0;
      }
    };
  }

  flush() {
    if (this.bufferIndex > 0) {
      const slice = this.buffer.slice(0, this.bufferIndex);
      this.port.postMessage({ type: 'audio', audioData: slice.buffer, samples: this.bufferIndex, flushed: true }, [slice.buffer]);
      this.bufferIndex = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true;
    }

    const channelData = input[0];
    const inputSampleRate = sampleRate; // global inside AudioWorklet
    const ratio = inputSampleRate / this.targetSampleRate;

    let sumSquares = 0;
    let peak = 0;

    for (let i = 0; i < channelData.length; i++) {
      const absVal = Math.abs(channelData[i]);
      if (absVal > peak) peak = absVal;
      sumSquares += channelData[i] * channelData[i];
    }
    const rms = Math.sqrt(sumSquares / channelData.length);
    this.port.postMessage({ type: 'level', rms, peak });

    let inIdx = this.resamplePhase;
    while (inIdx < channelData.length) {
      const i0 = Math.floor(inIdx);
      const frac = inIdx - i0;
      const s0 = i0 >= 0 ? channelData[i0] : this.lastSample;
      const s1 = (i0 + 1 < channelData.length) ? channelData[i0 + 1] : s0;
      const interp = s0 + (s1 - s0) * frac;

      // Clamping float32 to PCM16
      const clamped = Math.max(-1, Math.min(1, interp));
      const pcm16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.buffer[this.bufferIndex++] = Math.round(pcm16);

      if (this.bufferIndex >= this.targetChunkSize) {
        const out = this.buffer.slice(0, this.targetChunkSize);
        this.port.postMessage({ type: 'audio', audioData: out.buffer, samples: this.targetChunkSize }, [out.buffer]);
        this.bufferIndex = 0;
      }

      inIdx += ratio;
    }

    this.resamplePhase = inIdx - channelData.length;
    this.lastSample = channelData[channelData.length - 1];
    return true;
  }
}

registerProcessor('capture-worklet', CaptureWorkletProcessor);
