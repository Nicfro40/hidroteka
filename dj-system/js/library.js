/* Biblioteca de pistas: archivos locales, decodificación, análisis de BPM y persistencia en IndexedDB. */
const Library = (() => {
  const DB_NAME = 'mixdeck';
  const STORE = 'tracks';
  const MAX_DECODED = 8;

  let db = null;
  let tbody = null;
  let statusEl = null;
  const tracks = [];
  const decoded = new Map();
  const listeners = { change: [], load: [] };
  const queue = [];
  let analyzing = false;
  let addSeq = 0;

  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));

  /* ---- IndexedDB ---- */
  function openDB() {
    return new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  function tx(mode, fn) {
    return new Promise(resolve => {
      if (!db) return resolve(null);
      let t;
      try { t = db.transaction(STORE, mode); } catch (e) { return resolve(null); }
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req ? req.result : null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    });
  }
  const toRecord = t => ({ id: t.id, name: t.name, blob: t.blob, duration: t.duration,
    bpm: t.bpm, firstBeat: t.firstBeat, added: t.added });
  const dbPut = t => tx('readwrite', s => s.put(toRecord(t)));
  const dbDelete = id => tx('readwrite', s => s.delete(id));
  const dbClear = () => tx('readwrite', s => s.clear());
  const dbAll = () => tx('readonly', s => s.getAll()).then(r => r || []);

  /* ---- API ---- */
  async function init(opts) {
    tbody = opts.tbody;
    statusEl = opts.status;
    db = await openDB();
    const stored = await dbAll();
    stored.sort((a, b) => (a.added || 0) - (b.added || 0));
    for (const rec of stored) {
      rec.analyzing = false;
      tracks.push(rec);
      if (!rec.bpm && !rec.duration) enqueue(rec);
    }
    bindTable();
    render();
  }

  function on(evt, fn) { listeners[evt].push(fn); }
  const emit = (evt, ...a) => listeners[evt].forEach(fn => fn(...a));

  function get(id) { return tracks.find(t => t.id === id) || null; }

  function isAudio(f) {
    return (f.type && f.type.startsWith('audio/')) || /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|opus|aif|aiff)$/i.test(f.name);
  }

  /* Agrega archivos de inmediato y analiza en segundo plano. Devuelve los registros creados. */
  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(isAudio);
    const added = [];
    for (const file of files) {
      const rec = {
        id: uid(), name: file.name.replace(/\.[^.]+$/, ''), blob: file,
        duration: 0, bpm: null, firstBeat: 0, added: Date.now() * 1000 + (addSeq++ % 1000), analyzing: true
      };
      tracks.push(rec);
      added.push(rec);
      enqueue(rec);
    }
    render();
    return added;
  }

  function enqueue(rec) {
    rec.analyzing = true;
    queue.push(rec);
    pump();
  }

  async function pump() {
    if (analyzing) return;
    analyzing = true;
    while (queue.length) {
      const rec = queue.shift();
      try {
        const buf = await decode(rec);
        rec.duration = buf.duration;
        const r = await BPMDetector.analyze(buf);
        rec.bpm = r.bpm;
        rec.firstBeat = r.firstBeat;
        rec.error = false;
      } catch (e) {
        console.warn('No se pudo analizar', rec.name, e);
        rec.error = true;
      }
      rec.analyzing = false;
      await dbPut(rec);
      render();
      emit('change', rec);
    }
    analyzing = false;
    render();
  }

  async function decode(rec) {
    if (decoded.has(rec.id)) return decoded.get(rec.id);
    const ab = await rec.blob.arrayBuffer();
    const buf = await Engine.ctx.decodeAudioData(ab);
    if (decoded.size >= MAX_DECODED) decoded.delete(decoded.keys().next().value);
    decoded.set(rec.id, buf);
    return buf;
  }

  async function updateBpm(rec, bpm, firstBeat) {
    rec.bpm = bpm;
    if (firstBeat != null) rec.firstBeat = firstBeat;
    await dbPut(rec);
    render();
  }

  async function remove(id) {
    const i = tracks.findIndex(t => t.id === id);
    if (i < 0) return;
    tracks.splice(i, 1);
    decoded.delete(id);
    await dbDelete(id);
    render();
  }

  async function clear() {
    tracks.length = 0;
    decoded.clear();
    await dbClear();
    render();
  }

  /* ---- UI ---- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = s => {
    const m = Math.floor(s / 60), sec = Math.floor(s % 60);
    return m + ':' + String(sec).padStart(2, '0');
  };
  const fmtBpm = b => (b % 1 ? b.toFixed(1) : String(b));

  function render() {
    if (!tbody) return;
    tbody.innerHTML = tracks.map(t => {
      const bpm = t.analyzing ? '<span class="analyzing">analizando…</span>'
        : t.error ? '<span class="err">error</span>'
        : t.bpm ? fmtBpm(t.bpm) : '—';
      return '<tr data-id="' + t.id + '" draggable="true"' + (t.error ? ' class="row-err"' : '') + '>' +
        '<td class="t-name" title="' + esc(t.name) + '">' + esc(t.name) + '</td>' +
        '<td class="t-dur">' + (t.duration ? fmt(t.duration) : '—') + '</td>' +
        '<td class="t-bpm">' + bpm + '</td>' +
        '<td class="t-act">' +
          '<button class="load-a" data-act="A" title="Cargar en Deck A">A</button>' +
          '<button class="load-b" data-act="B" title="Cargar en Deck B">B</button>' +
          '<button class="del" data-act="del" title="Quitar de la biblioteca">×</button>' +
        '</td></tr>';
    }).join('');
    if (statusEl) {
      statusEl.textContent = tracks.length
        ? tracks.length + (tracks.length === 1 ? ' pista' : ' pistas') + (analyzing || queue.length ? ' · analizando BPM…' : '')
        : 'Sin pistas. Agrega archivos MP3, WAV, OGG, FLAC o M4A.';
    }
  }

  function bindTable() {
    if (!tbody) return;
    tbody.addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('tr').dataset.id;
      const act = btn.dataset.act;
      if (act === 'del') remove(id);
      else emit('load', get(id), act);
    });
    tbody.addEventListener('dragstart', e => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      e.dataTransfer.setData('text/mixdeck-id', tr.dataset.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
  }

  return { init, on, get, addFiles, decode, updateBpm, remove, clear, tracks, fmt };
})();
