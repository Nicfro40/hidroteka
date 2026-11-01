/* Google Drive: inicio de sesión con la cuenta de Google (Google Identity Services, sin backend),
   navegación de "Mi unidad" y "Compartidos conmigo", y carpetas vinculadas como fuente de la colección.
   Las pistas se descargan solas en segundo plano para analizarlas y quedan guardadas en el navegador. */
const GDrive = (() => {
  const KEY_ID = 'mixdeck.gdrive.clientId';
  const KEY_TOKEN = 'mixdeck.gdrive.token';
  const KEY_LAST = 'mixdeck.gdrive.connected';
  const API = 'https://www.googleapis.com/drive/v3';
  const GSI = 'https://accounts.google.com/gsi/client';
  const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
  const FOLDER = 'application/vnd.google-apps.folder';
  const SHORTCUT = 'application/vnd.google-apps.shortcut';
  const FIELDS = 'nextPageToken,files(id,name,mimeType,size,modifiedTime,shortcutDetails)';

  let clientId = localStorage.getItem(KEY_ID) || '';
  let token = safeParse(localStorage.getItem(KEY_TOKEN));
  let tokenClient = null, gsiPromise = null, pendingAuth = null;
  let user = null;
  let path = [];        // migas: [{ id, name }]
  let items = [];       // contenido de la carpeta actual
  let busy = false;
  const hooks = { toast() {}, linkFolder() {}, importFile() {}, linkedIds: () => [] };
  const el = {};

  function safeParse(s) { try { return JSON.parse(s || 'null'); } catch (e) { return null; } }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isAudio = f => (f.mimeType || '').startsWith('audio/') || /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|opus|aif|aiff)$/i.test(f.name || '');
  const hostBlocked = () => window.MIXDECK_CAPS && window.MIXDECK_CAPS.gdrive === false;
  const connected = () => !!token && Date.now() < token.expires;

  /* ---------- Autenticación (Google Identity Services) ---------- */
  function loadGsi() {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
    if (gsiPromise) return gsiPromise;
    gsiPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = GSI; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { gsiPromise = null; reject(new Error('no se pudo cargar el inicio de sesión de Google')); };
      document.head.appendChild(s);
    });
    return gsiPromise;
  }
  async function ensureClient() {
    await loadGsi();
    if (tokenClient) return tokenClient;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPE,
      callback: resp => {
        const p = pendingAuth; pendingAuth = null;
        if (!resp || resp.error) { if (p) p.reject(new Error(resp && resp.error_description || resp && resp.error || 'acceso denegado')); return; }
        token = { access: resp.access_token, expires: Date.now() + ((+resp.expires_in || 3600) - 60) * 1000 };
        localStorage.setItem(KEY_TOKEN, JSON.stringify(token));
        localStorage.setItem(KEY_LAST, '1');
        if (p) p.resolve(token.access);
      },
      error_callback: err => { const p = pendingAuth; pendingAuth = null; if (p) p.reject(new Error(err && err.message || 'ventana cerrada')); }
    });
    return tokenClient;
  }
  /* Pide un token; con silent=true intenta sin ventana (sirve si la sesión de Google sigue abierta). */
  async function authorize(silent) {
    if (hostBlocked()) throw friendly('Google Drive no está disponible en esta versión publicada.');
    if (!clientId) { openSettings(); throw friendly('Falta configurar el Client ID de Google.'); }
    const tc = await ensureClient();
    return new Promise((resolve, reject) => {
      pendingAuth = { resolve, reject };
      try { tc.requestAccessToken({ prompt: silent ? '' : 'consent' }); }
      catch (e) { pendingAuth = null; reject(e); }
    });
  }
  async function login() {
    try {
      await authorize(false);
      hooks.toast('Google Drive conectado.');
      await bootstrap();
    } catch (e) { if (!e.friendly) hooks.toast('Google: ' + e.message); }
    render();
  }
  async function reconnectSilently() {
    if (connected() || !localStorage.getItem(KEY_LAST) || !clientId || hostBlocked()) return connected();
    try { await authorize(true); await bootstrap(); render(); return true; } catch (e) { return false; }
  }
  function logout() {
    if (token && window.google && window.google.accounts) { try { window.google.accounts.oauth2.revoke(token.access, () => {}); } catch (e) { /* ignorar */ } }
    token = null; user = null; items = []; path = [];
    localStorage.removeItem(KEY_TOKEN); localStorage.removeItem(KEY_LAST);
    render();
  }
  function friendly(msg) { const e = new Error(msg); e.friendly = true; return e; }

  /* ---------- API ---------- */
  async function api(pathname, params, opts) {
    if (!connected()) {
      const ok = await reconnectSilently();
      if (!ok) throw friendly('Google Drive no está conectado. Pulsa "Conectar con Google".');
    }
    const url = new URL(API + pathname);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const r = await fetch(url, Object.assign({}, opts || {}, { headers: Object.assign({ Authorization: 'Bearer ' + token.access }, (opts && opts.headers) || {}) }));
    if (r.status === 401) { token = null; localStorage.removeItem(KEY_TOKEN); throw friendly('La sesión de Google expiró. Vuelve a conectar.'); }
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const d = await r.json(); msg = (d.error && d.error.message) || msg; } catch (e) { /* sin cuerpo */ }
      throw new Error(msg);
    }
    return r;
  }
  async function listQuery(q) {
    let out = [], pageToken = '';
    do {
      const params = { q, fields: FIELDS, pageSize: 1000, supportsAllDrives: true, includeItemsFromAllDrives: true, orderBy: 'folder,name' };
      if (pageToken) params.pageToken = pageToken;
      const d = await (await api('/files', params)).json();
      out = out.concat(d.files || []);
      pageToken = d.nextPageToken || '';
    } while (pageToken);
    return out.map(f => (f.mimeType === SHORTCUT && f.shortcutDetails
      ? Object.assign({}, f, { id: f.shortcutDetails.targetId, mimeType: f.shortcutDetails.targetMimeType, shortcut: true }) : f));
  }
  const listChildren = id => listQuery("'" + id + "' in parents and trashed=false");
  const listShared = () => listQuery('sharedWithMe=true and trashed=false');
  const listRoot = () => listQuery("'root' in parents and trashed=false");

  /* Lista recursiva de pistas de una carpeta: [{ path, name, size, mtime, driveId }]. */
  async function listRecursive(folderId, prefix, depth, out) {
    out = out || [];
    const children = await listChildren(folderId);
    for (const f of children) {
      if (f.mimeType === FOLDER) { if ((depth || 0) < 8) await listRecursive(f.id, (prefix || '') + f.name + '/', (depth || 0) + 1, out); }
      else if (isAudio(f)) out.push({ path: (prefix || '') + f.name, name: f.name, size: +f.size || 0, mtime: Date.parse(f.modifiedTime) || 0, driveId: f.id });
    }
    return out;
  }
  async function download(driveId, name, mtime) {
    const r = await api('/files/' + encodeURIComponent(driveId), { alt: 'media', supportsAllDrives: true });
    const blob = await r.blob();
    return new File([blob], name, { type: blob.type || 'audio/mpeg', lastModified: mtime || Date.now() });
  }
  async function bootstrap() {
    try { user = await (await api('/about', { fields: 'user(displayName,emailAddress)' })).json(); user = user.user; } catch (e) { user = null; }
    if (!path.length) await open({ id: 'shared', name: 'Compartidos conmigo' });
  }

  /* ---------- Navegación ---------- */
  async function open(folder, depthIndex) {
    busy = true;
    if (depthIndex != null) path = path.slice(0, depthIndex + 1); else path = path.concat([folder]);
    render();
    try {
      items = folder.id === 'shared' ? await listShared() : folder.id === 'root' ? await listRoot() : await listChildren(folder.id);
      items = items.filter(f => f.mimeType === FOLDER || isAudio(f));
    } catch (e) { items = []; hooks.toast('Google Drive: ' + e.message); }
    busy = false;
    render();
  }

  /* ---------- UI ---------- */
  function build(mount, h) {
    Object.assign(hooks, h || {});
    mount.innerHTML =
      '<div class="gd-head"><h2><span class="gd-logo">▲</span>Google Drive</h2><span class="gd-status"></span>' +
        '<div class="gd-actions"><button class="btn primary gd-login">Conectar con Google</button><button class="btn ghost gd-logout hidden">Salir</button><button class="btn ghost gd-settings" title="Configurar Client ID">⚙</button></div></div>' +
      '<div class="gd-body"></div>' +
      '<dialog class="gd-dialog">' +
        '<h3>Conectar MIXDECK con Google Drive</h3>' +
        '<ol class="sp-steps">' +
          '<li>Entra a <b>console.cloud.google.com</b>, crea un proyecto y en <b>APIs y servicios → Biblioteca</b> habilita <b>Google Drive API</b>.</li>' +
          '<li>En <b>Pantalla de consentimiento OAuth</b>: tipo Externo, estado "En pruebas", y agrega en <b>Usuarios de prueba</b> el correo con el que vas a entrar.</li>' +
          '<li>En <b>Credenciales → Crear credenciales → ID de cliente de OAuth</b>, tipo <b>Aplicación web</b>, agrega en <b>Orígenes autorizados de JavaScript</b> exactamente: <code class="gd-origin"></code> <button class="btn ghost gd-copy" type="button">Copiar</button></li>' +
          '<li>Copia el <b>ID de cliente</b> (termina en .apps.googleusercontent.com) y pégalo aquí:</li>' +
        '</ol>' +
        '<input class="sp-client gd-client" placeholder="xxxxxxxx.apps.googleusercontent.com" spellcheck="false">' +
        '<p class="sp-note">La app solo pide permiso de <b>lectura</b> de Drive. Mientras el proyecto esté "en pruebas", Google mostrará un aviso de app no verificada: pulsa "Continuar". La sesión se renueva sola mientras tu cuenta de Google siga abierta en el navegador.</p>' +
        '<div class="sp-dialog-actions"><button class="btn ghost gd-cancel" type="button">Cancelar</button><button class="btn primary gd-save" type="button">Guardar</button></div>' +
      '</dialog>';
    const q = s => mount.querySelector(s);
    el.mount = mount; el.status = q('.gd-status'); el.body = q('.gd-body');
    el.login = q('.gd-login'); el.logout = q('.gd-logout'); el.dialog = q('.gd-dialog'); el.client = q('.gd-client'); el.origin = q('.gd-origin');
    el.login.addEventListener('click', login);
    el.logout.addEventListener('click', logout);
    q('.gd-settings').addEventListener('click', openSettings);
    q('.gd-cancel').addEventListener('click', () => el.dialog.close());
    q('.gd-copy').addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(location.origin).then(() => hooks.toast('Origen copiado.'), () => {}); });
    q('.gd-save').addEventListener('click', () => {
      const v = el.client.value.trim();
      if (!/\.apps\.googleusercontent\.com$/.test(v)) return hooks.toast('El ID de cliente debe terminar en .apps.googleusercontent.com');
      clientId = v; localStorage.setItem(KEY_ID, v); tokenClient = null;
      el.dialog.close(); render();
      hooks.toast('ID guardado. Ahora pulsa "Conectar con Google".');
    });
    el.body.addEventListener('click', onBodyClick);
    render();
    if (connected()) bootstrap().then(render);
    else if (localStorage.getItem(KEY_LAST) && clientId && !hostBlocked()) {
      document.addEventListener('pointerdown', () => { reconnectSilently(); }, { once: true });
    }
  }
  function openSettings() {
    el.origin.textContent = location.protocol === 'file:' ? '(abre la app desde http://127.0.0.1 o https)' : location.origin;
    el.client.value = clientId;
    el.dialog.showModal();
  }
  function render() {
    if (!el.mount) return;
    const ok = connected();
    el.login.classList.toggle('hidden', ok);
    el.logout.classList.toggle('hidden', !ok);
    el.status.textContent = hostBlocked() ? 'No disponible en esta versión publicada'
      : location.protocol === 'file:' ? 'No disponible desde archivo local'
      : !clientId ? 'Falta configurar el Client ID'
      : !ok ? (localStorage.getItem(KEY_LAST) ? 'Sesión por renovar: pulsa Conectar' : 'Desconectado')
      : 'Conectado' + (user ? ' como ' + (user.emailAddress || user.displayName) : '');
    if (hostBlocked()) { el.body.innerHTML = '<p class="sp-msg">' + esc((window.MIXDECK_CAPS && window.MIXDECK_CAPS.gdriveNote) || 'Esta versión publicada no puede conectarse con Google Drive. Usa la versión en GitHub Pages.') + '</p>'; return; }
    if (location.protocol === 'file:') { el.body.innerHTML = '<p class="sp-msg">Google exige abrir la app desde <b>http://127.0.0.1</b> o <b>https</b> (por ejemplo, la dirección de GitHub Pages), no desde un archivo local.</p>'; return; }
    if (!clientId) { el.body.innerHTML = '<p class="sp-msg">Para usar Google Drive necesitas un ID de cliente de Google (gratis). Pulsa ⚙ y sigue los cuatro pasos.</p>'; return; }
    if (!ok) { el.body.innerHTML = '<p class="sp-msg">Conecta tu cuenta para ver las carpetas que te comparten y vincularlas: la app descarga y analiza las canciones sola, en segundo plano, y quedan guardadas en este navegador.</p>'; return; }
    const linked = new Set(hooks.linkedIds());
    const crumbs = '<div class="gd-crumbs">' +
      '<button class="gd-root" data-root="shared">Compartidos conmigo</button><button class="gd-root" data-root="root">Mi unidad</button>' +
      (path.length ? '<span class="gd-sep">›</span>' : '') +
      path.map((p, i) => '<button class="gd-crumb" data-i="' + i + '">' + esc(p.name) + '</button>').join('<span class="gd-sep">›</span>') + '</div>';
    const current = path[path.length - 1];
    const linkCurrent = current && current.id !== 'shared' && current.id !== 'root'
      ? '<div class="gd-current">' + (linked.has(current.id) ? '<span class="gd-linked">✓ Esta carpeta está vinculada</span>' : '<button class="btn primary gd-link" data-id="' + esc(current.id) + '" data-name="' + esc(current.name) + '">Vincular esta carpeta a la colección</button>') + '</div>' : '';
    const rows = busy ? '<tr><td colspan="3" class="sp-msg">Cargando…</td></tr>'
      : !items.length ? '<tr><td colspan="3" class="sp-msg">Carpeta vacía (o sin carpetas ni archivos de audio).</td></tr>'
      : items.map(f => f.mimeType === FOLDER
        ? '<tr class="gd-folder"><td class="t-name"><button class="gd-open" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '">📁 ' + esc(f.name) + '</button></td><td class="t-dur">carpeta</td><td class="t-act">' + (linked.has(f.id) ? '<span class="gd-linked">✓ vinculada</span>' : '<button class="gd-link" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '" title="Vincular a la colección">Vincular</button>') + '</td></tr>'
        : '<tr><td class="t-name">♪ ' + esc(f.name) + '</td><td class="t-dur">' + (f.size ? (f.size / 1048576).toFixed(1) + ' MB' : '—') + '</td><td class="t-act"><button class="queue gd-import" data-id="' + esc(f.id) + '" data-name="' + esc(f.name) + '" data-mtime="' + (Date.parse(f.modifiedTime) || 0) + '" title="Descargar y agregar a la colección">+ Colección</button></td></tr>'
      ).join('');
    el.body.innerHTML = crumbs + linkCurrent + '<div class="table-wrap gd-wrap"><table class="lib-table gd-table"><tbody>' + rows + '</tbody></table></div>';
  }
  function onBodyClick(e) {
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('gd-root')) { path = []; open({ id: b.dataset.root, name: b.dataset.root === 'shared' ? 'Compartidos conmigo' : 'Mi unidad' }); }
    else if (b.classList.contains('gd-crumb')) open(path[+b.dataset.i], +b.dataset.i);
    else if (b.classList.contains('gd-open')) open({ id: b.dataset.id, name: b.dataset.name });
    else if (b.classList.contains('gd-link')) { hooks.linkFolder(b.dataset.id, b.dataset.name); render(); }
    else if (b.classList.contains('gd-import')) hooks.importFile({ driveId: b.dataset.id, name: b.dataset.name, mtime: +b.dataset.mtime });
  }

  return { build, login, logout, connected, listRecursive, download, reconnectSilently, get clientId() { return clientId; } };
})();
