/* Punto de entrada: crea los decks, el mixer, la biblioteca, atajos de teclado y grabación. */
(() => {
  const $ = s => document.querySelector(s);

  const toastEl = $('#toast');
  let toastTimer = null;
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms || 3000);
  }

  /* ---- Decks y mixer ---- */
  const deckA = new Deck('A', $('#deck-a'), {
    color: '#22d3ee',
    keyHint: 'Q play · W cue · E sync · R loop · 1-4 hot cues',
    onLoadRequest: handleLoadRequest,
    onBpmEdit: (track, bpm) => Library.updateBpm(track, bpm),
    onNotice: toast,
    onPlay: () => SpotifyLink.pause(),
    onEnded: d => Automix.onDeckEnded(d.id)
  });
  const deckB = new Deck('B', $('#deck-b'), {
    color: '#fb7185',
    keyHint: 'P play · O cue · I sync · U loop · 7-0 hot cues',
    onLoadRequest: handleLoadRequest,
    onBpmEdit: (track, bpm) => Library.updateBpm(track, bpm),
    onNotice: toast,
    onPlay: () => SpotifyLink.pause(),
    onEnded: d => Automix.onDeckEnded(d.id)
  });
  deckA.getOther = () => deckB;
  deckB.getOther = () => deckA;
  Mixer.build($('#mixer'), deckA, deckB);
  const decks = { A: deckA, B: deckB };

  /* ---- Biblioteca ---- */
  async function loadTrack(track, deckId) {
    const deck = decks[deckId];
    if (!track || !deck) return;
    deck.setLoading(track);
    try {
      const buf = await Library.decode(track);
      if (!track.duration) track.duration = buf.duration;
      deck.load(track, buf);
      if (track.analyzing) toast('Pista cargada en ' + deckId + '. El BPM aparecerá cuando termine el análisis.');
    } catch (e) {
      console.error(e);
      deck.setError('No se pudo decodificar "' + track.name + '"');
      toast('El navegador no pudo decodificar ese archivo.');
    }
  }
  function handleLoadRequest(deckId, payload) {
    if (payload.files) {
      const added = Library.addFiles(payload.files);
      if (!added.length) return toast('Ese archivo no parece ser de audio.');
      loadTrack(added[0], deckId);
    } else if (payload.id) {
      loadTrack(Library.get(payload.id), deckId);
    }
  }
  Library.on('load', (track, deckId) => { if (deckId === 'Q') Automix.add([track.id]); else loadTrack(track, deckId); });
  Library.on('change', rec => {
    for (const d of [deckA, deckB]) if (d.track && d.track.id === rec.id) d.setBpm(rec.bpm, rec.firstBeat);
    SpotifyLink.refreshMatches();
  });
  Library.init({ tbody: $('#lib-body'), status: $('#lib-status') }).then(() => { SpotifyLink.refreshMatches(); Automix.libraryReady(); });

  /* ---- Spotify ---- */
  SpotifyLink.build($('#spotify'), {
    toast,
    locals: () => Library.tracks,
    loadLocal: (id, deckId) => loadTrack(Library.get(id), deckId),
    queueLocal: ids => { const n = Automix.add(ids); toast(n ? n + (n === 1 ? ' pista agregada' : ' pistas agregadas') + ' a la cola de Automix.' : 'Esas pistas ya están en la cola.'); },
    onSpotifyPlaying: () => { if (Automix.running) Automix.stop(); deckA.pause(); deckB.pause(); }
  });

  /* ---- Automix ---- */
  Automix.build($('#automix'), { toast, loadTrack }, decks, Library);

  const fileInput = $('#file-input');
  fileInput.addEventListener('change', () => { Library.addFiles(fileInput.files); fileInput.value = ''; SpotifyLink.refreshMatches(); });
  const dz = $('#dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('over');
    const added = Library.addFiles(e.dataTransfer.files);
    if (!added.length) toast('No encontré archivos de audio en lo que soltaste.');
  });
  $('#lib-clear').addEventListener('click', () => {
    if (!Library.tracks.length) return;
    if (confirm('¿Vaciar la biblioteca? Las pistas cargadas en los decks siguen sonando.')) Library.clear();
  });

  /* ---- Master, grabación, ayuda ---- */
  $('#master-vol').addEventListener('input', e => {
    Engine.master.gain.setTargetAtTime(parseFloat(e.target.value), Engine.ctx.currentTime, 0.01);
  });

  const recBtn = $('#rec-btn'), recLink = $('#rec-link');
  let recStart = 0;
  recBtn.addEventListener('click', async () => {
    Engine.resume();
    if (!Engine.recording) {
      if (!Engine.startRecording()) return toast('Este navegador no soporta grabar la mezcla.');
      recStart = Date.now();
      recBtn.classList.add('on');
      recLink.classList.add('hidden');
    } else {
      const blob = await Engine.stopRecording();
      recBtn.classList.remove('on');
      recBtn.textContent = '● REC';
      if (!blob || !blob.size) return toast('La grabación quedó vacía.');
      const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'm4a' : 'webm';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      recLink.href = URL.createObjectURL(blob);
      recLink.download = 'mix-' + stamp + '.' + ext;
      recLink.textContent = '⬇ Descargar mezcla (' + Library.fmt((Date.now() - recStart) / 1000) + ')';
      recLink.classList.remove('hidden');
    }
  });

  const help = $('#help');
  $('#help-btn').addEventListener('click', () => help.showModal());
  $('#help-close').addEventListener('click', () => help.close());

  document.addEventListener('pointerdown', () => Engine.resume(), { once: true });

  /* ---- Teclado ---- */
  const KEYS = {
    KeyQ: ['A', 'play'], KeyW: ['A', 'cue'], KeyE: ['A', 'sync'], KeyR: ['A', 'auto'],
    KeyZ: ['A', 'in'], KeyX: ['A', 'out'], KeyC: ['A', 'exit'], KeyA: ['A', 'bend', -1], KeyS: ['A', 'bend', 1],
    Digit1: ['A', 'hot', 0], Digit2: ['A', 'hot', 1], Digit3: ['A', 'hot', 2], Digit4: ['A', 'hot', 3],
    KeyP: ['B', 'play'], KeyO: ['B', 'cue'], KeyI: ['B', 'sync'], KeyU: ['B', 'auto'],
    KeyM: ['B', 'in'], Comma: ['B', 'out'], Period: ['B', 'exit'], KeyK: ['B', 'bend', -1], KeyL: ['B', 'bend', 1],
    Digit7: ['B', 'hot', 0], Digit8: ['B', 'hot', 1], Digit9: ['B', 'hot', 2], Digit0: ['B', 'hot', 3]
  };
  const typing = t => t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
    (t.tagName === 'INPUT' && t.type !== 'range'));

  document.addEventListener('keydown', e => {
    if (typing(e.target) || help.open) return;
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (e.target.tagName === 'INPUT') return;
      e.preventDefault();
      Mixer.nudgeXf(e.code === 'ArrowLeft' ? -0.05 : 0.05);
      return;
    }
    if (e.key === '?') { help.showModal(); return; }
    const m = KEYS[e.code];
    if (!m || e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    if (e.repeat) return;
    const d = decks[m[0]];
    switch (m[1]) {
      case 'play': d.togglePlay(); break;
      case 'cue': d.cuePress(); break;
      case 'sync': d.sync(); break;
      case 'auto': d.autoLoop(4); break;
      case 'in': d.loopIn(); break;
      case 'out': d.loopOut(); break;
      case 'exit': d.exitLoop(); break;
      case 'bend': d.setBend(m[2] * 0.04); break;
      case 'hot': d.hotCue(m[2], e.shiftKey); break;
    }
  });
  document.addEventListener('keyup', e => {
    const m = KEYS[e.code];
    if (!m) return;
    const d = decks[m[0]];
    if (m[1] === 'cue') d.cueRelease();
    if (m[1] === 'bend') d.setBend(0);
  });

  /* ---- Bucle de dibujo ---- */
  const masterVu = $('#master-vu');
  const masterData = new Uint8Array(Engine.analyser.fftSize);
  const mvu = { level: 0, peak: 0, hold: 0 };
  function drawMaster() {
    Engine.analyser.getByteTimeDomainData(masterData);
    let m = 0;
    for (let i = 0; i < masterData.length; i++) { const v = Math.abs(masterData[i] - 128) / 128; if (v > m) m = v; }
    const n = Math.max(0, Math.min(1, (20 * Math.log10(m || 1e-4) + 42) / 42));
    mvu.level = Math.max(n, mvu.level * 0.86);
    if (n >= mvu.peak) { mvu.peak = n; mvu.hold = 25; } else if (--mvu.hold <= 0) mvu.peak = Math.max(0, mvu.peak - 0.012);
    const dpr = window.devicePixelRatio || 1;
    const w = masterVu.clientWidth || 120, h = masterVu.clientHeight || 12;
    if (masterVu.width !== Math.round(w * dpr)) { masterVu.width = Math.round(w * dpr); masterVu.height = Math.round(h * dpr); }
    const g = masterVu.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const segs = 24, gap = 2, sw = (w - gap * (segs - 1)) / segs;
    for (let i = 0; i < segs; i++) {
      const lit = mvu.level >= (i + 1) / segs - 1 / segs / 2;
      g.globalAlpha = lit ? 1 : 0.15;
      g.fillStyle = i >= segs - 3 ? '#ef4444' : i >= segs - 7 ? '#facc15' : '#4ade80';
      g.fillRect(i * (sw + gap), 0, sw, h);
    }
    g.globalAlpha = 1;
    if (mvu.peak > 0.02) { g.fillStyle = '#fff'; g.fillRect(Math.min(w - 2, mvu.peak * w - 1), 0, 2, h); }
  }

  function frame() {
    Automix.tick();
    deckA.draw();
    deckB.draw();
    Mixer.draw();
    drawMaster();
    if (Engine.recording) recBtn.textContent = '■ ' + Library.fmt((Date.now() - recStart) / 1000);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.MixDeck = { deckA, deckB, Library, Engine, Mixer, SpotifyLink, Automix };
})();
