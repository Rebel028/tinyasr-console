// Mic capture: downsample the context rate to 16 kHz mono and post 40 ms PCM16 frames.
const OUT_RATE = 16000;
const FRAME = 640; // 40 ms at 16 kHz

class Pcm16Downsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / OUT_RATE; // input samples per output sample
    this.pos = 0; // fractional read position into the pending input
    this.pending = new Float32Array(0);
    this.out = new Int16Array(FRAME);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const buf = new Float32Array(this.pending.length + ch.length);
    buf.set(this.pending);
    buf.set(ch, this.pending.length);

    // Box-average each output window: a cheap low-pass that keeps aliasing down for speech.
    while (this.pos + this.step <= buf.length) {
      const a = Math.floor(this.pos), b = Math.floor(this.pos + this.step);
      let sum = 0;
      for (let i = a; i < b; i++) sum += buf[i];
      const v = Math.max(-1, Math.min(1, sum / Math.max(1, b - a)));
      this.out[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      this.pos += this.step;
      if (this.n === FRAME) {
        this.port.postMessage(this.out.buffer, [this.out.buffer]);
        this.out = new Int16Array(FRAME);
        this.n = 0;
      }
    }
    const keep = Math.floor(this.pos);
    this.pending = buf.slice(keep);
    this.pos -= keep;
    return true;
  }
}

registerProcessor("pcm16-downsampler", Pcm16Downsampler);
