const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../lib/audio');

test('formatos de áudio: os quatro prometidos, cada um com rótulo e codec', () => {
  assert.deepEqual(Object.keys(A.AUDIO_EXPORT_FORMATS), ['mp3', 'm4a', 'wav', 'flac']);
  for (const f of Object.values(A.AUDIO_EXPORT_FORMATS)) {
    assert.ok(f.label);
    assert.ok(f.args.includes('-c:a'));
  }
});

test('audioFormatOrDefault: formato desconhecido cai em mp3', () => {
  assert.equal(A.audioFormatOrDefault('flac'), 'flac');
  assert.equal(A.audioFormatOrDefault('ogg'), 'mp3');
  assert.equal(A.audioFormatOrDefault(undefined), 'mp3');
});

test('AUDIO_ONLY_FRAME: quadro mínimo e de dimensões pares', () => {
  assert.ok(A.AUDIO_ONLY_FRAME.width % 2 === 0 && A.AUDIO_ONLY_FRAME.height % 2 === 0);
  assert.ok(A.AUDIO_ONLY_FRAME.width <= 320);
});

// --- converter para só áudio ---------------------------------------------------

const base = { sourcePath: 'C:\\v\\video.mp4', outPath: 'C:\\o\\saida' };

test('buildExtractAudioArgs: sempre descarta o vídeo e pega a primeira faixa de áudio', () => {
  for (const ext of Object.keys(A.AUDIO_EXPORT_FORMATS)) {
    const { args } = A.buildExtractAudioArgs({ ...base, ext, codec: 'aac' });
    assert.ok(args.includes('-vn'), ext);
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-map') + 2), ['-map', '0:a:0'], ext);
    assert.equal(args[args.length - 1], base.outPath);
  }
});

test('buildExtractAudioArgs: cada formato usa o seu codec', () => {
  const codecDe = (ext) => {
    const { args } = A.buildExtractAudioArgs({ ...base, ext, codec: 'mp3' });
    return args[args.indexOf('-c:a') + 1];
  };
  assert.equal(codecDe('mp3'), 'libmp3lame');
  assert.equal(codecDe('m4a'), 'aac');
  assert.equal(codecDe('wav'), 'pcm_s16le');
  assert.equal(codecDe('flac'), 'flac');
});

test('buildExtractAudioArgs: M4A de fonte AAC, sem recorte, só copia o fluxo', () => {
  const r = A.buildExtractAudioArgs({ ...base, ext: 'm4a', codec: 'aac' });
  assert.equal(r.copyStream, true);
  assert.deepEqual(r.args.slice(r.args.indexOf('-c:a'), r.args.indexOf('-c:a') + 2), ['-c:a', 'copy']);
});

test('buildExtractAudioArgs: com recorte, nunca copia (o corte cairia no pacote mais próximo)', () => {
  const r = A.buildExtractAudioArgs({ ...base, ext: 'm4a', codec: 'aac', start: 1, end: 3 });
  assert.equal(r.copyStream, false);
  assert.equal(r.args[r.args.indexOf('-c:a') + 1], 'aac');
});

test('buildExtractAudioArgs: copiar só vale para M4A saindo de AAC', () => {
  assert.equal(A.buildExtractAudioArgs({ ...base, ext: 'm4a', codec: 'mp3' }).copyStream, false);
  assert.equal(A.buildExtractAudioArgs({ ...base, ext: 'mp3', codec: 'aac' }).copyStream, false);
  assert.equal(A.buildExtractAudioArgs({ ...base, ext: 'wav', codec: 'aac' }).copyStream, false);
});

test('buildExtractAudioArgs: recorte usa -ss antes da entrada e -t (duração) depois', () => {
  const { args } = A.buildExtractAudioArgs({ ...base, ext: 'mp3', codec: 'aac', start: 2, end: 5.5 });
  const i = args.indexOf('-i');
  assert.deepEqual(args.slice(0, 2), ['-ss', '2']);
  assert.ok(args.indexOf('-ss') < i);
  assert.equal(args[args.indexOf('-t') + 1], '3.5');
  assert.ok(args.indexOf('-t') > i);
});

test('buildExtractAudioArgs: recorte inválido (fim <= início, NaN) é ignorado', () => {
  for (const [start, end] of [[5, 5], [5, 2], [NaN, 3], [1, NaN], [undefined, undefined]]) {
    const { args } = A.buildExtractAudioArgs({ ...base, ext: 'mp3', codec: 'aac', start, end });
    assert.ok(!args.includes('-ss') && !args.includes('-t'), `start=${start} end=${end}`);
  }
});

// --- separar áudio do vídeo -------------------------------------------------

test('buildSeparateAudioArgs: AAC é copiado sem perda', () => {
  const args = A.buildSeparateAudioArgs({ ...base, codec: 'aac' });
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'copy']);
  assert.ok(args.includes('-vn'));
  assert.equal(args[args.length - 1], base.outPath);
});

test('buildSeparateAudioArgs: outros codecs viram AAC 256k (cabem no .m4a)', () => {
  for (const codec of ['mp3', 'opus', 'vorbis', 'pcm_s16le']) {
    const args = A.buildSeparateAudioArgs({ ...base, codec });
    assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 4), ['-c:a', 'aac', '-b:a', '256k'], codec);
  }
});

// --- montagem como áudio ---------------------------------------------------

test('buildMixToAudioArgs: a mixagem já é AAC, então M4A só copia', () => {
  const args = A.buildMixToAudioArgs({ mixedPath: 'mix.mp4', outPath: 'o.m4a', ext: 'm4a' });
  assert.deepEqual(args.slice(args.indexOf('-c:a'), args.indexOf('-c:a') + 2), ['-c:a', 'copy']);
});

test('buildMixToAudioArgs: os demais formatos recodificam com o codec certo', () => {
  const codecDe = (ext) => {
    const args = A.buildMixToAudioArgs({ mixedPath: 'mix.mp4', outPath: `o.${ext}`, ext });
    return args[args.indexOf('-c:a') + 1];
  };
  assert.equal(codecDe('mp3'), 'libmp3lame');
  assert.equal(codecDe('wav'), 'pcm_s16le');
  assert.equal(codecDe('flac'), 'flac');
});

test('buildMixToAudioArgs: lê o arquivo composto e descarta o vídeo', () => {
  const args = A.buildMixToAudioArgs({ mixedPath: 'mix.mp4', outPath: 'o.mp3', ext: 'mp3' });
  assert.equal(args[args.indexOf('-i') + 1], 'mix.mp4');
  assert.ok(args.includes('-vn'));
  assert.equal(args[args.length - 1], 'o.mp3');
});
