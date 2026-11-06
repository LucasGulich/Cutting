// Regras da linha do tempo que não dependem da tela: tempo, formatação e
// decisões sobre a montagem. Extraído do renderer.js.
//
// Carrega nos dois mundos: no app, pela tag <script> (vira window.CuttingTempo);
// nos testes, por require(). Sem DOM, sem estado global, sem Electron — tudo o
// que precisa vem por parâmetro. Ver docs/TESTES.md.

(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.CuttingTempo = fabrica();
}(typeof self !== 'undefined' ? self : this, function () {

  // --- Texto e tempo ------------------------------------------------------

  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  function getFileName(filePath) {
    return String(filePath).split(/[\\/]/).pop();
  }

  function stripExtension(fileName) {
    return fileName.replace(/\.[^.]+$/, '');
  }

  const pad2 = (n) => String(n).padStart(2, '0');

  // Formata segundos como HH:MM:SS.mmm (ou HH:MM:SS se withMs=false).
  // A precisão de milissegundos importa: cortes de vídeo raramente caem em
  // segundos inteiros, e truncar aqui jogava fora a precisão que o corte suporta.
  function formatTime(seconds, withMs = true) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) {
      return withMs ? '00:00:00.000' : '00:00:00';
    }
    const sign = seconds < 0 ? '-' : '';
    const totalMs = Math.round(Math.abs(seconds) * 1000);
    const ms = totalMs % 1000;
    const totalSec = Math.floor(totalMs / 1000);
    const base = `${pad2(Math.floor(totalSec / 3600))}:${pad2(Math.floor(totalSec / 60) % 60)}:${pad2(totalSec % 60)}`;
    return sign + (withMs ? `${base}.${String(ms).padStart(3, '0')}` : base);
  }

  // Aceita HH:MM:SS.mmm, MM:SS.mmm, SS.mmm e número puro de segundos.
  function parseTimeToSeconds(timeStr) {
    if (timeStr === null || timeStr === undefined) return 0;
    const raw = String(timeStr).trim().replace(',', '.');
    if (!raw) return 0;

    const parts = raw.split(':');
    const nums = parts.map((p) => parseFloat(p) || 0);

    if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
    if (nums.length === 2) return nums[0] * 60 + nums[1];
    return nums[0];
  }

  // --- Duração dos trechos ------------------------------------------------

  const clipSpeed = (clip) => clamp(Number(clip && clip.speed) || 1, 0.1, 10);

  // Duração NA LINHA DO TEMPO: o trecho da fonte dividido pela velocidade.
  // Um corte de 10s a 2x ocupa 5s na montagem.
  const clipDuration = (clip) => Math.max(0, (clip.end - clip.start) / clipSpeed(clip));
  const clipEnd = (clip) => clip.timelineStart + clipDuration(clip);

  // Duração total = onde termina o item que vai mais longe. Deixou de ser a soma
  // das durações: com posição no tempo existem vazios e sobreposições.
  const sequenceDuration = (clips) => clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);

  // --- Ajustes que obrigam a recodificar ----------------------------------

  const defaultColor = () => ({ brightness: 0, contrast: 1, saturation: 1 });
  const clipColor = (clip) => (clip && clip.color) || defaultColor();
  const hasColorAdjust = (c) => c.brightness !== 0 || c.contrast !== 1 || c.saturation !== 1;

  // Um trecho "mexido" precisa recodificar; serve para avisar e para decidir
  // se a montagem ainda cabe no caminho simples de exportação.
  const hasAdjustments = (clip) => !!clip && (
    clipSpeed(clip) !== 1 ||
    (clip.opacity !== undefined && clip.opacity < 1) ||
    (clip.rotate || 0) !== 0 || clip.flipH || clip.flipV ||
    hasColorAdjust(clipColor(clip)) ||
    !!clip.chroma || !!clip.blurRegion
  );

  // Trecho com o som mexido: volume, mudo ou normalização. Como o corte sem
  // perda só copia os streams, qualquer um deles obriga a recodificar.
  const hasAudioTweaks = (clip) => !!clip && (
    !!clip.muted ||
    (clip.volume !== undefined && clip.volume !== 1) ||
    !!clip.normalize
  );

  // --- A montagem "simples" ------------------------------------------------

  // A montagem é "simples" quando cabe no caminho antigo de exportação — aquele
  // que consegue cortar SEM PERDA. Basta uma faixa de vídeo usada, itens colados
  // desde o zero, nada de sobreposição nem trilha.
  function isSimpleTimeline({ tracks, clips, texts }) {
    const base = tracks.find((t) => t.kind === 'video');
    if (!base) return false;
    if (clips.some((c) => c.trackId !== base.id)) return false;

    // Qualquer ajuste de imagem ou de velocidade obriga a recodificar, então a
    // montagem deixa de caber no caminho simples (que só junta os arquivos).
    if (clips.some(hasAdjustments)) return false;

    // O mesmo vale para o som: o caminho simples não mexe no áudio, e volume,
    // mudo ou normalização iam embora sem aviso nenhum.
    if (clips.some(hasAudioTweaks)) return false;
    if (tracks.some((t) => t.solo)) return false;

    // Título ou legenda precisa ser gravado no quadro, o que o caminho simples
    // não faz — ele apenas emenda os arquivos.
    if ((texts || []).some((t) => String(t.content || '').trim())) return false;

    let cursor = 0;
    const items = clips
      .filter((c) => c.trackId === base.id)
      .sort((a, b) => a.timelineStart - b.timelineStart);
    for (const item of items) {
      if (Math.abs(item.timelineStart - cursor) > 0.02) return false;
      cursor = clipEnd(item);
    }
    return true;
  }

  // --- Separar o áudio do vídeo -------------------------------------------

  // Primeira faixa de áudio livre no intervalo [from, to]; null quando todas
  // estão ocupadas (quem chama cria uma nova). Evita empilhar o áudio separado
  // sobre outro som da montagem.
  function findFreeAudioTrack(tracks, clips, from, to) {
    const EPS = 0.001;
    return tracks
      .filter((t) => t.kind === 'audio')
      .find((t) => clips
        .filter((c) => c.trackId === t.id)
        .every((c) => clipEnd(c) <= from + EPS || c.timelineStart >= to - EPS)) || null;
  }

  // O bloco de áudio que nasce da separação: mesma posição, mesmo trecho, mesma
  // velocidade, volume e normalização do vídeo. O vídeo, por sua vez, fica mudo
  // (quem chama faz isso): o som passa a viver só no bloco de áudio.
  function buildSeparatedAudioClip(clip, audioSource, { id, trackId, framing }) {
    const audioClip = {
      id,
      trackId,
      sourceId: audioSource.id,
      timelineStart: clip.timelineStart,
      start: clip.start,
      end: Math.min(clip.end, audioSource.duration || clip.end),
      framing,
      volume: clip.volume === undefined ? 1 : clip.volume,
      muted: !!clip.muted
    };
    if (clip.speed !== undefined) audioClip.speed = clip.speed;
    if (clip.normalize !== undefined) audioClip.normalize = clip.normalize;
    return audioClip;
  }

  // --- Salvar a montagem: vídeo ou só áudio -------------------------------

  // A montagem tem alguma coisa de imagem (vídeo ou foto)?
  const hasVisualClips = (clips, sources) => clips.some((c) => {
    const source = sources.find((s) => s.id === c.sourceId);
    return !!source && source.kind !== 'audio';
  });

  // Decide o que o seletor "Salvar Como" mostra. `forced` lembra se foi o app
  // (e não a pessoa) quem escolheu "Somente áudio", para desfazer sozinho quando
  // a montagem ganhar imagem de novo.
  function resolveJoinMode({ visual, current, forced }) {
    let value = current;
    let nowForced = forced;

    if (!visual && current !== 'audio') {
      value = 'audio';
      nowForced = true;
    } else if (visual && forced) {
      if (current === 'audio') value = 'merged';
      nowForced = false;
    }

    const audio = value === 'audio';
    const hint = !visual
      ? 'A montagem só tem áudio, então só dá para salvar como áudio.'
      : audio
        ? 'A imagem (vídeos, fotos e textos) não vai para o arquivo: sai só o som da montagem.'
        : '';

    return {
      value,
      forced: nowForced,
      videoOptionsDisabled: !visual,
      showAudioOptions: audio,
      buttonLabel: audio ? 'Salvar Áudio' : 'Cortar e Salvar',
      hint
    };
  }

  // O que se perde ao salvar só o áudio de uma montagem com imagem
  function describeAudioOnlyLoss({ videos, photos, texts }) {
    return [
      videos > 0 ? `${videos} trecho(s) de vídeo: a imagem será perdida` : null,
      photos > 0 ? `${photos} foto(s): serão perdidas` : null,
      texts > 0 ? `${texts} título(s) ou legenda(s): serão perdidos` : null,
      'A sua montagem aqui no Cutting não é alterada: dá para exportar o vídeo depois.'
    ].filter(Boolean);
  }

  return {
    clamp, getFileName, stripExtension, formatTime, parseTimeToSeconds,
    clipSpeed, clipDuration, clipEnd, sequenceDuration,
    defaultColor, clipColor, hasColorAdjust, hasAdjustments, hasAudioTweaks,
    isSimpleTimeline,
    findFreeAudioTrack, buildSeparatedAudioClip,
    hasVisualClips, resolveJoinMode, describeAudioOnlyLoss
  };
}));
