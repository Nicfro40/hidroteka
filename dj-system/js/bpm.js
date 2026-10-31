/* Detección de BPM por picos de energía en graves (filtro pasa bajos + histograma de intervalos). */
const BPMDetector = (() => {
  const RATE = 11025;

  async function analyze(buffer) {
    const length = Math.ceil(buffer.duration * RATE);
    if (length < RATE * 4) return { bpm: null, firstBeat: 0 };
    const off = new OfflineAudioContext(1, length, RATE);
    const src = off.createBufferSource();
    src.buffer = buffer;
    const lp = off.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 160;
    lp.Q.value = 1;
    src.connect(lp);
    lp.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    const data = rendered.getChannelData(0);
    const peaks = getPeaks(data, RATE);
    if (peaks.length < 4) return { bpm: null, firstBeat: 0 };
    const coarse = getTempo(peaks, RATE);
    if (!coarse) return { bpm: null, firstBeat: 0 };
    const { bpm, firstBeat } = refine(peaks, coarse, RATE);
    return { bpm, firstBeat };
  }

  /* Pico más fuerte por cada medio segundo; conservamos la mitad más alta. */
  function getPeaks(data, sr) {
    const part = Math.floor(sr * 0.5);
    const n = Math.floor(data.length / part);
    const peaks = [];
    for (let i = 0; i < n; i++) {
      let max = 0, pos = i * part;
      const end = (i + 1) * part;
      for (let j = i * part; j < end; j++) {
        const v = Math.abs(data[j]);
        if (v > max) { max = v; pos = j; }
      }
      if (max > 0.01) peaks.push({ pos, vol: max });
    }
    peaks.sort((a, b) => b.vol - a.vol);
    const keep = peaks.slice(0, Math.max(4, Math.floor(peaks.length * 0.5)));
    keep.sort((a, b) => a.pos - b.pos);
    return keep;
  }

  /* Vota por el tempo implícito en cada par de picos cercanos, normalizado a 85–170 BPM. */
  function getTempo(peaks, sr) {
    const votes = new Map();
    const samples = [];
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < Math.min(peaks.length, i + 10); j++) {
        const interval = (peaks[j].pos - peaks[i].pos) / sr;
        if (interval < 0.2) continue;
        let tempo = 60 / interval;
        while (tempo < 85) tempo *= 2;
        while (tempo > 170) tempo /= 2;
        const key = Math.round(tempo);
        votes.set(key, (votes.get(key) || 0) + 1);
        samples.push(tempo);
      }
    }
    let best = null, bestCount = 0;
    for (const [k, c] of votes) if (c > bestCount) { best = k; bestCount = c; }
    if (best === null) return null;
    const near = samples.filter(t => Math.abs(t - best) <= 1).sort((a, b) => a - b);
    const median = near.length ? near[Math.floor(near.length / 2)] : best;
    const rounded = Math.round(median);
    return Math.abs(median - rounded) < 0.15 ? rounded : Math.round(median * 10) / 10;
  }

  /* Afina el tempo alrededor del candidato buscando la máxima coherencia de fase de los picos
     (suma vectorial de e^(2πi·t/beat)); el ángulo del vector ganador da la fase del primer beat. */
  function refine(peaks, coarse, sr) {
    let best = coarse, bestScore = -1, bestRe = 1, bestIm = 0;
    for (let c = coarse - 1.5; c <= coarse + 1.5 + 1e-9; c += 0.02) {
      const beat = 60 / c;
      let re = 0, im = 0;
      for (const p of peaks) {
        const ph = 2 * Math.PI * (p.pos / sr) / beat;
        re += p.vol * Math.cos(ph);
        im += p.vol * Math.sin(ph);
      }
      const score = re * re + im * im;
      if (score > bestScore) { bestScore = score; best = c; bestRe = re; bestIm = im; }
    }
    const beat = 60 / best;
    let firstBeat = (Math.atan2(bestIm, bestRe) / (2 * Math.PI)) * beat;
    firstBeat = ((firstBeat % beat) + beat) % beat;
    const rounded = Math.round(best);
    const bpm = Math.abs(best - rounded) < 0.06 ? rounded : Math.round(best * 10) / 10;
    return { bpm, firstBeat };
  }

  return { analyze };
})();
