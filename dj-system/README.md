# MIXDECK · Mezclador DJ en el navegador

Prototipo funcional de un sistema de DJ que corre completo en el navegador, sin servidor ni dependencias.
Está hecho con HTML, CSS y JavaScript puro sobre la Web Audio API.

## Cómo probarlo

Abre `index.html` directamente en Chrome, Edge o Firefox recientes. Si prefieres servirlo:

```bash
npx serve dj-system
```

El audio se activa con el primer clic en la página (política de autoplay de los navegadores).

## Qué incluye

- **Dos decks** con onda ampliada (8 s alrededor del cabezal, con grilla de beats) y onda completa clicable para saltar.
- **Transporte estilo CDJ**: Play/Pause, CUE (fija, vuelve y previsualiza mientras se mantiene), 4 hot cues por deck.
- **Loops**: in/out manual, loop automático de 4 beats alineado a la grilla, mitad, doble y salir.
- **Pitch** ±16 % con lectura de porcentaje, pitch bend momentáneo y botón de reinicio.
- **BPM automático** al agregar una pista (detección por energía en graves) con corrección manual al hacer clic en el BPM.
- **SYNC**: iguala el tempo con el otro deck y alinea la fase de los beats si ambos están sonando.
- **Mixer**: trim, EQ de tres bandas, medidores de nivel por canal, faders y crossfader con curva suave.
- **Efectos por deck**: filtro barrido (pasa bajos / pasa altos), eco sincronizado al tempo y reverb.
- **Grabación de la mezcla** desde el bus master, con descarga en WebM/Opus (u OGG/M4A según el navegador).
- **Biblioteca** con arrastrar y soltar. Las pistas quedan guardadas en IndexedDB, así que siguen ahí al recargar.
- **Atajos de teclado** para todo el transporte (botón "? Atajos" o tecla `?`).

## Conexión con Spotify

La app se conecta a tu cuenta de Spotify con OAuth PKCE, sin servidor propio. Con eso puedes:

- Buscar en el catálogo de Spotify e importar tus playlists como setlists.
- Ver qué pistas de una playlist ya tienes como archivo en la biblioteca local y cargarlas al deck A o B con un clic.
- Escuchar la pista completa con el reproductor integrado (Web Playback SDK, requiere Spotify Premium).

### Lo que Spotify no permite

Los términos para desarrolladores de Spotify prohíben mezclar, hacer segue u overlap de su contenido con otro audio,
y el reproductor web entrega el sonido cifrado (DRM). Por eso el audio de Spotify **no pasa por el mixer**: no se le
puede aplicar EQ, pitch, loops ni efectos, y la app pausa Spotify cuando arranca un deck (y viceversa). Además,
desde noviembre de 2024 las apps nuevas no reciben BPM (`audio-features`) ni previews de 30 segundos. Para mezclar
necesitas los archivos de audio; Spotify sirve para preparar el set.

### Configuración (una sola vez)

1. Spotify exige abrir la app desde `http://127.0.0.1` o `https`, no desde un archivo local. En esta carpeta:

   ```bash
   python3 -m http.server 8080 --bind 127.0.0.1
   ```

   y abre `http://127.0.0.1:8080/`. (También sirve publicarla en GitHub Pages u otro hosting https.)
2. Entra a `developer.spotify.com/dashboard`, crea una app y en **Redirect URIs** agrega exactamente la URL que muestra
   el botón ⚙ de la sección Spotify (por ejemplo `http://127.0.0.1:8080/index.html`). Marca **Web API** y
   **Web Playback SDK**.
3. Copia el **Client ID** en el diálogo ⚙ y pulsa "Conectar con Spotify".
4. Mientras la app de Spotify esté en modo desarrollo, agrega en **User Management** las cuentas que podrán entrar (hasta 25).

## Estructura

```
dj-system/
├── index.html      Maquetado general
├── styles.css      Tema oscuro y layout responsivo
└── js/
    ├── engine.js   Contexto de audio, bus master, grabación
    ├── knob.js     Perilla rotatoria reutilizable
    ├── bpm.js      Detección de BPM y fase del beat
    ├── library.js  Biblioteca, decodificación, IndexedDB
    ├── deck.js     Reproducción, cue, loops, pitch, sync, FX, dibujo
    ├── mixer.js    Strips de canal, medidores, crossfader
    ├── spotify.js  OAuth PKCE, búsqueda, playlists, cruce con biblioteca, reproductor
    └── app.js      Wiring, teclado, grabación, ayuda
```

## Limitaciones conocidas del prototipo

- No hay salida de pre-escucha (auriculares) separada: los navegadores exponen una sola salida de audio.
- Los formatos soportados dependen del navegador (MP3, WAV, OGG y AAC funcionan en todos; FLAC no en Safari).
- La detección de BPM funciona bien en música con pulso marcado; en material sin bajo claro conviene corregir a mano.
- No hay cuenta de usuario ni sincronización entre dispositivos: todo vive en el navegador local.
- Spotify solo sirve para buscar, armar setlists y escuchar; su audio no se puede mezclar (ver arriba).

## Siguientes pasos sugeridos

1. Soporte de controladoras MIDI (Web MIDI API) para jog wheels y pads.
2. Análisis de tonalidad (key detection) para mezcla armónica.
3. Listas de reproducción y etiquetas en la biblioteca.
4. Backend opcional para compartir bibliotecas y grabaciones entre dispositivos.
