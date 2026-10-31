/* Automix: cola de pistas que se mezclan solas alternando los decks.
   Igualado de tempo y fase, crossfader automático, intercambio de graves,
   salto de silencios y vuelta suave al tempo original. */
const Automix = (() => {
  const KEY = 'mixdeck.automix';
  const EASE_MS = 8000;
  let decks = null, lib = null;
  const hooks = { toast() {}, loadTrack: () => Promise.resolve(), onChange() {} };
  const el = {};

  let queue = [];   // [{ id, played }]
  let libReady = false;
  const settings = { beats: 16, sync: true, bassSwap: true, keepTempo: false, skipSilence: true, useCues: true };
  const st = { running: false, active: null, current: null, next: null, loading: null, transition: null, ease: null };

  /* ---------- Persistencia ---------- */
  function save() {
    hooks.onChange();
    try { localStorage.setItem(KEY, JSON.stringify({ queue: queue.map(q => q.id), settings })); } catch (e) { /* sin espacio */ }
  }
  function restore() {
    let d = null;
    try { d = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { d = null; }
    if (!d) return;
    Object.assign(settings, d.settings || {});
    queue = (d.queue || []).map(id => ({ id, played: false }));
  }

  /* ---------- Cola ---------- */
  function add(ids) {
    let n = 0;
    for (const id of [].concat(ids)) {
      if (!lib.get(id)) continue;
      if (st.running && queue.some(q => q.id === id && !q.played)) continue;
      queue.push({ id, played: false });
      n++;
    }
    if (n) { save(); render(); if (st.running && !st.next) preloadNext(); }
    return n;
  }
  function remove(i) {
    const q = queue[i];
    if (!q) return;
    queue.splice(i, 1);
    if (st.next === q) { st.next = null; if (st.running) preloadNext(); }
    save(); render();
  }
  function move(i, d) {
    const j = i + d;
    if (i < 0 || j < 0 || i >= queue.length || j >= queue.length) return;
    [queue[i], queue[j]] = [queue[j], queue[i]];
    if (st.running && (st.next === queue[i] || st.next === queue[j] || st.next === null)) { st.next = null; preloadNext(); }
    save(); render();
  }
  function clear() { queue = []; st.next = null; save(); render(); }
  function shuffle() {
    const fixed = queue.filter(q => q.played || q === st.current);
    const rest = queue.filter(q => !q.played && q !== st.current);
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    queue = fixed.concat(rest);
    st.next = null;
    if (st.running) preloadNext();
    save(); render();
  }
  function resetPlayed() { queue.forEach(q => { q.played = false; }); render(); }

  function nextEntry() {
    const i = st.current ? queue.indexOf(st.current) : -1;
    for (let k = i + 1; k < queue.length; k++) if (!queue[k].played && queue[k] !== st.current) return queue[k];
    for (let k = 0; k < queue.length; k++) if (!queue[k].played && queue[k] !== st.current) return queue[k];
    return null;
  }
  const other = id => (id === 'A' ? 'B' : 'A');

  /* ---------- Control ---------- */
  async function start() {
    if (st.running) return;
    if (!queue.length) return hooks.toast('La cola de Automix está vacía. Agrega pistas con el botón +.');
    if (!queue.some(q => !q.played)) resetPlayed();
    st.running = true;
    st.transition = null; st.ease = null;
    const playing = decks.A.playing ? 'A' : decks.B.playing ? 'B' : null;
    if (playing) {
      st.active = playing;
      st.current = queue.find(q => q.id === decks[playing].track.id && !q.played) || null;
      if (st.current) st.current.played = true;
    } else {
      const first = nextEntry();
      st.active = decks.A.buffer && !decks.B.buffer ? 'B' : 'A';
      if (decks.A.track && decks.A.track.id === first.id) st.active = 'A';
      else if (decks.B.track && decks.B.track.id === first.id) st.active = 'B';
      const deck = decks[st.active];
      if (!deck.track || deck.track.id !== first.id) await hooks.loadTrack(lib.get(first.id), st.active);
      if (!st.running) return;
      if (!deck.buffer) { stop(); return hooks.toast('No se pudo cargar la primera pista de la cola.'); }
      st.current = first; first.played = true;
      deck.setPitch(0);
      deck.seek(startPosition(deck));
      Mixer.setXf(st.active === 'A' ? -1 : 1);
      deck.play();
    }
    render();
    preloadNext();
  }
  function stop() {
    st.running = false; st.transition = null; st.ease = null; st.next = null; st.loading = null;
    render();
  }
  function libraryReady() { libReady = true; render(); }
  /* El deck activo llegó al final de la pista sin que empezara una transición. */
  function onDeckEnded(deckId) {
    if (!st.running || st.transition || deckId !== st.active) return;
    if (nextEntry()) { beginTransition(true); return; }
    stop();
    hooks.toast('Automix terminó la cola.');
  }
  function skip() {
    if (!st.running || st.transition) return;
    beginTransition(true);
  }

  function startPosition(deck) {
    const t = settings.skipSilence ? deck.audioStart || 0 : 0;
    return Math.min(deck.beatAtOrAfter(t, true), Math.max(0, deck.duration - 1));
  }
  /* Punto de salida: el outro detectado por el análisis, o el final del audio. */
  function endPosition(deck) {
    const cues = deck.track && deck.track.cues;
    const end = settings.skipSilence && deck.audioEnd ? deck.audioEnd : deck.duration;
    if (settings.useCues && cues && cues.outro && cues.outro < end) return Math.min(end, cues.outro + transitionSecondsRaw(deck));
    return end;
  }
  function transitionSecondsRaw(deck) { return settings.beats * 60 / (deck.effectiveBpm() || 120); }
  function transitionSeconds(deck) {
    const bpm = deck.effectiveBpm() || 120;
    const s = settings.beats * 60 / bpm;
    const len = endPosition(deck) - startPosition(deck);
    return Math.max(1, Math.min(s, len / 3));
  }

  async function preloadNext() {
    if (!st.running) return;
    const entry = nextEntry();
    const deckId = other(st.active);
    const deck = decks[deckId];
    if (!entry) { st.next = null; render(); return; }
    if (st.next === entry && deck.track && deck.track.id === entry.id) return;
    if (deck.playing && deckId !== st.active) return; // el usuario lo está usando: esperamos
    if (st.loading === entry) return;
    st.loading = entry;
    render();
    if (!deck.track || deck.track.id !== entry.id) await hooks.loadTrack(lib.get(entry.id), deckId);
    if (st.loading !== entry) return;
    st.loading = null;
    if (!st.running) return;
    if (!deck.buffer || !deck.track || deck.track.id !== entry.id) {
      hooks.toast('Automix: no se pudo cargar "' + lib.get(entry.id).name + '", la salto.');
      entry.played = true;
      return preloadNext();
    }
    deck.setPitch(0);
    deck.seek(startPosition(deck));
    st.next = entry;
    render();
  }

  function beginTransition(forced) {
    const outId = st.active, incId = other(outId);
    const out = decks[outId], inc = decks[incId];
    const entry = st.next;
    if (!entry || !inc.buffer || !inc.track || inc.track.id !== entry.id) {
      if (!nextEntry()) return;        // no hay más: dejamos terminar la pista
      preloadNext();
      return;
    }
    if (!out.playing && forced && out.buffer) {
      // la saliente ya terminó: arrancamos la entrante sin crossfade progresivo
      inc.setPitch(0);
      inc.seek(startPosition(inc));
      inc.play();
      Mixer.setXf(incId === 'A' ? -1 : 1);
      Mixer.setEq(outId, 'low', 0);
      st.active = incId; st.current = entry; entry.played = true; st.next = null;
      render(); preloadNext();
      return;
    }
    const dur = transitionSeconds(out);
    let pos = startPosition(inc);
    const canSync = settings.sync && out.bpm && inc.bpm && out.playing;
    if (canSync) {
      let ratio = out.effectiveBpm() / inc.bpm;
      if (ratio > 1.4) ratio /= 2; else if (ratio < 0.7) ratio *= 2;
      inc.setPitch(Math.max(-inc.PITCH_RANGE, Math.min(inc.PITCH_RANGE, (ratio - 1) * 100)));
      const outBeat = 60 / out.bpm, incBeat = 60 / inc.bpm;
      const outBeats = (out.getPosition() - out.firstBeat) / outBeat;
      const beatInBar = ((outBeats % 4) + 4) % 4;
      pos = inc.beatAtOrAfter(pos, true) + beatInBar * incBeat;
    }
    inc.seek(pos);
    inc.play();
    if (settings.bassSwap) Mixer.setEq(incId, 'low', -24);
    st.transition = { t0: performance.now(), dur: dur * 1000, from: Mixer.getXf(), to: incId === 'A' ? -1 : 1, outId, incId, entry, outLow: Mixer.getEq(outId, 'low') };
    render();
  }

  function advanceTransition() {
    const tr = st.transition;
    const p = Math.min(1, (performance.now() - tr.t0) / tr.dur);
    Mixer.setXf(tr.from + (tr.to - tr.from) * p);
    if (settings.bassSwap) {
      const a = Math.max(0, Math.min(1, (p - 0.3) / 0.45));   // graves salientes: bajan entre 30 % y 75 %
      const b = Math.max(0, Math.min(1, (p - 0.25) / 0.5));   // graves entrantes: suben entre 25 % y 75 %
      Mixer.setEq(tr.outId, 'low', tr.outLow + (-24 - tr.outLow) * a);
      Mixer.setEq(tr.incId, 'low', -24 * (1 - b));
    }
    if (p >= 1) endTransition();
  }
  function endTransition() {
    const tr = st.transition;
    const out = decks[tr.outId], inc = decks[tr.incId];
    out.pause();
    out.setPitch(0);
    Mixer.setEq(tr.outId, 'low', 0);
    Mixer.setEq(tr.incId, 'low', 0);
    st.active = tr.incId;
    st.current = tr.entry; tr.entry.played = true;
    st.next = null;
    st.transition = null;
    if (!settings.keepTempo && Math.abs(inc.pitch) > 0.01) st.ease = { deck: inc, from: inc.pitch, t0: performance.now() };
    render();
    preloadNext();
  }
  function advanceEase() {
    const e = st.ease;
    const p = Math.min(1, (performance.now() - e.t0) / EASE_MS);
    e.deck.setPitch(e.from * (1 - p));
    if (p >= 1) { e.deck.setPitch(0); st.ease = null; }
  }

  let lastStatus = 0;
  function tick() {
    if (!st.running) return;
    if (st.transition) { advanceTransition(); return; }
    if (st.ease) advanceEase();
    const out = decks[st.active];
    if (!out.buffer || !out.playing) return;   // pausado por el usuario: esperamos
    const remaining = (endPosition(out) - out.getPosition()) / out.rate;
    if (remaining <= transitionSeconds(out)) beginTransition(false);
    else if (performance.now() - lastStatus > 500) { lastStatus = performance.now(); renderStatus(); }
  }

  /* ---------- UI ---------- */
  function build(mount, h, d, library) {
    Object.assign(hooks, h || {});
    decks = d; lib = library;
    restore();
    mount.innerHTML =
      '<div class="am-head">' +
        '<h2>Automix</h2><span class="am-status"></span>' +
        '<div class="am-actions">' +
          '<button class="btn primary am-start">▶ Iniciar</button>' +
          '<button class="btn am-skip hidden" title="Pasar ya a la siguiente">⏭</button>' +
          '<button class="btn am-stop hidden">■ Detener</button>' +
        '</div>' +
      '</div>' +
      '<div class="am-settings">' +
        '<label>Transición <select class="am-beats">' +
          [4, 8, 16, 32, 64].map(b => '<option value="' + b + '"' + (b === settings.beats ? ' selected' : '') + '>' + b + ' beats</option>').join('') +
        '</select></label>' +
        '<label><input type="checkbox" class="am-sync"' + (settings.sync ? ' checked' : '') + '> Igualar tempo y fase</label>' +
        '<label><input type="checkbox" class="am-bass"' + (settings.bassSwap ? ' checked' : '') + '> Intercambio de graves</label>' +
        '<label><input type="checkbox" class="am-skipsil"' + (settings.skipSilence ? ' checked' : '') + '> Saltar silencios</label>' +
        '<label><input type="checkbox" class="am-keep"' + (settings.keepTempo ? ' checked' : '') + '> Mantener el tempo igualado</label>' +
        '<label><input type="checkbox" class="am-cues"' + (settings.useCues ? ' checked' : '') + '> Mezclar en el outro detectado</label>' +
      '</div>' +
      '<div class="am-tools">' +
        '<button class="btn ghost am-all">+ Toda la biblioteca</button>' +
        '<button class="btn ghost am-shuffle">Orden aleatorio</button>' +
        '<button class="btn ghost am-reset">Marcar todas como no tocadas</button>' +
        '<button class="btn ghost am-clear">Vaciar</button>' +
      '</div>' +
      '<ol class="am-queue"></ol>' +
      '<p class="am-hint">Arrastra pistas de la biblioteca aquí, o usa el botón + de cada fila. Mantén los faders de canal arriba: Automix mueve solo el crossfader y los graves.</p>';

    const q = s => mount.querySelector(s);
    el.mount = mount; el.status = q('.am-status'); el.queue = q('.am-queue');
    el.start = q('.am-start'); el.stop = q('.am-stop'); el.skip = q('.am-skip');
    el.start.addEventListener('click', start);
    el.stop.addEventListener('click', stop);
    el.skip.addEventListener('click', skip);
    q('.am-beats').addEventListener('change', e => { settings.beats = +e.target.value; save(); });
    q('.am-sync').addEventListener('change', e => { settings.sync = e.target.checked; save(); });
    q('.am-bass').addEventListener('change', e => { settings.bassSwap = e.target.checked; save(); });
    q('.am-skipsil').addEventListener('change', e => { settings.skipSilence = e.target.checked; save(); });
    q('.am-keep').addEventListener('change', e => { settings.keepTempo = e.target.checked; save(); });
    q('.am-cues').addEventListener('change', e => { settings.useCues = e.target.checked; save(); });
    q('.am-all').addEventListener('click', () => {
      const ids = lib.tracks.filter(t => !t.error && !queue.some(x => x.id === t.id)).map(t => t.id);
      if (!add(ids)) hooks.toast('No hay pistas nuevas que agregar.');
    });
    q('.am-shuffle').addEventListener('click', shuffle);
    q('.am-reset').addEventListener('click', resetPlayed);
    q('.am-clear').addEventListener('click', clear);
    el.queue.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const i = +b.closest('li').dataset.i;
      if (b.dataset.act === 'up') move(i, -1);
      else if (b.dataset.act === 'down') move(i, 1);
      else if (b.dataset.act === 'del') remove(i);
    });
    mount.addEventListener('dragover', e => { e.preventDefault(); mount.classList.add('drop'); });
    mount.addEventListener('dragleave', () => mount.classList.remove('drop'));
    mount.addEventListener('drop', e => {
      e.preventDefault(); mount.classList.remove('drop');
      const id = e.dataTransfer.getData('text/mixdeck-id');
      if (id) add([id]);
      else if (e.dataTransfer.files && e.dataTransfer.files.length) add(lib.addFiles(e.dataTransfer.files).map(t => t.id));
    });
    render();
  }

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function render() {
    if (!el.mount) return;
    el.mount.classList.toggle('running', st.running);
    el.start.classList.toggle('hidden', st.running);
    el.stop.classList.toggle('hidden', !st.running);
    el.skip.classList.toggle('hidden', !st.running);
    if (libReady) queue = queue.filter(q => lib.get(q.id));
    el.queue.innerHTML = queue.filter(q => lib.get(q.id)).map((q, i) => {
      const t = lib.get(q.id);
      const state = q === st.current && st.running ? '▶ ' + st.active
        : q === st.next ? '⏭ ' + other(st.active)
        : q === st.loading ? 'cargando…'
        : q.played ? '✓' : '';
      const cls = q === st.current && st.running ? 'active' : q === st.next ? 'next' : q.played ? 'played' : '';
      return '<li class="' + cls + '" data-i="' + i + '">' +
        '<span class="am-n">' + (i + 1) + '</span>' +
        '<span class="am-name" title="' + esc(t.name) + '">' + esc(t.name) + (t.artist ? ' <small>' + esc(t.artist) + '</small>' : '') + '</span>' +
        '<span class="am-meta">' + (t.bpm ? t.bpm + ' bpm' : '— bpm') + (t.camelot ? ' · ' + t.camelot : '') + ' · ' + lib.fmt(t.duration || 0) + '</span>' +
        '<span class="am-state">' + state + '</span>' +
        '<button data-act="up" title="Subir">↑</button><button data-act="down" title="Bajar">↓</button><button data-act="del" title="Quitar">×</button>' +
      '</li>';
    }).join('');
    renderStatus();
  }
  function renderStatus() {
    if (!el.status) return;
    if (!st.running) {
      const pend = queue.filter(q => !q.played).length;
      el.status.textContent = queue.length ? queue.length + ' en cola · ' + pend + ' por tocar' : 'Cola vacía';
      return;
    }
    const out = decks[st.active];
    let txt = 'Sonando en ' + st.active;
    if (st.transition) txt = 'Mezclando ' + st.transition.outId + ' → ' + st.transition.incId;
    else if (out.buffer && out.playing) {
      const remaining = (endPosition(out) - out.getPosition()) / out.rate - transitionSeconds(out);
      txt += ' · mezcla en ' + lib.fmt(Math.max(0, remaining));
      if (!st.next) txt += nextEntry() ? ' · preparando siguiente…' : ' · última de la cola';
    } else if (out.buffer) txt += ' (pausado)';
    el.status.textContent = txt;
  }

  return { build, tick, add, start, stop, skip, libraryReady, onDeckEnded, settings, get running() { return st.running; }, get queue() { return queue; }, get state() { return st; } };
})();
