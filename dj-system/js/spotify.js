/* Integración con Spotify: OAuth PKCE sin backend, búsqueda, playlists como setlists,
   cruce con la biblioteca local y reproductor (Web Playback SDK, requiere Premium).
   Por los términos de Spotify, su audio no pasa por el mixer y nunca suena encima de los decks. */
const SpotifyLink = (() => {
  const KEY_ID = 'mixdeck.spotify.clientId';
  const KEY_TOKEN = 'mixdeck.spotify.token';
  const KEY_PKCE = 'mixdeck.spotify.pkce';
  const API = 'https://api.spotify.com/v1';
  const ACCOUNTS = 'https://accounts.spotify.com';
  const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
  const SCOPES = ['streaming', 'user-read-email', 'user-read-private', 'playlist-read-private',
    'playlist-read-collaborative', 'user-modify-playback-state', 'user-read-playback-state'].join(' ');

  let clientId = localStorage.getItem(KEY_ID) || '';
  let token = safeParse(localStorage.getItem(KEY_TOKEN));
  let user = null;
  let playlists = [];
  let list = { title: '', tracks: [] };
  let player = null, deviceId = null, playerState = null, sdkPromise = null, playerTimer = null;
  let busy = false;
  const hooks = { toast() {}, locals: () => [], loadLocal() {}, queueLocal() {}, onSpotifyPlaying() {} };
  const el = {};

  function safeParse(s) { try { return JSON.parse(s || 'null'); } catch (e) { return null; } }
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

  /* ---------- Entorno ---------- */
  function hostBlocked() { return window.MIXDECK_CAPS && window.MIXDECK_CAPS.spotify === false; }
  function supported() {
    if (hostBlocked()) return false;
    return location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
  }
  function redirectUri() { return location.origin + location.pathname; }
  const connected = () => !!token;

  /* ---------- OAuth PKCE ---------- */
  function randomString(n) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const bytes = crypto.getRandomValues(new Uint8Array(n));
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  }
  function b64url(buf) {
    return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  async function challengeFor(verifier) {
    return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  }
  async function login() {
    if (!supported()) return hooks.toast('Abre la app desde http://127.0.0.1 o https para conectar con Spotify.');
    if (!clientId) return openSettings();
    const verifier = randomString(64);
    const state = randomString(16);
    sessionStorage.setItem(KEY_PKCE, JSON.stringify({ verifier, state }));
    const p = new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: await challengeFor(verifier), state
    });
    location.assign(ACCOUNTS + '/authorize?' + p.toString());
  }
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    if (!q.has('code') && !q.has('error')) return false;
    const saved = safeParse(sessionStorage.getItem(KEY_PKCE));
    sessionStorage.removeItem(KEY_PKCE);
    history.replaceState(null, '', location.pathname);
    if (q.has('error')) { hooks.toast('Spotify rechazó la conexión: ' + q.get('error')); return true; }
    if (!saved || saved.state !== q.get('state')) { hooks.toast('La respuesta de Spotify no coincide con la solicitud. Intenta conectar de nuevo.'); return true; }
    try {
      await tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: redirectUri(), code_verifier: saved.verifier });
      hooks.toast('Spotify conectado.');
    } catch (e) {
      hooks.toast('No se pudo completar la conexión con Spotify: ' + e.message);
    }
    return true;
  }
  async function tokenRequest(params) {
    const body = new URLSearchParams(Object.assign({ client_id: clientId }, params));
    const r = await fetch(ACCOUNTS + '/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error_description || data.error || ('HTTP ' + r.status));
    token = {
      access: data.access_token,
      refresh: data.refresh_token || (token && token.refresh) || null,
      expires: Date.now() + ((data.expires_in || 3600) - 30) * 1000
    };
    localStorage.setItem(KEY_TOKEN, JSON.stringify(token));
    return token.access;
  }
  async function getToken() {
    if (!token) return null;
    if (Date.now() < token.expires) return token.access;
    if (!token.refresh) { logout(); return null; }
    try {
      return await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh });
    } catch (e) {
      logout();
      hooks.toast('La sesión de Spotify expiró. Conéctate de nuevo.');
      return null;
    }
  }
  async function api(path, opts) {
    opts = opts || {};
    const t = await getToken();
    if (!t) throw new Error('sin sesión');
    const r = await fetch(path.startsWith('http') ? path : API + path, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, opts.headers || {})
    }));
    if (r.status === 204) return null;
    if (r.status === 429) throw new Error('Spotify pide esperar unos segundos (límite de peticiones).');
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      if (r.status === 401) logout();
      throw new Error((data && data.error && (data.error.message || data.error)) || ('HTTP ' + r.status));
    }
    return data;
  }
  function logout() {
    token = null; user = null; playlists = []; list = { title: '', tracks: [] };
    localStorage.removeItem(KEY_TOKEN);
    if (player) { try { player.disconnect(); } catch (e) { /* ignorar */ } }
    player = null; deviceId = null; playerState = null;
    render();
  }

  /* ---------- Datos ---------- */
  const simplify = t => ({
    id: t.id, uri: t.uri, name: t.name || '', artists: (t.artists || []).map(a => a.name),
    album: t.album ? t.album.name : '',
    cover: t.album && t.album.images && t.album.images.length ? t.album.images[t.album.images.length - 1].url : null,
    duration: (t.duration_ms || 0) / 1000
  });
  async function loadPlaylists() {
    let items = [], url = '/me/playlists?limit=50';
    while (url && items.length < 300) {
      const d = await api(url);
      items = items.concat((d.items || []).filter(Boolean));
      url = d.next;
    }
    return items.map(p => ({ id: p.id, name: p.name, total: p.tracks ? p.tracks.total : 0 }));
  }
  async function playlistTracks(id) {
    let items = [], url = '/playlists/' + id + '/tracks?limit=100&fields=next,items(track(id,uri,name,duration_ms,artists(name),album(name,images)))';
    while (url && items.length < 500) {
      const d = await api(url);
      items = items.concat((d.items || []).map(i => i && i.track).filter(t => t && t.id));
      url = d.next;
    }
    return items.map(simplify);
  }
  async function search(q) {
    const d = await api('/search?type=track&limit=30&q=' + encodeURIComponent(q));
    return ((d.tracks && d.tracks.items) || []).map(simplify);
  }

  /* ---------- Cruce con la biblioteca local ---------- */
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/\b(feat|ft)\.?\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  function matchLocal(track, locals) {
    const title = norm(track.name);
    if (title.length < 3) return null;
    const artists = track.artists.map(norm).filter(a => a.length >= 2);
    let best = null, bestScore = 0;
    for (const l of locals) {
      const n = norm((l.artist ? l.artist + ' ' : '') + l.name);
      if (!n.includes(title)) continue;
      let score = 0;
      if (n === title) score = 2;
      else if (artists.some(a => n.includes(a))) score = 3;
      else if (title.length >= 10) score = 1;
      if (score > bestScore) { bestScore = score; best = l; }
    }
    return best;
  }

  /* ---------- Reproductor (Web Playback SDK) ---------- */
  function loadSdk() {
    if (window.Spotify && window.Spotify.Player) return Promise.resolve();
    if (sdkPromise) return sdkPromise;
    sdkPromise = new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = () => resolve();
      const s = document.createElement('script');
      s.src = SDK_URL; s.async = true;
      s.onerror = () => { sdkPromise = null; reject(new Error('no se pudo cargar el reproductor de Spotify')); };
      document.head.appendChild(s);
    });
    return sdkPromise;
  }
  function ensurePlayer() {
    if (player && deviceId) return Promise.resolve(player);
    return loadSdk().then(() => new Promise((resolve, reject) => {
      const p = new window.Spotify.Player({
        name: 'MIXDECK', volume: 0.8,
        getOAuthToken: cb => getToken().then(t => cb(t || ''))
      });
      let settled = false;
      const fail = msg => { if (!settled) { settled = true; reject(new Error(msg)); } };
      p.addListener('ready', ({ device_id }) => {
        deviceId = device_id; player = p;
        if (!settled) { settled = true; resolve(p); }
        render();
      });
      p.addListener('not_ready', () => { deviceId = null; });
      p.addListener('player_state_changed', st => {
        playerState = st;
        renderPlayer();
        if (st && !st.paused) hooks.onSpotifyPlaying();
      });
      p.addListener('initialization_error', e => fail(e.message || 'el navegador no soporta el reproductor'));
      p.addListener('authentication_error', e => fail(e.message || 'error de autenticación'));
      p.addListener('account_error', () => fail('el reproductor de Spotify requiere una cuenta Premium'));
      p.connect().then(ok => { if (!ok) fail('no se pudo conectar el reproductor'); });
      setTimeout(() => fail('el reproductor de Spotify no respondió'), 15000);
    }));
  }
  async function playTrack(track) {
    try {
      await ensurePlayer();
      await api('/me/player/play?device_id=' + encodeURIComponent(deviceId), { method: 'PUT', body: JSON.stringify({ uris: [track.uri] }) });
      hooks.onSpotifyPlaying();
    } catch (e) {
      hooks.toast('Spotify: ' + e.message);
    }
  }
  function pause() {
    if (player && playerState && !playerState.paused) player.pause();
  }
  function togglePlayer() { if (player) player.togglePlay(); }

  /* ---------- UI ---------- */
  function build(mount, h) {
    Object.assign(hooks, h || {});
    mount.innerHTML =
      '<div class="sp-head">' +
        '<h2><span class="sp-dot"></span>Spotify</h2>' +
        '<span class="sp-status"></span>' +
        '<div class="sp-actions">' +
          '<button class="btn primary sp-login">Conectar con Spotify</button>' +
          '<button class="btn ghost sp-logout hidden">Salir</button>' +
          '<button class="btn ghost sp-settings" title="Configurar Client ID">⚙</button>' +
        '</div>' +
      '</div>' +
      '<div class="sp-body"></div>' +
      '<div class="sp-player hidden">' +
        '<img class="sp-cover" alt="">' +
        '<div class="sp-np"><div class="sp-np-title">—</div><div class="sp-np-sub">Suena directo desde Spotify, fuera del mixer. Se pausa al arrancar un deck.</div>' +
          '<input type="range" class="sp-seek" min="0" max="1000" value="0" title="Posición"></div>' +
        '<button class="btn sp-toggle">▶</button>' +
        '<input type="range" class="sp-vol" min="0" max="1" step="0.01" value="0.8" title="Volumen de Spotify">' +
      '</div>' +
      '<dialog class="sp-dialog">' +
        '<h3>Conectar MIXDECK con Spotify</h3>' +
        '<ol class="sp-steps">' +
          '<li>Entra a <b>developer.spotify.com/dashboard</b> y crea una app (cualquier nombre).</li>' +
          '<li>En <b>Redirect URIs</b> agrega exactamente: <code class="sp-redirect"></code> <button class="btn ghost sp-copy" type="button">Copiar</button></li>' +
          '<li>En <b>APIs used</b> marca <b>Web API</b> y <b>Web Playback SDK</b>. Guarda.</li>' +
          '<li>Copia el <b>Client ID</b> de la app y pégalo aquí:</li>' +
        '</ol>' +
        '<input class="sp-client" placeholder="Client ID (32 caracteres)" spellcheck="false">' +
        '<p class="sp-note">Mientras la app esté en modo desarrollo, Spotify solo deja entrar a los usuarios que agregues en <b>User Management</b> (hasta 25). El reproductor integrado necesita Spotify Premium.</p>' +
        '<div class="sp-dialog-actions"><button class="btn ghost sp-cancel" type="button">Cancelar</button><button class="btn primary sp-save" type="button">Guardar</button></div>' +
      '</dialog>';

    const q = s => mount.querySelector(s);
    el.mount = mount; el.status = q('.sp-status'); el.body = q('.sp-body');
    el.login = q('.sp-login'); el.logout = q('.sp-logout');
    el.player = q('.sp-player'); el.cover = q('.sp-cover'); el.npTitle = q('.sp-np-title');
    el.seek = q('.sp-seek'); el.toggle = q('.sp-toggle'); el.vol = q('.sp-vol');
    el.dialog = q('.sp-dialog'); el.client = q('.sp-client'); el.redirect = q('.sp-redirect');

    el.login.addEventListener('click', login);
    el.logout.addEventListener('click', logout);
    q('.sp-settings').addEventListener('click', openSettings);
    q('.sp-cancel').addEventListener('click', () => el.dialog.close());
    q('.sp-save').addEventListener('click', () => {
      const v = el.client.value.trim();
      if (!/^[0-9a-f]{32}$/i.test(v)) return hooks.toast('Ese Client ID no tiene el formato esperado (32 caracteres hexadecimales).');
      clientId = v;
      localStorage.setItem(KEY_ID, v);
      el.dialog.close();
      render();
      hooks.toast('Client ID guardado. Ahora pulsa "Conectar con Spotify".');
    });
    q('.sp-copy').addEventListener('click', () => {
      navigator.clipboard && navigator.clipboard.writeText(redirectUri()).then(() => hooks.toast('Redirect URI copiada.'), () => {});
    });
    el.toggle.addEventListener('click', togglePlayer);
    el.vol.addEventListener('input', () => { if (player) player.setVolume(parseFloat(el.vol.value)); });
    el.seek.addEventListener('change', () => {
      if (player && playerState) player.seek(parseFloat(el.seek.value) / 1000 * playerState.duration);
    });

    el.body.addEventListener('click', onBodyClick);
    el.body.addEventListener('keydown', e => {
      if (e.target.classList.contains('sp-search') && e.key === 'Enter') doSearch(e.target.value);
    });
    el.body.addEventListener('change', e => {
      if (e.target.classList.contains('sp-playlists') && e.target.value) importPlaylist(e.target.value);
    });

    handleCallback().then(() => { render(); if (connected()) bootstrap(); });
  }

  function openSettings() {
    el.redirect.textContent = supported() ? redirectUri() : '(abre la app desde http://127.0.0.1 o https)';
    el.client.value = clientId;
    el.dialog.showModal();
  }

  async function bootstrap() {
    try {
      user = await api('/me');
      playlists = await loadPlaylists();
    } catch (e) {
      if (token) hooks.toast('Spotify: ' + e.message);
    }
    render();
  }

  function render() {
    if (!el.mount) return;
    const ok = supported();
    el.login.classList.toggle('hidden', connected());
    el.logout.classList.toggle('hidden', !connected());
    el.status.textContent = !ok ? (hostBlocked() ? 'No disponible en esta versión publicada' : 'No disponible desde archivo local')
      : !clientId ? 'Falta configurar el Client ID'
      : !connected() ? 'Desconectado'
      : 'Conectado' + (user ? ' como ' + (user.display_name || user.id) + (user.product === 'premium' ? ' · Premium' : ' · sin Premium (sin reproductor)') : '…');
    el.player.classList.toggle('hidden', !connected() || !playerState);

    if (hostBlocked()) {
      el.body.innerHTML = '<p class="sp-msg">' + ((window.MIXDECK_CAPS && window.MIXDECK_CAPS.spotifyNote) || 'Esta versión publicada no puede conectarse con Spotify. Usa la versión alojada en tu propio dominio o en GitHub Pages.') + '</p>';
      return;
    }
    if (!ok) {
      el.body.innerHTML = '<p class="sp-msg">Spotify exige que la app se abra desde <b>http://127.0.0.1</b> o <b>https</b>, no desde un archivo local. ' +
        'Por ejemplo, en la carpeta del proyecto:</p><pre class="sp-code">python3 -m http.server 8080 --bind 127.0.0.1</pre>' +
        '<p class="sp-msg">y luego abre <b>http://127.0.0.1:8080/</b>. Tu biblioteca local sigue funcionando igual sin esto.</p>';
      return;
    }
    if (!clientId) {
      el.body.innerHTML = '<p class="sp-msg">Para usar Spotify necesitas un Client ID propio (gratis). Pulsa ⚙ y sigue los cuatro pasos.</p>';
      return;
    }
    if (!connected()) {
      el.body.innerHTML = '<p class="sp-msg">Conecta tu cuenta para buscar en el catálogo, importar tus playlists como setlists y ver qué pistas ya tienes en la biblioteca local.</p>';
      return;
    }
    const opts = playlists.map(p => '<option value="' + esc(p.id) + '">' + esc(p.name) + ' (' + p.total + ')</option>').join('');
    el.body.innerHTML =
      '<div class="sp-toolbar">' +
        '<input class="sp-search" placeholder="Buscar canción o artista en Spotify… (Enter)" value="' + esc(el.lastQuery || '') + '">' +
        '<select class="sp-playlists"><option value="">Mis playlists…</option>' + opts + '</select>' +
      '</div>' +
      '<div class="sp-summary"></div>' +
      '<div class="table-wrap sp-wrap"><table class="lib-table sp-table">' +
        '<thead><tr><th>Título</th><th>Artista</th><th>Duración</th><th>En biblioteca</th><th></th></tr></thead>' +
        '<tbody class="sp-rows"></tbody></table></div>';
    renderList();
  }

  function renderList() {
    const rows = el.body.querySelector('.sp-rows');
    const summary = el.body.querySelector('.sp-summary');
    if (!rows) return;
    const locals = hooks.locals();
    let have = 0;
    rows.innerHTML = list.tracks.map((t, i) => {
      const local = matchLocal(t, locals);
      if (local) have++;
      t.localId = local ? local.id : null;
      const cover = t.cover ? '<img class="sp-thumb" src="' + esc(t.cover) + '" alt="" loading="lazy">' : '<span class="sp-thumb"></span>';
      const localCell = local
        ? '<span class="sp-have" title="' + esc(local.name) + '">✓</span>' +
          '<button class="load-a" data-act="A" data-i="' + i + '" title="Cargar el archivo local en Deck A">A</button>' +
          '<button class="load-b" data-act="B" data-i="' + i + '" title="Cargar el archivo local en Deck B">B</button>' +
          '<button class="queue" data-act="Q" data-i="' + i + '" title="Agregar el archivo local a la cola de Automix">+</button>'
        : '<span class="sp-miss" title="No hay un archivo con este título en la biblioteca">—</span>';
      return '<tr>' +
        '<td class="t-name sp-name">' + cover + '<span>' + esc(t.name) + '</span></td>' +
        '<td class="sp-artist">' + esc(t.artists.join(', ')) + '</td>' +
        '<td class="t-dur">' + fmt(t.duration) + '</td>' +
        '<td class="t-act sp-local">' + localCell + '</td>' +
        '<td class="t-act"><button class="sp-play" data-act="play" data-i="' + i + '" title="Escuchar en Spotify (Premium)">▶</button></td>' +
      '</tr>';
    }).join('');
    summary.innerHTML = busy ? 'Cargando…'
      : !list.tracks.length ? 'Busca una canción o elige una playlist para armar un setlist.'
      : esc((list.title ? list.title + ' · ' : '') + list.tracks.length + ' pistas · ' + have + ' en tu biblioteca') +
        (have ? ' <button class="btn ghost sp-queue-all" type="button">+ Encolar las ' + have + ' en Automix</button>' : '');
  }
  function refreshMatches() { if (connected()) renderList(); }

  function onBodyClick(e) {
    if (e.target.closest('.sp-queue-all')) {
      const ids = list.tracks.filter(t => t.localId).map(t => t.localId);
      hooks.queueLocal(ids);
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const t = list.tracks[+btn.dataset.i];
    if (!t) return;
    if (btn.dataset.act === 'play') playTrack(t);
    else if (btn.dataset.act === 'Q') { if (t.localId) hooks.queueLocal([t.localId]); }
    else if (t.localId) hooks.loadLocal(t.localId, btn.dataset.act);
  }
  async function doSearch(q) {
    q = (q || '').trim();
    if (!q) return;
    el.lastQuery = q;
    busy = true; renderList();
    try { list = { title: 'Búsqueda: "' + q + '"', tracks: await search(q) }; }
    catch (e) { hooks.toast('Spotify: ' + e.message); }
    busy = false; renderList();
  }
  async function importPlaylist(id) {
    const p = playlists.find(x => x.id === id);
    busy = true; renderList();
    try { list = { title: p ? p.name : 'Playlist', tracks: await playlistTracks(id) }; }
    catch (e) { hooks.toast('Spotify: ' + e.message); }
    busy = false; renderList();
  }

  function renderPlayer() {
    if (!el.player) return;
    const st = playerState;
    el.player.classList.toggle('hidden', !st);
    if (!st) { clearInterval(playerTimer); playerTimer = null; return; }
    const cur = st.track_window && st.track_window.current_track;
    if (cur) {
      el.npTitle.textContent = cur.name + ' · ' + (cur.artists || []).map(a => a.name).join(', ');
      const img = cur.album && cur.album.images && cur.album.images[0];
      el.cover.src = img ? img.url : '';
    }
    el.toggle.textContent = st.paused ? '▶' : '❚❚';
    if (!playerTimer) playerTimer = setInterval(tickPlayer, 500);
    tickPlayer();
  }
  function tickPlayer() {
    const st = playerState;
    if (!st || !st.duration) return;
    const pos = st.paused ? st.position : Math.min(st.duration, st.position + (Date.now() - st.timestamp));
    if (document.activeElement !== el.seek) el.seek.value = Math.round(pos / st.duration * 1000);
  }

  return { build, login, logout, refreshMatches, pause, matchLocal, norm, connected, supported, redirectUri, challengeFor,
    get clientId() { return clientId; } };
})();
