// Tempo da montagem, transições e o grafo de composição (sobreposições e mix de áudio).
// Extraído do main.js: sem Electron, sem janela, sem estado — por isso
// pode ser testado com `node --test`. Ver docs/TESTES.md.

const {
  clampNumber, normalizeAdjust, buildAdjustChain, buildBlurRegionGraph,
  buildAtempoChain, buildMediaComposite, evenRound, normalizeFraming, computeMediaLayout
} = require('./filtros');

const TIME_EPSILON = 0.02;   // menor que um frame a 30fps
const AUDIO_RATE = 44100;

// Áudio uniforme em todos os segmentos: é o que permite concatenar sem recodificar
const AUDIO_ENCODE = ['-c:a aac', '-b:a 192k', `-ar ${AUDIO_RATE}`, '-ac 2'];

// Normalização de volume (EBU R128, os mesmos alvos que as plataformas de vídeo
// usam). Em uma passagem só: duas passagens medem melhor, mas exigiriam
// analisar cada trecho antes de exportar — o ganho não paga o tempo aqui.
//   I  = volume médio percebido, em LUFS
//   TP = pico máximo, com folga para não estourar na conversão
//   LRA= quanta diferença entre o mais baixo e o mais alto ainda é permitida
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';

// Duração NA LINHA DO TEMPO. A velocidade separa as duas contas: um trecho de
// 10s da fonte a 2x ocupa 5s na montagem. Todo o resto do motor mede tempo de
// linha do tempo, então a divisão fica concentrada aqui.
// Quanto de material o trecho consome do arquivo original. Não é o mesmo que a
// duração na montagem: com velocidade, 4s de material podem virar 2s de vídeo.
const sourceSpan = (item) => Math.max(0, item.sourceEnd - item.sourceStart);

const itemDuration = (item) => {
  const speed = clampNumber(Number(item.speed) || 1, 0.1, 10);
  return sourceSpan(item) / speed;
};
const itemEnd = (item) => item.timelineStart + itemDuration(item);

// Volume efetivo de um item: mudo é 0; sem valor, 100%; senão o valor entre 0 e 4.
// Não usar `Number(volume) || 1`: o 0 é falso, e um trecho com o volume em 0%
// (sem estar mudo) saía no arquivo a 100%.
const itemVolume = (item) => {
  if (item.muted) return 0;
  if (item.volume === undefined || item.volume === null) return 1;
  const v = Number(item.volume);
  return Number.isFinite(v) ? clampNumber(v, 0, 4) : 1;
};

// Transições aceitas. São nomes do filtro `xfade`, que só existe a partir do
// ffmpeg 4.3 — por isso a troca do binário embutido veio antes deste recurso.
const TRANSITION_TYPES = [
  'fade', 'fadeblack', 'fadewhite', 'dissolve',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright', 'slideup', 'slidedown',
  'circleopen', 'circleclose', 'radial', 'smoothleft', 'smoothright',
  'pixelize', 'hlslice', 'vuslice'
];

const normalizeTransition = (type) =>
  TRANSITION_TYPES.includes(type) ? type : 'fade';

function describeDrift(drift) {
  return Math.abs(drift) > 0.1
    ? `Concluído (início ajustado ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}s p/ keyframe)`
    : 'Concluído!';
}

// Grafo do passe final: sobreposições e mistura de áudio sobre a faixa base.
//
// entrada 0        = vídeo da faixa base (já com a duração total)
// entradas 1..n    = itens de sobreposição, na ordem de empilhamento
// entradas n+1..m  = itens de áudio
function buildCompositionGraph(overlays, audios, frame, duration, textChain) {
  const parts = [];
  let videoLabel = '0:v';

  overlays.forEach((overlay, index) => {
    const input = overlay.inputIndex;
    const layout = overlay.layout;
    const start = overlay.item.timelineStart;
    const end = itemEnd(overlay.item);

    // Os ajustes valem também para quem está por cima — é justamente aqui que
    // o chroma e a opacidade fazem mais sentido, porque o que aparece atrás é
    // a faixa de baixo. A ordem é a mesma do trecho de base: girar/espelhar,
    // cor, chroma e opacidade; depois o borrão; e só então a escala.
    const adjust = normalizeAdjust(overlay.item);
    let label = `${input}:v`;

    const chain = buildAdjustChain(adjust, overlay.effectiveSize);
    if (chain) {
      parts.push(`[${label}]${chain}[oadj${index}]`);
      label = `oadj${index}`;
    }
    if (adjust.blurRegion) {
      parts.push(buildBlurRegionGraph(label, `oblur${index}`, adjust.blurRegion, overlay.effectiveSize));
      label = `oblur${index}`;
    }

    // `setpts` desloca o trecho para a sua posição na linha do tempo (e divide
    // pela velocidade, quando houver); `enable` garante que ele só apareça
    // dentro da janela dele — sem isso o overlay continuaria mostrando o
    // último frame depois de acabar.
    const pts = adjust.speed !== 1
      ? `setpts=(PTS-STARTPTS)/${adjust.speed.toFixed(4)}+${start.toFixed(3)}/TB`
      : `setpts=PTS-STARTPTS+${start.toFixed(3)}/TB`;

    parts.push(`[${label}]scale=${layout.drawWidth}:${layout.drawHeight},setsar=1,${pts}[ov${index}]`);

    const out = `vc${index}`;
    parts.push(
      `[${videoLabel}][ov${index}]overlay=${layout.x}:${layout.y}:` +
      `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})':` +
      `eof_action=pass:shortest=0[${out}]`
    );
    videoLabel = out;
  });

  // Texto por cima de tudo: título e legenda não devem ficar atrás de uma
  // sobreposição. Se o vídeo ainda é a entrada crua, o filtro precisa de um
  // rótulo de saída para poder ser mapeado.
  if (textChain) {
    parts.push(`[${videoLabel}]${textChain}[vtext]`);
    videoLabel = 'vtext';
  }

  // Áudio: cada entrada é deslocada, tem o seu volume e é esticada com silêncio
  // até a duração total. Igualar as durações evita o salto de volume que o amix
  // produz quando uma entrada termina antes das outras.
  const audioLabels = ['0:a'];

  // O som dos vídeos das faixas de cima também entra na mistura. Sem isto um
  // vídeo colocado numa faixa de sobreposição entrava mudo, sem aviso nenhum.
  overlays.forEach((overlay, index) => {
    if (!overlay.hasAudio) return;
    const item = overlay.item;
    const volume = itemVolume(item);
    if (volume === 0) return;

    const delayMs = Math.round(item.timelineStart * 1000);
    const speed = normalizeAdjust(item).speed;
    const tempo = speed !== 1 ? `${buildAtempoChain(speed)},` : '';
    const norm = item.normalize ? `${LOUDNORM},` : '';
    const label = `ovaud${index}`;   // rótulo próprio, sem colidir com o do vídeo

    parts.push(
      `[${overlay.inputIndex}:a]${norm}volume=${volume.toFixed(3)},${tempo}aresample=${AUDIO_RATE},` +
      `adelay=${delayMs}|${delayMs},apad,atrim=0:${duration.toFixed(3)}[${label}]`
    );
    audioLabels.push(label);
  });

  audios.forEach((audio, index) => {
    const delayMs = Math.round(audio.item.timelineStart * 1000);
    const volume = itemVolume(audio.item);
    const label = `ac${index}`;
    // O atempo vem ANTES do adelay: acelerar depois de deslocar mexeria também
    // no silêncio da frente, e a trilha entraria na hora errada.
    const speed = normalizeAdjust(audio.item).speed;
    const tempo = speed !== 1 ? `${buildAtempoChain(speed)},` : '';
    // Normalizar antes do volume, pelo mesmo motivo do trecho de base
    const norm = audio.item.normalize && volume > 0 ? `${LOUDNORM},` : '';
    parts.push(
      `[${audio.inputIndex}:a]${norm}volume=${volume.toFixed(3)},${tempo}aresample=${AUDIO_RATE},` +
      `adelay=${delayMs}|${delayMs},apad,atrim=0:${duration.toFixed(3)}[${label}]`
    );
    audioLabels.push(label);
  });

  let audioOut = '0:a';
  if (audioLabels.length > 1) {
    // O amix divide a soma pelo número de entradas; o volume depois devolve o
    // nível original, para acrescentar uma trilha não abaixar o áudio do vídeo.
    parts.push(
      audioLabels.map((l) => `[${l}]`).join('') +
      `amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0,` +
      `volume=${audioLabels.length}[amixed]`
    );
    audioOut = 'amixed';
  }

  // Os colchetes do -map identificam um RÓTULO do grafo de filtros. Um stream de
  // entrada (0:v, 0:a) é mapeado SEM colchetes — com eles o ffmpeg procura um
  // rótulo com esse nome, não encontra, e aborta.
  //
  // Não dá para usar o .map() do fluent-ffmpeg aqui: ele aplica
  // /^\[?(.*?)\]?$/ e recoloca os colchetes sempre, inclusive em '0:a'. Por isso
  // estes valores vão direto nas outputOptions, já na forma final.
  const toMap = (name) => (/^\d+:[av]$/.test(name) ? name : `[${name}]`);

  return {
    graph: parts.join(';'),
    videoMap: toMap(videoLabel),
    audioMap: toMap(audioOut)
  };
}

module.exports = {
  TIME_EPSILON, AUDIO_RATE, AUDIO_ENCODE, LOUDNORM,
  sourceSpan, itemDuration, itemEnd, itemVolume,
  TRANSITION_TYPES, normalizeTransition,
  describeDrift, buildCompositionGraph
};
