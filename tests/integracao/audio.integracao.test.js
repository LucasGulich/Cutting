// Os argumentos de lib/audio.js produzem o arquivo certo no FFmpeg de verdade?

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const A = require('./_ajudas');
const Audio = require('../../lib/audio');

const CODEC_ESPERADO = { mp3: 'mp3', m4a: 'aac', wav: 'pcm_s16le', flac: 'flac' };

for (const ext of Object.keys(CODEC_ESPERADO)) {
  test(`converter para só áudio: ${ext} sai sem vídeo, com o codec certo e a duração inteira`, (t) => {
    const dir = A.pastaTemporaria(t);
    const video = A.criarVideo(dir, 'v', { segundos: 3 });
    const saida = path.join(dir, `saida.${ext}`);
    const { args } = Audio.buildExtractAudioArgs({ sourcePath: video, outPath: saida, ext, codec: 'aac' });

    const r = A.ffmpeg(args);
    assert.ok(r.ok, r.erro);
    const info = A.probe(saida);
    assert.equal(info.temVideo, false, 'o arquivo de áudio não pode ter vídeo');
    assert.equal(info.temAudio, true);
    assert.equal(info.codecAudio, CODEC_ESPERADO[ext]);
    assert.ok(Math.abs(info.duracao - 3) < 0.2, `duração ${info.duracao}`);
  });
}

test('converter: recorte de 1s a 2s dura ~1s', (t) => {
  const dir = A.pastaTemporaria(t);
  const video = A.criarVideo(dir, 'v', { segundos: 4 });
  const saida = path.join(dir, 'saida.mp3');
  const { args } = Audio.buildExtractAudioArgs({ sourcePath: video, outPath: saida, ext: 'mp3', codec: 'aac', start: 1, end: 2 });
  assert.ok(A.ffmpeg(args).ok);
  assert.ok(Math.abs(A.probe(saida).duracao - 1) < 0.15, `duração ${A.probe(saida).duracao}`);
});

test('converter: M4A de fonte AAC copia o fluxo (continua AAC, instantâneo)', (t) => {
  const dir = A.pastaTemporaria(t);
  const video = A.criarVideo(dir, 'v', { segundos: 3, codecAudio: 'aac' });
  const saida = path.join(dir, 's.m4a');
  const r = Audio.buildExtractAudioArgs({ sourcePath: video, outPath: saida, ext: 'm4a', codec: 'aac' });
  assert.equal(r.copyStream, true);
  assert.ok(A.ffmpeg(r.args).ok);
  assert.equal(A.probe(saida).codecAudio, 'aac');
});

test('converter: M4A de fonte que não é AAC recodifica para AAC', (t) => {
  const dir = A.pastaTemporaria(t);
  const video = A.criarVideo(dir, 'v', { segundos: 2, codecAudio: 'libmp3lame', ext: 'mkv' });
  assert.equal(A.probe(video).codecAudio, 'mp3');
  const saida = path.join(dir, 's.m4a');
  const r = Audio.buildExtractAudioArgs({ sourcePath: video, outPath: saida, ext: 'm4a', codec: 'mp3' });
  assert.equal(r.copyStream, false);
  assert.ok(A.ffmpeg(r.args).ok);
  assert.equal(A.probe(saida).codecAudio, 'aac');
});

test('converter: fonte só de áudio (um .wav) também converte', (t) => {
  const dir = A.pastaTemporaria(t);
  const wav = A.criarAudio(dir, 'a', { segundos: 2 });
  const saida = path.join(dir, 's.flac');
  const { args } = Audio.buildExtractAudioArgs({ sourcePath: wav, outPath: saida, ext: 'flac', codec: 'pcm_s16le' });
  assert.ok(A.ffmpeg(args).ok);
  assert.equal(A.probe(saida).codecAudio, 'flac');
});

test('separar: vídeo com AAC vira .m4a sem vídeo, com o mesmo tempo', (t) => {
  const dir = A.pastaTemporaria(t);
  const video = A.criarVideo(dir, 'v', { segundos: 3 });
  const saida = path.join(dir, 'v (áudio).m4a');
  assert.ok(A.ffmpeg(Audio.buildSeparateAudioArgs({ sourcePath: video, outPath: saida, codec: 'aac' })).ok);
  const info = A.probe(saida);
  assert.equal(info.temVideo, false);
  assert.equal(info.codecAudio, 'aac');
  assert.ok(Math.abs(info.duracao - 3) < 0.2);
});

test('separar: vídeo com outro codec vira AAC no .m4a', (t) => {
  const dir = A.pastaTemporaria(t);
  const video = A.criarVideo(dir, 'v', { segundos: 2, codecAudio: 'libmp3lame', ext: 'mkv' });
  const saida = path.join(dir, 'v (áudio).m4a');
  assert.ok(A.ffmpeg(Audio.buildSeparateAudioArgs({ sourcePath: video, outPath: saida, codec: 'mp3' })).ok);
  assert.equal(A.probe(saida).codecAudio, 'aac');
});

test('exportar a montagem como áudio: tirar o som do arquivo composto, em cada formato', (t) => {
  const dir = A.pastaTemporaria(t);
  const composto = A.criarVideo(dir, 'mix', { segundos: 2 });
  for (const ext of Object.keys(CODEC_ESPERADO)) {
    const saida = path.join(dir, `m.${ext}`);
    assert.ok(A.ffmpeg(Audio.buildMixToAudioArgs({ mixedPath: composto, outPath: saida, ext })).ok, ext);
    const info = A.probe(saida);
    assert.equal(info.temVideo, false, ext);
    assert.equal(info.codecAudio, CODEC_ESPERADO[ext], ext);
  }
});

test('o caminho com acentos e espaços funciona (nome do vídeo + "(áudio)")', (t) => {
  const dir = A.pastaTemporaria(t);
  const video = A.criarVideo(dir, 'Reunião da Conceição', { segundos: 2 });
  const saida = path.join(dir, 'Reunião da Conceição (áudio).m4a');
  assert.ok(A.ffmpeg(Audio.buildSeparateAudioArgs({ sourcePath: video, outPath: saida, codec: 'aac' })).ok);
  assert.ok(A.probe(saida).temAudio);
});
