const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../../lib/linhadotempo');

// --- texto e tempo ---------------------------------------------------------

test('formatTime: HH:MM:SS.mmm, com e sem milissegundos', () => {
  assert.equal(T.formatTime(0), '00:00:00.000');
  assert.equal(T.formatTime(61.5), '00:01:01.500');
  assert.equal(T.formatTime(3661.005), '01:01:01.005');
  assert.equal(T.formatTime(61.5, false), '00:01:01');
});

test('formatTime: arredonda para o milissegundo mais próximo (sem truncar)', () => {
  assert.equal(T.formatTime(0.9996), '00:00:01.000');
  assert.equal(T.formatTime(1.2344), '00:00:01.234');
});

test('formatTime: valores inválidos viram zero e negativos levam o sinal', () => {
  assert.equal(T.formatTime(NaN), '00:00:00.000');
  assert.equal(T.formatTime(null), '00:00:00.000');
  assert.equal(T.formatTime(undefined, false), '00:00:00');
  assert.equal(T.formatTime(-2.5), '-00:00:02.500');
});

test('parseTimeToSeconds: aceita HH:MM:SS, MM:SS, SS e vírgula decimal', () => {
  assert.equal(T.parseTimeToSeconds('1:02:03.5'), 3723.5);
  assert.equal(T.parseTimeToSeconds('02:03'), 123);
  assert.equal(T.parseTimeToSeconds('12.5'), 12.5);
  assert.equal(T.parseTimeToSeconds('1,5'), 1.5);
  assert.equal(T.parseTimeToSeconds(' 7 '), 7);
});

test('parseTimeToSeconds: vazio e lixo viram zero', () => {
  assert.equal(T.parseTimeToSeconds(''), 0);
  assert.equal(T.parseTimeToSeconds(null), 0);
  assert.equal(T.parseTimeToSeconds(undefined), 0);
  assert.equal(T.parseTimeToSeconds('abc'), 0);
});

test('formatTime e parseTimeToSeconds: ida e volta', () => {
  for (const s of [0, 1.234, 59.999, 61, 3599.5, 7322.25]) {
    assert.ok(Math.abs(T.parseTimeToSeconds(T.formatTime(s)) - s) < 0.001, String(s));
  }
});

test('getFileName e stripExtension', () => {
  assert.equal(T.getFileName('C:\\pasta\\sub\\video.mp4'), 'video.mp4');
  assert.equal(T.getFileName('/home/u/video.mp4'), 'video.mp4');
  assert.equal(T.getFileName('video.mp4'), 'video.mp4');
  assert.equal(T.stripExtension('a.b.mp4'), 'a.b');
  assert.equal(T.stripExtension('semextensao'), 'semextensao');
});

// --- duração dos trechos ---------------------------------------------------

const clip = (extra = {}) => ({ id: 1, trackId: 1, sourceId: 1, timelineStart: 0, start: 0, end: 10, ...extra });

test('clipSpeed: limitada a 0,1–10 e 1 quando ausente ou inválida', () => {
  assert.equal(T.clipSpeed(clip()), 1);
  assert.equal(T.clipSpeed(clip({ speed: 50 })), 10);
  assert.equal(T.clipSpeed(clip({ speed: 0.001 })), 0.1);
  assert.equal(T.clipSpeed(null), 1);
});

test('clipDuration e clipEnd: a velocidade muda o tempo na linha do tempo', () => {
  assert.equal(T.clipDuration(clip({ start: 2, end: 12 })), 10);
  assert.equal(T.clipDuration(clip({ speed: 2 })), 5);
  assert.equal(T.clipEnd(clip({ timelineStart: 4, speed: 2 })), 9);
  assert.equal(T.clipDuration(clip({ start: 5, end: 1 })), 0);
});

test('sequenceDuration: termina onde acaba o item que vai mais longe', () => {
  assert.equal(T.sequenceDuration([]), 0);
  assert.equal(T.sequenceDuration([clip(), clip({ timelineStart: 20, end: 5 })]), 25);
  assert.equal(T.sequenceDuration([clip({ timelineStart: 100 }), clip()]), 110);
});

// --- ajustes que obrigam a recodificar ----------------------------------

test('hasAudioTweaks: volume, mudo e normalização', () => {
  assert.equal(T.hasAudioTweaks(clip()), false);
  assert.equal(T.hasAudioTweaks(clip({ volume: 1 })), false);
  assert.ok(T.hasAudioTweaks(clip({ muted: true })));
  assert.ok(T.hasAudioTweaks(clip({ volume: 0.5 })));
  assert.ok(T.hasAudioTweaks(clip({ volume: 0 })));
  assert.ok(T.hasAudioTweaks(clip({ normalize: true })));
  assert.equal(T.hasAudioTweaks(null), false);
});

test('hasAdjustments: velocidade, imagem e cor', () => {
  assert.equal(T.hasAdjustments(clip()), false);
  assert.ok(T.hasAdjustments(clip({ speed: 2 })));
  assert.ok(T.hasAdjustments(clip({ opacity: 0.9 })));
  assert.equal(T.hasAdjustments(clip({ opacity: 1 })), false);
  assert.ok(T.hasAdjustments(clip({ rotate: 90 })));
  assert.ok(T.hasAdjustments(clip({ flipH: true })));
  assert.ok(T.hasAdjustments(clip({ chroma: { color: '#00ff00' } })));
  assert.ok(T.hasAdjustments(clip({ blurRegion: { x: 0, y: 0, w: 1, h: 1 } })));
  assert.ok(T.hasAdjustments(clip({ color: { brightness: 0.1, contrast: 1, saturation: 1 } })));
  assert.equal(T.hasAdjustments(clip({ color: T.defaultColor() })), false);
  assert.equal(T.hasAdjustments(null), false);
});

// --- montagem "simples" (cabe no corte sem perda) ------------------------

const tracks = () => [
  { id: 1, kind: 'video', name: 'V1', muted: false },
  { id: 2, kind: 'audio', name: 'A1', muted: false }
];

test('isSimpleTimeline: trechos colados de uma faixa só são simples', () => {
  const clips = [clip({ id: 1 }), clip({ id: 2, timelineStart: 10 })];
  assert.equal(T.isSimpleTimeline({ tracks: tracks(), clips, texts: [] }), true);
});

test('isSimpleTimeline: sem faixa de vídeo, nunca', () => {
  assert.equal(T.isSimpleTimeline({ tracks: [], clips: [], texts: [] }), false);
  assert.equal(T.isSimpleTimeline({ tracks: [{ id: 2, kind: 'audio' }], clips: [], texts: [] }), false);
});

test('isSimpleTimeline: vazio entre trechos deixa de ser simples', () => {
  const clips = [clip({ id: 1 }), clip({ id: 2, timelineStart: 12 })];
  assert.equal(T.isSimpleTimeline({ tracks: tracks(), clips, texts: [] }), false);
});

test('isSimpleTimeline: o primeiro trecho precisa começar em zero', () => {
  assert.equal(T.isSimpleTimeline({ tracks: tracks(), clips: [clip({ timelineStart: 1 })], texts: [] }), false);
});

test('isSimpleTimeline: item em outra faixa (trilha de áudio, sobreposição) deixa de ser simples', () => {
  const clips = [clip({ id: 1 }), clip({ id: 2, trackId: 2 })];
  assert.equal(T.isSimpleTimeline({ tracks: tracks(), clips, texts: [] }), false);
});

test('isSimpleTimeline: trecho mudo (inclusive o vídeo de um áudio separado) obriga a recodificar', () => {
  assert.equal(T.isSimpleTimeline({ tracks: tracks(), clips: [clip({ muted: true })], texts: [] }), false);
});

test('isSimpleTimeline: ajuste de imagem, volume, solo e texto obrigam a recodificar', () => {
  const t = tracks();
  assert.equal(T.isSimpleTimeline({ tracks: t, clips: [clip({ speed: 2 })], texts: [] }), false);
  assert.equal(T.isSimpleTimeline({ tracks: t, clips: [clip({ volume: 0.5 })], texts: [] }), false);
  assert.equal(T.isSimpleTimeline({ tracks: [{ ...t[0], solo: true }, t[1]], clips: [clip()], texts: [] }), false);
  assert.equal(T.isSimpleTimeline({ tracks: t, clips: [clip()], texts: [{ content: 'Título' }] }), false);
});

test('isSimpleTimeline: texto vazio ou só espaços não conta', () => {
  assert.equal(T.isSimpleTimeline({ tracks: tracks(), clips: [clip()], texts: [{ content: '   ' }, {}] }), true);
});

test('isSimpleTimeline: a ordem do array não importa, só a posição no tempo', () => {
  const clips = [clip({ id: 2, timelineStart: 10 }), clip({ id: 1 })];
  assert.equal(T.isSimpleTimeline({ tracks: tracks(), clips, texts: [] }), true);
});

// --- separar áudio do vídeo -------------------------------------------------

test('findFreeAudioTrack: devolve a primeira faixa de áudio sem nada no intervalo', () => {
  const t = [...tracks(), { id: 3, kind: 'audio' }];
  assert.equal(T.findFreeAudioTrack(t, [], 0, 5).id, 2);
});

test('findFreeAudioTrack: pula a faixa ocupada e usa a próxima', () => {
  const t = [...tracks(), { id: 3, kind: 'audio' }];
  const clips = [clip({ id: 9, trackId: 2, timelineStart: 0, end: 10 })];
  assert.equal(T.findFreeAudioTrack(t, clips, 2, 6).id, 3);
});

test('findFreeAudioTrack: encostar na ponta não é sobrepor', () => {
  const clips = [clip({ id: 9, trackId: 2, timelineStart: 0, end: 5 })];
  assert.equal(T.findFreeAudioTrack(tracks(), clips, 5, 9).id, 2);
  const depois = [clip({ id: 9, trackId: 2, timelineStart: 9, end: 20 })];
  assert.equal(T.findFreeAudioTrack(tracks(), depois, 5, 9).id, 2);
});

test('findFreeAudioTrack: tudo ocupado devolve null (quem chama cria a faixa)', () => {
  const clips = [clip({ id: 9, trackId: 2, timelineStart: 0, end: 10 })];
  assert.equal(T.findFreeAudioTrack(tracks(), clips, 1, 4), null);
});

test('findFreeAudioTrack: ignora faixas de vídeo e itens de outras faixas', () => {
  const clips = [clip({ id: 9, trackId: 1, timelineStart: 0, end: 100 })];
  assert.equal(T.findFreeAudioTrack(tracks(), clips, 0, 50).id, 2);
});

test('buildSeparatedAudioClip: mesma posição e trecho do vídeo, na faixa de áudio', () => {
  const video = clip({ id: 5, timelineStart: 12, start: 3, end: 9, volume: 0.7 });
  const a = T.buildSeparatedAudioClip(video, { id: 40, duration: 100 }, { id: 6, trackId: 2, framing: { zoom: 1 } });
  assert.deepEqual(
    { id: a.id, trackId: a.trackId, sourceId: a.sourceId, timelineStart: a.timelineStart, start: a.start, end: a.end, volume: a.volume },
    { id: 6, trackId: 2, sourceId: 40, timelineStart: 12, start: 3, end: 9, volume: 0.7 }
  );
});

test('buildSeparatedAudioClip: velocidade e normalização só vão se existirem', () => {
  const sem = T.buildSeparatedAudioClip(clip(), { id: 1, duration: 10 }, { id: 2, trackId: 2 });
  assert.ok(!('speed' in sem) && !('normalize' in sem));
  const com = T.buildSeparatedAudioClip(clip({ speed: 1.5, normalize: true }), { id: 1, duration: 10 }, { id: 2, trackId: 2 });
  assert.equal(com.speed, 1.5);
  assert.equal(com.normalize, true);
});

test('buildSeparatedAudioClip: o fim nunca passa da duração do áudio extraído', () => {
  const a = T.buildSeparatedAudioClip(clip({ end: 30 }), { id: 1, duration: 28.5 }, { id: 2, trackId: 2 });
  assert.equal(a.end, 28.5);
  const semDuracao = T.buildSeparatedAudioClip(clip({ end: 30 }), { id: 1, duration: 0 }, { id: 2, trackId: 2 });
  assert.equal(semDuracao.end, 30);
});

test('buildSeparatedAudioClip: volume padrão 100% e o mudo é herdado', () => {
  const a = T.buildSeparatedAudioClip(clip({ muted: true }), { id: 1, duration: 10 }, { id: 2, trackId: 2 });
  assert.equal(a.volume, 1);
  assert.equal(a.muted, true);
  assert.equal(T.buildSeparatedAudioClip(clip({ volume: 0 }), { id: 1, duration: 10 }, { id: 2, trackId: 2 }).volume, 0);
});

// --- salvar a montagem: vídeo ou só áudio -------------------------------

const fontes = [
  { id: 1, kind: 'video' }, { id: 2, kind: 'image' }, { id: 3, kind: 'audio' }
];

test('hasVisualClips: vídeo e foto contam; só áudio não', () => {
  assert.equal(T.hasVisualClips([clip({ sourceId: 1 })], fontes), true);
  assert.equal(T.hasVisualClips([clip({ sourceId: 2 })], fontes), true);
  assert.equal(T.hasVisualClips([clip({ sourceId: 3 })], fontes), false);
  assert.equal(T.hasVisualClips([], fontes), false);
  assert.equal(T.hasVisualClips([clip({ sourceId: 99 })], fontes), false);
});

test('resolveJoinMode: só áudio força "Somente áudio" e desabilita as opções de vídeo', () => {
  const r = T.resolveJoinMode({ visual: false, current: 'merged', forced: false });
  assert.equal(r.value, 'audio');
  assert.equal(r.forced, true);
  assert.equal(r.videoOptionsDisabled, true);
  assert.equal(r.showAudioOptions, true);
  assert.equal(r.buttonLabel, 'Salvar Áudio');
  assert.match(r.hint, /só tem áudio/);
});

test('resolveJoinMode: com imagem, tudo habilitado e nada é imposto', () => {
  const r = T.resolveJoinMode({ visual: true, current: 'merged', forced: false });
  assert.equal(r.value, 'merged');
  assert.equal(r.videoOptionsDisabled, false);
  assert.equal(r.showAudioOptions, false);
  assert.equal(r.buttonLabel, 'Cortar e Salvar');
  assert.equal(r.hint, '');
});

test('resolveJoinMode: o áudio imposto pelo app é desfeito quando a montagem ganha imagem', () => {
  const r = T.resolveJoinMode({ visual: true, current: 'audio', forced: true });
  assert.equal(r.value, 'merged');
  assert.equal(r.forced, false);
});

test('resolveJoinMode: o áudio escolhido pela pessoa é respeitado, com aviso de que a imagem sai', () => {
  const r = T.resolveJoinMode({ visual: true, current: 'audio', forced: false });
  assert.equal(r.value, 'audio');
  assert.equal(r.showAudioOptions, true);
  assert.match(r.hint, /não vai para o arquivo/);
});

test('resolveJoinMode: já em áudio e só áudio não muda nada', () => {
  const r = T.resolveJoinMode({ visual: false, current: 'audio', forced: true });
  assert.equal(r.value, 'audio');
  assert.equal(r.forced, true);
});

test('describeAudioOnlyLoss: lista só o que existe e sempre avisa que a montagem fica intacta', () => {
  const tudo = T.describeAudioOnlyLoss({ videos: 3, photos: 2, texts: 1 });
  assert.equal(tudo.length, 4);
  assert.match(tudo[0], /3 trecho\(s\) de vídeo/);
  assert.match(tudo[1], /2 foto\(s\)/);
  assert.match(tudo[2], /1 título/);
  assert.match(tudo[3], /não é alterada/);

  const soVideo = T.describeAudioOnlyLoss({ videos: 1, photos: 0, texts: 0 });
  assert.equal(soVideo.length, 2);
});
