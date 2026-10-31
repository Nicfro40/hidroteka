/* Diálogos propios (en lugar de prompt/confirm, que algunos entornos bloquean). */
const Dialogs = (() => {
  let dlg = null;
  function ensure() {
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.className = 'ui-dialog';
    dlg.innerHTML = '<form method="dialog"><h3 class="ui-title"></h3><p class="ui-text"></p>' +
      '<input class="ui-input" autocomplete="off" spellcheck="false">' +
      '<div class="ui-actions"><button type="button" class="btn ghost ui-cancel">Cancelar</button><button type="submit" class="btn primary ui-ok">Aceptar</button></div></form>';
    document.body.appendChild(dlg);
    return dlg;
  }
  function open(opts) {
    const d = ensure();
    d.querySelector('.ui-title').textContent = opts.title || '';
    const text = d.querySelector('.ui-text');
    text.textContent = opts.text || '';
    text.classList.toggle('hidden', !opts.text);
    const input = d.querySelector('.ui-input');
    input.classList.toggle('hidden', !opts.input);
    input.value = opts.value == null ? '' : String(opts.value);
    input.placeholder = opts.placeholder || '';
    d.querySelector('.ui-ok').textContent = opts.ok || 'Aceptar';
    d.querySelector('.ui-cancel').textContent = opts.cancel || 'Cancelar';
    return new Promise(resolve => {
      const form = d.querySelector('form');
      const done = v => { form.onsubmit = null; d.onclose = null; cancelBtn.onclick = null; if (d.open) d.close(); resolve(v); };
      const cancelBtn = d.querySelector('.ui-cancel');
      form.onsubmit = e => { e.preventDefault(); done(opts.input ? input.value : true); };
      cancelBtn.onclick = () => done(null);
      d.onclose = () => done(null);
      try { d.showModal(); } catch (e) { done(null); return; }
      if (opts.input) { input.focus(); input.select(); }
    });
  }
  const prompt = (title, value, text) => open({ title, text, input: true, value });
  const confirm = (title, text, ok) => open({ title, text, ok: ok || 'Sí' }).then(v => v === true);
  return { prompt, confirm };
})();
