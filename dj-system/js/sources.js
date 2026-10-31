/* Fuentes: carpetas y pendrives vinculados (File System Access API). La app recuerda la
   carpeta entre sesiones, la vuelve a leer al iniciar y detecta pistas nuevas o faltantes.
   Los archivos no se copian: se leen desde la carpeta cuando hace falta. */
const Sources = (() => {
  const RECHECK_MS = 20000;
  let sources = [];   // { id, name, handle, kind, status, count, added }
  let el = null;
  const hooks = { toast() {}, onChange() {}, onSelect() {} };
  const fileCache = new Map();   // id+path → File (transitorio, para no releer durante el análisis)

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const supported = () => typeof window.showDirectoryPicker === 'function';
  const isAudio = name => /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|opus|aif|aiff)$/i.test(name);
  const guessKind = name => /^(usb|pen|kingston|sandisk|lexar|verbatim|rekordbox|cdj|dj)/i.test(name) || /^[A-Z]:?$/.test(name) ? 'usb' : 'folder';

  /* ---------- Ciclo de vida ---------- */
  async function init(mount, h) {
    Object.assign(hooks, h || {});
    el = mount;
    sources = (await Library.listSources()).map(s => Object.assign(s, { status: 'checking', count: Library.countBySource(s.id) }));
    render();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    for (const src of sources) check(src, false);
    setInterval(() => { for (const src of sources) if (src.status === 'missing') check(src, false); }, RECHECK_MS);
  }

  async function link() {
    if (!supported()) return hooks.toast('Este navegador no permite vincular carpetas. Usa "Importar carpeta" para copiar las pistas.');
    let handle;
    try { handle = await window.showDirectoryPicker({ mode: 'read' }); }
    catch (e) { if (e && e.name !== 'AbortError') hooks.toast('No se pudo abrir la carpeta: ' + e.message); return; }
    return linkHandle(handle);
  }
  async function linkHandle(handle) {
    for (const s of sources) {
      if (s.handle && handle.isSameEntry && await s.handle.isSameEntry(handle).catch(() => false)) {
        hooks.toast('Esa carpeta ya está vinculada.');
        return scan(s);
      }
    }
    const src = { id: uid(), name: handle.name || 'Carpeta', handle, kind: guessKind(handle.name || ''), added: Date.now(), status: 'scanning', count: 0 };
    sources.push(src);
    await Library.putSource({ id: src.id, name: src.name, handle, kind: src.kind, added: src.added });
    render();
    await scan(src);
    return src;
  }
  async function unlink(id) {
    const i = sources.findIndex(s => s.id === id);
    if (i < 0) return;
    const src = sources[i];
    const ok = await Dialogs.confirm('¿Desvincular «' + src.name + '»?', 'Sus ' + src.count + ' pistas y su análisis se quitan de la colección. Los archivos no se tocan.', 'Desvincular');
    if (!ok) return;
    sources.splice(i, 1);
    await Library.deleteSource(id);
    await Library.removeBySource(id);
    render();
    hooks.onChange();
  }

  /* Comprueba permiso y presencia; con `interactive` pide el permiso (requiere un clic). */
  async function check(src, interactive) {
    try {
      let p = 'granted';
      if (src.handle.queryPermission) p = await src.handle.queryPermission({ mode: 'read' });
      if (p === 'prompt' && interactive && src.handle.requestPermission) p = await src.handle.requestPermission({ mode: 'read' });
      if (p !== 'granted') { src.status = 'prompt'; render(); return false; }
      await scan(src);
      return true;
    } catch (e) {
      src.status = 'missing';
      render();
      return false;
    }
  }

  async function scan(src) {
    src.status = 'scanning';
    render();
    const entries = [];
    try {
      await walk(src.handle, '', entries, 0);
    } catch (e) {
      src.status = 'missing';
      render();
      return;
    }
    const files = [];
    for (const en of entries) {
      try {
        const f = await en.handle.getFile();
        files.push({ path: en.path, file: f });
        fileCache.set(src.id + '\n' + en.path, f);
      } catch (e) { /* archivo inaccesible: se trata como faltante */ }
    }
    const r = await Library.syncSource(src.id, src.name, files);
    src.count = r.total;
    src.status = 'ok';
    render();
    if (r.added) hooks.toast('«' + src.name + '»: ' + r.added + (r.added === 1 ? ' pista nueva' : ' pistas nuevas') + ' en análisis.');
    hooks.onChange();
  }
  async function walk(dir, prefix, out, depth) {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.') || name === 'System Volume Information' || name === '$RECYCLE.BIN') continue;
      if (h.kind === 'file') { if (isAudio(name)) out.push({ path: prefix + name, handle: h }); }
      else if (depth < 8) await walk(h, prefix + name + '/', out, depth + 1);
    }
  }

  /* Devuelve el File de una pista vinculada, leyéndolo desde la carpeta. */
  async function getFile(ref) {
    const key = ref.id + '\n' + ref.path;
    if (fileCache.has(key)) { const f = fileCache.get(key); fileCache.delete(key); return f; }
    const src = sources.find(s => s.id === ref.id);
    if (!src) throw friendly('Esta pista estaba en una carpeta que ya no está vinculada.');
    try {
      const parts = ref.path.split('/');
      let dir = src.handle;
      for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
      const fh = await dir.getFileHandle(parts[parts.length - 1]);
      return await fh.getFile();
    } catch (e) {
      if (src.status === 'ok') { src.status = 'missing'; render(); }
      throw friendly('«' + src.name + '» no está conectado: no se puede leer "' + ref.path + '".');
    }
  }
  function friendly(msg) { const e = new Error(msg); e.friendly = true; return e; }
  function nameOf(id) { const s = sources.find(x => x.id === id); return s ? s.name : 'carpeta'; }

  /* ---------- UI ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function render() {
    if (!el) return;
    const items = sources.map(s => {
      const st = s.status === 'ok' ? '<i class="src-dot ok" title="Conectada"></i>'
        : s.status === 'scanning' ? '<i class="src-dot busy" title="Leyendo…"></i>'
        : s.status === 'prompt' ? '<i class="src-dot warn" title="Toca para dar permiso"></i>'
        : s.status === 'missing' ? '<i class="src-dot off" title="No conectada"></i>'
        : '<i class="src-dot" title="Comprobando…"></i>';
      const hint = s.status === 'prompt' ? 'toca para reconectar' : s.status === 'missing' ? 'no conectado' : s.status === 'scanning' ? 'leyendo…' : (s.count + (s.count === 1 ? ' pista' : ' pistas'));
      return '<div class="src-item' + (s.status === 'ok' ? '' : ' src-' + s.status) + '" data-id="' + s.id + '">' +
        '<button class="src-main" data-act="open" title="' + esc(s.name) + '">' + st +
          '<span class="src-icon">' + (s.kind === 'usb' ? '▮' : '▭') + '</span>' +
          '<span class="src-name">' + esc(s.name) + '</span><em>' + esc(hint) + '</em></button>' +
        '<button class="src-btn" data-act="rescan" title="Volver a leer la carpeta">↻</button>' +
        '<button class="src-btn" data-act="unlink" title="Desvincular">×</button>' +
      '</div>';
    }).join('');
    el.innerHTML =
      '<div class="tree-title">FUENTES</div>' + items +
      (supported()
        ? '<button class="tree-item src-link"><span class="ti-icon">+</span>Vincular carpeta o pendrive</button>'
        : '<label class="tree-item src-link"><span class="ti-icon">+</span>Importar carpeta<input type="file" class="src-folder" webkitdirectory multiple hidden></label>' +
          '<div class="src-note">Este navegador no puede recordar carpetas; las pistas se copian a la colección.</div>');
  }
  function bind() {
    el.addEventListener('click', async e => {
      const linkBtn = e.target.closest('.src-link');
      if (linkBtn && supported()) { link(); return; }
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.closest('.src-item').dataset.id;
      const src = sources.find(s => s.id === id);
      if (!src) return;
      if (btn.dataset.act === 'unlink') unlink(id);
      else if (btn.dataset.act === 'rescan') check(src, true);
      else if (src.status === 'prompt' || src.status === 'missing') check(src, true);
      else hooks.onSelect(id);
    });
    el.addEventListener('change', e => {
      if (!e.target.classList.contains('src-folder')) return;
      const files = Array.from(e.target.files || []);
      const added = Library.addFiles(files);
      hooks.toast(added.length ? added.length + ' pistas importadas de la carpeta.' : 'No había archivos de audio en esa carpeta.');
      e.target.value = '';
      hooks.onChange();
    });
  }

  return {
    init: async (mount, h) => { await init(mount, h); bind(); },
    link, linkHandle, unlink, getFile, nameOf, supported,
    get list() { return sources; }
  };
})();
