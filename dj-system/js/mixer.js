/* Mezclador central: trim, EQ de 3 bandas, medidores, faders de canal y crossfader. */
const Mixer = (() => {
  let decks = {};
  let vuCanvases = {};
  let xfInput = null;
  const knobs = { A: {}, B: {} };
  const faders = {};
  const pflBtns = {};
  let phonesKnob = null;

  const dbFmt = v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';

  function build(mount, deckA, deckB) {
    decks = { A: deckA, B: deckB };
    mount.innerHTML =
      '<div class="mixer-title">MIXER</div>' +
      '<div class="strips">' +
        '<div class="strip" data-deck="A"></div>' +
        '<div class="strip" data-deck="B"></div>' +
      '</div>' +
      '<div class="xfader-wrap">' +
        '<span class="xf-label xf-a">A</span>' +
        '<input type="range" class="xfader" min="-1" max="1" step="0.01" value="0" title="Crossfader (← →)">' +
        '<span class="xf-label xf-b">B</span>' +
      '</div>' +
      '<div class="phones-wrap"></div>';

    for (const id of ['A', 'B']) {
      const deck = decks[id];
      const strip = mount.querySelector('.strip[data-deck="' + id + '"]');
      strip.style.setProperty('--accent', deck.color);
      const knobBox = document.createElement('div');
      knobBox.className = 'strip-knobs';
      const k = knobs[id];
      k.trim = createKnob({ label: 'TRIM', min: -12, max: 12, value: 0, format: dbFmt, onChange: v => deck.setTrim(v) });
      k.high = createKnob({ label: 'HI', min: -24, max: 12, value: 0, format: dbFmt, onChange: v => deck.setEq('high', v) });
      k.mid = createKnob({ label: 'MID', min: -24, max: 12, value: 0, format: dbFmt, onChange: v => deck.setEq('mid', v) });
      k.low = createKnob({ label: 'LOW', min: -24, max: 12, value: 0, format: dbFmt, onChange: v => deck.setEq('low', v) });
      knobBox.append(k.trim.el, k.high.el, k.mid.el, k.low.el);
      const lower = document.createElement('div');
      lower.className = 'strip-lower';
      lower.innerHTML =
        '<canvas class="vu"></canvas>' +
        '<input type="range" class="fader" min="0" max="1" step="0.01" value="1" title="Volumen canal ' + id + '">';
      const badge = document.createElement('div');
      badge.className = 'strip-badge';
      badge.textContent = id;
      const pfl = document.createElement('button');
      pfl.className = 'btn pfl';
      pfl.textContent = '🎧 CUE';
      pfl.title = 'Pre-escucha en auriculares (canales 3-4 de la tarjeta)';
      pfl.addEventListener('click', () => setPfl(id, !deck.pfl));
      pflBtns[id] = pfl;
      strip.append(knobBox, lower, pfl, badge);
      vuCanvases[id] = lower.querySelector('.vu');
      faders[id] = lower.querySelector('.fader');
      faders[id].addEventListener('input', e => deck.setFader(parseFloat(e.target.value)));
    }

    xfInput = mount.querySelector('.xfader');
    xfInput.addEventListener('input', () => applyXf(parseFloat(xfInput.value)));
    applyXf(0);
    phonesKnob = createKnob({ label: 'PHONES', min: 0, max: 1, value: 0.8, format: v => Math.round(v * 100) + '%', onChange: v => Engine.setPhones(v) });
    mount.querySelector('.phones-wrap').appendChild(phonesKnob.el);
  }
  function setPfl(id, on) { decks[id].setPfl(on); pflBtns[id].classList.toggle('on', !!on); }
  function getPfl(id) { return !!decks[id].pfl; }
  function setFader(id, v) { v = Math.max(0, Math.min(1, v)); faders[id].value = v; decks[id].setFader(v); }

  /* Curva suave: ambos canales al 100% en el centro, silencio total en el extremo opuesto. */
  function applyXf(v) {
    const a = Math.min(1, Math.cos((v + 1) * Math.PI / 4) * Math.SQRT2);
    const b = Math.min(1, Math.sin((v + 1) * Math.PI / 4) * Math.SQRT2);
    decks.A.setCrossfadeGain(a);
    decks.B.setCrossfadeGain(b);
  }
  function setXf(v) {
    v = Math.max(-1, Math.min(1, v));
    xfInput.value = v;
    applyXf(v);
  }
  function getXf() { return parseFloat(xfInput.value); }
  function nudgeXf(d) { setXf(getXf() + d); }
  function setEq(id, band, db) { knobs[id][band].set(db); }
  function getEq(id, band) { return knobs[id][band].value; }
  function getFader(id) { return parseFloat(faders[id].value); }

  function drawVu(cv, level, peak, color) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 14, h = cv.clientHeight || 100;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const segs = 16, gap = 2, sh = (h - gap * (segs - 1)) / segs;
    for (let i = 0; i < segs; i++) {
      const frac = (i + 1) / segs;
      const y = h - (i + 1) * sh - i * gap;
      const lit = level >= frac - 1 / segs / 2;
      const col = i >= segs - 2 ? '#ef4444' : i >= segs - 5 ? '#facc15' : color;
      g.globalAlpha = lit ? 1 : 0.13;
      g.fillStyle = col;
      g.fillRect(0, y, w, sh);
    }
    g.globalAlpha = 1;
    if (peak > 0.02) {
      const y = h - peak * h;
      g.fillStyle = '#fff';
      g.fillRect(0, Math.max(0, y - 1), w, 2);
    }
  }

  function draw() {
    for (const id of ['A', 'B']) {
      const d = decks[id];
      drawVu(vuCanvases[id], d.vu.level, d.vu.peak, d.color);
    }
  }

  return { build, draw, nudgeXf, setXf, getXf, setEq, getEq, getFader, setFader, setPfl, getPfl, drawVu };
})();
