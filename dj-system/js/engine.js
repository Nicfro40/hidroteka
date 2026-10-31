/* Motor de audio compartido: contexto, bus master, medidor y grabación de la mezcla. */
const Engine = (() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC({ latencyHint: 'interactive' });

  const master = ctx.createGain();
  master.gain.value = 0.9;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  master.connect(analyser);
  analyser.connect(ctx.destination);

  let recDest = null;
  let recorder = null;
  let chunks = [];

  function resume() {
    if (ctx.state !== 'running') ctx.resume();
  }

  function startRecording() {
    if (recorder || !window.MediaRecorder) return false;
    if (!recDest) {
      recDest = ctx.createMediaStreamDestination();
      master.connect(recDest);
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      .find(m => MediaRecorder.isTypeSupported(m));
    chunks = [];
    try {
      recorder = new MediaRecorder(recDest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
    } catch (e) {
      recorder = null;
      return false;
    }
    recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(1000);
    return true;
  }

  function stopRecording() {
    return new Promise(resolve => {
      if (!recorder) return resolve(null);
      const r = recorder;
      recorder = null;
      r.onstop = () => resolve(new Blob(chunks, { type: r.mimeType || 'audio/webm' }));
      r.stop();
    });
  }

  /* Respuesta al impulso sintética (ruido con caída exponencial) para la reverb. */
  function makeImpulse(seconds, decay) {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function dbToGain(db) { return Math.pow(10, db / 20); }

  return {
    ctx, master, analyser, resume, startRecording, stopRecording, makeImpulse, dbToGain,
    get recording() { return !!recorder; }
  };
})();
