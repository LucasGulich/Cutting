// Filtros do FFmpeg e normalização dos ajustes de cada trecho.
// Extraído do main.js: sem Electron, sem janela, sem estado — por isso
// pode ser testado com `node --test`. Ver docs/TESTES.md.

// Limites do zoom da foto dentro do quadro. 1 = a foto inteira encaixada;
// abaixo disso ela afasta e sobra fundo, acima disso ela transborda e é aparada.
const IMAGE_MIN_ZOOM = 0.1;
const IMAGE_MAX_ZOOM = 5;

function normalizeFormat(format) {
  if (!format) return null;

  const width = Math.round(Number(format.width));
  const height = Math.round(Number(format.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 2 || height < 2) {
    return null;
  }

  // Dimensões ímpares quebram o yuv420p do libx264
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2),
    fit: format.fit === 'contain' ? 'contain' : 'cover'
  };
}

const clampNumber = (value, min, max) => Math.min(Math.max(value, min), max);
const evenRound = (value) => Math.max(2, Math.round(value / 2) * 2);

// --- ENQUADRAMENTO DA FOTO -------------------------------------------------
//
// framing = { zoom, offsetX, offsetY, background: { mode, color } }
//   zoom     : 1 = foto inteira encaixada no quadro. <1 afasta (sobra fundo),
//              >1 aproxima (a foto transborda e é aparada pelo quadro).
//   offsetX/Y: deslocamento em FRAÇÃO do quadro (0 = centro, 0.5 = meia tela).
//              Fração, e não pixels, para a mesma escolha valer em qualquer
//              resolução de saída.
//   background: 'color' = cor sólida | 'blur' = a própria foto desfocada
//              preenchendo o quadro (o efeito de fundo do Reels/Shorts).

function normalizeFraming(framing) {
  const source = framing || {};
  const background = source.background || {};
  const hex = /^#[0-9a-fA-F]{6}$/.test(background.color || '') ? background.color : '#000000';

  return {
    zoom: clampNumber(Number(source.zoom) || 1, IMAGE_MIN_ZOOM, IMAGE_MAX_ZOOM),
    offsetX: clampNumber(Number(source.offsetX) || 0, -2, 2),
    offsetY: clampNumber(Number(source.offsetY) || 0, -2, 2),
    background: { mode: background.mode === 'blur' ? 'blur' : 'color', color: hex }
  };
}

const isDefaultFraming = (framing) =>
  framing.zoom === 1 &&
  framing.offsetX === 0 &&
  framing.offsetY === 0 &&
  framing.background.mode === 'color' &&
  framing.background.color === '#000000';

// Onde e com que tamanho a foto é desenhada dentro do quadro de saída.
// zoom = 1 parte do "encaixe" (a foto inteira cabendo), que é a referência
// natural: o usuário mexe a partir de ver a foto completa.
function computeMediaLayout(mediaSize, frame, framing) {
  const fitScale = Math.min(frame.width / mediaSize.width, frame.height / mediaSize.height);
  const drawWidth = evenRound(mediaSize.width * fitScale * framing.zoom);
  const drawHeight = evenRound(mediaSize.height * fitScale * framing.zoom);

  return {
    drawWidth,
    drawHeight,
    x: Math.round((frame.width - drawWidth) / 2 + framing.offsetX * frame.width),
    y: Math.round((frame.height - drawHeight) / 2 + framing.offsetY * frame.height)
  };
}

// Grafo de filtros que compõe fundo + mídia posicionada. Serve para foto e
// para vídeo — a diferença está só em de onde vem o áudio.
//
// audioSource: rótulo da entrada de áudio (ex.: '1:a' para o silêncio gerado,
//              '0:a' para o áudio do próprio vídeo) ou null para saída muda.
// --- AJUSTES POR TRECHO -----------------------------------------------------
//
// Todos entram na MESMA cadeia, aplicada à mídia ANTES do enquadramento. A
// ordem importa e é esta de propósito:
//
//   1. girar/espelhar  — muda a orientação, então vem antes de tudo que mede
//   2. cor             — sobre a imagem já orientada
//   3. chroma          — recorta o fundo depois da cor (senão a correção de cor
//                        mudaria o verde e a chave erraria o alvo)
//   4. borrão de área  — por último, para tapar o que ficou visível
//
// A velocidade NÃO entra aqui: ela mexe no tempo, não na imagem, e é aplicada
// separadamente (setpts no vídeo, atempo no áudio).

const DEFAULT_ADJUST = {
  speed: 1,
  opacity: 1,
  rotate: 0,
  flipH: false,
  flipV: false,
  color: null,        // { brightness, contrast, saturation }
  blurRegion: null,   // { x, y, w, h } em fração do quadro da mídia
  chroma: null        // { color, similarity, blend }
};

// Número válido ou o padrão. Number(undefined) é NaN, e NaN passa por clamp sem
// ser corrigido: o filtro do ffmpeg receberia "contrast=NaN" e abortaria.
const numberOr = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

function normalizeAdjust(clip) {
  const a = clip || {};
  const color = a.color && (a.color.brightness || a.color.contrast !== 1 || a.color.saturation !== 1)
    ? {
      brightness: clampNumber(Number(a.color.brightness) || 0, -1, 1),
      contrast: clampNumber(numberOr(a.color.contrast, 1), 0, 3),
      saturation: clampNumber(numberOr(a.color.saturation, 1), 0, 3)
    }
    : null;

  const region = a.blurRegion && a.blurRegion.w > 0.01 && a.blurRegion.h > 0.01
    ? {
      x: clampNumber(Number(a.blurRegion.x) || 0, 0, 1),
      y: clampNumber(Number(a.blurRegion.y) || 0, 0, 1),
      w: clampNumber(Number(a.blurRegion.w) || 0, 0.01, 1),
      h: clampNumber(Number(a.blurRegion.h) || 0, 0.01, 1)
    }
    : null;

  const chroma = a.chroma && /^#[0-9a-fA-F]{6}$/.test(a.chroma.color || '')
    ? {
      color: a.chroma.color,
      similarity: clampNumber(Number(a.chroma.similarity) || 0.3, 0.01, 1),
      blend: clampNumber(Number(a.chroma.blend) || 0.1, 0, 1)
    }
    : null;

  return {
    speed: clampNumber(Number(a.speed) || 1, 0.1, 10),
    opacity: clampNumber(a.opacity === undefined ? 1 : Number(a.opacity), 0, 1),
    rotate: [0, 90, 180, 270].includes(Number(a.rotate)) ? Number(a.rotate) : 0,
    flipH: !!a.flipH,
    flipV: !!a.flipV,
    color, blurRegion: region, chroma
  };
}

const hasAdjustments = (a) =>
  a.rotate !== 0 || a.flipH || a.flipV || a.color || a.blurRegion || a.chroma || a.opacity < 1;

// Filtros que agem sobre a imagem, na ordem descrita acima. Devolve os trechos
// já encadeados por vírgula, ou string vazia se não houver nada a fazer.
function buildAdjustChain(adjust, mediaSize) {
  const parts = [];

  if (adjust.rotate === 90) parts.push('transpose=1');
  else if (adjust.rotate === 180) parts.push('transpose=1,transpose=1');
  else if (adjust.rotate === 270) parts.push('transpose=2');
  if (adjust.flipH) parts.push('hflip');
  if (adjust.flipV) parts.push('vflip');

  if (adjust.color) {
    parts.push(
      `eq=brightness=${adjust.color.brightness.toFixed(3)}:` +
      `contrast=${adjust.color.contrast.toFixed(3)}:` +
      `saturation=${adjust.color.saturation.toFixed(3)}`
    );
  }

  if (adjust.chroma) {
    // O chromakey abre transparência; o formato precisa suportar alfa, senão
    // o recorte se perde na próxima etapa.
    parts.push(
      `format=yuva420p,chromakey=0x${adjust.chroma.color.slice(1)}:` +
      `${adjust.chroma.similarity.toFixed(3)}:${adjust.chroma.blend.toFixed(3)}`
    );
  }

  if (adjust.opacity < 1) {
    parts.push(`format=yuva420p,colorchannelmixer=aa=${adjust.opacity.toFixed(3)}`);
  }

  return parts.join(',');
}

// O borrão de região precisa de um grafo próprio (recorta, borra e devolve),
// então não cabe na cadeia linear acima.
function buildBlurRegionGraph(input, output, region, mediaSize) {
  if (!mediaSize) return `[${input}]null[${output}]`;

  const w = evenRound(mediaSize.width * region.w);
  const h = evenRound(mediaSize.height * region.h);
  const x = Math.round(mediaSize.width * region.x);
  const y = Math.round(mediaSize.height * region.y);

  return `[${input}]split=2[brbase][brcut];` +
         `[brcut]crop=${w}:${h}:${x}:${y},boxblur=12:2[brblur];` +
         `[brbase][brblur]overlay=${x}:${y}[${output}]`;
}

// atempo só aceita de 0.5 a 2.0; fora disso encadeia-se mais de um.
// Sem isso, uma câmera lenta de 0.25x sairia com o áudio intacto e fora de sincronia.
function buildAtempoChain(speed) {
  const steps = [];
  let remaining = speed;
  while (remaining < 0.5) { steps.push(0.5); remaining /= 0.5; }
  while (remaining > 2.0) { steps.push(2.0); remaining /= 2.0; }
  steps.push(remaining);
  return steps.map((s) => `atempo=${s.toFixed(4)}`).join(',');
}

function buildMediaComposite(frame, layout, background, audioSource, adjust, mediaSize, preChain) {
  const { width, height } = frame;
  const { drawWidth, drawHeight, x, y } = layout;
  const settings = adjust || normalizeAdjust({});

  let graph = '';

  // Etapa opcional aplicada à fonte antes de tudo (usada pela velocidade).
  // Fica como um passo nomeado em vez de emenda de texto no grafo pronto:
  // procurar "[0:v]" numa string montada é o tipo de coisa que quebra em
  // silêncio quando o grafo muda de forma.
  let sourceLabel = '0:v';
  if (preChain) {
    graph += `[0:v]${preChain}[srcpre];`;
    sourceLabel = 'srcpre';
  }

  if (background.mode === 'blur') {
    // Desfoque feito em miniatura e depois ampliado: o resultado é
    // visualmente o mesmo de desfocar em tamanho real, e evita processar um
    // blur pesado em CADA frame do trecho (10s a 30fps são 300 frames).
    const smallWidth = evenRound(width / 8);
    const smallHeight = evenRound(height / 8);
    graph +=
      `[${sourceLabel}]split=2[bgsrc][fgsrc];` +
      `[bgsrc]scale=${smallWidth}:${smallHeight}:force_original_aspect_ratio=increase,` +
      `crop=${smallWidth}:${smallHeight},boxblur=4:2,scale=${width}:${height},setsar=1[bg];`;
  } else {
    // 0x… e não #…: o parser de filtros do ffmpeg trata '#' como comentário
    graph +=
      `color=c=0x${background.color.slice(1)}:s=${width}x${height}[bg];` +
      `[${sourceLabel}]null[fgsrc];`;
  }

  // Ajustes da imagem entram entre a fonte e o enquadramento
  const chain = buildAdjustChain(settings, mediaSize);
  let frontLabel = 'fgsrc';

  if (chain) {
    graph += `[${frontLabel}]${chain}[fgadj];`;
    frontLabel = 'fgadj';
  }

  // O borrão vem DEPOIS de girar: a região é escolhida sobre a imagem como ela
  // aparece, então as coordenadas valem no tamanho já rotacionado.
  if (settings.blurRegion) {
    const rotated = settings.rotate === 90 || settings.rotate === 270;
    const size = mediaSize && rotated
      ? { width: mediaSize.height, height: mediaSize.width }
      : mediaSize;
    graph += buildBlurRegionGraph(frontLabel, 'fgblur', settings.blurRegion, size) + ';';
    frontLabel = 'fgblur';
  }

  graph +=
    `[${frontLabel}]scale=${drawWidth}:${drawHeight},setsar=1[fg];` +
    `[bg][fg]overlay=${x}:${y}[v]`;

  if (audioSource) graph += `;[${audioSource}]anull[a]`;

  return graph;
}

function buildScaleFilter({ width, height, fit }) {
  if (fit === 'contain') {
    // `decrease` cabe dentro do alvo; o pad centraliza e completa com tarjas
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
           `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  }
  // `increase` cobre o alvo inteiro (sobrando para fora); o crop apara no centro
  return `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
         `crop=${width}:${height},setsar=1`;
}

module.exports = {
  IMAGE_MIN_ZOOM, IMAGE_MAX_ZOOM,
  clampNumber, evenRound, numberOr,
  normalizeFormat, normalizeFraming, isDefaultFraming, computeMediaLayout,
  DEFAULT_ADJUST, normalizeAdjust, hasAdjustments,
  buildAdjustChain, buildBlurRegionGraph, buildAtempoChain, buildMediaComposite,
  buildScaleFilter
};
