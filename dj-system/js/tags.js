/* Lectura de etiquetas ID3v2 (título, artista, álbum, BPM, tonalidad, carátula) con
   respaldo en el nombre de archivo "Artista - Título". */
const Tags = (() => {
  async function read(file) {
    const out = { title: null, artist: null, album: null, cover: null, bpm: null, key: null };
    try {
      if (/\.mp3$/i.test(file.name) || file.type === 'audio/mpeg' || file.type === 'audio/mp3') Object.assign(out, await readId3(file));
    } catch (e) { /* etiquetas corruptas: seguimos con el nombre */ }
    if (!out.title) {
      const base = file.name.replace(/\.[^.]+$/, '');
      const m = base.match(/^(.+?)\s+-\s+(.+)$/);
      if (m) { if (!out.artist) out.artist = m[1].trim(); out.title = m[2].trim(); }
      else out.title = base;
    }
    return out;
  }

  function syncsafe(v, o) { return (v.getUint8(o) << 21) | (v.getUint8(o + 1) << 14) | (v.getUint8(o + 2) << 7) | v.getUint8(o + 3); }
  const decoders = {};
  function decode(enc, bytes) {
    let label = enc === 0 ? 'iso-8859-1' : enc === 1 ? 'utf-16' : enc === 2 ? 'utf-16be' : 'utf-8';
    if (enc === 0) {
      // Muchas etiquetas "latin1" traen en realidad UTF-8; si decodifica estricto, lo usamos.
      try { decoders.strict = decoders.strict || new TextDecoder('utf-8', { fatal: true }); decoders.strict.decode(bytes); label = 'utf-8'; } catch (e) { /* latin1 real */ }
    }
    decoders[label] = decoders[label] || new TextDecoder(label);
    return decoders[label].decode(bytes).replace(/\0+$/g, '').split('\0')[0].trim();
  }

  async function readId3(file) {
    const head = new DataView(await file.slice(0, 10).arrayBuffer());
    if (head.byteLength < 10 || head.getUint8(0) !== 0x49 || head.getUint8(1) !== 0x44 || head.getUint8(2) !== 0x33) return {};
    const ver = head.getUint8(3), flags = head.getUint8(5);
    if (ver < 3) return {};
    const size = syncsafe(head, 6);
    const buf = await file.slice(10, 10 + size).arrayBuffer();
    const v = new DataView(buf), u8 = new Uint8Array(buf);
    let pos = 0;
    if (flags & 0x40) pos += ver === 4 ? syncsafe(v, 0) : v.getUint32(0) + 4;
    const out = {};
    while (pos + 10 <= size) {
      if (u8[pos] === 0) break;
      const id = String.fromCharCode(u8[pos], u8[pos + 1], u8[pos + 2], u8[pos + 3]);
      const fsize = ver === 4 ? syncsafe(v, pos + 4) : v.getUint32(pos + 4);
      const fflags = v.getUint16(pos + 8);
      pos += 10;
      if (fsize <= 0 || pos + fsize > size) break;
      const data = u8.subarray(pos, pos + fsize);
      pos += fsize;
      if (ver === 4 && (fflags & 0x0c)) continue;   // comprimido o cifrado
      if (id[0] === 'T' && id !== 'TXXX') {
        const text = decode(data[0], data.subarray(1));
        if (id === 'TIT2') out.title = text;
        else if (id === 'TPE1') out.artist = text;
        else if (id === 'TALB') out.album = text;
        else if (id === 'TBPM') { const n = parseFloat(text); if (n > 40 && n < 300) out.bpm = n; }
        else if (id === 'TKEY') out.key = text;
      } else if (id === 'APIC' && !out.cover) {
        const enc = data[0];
        let i = 1;
        while (i < data.length && data[i] !== 0) i++;
        const mime = decode(0, data.subarray(1, i)) || 'image/jpeg';
        i += 2;   // null + tipo de imagen
        if (enc === 1 || enc === 2) { while (i + 1 < data.length && (data[i] !== 0 || data[i + 1] !== 0)) i += 2; i += 2; }
        else { while (i < data.length && data[i] !== 0) i++; i += 1; }
        if (i < data.length) out.cover = new Blob([data.slice(i)], { type: mime });
      }
    }
    return out;
  }

  return { read };
})();
