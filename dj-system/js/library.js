/* Colección: archivos locales, etiquetas, análisis automático y persistencia en IndexedDB.
   Navegador con columnas ordenables, búsqueda y compatibilidad de tonalidad. */
const Library = (() => {
  const DB_NAME = 'mixdeck';
  const STORE = 'tracks';
  const SOURCES = 'sources';
  const DB_VERSION = 2;
  const MAX_DECODED = 8;

  let db = null;
  let tbody = null, statusEl = null, searchEl = null, countEl = null;
  const tracks = [];
  const decoded = new Map();
  const coverUrls = new Map();
  const listeners = { change: [], load: [] };
  const queue = [];
  let analyzing = false, analyzingNow = null, stageNow = '';
  let addSeq = 0;
  let sortKey = 'added', sortDir = 1, filter = '', sourceFilter = null, selectedId = null;
  const hooks = { masterCamelot: () => null };

  const uid = () => (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));

  /* ---- IndexedDB ---- */
  function openDB() {
    return new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return resolve(null); }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        if (!d.objectStoreNames.contains(SOURCES)) d.createObjectStore(SOURCES, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  function tx(mode, fn, store) {
    return new Promise(resolve => {
      if (!db) return resolve(null);
      let t;
      try { t = db.transaction(store || STORE, mode); } catch (e) { return resolve(null); }
      const req = fn(t.objectStore(store || STORE));
      t.oncomplete = () => resolve(req ? req.result : null);
      t.onerror = () => resolve(null);
      t.onabort = () => resolve(null);
    });
  }
  const toRecord = t => ({
    id: t.id, name: t.name, artist: t.artist, album: t.album, cover: t.cover, blob: t.blob, added: t.added,
    duration: t.duration, bpm: t.bpm, firstBeat: t.firstBeat, key: t.key, camelot: t.camelot,
    gainDb: t.gainDb, energy: t.energy, audioStart: t.audioStart, audioEnd: t.audioEnd,
    bands: t.bands, cues: t.cues, analysisVersion: t.analysisVersion, error: !!t.error,
    source: t.source || null, missing: !!t.missing
  });
  const dbPut = t => tx('readwrite', s => s.put(toRecord(t)));
  const dbDelete = id => tx('readwrite', s => s.delete(id));
  const dbClear = () => tx('readwrite', s => s.clear());
  const dbAll = () => tx('readonly', s => s.getAll()).then(r => r || []);
  const listSources = () => tx('readonly', s => s.getAll(), SOURCES).then(r => (r || []).sort((a, b) => (a.added || 0) - (b.added || 0)));
  const putSource = src => tx('readwrite', s => s.put(src), SOURCES);
  const deleteSource = id => tx('readwrite', s => s.delete(id), SOURCES);

  /* ---- API ---- */
  async function init(opts) {
    tbody = opts.tbody; statusEl = opts.status; searchEl = opts.search; countEl = opts.count;
    Object.assign(hooks, opts.hooks || {});
    db = await openDB();
    const stored = await dbAll();
    stored.sort((a, b) => (a.added || 0) - (b.added || 0));
    for (const rec of stored) {
      rec.analyzing = false;
      tracks.push(rec);
      if (!rec.error && rec.analysisVersion !== Analyzer.VERSION) enqueue(rec);
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

  /* Agrega archivos de inmediato (nombre provisional) y los analiza en segundo plano. */
  function addFiles(fileList) {
    const files = Array.from(fileList || []).filter(isAudio);
    const added = [];
    for (const file of files) {
      const rec = {
        id: uid(), name: file.name.replace(/\.[^.]+$/, ''), artist: '', album: '', cover: null, blob: file,
        duration: 0, bpm: null, firstBeat: 0, key: null, camelot: null, gainDb: 0, energy: null,
        audioStart: 0, audioEnd: 0, bands: null, cues: null, analysisVersion: 0,
        added: Date.now() * 1000 + (addSeq++ % 1000), analyzing: true
      };
      tracks.push(rec);
      added.push(rec);
      Tags.read(file).then(tags => {
        rec.name = tags.title || rec.name; rec.artist = tags.artist || ''; rec.album = tags.album || '';
        rec.cover = tags.cover || null; rec.tagBpm = tags.bpm; rec.tagKey = tags.key;
        render();
      });
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
      analyzingNow = rec; stageNow = 'decodificando';
      render();
      try {
        if (!decoded.has(rec.id) && (rec.tagsPending || (rec.source && rec.source.cache && !rec.blob))) {
          stageNow = rec.source && rec.source.driveId ? 'descargando' : 'leyendo';
          renderStatus();
          const file = await fileOf(rec);
          if (rec.tagsPending) await readTags(rec, file);
          if (rec.source && rec.source.cache && !rec.blob) rec.blob = file;   // copia local para no volver a descargar
        }
        const buf = await decode(rec);
        const a = await Analyzer.analyze(buf, s => { stageNow = s; renderStatus(); });
        Object.assign(rec, {
          duration: a.duration, bpm: a.bpm, firstBeat: a.firstBeat, key: a.key, camelot: a.camelot,
          gainDb: a.gainDb, energy: a.energy, audioStart: a.audioStart, audioEnd: a.audioEnd,
          bands: a.bands, cues: a.cues, analysisVersion: a.version, error: false
        });
        if (!rec.bpm && rec.tagBpm) rec.bpm = rec.tagBpm;
      } catch (e) {
        if (e && e.friendly) { rec.missing = true; }
        else { console.warn('No se pudo analizar', rec.name, e); rec.error = true; }
      }
      rec.analyzing = false;
      analyzingNow = null;
      await dbPut(rec);
      render();
      emit('change', rec);
    }
    analyzing = false;
    render();
  }

  async function fileOf(rec) {
    if (rec.blob) return rec.blob;
    if (rec.source) return Sources.getFile(rec.source);
    const e = new Error('La pista no tiene archivo asociado.'); e.friendly = true; throw e;
  }
  async function decode(rec) {
    if (decoded.has(rec.id)) return decoded.get(rec.id);
    const file = await fileOf(rec);
    const ab = await file.arrayBuffer();
    const buf = await Engine.ctx.decodeAudioData(ab);
    if (decoded.size >= MAX_DECODED) decoded.delete(decoded.keys().next().value);
    decoded.set(rec.id, buf);
    return buf;
  }

  /* Sincroniza la colección con el contenido actual de una carpeta vinculada. */
  async function syncSource(sourceId, sourceName, files, opts) {
    const cache = !!(opts && opts.cache);
    const byPath = new Map();
    for (const t of tracks) if (t.source && t.source.id === sourceId) byPath.set(t.source.path, t);
    let added = 0;
    const seen = new Set();
    for (const en of files) {
      const { path, file } = en;
      const size = en.size != null ? en.size : (file ? file.size : 0);
      const mtime = en.mtime != null ? en.mtime : (file ? file.lastModified : 0);
      const fname = en.name || (file ? file.name : path.split('/').pop());
      seen.add(path);
      const prev = byPath.get(path);
      if (prev) {
        const changed = prev.source.size !== size || prev.source.mtime !== mtime;
        prev.missing = false;
        if (en.driveId) prev.source.driveId = en.driveId;
        if (changed) {
          prev.source.size = size; prev.source.mtime = mtime;
          decoded.delete(prev.id); prev.blob = null; prev.tagsPending = true;
          if (file) readTags(prev, file);
          enqueue(prev);
        } else if (!prev.error && prev.analysisVersion !== Analyzer.VERSION && !prev.analyzing) enqueue(prev);
        continue;
      }
      const rec = {
        id: uid(), name: fname.replace(/\.[^.]+$/, ''), artist: '', album: '', cover: null, blob: null,
        source: { id: sourceId, path, size, mtime, driveId: en.driveId || null, cache },
        duration: 0, bpm: null, firstBeat: 0, key: null, camelot: null, gainDb: 0, energy: null,
        audioStart: 0, audioEnd: 0, bands: null, cues: null, analysisVersion: 0, missing: false,
        added: Date.now() * 1000 + (addSeq++ % 1000), analyzing: true, tagsPending: true
      };
      tracks.push(rec);
      added++;
      if (file) readTags(rec, file);
      enqueue(rec);
    }
    let missing = 0;
    for (const [path, t] of byPath) if (!seen.has(path)) { t.missing = true; missing++; }
    for (const t of tracks) if (t.source && t.source.id === sourceId) await dbPut(t);
    render();
    return { added, missing, total: files.length };
  }
  function readTags(rec, file) {
    rec.tagsPending = false;
    return Tags.read(file).then(tags => {
      rec.name = tags.title || rec.name; rec.artist = tags.artist || rec.artist || ''; rec.album = tags.album || rec.album || '';
      rec.cover = tags.cover || rec.cover || null; rec.tagBpm = tags.bpm;
      dbPut(rec); render();
    });
  }
  function countBySource(id) { return tracks.filter(t => t.source && t.source.id === id).length; }
  async function removeBySource(id) {
    for (const t of tracks.filter(t => t.source && t.source.id === id)) {
      const i = tracks.indexOf(t);
      tracks.splice(i, 1);
      decoded.delete(t.id);
      await dbDelete(t.id);
    }
    render();
  }
  function setSourceFilter(id) { sourceFilter = id; render(); }

  async function updateBpm(rec, bpm, firstBeat) {
    rec.bpm = bpm;
    if (firstBeat != null) rec.firstBeat = firstBeat;
    await dbPut(rec);
    render();
  }
  async function reanalyze(id) {
    const rec = get(id);
    if (!rec || rec.analyzing) return;
    rec.error = false;
    enqueue(rec);
    render();
  }
  async function remove(id) {
    const i = tracks.findIndex(t => t.id === id);
    if (i < 0) return;
    tracks.splice(i, 1);
    decoded.delete(id);
    if (coverUrls.has(id)) { URL.revokeObjectURL(coverUrls.get(id)); coverUrls.delete(id); }
    await dbDelete(id);
    render();
  }
  async function clear() {
    tracks.length = 0;
    decoded.clear();
    await dbClear();
    render();
  }
  function coverUrl(rec) {
    if (!rec || !rec.cover) return null;
    if (!coverUrls.has(rec.id)) coverUrls.set(rec.id, URL.createObjectURL(rec.cover));
    return coverUrls.get(rec.id);
  }

  /* ---- UI ---- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = s => { const m = Math.floor(s / 60), sec = Math.floor(s % 60); return m + ':' + String(sec).padStart(2, '0'); };
  const fmtBpm = b => (b % 1 ? b.toFixed(1) : String(b));

  function visibleTracks() {
    const q = filter.trim().toLowerCase();
    let list = q ? tracks.filter(t => (t.name + ' ' + (t.artist || '') + ' ' + (t.album || '')).toLowerCase().includes(q)) : tracks.slice();
    if (sourceFilter) list = list.filter(t => t.source && t.source.id === sourceFilter);
    const cmp = {
      added: (a, b) => a.added - b.added,
      name: (a, b) => a.name.localeCompare(b.name),
      artist: (a, b) => (a.artist || '').localeCompare(b.artist || ''),
      bpm: (a, b) => (a.bpm || 0) - (b.bpm || 0),
      key: (a, b) => camelotOrder(a.camelot) - camelotOrder(b.camelot),
      duration: (a, b) => (a.duration || 0) - (b.duration || 0),
      energy: (a, b) => (a.energy || 0) - (b.energy || 0)
    }[sortKey] || ((a, b) => 0);
    list.sort((a, b) => cmp(a, b) * sortDir);
    return list;
  }
  function camelotOrder(c) { return c ? parseInt(c, 10) * 2 + (c.endsWith('B') ? 1 : 0) : 99; }

  function keyBadge(t) {
    if (!t.camelot) return '<span class="key-badge empty">—</span>';
    const compat = Analyzer.compatible(t.camelot, hooks.masterCamelot());
    return '<span class="key-badge' + (compat ? ' compat' : '') + '" style="--kc:' + Analyzer.camelotColor(t.camelot) + '" title="' + esc(t.key) + (compat ? ' · compatible con la pista maestra' : '') + '">' + t.camelot + '</span>';
  }
  function energyBar(e) {
    if (!e) return '<span class="energy empty">—</span>';
    return '<span class="energy" title="Energía ' + e + '/10"><i style="width:' + (e * 10) + '%"></i><b>' + e + '</b></span>';
  }

  function render() {
    if (!tbody) return;
    const master = hooks.masterCamelot();
    tbody.innerHTML = visibleTracks().map(t => {
      const cover = coverUrl(t);
      const bpm = t.analyzing ? '<span class="analyzing">…</span>' : t.error ? '<span class="err">error</span>' : t.bpm ? fmtBpm(t.bpm) : '—';
      const src = t.source ? '<span class="t-src" title="' + esc(Sources.nameOf(t.source.id)) + ' · ' + esc(t.source.path) + '">' + (t.missing ? '⊘' : '▮') + '</span>' : '';
      return '<tr data-id="' + t.id + '" draggable="true" class="' + (t.error ? 'row-err' : '') + (t.analyzing ? ' row-analyzing' : '') + (t.missing ? ' row-missing' : '') + (t.id === selectedId ? ' selected' : '') + '">' +
        '<td class="t-art">' + (cover ? '<img src="' + cover + '" alt="" loading="lazy">' : '<span class="art-empty"></span>') + '</td>' +
        '<td class="t-name"><div class="t-title" title="' + esc(t.name) + (t.missing ? ' (no conectado)' : '') + '">' + src + esc(t.name) + '</div></td>' +
        '<td class="t-artist" title="' + esc(t.artist) + '">' + esc(t.artist || '—') + '</td>' +
        '<td class="t-bpm">' + bpm + '</td>' +
        '<td class="t-key">' + keyBadge(t) + '</td>' +
        '<td class="t-dur">' + (t.duration ? fmt(t.duration) : '—') + '</td>' +
        '<td class="t-energy">' + energyBar(t.energy) + '</td>' +
        '<td class="t-act">' +
          '<button class="load-a" data-act="A" title="Cargar en Deck A">A</button>' +
          '<button class="load-b" data-act="B" title="Cargar en Deck B">B</button>' +
          '<button class="queue" data-act="Q" title="Agregar a la cola de Automix">+</button>' +
          '<button class="more" data-act="re" title="Volver a analizar">↻</button>' +
          '<button class="del" data-act="del" title="Quitar de la colección">×</button>' +
        '</td></tr>';
    }).join('');
    if (countEl) countEl.textContent = tracks.length ? tracks.length + (tracks.length === 1 ? ' pista' : ' pistas') : '';
    renderStatus();
    document.querySelectorAll('.lib-table th[data-sort]').forEach(th => {
      th.classList.toggle('asc', th.dataset.sort === sortKey && sortDir === 1);
      th.classList.toggle('desc', th.dataset.sort === sortKey && sortDir === -1);
    });
  }
  function renderStatus() {
    if (!statusEl) return;
    if (analyzingNow) {
      const left = queue.length;
      statusEl.textContent = 'Analizando ' + analyzingNow.name + ' (' + stageNow + ')' + (left ? ' · ' + left + ' en espera' : '');
      statusEl.classList.add('busy');
    } else {
      statusEl.textContent = tracks.length ? 'Colección analizada' : 'Sin pistas. Agrega archivos MP3, WAV, OGG, FLAC o M4A.';
      statusEl.classList.remove('busy');
    }
  }

  function selected() { return get(selectedId); }
  function selectRelative(d) {
    const list = visibleTracks();
    if (!list.length) return;
    let i = list.findIndex(t => t.id === selectedId);
    i = i < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d));
    selectedId = list[i].id;
    render();
    const row = tbody.querySelector('tr.selected');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }
  function bindTable() {
    tbody.addEventListener('click', e => {
      const tr = e.target.closest('tr');
      if (tr && tr.dataset.id && !e.target.closest('button')) { selectedId = tr.dataset.id; tbody.querySelectorAll('tr.selected').forEach(x => x.classList.remove('selected')); tr.classList.add('selected'); }
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('tr').dataset.id;
      const act = btn.dataset.act;
      if (act === 'del') remove(id);
      else if (act === 're') reanalyze(id);
      else emit('load', get(id), act);
    });
    tbody.addEventListener('dblclick', e => {
      const tr = e.target.closest('tr');
      if (tr && !e.target.closest('button')) emit('load', get(tr.dataset.id), 'auto');
    });
    tbody.addEventListener('dragstart', e => {
      const tr = e.target.closest('tr');
      if (!tr) return;
      e.dataTransfer.setData('text/mixdeck-id', tr.dataset.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    const table = tbody.closest('table');
    table.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
      if (sortKey === th.dataset.sort) sortDir = -sortDir; else { sortKey = th.dataset.sort; sortDir = 1; }
      render();
    }));
    if (searchEl) searchEl.addEventListener('input', () => { filter = searchEl.value; render(); });
  }

  return { init, on, get, addFiles, decode, updateBpm, reanalyze, remove, clear, coverUrl, render, tracks, fmt,
    listSources, putSource, deleteSource, syncSource, countBySource, removeBySource, setSourceFilter, selected, selectRelative };
})();
