// O FFmpeg de verdade aceita os grafos e filtros que o app monta?
// É o teste que pega o erro que o teste de texto não pega: "# é comentário",
// rótulo inexistente, colchete a mais, NaN no filtro...

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const A = require('./_ajudas');
const F = require('../../lib/filtros');
const M = require('../../lib/montagem');

// O volumedetect mede silêncio digital em AAC como -91 dB, não como -inf
const SILENCIO_DB = -80;

const quadro = { width: 320, height: 180 };
const layoutCheio = { drawWidth: 320, drawHeight: 180, x: 0, y: 0 };
const fundoPreto = { mode: 'color', color: '#000000' };

// --- buildMediaComposite --------------------------------------------------

const variacoes = {
  'sem ajustes': {},
  'girar 90': { rotate: 90 },
  'girar 180': { rotate: 180 },
  'girar 270': { rotate: 270 },
  'espelhos': { flipH: true, flipV: true },
  'cor': { color: { brightness: 0.2, contrast: 1.4, saturation: 0.6 } },
  'cor parcial (só brilho)': { color: { brightness: 0.3 } },
  'chroma': { chroma: { color: '#00ff00', similarity: 0.3, blend: 0.1 } },
  'opacidade': { opacity: 0.5 },
  'borrão de região': { blurRegion: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } },
  'tudo junto': {
    rotate: 90, flipH: true,
    color: { brightness: 0.1, contrast: 1.2, saturation: 1.1 },
    opacity: 0.8, blurRegion: { x: 0.2, y: 0.2, w: 0.3, h: 0.3 }
  }
};

for (const [nome, ajuste] of Object.entries(variacoes)) {
  test(`buildMediaComposite: o ffmpeg aceita o grafo (${nome})`, () => {
    const adjust = F.normalizeAdjust(ajuste);
    const graph = F.buildMediaComposite(quadro, layoutCheio, fundoPreto, null, adjust, { width: 320, height: 180 });
    const r = A.ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc=d=1:s=320x180:r=10',
      '-filter_complex', graph, '-map', '[v]', '-frames:v', '3', '-f', 'null', '-'
    ]);
    assert.ok(r.ok, `grafo recusado: ${graph}\n${r.erro}`);
  });
}

test('buildMediaComposite: fundo desfocado e fundo de cor com #: o ffmpeg aceita', () => {
  for (const fundo of [{ mode: 'blur', color: '#000000' }, { mode: 'color', color: '#aa33cc' }]) {
    const graph = F.buildMediaComposite(quadro, layoutCheio, fundo, null);
    const r = A.ffmpeg(['-f', 'lavfi', '-i', 'testsrc=d=1:s=320x180:r=10', '-filter_complex', graph, '-map', '[v]', '-frames:v', '2', '-f', 'null', '-']);
    assert.ok(r.ok, `${fundo.mode}: ${r.erro}`);
  }
});

test('buildMediaComposite: com áudio mapeia [a] e a pré-cadeia de velocidade é aceita', (t) => {
  const dir = A.pastaTemporaria(t);
  const video = A.criarVideo(dir, 'v', { segundos: 2 });
  const graph = F.buildMediaComposite(quadro, layoutCheio, fundoPreto, '0:a', undefined, undefined, 'setpts=PTS/2');
  const saida = path.join(dir, 'saida.mp4');
  const r = A.ffmpeg(['-i', video, '-filter_complex', graph, '-map', '[v]', '-map', '[a]', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', saida]);
  assert.ok(r.ok, r.erro);
  const info = A.probe(saida);
  assert.ok(info.temVideo && info.temAudio);
});

// --- encaixar x preencher ------------------------------------------------------

for (const fit of ['contain', 'cover']) {
  test(`buildScaleFilter: ${fit} entrega exatamente o tamanho pedido`, (t) => {
    const dir = A.pastaTemporaria(t);
    const video = A.criarVideo(dir, 'v', { segundos: 1, comAudio: false });
    const saida = path.join(dir, 's.mp4');
    const r = A.ffmpeg(['-i', video, '-vf', F.buildScaleFilter({ width: 100, height: 200, fit }), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', saida]);
    assert.ok(r.ok, r.erro);
    const info = A.probe(saida);
    assert.deepEqual([info.largura, info.altura], [100, 200]);
  });
}

// --- velocidade do áudio ------------------------------------------------------

for (const speed of [0.25, 0.5, 2, 4, 8]) {
  test(`buildAtempoChain: o áudio a ${speed}x dura ${1 / speed}x do original`, (t) => {
    const dir = A.pastaTemporaria(t);
    const audio = A.criarAudio(dir, 'a', { segundos: 4 });
    const saida = path.join(dir, 'o.wav');
    const r = A.ffmpeg(['-i', audio, '-af', F.buildAtempoChain(speed), saida]);
    assert.ok(r.ok, r.erro);
    const esperado = 4 / speed;
    assert.ok(Math.abs(A.probe(saida).duracao - esperado) < 0.15, `esperado ~${esperado}s, saiu ${A.probe(saida).duracao}s`);
  });
}

// --- composição final (sobreposição + mistura de áudio) --------------------

// Monta e executa o passe final como o main.js faz
function comporFinal(dir, { base, overlays = [], audios = [], duration }) {
  const entradas = [base.arquivo];
  const ov = overlays.map((o, i) => {
    entradas.push(o.arquivo);
    return {
      item: o.item, hasAudio: o.hasAudio, inputIndex: entradas.length - 1,
      layout: { drawWidth: 160, drawHeight: 90, x: 10, y: 10 }, effectiveSize: { width: 320, height: 180 }
    };
  });
  const au = audios.map((a) => {
    entradas.push(a.arquivo);
    return { item: a.item, inputIndex: entradas.length - 1 };
  });
  const { graph, videoMap, audioMap } = M.buildCompositionGraph(ov, au, { width: 320, height: 180, fps: 10 }, duration, null);
  const saida = path.join(dir, 'final.mp4');
  const args = [];
  entradas.forEach((e) => args.push('-i', e));
  if (graph) args.push('-filter_complex', graph);
  args.push('-map', videoMap, '-map', audioMap, '-t', String(duration), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', saida);
  const r = A.ffmpeg(args);
  return { r, saida, graph };
}

const itemDe = (extra = {}) => ({ timelineStart: 0, sourceStart: 0, sourceEnd: 2, speed: 1, volume: 1, muted: false, ...extra });

test('buildCompositionGraph: só a base (sem camadas) produz um arquivo válido', (t) => {
  const dir = A.pastaTemporaria(t);
  const base = A.criarVideo(dir, 'base', { segundos: 2 });
  const { r, saida } = comporFinal(dir, { base: { arquivo: base }, duration: 2 });
  assert.ok(r.ok, r.erro);
  const info = A.probe(saida);
  assert.ok(info.temVideo && info.temAudio);
});

test('buildCompositionGraph: sobreposição de vídeo com áudio + trilha, tudo junto, o ffmpeg aceita', (t) => {
  const dir = A.pastaTemporaria(t);
  const base = A.criarVideo(dir, 'base', { segundos: 3 });
  const sobre = A.criarVideo(dir, 'sobre', { segundos: 1 });
  const trilha = A.criarAudio(dir, 'trilha', { segundos: 2 });
  const { r, saida, graph } = comporFinal(dir, {
    base: { arquivo: base },
    overlays: [{ arquivo: sobre, hasAudio: true, item: itemDe({ timelineStart: 1, sourceEnd: 1, opacity: 0.8, rotate: 90 }) }],
    audios: [{ arquivo: trilha, item: itemDe({ timelineStart: 0.5, volume: 0.5, speed: 2, normalize: true }) }],
    duration: 3
  });
  assert.ok(r.ok, `${r.erro}\n${graph}`);
  const info = A.probe(saida);
  assert.ok(info.temVideo && info.temAudio);
  assert.ok(Math.abs(info.duracao - 3) < 0.3, `duração ${info.duracao}`);
});

test('mixagem: trilha com volume 0% fica em silêncio no arquivo (e não a 100%)', (t) => {
  const dir = A.pastaTemporaria(t);
  const base = A.criarVideo(dir, 'base', { segundos: 2, silencioso: true });
  const trilha = A.criarAudio(dir, 'trilha', { segundos: 2 });

  const mudo = comporFinal(dir, { base: { arquivo: base }, audios: [{ arquivo: trilha, item: itemDe({ volume: 0 }) }], duration: 2 });
  assert.ok(mudo.r.ok, mudo.r.erro);
  assert.ok(A.picoDb(mudo.saida) < SILENCIO_DB, `volume 0% deveria ser silêncio (pico ${A.picoDb(mudo.saida)} dB)`);
});

test('mixagem: trilha com volume 100% é audível, e 50% é mais baixa que 100%', (t) => {
  const dir = A.pastaTemporaria(t);
  const base = A.criarVideo(dir, 'base', { segundos: 2, silencioso: true });
  const trilha = A.criarAudio(dir, 'trilha', { segundos: 2 });
  const pico = (volume) => {
    const sub = path.join(dir, `v${volume}`);
    require('fs').mkdirSync(sub);
    const c = comporFinal(sub, { base: { arquivo: base }, audios: [{ arquivo: trilha, item: itemDe({ volume }) }], duration: 2 });
    assert.ok(c.r.ok, c.r.erro);
    return A.picoDb(c.saida);
  };
  const cheio = pico(1);
  const metade = pico(0.5);
  assert.ok(cheio > -30, `a 100% deveria ser audível (pico ${cheio} dB)`);
  assert.ok(metade < cheio - 3, `a 50% deveria ser bem mais baixo (${metade} dB contra ${cheio} dB)`);
});

test('mixagem: trilha muda é silêncio', (t) => {
  const dir = A.pastaTemporaria(t);
  const base = A.criarVideo(dir, 'base', { segundos: 2, silencioso: true });
  const trilha = A.criarAudio(dir, 'trilha', { segundos: 2 });
  const c = comporFinal(dir, { base: { arquivo: base }, audios: [{ arquivo: trilha, item: itemDe({ muted: true }) }], duration: 2 });
  assert.ok(c.r.ok, c.r.erro);
  assert.ok(A.picoDb(c.saida) < SILENCIO_DB, `trilha muda deveria ser silêncio (pico ${A.picoDb(c.saida)} dB)`);
});
