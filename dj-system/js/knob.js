/* Perilla rotatoria: arrastrar vertical para ajustar, rueda del mouse, doble clic para reiniciar. */
function createKnob(opts) {
  const o = Object.assign({
    min: 0, max: 1, value: 0, def: null, label: '',
    format: v => v.toFixed(2), onChange: () => {}, color: 'var(--accent)'
  }, opts);
  const def = o.def === null ? o.value : o.def;
  const bipolar = o.min < 0 && o.max > 0;
  let value = o.value;

  const el = document.createElement('div');
  el.className = 'knob';
  el.title = 'Arrastra para ajustar · doble clic para reiniciar · Shift = ajuste fino';
  el.innerHTML = '<div class="knob-ring"><div class="knob-dial"></div></div>' +
    '<div class="knob-label">' + o.label + '</div><div class="knob-value"></div>';
  const ring = el.querySelector('.knob-ring');
  const dial = el.querySelector('.knob-dial');
  const valEl = el.querySelector('.knob-value');

  function render() {
    const n = (value - o.min) / (o.max - o.min);
    const ang = -135 + n * 270;
    dial.style.transform = 'rotate(' + ang + 'deg)';
    let start, len;
    if (bipolar) {
      const zero = -135 + ((0 - o.min) / (o.max - o.min)) * 270;
      start = Math.min(zero, ang);
      len = Math.abs(ang - zero);
    } else {
      start = -135;
      len = n * 270;
    }
    ring.style.background =
      'conic-gradient(from ' + start + 'deg, ' + o.color + ' 0deg ' + len + 'deg, transparent ' + len + 'deg 360deg),' +
      'conic-gradient(from -135deg, rgba(255,255,255,.1) 0deg 270deg, transparent 270deg 360deg)';
  }

  function set(v, silent) {
    v = Math.min(o.max, Math.max(o.min, v));
    value = v;
    render();
    valEl.textContent = o.format(v);
    if (!silent) o.onChange(v);
  }

  let drag = null;
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, v: value };
    el.setPointerCapture(e.pointerId);
    el.classList.add('active');
    e.preventDefault();
  });
  el.addEventListener('pointermove', e => {
    if (!drag) return;
    const fine = e.shiftKey ? 0.15 : 1;
    set(drag.v + (drag.y - e.clientY) * (o.max - o.min) / 150 * fine);
  });
  const end = () => { if (drag) { drag = null; el.classList.remove('active'); } };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => set(def));
  el.addEventListener('wheel', e => {
    e.preventDefault();
    set(value - Math.sign(e.deltaY) * (o.max - o.min) / 50);
  }, { passive: false });

  set(value, true);
  return { el, set, get value() { return value; } };
}
