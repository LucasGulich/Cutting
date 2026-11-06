const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../lib/montagem');

const item = (extra = {}) => ({
  timelineStart: 0, sourceStart: 0, sourceEnd: 10, speed: 1, volume: 1, muted: false, ...extra
});

// --- tempo dos itens ---------------------------------------------------------

test('sourceSpan: quanto material do arquivo original o trecho consome', () => {
  assert.equal(M.sourceSpan(item({ sourceStart: 2, sourceEnd: 7 })), 5);
  assert.equal(M.sourceSpan(item({ sourceStart: 7, sourceEnd: 2 })), 0);
});

test('itemDuration: a velocidade encurta ou estica o tempo na montagem', () => {
  assert.equal(M.itemDuration(item({ speed: 1 })), 10);
  assert.equal(M.itemDuration(item({ speed: 2 })), 5);
  assert.equal(M.itemDuration(item({ speed: 0.5 })), 20);
});

test('itemDuration: velocidade inválida ou fora dos limites é corrigida', () => {
  assert.equal(M.itemDuration(item({ speed: 0 })), 10);
  assert.equal(M.itemDuration(item({ speed: 100 })), 1);
  assert.equal(M.itemDuration(item({ speed: undefined })), 10);
});

test('itemEnd: posição na linha do tempo mais a duração', () => {
  assert.equal(M.itemEnd(item({ timelineStart: 3, speed: 2 })), 8);
});

// --- transições e mensagens ---------------------------------------------------

test('normalizeTransition: aceita as conhecidas e cai em "fade" nas demais', () => {
  for (const t of M.TRANSITION_TYPES) assert.equal(M.normalizeTransition(t), t);
  assert.equal(M.normalizeTransition('inventada'), 'fade');
  assert.equal(M.normalizeTransition(undefined), 'fade');
});

test('TRANSITION_TYPES: sem repetidos', () => {
  assert.equal(new Set(M.TRANSITION_TYPES).size, M.TRANSITION_TYPES.length);
});

test('describeDrift: só avisa quando o início andou mais de 0,1s', () => {
  assert.equal(M.describeDrift(0), 'Concluído!');
  assert.equal(M.describeDrift(0.05), 'Concluído!');
  assert.equal(M.describeDrift(-0.1), 'Concluído!');
  assert.match(M.describeDrift(0.5), /\+0\.5s/);
  assert.match(M.describeDrift(-1.2), /-1\.2s/);
});

test('o áudio de saída é uniforme (é o que permite concatenar sem recodificar)', () => {
  assert.ok(M.AUDIO_ENCODE.includes(`-ar ${M.AUDIO_RATE}`));
  assert.ok(M.AUDIO_ENCODE.includes('-ac 2'));
});

// --- volume efetivo ---------------------------------------------------------

test('itemVolume: mudo é sempre 0, mesmo com volume alto', () => {
  assert.equal(M.itemVolume({ muted: true, volume: 3 }), 0);
});

test('itemVolume: sem valor é 100%', () => {
  assert.equal(M.itemVolume({}), 1);
  assert.equal(M.itemVolume({ volume: undefined }), 1);
  assert.equal(M.itemVolume({ volume: null }), 1);
  assert.equal(M.itemVolume({ volume: 'abc' }), 1);
});

test('itemVolume: 0% é silêncio, e não 100% (volume 0 sem estar mudo)', () => {
  assert.equal(M.itemVolume({ volume: 0 }), 0);
});

test('itemVolume: limita a 0–4 (400%)', () => {
  assert.equal(M.itemVolume({ volume: 9 }), 4);
  assert.equal(M.itemVolume({ volume: -3 }), 0);
  assert.equal(M.itemVolume({ volume: 0.5 }), 0.5);
});

// --- grafo da composição -----------------------------------------------------

const quadro = { width: 1280, height: 720, fps: 30 };
const audio = (extra, inputIndex = 1) => ({ item: item(extra), inputIndex });
const overlay = (extra = {}, hasAudio = false, inputIndex = 1) => ({
  item: item(extra),
  layout: { drawWidth: 640, drawHeight: 360, x: 10, y: 20 },
  effectiveSize: { width: 1280, height: 720 },
  hasAudio,
  inputIndex
});

test('buildCompositionGraph: sem camadas nem trilhas, usa o áudio e o vídeo da base como estão', () => {
  const r = M.buildCompositionGraph([], [], quadro, 10, null);
  assert.equal(r.graph, '');
  assert.equal(r.videoMap, '0:v');
  assert.equal(r.audioMap, '0:a');   // sem colchetes: é um stream de entrada, não um rótulo
});

test('buildCompositionGraph: uma trilha é deslocada, ajustada e mixada com o áudio da base', () => {
  const r = M.buildCompositionGraph([], [audio({ timelineStart: 2.5, volume: 0.5 })], quadro, 10, null);
  assert.match(r.graph, /\[1:a\]volume=0\.500,aresample=44100,adelay=2500\|2500,apad,atrim=0:10\.000\[ac0\]/);
  assert.match(r.graph, /\[0:a\]\[ac0\]amix=inputs=2:duration=longest:dropout_transition=0,volume=2\[amixed\]/);
  assert.equal(r.audioMap, '[amixed]');
  assert.equal(r.videoMap, '0:v');
});

test('buildCompositionGraph: o amix é compensado pelo número de entradas', () => {
  const r = M.buildCompositionGraph([], [audio({}, 1), audio({}, 2)], quadro, 10, null);
  assert.match(r.graph, /amix=inputs=3:duration=longest:dropout_transition=0,volume=3\[amixed\]/);
});

test('buildCompositionGraph: trilha muda entra com volume 0', () => {
  const r = M.buildCompositionGraph([], [audio({ muted: true })], quadro, 10, null);
  assert.match(r.graph, /volume=0\.000/);
});

test('buildCompositionGraph: trilha com volume 0% (sem estar muda) fica em silêncio', () => {
  const r = M.buildCompositionGraph([], [audio({ volume: 0 })], quadro, 10, null);
  assert.match(r.graph, /\[1:a\]volume=0\.000,/);
});

test('buildCompositionGraph: volume acima de 400% é limitado e ausente vale 100%', () => {
  assert.match(M.buildCompositionGraph([], [audio({ volume: 9 })], quadro, 10, null).graph, /volume=4\.000/);
  assert.match(M.buildCompositionGraph([], [audio({ volume: undefined })], quadro, 10, null).graph, /volume=1\.000/);
});

test('buildCompositionGraph: normalizar vem ANTES do volume, e trilha muda não normaliza', () => {
  const com = M.buildCompositionGraph([], [audio({ normalize: true, volume: 0.8 })], quadro, 10, null).graph;
  assert.ok(com.indexOf(M.LOUDNORM) >= 0);
  assert.ok(com.indexOf(M.LOUDNORM) < com.indexOf('volume=0.800'));

  const muda = M.buildCompositionGraph([], [audio({ normalize: true, muted: true })], quadro, 10, null).graph;
  assert.ok(!muda.includes(M.LOUDNORM));
});

test('buildCompositionGraph: velocidade entra com atempo ANTES do deslocamento', () => {
  const g = M.buildCompositionGraph([], [audio({ speed: 2, timelineStart: 1 })], quadro, 10, null).graph;
  assert.match(g, /volume=1\.000,atempo=2\.0000,aresample=44100,adelay=1000\|1000/);
});

test('buildCompositionGraph: sobreposição de vídeo é limitada à janela dela no tempo', () => {
  const r = M.buildCompositionGraph([overlay({ timelineStart: 4, sourceEnd: 3 })], [], quadro, 10, null);
  assert.match(r.graph, /setpts=PTS-STARTPTS\+4\.000\/TB/);
  assert.match(r.graph, /overlay=10:20:enable='between\(t,4\.000,7\.000\)':eof_action=pass:shortest=0\[vc0\]/);
  assert.equal(r.videoMap, '[vc0]');
});

test('buildCompositionGraph: sobreposição com velocidade divide o tempo no setpts', () => {
  const g = M.buildCompositionGraph([overlay({ speed: 2, timelineStart: 1 })], [], quadro, 10, null).graph;
  assert.match(g, /setpts=\(PTS-STARTPTS\)\/2\.0000\+1\.000\/TB/);
});

test('buildCompositionGraph: sobreposições empilham na ordem recebida', () => {
  const g = M.buildCompositionGraph([overlay({}, false, 1), overlay({}, false, 2)], [], quadro, 10, null);
  assert.match(g.graph, /\[0:v\]\[ov0\]overlay=.*\[vc0\]/);
  assert.match(g.graph, /\[vc0\]\[ov1\]overlay=.*\[vc1\]/);
  assert.equal(g.videoMap, '[vc1]');
});

test('buildCompositionGraph: o som do vídeo de uma sobreposição entra na mistura', () => {
  const r = M.buildCompositionGraph([overlay({ timelineStart: 3 }, true)], [], quadro, 10, null);
  assert.match(r.graph, /\[1:a\]volume=1\.000,aresample=44100,adelay=3000\|3000,apad,atrim=0:10\.000\[ovaud0\]/);
  assert.match(r.graph, /\[0:a\]\[ovaud0\]amix=inputs=2/);
});

test('buildCompositionGraph: sobreposição sem áudio, ou muda, não entra na mistura', () => {
  assert.ok(!M.buildCompositionGraph([overlay({}, false)], [], quadro, 10, null).graph.includes('ovaud'));
  assert.ok(!M.buildCompositionGraph([overlay({ muted: true }, true)], [], quadro, 10, null).graph.includes('ovaud'));
  assert.ok(!M.buildCompositionGraph([overlay({ volume: 0 }, true)], [], quadro, 10, null).graph.includes('ovaud'));
});

test('buildCompositionGraph: ajustes da sobreposição (opacidade, giro) viram filtros antes da escala', () => {
  const g = M.buildCompositionGraph([overlay({ opacity: 0.5, rotate: 90 })], [], quadro, 10, null).graph;
  assert.match(g, /\[1:v\]transpose=1,format=yuva420p,colorchannelmixer=aa=0\.500\[oadj0\]/);
  assert.match(g, /\[oadj0\]scale=640:360/);
});

test('buildCompositionGraph: texto vai por cima de tudo, até das sobreposições', () => {
  const r = M.buildCompositionGraph([overlay()], [], quadro, 10, "drawtext=text='oi'");
  assert.match(r.graph, /\[vc0\]drawtext=text='oi'\[vtext\]/);
  assert.equal(r.videoMap, '[vtext]');
});

test('buildCompositionGraph: texto sozinho parte da entrada crua do vídeo', () => {
  const r = M.buildCompositionGraph([], [], quadro, 10, "drawtext=text='oi'");
  assert.match(r.graph, /^\[0:v\]drawtext/);
  assert.equal(r.videoMap, '[vtext]');
});
