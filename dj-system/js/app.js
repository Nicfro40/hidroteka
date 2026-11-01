/* Punto de entrada: decks, mixer, colección, navegador, Spotify, Automix, teclado y grabación. */
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
  const deckOpts = id => ({
    color: id === 'A' ? '#19c4ff' : '#ff5a7a',
    keyHint: id === 'A' ? 'Q play · W cue · E sync · R loop · 1-4 hot cues' : 'P play · O cue · I sync · U loop · 7-0 hot cues',
    zoomMount: $(id === 'A' ? '#wave-a' : '#wave-b'),
    onLoadRequest: handleLoadRequest,
    onBpmEdit: (track, bpm) => Library.updateBpm(track, bpm),
    onNotice: toast,
    onPlay: () => { SpotifyLink.pause(); Library.render(); },
    onEnded: d => Automix.onDeckEnded(d.id)
  });
  const deckA = new Deck('A', $('#deck-a'), deckOpts('A'));
  const deckB = new Deck('B', $('#deck-b'), deckOpts('B'));
  deckA.getOther = () => deckB;
  deckB.getOther = () => deckA;
  Mixer.build($('#mixer'), deckA, deckB);
  const decks = { A: deckA, B: deckB };

  /* Deck "maestro" para la compatibilidad de tonalidad: el que suena, o el que tiene pista. */
  function masterDeck() {
    if (deckA.playing) return deckA;
    if (deckB.playing) return deckB;
    return deckA.track ? deckA : deckB.track ? deckB : null;
  }
  function idleDeck() {
    if (!deckA.playing && !deckA.track) return 'A';
    if (!deckB.playing && !deckB.track) return 'B';
    if (!deckA.playing) return 'A';
    if (!deckB.playing) return 'B';
    return null;
  }

  /* ---- Colección ---- */
  async function loadTrack(track, deckId) {
    if (deckId === 'auto') deckId = idleDeck();
    const deck = decks[deckId];
    if (!track || !deck) { if (track) toast('Los dos decks están sonando. Pausa uno para cargar ahí.'); return; }
    deck.setLoading(track);
    try {
      const buf = await Library.decode(track);
      if (!track.duration) track.duration = buf.duration;
      deck.load(track, buf);
      if (track.analyzing) toast('Pista cargada en ' + deckId + '. El análisis se completará en segundo plano.');
      Library.render();
    } catch (e) {
      if (e && e.friendly) { deck.setError('Pista no disponible'); toast(e.message); Library.render(); return; }
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
    for (const d of [deckA, deckB]) if (d.track && d.track.id === rec.id) d.applyAnalysis(rec);
    SpotifyLink.refreshMatches();
    updateTree();
  });
  Library.init({
    tbody: $('#lib-body'), status: $('#lib-status'), search: $('#lib-search'), count: $('#lib-count'),
    hooks: { masterCamelot: () => { const d = masterDeck(); return d && d.track ? d.track.camelot : null; } }
  }).then(() => { SpotifyLink.refreshMatches(); Automix.libraryReady(); updateTree(); return Sources.init($('#sources'), sourcesHooks); });

  const fileInput = $('#file-input');
  fileInput.addEventListener('change', () => { Library.addFiles(fileInput.files); fileInput.value = ''; SpotifyLink.refreshMatches(); updateTree(); });
  const dz = $('#dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault(); dz.classList.remove('over');
    const added = Library.addFiles(e.dataTransfer.files);
    if (!added.length) toast('No encontré archivos de audio en lo que soltaste.');
    updateTree();
  });
  $('#lib-clear').addEventListener('click', async () => {
    if (!Library.tracks.length) return;
    if (await Dialogs.confirm('¿Vaciar la colección?', 'Las pistas cargadas en los decks siguen sonando.', 'Vaciar')) Library.clear().then(updateTree);
  });

  /* ---- Navegador (árbol lateral) ---- */
  function showPanel(name) {
    document.querySelectorAll('.tree-item[data-panel]').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    document.querySelectorAll('.panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name || p.id === name));
  }
  document.querySelectorAll('.tree-item[data-panel]').forEach(btn => btn.addEventListener('click', () => {
    showPanel(btn.dataset.panel);
    if (btn.dataset.panel === 'collection') { Library.setSourceFilter(null); document.querySelectorAll('.src-item').forEach(x => x.classList.remove('active')); }
  }));

  /* ---- Fuentes (carpetas y pendrives vinculados): se inicia cuando la colección está lista ---- */
  const sourcesHooks = {
    toast,
    onChange: () => { updateTree(); SpotifyLink.refreshMatches(); },
    onSelect: id => {
      showPanel('collection');
      document.querySelector('.tree-item[data-panel="collection"]').classList.remove('active');
      document.querySelectorAll('.src-item').forEach(x => x.classList.toggle('active', x.dataset.id === id));
      Library.setSourceFilter(id);
    }
  };
  function updateTree() {
    $('#tree-count').textContent = Library.tracks.length || '';
    $('#tree-queue').textContent = Automix.queue.length || '';
  }

  /* ---- Spotify ---- */
  SpotifyLink.build($('#spotify'), {
    toast,
    locals: () => Library.tracks,
    loadLocal: (id, deckId) => loadTrack(Library.get(id), deckId),
    queueLocal: ids => { const n = Automix.add(ids); toast(n ? n + (n === 1 ? ' pista agregada' : ' pistas agregadas') + ' a la cola de Automix.' : 'Esas pistas ya están en la cola.'); updateTree(); },
    onSpotifyPlaying: () => { if (Automix.running) Automix.stop(); deckA.pause(); deckB.pause(); }
  });

  /* ---- Automix ---- */
  Automix.build($('#automix'), { toast, loadTrack, onChange: updateTree }, decks, Library);

  /* ---- Controladora MIDI y salida de audio ---- */
  Midi.build($('#midi'), { toast, decks, library: Library, automix: Automix, loadTrack });

  /* ---- Master, grabación, ayuda ---- */
  $('#master-vol').addEventListener('input', e => {
    Engine.master.gain.setTargetAtTime(parseFloat(e.target.value), Engine.ctx.currentTime, 0.01);
  });
  const CAPS = Object.assign({ spotify: true, download: true }, window.MIXDECK_CAPS || {});
  const recBtn = $('#rec-btn'), recLink = $('#rec-link');
  let recStart = 0, recBlob = null, recName = '';
  if (!CAPS.download) recBtn.classList.add('hidden');
  /* En páginas publicadas la descarga pasa por la capacidad "downloads" del host (el visitante confirma). */
  if (CAPS.download === 'capability') {
    recLink.addEventListener('click', async e => {
      e.preventDefault();
      if (!recBlob) return;
      const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
      if (!dl) return toast('La descarga no está disponible en esta vista.');
      try { await dl.save({ filename: recName, data: recBlob }); toast('Mezcla guardada.'); }
      catch (err) { if (!err || err.code !== 'declined') toast('No se pudo guardar la mezcla' + (err && err.message ? ': ' + err.message : '.')); }
    });
  }
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
      const ext = blob.type.includes('ogg') ? 'ogg' : blob.type.includes('mp4') ? 'mp4' : 'webm';
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      recBlob = blob; recName = 'mix-' + stamp + '.' + ext;
      if (CAPS.download === 'capability') { recLink.removeAttribute('download'); recLink.href = '#'; }
      else { recLink.href = URL.createObjectURL(blob); recLink.download = recName; }
      recLink.textContent = '⬇ Mezcla (' + Library.fmt((Date.now() - recStart) / 1000) + ')';
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
      g.fillStyle = i >= segs - 3 ? '#ff3b3b' : i >= segs - 7 ? '#ffc400' : '#39d353';
      g.fillRect(i * (sw + gap), 0, sw, h);
    }
    g.globalAlpha = 1;
    if (mvu.peak > 0.02) { g.fillStyle = '#fff'; g.fillRect(Math.min(w - 2, mvu.peak * w - 1), 0, 2, h); }
  }
  const leds = { A: Array.from($('#leds-a').children), B: Array.from($('#leds-b').children) };
  const bars = { A: $('#bar-a'), B: $('#bar-b') };
  function drawBeats(id) {
    const info = decks[id].beatInfo();
    const b = info ? Math.floor(info.beat) : -1;
    leds[id].forEach((el, i) => el.classList.toggle('on', i === b));
    bars[id].textContent = info ? (info.bar + 1) + '.' + (b + 1) : '—';
  }
  const topStatus = $('#top-status');
  function frame() {
    Automix.tick();
    deckA.draw();
    deckB.draw();
    Mixer.draw();
    drawMaster();
    drawBeats('A'); drawBeats('B');
    if (Engine.recording) recBtn.textContent = '■ ' + Library.fmt((Date.now() - recStart) / 1000);
    const m = masterDeck();
    topStatus.textContent = m && m.track ? 'MASTER · DECK ' + m.id + ' · ' + (m.effectiveBpm() ? m.effectiveBpm().toFixed(1) + ' BPM' : '— BPM') + (m.track.camelot ? ' · ' + m.track.camelot + ' ' + m.track.key : '') : '';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.MixDeck = { deckA, deckB, Library, Engine, Mixer, SpotifyLink, Automix, Analyzer, Sources, Midi };
})();
