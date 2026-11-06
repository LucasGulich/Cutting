// Argumentos do FFmpeg para trabalhar só com o áudio: converter, separar do
// vídeo e exportar a montagem como áudio.
// Sem Electron e sem executar nada: só decide COMO o ffmpeg será chamado, para
// poder ser testado com `node --test`. Ver docs/TESTES.md.

const AUDIO_EXPORT_FORMATS = {
  mp3: { label: 'MP3', args: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
  m4a: { label: 'M4A (AAC)', args: ['-c:a', 'aac', '-b:a', '192k'] },
  wav: { label: 'WAV (sem compressão)', args: ['-c:a', 'pcm_s16le'] },
  flac: { label: 'FLAC (sem perda)', args: ['-c:a', 'flac'] }
};

// Formato mínimo do quadro quando a imagem vai ser jogada fora (exportar a
// montagem como áudio): só serve para a composição rodar barato.
const AUDIO_ONLY_FRAME = { width: 160, height: 90, fit: 'contain' };

// Formato desconhecido cai em MP3, o mais compatível
const audioFormatOrDefault = (ext) => (AUDIO_EXPORT_FORMATS[ext] ? ext : 'mp3');

// Converter uma mídia (ou um trecho dela) para um arquivo só de áudio.
// start/end em segundos DA FONTE; sem eles converte tudo.
// Copiar o fluxo (sem recodificar) só vale com M4A, fonte já em AAC e sem recorte:
// com recorte, o corte cairia no pacote mais próximo e não no ponto pedido.
function buildExtractAudioArgs({ sourcePath, outPath, ext, codec, start, end }) {
  const trimmed = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const copyStream = ext === 'm4a' && codec === 'aac' && !trimmed;
  const codecArgs = copyStream ? ['-c:a', 'copy'] : AUDIO_EXPORT_FORMATS[ext].args;

  return {
    copyStream,
    args: [
      ...(trimmed ? ['-ss', String(start)] : []),
      '-i', sourcePath,
      ...(trimmed ? ['-t', String(end - start)] : []),
      '-vn', '-map', '0:a:0',
      ...codecArgs,
      outPath
    ]
  };
}

// Separar o áudio de um vídeo para um .m4a: AAC copia, o resto vira AAC 256k.
function buildSeparateAudioArgs({ sourcePath, outPath, codec }) {
  const codecArgs = codec === 'aac' ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k'];
  return ['-i', sourcePath, '-vn', '-map', '0:a:0', ...codecArgs, outPath];
}

// Tirar o áudio da montagem já composta. A mixagem sai em AAC, então no M4A
// basta copiar — recodificar seria uma segunda perda sem ganho nenhum.
function buildMixToAudioArgs({ mixedPath, outPath, ext }) {
  const codecArgs = ext === 'm4a' ? ['-c:a', 'copy'] : AUDIO_EXPORT_FORMATS[ext].args;
  return ['-i', mixedPath, '-vn', '-map', '0:a:0', ...codecArgs, outPath];
}

module.exports = {
  AUDIO_EXPORT_FORMATS, AUDIO_ONLY_FRAME, audioFormatOrDefault,
  buildExtractAudioArgs, buildSeparateAudioArgs, buildMixToAudioArgs
};
