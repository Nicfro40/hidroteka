/* Controladoras MIDI (Web MIDI API): cualquier controladora USB estándar.
   Modo Aprender, mapeos guardados por dispositivo, presets, luces (feedback) y
   selección de la tarjeta de sonido con pre-escucha por auriculares. */
const Midi = (() => {
  const KEY = 'mixdeck.midi';
  const LED_MS = 100;
  let access = null;
  const inputs = new Map();     // id → MIDIInput
  const outputs = new Map();    // name → { send(data) }
  let store = { devices: {} };  // devices[name] = [ { key, action, mode, invert, led } ]
  let learning = null;          // id de acción esperando un mensaje
  let lastActivity = 0;
  const jogTimers = {};
  const hooks = { toast() {}, decks: {}, library: null, automix: null, loadTrack() {} };
  const el = {};

  /* ---------- Acciones ---------- */
  const ACTIONS = [];
  const act = (id, label, group, kind, run, state) => ACTIONS.push({ id, label, group, kind, run, state });
  function defineActions() {
    for (const id of ['A', 'B']) {
      const d = () => hooks.decks[id];
      const g = 'Deck ' + id;
      act(id + '.play', 'Play / Pause', g, 'button', (v, press) => { if (press) d().togglePlay(); }, () => d().playing);
      act(id + '.cue', 'Cue', g, 'button', (v, press) => { if (press) d().cuePress(); else d().cueRelease(); }, () => d().buffer && !d().playing && Math.abs(d().pausedPos - d().cuePoint) <= 0.02);
      act(id + '.sync', 'Sync', g, 'button', (v, press) => { if (press) d().sync(); }, () => d().isInSync());
      for (let i = 0; i < 4; i++) act(id + '.hot' + (i + 1), 'Hot cue ' + (i + 1), g, 'button', (v, press) => { if (press) d().hotCue(i, false); }, () => d().hotCues[i] != null);
      act(id + '.loopIn', 'Loop in', g, 'button', (v, press) => { if (press) d().loopIn(); }, () => d().loop.inPoint != null || d().loop.active);
      act(id + '.loopOut', 'Loop out', g, 'button', (v, press) => { if (press) d().loopOut(); }, () => d().loop.active);
      act(id + '.loop4', 'Loop 4 beats', g, 'button', (v, press) => { if (press) d().autoLoop(4); }, () => d().loop.active);
      act(id + '.loopHalf', 'Loop ½', g, 'button', (v, press) => { if (press) d().loopHalve(); });
      act(id + '.loopDouble', 'Loop ×2', g, 'button', (v, press) => { if (press) d().loopDouble(); });
      act(id + '.loopExit', 'Salir del loop', g, 'button', (v, press) => { if (press) d().exitLoop(); }, () => d().loop.active);
      act(id + '.pfl', 'Cue auriculares', g, 'button', (v, press) => { if (press) Mixer.setPfl(id, !Mixer.getPfl(id)); }, () => Mixer.getPfl(id));
      act(id + '.load', 'Cargar pista seleccionada', g, 'button', (v, press) => { if (press) { const t = hooks.library.selected(); if (t) hooks.loadTrack(t, id); } });
      act(id + '.pitch', 'Pitch (fader de tempo)', g, 'fader', v => d().setPitch((v * 2 - 1) * d().PITCH_RANGE));
      act(id + '.jog', 'Jog wheel (nudge / búsqueda)', g, 'jog', delta => jog(id, delta));
      act(id + '.volume', 'Fader de canal', g, 'fader', v => Mixer.setFader(id, v));
      act(id + '.trim', 'Trim', g, 'knob', v => Mixer.setEq(id, 'trim', v * 24 - 12));
      act(id + '.eqHigh', 'EQ agudos', g, 'knob', v => Mixer.setEq(id, 'high', eqDb(v)));
      act(id + '.eqMid', 'EQ medios', g, 'knob', v => Mixer.setEq(id, 'mid', eqDb(v)));
      act(id + '.eqLow', 'EQ graves', g, 'knob', v => Mixer.setEq(id, 'low', eqDb(v)));
      act(id + '.filter', 'Filtro', g, 'knob', v => d().knobFilter.set(v * 2 - 1));
      act(id + '.echo', 'Echo', g, 'knob', v => d().knobEcho.set(v));
      act(id + '.reverb', 'Reverb', g, 'knob', v => d().knobReverb.set(v));
    }
    act('mix.xfader', 'Crossfader', 'Mixer', 'fader', v => Mixer.setXf(v * 2 - 1));
    act('mix.master', 'Volumen master', 'Mixer', 'knob', v => Engine.setMaster(v));
    act('mix.phones', 'Volumen auriculares', 'Mixer', 'knob', v => Engine.setPhones(v));
    act('browse.scroll', 'Navegar la colección (encoder)', 'Navegador', 'encoder', delta => hooks.library.selectRelative(Math.sign(delta)));
    act('browse.loadA', 'Cargar selección en A', 'Navegador', 'button', (v, press) => { if (press) { const t = hooks.library.selected(); if (t) hooks.loadTrack(t, 'A'); } });
    act('browse.loadB', 'Cargar selección en B', 'Navegador', 'button', (v, press) => { if (press) { const t = hooks.library.selected(); if (t) hooks.loadTrack(t, 'B'); } });
    act('automix.toggle', 'Automix iniciar / detener', 'Automix', 'button', (v, press) => { if (press) { if (hooks.automix.running) hooks.automix.stop(); else hooks.automix.start(); } }, () => hooks.automix.running);
    act('automix.skip', 'Automix siguiente', 'Automix', 'button', (v, press) => { if (press) hooks.automix.skip(); });
  }
  const eqDb = v => (v < 0.5 ? -24 * (1 - v * 2) : 12 * (v * 2 - 1));
  const byId = id => ACTIONS.find(a => a.id === id);

  /* Jog: con la pista sonando empuja el tempo (nudge); en pausa busca dentro de la pista. */
  function jog(id, delta) {
    const d = hooks.decks[id];
    if (!d.buffer) return;
    if (d.playing) {
      d.setBend(Math.max(-0.08, Math.min(0.08, delta * 0.004)));
      clearTimeout(jogTimers[id]);
      jogTimers[id] = setTimeout(() => d.setBend(0), 120);
    } else {
      d.seek(d.getPosition() + delta * 0.02);
    }
  }

  /* ---------- Presets (aproximados; se corrigen con Aprender) ---------- */
  const PRESETS = {
    'Pioneer DDJ-400 / DDJ-FLX4 (aproximado)': [
      ...['A', 'B'].flatMap((id, i) => [
        { key: i + ':n:11', action: id + '.play', mode: 'button', led: true },
        { key: i + ':n:12', action: id + '.cue', mode: 'button', led: true },
        { key: i + ':n:88', action: id + '.sync', mode: 'button', led: true },
        { key: i + ':n:16', action: id + '.loopIn', mode: 'button', led: true },
        { key: i + ':n:17', action: id + '.loopOut', mode: 'button', led: true },
        { key: i + ':n:84', action: id + '.pfl', mode: 'button', led: true },
        { key: i + ':n:70', action: id + '.load', mode: 'button' },
        { key: (i ? 9 : 7) + ':n:0', action: id + '.hot1', mode: 'button', led: true },
        { key: (i ? 9 : 7) + ':n:1', action: id + '.hot2', mode: 'button', led: true },
        { key: (i ? 9 : 7) + ':n:2', action: id + '.hot3', mode: 'button', led: true },
        { key: (i ? 9 : 7) + ':n:3', action: id + '.hot4', mode: 'button', led: true },
        { key: i + ':c:34', action: id + '.jog', mode: 'rel' },
        { key: i + ':c:33', action: id + '.jog', mode: 'rel' },
        { key: i + ':c:0', action: id + '.pitch', mode: 'abs14', invert: true },
        { key: i + ':c:19', action: id + '.volume', mode: 'abs14' },
        { key: i + ':c:4', action: id + '.trim', mode: 'abs14' },
        { key: i + ':c:7', action: id + '.eqHigh', mode: 'abs14' },
        { key: i + ':c:11', action: id + '.eqMid', mode: 'abs14' },
        { key: i + ':c:15', action: id + '.eqLow', mode: 'abs14' },
        { key: '6:c:' + (23 + i), action: id + '.filter', mode: 'abs14' }
      ]),
      { key: '6:c:31', action: 'mix.xfader', mode: 'abs14' },
      { key: '6:c:8', action: 'mix.master', mode: 'abs14' },
      { key: '6:c:13', action: 'mix.phones', mode: 'abs14' },
      { key: '6:c:64', action: 'browse.scroll', mode: 'rel' }
    ]
  };

  /* ---------- Persistencia ---------- */
  function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { /* sin espacio */ } }
  function load() { try { store = JSON.parse(localStorage.getItem(KEY) || 'null') || { devices: {} }; } catch (e) { store = { devices: {} }; } if (!store.devices) store.devices = {}; }
  function mappingsFor(name) { return store.devices[name] || (store.devices[name] = []); }

  /* ---------- Conexión ---------- */
  const supported = () => !!navigator.requestMIDIAccess;
  async function connect() {
    if (!supported()) return hooks.toast('Este navegador no tiene Web MIDI. Usa Chrome o Edge de escritorio.');
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      return hooks.toast('No se pudo acceder al MIDI: ' + (e.message || 'permiso denegado'));
    }
    access.onstatechange = () => refreshDevices();
    refreshDevices();
    store.autoConnect = true; save();
  }
  function refreshDevices() {
    if (!access) return;
    inputs.clear();
    for (const i of access.inputs.values()) {
      if (i.state !== 'connected') continue;
      inputs.set(i.id, i);
      i.onmidimessage = e => handle(i.name || 'MIDI', e.data);
      if (!store.devices[i.name] || !store.devices[i.name].length) {
        const preset = Object.keys(PRESETS).find(p => matchesPreset(p, i.name));
        if (preset) { store.devices[i.name] = PRESETS[preset].map(m => Object.assign({}, m)); save(); hooks.toast('Controladora «' + i.name + '»: cargado el preset ' + preset + '.'); }
      }
    }
    for (const n of Array.from(outputs.keys())) if (!outputs.get(n).test) outputs.delete(n);
    for (const o of access.outputs.values()) if (o.state === 'connected') outputs.set(o.name || 'MIDI', { send: d => { try { o.send(d); } catch (e) { /* ignorar */ } } });
    render();
  }
  function matchesPreset(preset, name) {
    const n = (name || '').toLowerCase();
    return /ddj-400|ddj-flx4|ddj flx4/.test(n) && preset.startsWith('Pioneer DDJ-400');
  }

  /* ---------- Mensajes ---------- */
  function parse(data) {
    const type = data[0] & 0xf0, ch = data[0] & 0x0f, d1 = data[1] || 0, d2 = data[2] || 0;
    if (type === 0x90 || type === 0x80) return { key: ch + ':n:' + d1, isNote: true, on: type === 0x90 && d2 > 0, value: d2, ch, num: d1 };
    if (type === 0xB0) return { key: ch + ':c:' + d1, isNote: false, value: d2, ch, num: d1 };
    if (type === 0xE0) return { key: ch + ':p', isNote: false, value: (d2 << 7) | d1, bend: true, ch };
    return null;
  }
  const relDelta = v => (v === 64 || v === 0 ? 0 : v <= 32 ? v : v >= 96 ? v - 128 : v - 64);

  function handle(deviceName, data) {
    const msg = parse(data);
    if (!msg) return;
    lastActivity = Date.now();
    if (learning) { assign(deviceName, msg); return; }
    const list = store.devices[deviceName];
    if (!list) return;
    for (const m of list) {
      const a = byId(m.action);
      if (!a) continue;
      if (m.key === msg.key) apply(m, a, msg);
      else if (m.mode === 'abs14' && !msg.isNote && !msg.bend) {
        const parts = m.key.split(':');
        if (parts[1] === 'c' && +parts[0] === msg.ch && +parts[2] + 32 === msg.num) { m.lsb = msg.value; apply(m, a, { key: m.key, value14: (((m.msb || 0) << 7) | msg.value) }); }
      }
    }
  }
  function apply(m, a, msg) {
    if (m.mode === 'button' || a.kind === 'button') {
      const press = msg.isNote ? msg.on : msg.value > 63;
      if (m.lastPress === press) return;
      m.lastPress = press;
      a.run(press ? 1 : 0, press);
      return;
    }
    if (m.mode === 'rel' || a.kind === 'jog' || a.kind === 'encoder') {
      const d = relDelta(msg.value) * (m.invert ? -1 : 1);
      if (d) a.run(d);
      return;
    }
    let norm;
    if (msg.value14 != null) norm = msg.value14 / 16383;
    else if (msg.bend) norm = msg.value / 16383;
    else if (m.mode === 'abs14') { m.msb = msg.value; norm = ((msg.value << 7) | (m.lsb || 0)) / 16383; }
    else norm = msg.value / 127;
    if (m.invert) norm = 1 - norm;
    a.run(norm);
  }

  /* ---------- Aprender ---------- */
  function learn(actionId) {
    learning = learning === actionId ? null : actionId;
    render();
    if (learning) hooks.toast('Mueve o pulsa el control de la controladora para «' + byId(actionId).label + '». Esc cancela.');
  }
  function assign(deviceName, msg) {
    const a = byId(learning);
    const list = mappingsFor(deviceName);
    for (let i = list.length - 1; i >= 0; i--) if (list[i].action === learning || list[i].key === msg.key) list.splice(i, 1);
    const mode = msg.isNote ? 'button' : msg.bend ? 'abs14' : a.kind === 'button' ? 'button' : (a.kind === 'jog' || a.kind === 'encoder') ? 'rel' : 'abs';
    list.push({ key: msg.key, action: learning, mode, invert: a.id.endsWith('.pitch'), led: msg.isNote && !!a.state });
    learning = null;
    save(); render();
    hooks.toast('Asignado: ' + a.label + ' ← ' + describeKey(msg.key) + ' en «' + deviceName + '».');
  }
  function unassign(deviceName, actionId) {
    const list = mappingsFor(deviceName);
    for (let i = list.length - 1; i >= 0; i--) if (list[i].action === actionId) list.splice(i, 1);
    save(); render();
  }
  function describeKey(key) {
    const [ch, t, n] = key.split(':');
    return (t === 'n' ? 'nota ' + n : t === 'c' ? 'CC ' + n : 'pitch bend') + ' · canal ' + (+ch + 1);
  }

  /* ---------- Luces ---------- */
  function ledTick() {
    for (const [name, list] of Object.entries(store.devices)) {
      const out = outputs.get(name);
      if (!out) continue;
      for (const m of list) {
        if (!m.led) continue;
        const a = byId(m.action);
        const parts = m.key.split(':');
        if (!a || !a.state || parts[1] !== 'n') continue;
        let s = false;
        try { s = !!a.state(); } catch (e) { s = false; }
        if (m.lastLed === s) continue;
        m.lastLed = s;
        out.send([0x90 | +parts[0], +parts[2], s ? 127 : 0]);
      }
    }
  }

  /* ---------- Salida de audio ---------- */
  async function listOutputs() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter(d => d.kind === 'audiooutput');
  }
  async function unlockNames() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
    } catch (e) { hooks.toast('Sin permiso de micrófono no se pueden mostrar los nombres de las salidas.'); }
    renderOutputs();
  }
  async function chooseOutput(id) {
    try {
      const r = await Engine.setOutput(id);
      store.output = id; save();
      hooks.toast(r.cue ? 'Salida con ' + r.channels + ' canales: pre-escucha por auriculares activada (canales 3-4).' : 'Salida estéreo: sin canal de pre-escucha.');
    } catch (e) {
      hooks.toast('No se pudo cambiar la salida: ' + e.message);
    }
    renderOutputs();
  }

  /* ---------- UI ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function build(mount, h) {
    Object.assign(hooks, h || {});
    defineActions();
    load();
    el.mount = mount;
    mount.innerHTML =
      '<div class="midi-head"><h2>Controladora</h2><span class="midi-status"></span>' +
        '<div class="midi-actions"><button class="btn primary midi-connect">Conectar controladora</button></div></div>' +
      '<div class="midi-audio">' +
        '<label>Salida de audio <select class="out-select"><option value="">Predeterminada del sistema</option></select></label>' +
        '<button class="btn ghost out-names" title="Pide permiso de micrófono solo para poder leer los nombres de las salidas">Mostrar nombres</button>' +
        '<span class="out-status"></span>' +
      '</div>' +
      '<div class="midi-tools">' +
        '<label>Dispositivo <select class="midi-device"></select></label>' +
        '<label>Preset <select class="midi-preset"><option value="">Elegir…</option>' + Object.keys(PRESETS).map(p => '<option>' + esc(p) + '</option>').join('') + '</select></label>' +
        '<button class="btn ghost midi-export">Exportar</button>' +
        '<label class="btn ghost">Importar<input type="file" class="midi-import" accept="application/json" hidden></label>' +
        '<button class="btn ghost midi-clear">Borrar mapeo</button>' +
      '</div>' +
      '<p class="midi-hint">Pulsa <b>Aprender</b> en una fila y mueve ese control en la controladora. Funciona con cualquier controladora MIDI (Pioneer, Numark, Hercules, Reloop, Denon, Traktor en modo MIDI). Los mapeos se guardan por dispositivo.</p>' +
      '<div class="table-wrap midi-wrap"><table class="lib-table midi-table"><thead><tr><th>Función</th><th>Control</th><th>Modo</th><th>Inv.</th><th>LED</th><th></th></tr></thead><tbody class="midi-rows"></tbody></table></div>';
    const q = s => mount.querySelector(s);
    el.status = q('.midi-status'); el.rows = q('.midi-rows'); el.device = q('.midi-device'); el.preset = q('.midi-preset');
    el.outSelect = q('.out-select'); el.outStatus = q('.out-status');
    q('.midi-connect').addEventListener('click', connect);
    q('.out-names').addEventListener('click', unlockNames);
    el.outSelect.addEventListener('change', () => chooseOutput(el.outSelect.value));
    el.device.addEventListener('change', render);
    el.preset.addEventListener('change', () => {
      const name = currentDevice();
      if (!name || !el.preset.value) return;
      store.devices[name] = PRESETS[el.preset.value].map(m => Object.assign({}, m));
      save(); render(); el.preset.value = '';
      hooks.toast('Preset aplicado a «' + name + '». Corrige lo que no coincida con Aprender.');
    });
    q('.midi-export').addEventListener('click', async () => {
      const name = currentDevice();
      if (!name) return;
      const json = JSON.stringify({ device: name, mappings: mappingsFor(name) }, null, 2);
      if (navigator.clipboard) { try { await navigator.clipboard.writeText(json); return hooks.toast('Mapeo copiado al portapapeles (JSON).'); } catch (e) { /* sigue */ } }
      hooks.toast('No se pudo copiar el mapeo.');
    });
    q('.midi-import').addEventListener('change', async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const d = JSON.parse(await f.text());
        const name = currentDevice() || d.device;
        if (!name || !Array.isArray(d.mappings)) throw new Error('formato');
        store.devices[name] = d.mappings; save(); render();
        hooks.toast('Mapeo importado para «' + name + '».');
      } catch (err) { hooks.toast('El archivo no es un mapeo válido.'); }
      e.target.value = '';
    });
    q('.midi-clear').addEventListener('click', async () => {
      const name = currentDevice(); if (!name) return;
      if (await Dialogs.confirm('¿Borrar el mapeo de «' + name + '»?', '', 'Borrar')) { store.devices[name] = []; save(); render(); }
    });
    el.rows.addEventListener('click', e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const id = b.closest('tr').dataset.id;
      if (b.dataset.act === 'learn') learn(id);
      else if (b.dataset.act === 'del') unassign(currentDevice(), id);
    });
    el.rows.addEventListener('change', e => {
      const tr = e.target.closest('tr'); if (!tr) return;
      const m = mappingsFor(currentDevice()).find(x => x.action === tr.dataset.id); if (!m) return;
      if (e.target.classList.contains('m-mode')) m.mode = e.target.value;
      if (e.target.classList.contains('m-inv')) m.invert = e.target.checked;
      if (e.target.classList.contains('m-led')) { m.led = e.target.checked; m.lastLed = undefined; }
      save();
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && learning) { learning = null; render(); } });
    setInterval(ledTick, LED_MS);
    setInterval(() => { if (el.status) el.status.classList.toggle('blink', Date.now() - lastActivity < 150); }, 100);
    render();
    renderOutputs();
    if (store.autoConnect && supported()) connect();
  }
  function currentDevice() {
    if (el.device && el.device.value) return el.device.value;
    const first = inputs.values().next().value;
    return first ? first.name : (Object.keys(store.devices)[0] || null);
  }
  function render() {
    if (!el.mount) return;
    const names = new Set([...Array.from(inputs.values()).map(i => i.name), ...Object.keys(store.devices)]);
    const cur = currentDevice();
    el.device.innerHTML = names.size ? Array.from(names).map(n => '<option' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>').join('') : '<option value="">(sin controladora)</option>';
    const connected = Array.from(inputs.values()).map(i => i.name);
    el.status.textContent = !supported() ? 'Este navegador no tiene Web MIDI (usa Chrome o Edge de escritorio)'
      : !access ? 'Sin conectar'
      : connected.length ? 'Conectada: ' + connected.join(', ') : 'MIDI activo · conecta una controladora por USB';
    const list = cur ? mappingsFor(cur) : [];
    let group = '';
    el.rows.innerHTML = ACTIONS.map(a => {
      const m = list.find(x => x.action === a.id);
      const head = a.group !== group ? '<tr class="midi-group"><td colspan="6">' + esc(a.group) + '</td></tr>' : '';
      group = a.group;
      const isLearning = learning === a.id;
      const modes = ['button', 'abs', 'abs14', 'rel'];
      const modeLabel = { button: 'Botón', abs: 'Absoluto', abs14: 'Absoluto 14 bit', rel: 'Relativo' };
      return head + '<tr data-id="' + a.id + '" class="' + (isLearning ? 'learning' : m ? 'mapped' : '') + '">' +
        '<td>' + esc(a.label) + '</td>' +
        '<td class="midi-key">' + (isLearning ? 'mueve el control…' : m ? esc(describeKey(m.key)) : '—') + '</td>' +
        '<td>' + (m ? '<select class="m-mode">' + modes.map(x => '<option value="' + x + '"' + (m.mode === x ? ' selected' : '') + '>' + modeLabel[x] + '</option>').join('') + '</select>' : '') + '</td>' +
        '<td>' + (m ? '<input type="checkbox" class="m-inv"' + (m.invert ? ' checked' : '') + '>' : '') + '</td>' +
        '<td>' + (m && a.state ? '<input type="checkbox" class="m-led"' + (m.led ? ' checked' : '') + '>' : '') + '</td>' +
        '<td class="t-act"><button data-act="learn" class="' + (isLearning ? 'on' : '') + '">' + (isLearning ? 'Cancelar' : 'Aprender') + '</button>' + (m ? '<button data-act="del" class="del" title="Quitar">×</button>' : '') + '</td>' +
      '</tr>';
    }).join('');
  }
  async function renderOutputs() {
    if (!el.outSelect) return;
    const devs = await listOutputs();
    const cur = store.output || '';
    el.outSelect.innerHTML = '<option value="">Predeterminada del sistema</option>' +
      devs.filter(d => d.deviceId && d.deviceId !== 'default').map((d, i) => '<option value="' + esc(d.deviceId) + '"' + (d.deviceId === cur ? ' selected' : '') + '>' + esc(d.label || ('Salida ' + (i + 1))) + '</option>').join('');
    const st = Engine.outputStatus();
    el.outStatus.textContent = !Engine.ctx.setSinkId ? 'Este navegador no permite elegir la salida.'
      : st.cue ? 'Pre-escucha activa: master en canales 1-2, auriculares en 3-4.' : 'Salida estéreo: la pre-escucha necesita una tarjeta de 4 canales (la de la controladora).';
  }

  /* Para pruebas y depuración: inyectar mensajes y salidas falsas. */
  function _test(name, sendFn) { outputs.set(name, { send: sendFn, test: true }); if (!store.devices[name]) store.devices[name] = []; render(); }

  return { build, connect, handle, learn, unassign, mappingsFor, relDelta, parse, PRESETS, ACTIONS, _test, get learning() { return learning; }, get store() { return store; } };
})();
