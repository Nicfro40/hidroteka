/* Deck: reproducción, cue, hot cues, loops, pitch, sync, efectos y dibujo de ondas en 3 bandas. */
const HOT_COLORS = ['#ff3b5c', '#9ef01a', '#3ec5ff', '#c77dff'];
const WAVE_COLORS = { low: '#2f6df6', mid: '#f59e0b', high: '#f5f7ff' };

function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
}
function fmtTime(s, withTenths) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), t = Math.floor((s % 1) * 10);
  return m + ':' + String(sec).padStart(2, '0') + (withTenths ? '.' + t : '');
}
function computePeaks(buffer, perSec) {
  const bins = Math.ceil(buffer.duration * perSec);
  const spb = buffer.sampleRate / perSec;
  const peaks = new Float32Array(bins);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const d = buffer.getChannelData(ch);
    for (let b = 0; b < bins; b++) {
      const start = Math.floor(b * spb), end = Math.min(d.length, Math.floor((b + 1) * spb));
      let m = 0;
      for (let i = start; i < end; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > m) m = v; }
      if (m > peaks[b]) peaks[b] = m;
    }
  }
  return peaks;
}

class Deck {
  constructor(id, mount, opts = {}) {
    this.id = id;
    this.ctx = Engine.ctx;
    this.color = opts.color || '#19c4ff';
    this.keyHint = opts.keyHint || '';
    this.onLoadRequest = opts.onLoadRequest || (() => {});
    this.onBpmEdit = opts.onBpmEdit || (() => {});
    this.onNotice = opts.onNotice || (() => {});
    this.onPlay = opts.onPlay || (() => {});
    this.onEnded = opts.onEnded || (() => {});
    this.getOther = opts.getOther || (() => null);
    this.PPS = 100;
    this.ZOOM_SECONDS = 8;
    this.PITCH_RANGE = 16;

    this.track = null; this.buffer = null; this.peaks = null; this.bands = null; this.duration = 0;
    this.status = 'empty';
    this.playing = false; this.pausedPos = 0; this.startPos = 0; this.startCtxTime = 0;
    this.source = null;
    this.pitch = 0; this.bend = 0; this.rate = 1;
    this.cuePoint = 0; this.previewing = false;
    this.hotCues = [null, null, null, null];
    this.loop = { active: false, start: 0, end: 0, inPoint: null };
    this.bpm = null; this.firstBeat = 0; this.audioStart = 0; this.audioEnd = 0;
    this.overviewCache = null;
    this.vu = { level: 0, peak: 0, hold: 0 };

    this._buildGraph();
    this._buildUI(mount, opts.zoomMount);
  }

  /* ---------------- Grafo de audio ---------------- */
  _buildGraph() {
    const c = this.ctx;
    this.autoGain = c.createGain();
    this.eqLow = c.createBiquadFilter(); this.eqLow.type = 'lowshelf'; this.eqLow.frequency.value = 250;
    this.eqMid = c.createBiquadFilter(); this.eqMid.type = 'peaking'; this.eqMid.frequency.value = 1000; this.eqMid.Q.value = 0.9;
    this.eqHigh = c.createBiquadFilter(); this.eqHigh.type = 'highshelf'; this.eqHigh.frequency.value = 4000;
    this.filter = c.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.frequency.value = 20000; this.filter.Q.value = 0.7;
    this.preFx = c.createGain();
    this.delay = c.createDelay(2.0); this.delay.delayTime.value = 0.375;
    this.delayFilter = c.createBiquadFilter(); this.delayFilter.type = 'lowpass'; this.delayFilter.frequency.value = 3500;
    this.delayFb = c.createGain(); this.delayFb.gain.value = 0.45;
    this.delayWet = c.createGain(); this.delayWet.gain.value = 0;
    this.convolver = c.createConvolver(); this.convolver.buffer = Engine.makeImpulse(2.2, 3.5);
    this.reverbWet = c.createGain(); this.reverbWet.gain.value = 0;
    this.fxSum = c.createGain();
    this.trim = c.createGain();
    this.fader = c.createGain();
    this.xf = c.createGain();
    this.analyser = c.createAnalyser(); this.analyser.fftSize = 256;
    this.vuData = new Uint8Array(this.analyser.fftSize);
    this.input = this.autoGain;

    this.autoGain.connect(this.eqLow);
    this.eqLow.connect(this.eqMid); this.eqMid.connect(this.eqHigh); this.eqHigh.connect(this.filter);
    this.filter.connect(this.preFx);
    this.preFx.connect(this.fxSum);
    this.preFx.connect(this.delay); this.delay.connect(this.delayFilter); this.delayFilter.connect(this.delayFb);
    this.delayFb.connect(this.delay); this.delay.connect(this.delayWet); this.delayWet.connect(this.fxSum);
    this.preFx.connect(this.convolver); this.convolver.connect(this.reverbWet); this.reverbWet.connect(this.fxSum);
    this.fxSum.connect(this.trim); this.trim.connect(this.fader); this.fader.connect(this.xf);
    this.xf.connect(Engine.master);
    this.fader.connect(this.analyser);
    /* Pre-escucha: toma la señal antes del fader y la manda al bus de auriculares. */
    this.cueSend = c.createGain(); this.cueSend.gain.value = 0;
    this.trim.connect(this.cueSend); this.cueSend.connect(Engine.cueBus);
    this.pfl = false;
  }
  setPfl(on) { this.pfl = !!on; this.cueSend.gain.setTargetAtTime(this.pfl ? 1 : 0, this.ctx.currentTime, 0.01); }

  setTrim(db) { this.trim.gain.setTargetAtTime(Engine.dbToGain(db), this.ctx.currentTime, 0.02); }
  setEq(band, db) {
    const node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.02);
  }
  setFader(v) { this.fader.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.01); }
  setCrossfadeGain(g) { this.xf.gain.setTargetAtTime(g, this.ctx.currentTime, 0.01); }
  setFilter(v) {
    const f = this.filter, now = this.ctx.currentTime;
    if (Math.abs(v) < 0.03) { f.type = 'lowpass'; f.frequency.setTargetAtTime(20000, now, 0.02); f.Q.value = 0.7; return; }
    f.Q.value = 1.4;
    if (v < 0) { f.type = 'lowpass'; f.frequency.setTargetAtTime(20000 * Math.pow(60 / 20000, -v), now, 0.02); }
    else { f.type = 'highpass'; f.frequency.setTargetAtTime(20 * Math.pow(10000 / 20, v), now, 0.02); }
  }
  setEcho(v) { this.delayWet.gain.setTargetAtTime(v * 0.8, this.ctx.currentTime, 0.02); }
  setReverb(v) { this.reverbWet.gain.setTargetAtTime(v * 0.9, this.ctx.currentTime, 0.02); }
  _updateDelayTime() {
    const beat = this.bpm ? 60 / (this.bpm * this.rate) : 0.5;
    this.delay.delayTime.setTargetAtTime(Math.min(1.9, beat * 0.75), this.ctx.currentTime, 0.05);
  }

  /* ---------------- Transporte ---------------- */
  _effRate() { return (1 + this.pitch / 100) * (1 + this.bend); }
  _applyRate() {
    if (this.playing) { const pos = this.getPosition(); this.startPos = pos; this.startCtxTime = this.ctx.currentTime; }
    this.rate = this._effRate();
    if (this.source) this.source.playbackRate.setTargetAtTime(this.rate, this.ctx.currentTime, 0.005);
    this._updateDelayTime();
    this._renderBpm();
  }
  setPitch(p) {
    this.pitch = Math.max(-this.PITCH_RANGE, Math.min(this.PITCH_RANGE, p));
    if (this.pitchInput && parseFloat(this.pitchInput.value) !== this.pitch) this.pitchInput.value = this.pitch;
    this._applyRate();
  }
  setBend(b) { this.bend = b; this._applyRate(); }
  effectiveBpm() { return this.bpm ? this.bpm * this.rate : null; }

  getPosition() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.pausedPos;
    let pos = this.startPos + (this.ctx.currentTime - this.startCtxTime) * this.rate;
    const L = this.loop;
    if (L.active && pos >= L.end) { const len = L.end - L.start; pos = L.start + ((pos - L.start) % len); }
    return Math.min(pos, this.duration);
  }
  /* Beat dentro del compás (0-3, fraccional) y número de compás, según la grilla. */
  beatInfo() {
    if (!this.buffer || !this.bpm) return null;
    const beats = (this.getPosition() - this.firstBeat) / (60 / this.bpm);
    const bar = Math.floor(beats / 4);
    return { beat: ((beats % 4) + 4) % 4, bar };
  }
  beatAtOrAfter(t, barAligned) {
    if (!this.bpm) return t;
    const beat = 60 / this.bpm;
    let k = Math.ceil((t - this.firstBeat) / beat - 1e-6);
    if (barAligned) k = Math.ceil(k / 4) * 4;
    return this.firstBeat + k * beat;
  }

  _startSource(pos) {
    this._stopSource();
    const s = this.ctx.createBufferSource();
    s.buffer = this.buffer;
    s.playbackRate.value = this.rate;
    if (this.loop.active) { s.loop = true; s.loopStart = this.loop.start; s.loopEnd = this.loop.end; }
    s.connect(this.input);
    pos = Math.max(0, Math.min(pos, this.duration));
    s.start(0, Math.min(pos, Math.max(0, this.duration - 0.001)));
    this.source = s;
    this.startPos = pos;
    this.startCtxTime = this.ctx.currentTime;
  }
  _stopSource() {
    const s = this.source;
    if (!s) return;
    this.source = null;
    try { s.stop(); } catch (e) { /* ya detenido */ }
    s.disconnect();
  }

  play() {
    if (!this.buffer || this.playing) return;
    Engine.resume();
    if (this.pausedPos >= this.duration) this.pausedPos = 0;
    this._startSource(this.pausedPos);
    this.playing = true;
    this._renderTransport();
    this.onPlay(this);
  }
  pause() {
    if (!this.playing) return;
    const pos = this.getPosition();
    this._stopSource();
    this.playing = false;
    this.pausedPos = pos;
    this._renderTransport();
  }
  togglePlay() {
    if (this.previewing) { this.previewing = false; return; }
    if (this.playing) this.pause(); else this.play();
  }
  seek(pos) {
    if (!this.buffer) return;
    pos = Math.max(0, Math.min(pos, this.duration));
    if (this.loop.active && (pos < this.loop.start || pos >= this.loop.end)) this.exitLoop();
    if (this.playing) this._startSource(pos); else this.pausedPos = pos;
  }
  _onEnded() {
    this._stopSource();
    this.playing = false;
    this.previewing = false;
    this.pausedPos = this.cuePoint;
    this._renderTransport();
    this.onEnded(this);
  }

  cuePress() {
    if (!this.buffer) return;
    if (this.playing) { this.previewing = false; this.pause(); this.seek(this.cuePoint); return; }
    if (Math.abs(this.pausedPos - this.cuePoint) > 0.02) {
      this.cuePoint = this.pausedPos;
      this._renderTransport();
      return;
    }
    this.previewing = true;
    this.play();
  }
  cueRelease() {
    if (!this.previewing) return;
    this.previewing = false;
    this.pause();
    this.seek(this.cuePoint);
  }
  hotCue(i, clear) {
    if (!this.buffer) return;
    if (clear) this.hotCues[i] = null;
    else if (this.hotCues[i] == null) this.hotCues[i] = this.getPosition();
    else { this.seek(this.hotCues[i]); if (!this.playing) this.play(); }
    this._renderHotCues();
  }

  /* ---------------- Loops ---------------- */
  loopIn() {
    if (!this.buffer) return;
    if (this.loop.active) this.exitLoop();
    this.loop.inPoint = this.getPosition();
    this._renderLoop();
  }
  loopOut() {
    if (!this.buffer || this.loop.inPoint == null) return;
    const start = this.loop.inPoint, end = this.getPosition();
    if (end - start < 0.03) return;
    this._setLoop(start, end, true);
  }
  autoLoop(beats) {
    if (!this.buffer) return;
    const pos = this.getPosition();
    const beat = this.bpm ? 60 / this.bpm : 0.5;
    let start = pos;
    if (this.bpm) {
      start = this.firstBeat + Math.floor((pos - this.firstBeat) / beat) * beat;
      if (start + beats * beat - pos < 0.08) start += beat;
    }
    this._setLoop(start, Math.min(this.duration, start + beats * beat), false);
  }
  loopHalve() {
    if (!this.loop.active) return;
    const len = (this.loop.end - this.loop.start) / 2;
    if (len < 0.015) return;
    this._setLoop(this.loop.start, this.loop.start + len, false);
  }
  loopDouble() {
    if (!this.loop.active) return;
    const len = (this.loop.end - this.loop.start) * 2;
    this._setLoop(this.loop.start, Math.min(this.duration, this.loop.start + len), false);
  }
  _setLoop(start, end, forceRestart) {
    const pos = this.getPosition();
    const L = this.loop;
    L.active = true; L.start = start; L.end = end; L.inPoint = null;
    if (this.playing) {
      if (forceRestart || pos >= end) {
        const len = end - start;
        this._startSource(start + (((pos - start) % len) + len) % len);
      } else {
        this.source.loop = true; this.source.loopStart = start; this.source.loopEnd = end;
        this.startPos = pos; this.startCtxTime = this.ctx.currentTime;
      }
    } else if (this.pausedPos >= end) {
      this.pausedPos = start;
    }
    this._renderLoop();
  }
  exitLoop() {
    if (!this.loop.active) return;
    const pos = this.getPosition();
    this.loop.active = false;
    if (this.playing && this.source) { this.source.loop = false; this.startPos = pos; this.startCtxTime = this.ctx.currentTime; }
    this._renderLoop();
  }

  /* ---------------- Sync ---------------- */
  sync() {
    const other = this.getOther();
    if (!other || !this.buffer) return;
    if (!this.bpm || !other.bpm) { this.onNotice('SYNC necesita el BPM de las dos pistas.'); return; }
    let ratio = other.effectiveBpm() / this.bpm;
    if (ratio > 1.4) ratio /= 2; else if (ratio < 0.7) ratio *= 2;
    const wanted = (ratio - 1) * 100;
    this.setPitch(wanted);
    if (Math.abs(wanted) > this.PITCH_RANGE + 1e-9) {
      this.onNotice('SYNC: el Deck ' + this.id + ' necesitaría ' + (wanted > 0 ? '+' : '') + wanted.toFixed(1) +
        '% y el pitch llega a ±' + this.PITCH_RANGE + '%.');
    }
    if (this.playing && other.playing) {
      const myBeat = 60 / this.bpm, otherBeat = 60 / other.bpm;
      const mod1 = x => ((x % 1) + 1) % 1;
      const myPhase = mod1((this.getPosition() - this.firstBeat) / myBeat);
      const otherPhase = mod1((other.getPosition() - other.firstBeat) / otherBeat);
      let d = otherPhase - myPhase;
      if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
      this.seek(this.getPosition() + d * myBeat);
    }
  }
  isInSync() {
    const other = this.getOther();
    if (!other || !this.bpm || !other.bpm) return false;
    return Math.abs(this.effectiveBpm() - other.effectiveBpm()) < 0.05;
  }

  /* ---------------- Carga y análisis ---------------- */
  setLoading(track) {
    this.status = 'loading';
    this.titleEl.textContent = 'Cargando ' + track.name + '…';
  }
  setError(msg) {
    this.status = this.buffer ? 'ready' : 'empty';
    this.titleEl.textContent = msg || 'No se pudo cargar la pista';
  }
  load(track, buffer) {
    this.pause();
    this.track = track; this.buffer = buffer; this.duration = buffer.duration;
    this.peaks = computePeaks(buffer, this.PPS);
    this.pausedPos = 0; this.cuePoint = 0; this.previewing = false;
    this.hotCues = [null, null, null, null];
    this.loop = { active: false, start: 0, end: 0, inPoint: null };
    this.status = 'ready';
    this.mount.classList.add('loaded');
    this.applyAnalysis(track);
    this._renderTransport(); this._renderHotCues(); this._renderLoop();
  }
  /* Aplica (o reaplica, cuando termina el análisis en segundo plano) los datos de la pista. */
  applyAnalysis(track) {
    if (!this.buffer || !track || this.track !== track) return;
    this.bpm = track.bpm || null; this.firstBeat = track.firstBeat || 0;
    this.bands = track.bands && track.bands.low ? track.bands : null;
    if (track.audioEnd) { this.audioStart = track.audioStart || 0; this.audioEnd = track.audioEnd; }
    else this._findAudioBounds();
    this.autoGain.gain.setTargetAtTime(Engine.dbToGain(track.gainDb || 0), this.ctx.currentTime, 0.05);
    const cues = track.cues || null;
    if (cues && !this.playing && this.pausedPos === 0) {
      this.cuePoint = cues.intro || 0;
      this.pausedPos = this.cuePoint;
      if (cues.drop != null && this.hotCues[0] == null) this.hotCues[0] = cues.drop;
      if (cues.outro != null && this.hotCues[1] == null) this.hotCues[1] = cues.outro;
    }
    this.overviewCache = null;
    this._updateDelayTime();
    this._renderHeader(); this._renderBpm(); this._renderHotCues(); this._renderTransport();
  }
  _findAudioBounds() {
    const P = this.peaks, th = 0.02;
    let a = 0, b = P.length - 1;
    while (a < P.length && P[a] < th) a++;
    while (b > a && P[b] < th) b--;
    this.audioStart = Math.min(a / this.PPS, this.duration);
    this.audioEnd = Math.min((b + 1) / this.PPS, this.duration);
  }
  setBpm(bpm, firstBeat) {
    this.bpm = bpm || null;
    if (firstBeat != null) this.firstBeat = firstBeat;
    this._updateDelayTime();
    this._renderBpm();
  }

  /* ---------------- UI ---------------- */
  _buildUI(mount, zoomMount) {
    this.mount = mount;
    mount.style.setProperty('--accent', this.color);
    mount.innerHTML =
      '<div class="deck-head">' +
        '<div class="deck-art"><span class="deck-badge">' + this.id + '</span></div>' +
        '<div class="deck-info">' +
          '<div class="track-title">Sin pista</div>' +
          '<div class="track-artist">Arrastra un archivo o cárgalo desde la colección</div>' +
          '<div class="deck-meta">' +
            '<span class="key-badge empty deck-key">—</span>' +
            '<button class="bpm-btn" title="Clic para corregir el BPM a mano"><strong class="bpm-eff">—</strong><small class="bpm-orig"></small> BPM</button>' +
            '<span class="pitch-read">+0.00%</span>' +
            '<span class="gain-read" title="Ganancia automática"></span>' +
          '</div>' +
        '</div>' +
        '<div class="time"><span class="t-el">0:00.0</span><span class="t-rem">-0:00.0</span></div>' +
      '</div>' +
      '<canvas class="wave-over"></canvas>' +
      '<div class="deck-body">' +
        '<div class="deck-main">' +
          '<div class="transport">' +
            '<button class="btn btn-cue">CUE</button>' +
            '<button class="btn btn-play">▶ PLAY</button>' +
            '<button class="btn btn-sync">SYNC</button>' +
          '</div>' +
          '<div class="hotcues">' +
            [0, 1, 2, 3].map(i => '<button class="btn hc" data-i="' + i + '" style="--hc:' + HOT_COLORS[i] + '" title="Hot cue ' + (i + 1) + ' · Shift+clic borra">' + (i + 1) + '</button>').join('') +
          '</div>' +
          '<div class="loops">' +
            '<button class="btn btn-lin" title="Inicio de loop">IN</button>' +
            '<button class="btn btn-lout" title="Fin de loop">OUT</button>' +
            '<button class="btn btn-auto" title="Loop automático de 4 beats">LOOP 4</button>' +
            '<button class="btn btn-half" title="Mitad">½</button>' +
            '<button class="btn btn-dbl" title="Doble">×2</button>' +
            '<button class="btn btn-lexit" title="Salir del loop">EXIT</button>' +
          '</div>' +
          '<div class="fx"></div>' +
          '<div class="key-hint">' + this.keyHint + '</div>' +
        '</div>' +
        '<div class="pitch-col">' +
          '<button class="btn bend bend-plus" title="Acelerar momentáneamente">+</button>' +
          '<input type="range" class="pitch" min="-' + this.PITCH_RANGE + '" max="' + this.PITCH_RANGE + '" step="0.05" value="0" title="Pitch / tempo">' +
          '<button class="btn bend bend-minus" title="Frenar momentáneamente">−</button>' +
          '<button class="btn pitch-reset" title="Pitch a 0%">0</button>' +
        '</div>' +
      '</div>';

    const q = s => mount.querySelector(s);
    this.titleEl = q('.track-title'); this.artistEl = q('.track-artist'); this.artEl = q('.deck-art');
    this.keyEl = q('.deck-key'); this.gainEl = q('.gain-read');
    this.tEl = q('.t-el'); this.tRem = q('.t-rem');
    this.bpmEff = q('.bpm-eff'); this.bpmOrig = q('.bpm-orig'); this.pitchRead = q('.pitch-read');
    this.overCv = q('.wave-over');
    this.zoomCv = document.createElement('canvas');
    this.zoomCv.className = 'wave-zoom';
    (zoomMount || mount).appendChild(this.zoomCv);
    this.btnPlay = q('.btn-play'); this.btnCue = q('.btn-cue'); this.btnSync = q('.btn-sync');
    this.hcBtns = Array.from(mount.querySelectorAll('.hc'));
    this.btnIn = q('.btn-lin'); this.btnOut = q('.btn-lout'); this.btnAuto = q('.btn-auto');
    this.btnHalf = q('.btn-half'); this.btnDbl = q('.btn-dbl'); this.btnExit = q('.btn-lexit');
    this.pitchInput = q('.pitch');

    this.btnPlay.addEventListener('click', () => this.togglePlay());
    this.btnCue.addEventListener('pointerdown', e => { e.preventDefault(); this.cuePress(); });
    this.btnCue.addEventListener('pointerup', () => this.cueRelease());
    this.btnCue.addEventListener('pointerleave', () => this.cueRelease());
    this.btnSync.addEventListener('click', () => this.sync());
    this.hcBtns.forEach(b => b.addEventListener('click', e => this.hotCue(+b.dataset.i, e.shiftKey)));
    this.btnIn.addEventListener('click', () => this.loopIn());
    this.btnOut.addEventListener('click', () => this.loopOut());
    this.btnAuto.addEventListener('click', () => this.autoLoop(4));
    this.btnHalf.addEventListener('click', () => this.loopHalve());
    this.btnDbl.addEventListener('click', () => this.loopDouble());
    this.btnExit.addEventListener('click', () => this.exitLoop());
    this.pitchInput.addEventListener('input', () => this.setPitch(parseFloat(this.pitchInput.value)));
    q('.pitch-reset').addEventListener('click', () => this.setPitch(0));
    const bendDown = b => e => { e.preventDefault(); this.setBend(b); };
    const bendUp = () => this.setBend(0);
    ['.bend-plus', '.bend-minus'].forEach((sel, i) => {
      const el = q(sel);
      el.addEventListener('pointerdown', bendDown(i === 0 ? 0.04 : -0.04));
      el.addEventListener('pointerup', bendUp);
      el.addEventListener('pointerleave', bendUp);
    });
    q('.bpm-btn').addEventListener('click', async () => {
      if (!this.buffer) return;
      const v = await Dialogs.prompt('Corregir BPM', this.bpm ? String(this.bpm) : '', this.track.name);
      if (v === null) return;
      const n = parseFloat(String(v).replace(',', '.'));
      if (!isFinite(n) || n < 40 || n > 300) { this.onNotice('Escribe un BPM entre 40 y 300.'); return; }
      this.setBpm(Math.round(n * 100) / 100, this.firstBeat);
      this.onBpmEdit(this.track, this.bpm);
    });

    this.overCv.addEventListener('click', e => {
      if (!this.buffer) return;
      const r = this.overCv.getBoundingClientRect();
      this.seek((e.clientX - r.left) / r.width * this.duration);
    });
    this.zoomCv.addEventListener('click', e => {
      if (!this.buffer) return;
      const r = this.zoomCv.getBoundingClientRect();
      const dt = ((e.clientX - r.left) / r.width - 0.5) * this.ZOOM_SECONDS;
      this.seek(this.getPosition() + dt);
    });

    const fx = q('.fx');
    const pct = v => Math.round(v * 100) + '%';
    const hz = f => f >= 1000 ? (f / 1000).toFixed(1) + 'k' : Math.round(f) + '';
    const fmtFilter = v => Math.abs(v) < 0.03 ? 'OFF'
      : v < 0 ? 'LP ' + hz(20000 * Math.pow(60 / 20000, -v)) : 'HP ' + hz(20 * Math.pow(10000 / 20, v));
    this.knobFilter = createKnob({ label: 'FILTER', min: -1, max: 1, value: 0, format: fmtFilter, onChange: v => this.setFilter(v) });
    this.knobEcho = createKnob({ label: 'ECHO', min: 0, max: 1, value: 0, format: pct, onChange: v => this.setEcho(v) });
    this.knobReverb = createKnob({ label: 'REVERB', min: 0, max: 1, value: 0, format: pct, onChange: v => this.setReverb(v) });
    fx.append(this.knobFilter.el, this.knobEcho.el, this.knobReverb.el);

    const dropTargets = [mount, this.zoomCv];
    dropTargets.forEach(t => {
      t.addEventListener('dragover', e => { e.preventDefault(); mount.classList.add('drop'); });
      t.addEventListener('dragleave', () => mount.classList.remove('drop'));
      t.addEventListener('drop', e => {
        e.preventDefault();
        mount.classList.remove('drop');
        const id = e.dataTransfer.getData('text/mixdeck-id');
        if (id) this.onLoadRequest(this.id, { id });
        else if (e.dataTransfer.files && e.dataTransfer.files.length) this.onLoadRequest(this.id, { files: e.dataTransfer.files });
      });
    });
    if (window.ResizeObserver) new ResizeObserver(() => { this.overviewCache = null; }).observe(mount);
    this._renderHeader(); this._renderTransport(); this._renderHotCues(); this._renderLoop(); this._renderBpm();
  }

  _renderHeader() {
    const t = this.track;
    if (!t) return;
    this.titleEl.textContent = t.name;
    this.titleEl.title = t.name;
    this.artistEl.textContent = t.artist || (t.album ? t.album : '—');
    const cover = Library.coverUrl(t);
    this.artEl.style.backgroundImage = cover ? 'url("' + cover.replace(/"/g, '%22') + '")' : '';
    this.artEl.classList.toggle('has-art', !!cover);
    if (t.camelot) {
      this.keyEl.textContent = t.camelot;
      this.keyEl.title = t.key;
      this.keyEl.className = 'key-badge deck-key';
      this.keyEl.style.setProperty('--kc', Analyzer.camelotColor(t.camelot));
    } else {
      this.keyEl.textContent = t.analyzing ? '…' : '—';
      this.keyEl.className = 'key-badge empty deck-key';
    }
    this.gainEl.textContent = t.gainDb ? 'GAIN ' + (t.gainDb > 0 ? '+' : '') + t.gainDb.toFixed(1) + ' dB' : '';
  }
  _renderTransport() {
    this.btnPlay.textContent = this.playing && !this.previewing ? '❚❚ PAUSE' : '▶ PLAY';
    this.btnPlay.classList.toggle('on', this.playing && !this.previewing);
    this.btnCue.classList.toggle('on', !!this.buffer && !this.playing && Math.abs(this.pausedPos - this.cuePoint) <= 0.02);
  }
  _renderHotCues() {
    this.hcBtns.forEach((b, i) => b.classList.toggle('set', this.hotCues[i] != null));
  }
  _renderLoop() {
    const L = this.loop;
    this.btnIn.classList.toggle('on', L.inPoint != null || L.active);
    this.btnOut.classList.toggle('on', L.active);
    this.btnAuto.classList.toggle('on', L.active);
    this.btnExit.classList.toggle('on', L.active);
    this.mount.classList.toggle('looping', L.active);
  }
  _renderBpm() {
    const eff = this.effectiveBpm();
    this.bpmEff.textContent = eff ? (Math.round(eff * 10) / 10).toFixed(1) : '—';
    this.bpmOrig.textContent = this.bpm && Math.abs(this.rate - 1) > 0.0005 ? ' (' + this.bpm + ')' : '';
    const p = this.pitch;
    this.pitchRead.textContent = (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
    this.btnSync.classList.toggle('on', this.isInSync());
  }

  /* ---------------- Dibujo ---------------- */
  _sizeCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 300, h = cv.clientHeight || 60;
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) { cv.width = pw; cv.height = ph; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }
  _marker(g, x, h, color, label) {
    g.fillStyle = color;
    g.fillRect(x - 0.5, 0, 1.5, h);
    g.beginPath(); g.moveTo(x - 5, 0); g.lineTo(x + 5, 0); g.lineTo(x, 7); g.closePath(); g.fill();
    if (label) { g.font = 'bold 10px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText(label, x + 3, h - 4); }
  }
  /* Dibuja una columna de onda: 3 bandas superpuestas (graves, medios, agudos) o el pico mono. */
  _column(g, x, mid, h, i, alpha, width) {
    width = width || 1;
    if (this.bands) {
      const B = this.bands, amp = h * 0.47 / 255;
      const l = (B.low[i] || 0) * amp, m = (B.mid[i] || 0) * amp, hi = (B.high[i] || 0) * amp;
      g.globalAlpha = alpha;
      g.fillStyle = WAVE_COLORS.low; g.fillRect(x, mid - l, width, l * 2);
      g.fillStyle = WAVE_COLORS.mid; g.fillRect(x, mid - m, width, m * 2);
      g.fillStyle = WAVE_COLORS.high; g.fillRect(x, mid - hi, width, hi * 2);
      g.globalAlpha = 1;
    } else {
      const v = this.peaks[i] || 0;
      const hh = Math.max(1, v * h * 0.46);
      g.globalAlpha = alpha;
      g.fillStyle = this.color; g.fillRect(x, mid - hh, width, hh * 2);
      g.globalAlpha = 1;
    }
  }
  _columnMax(g, x, mid, h, a, b, alpha) {
    if (this.bands) {
      const B = this.bands, amp = h * 0.47 / 255;
      let l = 0, m = 0, hi = 0;
      for (let i = a; i < b; i++) { if (B.low[i] > l) l = B.low[i]; if (B.mid[i] > m) m = B.mid[i]; if (B.high[i] > hi) hi = B.high[i]; }
      g.globalAlpha = alpha;
      g.fillStyle = WAVE_COLORS.low; g.fillRect(x, mid - l * amp, 1, l * amp * 2);
      g.fillStyle = WAVE_COLORS.mid; g.fillRect(x, mid - m * amp, 1, m * amp * 2);
      g.fillStyle = WAVE_COLORS.high; g.fillRect(x, mid - hi * amp, 1, hi * amp * 2);
      g.globalAlpha = 1;
    } else {
      let v = 0;
      for (let i = a; i < b; i++) if (this.peaks[i] > v) v = this.peaks[i];
      const hh = Math.max(0.5, v * h * 0.45);
      g.globalAlpha = alpha; g.fillStyle = this.color; g.fillRect(x, mid - hh, 1, hh * 2); g.globalAlpha = 1;
    }
  }

  draw() {
    if (this.playing && !this.loop.active && this.getPosition() >= this.duration) this._onEnded();
    const pos = this.getPosition();
    this.tEl.textContent = fmtTime(pos, true);
    this.tRem.textContent = '-' + fmtTime(this.duration - pos, true);
    this._drawZoom(pos);
    this._drawOverview(pos);
    this._updateVu();
    if (this.buffer && this.getOther()) this.btnSync.classList.toggle('on', this.isInSync());
  }

  _drawZoom(pos) {
    const { g, w, h } = this._sizeCanvas(this.zoomCv);
    g.fillStyle = '#07080b'; g.fillRect(0, 0, w, h);
    if (!this.buffer) {
      g.fillStyle = '#3a3f4d'; g.font = '12px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(this.status === 'loading' ? 'Cargando…' : 'DECK ' + this.id + ' · suelta una pista aquí', w / 2, h / 2);
      return;
    }
    const win = this.ZOOM_SECONDS, t0 = pos - win / 2, pps = w / win;
    const L = this.loop;
    if (L.active) { g.fillStyle = 'rgba(255,255,255,.09)'; g.fillRect((L.start - t0) * pps, 0, (L.end - L.start) * pps, h); }
    else if (L.inPoint != null) { g.fillStyle = 'rgba(255,255,255,.6)'; g.fillRect((L.inPoint - t0) * pps, 0, 1, h); }
    if (this.bpm) {
      const beat = 60 / this.bpm;
      let k = Math.ceil((t0 - this.firstBeat) / beat);
      for (let t = this.firstBeat + k * beat; t < t0 + win; k++, t = this.firstBeat + k * beat) {
        const down = ((k % 4) + 4) % 4 === 0;
        g.fillStyle = down ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.14)';
        g.fillRect((t - t0) * pps, 0, 1, h);
        if (down) { g.fillStyle = 'rgba(255,255,255,.5)'; g.fillRect((t - t0) * pps - 2, 0, 5, 3); }
      }
    }
    const mid = h / 2, PPS = this.PPS, xPlay = Math.floor(w / 2);
    for (let x = 0; x < w; x++) {
      const t = t0 + x / pps;
      if (t < 0 || t >= this.duration) continue;
      this._column(g, x, mid, h, Math.floor(t * PPS), x < xPlay ? 0.5 : 1);
    }
    const cx = (this.cuePoint - t0) * pps;
    if (cx >= -6 && cx <= w + 6) this._marker(g, cx, h, '#ffb020');
    this.hotCues.forEach((c, i) => {
      if (c == null) return;
      const x = (c - t0) * pps;
      if (x >= -6 && x <= w + 6) this._marker(g, x, h, HOT_COLORS[i], String(i + 1));
    });
    g.fillStyle = '#fff'; g.fillRect(w / 2 - 1, 0, 2, h);
  }

  _drawOverview(pos) {
    const { g, w, h } = this._sizeCanvas(this.overCv);
    g.fillStyle = '#07080b'; g.fillRect(0, 0, w, h);
    if (!this.buffer) return;
    const dpr = window.devicePixelRatio || 1;
    const cv = this.overCv;
    const bins = this.bands ? this.bands.low.length : this.peaks.length;
    if (!this.overviewCache || this.overviewCache.width !== cv.width || this.overviewCache.height !== cv.height) {
      const oc = document.createElement('canvas');
      oc.width = cv.width; oc.height = cv.height;
      const og = oc.getContext('2d');
      og.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bpp = bins / w;
      for (let x = 0; x < w; x++) {
        const a = Math.floor(x * bpp), b = Math.max(a + 1, Math.floor((x + 1) * bpp));
        this._columnMax(og, x, h / 2, h, a, b, 1);
      }
      this.overviewCache = oc;
    }
    g.drawImage(this.overviewCache, 0, 0, w, h);
    const px = pos / this.duration * w;
    g.fillStyle = 'rgba(0,0,0,.55)'; g.fillRect(0, 0, px, h);
    if (this.loop.active) {
      g.fillStyle = 'rgba(255,255,255,.2)';
      g.fillRect(this.loop.start / this.duration * w, 0, (this.loop.end - this.loop.start) / this.duration * w, h);
    }
    this._marker(g, this.cuePoint / this.duration * w, h, '#ffb020');
    this.hotCues.forEach((c, i) => { if (c != null) this._marker(g, c / this.duration * w, h, HOT_COLORS[i]); });
    g.fillStyle = '#fff'; g.fillRect(px - 1, 0, 2, h);
  }

  _updateVu() {
    this.analyser.getByteTimeDomainData(this.vuData);
    let m = 0;
    for (let i = 0; i < this.vuData.length; i++) { const v = Math.abs(this.vuData[i] - 128) / 128; if (v > m) m = v; }
    const db = 20 * Math.log10(m || 1e-4);
    const n = Math.max(0, Math.min(1, (db + 42) / 42));
    this.vu.level = Math.max(n, this.vu.level * 0.86);
    if (n >= this.vu.peak) { this.vu.peak = n; this.vu.hold = 25; }
    else if (--this.vu.hold <= 0) this.vu.peak = Math.max(0, this.vu.peak - 0.012);
  }
}
