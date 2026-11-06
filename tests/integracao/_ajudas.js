// Ajudas dos testes de integração: ffmpeg/ffprobe embutidos, mídias sintéticas
// pequenas e leitura do que saiu. Nada aqui é teste (o prefixo _ o tira da busca).

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

// Pasta própria e descartável por teste: nada vaza entre eles nem para o projeto.
function pastaTemporaria(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutting-int-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ffmpeg(args) {
  const r = spawnSync(ffmpegPath, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, erro: (r.stderr || '').trim(), saida: r.stdout || '' };
}

// Roda e exige sucesso: usado para montar as entradas do teste
function gerar(args) {
  const r = ffmpeg(args);
  if (!r.ok) throw new Error(`ffmpeg falhou ao preparar a entrada: ${r.erro}`);
}

function probe(arquivo) {
  const r = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', arquivo], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffprobe falhou em ${arquivo}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    duracao: Number(j.format.duration),
    temVideo: !!v,
    temAudio: !!a,
    codecAudio: a ? a.codec_name : null,
    largura: v ? v.width : 0,
    altura: v ? v.height : 0,
    streams: j.streams.length
  };
}

// Volume de pico do áudio, em dB (-Infinity = silêncio total)
function picoDb(arquivo) {
  const r = spawnSync(ffmpegPath, ['-v', 'info', '-i', arquivo, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = (r.stderr || '').match(/max_volume:\s*(-?[\d.]+|-inf) dB/);
  if (!m) return null;
  return m[1] === '-inf' ? -Infinity : parseFloat(m[1]);
}

// Vídeo de teste: 320x180, com tom de áudio (ou silêncio)
function criarVideo(dir, nome, { segundos = 2, comAudio = true, silencioso = false, codecAudio = 'aac', ext = 'mp4' } = {}) {
  const arquivo = path.join(dir, `${nome}.${ext}`);
  const entradaAudio = silencioso
    ? ['-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo:d=${segundos}`]
    : ['-f', 'lavfi', '-i', `sine=f=880:d=${segundos}`];
  gerar([
    '-f', 'lavfi', '-i', `testsrc=d=${segundos}:s=320x180:r=10`,
    ...(comAudio ? entradaAudio : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    ...(comAudio ? ['-c:a', codecAudio] : ['-an']),
    '-shortest', arquivo
  ]);
  return arquivo;
}

function criarAudio(dir, nome, { segundos = 2, freq = 440, ext = 'wav' } = {}) {
  const arquivo = path.join(dir, `${nome}.${ext}`);
  gerar(['-f', 'lavfi', '-i', `sine=f=${freq}:d=${segundos}`, arquivo]);
  return arquivo;
}

module.exports = { ffmpegPath, ffprobePath, pastaTemporaria, ffmpeg, gerar, probe, picoDb, criarVideo, criarAudio };
