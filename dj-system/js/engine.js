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

  /* Bus de pre-escucha (auriculares): los decks con CUE envían aquí, antes del fader. */
  const cueBus = ctx.createGain();
  const phones = ctx.createGain();
  phones.gain.value = 0.8;
  cueBus.connect(phones);
  let fourCh = false, merger = null, sinkId = '';

  let recDest = null;
  let recorder = null;
  let chunks = [];

  function resume() {
    if (ctx.state !== 'running') ctx.resume();
  }
  function setMaster(v) { master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime, 0.01); }
  function setPhones(v) { phones.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), ctx.currentTime, 0.01); }

  /* Elige la tarjeta de salida; con 4 canales o más, master en 1-2 y auriculares en 3-4. */
  async function setOutput(deviceId) {
    if (!ctx.setSinkId) throw new Error('este navegador no permite elegir la salida');
    await ctx.setSinkId(deviceId || '');
    sinkId = deviceId || '';
    return configureChannels();
  }
  function configureChannels() {
    const max = ctx.destination.maxChannelCount || 2;
    if (max >= 4 && !fourCh) {
      try {
        ctx.destination.channelCount = 4;
        ctx.destination.channelCountMode = 'explicit';
        ctx.destination.channelInterpretation = 'discrete';
        merger = ctx.createChannelMerger(4);
        const sm = ctx.createChannelSplitter(2), sc = ctx.createChannelSplitter(2);
        analyser.disconnect(ctx.destination);
        analyser.connect(sm); sm.connect(merger, 0, 0); sm.connect(merger, 1, 1);
        phones.connect(sc); sc.connect(merger, 0, 2); sc.connect(merger, 1, 3);
        merger.connect(ctx.destination);
        fourCh = true;
      } catch (e) { fourCh = false; }
    } else if (max < 4 && fourCh) {
      try { merger.disconnect(); analyser.connect(ctx.destination); ctx.destination.channelCount = 2; } catch (e) { /* ignorar */ }
      fourCh = false; merger = null;
    }
    return { channels: max, cue: fourCh };
  }
  function outputStatus() { return { sink: sinkId, channels: ctx.destination.maxChannelCount || 2, cue: fourCh }; }

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
    ctx, master, analyser, cueBus, phones, resume, startRecording, stopRecording, makeImpulse, dbToGain,
    setMaster, setPhones, setOutput, outputStatus,
    get recording() { return !!recorder; }
  };
})();
