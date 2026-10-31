/* Análisis automático de pistas (estilo rekordbox): BPM y grilla, tonalidad (Camelot),
   forma de onda en 3 bandas, ganancia automática, energía y puntos de estructura. */
const Analyzer = (() => {
  const RATE = 11025;
  const PPS = 100;
  const VERSION = 2;
  const NOTES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const CAMELOT = {
    major: { C: '8B', Db: '3B', D: '10B', Eb: '5B', E: '12B', F: '7B', Gb: '2B', G: '9B', Ab: '4B', A: '11B', Bb: '6B', B: '1B' },
    minor: { C: '5A', Db: '12A', D: '7A', Eb: '2A', E: '9A', F: '4A', Gb: '11A', G: '6A', Ab: '1A', A: '8A', Bb: '3A', B: '10A' }
  };
  /* Perfiles de Krumhansl-Schmuckler */
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

  const yieldUI = () => new Promise(r => setTimeout(r, 0));

  async function analyze(buffer, onStage) {
    const stage = s => { if (onStage) onStage(s); };
    stage('bandas');
    const length = Math.ceil(buffer.duration * RATE);
    const off = new OfflineAudioContext(4, length, RATE);
    const src = off.createBufferSource();
    src.buffer = buffer;
    const merger = off.createChannelMerger(4);
    const bq = (type, f) => { const n = off.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = 0.8; return n; };
    src.connect(merger, 0, 0);
    const lowA = bq('lowpass', 200), lowB = bq('lowpass', 200); src.connect(lowA); lowA.connect(lowB); lowB.connect(merger, 0, 1);
    const midA = bq('highpass', 200), midB = bq('lowpass', 2000); src.connect(midA); midA.connect(midB); midB.connect(merger, 0, 2);
    const highA = bq('highpass', 2000), highB = bq('highpass', 2000); src.connect(highA); highA.connect(highB); highB.connect(merger, 0, 3);
    merger.connect(off.destination);
    src.start(0);
    const r = await off.startRendering();
    const mono = r.getChannelData(0), L = r.getChannelData(1), M = r.getChannelData(2), H = r.getChannelData(3);

    const lowRms = rmsBins(L), midRms = rmsBins(M), highRms = rmsBins(H), allRms = rmsBins(mono);
    const bounds = audioBounds(allRms, buffer.duration);

    stage('tempo');
    await yieldUI();
    const tempo = detectTempo(L, RATE);

    stage('tonalidad');
    const key = await detectKey(mono, RATE);

    stage('estructura');
    const ref = percentile(allRms, 0.985) || 1;   // referencia común: las bandas conservan su proporción real
    const loud = loudness(mono);
    const cues = structure(lowRms, tempo, bounds, buffer.duration);

    return {
      version: VERSION, duration: buffer.duration,
      bpm: tempo.bpm, firstBeat: tempo.firstBeat,
      key: key.name, camelot: key.camelot, keyConfidence: key.confidence,
      gainDb: loud.gainDb, energy: energyLevel(loud.rmsDb, lowRms, allRms),
      audioStart: bounds.start, audioEnd: bounds.end,
      bands: { low: toBytes(lowRms, ref), mid: toBytes(midRms, ref * 0.7), high: toBytes(highRms, ref * 0.4), all: toBytes(allRms, ref) },
      cues
    };
  }

  /* ---------- Bandas ---------- */
  function rmsBins(data) {
    const spb = RATE / PPS;
    const n = Math.ceil(data.length / spb);
    const out = new Float32Array(n);
    for (let b = 0; b < n; b++) {
      const s = Math.floor(b * spb), e = Math.min(data.length, Math.floor((b + 1) * spb));
      let acc = 0;
      for (let i = s; i < e; i++) acc += data[i] * data[i];
      out[b] = e > s ? Math.sqrt(acc / (e - s)) : 0;
    }
    return out;
  }
  function percentile(arr, p) {
    const a = Array.from(arr).filter(v => v > 0).sort((x, y) => x - y);
    return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 1;
  }
  function toBytes(rms, ref) {
    const out = new Uint8Array(rms.length);
    for (let i = 0; i < rms.length; i++) out[i] = Math.min(255, Math.round(255 * Math.pow(Math.min(1.2, rms[i] / ref), 0.75)));
    return out;
  }
  function audioBounds(rms, duration) {
    const th = Math.max(0.004, percentile(rms, 0.9) * 0.04);
    let a = 0, b = rms.length - 1;
    while (a < rms.length && rms[a] < th) a++;
    while (b > a && rms[b] < th) b--;
    return { start: Math.min(a / PPS, duration), end: Math.min((b + 1) / PPS, duration) };
  }

  /* ---------- Tempo (picos de energía en graves + coherencia de fase) ---------- */
  function detectTempo(low, sr) {
    const peaks = getPeaks(low, sr);
    if (peaks.length < 4) return { bpm: null, firstBeat: 0 };
    const coarse = coarseTempo(peaks, sr);
    if (!coarse) return { bpm: null, firstBeat: 0 };
    return refineTempo(peaks, coarse, sr);
  }
  function getPeaks(data, sr) {
    const part = Math.floor(sr * 0.5);
    const n = Math.floor(data.length / part);
    const peaks = [];
    for (let i = 0; i < n; i++) {
      let max = 0, pos = i * part;
      const end = (i + 1) * part;
      for (let j = i * part; j < end; j++) { const v = Math.abs(data[j]); if (v > max) { max = v; pos = j; } }
      if (max > 0.01) peaks.push({ pos, vol: max });
    }
    peaks.sort((a, b) => b.vol - a.vol);
    const keep = peaks.slice(0, Math.max(4, Math.floor(peaks.length * 0.5)));
    keep.sort((a, b) => a.pos - b.pos);
    return keep;
  }
  function coarseTempo(peaks, sr) {
    const votes = new Map();
    for (let i = 0; i < peaks.length; i++) {
      for (let j = i + 1; j < Math.min(peaks.length, i + 10); j++) {
        const interval = (peaks[j].pos - peaks[i].pos) / sr;
        if (interval < 0.2) continue;
        let t = 60 / interval;
        while (t < 85) t *= 2;
        while (t > 170) t /= 2;
        const k = Math.round(t);
        votes.set(k, (votes.get(k) || 0) + 1);
      }
    }
    let best = null, n = 0;
    for (const [k, c] of votes) if (c > n) { best = k; n = c; }
    return best;
  }
  function refineTempo(peaks, coarse, sr) {
    let best = coarse, bestScore = -1, bre = 1, bim = 0;
    for (let c = coarse - 1.5; c <= coarse + 1.5 + 1e-9; c += 0.02) {
      const beat = 60 / c;
      let re = 0, im = 0;
      for (const p of peaks) { const ph = 2 * Math.PI * (p.pos / sr) / beat; re += p.vol * Math.cos(ph); im += p.vol * Math.sin(ph); }
      const s = re * re + im * im;
      if (s > bestScore) { bestScore = s; best = c; bre = re; bim = im; }
    }
    const beat = 60 / best;
    let firstBeat = (Math.atan2(bim, bre) / (2 * Math.PI)) * beat;
    firstBeat = ((firstBeat % beat) + beat) % beat;
    const rounded = Math.round(best);
    return { bpm: Math.abs(best - rounded) < 0.06 ? rounded : Math.round(best * 10) / 10, firstBeat };
  }

  /* ---------- Tonalidad (cromagrama por FFT + perfiles de Krumhansl) ---------- */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = a + half;
          const vr = re[b] * cr - im[b] * ci, vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr; im[b] = im[a] - vi; re[a] += vr; im[a] += vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  async function detectKey(mono, sr) {
    const N = 4096, HOP = 2048;
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const binPc = new Int8Array(N / 2), binW = new Float32Array(N / 2);
    for (let k = 1; k < N / 2; k++) {
      const f = k * sr / N;
      if (f < 55 || f > 2500) { binPc[k] = -1; continue; }
      const midi = 12 * Math.log2(f / 440) + 69;
      binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
      binW[k] = 1 / Math.sqrt(1 + Math.max(0, midi - 48) / 24);
    }
    const chroma = new Float64Array(12);
    const re = new Float32Array(N), im = new Float32Array(N);
    let frames = 0;
    for (let start = 0; start + N <= mono.length; start += HOP) {
      let energy = 0;
      for (let i = 0; i < N; i++) { const v = mono[start + i]; re[i] = v * win[i]; im[i] = 0; energy += v * v; }
      if (energy / N < 1e-6) continue;
      fft(re, im);
      for (let k = 1; k < N / 2; k++) {
        const pc = binPc[k];
        if (pc < 0) continue;
        chroma[pc] += Math.sqrt(re[k] * re[k] + im[k] * im[k]) * binW[k];
      }
      if ((++frames & 31) === 0) await yieldUI();
    }
    if (!frames) return { name: null, camelot: null, confidence: 0 };
    let best = null, bestScore = -2, second = -2;
    for (let tonic = 0; tonic < 12; tonic++) {
      for (const mode of ['major', 'minor']) {
        const prof = mode === 'major' ? MAJOR : MINOR;
        const rot = new Array(12);
        for (let i = 0; i < 12; i++) rot[(i + tonic) % 12] = prof[i];
        const s = pearson(chroma, rot);
        if (s > bestScore) { second = bestScore; bestScore = s; best = { tonic, mode }; }
        else if (s > second) second = s;
      }
    }
    const note = NOTES[best.tonic];
    return { name: note + (best.mode === 'minor' ? 'm' : ''), camelot: CAMELOT[best.mode][note], confidence: Math.max(0, bestScore - second) };
  }
  function pearson(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }

  /* ---------- Sonoridad, ganancia automática y energía ---------- */
  function loudness(mono) {
    let acc = 0;
    for (let i = 0; i < mono.length; i++) acc += mono[i] * mono[i];
    const rms = Math.sqrt(acc / Math.max(1, mono.length));
    const rmsDb = 20 * Math.log10(rms || 1e-5);
    return { rmsDb, gainDb: Math.max(-12, Math.min(12, Math.round((-16 - rmsDb) * 10) / 10)) };
  }
  function energyLevel(rmsDb, lowRms, allRms) {
    const lowRatio = percentile(lowRms, 0.9) / (percentile(allRms, 0.9) || 1);
    const e = (rmsDb + 30) / 22 * 9 + 1 + (lowRatio - 0.5) * 2;
    return Math.max(1, Math.min(10, Math.round(e)));
  }

  /* ---------- Estructura: primer compás, drop y outro por energía de graves por compás ---------- */
  function structure(lowRms, tempo, bounds, duration) {
    if (!tempo.bpm) return { intro: bounds.start, drop: null, outro: null };
    const beat = 60 / tempo.bpm, bar = beat * 4;
    const b0 = tempo.firstBeat + Math.ceil((bounds.start - tempo.firstBeat) / beat - 1e-6) * beat;
    const bars = [];
    for (let t = b0; t + bar <= bounds.end; t += bar) {
      const s = Math.floor(t * PPS), e = Math.min(lowRms.length, Math.floor((t + bar) * PPS));
      let acc = 0;
      for (let i = s; i < e; i++) acc += lowRms[i];
      bars.push(e > s ? acc / (e - s) : 0);
    }
    if (bars.length < 4) return { intro: b0, drop: null, outro: null };
    const max = percentile(bars, 0.95) || 1;
    const hi = 0.55 * max, lo = 0.35 * max;
    let drop = -1;
    for (let i = 2; i < bars.length; i++) {
      if (bars[i] >= hi && (bars[i - 1] + bars[i - 2]) / 2 < lo) { drop = i; break; }
    }
    if (drop < 0) for (let i = 0; i < bars.length; i++) if (bars[i] >= hi) { drop = i; break; }
    let outroBar = bars.length;
    for (let i = bars.length - 1; i >= 0; i--) if (bars[i] >= hi) { outroBar = i + 1; break; }
    const outro = b0 + outroBar * bar;
    return {
      intro: b0,
      drop: drop > 0 ? b0 + drop * bar : null,
      outro: outroBar < bars.length - 1 && outro < bounds.end - bar ? outro : null
    };
  }

  /* ---------- Utilidades de tonalidad para la UI ---------- */
  function camelotColor(camelot) {
    if (!camelot) return '#555';
    const n = parseInt(camelot, 10);
    const hue = ((n - 1) * 30 + 200) % 360;
    return camelot.endsWith('A') ? 'hsl(' + hue + ' 70% 48%)' : 'hsl(' + hue + ' 90% 60%)';
  }
  function compatible(a, b) {
    if (!a || !b) return false;
    const na = parseInt(a, 10), nb = parseInt(b, 10), la = a.slice(-1), lb = b.slice(-1);
    if (na === nb) return true;
    if (la !== lb) return false;
    return (na % 12) + 1 === nb || (nb % 12) + 1 === na;
  }

  return { analyze, camelotColor, compatible, VERSION, PPS };
})();
