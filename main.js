const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

// Guardamos o binário do ffprobe para consultas diretas (listagem de keyframes)
let ffprobeBinary = null;
let ffmpegBinary = null;

// Configura os caminhos do FFmpeg e FFprobe embutidos.
//
// `ffmpeg-static` + `@ffprobe-installer/ffprobe`, ambos com builds de 2023.
// O `@ffmpeg-installer` está parado num build de 2018, que já foi a causa-raiz
// de um corte saindo errado (-avoid_negative_ts quebrando o -t) e não tem o
// filtro `xfade`, necessário para as transições.
//
// O par importa: `ffprobe-static` traz um ffprobe de 2018, e ler com uma versão
// muito mais velha do que a que escreve é pedir para um metadado sair torto.
// Empacotado, o código vive dentro de um arquivo `app.asar` — e binários NÃO
// executam de dentro dele. Os dois pacotes ficam de fora (asar.unpack no
// electron-packager), e o caminho precisa apontar para a pasta desempacotada.
// Rodando pelo código-fonte não existe 'app.asar' no caminho e a troca não faz
// nada, então a mesma linha serve para os dois casos.
const unpacked = (p) => (p ? p.replace('app.asar', 'app.asar.unpacked') : p);

try {
  const ffmpegPath = unpacked(require('ffmpeg-static'));
  const ffprobePath = unpacked(require('@ffprobe-installer/ffprobe').path);
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
  ffprobeBinary = ffprobePath;
  ffmpegBinary = ffmpegPath;
  console.log('FFmpeg configurado com sucesso. Path:', ffmpegPath);
} catch (err) {
  console.error('Erro ao configurar FFmpeg embutido:', err);
}

// Extensões aceitas como foto. Mantida aqui e exposta ao renderer para que o
// diálogo de arquivos e o arrastar-e-soltar concordem sobre o que é imagem.
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'];
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'];

let mainWindow;

// Fechar a janela descarta a montagem — nada é salvo em disco. Quem decide se
// o fechamento prossegue é o renderer, o único que sabe se há trechos
// pendentes ou exportação em andamento. Estes dois sinalizadores evitam o laço
// close -> pergunta -> close.
let allowWindowClose = false;
let closeAckTimer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    // A linha do tempo ocupa 232px na base, então a janela nasce mais alta
    // para o player não ficar espremido.
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 680,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: 'Cutting',
    // Ícone da janela e da barra de tarefas. O do EXECUTÁVEL é outro caminho:
    // vem do --icon do electron-packager, gravado dentro do .exe.
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: '#0f0c1b' // Fundo elegante inicial
  });

  mainWindow.loadFile('index.html');

  // Pergunta ao renderer antes de fechar de fato.
  //
  // O timeout de 2s vale só até o renderer dar sinal de vida ('close-ack').
  // Ele existe para o caso de o renderer estar travado ou quebrado — sem isso
  // a janela ficaria impossível de fechar. Depois do ack esperamos a resposta
  // do usuário pelo tempo que ele levar: seria péssimo fechar sozinho enquanto
  // ele lê a pergunta.
  mainWindow.on('close', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();

    if (mainWindow.webContents.isCrashed()) {
      allowWindowClose = true;
      mainWindow.close();
      return;
    }

    mainWindow.webContents.send('app-close-requested');

    clearTimeout(closeAckTimer);
    closeAckTimer = setTimeout(() => {
      closeAckTimer = null;
      allowWindowClose = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    }, 2000);
  });

  mainWindow.on('closed', () => {
    clearTimeout(closeAckTimer);
    closeAckTimer = null;
    mainWindow = null;
  });

  // mainWindow.webContents.openDevTools(); // Útil para desenvolvimento
}

// O renderer recebeu o pedido e vai perguntar ao usuário: desarma o timeout.
ipcMain.on('close-ack', () => {
  clearTimeout(closeAckTimer);
  closeAckTimer = null;
});

ipcMain.on('close-response', (event, allow) => {
  clearTimeout(closeAckTimer);
  closeAckTimer = null;
  if (!allow) return; // usuário desistiu; a janela continua aberta
  allowWindowClose = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// --- IPC Handlers (Backend Logic) ---

// 1. Seleção do vídeo original
ipcMain.handle('select-video', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione o Vídeo para Cortar',
    filters: [
      { name: 'Vídeos', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'ts'] }
    ],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// 1b. Seleção de fotos para entrar na sequência
ipcMain.handle('select-images', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione as Fotos',
    filters: [
      { name: 'Imagens', extensions: IMAGE_EXTENSIONS }
    ],
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return [];
  }
  return result.filePaths;
});

// 1d. Seleção de áudio (música, narração) para a faixa de áudio
ipcMain.handle('select-audio', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione o Áudio',
    filters: [
      { name: 'Áudio', extensions: AUDIO_EXTENSIONS }
    ],
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled || result.filePaths.length === 0) return [];
  return result.filePaths;
});

// 1c. Cor média de uma foto, para usar como fundo
//
// Feito aqui e não no renderer de propósito: ler os pixels de um arquivo
// file:// pelo canvas esbarra na política de origem do Chromium. Reduzir a
// imagem a 1x1 pelo ffmpeg dá exatamente a média, sem esse problema.
ipcMain.handle('get-image-average-color', (event, filePath) => {
  return new Promise((resolve) => {
    if (!ffmpegBinary) return resolve(null);

    execFile(ffmpegBinary, [
      '-v', 'error', '-i', filePath,
      '-vf', 'scale=1:1', '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'
    ], { encoding: 'buffer', maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err || !stdout || stdout.length < 3) return resolve(null);
      const hex = [stdout[0], stdout[1], stdout[2]]
        .map((c) => c.toString(16).padStart(2, '0')).join('');
      resolve(`#${hex}`);
    });
  });
});

// 2. Seleção do diretório de destino
ipcMain.handle('select-output-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione a Pasta de Destino para os Cortes',
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// 3. Obtenção de metadados do vídeo
ipcMain.handle('get-video-metadata', (event, filePath) => {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        console.error('Erro ao ler metadados:', err);
        return reject(err);
      }
      const duration = metadata.format.duration;
      const size = metadata.format.size;
      const formatName = metadata.format.format_name;
      
      // Busca informações da stream de vídeo
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      const width = videoStream ? videoStream.width : 0;
      const height = videoStream ? videoStream.height : 0;
      const codec = videoStream ? videoStream.codec_name : 'desconhecido';

      // FPS: usado no frontend para navegação frame a frame e para os "nudges"
      let fps = 30;
      const rateStr = videoStream && (videoStream.avg_frame_rate || videoStream.r_frame_rate);
      if (rateStr && rateStr !== '0/0') {
        const [num, den] = rateStr.split('/').map(Number);
        if (num > 0 && den > 0) fps = num / den;
      }

      const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

      resolve({
        duration,
        size,
        formatName,
        width,
        height,
        codec,
        fps,
        hasAudio: !!audioStream,
        audioCodec: audioStream ? audioStream.codec_name : null
      });
    });
  });
});

// 4. Criação de vídeo de preview compatível (remux rápido para MP4 + AAC)
ipcMain.handle('create-preview', (event, filePath) => {
  return new Promise((resolve, reject) => {
    const ext = path.extname(filePath).toLowerCase();
    
    // Se já for MP4, tentamos reproduzir direto
    if (ext === '.mp4') {
      // Verifica se o codec é H.264 (comum para web)
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (!err) {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
          
          const isVCodecOk = videoStream && (videoStream.codec_name === 'h264' || videoStream.codec_name === 'vp9' || videoStream.codec_name === 'av1');
          const isACodecOk = !audioStream || (audioStream.codec_name === 'aac' || audioStream.codec_name === 'mp3' || audioStream.codec_name === 'opus');
          
          if (isVCodecOk && isACodecOk) {
            console.log('Vídeo compatível nativamente. Usando arquivo original para preview.');
            return resolve(filePath);
          }
        }
        // Se não for totalmente compatível, gera o preview
        generatePreviewFile(filePath, resolve, reject);
      });
    } else {
      generatePreviewFile(filePath, resolve, reject);
    }
  });
});

function generatePreviewFile(filePath, resolve, reject) {
  const tempDir = app.getPath('temp');
  const previewPath = path.join(tempDir, `cutting_preview_${Date.now()}.mp4`);
  
  console.log(`Iniciando geração de preview: de ${filePath} para ${previewPath}`);

  // Faz remux rápido (copia vídeo se for compatível, ou recodifica rapidamente em baixa qualidade se necessário)
  // Como padrão para preview rápido, usamos copy de vídeo se possível e convertemos áudio para aac
  ffmpeg(filePath)
    .outputOptions([
      '-c:v libx264',
      '-preset ultrafast', // Extremamente rápido
      '-crf 28',          // Qualidade de rascunho para preview leve
      '-c:a aac',
      '-b:a 128k',
      '-movflags +faststart' // Carrega rapidamente na web
    ])
    .size('?x480') // Reduz a escala para 480p para ser rápido no processamento
    .output(previewPath)
    .on('end', () => {
      console.log('Preview gerado com sucesso:', previewPath);
      resolve(previewPath);
    })
    .on('error', (err) => {
      console.error('Erro ao gerar preview de vídeo:', err);
      reject(err);
    })
    .run();
}

// 5. Limpeza de arquivos de preview temporários ao fechar
app.on('will-quit', () => {
  const tempDir = app.getPath('temp');
  try {
    const files = fs.readdirSync(tempDir);
    files.forEach(file => {
      if (file.startsWith('cutting_preview_') && file.endsWith('.mp4')) {
        const filePath = path.join(tempDir, file);
        fs.unlinkSync(filePath);
        console.log('Arquivo temporário excluído:', filePath);
      }
    });
  } catch (err) {
    console.error('Erro ao limpar arquivos temporários:', err);
  }
});

// 6. Exportação de clipes
//
// Contrato único que atende os dois formatos de saída e aceita clipes de fontes
// diferentes, na ordem exata que o usuário montou na sequência:
//   clips    : [{ id, sourcePath, start, end, label, kind }]  (a ORDEM é a ordem final)
//              kind: 'video' (padrão) | 'image' — foto exibida de start a end
//   mode     : 'precise' | 'fast'                        (qualidade/velocidade do corte)
//   joinMode : 'separate' | 'merged'                     (um arquivo por clipe, ou tudo num só)
//   format   : null | { width, height, fit }             (proporção/resolução de saída)
//   baseName : nome base escolhido pelo usuário
ipcMain.handle('export-clips', async (event, { clips, outputDir, baseName, mode, joinMode, format }) => {
  const cutMode = mode === 'fast' ? 'fast' : 'precise';
  const join = joinMode === 'merged' ? 'merged' : 'separate';
  const safeBase = sanitizeFileName(baseName) || 'corte';
  const target = normalizeFormat(format);

  const notifyClip = (clipId, status, message) => {
    event.sender.send('cut-status', { cutId: clipId, status, message });
  };
  const notifyOverall = (percent, message) => {
    event.sender.send('export-overall', { percent, message });
  };

  if (join === 'separate') {
    return exportSeparate(event, clips, outputDir, safeBase, cutMode, notifyClip, notifyOverall, target);
  }
  return exportMerged(event, clips, outputDir, safeBase, cutMode, notifyClip, notifyOverall, target);
});

// 6b. Exportação da LINHA DO TEMPO (faixas, sobreposição e áudio)
//
// Continua existindo o `export-clips` acima: quando a montagem é simples — uma
// faixa só, itens colados, sem sobreposição nem trilha —, aquele caminho é
// preferido porque consegue cortar SEM PERDA. A composição aqui sempre
// recodifica, que é o preço de compor camadas.
ipcMain.handle('export-timeline', async (event, payload) => {
  const safeBase = sanitizeFileName(payload.baseName) || 'montagem';

  const notifyItem = (itemId, status, message) => {
    event.sender.send('cut-status', { cutId: itemId, status, message });
  };
  const notifyOverall = (percent, message) => {
    event.sender.send('export-overall', { percent, message });
  };

  return exportTimeline(
    event,
    { ...payload, format: normalizeFormat(payload.format) },
    payload.outputDir,
    safeBase,
    notifyItem,
    notifyOverall
  );
});

// --- FORMATO DE SAÍDA (proporção / resolução) -----------------------------
//
// `format` = null  → mantém a resolução original de cada fonte.
// `format` = { width, height, fit } → padroniza tudo naquele alvo.
//
//   fit 'contain' → encaixa inteiro e preenche o resto com tarjas.
//                   Não perde imagem nenhuma.
//   fit 'cover'   → preenche a tela e descarta o que sobra nas bordas.
//                   Não tem tarja, mas corta (de 16:9 para 9:16 sai caro).
//
// Para acrescentar um formato novo não é preciso mexer aqui: o alvo chega
// pronto da interface, este módulo só valida e monta o filtro.

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

function normalizeAdjust(clip) {
  const a = clip || {};
  const color = a.color && (a.color.brightness || a.color.contrast !== 1 || a.color.saturation !== 1)
    ? {
      brightness: clampNumber(Number(a.color.brightness) || 0, -1, 1),
      contrast: clampNumber(Number(a.color.contrast) === undefined ? 1 : Number(a.color.contrast), 0, 3),
      saturation: clampNumber(Number(a.color.saturation) === undefined ? 1 : Number(a.color.saturation), 0, 3)
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

function probeFrameSize(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return resolve(null);
      const v = metadata.streams.find((s) => s.codec_type === 'video');
      resolve(v && v.width ? { width: v.width, height: v.height } : null);
    });
  });
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

// Remove caracteres proibidos em nomes de arquivo no Windows.
function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 120);
}

// Evita sobrescrever silenciosamente: acrescenta (2), (3)... se o arquivo já existir.
function uniquePath(dirPath, fileName) {
  const ext = path.extname(fileName);
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dirPath, fileName);
  let counter = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dirPath, `${stem} (${counter})${ext}`);
    counter++;
  }
  return candidate;
}

function describeDrift(drift) {
  return Math.abs(drift) > 0.1
    ? `Concluído (início ajustado ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}s p/ keyframe)`
    : 'Concluído!';
}

// ==========================================================================
// EXPORTAÇÃO POR COMPOSIÇÃO (linha do tempo em faixas)
//
// A montagem deixou de ser "um trecho depois do outro" e passou a ter posição
// no tempo e camadas. A exportação acontece em duas etapas:
//
//   1. FAIXA BASE (a de baixo) — cada item é normalizado para a resolução, o
//      fps e o formato de áudio de saída, e os vazios entre itens são
//      preenchidos com segmentos de fundo. O resultado é concatenado: como
//      tudo saiu com os mesmos parâmetros, a junção é instantânea.
//
//   2. SOBREPOSIÇÕES E ÁUDIO — um único passe de filter_complex sobrepõe os
//      itens das faixas de cima, cada um limitado à sua janela de tempo, e
//      mixa as faixas de áudio já deslocadas para a sua posição.
//
// Por que em duas etapas, e não um grafo único: um grafo com todos os itens de
// todas as faixas fica enorme e frágil, e o ffmpeg embutido é de 2018. A faixa
// base reaproveita a concatenação, que já é território conhecido e testado.
// ==========================================================================

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

/**
 * Monta a faixa base aplicando transições nas emendas marcadas.
 *
 * Os trechos SEM transição entre si são concatenados normalmente (barato), e
 * os grupos resultantes são encadeados com `xfade` no vídeo e `acrossfade` no
 * áudio. Fazer tudo num xfade só exigiria uma transição em cada emenda, que
 * não é o caso — a maioria das emendas costuma ser corte seco.
 */
async function buildBaseWithTransitions(segments, transitions, outputPath, frame, tempDir, registerTemp) {
  const cutAt = new Map(transitions.map((t) => [t.beforeSegment, t]));

  // 1. Agrupa segmentos em blocos separados pelas transições
  const groups = [];
  let current = [];
  segments.forEach((segment, index) => {
    if (cutAt.has(index) && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(segment);
  });
  if (current.length > 0) groups.push(current);

  // 2. Concatena cada bloco
  const groupPaths = [];
  for (let i = 0; i < groups.length; i++) {
    if (groups[i].length === 1) {
      groupPaths.push(groups[i][0]);
      continue;
    }
    const groupPath = registerTemp(path.join(tempDir, `grupo_${i}.mp4`));
    await performConcatDemux(groups[i], groupPath, () => {});
    groupPaths.push(groupPath);
  }

  if (groupPaths.length === 1) {
    fs.copyFileSync(groupPaths[0], outputPath);
    return;
  }

  // 3. Encadeia os blocos com xfade / acrossfade.
  //
  // O `offset` do xfade é medido no fluxo ACUMULADO, e cada transição encurta
  // o total pela duração dela — daí o acumulador descontar `duration` a cada
  // emenda. Errar essa conta faz a transição acontecer no lugar errado.
  const durations = [];
  for (const groupPath of groupPaths) {
    const probe = await probeBasics(groupPath);
    durations.push(probe.duration || 0);
  }

  const ordered = transitions.slice(0, groupPaths.length - 1);
  const parts = [];
  let videoLabel = '0:v';
  let audioLabel = '0:a';
  let accumulated = durations[0];

  for (let i = 1; i < groupPaths.length; i++) {
    const transition = ordered[i - 1] || { duration: 0.5, type: 'fade' };
    // A transição não pode ser maior que os blocos que ela une
    const maxDuration = Math.max(0.1, Math.min(durations[i - 1], durations[i]) - 0.05);
    const dur = Math.min(transition.duration, maxDuration);
    const offset = Math.max(0, accumulated - dur);

    const vOut = `vx${i}`;
    const aOut = `ax${i}`;
    parts.push(
      `[${videoLabel}][${i}:v]xfade=transition=${normalizeTransition(transition.type)}:` +
      `duration=${dur.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`
    );
    parts.push(`[${audioLabel}][${i}:a]acrossfade=d=${dur.toFixed(3)}[${aOut}]`);

    videoLabel = vOut;
    audioLabel = aOut;
    accumulated = accumulated + durations[i] - dur;
  }

  let command = ffmpeg();
  groupPaths.forEach((p) => { command = command.input(p); });

  await new Promise((resolve, reject) => {
    command
      .complexFilter(parts.join(';'))
      .outputOptions([
        `-map [${videoLabel}]`,
        `-map [${audioLabel}]`,
        '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p',
        `-r ${frame.fps}`, ...AUDIO_ENCODE, '-movflags +faststart'
      ])
      .output(outputPath)
      .on('start', (cmd) => console.log('Transições FFmpeg:', cmd))
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// Segmento de FUNDO para preencher um vazio da faixa base.
// Precisa de áudio silencioso pelo mesmo motivo das fotos: sem faixa de áudio
// ele não emenda com os demais na concatenação.
function buildGapSegment(outputPath, duration, frame, fps, color) {
  return ffmpeg()
    .input(`color=c=0x${color.slice(1)}:s=${frame.width}x${frame.height}:r=${fps}`)
    .inputOptions(['-f lavfi'])
    .input(`anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`)
    .inputOptions(['-f lavfi'])
    .outputOptions([
      `-t ${duration.toFixed(3)}`,
      '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p',
      `-r ${fps}`, ...AUDIO_ENCODE, '-shortest', '-movflags +faststart'
    ])
    .output(outputPath);
}

// Um item da faixa base, normalizado para o alvo de saída.
// Sempre recodifica: a uniformidade é o que torna a concatenação instantânea e
// a composição previsível.
function buildNormalizedItem(item, outputPath, frame, fps, mediaSize, hasAudio) {
  const framing = normalizeFraming(item.framing);
  const adjust = normalizeAdjust(item);
  const duration = itemDuration(item);          // já na linha do tempo, com a velocidade
  const isImage = item.kind === 'image';

  // Girar em 90° ou 270° troca largura por altura, e o enquadramento tem que
  // ser calculado sobre a imagem COMO ELA FICA — senão um vídeo em pé rodado
  // sairia com as tarjas no lado errado.
  const rotated = adjust.rotate === 90 || adjust.rotate === 270;
  const effectiveSize = rotated
    ? { width: mediaSize.height, height: mediaSize.width }
    : mediaSize;
  const layout = computeMediaLayout(effectiveSize, frame, framing);

  // Volume e mudo do item entram aqui, junto com o resto da normalização
  const volume = item.muted ? 0 : clampNumber(Number(item.volume) || 1, 0, 4);

  let command = ffmpeg();
  if (isImage) {
    command = command
      .input(item.sourcePath).inputOptions(['-loop 1', `-framerate ${fps}`])
      .input(`anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`).inputOptions(['-f lavfi']);
  } else {
    command = command
      .input(item.sourcePath).inputOptions([`-ss ${item.sourceStart.toFixed(3)}`]);
    // Vídeo mudo (ou silenciado) ainda precisa de faixa de áudio para concatenar
    if (!hasAudio || volume === 0) {
      command = command
        .input(`anullsrc=channel_layout=stereo:sample_rate=${AUDIO_RATE}`).inputOptions(['-f lavfi']);
    }
  }

  const silentInput = isImage || !hasAudio || volume === 0;
  const audioLabel = silentInput ? '1:a' : '0:a';

  // Velocidade: setpts estica ou encolhe o tempo do vídeo; o áudio precisa do
  // atempo para acompanhar sem virar chipmunk (ou sem descolar da imagem).
  const speed = adjust.speed;
  const speedVideo = speed !== 1 ? `setpts=PTS/${speed.toFixed(4)},` : '';
  const speedAudio = speed !== 1 ? `,${buildAtempoChain(speed)}` : '';

  const audioParts = [];
  // Normalizar vem ANTES do volume: primeiro o trecho é levado ao nível padrão,
  // depois o usuário sobe ou desce a partir dali. Na ordem inversa o loudnorm
  // desfaria o ajuste manual.
  if (!silentInput && item.normalize) audioParts.push(LOUDNORM);
  if (!silentInput && volume !== 1) audioParts.push(`volume=${volume.toFixed(3)}`);
  const audioChain = (audioParts.length ? audioParts.join(',') : 'anull') + speedAudio;

  // O setpts entra na FONTE, antes de qualquer coisa que meça a imagem
  const graph =
    buildMediaComposite(
      frame, layout, framing.background, null, adjust, effectiveSize,
      speedVideo ? speedVideo.slice(0, -1) : null
    ) +
    `;[${audioLabel}]${audioChain},aresample=${AUDIO_RATE}[a]`;

  return command
    .complexFilter(graph)
    .map('[v]')
    .map('[a]')
    .outputOptions([
      `-t ${duration.toFixed(3)}`,
      '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p',
      `-r ${fps}`, ...AUDIO_ENCODE, '-movflags +faststart'
    ])
    .output(outputPath);
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
    const volume = item.muted ? 0 : clampNumber(Number(item.volume) || 1, 0, 4);
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
    const volume = audio.item.muted ? 0 : clampNumber(Number(audio.item.volume) || 1, 0, 4);
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

// Alvo de saída (resolução e fps) quando o usuário não escolheu um formato:
// manda a maior resolução e o maior fps entre os VÍDEOS da montagem. Fotos não
// entram na conta — uma foto de 6000px não deve inflar o vídeo todo.
async function resolveTimelineTarget(items, format) {
  const videoPaths = [...new Set(
    items.filter((i) => i.kind === 'video').map((i) => i.sourcePath)
  )];

  const detected = videoPaths.length > 0
    ? await pickCommonTarget(videoPaths)
    : null;

  const fps = detected ? detected.fps : IMAGE_CLIP_FPS;

  if (format) return { width: format.width, height: format.height, fps };
  if (detected) return { width: detected.width, height: detected.height, fps };

  // Só fotos: usa a maior delas
  const sizes = (await Promise.all(
    [...new Set(items.map((i) => i.sourcePath))].map(probeFrameSize)
  )).filter(Boolean);

  if (sizes.length === 0) return { width: 1280, height: 720, fps };
  return {
    width: evenRound(Math.max(...sizes.map((s) => s.width))),
    height: evenRound(Math.max(...sizes.map((s) => s.height))),
    fps
  };
}

/**
 * Exporta a linha do tempo inteira como um único vídeo.
 *
 *   tracks : [{ id, kind: 'video'|'audio', muted }]  — ordem = empilhamento
 *   items  : [{ id, trackId, sourcePath, kind, timelineStart,
 *               sourceStart, sourceEnd, framing, volume, muted }]
 *   background : cor dos vazios da faixa base
 */
async function exportTimeline(event, payload, outputDir, safeBase, notifyItem, notifyOverall) {
  const { tracks, items, format, background, texts, split } = payload;

  const videoTracks = tracks.filter((t) => t.kind === 'video');
  const audioTracks = tracks.filter((t) => t.kind === 'audio');
  const baseTrack = videoTracks[0];
  if (!baseTrack) throw new Error('A montagem não tem faixa de vídeo.');

  const visible = (item) => {
    const track = tracks.find((t) => t.id === item.trackId);
    return track && !track.muted;
  };

  const baseItems = items
    .filter((i) => i.trackId === baseTrack.id)
    .sort((a, b) => a.timelineStart - b.timelineStart);

  // A ORDEM AQUI É A ORDEM DE EMPILHAMENTO: cada sobreposição é desenhada sobre
  // o resultado das anteriores, então a última da lista fica na frente. Quem
  // manda é a posição da FAIXA (a mais acima na tela vem por último), não a
  // hora em que o trecho começa — ordenar por tempo fazia um trecho de faixa
  // baixa cobrir um de faixa alta sempre que ele começasse depois, e o arquivo
  // saía diferente do que o monitor mostrava.
  const overlayItems = videoTracks.slice(1)
    .flatMap((track) => items
      .filter((i) => i.trackId === track.id && visible(i))
      .sort((a, b) => a.timelineStart - b.timelineStart));

  const audioItems = audioTracks
    .flatMap((track) => items.filter((i) => i.trackId === track.id && visible(i)));

  let duration = Math.max(
    0,
    ...items.map(itemEnd)
  );
  if (duration <= 0) throw new Error('A montagem está vazia.');

  // Itens de faixa desligada não entram no arquivo. Avisar explicitamente
  // evita que a linha deles fique parada em "Aguardando..." para sempre.
  const included = new Set([...baseItems, ...overlayItems, ...audioItems].map((i) => i.id));
  items.filter((i) => !included.has(i.id)).forEach((item) => {
    notifyItem(item.id, 'skipped', 'Faixa desligada');
  });

  const frame = await resolveTimelineTarget(items.filter((i) => i.kind !== 'audio'), format);
  const gapColor = /^#[0-9a-fA-F]{6}$/.test(background || '') ? background : '#000000';

  const tempDir = path.join(app.getPath('temp'), `cutting_tl_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const temps = [];

  const registerTemp = (p) => { temps.push(p); return p; };

  try {
    // ---------- Etapa 1: faixa base ----------
    const segments = [];
    let cursor = 0;
    let sequence = 0;

    const addGap = async (gapDuration) => {
      const gapPath = registerTemp(path.join(tempDir, `gap_${String(sequence++).padStart(4, '0')}.mp4`));
      await runCutCommand(
        buildGapSegment(gapPath, gapDuration, frame, frame.fps, gapColor),
        gapDuration,
        () => {}
      );
      segments.push(gapPath);
    };

    // Transições em cada emenda. Dois trechos vizinhos que se SOBREPÕEM na
    // linha do tempo formam uma transição: a sobreposição é a duração dela.
    // Guardamos o índice do segmento onde a transição começa.
    const transitions = [];

    for (let i = 0; i < baseItems.length; i++) {
      const item = baseItems[i];

      if (item.timelineStart > cursor + TIME_EPSILON) {
        notifyOverall(Math.round((i / baseItems.length) * 70), 'Preenchendo o intervalo...');
        await addGap(item.timelineStart - cursor);
      } else if (i > 0 && cursor - item.timelineStart > TIME_EPSILON) {
        // Sobreposição = transição antes deste trecho
        transitions.push({
          beforeSegment: segments.length,
          duration: cursor - item.timelineStart,
          type: normalizeTransition(item.transition)
        });
      }

      notifyItem(item.id, 'processing', `Preparando ${i + 1} de ${baseItems.length}...`);
      notifyOverall(Math.round((i / baseItems.length) * 70), `Preparando trecho ${i + 1} de ${baseItems.length}...`);

      const mediaSize = await probeFrameSize(item.sourcePath);
      if (!mediaSize) throw new Error(`Não foi possível ler "${path.basename(item.sourcePath)}".`);
      const probe = item.kind === 'image' ? { hasAudio: false } : await probeBasics(item.sourcePath);

      const segmentPath = registerTemp(path.join(tempDir, `seg_${String(sequence++).padStart(4, '0')}.mp4`));
      await runCutCommand(
        buildNormalizedItem(item, segmentPath, frame, frame.fps, mediaSize, probe.hasAudio),
        itemDuration(item),
        (percent) => event.sender.send('cut-progress', { cutId: item.id, percent })
      );

      segments.push(segmentPath);
      notifyItem(item.id, 'success', 'Pronto');
      cursor = Math.max(cursor, itemEnd(item));
    }

    if (cursor < duration - TIME_EPSILON) await addGap(duration - cursor);

    if (segments.length === 0) throw new Error('A faixa de vídeo está vazia.');

    // Com transições, a faixa base é montada com xfade em vez de concatenação
    let basePath;
    if (transitions.length > 0) {
      notifyOverall(72, `Aplicando ${transitions.length} transição(ões)...`);
      basePath = registerTemp(path.join(tempDir, 'base_xfade.mp4'));
      await buildBaseWithTransitions(segments, transitions, basePath, frame, tempDir, registerTemp);
    } else if (segments.length > 1) {
      // Todos os segmentos nasceram com os mesmos parâmetros, então a junção é
      // instantânea. A verificação continua aqui como rede de segurança.
      notifyOverall(72, 'Montando a faixa principal...');
      basePath = registerTemp(path.join(tempDir, 'base.mp4'));
      if (await canConcatByDemux(segments)) {
        await performConcatDemux(segments, basePath, () => {});
      } else {
        console.warn('Segmentos da faixa base não casaram; transcodificando a junção.');
        const probes = await Promise.all(segments.map(probeBasics));
        await performComplexConcat(segments, probes, basePath, () => {}, { ...frame, fit: 'contain' });
      }
    } else {
      basePath = segments[0];
    }

    // A transição consome tempo dos dois lados, então a duração real da
    // montagem é a do arquivo — e não a soma das posições.
    const baseProbe = await probeBasics(basePath);
    if (baseProbe.duration > 0) duration = baseProbe.duration;

    // ---------- Etapa 2: sobreposições e áudio ----------
    //
    // Com recorte pedido, a composição vai para um temporário: o que o usuário
    // recebe são os pedaços, não a montagem inteira.
    const pedacos = Array.isArray(split) && split.length > 0 ? split : null;
    const outputPath = pedacos
      ? registerTemp(path.join(tempDir, 'montagem_completa.mp4'))
      : uniquePath(outputDir, `${safeBase}.mp4`);

    const textChain = buildTextChain(texts, frame, tempDir, registerTemp);

    if (overlayItems.length === 0 && audioItems.length === 0) {
      if (textChain) {
        // Sem camadas para compor, o texto ganha uma passagem só dele. O áudio
        // é copiado: gravar legenda não é motivo para recodificar o som.
        notifyOverall(90, 'Gravando os textos...');
        await new Promise((resolve, reject) => {
          ffmpeg(basePath)
            .outputOptions([
              '-vf', textChain,
              '-c:v libx264', '-preset veryfast', '-crf 20', '-pix_fmt yuv420p',
              `-r ${frame.fps}`, '-c:a copy', '-movflags +faststart'
            ])
            .output(outputPath)
            .on('start', (cmd) => console.log('Textos FFmpeg:', cmd))
            .on('end', resolve)
            .on('error', reject)
            .run();
        });
      } else {
        notifyOverall(95, 'Finalizando...');
        fs.copyFileSync(basePath, outputPath);
      }
      if (pedacos) {
        const partes = await recortarMontagem(outputPath, pedacos, outputDir, safeBase, notifyItem, notifyOverall);
        return { outputDir, duration, frame, method: 'base', parts: partes };
      }
      notifyOverall(100, 'Montagem concluída.');
      return { path: outputPath, outputDir, duration, frame, method: 'base' };
    }

    notifyOverall(75, 'Compondo sobreposições e áudio...');

    // Sobreposições e trilhas entram todas de uma vez, no passe final — não há
    // um "cortar item por item" para elas. Sem avisar aqui, a linha delas
    // ficava em "Aguardando..." mesmo depois da exportação terminar.
    [...overlayItems, ...audioItems].forEach((item) => {
      notifyItem(item.id, 'processing', 'Compondo...');
    });

    let command = ffmpeg(basePath);
    let inputIndex = 1;

    const overlays = [];
    for (const item of overlayItems) {
      const mediaSize = await probeFrameSize(item.sourcePath);
      if (!mediaSize) {
        console.warn('Sobreposição ignorada (dimensões ilegíveis):', item.sourcePath);
        continue;
      }
      const framing = normalizeFraming(item.framing);
      const adjust = normalizeAdjust(item);
      // Girar em 90° troca os lados, e é o lado NOVO que precisa caber no quadro
      const quarter = adjust.rotate === 90 || adjust.rotate === 270;
      const effectiveSize = quarter
        ? { width: mediaSize.height, height: mediaSize.width }
        : mediaSize;
      const layout = computeMediaLayout(effectiveSize, frame, framing);

      let hasAudio = false;
      if (item.kind === 'image') {
        command = command.input(item.sourcePath)
          .inputOptions(['-loop 1', `-framerate ${frame.fps}`, `-t ${itemDuration(item).toFixed(3)}`]);
      } else {
        hasAudio = (await probeBasics(item.sourcePath)).hasAudio;
        command = command.input(item.sourcePath)
          .inputOptions([`-ss ${item.sourceStart.toFixed(3)}`, `-t ${sourceSpan(item).toFixed(3)}`]);
      }
      overlays.push({ item, layout, effectiveSize, hasAudio, inputIndex: inputIndex++ });
    }

    const audios = [];
    for (const item of audioItems) {
      command = command.input(item.sourcePath)
        .inputOptions([`-ss ${item.sourceStart.toFixed(3)}`, `-t ${sourceSpan(item).toFixed(3)}`]);
      audios.push({ item, inputIndex: inputIndex++ });
    }

    const { graph, videoMap, audioMap } = buildCompositionGraph(overlays, audios, frame, duration, textChain);

    await new Promise((resolve, reject) => {
      command
        .complexFilter(graph)
        .outputOptions([
          `-map ${videoMap}`,
          `-map ${audioMap}`,
          `-t ${duration.toFixed(3)}`,
          '-c:v libx264', '-preset veryfast', '-crf 20', '-pix_fmt yuv420p',
          `-r ${frame.fps}`, ...AUDIO_ENCODE, '-movflags +faststart'
        ])
        .output(outputPath)
        .on('start', (cmd) => console.log('Composição FFmpeg:', cmd))
        .on('progress', (progress) => {
          if (progress.timemark) {
            const parts = progress.timemark.split(':');
            const elapsed = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
            notifyOverall(75 + Math.min(24, Math.round((elapsed / duration) * 24)), 'Compondo...');
          }
        })
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    [...overlayItems, ...audioItems].forEach((item) => {
      notifyItem(item.id, 'success', 'Pronto');
    });
    if (pedacos) {
      const partes = await recortarMontagem(outputPath, pedacos, outputDir, safeBase, notifyItem, notifyOverall);
      return {
        outputDir, duration, frame, method: 'composite',
        overlays: overlays.length, audioTracks: audios.length, parts: partes
      };
    }

    notifyOverall(100, 'Montagem concluída.');
    return {
      path: outputPath, outputDir, duration, frame,
      method: 'composite',
      overlays: overlays.length,
      audioTracks: audios.length
    };
  } finally {
    temps.forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });
    try { fs.rmdirSync(tempDir); } catch (e) {}
  }
}

// Recorta a montagem JÁ COMPOSTA em um arquivo por trecho.
//
// É por aqui que "arquivos separados" passa a incluir as faixas de cima, as
// trilhas de áudio e os textos: o corte acontece DEPOIS da composição, sobre o
// vídeo pronto, em vez de voltar às mídias originais e enxergar só a faixa base.
//
// Os limites vêm da linha do tempo e valem direto no arquivo composto: a
// montagem exportada tem exatamente a duração da linha do tempo, inclusive com
// transições, que consomem tempo dos dois lados da emenda.
async function recortarMontagem(composedPath, pedacos, outputDir, safeBase, notifyItem, notifyOverall) {
  const partes = [];

  for (let i = 0; i < pedacos.length; i++) {
    const pedaco = pedacos[i];
    const inicio = Math.max(0, Number(pedaco.start) || 0);
    const fim = Math.max(inicio + 0.05, Number(pedaco.end) || 0);

    notifyItem(pedaco.id, 'processing', `Separando ${i + 1} de ${pedacos.length}...`);
    notifyOverall(
      80 + Math.round((i / pedacos.length) * 19),
      `Separando o trecho ${i + 1} de ${pedacos.length}...`
    );

    const nome = sanitizeFileName(pedaco.name) || `${safeBase}_${i + 1}`;
    const destino = uniquePath(outputDir, `${nome}.mp4`);

    try {
      // Sem formato: a montagem composta já saiu no tamanho final
      await runCutCommand(buildPreciseCut(composedPath, destino, inicio, fim), fim - inicio, () => {});
      partes.push({ id: pedaco.id, path: destino, success: true });
      notifyItem(pedaco.id, 'success', 'Pronto');
    } catch (err) {
      partes.push({ id: pedaco.id, path: destino, success: false, error: err.message });
      notifyItem(pedaco.id, 'error', err.message);
    }
  }

  notifyOverall(100, 'Trechos separados.');
  return partes;
}

// --- Saída A: um arquivo por clipe ---
async function exportSeparate(event, clips, outputDir, safeBase, cutMode, notifyClip, notifyOverall, format) {
  const results = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    // Foto sempre sai como vídeo .mp4; para vídeo, preserva o container de origem
    // (a menos que o formato force a recodificação, que já produz H.264/AAC).
    const ext = clip.kind === 'image' ? '.mp4' : (path.extname(clip.sourcePath) || '.mp4');
    const outputPath = uniquePath(outputDir, `${safeBase}_${i + 1}${ext}`);
    const verb = clip.kind === 'image' ? 'Gerando' : 'Cortando';

    notifyClip(clip.id, 'processing', `${verb} ${i + 1} de ${clips.length}...`);
    notifyOverall(Math.round((i / clips.length) * 100), `${verb} trecho ${i + 1} de ${clips.length}...`);

    try {
      const info = await renderClip(clip, outputPath, (percent) => {
        event.sender.send('cut-progress', { cutId: clip.id, percent });
      }, cutMode, format);

      results.push({ id: clip.id, success: true, path: outputPath, ...info });
      notifyClip(clip.id, 'success',
        clip.kind === 'image' ? 'Concluído!' : describeDrift(info.actualStart - clip.start));
    } catch (err) {
      console.error(`Erro no clipe ${clip.id}:`, err);
      results.push({ id: clip.id, success: false, error: err.message });
      notifyClip(clip.id, 'error', `Falha: ${err.message}`);
    }
  }

  notifyOverall(100, 'Todos os cortes concluídos.');
  return { joinMode: 'separate', results, outputDir };
}

// --- Saída B: um único vídeo com todos os clipes na ordem da sequência ---
// Estratégia: corta cada clipe para um arquivo temporário e depois concatena.
// Tenta o concat demuxer (instantâneo, sem perda); se os parâmetros não casarem
// (fontes diferentes, resoluções diferentes), cai no filter_complex que padroniza tudo.
async function exportMerged(event, clips, outputDir, safeBase, cutMode, notifyClip, notifyOverall, format) {
  const tempDir = path.join(app.getPath('temp'), `cutting_seq_${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const segmentPaths = [];
  const results = [];

  try {
    // Quadro das fotos: sem formato pedido, elas precisam nascer no mesmo
    // tamanho que os vídeos da sequência — senão o fundo escolhido sairia no
    // tamanho da foto e o concat acrescentaria tarjas por fora dele. Deduzimos
    // dos vídeos ANTES de cortar, já que depois seria tarde.
    const imageFrame = format || await resolveImageFrame(clips);

    // Fase 1: gerar cada trecho (85% da barra geral)
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      // Com formato definido, todo trecho é recodificado para o mesmo alvo —
      // usar .mp4 em todos faz os segmentos ficarem idênticos em container e
      // parâmetros, o que habilita a junção instantânea logo adiante. Sem isso,
      // misturar .mkv com .mp4 forçaria um segundo passe de recodificação.
      const ext = (format || clip.kind === 'image')
        ? '.mp4'
        : (path.extname(clip.sourcePath) || '.mp4');
      const segmentPath = path.join(tempDir, `seg_${String(i).padStart(4, '0')}${ext}`);
      const verb = clip.kind === 'image' ? 'Gerando' : 'Cortando';

      notifyClip(clip.id, 'processing', `${verb} ${i + 1} de ${clips.length}...`);
      notifyOverall(
        Math.round((i / clips.length) * 85),
        `${verb} trecho ${i + 1} de ${clips.length}...`
      );

      const info = await renderClip(clip, segmentPath, (percent) => {
        event.sender.send('cut-progress', { cutId: clip.id, percent });
      }, cutMode, format, imageFrame);

      segmentPaths.push(segmentPath);
      results.push({ id: clip.id, success: true, ...info });
      notifyClip(clip.id, 'success',
        clip.kind === 'image' ? 'Concluído!' : describeDrift(info.actualStart - clip.start));
    }

    // Fase 2: juntar tudo (15% restantes)
    const outputPath = uniquePath(outputDir, `${safeBase}.mp4`);
    let method = 'demux';

    notifyOverall(85, 'Juntando os clipes em um único vídeo...');

    // Só tenta a junção sem perda se os trechos forem realmente compatíveis
    const compatible = await canConcatByDemux(segmentPaths);

    try {
      if (!compatible) {
        throw new Error('Trechos com formatos/resoluções diferentes');
      }
      await performConcatDemux(segmentPaths, outputPath, (percent) => {
        notifyOverall(85 + Math.round(percent * 0.15), 'Juntando os clipes (modo rápido)...');
      });
    } catch (demuxErr) {
      console.log('Junção sem perda indisponível, transcodificando...', demuxErr.message);
      notifyOverall(85, 'Padronizando formatos e juntando (pode demorar)...');

      const probes = await Promise.all(segmentPaths.map(probeBasics));
      const target = await resolveConcatTarget(segmentPaths, format);
      await performComplexConcat(segmentPaths, probes, outputPath, (percent) => {
        notifyOverall(85 + Math.round(percent * 0.15), 'Juntando os clipes (transcodificando)...');
      }, target);
      method = 'transcode';
    }

    notifyOverall(100, 'Vídeo único gerado com sucesso.');
    return { joinMode: 'merged', results, path: outputPath, method, outputDir };
  } catch (err) {
    console.error('Erro na exportação mesclada:', err);
    notifyOverall(100, `Falha: ${err.message}`);
    throw err;
  } finally {
    // Limpa os segmentos temporários
    try {
      segmentPaths.forEach((p) => { try { fs.unlinkSync(p); } catch (e) {} });
      fs.rmdirSync(tempDir);
    } catch (e) {
      console.warn('Não foi possível limpar a pasta temporária da sequência:', e.message);
    }
  }
}

// Presença de áudio e duração — os dois dados que a junção precisa de cada
// trecho. A duração importa porque o silêncio gerado para trechos mudos tem
// que ter fim: uma fonte de áudio infinita trava o filtro concat.
function probeBasics(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return resolve({ hasAudio: false, duration: 0 });
      resolve({
        hasAudio: metadata.streams.some((s) => s.codec_type === 'audio'),
        duration: Number(metadata.format && metadata.format.duration) || 0
      });
    });
  });
}

// Assinatura dos parâmetros que o concat demuxer exige idênticos entre os arquivos.
function concatSignature(filePath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return resolve(null);
      const v = metadata.streams.find((s) => s.codec_type === 'video');
      const a = metadata.streams.find((s) => s.codec_type === 'audio');
      if (!v) return resolve(null);
      resolve([
        v.codec_name, v.width, v.height, v.pix_fmt,
        a ? a.codec_name : 'none',
        a ? a.sample_rate : 0,
        a ? a.channels : 0
      ].join('|'));
    });
  });
}

// O concat demuxer NÃO valida compatibilidade: se as resoluções diferem, ele
// "conclui com sucesso" e gera um arquivo quebrado (só o primeiro trecho é
// exibido corretamente). Então verificamos ANTES, em vez de confiar no erro.
// Todos os arquivos já estão exatamente na resolução alvo?
async function allMatchFormat(filePaths, format) {
  const sizes = await Promise.all(filePaths.map((p) => new Promise((resolve) => {
    ffmpeg.ffprobe(p, (err, metadata) => {
      if (err) return resolve(null);
      const v = metadata.streams.find((s) => s.codec_type === 'video');
      resolve(v ? { width: v.width, height: v.height } : null);
    });
  })));
  return sizes.every((s) => s && s.width === format.width && s.height === format.height);
}

async function canConcatByDemux(filePaths) {
  if (filePaths.length < 2) return true;
  const signatures = await Promise.all(filePaths.map(concatSignature));
  if (signatures.some((s) => s === null)) return false;
  return signatures.every((s) => s === signatures[0]);
}

// 6c. Prévia do desvio do modo Rápido
//
// No modo sem perda o início "escorrega" para o keyframe anterior. Em gravações
// com GOP longo esse recuo pode ser de vários segundos — o usuário precisa saber
// disso ANTES de exportar, não descobrir olhando o arquivo depois.
ipcMain.handle('preview-fast-drift', async (event, clips) => {
  const report = [];
  for (const clip of clips) {
    try {
      const keyframe = await findKeyframeAtOrBefore(clip.sourcePath, clip.start);
      const actualStart = keyframe === null ? clip.start : keyframe;
      report.push({
        id: clip.id,
        requestedStart: clip.start,
        actualStart,
        drift: actualStart - clip.start
      });
    } catch (err) {
      report.push({ id: clip.id, requestedStart: clip.start, actualStart: clip.start, drift: 0 });
    }
  }
  return report;
});


// ==========================================================================
// TÍTULOS E LEGENDAS
//
// O texto é gravado no vídeo pelo filtro `drawtext`. O conteúdo vai por
// ARQUIVO (`textfile=`), não inline: assim acento, dois-pontos, aspas, vírgula
// e quebra de linha entram como o usuário escreveu, sem uma camada de escapes
// que sempre acaba deixando passar algum caso.
//
// Posição e tamanho vêm em FRAÇÃO do quadro, então o mesmo texto sai igual em
// 1080p, em 4K ou num vídeo vertical.
// ==========================================================================

// O drawtext precisa de um arquivo de fonte. A Arial existe em toda instalação
// do Windows; as alternativas cobrem quem tiver uma instalação enxugada.
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/arial.ttf',
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/calibri.ttf',
  'C:/Windows/Fonts/tahoma.ttf'
];

let cachedFontPath;

function resolveFontPath(bold) {
  if (cachedFontPath === undefined) {
    cachedFontPath = FONT_CANDIDATES.find((p) => fs.existsSync(p)) || null;
  }
  if (!cachedFontPath) return null;
  // Negrito só troca de arquivo se o par existir na máquina
  if (!bold && cachedFontPath.endsWith('arialbd.ttf') && fs.existsSync('C:/Windows/Fonts/arial.ttf')) {
    return 'C:/Windows/Fonts/arial.ttf';
  }
  if (bold && fs.existsSync('C:/Windows/Fonts/arialbd.ttf')) return 'C:/Windows/Fonts/arialbd.ttf';
  return cachedFontPath;
}

// Num filtro, `:` separa opções e `\` escapa — um caminho do Windows tem os
// dois. Estes são os únicos escapes necessários porque o TEXTO vai por arquivo.
const escapeFilterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');

const hexToDrawtext = (hex, opacity) => {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex.slice(1) : 'ffffff';
  const alpha = clampNumber(Number(opacity === undefined ? 1 : opacity), 0, 1);
  return `0x${clean}@${alpha.toFixed(3)}`;
};

// Monta a cadeia de drawtext de todos os textos visíveis. Devolve '' quando não
// há texto nenhum, para o grafo não ganhar um filtro à toa.
function buildTextChain(texts, frame, tempDir, registerTemp) {
  if (!texts || texts.length === 0) return '';

  const font = resolveFontPath(false);
  if (!font) {
    console.warn('Nenhuma fonte encontrada para o drawtext; os textos serão ignorados.');
    return '';
  }

  return texts.map((text, index) => {
    const content = String(text.content || '').trim();
    if (!content) return null;

    const file = path.join(tempDir, `texto_${index}.txt`);
    fs.writeFileSync(file, content, 'utf8');
    registerTemp(file);

    const fontFile = escapeFilterPath(resolveFontPath(!!text.bold) || font);
    const size = Math.max(8, Math.round(clampNumber(Number(text.size) || 0.08, 0.01, 0.5) * frame.height));

    // x/y são o CENTRO do texto, em fração do quadro. Centralizar pela largura
    // real (text_w) é o que mantém o alinhamento com qualquer quantidade de
    // letras — sem isso, mudar uma palavra deslocaria o título inteiro.
    const x = clampNumber(Number(text.x) === undefined ? 0.5 : Number(text.x), 0, 1);
    const y = clampNumber(Number(text.y) === undefined ? 0.5 : Number(text.y), 0, 1);

    const options = [
      `fontfile='${fontFile}'`,
      `textfile='${escapeFilterPath(file)}'`,
      `fontsize=${size}`,
      `fontcolor=${hexToDrawtext(text.color, 1)}`,
      `x=(w*${x.toFixed(4)})-(text_w/2)`,
      `y=(h*${y.toFixed(4)})-(text_h/2)`,
      'line_spacing=6',
      // Sem isto, o drawtext tenta EXPANDIR o texto: um '%' é lido como início
      // de código de formatação e o título inteiro some do vídeo, sem erro
      // nenhum. Texto de usuário tem que sair exatamente como foi escrito.
      'expansion=none'
    ];

    if (text.background) {
      options.push('box=1');
      options.push(`boxcolor=${hexToDrawtext(text.backgroundColor, text.backgroundOpacity)}`);
      options.push(`boxborderw=${Math.max(2, Math.round(size * 0.28))}`);
    }
    if (text.outline) {
      options.push(`borderw=${Math.max(1, Math.round(size * 0.06))}`);
      options.push('bordercolor=0x000000@0.85');
    }

    const start = Math.max(0, Number(text.timelineStart) || 0);
    const end = start + Math.max(0.1, Number(text.duration) || 3);
    options.push(`enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`);

    return `drawtext=${options.join(':')}`;
  }).filter(Boolean).join(',');
}

// ==========================================================================
// ONDA SONORA
//
// Para desenhar a onda no bloco basta a ENVOLTÓRIA, não o áudio inteiro. O
// ffmpeg entrega PCM já rebaixado para 2 kHz mono, e daí saem os picos por
// balde. Assim uma música de 5 minutos vira ~600 KB de leitura em vez de
// dezenas de MB, e o resultado cabe no arquivo de projeto.
// ==========================================================================

const PEAK_SAMPLE_RATE = 2000;
const PEAK_BUCKETS = 1200;

ipcMain.handle('get-audio-peaks', (event, filePath) => new Promise((resolve) => {
  const chunks = [];
  let total = 0;
  // Teto de memória: 2 kHz mono 16 bits = 4 KB/s, ou seja ~2h de áudio.
  const MAX_BYTES = 32 * 1024 * 1024;

  const child = spawn(ffmpegBinary, [
    '-v', 'error', '-i', filePath,
    '-ac', '1', '-ar', String(PEAK_SAMPLE_RATE),
    '-map', '0:a:0', '-f', 's16le', '-'
  ]);

  child.stdout.on('data', (chunk) => {
    if (total >= MAX_BYTES) return;
    chunks.push(chunk);
    total += chunk.length;
  });

  child.on('error', () => resolve(null));
  child.on('close', () => {
    if (total === 0) return resolve(null);   // mídia sem áudio

    const pcm = Buffer.concat(chunks, total);
    const samples = Math.floor(pcm.length / 2);
    const buckets = Math.min(PEAK_BUCKETS, Math.max(1, samples));
    const perBucket = samples / buckets;
    const peaks = new Array(buckets);

    for (let b = 0; b < buckets; b++) {
      const from = Math.floor(b * perBucket);
      const to = Math.min(samples, Math.floor((b + 1) * perBucket));
      let peak = 0;
      for (let i = from; i < to; i++) {
        const value = Math.abs(pcm.readInt16LE(i * 2));
        if (value > peak) peak = value;
      }
      // 0–100 em inteiro: o desenho não precisa de mais precisão, e o
      // projeto salvo fica muito menor do que com casas decimais.
      peaks[b] = Math.round((peak / 32768) * 100);
    }
    resolve(peaks);
  });
}));

// ==========================================================================
// PROJETO (.cutting)
//
// O arquivo guarda a MONTAGEM, não as mídias: só os caminhos delas. É a
// diferença entre um arquivo de alguns KB e um de vários GB — e é como todo
// editor faz. Em troca, mover ou apagar uma mídia quebra o projeto, então
// avisamos quais faltam na hora de abrir, em vez de abrir pela metade.
// ==========================================================================

const PROJECT_EXTENSION = 'cutting';
const PROJECT_FILTERS = [{ name: 'Projeto do Cutting', extensions: [PROJECT_EXTENSION] }];

// Recuperação automática: fica na pasta de dados do app, não junto do projeto.
// Assim ela sobrevive a um desligamento no meio do trabalho e não polui a
// pasta do usuário com arquivos temporários.
const autosavePath = () => path.join(app.getPath('userData'), 'recuperacao.cutting');

ipcMain.handle('project-save-dialog', async (event, suggestedName) => {
  const safe = sanitizeFileName(suggestedName) || 'projeto';
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Salvar projeto',
    defaultPath: `${safe}.${PROJECT_EXTENSION}`,
    filters: PROJECT_FILTERS
  });
  return result.canceled || !result.filePath ? null : result.filePath;
});

ipcMain.handle('project-open-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Abrir projeto',
    filters: PROJECT_FILTERS,
    properties: ['openFile']
  });
  return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
});

ipcMain.handle('project-write', (event, { filePath, data }) => {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('project-read', (event, filePath) => {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || data.app !== 'Cutting') {
      return { ok: false, error: 'Este arquivo não é um projeto do Cutting.' };
    }
    // Quais mídias ainda estão no lugar. Vai junto para o renderer poder
    // avisar em vez de descobrir só quando o vídeo não carregar.
    const missing = (data.document && data.document.sources ? data.document.sources : [])
      .filter((s) => !fs.existsSync(s.path))
      .map((s) => ({ name: s.name, path: s.path }));
    return { ok: true, path: filePath, data, missing };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Quais dos caminhos ainda existem. Usado pela lista de projetos recentes,
// que precisa saber o que ainda abre antes de o usuário clicar.
ipcMain.handle('files-exist', (event, paths) => {
  const mapa = {};
  (Array.isArray(paths) ? paths : []).forEach((p) => {
    try { mapa[p] = fs.existsSync(p); } catch (err) { mapa[p] = false; }
  });
  return mapa;
});

ipcMain.handle('project-autosave-write', (event, data) => {
  try {
    fs.writeFileSync(autosavePath(), JSON.stringify(data), 'utf8');
    return true;
  } catch (err) {
    console.warn('Salvamento automático falhou:', err.message);
    return false;
  }
});

ipcMain.handle('project-autosave-read', () => {
  try {
    const file = autosavePath();
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.app !== 'Cutting') return null;
    return { data, savedAt: data.savedAt || null, modifiedAt: fs.statSync(file).mtimeMs };
  } catch (err) {
    return null;
  }
});

ipcMain.handle('project-autosave-clear', () => {
  try {
    const file = autosavePath();
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (err) {
    return false;
  }
});

// 6b. Abrir a pasta de destino no explorador (conveniência pós-exportação)
ipcMain.handle('reveal-path', (event, targetPath) => {
  try {
    if (fs.existsSync(targetPath)) {
      const stat = fs.statSync(targetPath);
      if (stat.isDirectory()) shell.openPath(targetPath);
      else shell.showItemInFolder(targetPath);
      return true;
    }
  } catch (err) {
    console.warn('Não foi possível abrir o caminho:', err.message);
  }
  return false;
});

// Tolerância (em segundos) para considerar que um keyframe coincide com o ponto de início.
// ~1 frame a 25fps. Dentro disso o corte por cópia já é exato.
const KEYFRAME_EXACT_TOLERANCE = 0.042;

// Fotos viram vídeo parado: 30fps é suficiente para imagem estática e mantém o
// arquivo pequeno. Duração mínima para o trecho não sair vazio.
const IMAGE_CLIP_FPS = 30;
const IMAGE_MIN_DURATION = 0.1;

// Limites do zoom da foto dentro do quadro. 1 = a foto inteira encaixada;
// abaixo disso ela afasta e sobra fundo, acima disso ela transborda e é aparada.
const IMAGE_MIN_ZOOM = 0.1;
const IMAGE_MAX_ZOOM = 5;

const DEFAULT_FRAMING = { zoom: 1, offsetX: 0, offsetY: 0, background: { mode: 'color', color: '#000000' } };

// Lê os timestamps dos keyframes (frames I) dentro de uma janela do vídeo.
// Usamos -read_intervals para não varrer o arquivo inteiro (rápido mesmo em vídeos longos).
function getKeyframeTimes(inputPath, from, to) {
  return new Promise((resolve) => {
    if (!ffprobeBinary) return resolve([]);

    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-skip_frame', 'nokey',
      '-show_entries', 'frame=pts_time',
      '-read_intervals', `${Math.max(0, from).toFixed(3)}%${to.toFixed(3)}`,
      '-of', 'csv=p=0',
      '-i', inputPath
    ];

    execFile(ffprobeBinary, args, { maxBuffer: 1 << 26 }, (err, stdout) => {
      if (err) {
        console.warn('Não foi possível listar keyframes:', err.message);
        return resolve([]);
      }
      const times = String(stdout)
        .split('\n')
        .map((line) => parseFloat(line))
        .filter((n) => !isNaN(n))
        .sort((a, b) => a - b);
      resolve(times);
    });
  });
}

// Encontra o último keyframe em (ou antes de) `start`.
// Expande a janela de busca progressivamente para não varrer o arquivo todo sem necessidade.
async function findKeyframeAtOrBefore(inputPath, start) {
  if (start <= KEYFRAME_EXACT_TOLERANCE) return 0; // o primeiro frame é sempre keyframe

  for (const back of [2, 15, 60, Infinity]) {
    const from = back === Infinity ? 0 : Math.max(0, start - back);
    const times = await getKeyframeTimes(inputPath, from, start + 0.5);
    const candidates = times.filter((t) => t <= start + KEYFRAME_EXACT_TOLERANCE);
    if (candidates.length > 0) return candidates[candidates.length - 1];
    if (from === 0) break; // já varremos desde o começo, não há mais o que buscar
  }
  return null;
}

// Executa um comando ffmpeg reportando progresso relativo à duração esperada do corte.
function runCutCommand(command, expectedDuration, onProgress) {
  return new Promise((resolve, reject) => {
    command
      .on('start', (cmd) => console.log('Comando FFmpeg executado:', cmd))
      .on('progress', (progress) => {
        if (progress.timemark) {
          const parts = progress.timemark.split(':');
          const elapsed = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
          const percent = Math.min(Math.round((elapsed / expectedDuration) * 100), 99);
          onProgress(percent);
        }
      })
      .on('end', () => {
        onProgress(100);
        resolve();
      })
      .on('error', reject)
      .run();
  });
}

// Corte SEM PERDA por cópia de streams. Só pode começar em um keyframe:
// por isso recebemos `copyStart` (o keyframe) que pode ser anterior ao início pedido.
//
// ATENÇÃO: NÃO adicionar '-avoid_negative_ts make_zero' aqui. Combinado com o
// `-ss` de entrada, ele quebrava o `-t` no build antigo de 2018: o corte saía
// muito mais longo do que o pedido e arrastava conteúdo anterior ao início.
// O ffmpeg embutido hoje é o 6.1.1 e não tem mais esse defeito, mas a opção
// continua dispensável: como buscamos um keyframe exato, o primeiro PTS já sai
// em zero. Fica registrado para ninguém "consertar" reintroduzindo.
function buildCopyCut(inputPath, outputPath, copyStart, end) {
  return ffmpeg(inputPath)
    .inputOptions([`-ss ${copyStart.toFixed(3)}`])
    .outputOptions([
      `-t ${(end - copyStart).toFixed(3)}`,
      '-map 0:v:0',
      '-map 0:a?',
      '-c copy'
    ])
    .output(outputPath);
}

// Corte PRECISO (frame a frame) recodificando o trecho.
// `-ss` antes do `-i` faz seek rápido E preciso no FFmpeg moderno: ele decodifica
// a partir do keyframe anterior e descarta os frames antes do ponto pedido.
function buildPreciseCut(inputPath, outputPath, start, end, format = null) {
  const options = [
    `-t ${(end - start).toFixed(3)}`,
    '-map 0:v:0',
    '-map 0:a?',
    '-c:v libx264',
    '-preset veryfast',
    '-crf 18',
    '-pix_fmt yuv420p',
    '-c:a aac',
    '-b:a 192k'
  ];

  if (format) {
    options.push(`-vf ${buildScaleFilter(format)}`);
  }

  if (path.extname(outputPath).toLowerCase() === '.mp4') {
    options.push('-movflags +faststart');
  }

  return ffmpeg(inputPath)
    .inputOptions([`-ss ${start.toFixed(3)}`])
    .outputOptions(options)
    .output(outputPath);
}

// Corte de vídeo com ENQUADRAMENTO: recompõe a imagem sobre um fundo, do mesmo
// jeito que a foto. Sempre recodifica — não existe cópia de streams que
// reposicione a imagem.
function buildFramedCut(inputPath, outputPath, start, end, { frame, framing, mediaSize, hasAudio }) {
  const layout = computeMediaLayout(mediaSize, frame, framing);

  const options = [
    `-t ${(end - start).toFixed(3)}`,
    '-c:v libx264',
    '-preset veryfast',
    '-crf 18',
    '-pix_fmt yuv420p'
  ];

  if (hasAudio) options.push('-c:a aac', '-b:a 192k');

  if (path.extname(outputPath).toLowerCase() === '.mp4') {
    options.push('-movflags +faststart');
  }

  const command = ffmpeg(inputPath)
    .inputOptions([`-ss ${start.toFixed(3)}`])
    .complexFilter(buildMediaComposite(frame, layout, framing.background, hasAudio ? '0:a' : null))
    .map('[v]');

  if (hasAudio) command.map('[a]');

  return command.outputOptions(options).output(outputPath);
}

// Uma FOTO vira um trecho de vídeo parado, com a duração escolhida.
//
// O áudio silencioso não é capricho: sem faixa de áudio, juntar a foto com
// trechos que têm som exige remendo na hora da concatenação. Gerando o silêncio
// aqui, a foto fica indistinguível de um vídeo comum daí para frente.
function buildImageClip(inputPath, outputPath, duration, options_ = {}) {
  const { format = null, framing = null, imageSize = null, fps = IMAGE_CLIP_FPS } = options_;
  const frame = normalizeFraming(framing);

  const encoding = [
    `-t ${duration.toFixed(3)}`,
    '-c:v libx264',
    '-preset veryfast',
    '-crf 18',
    '-pix_fmt yuv420p',
    `-r ${fps}`,
    '-c:a aac',
    '-b:a 192k',
    '-shortest'
  ];

  if (path.extname(outputPath).toLowerCase() === '.mp4') {
    encoding.push('-movflags +faststart');
  }

  let command = ffmpeg()
    .input(inputPath)
    .inputOptions(['-loop 1', `-framerate ${fps}`])
    .input('anullsrc=channel_layout=stereo:sample_rate=44100')
    .inputOptions(['-f lavfi']);

  // Caminho composto: precisa do tamanho da foto para calcular a geometria.
  // Sem quadro de saída conhecido, o próprio tamanho da foto é o quadro — o
  // que faz o zoom e o fundo continuarem valendo mesmo exportando "Original".
  const outputFrame = format
    ? { width: format.width, height: format.height }
    : (imageSize ? { width: evenRound(imageSize.width), height: evenRound(imageSize.height) } : null);

  if (imageSize && outputFrame && !isDefaultFraming(frame)) {
    const layout = computeMediaLayout(imageSize, outputFrame, frame);
    return command
      // '1:a' é o anullsrc: a foto é a entrada 0 e o silêncio a entrada 1
      .complexFilter(buildMediaComposite(outputFrame, layout, frame.background, '1:a'))
      .map('[v]')
      .map('[a]')
      .outputOptions(encoding)
      .output(outputPath);
  }

  // Caminho simples: sem enquadramento personalizado, um -vf resolve
  const filter = format
    ? buildScaleFilter(format)
    // Sem formato definido, ainda é preciso garantir dimensões pares para o
    // yuv420p — fotos vêm em qualquer tamanho, inclusive ímpar.
    : 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1';

  return command
    .outputOptions([
      // Mapeamento explícito: a foto é a entrada 0 e o silêncio a entrada 1.
      // Deixar o ffmpeg escolher sozinho funciona, mas depende da heurística dele.
      '-map 0:v:0',
      '-map 1:a:0',
      `-vf ${filter}`,
      ...encoding
    ])
    .output(outputPath);
}

/**
 * Corta um trecho do vídeo.
 *
 * mode = 'precise' (padrão): o início é respeitado exatamente. Usa cópia sem perda
 *   quando o ponto de início já cai sobre um keyframe; senão recodifica o trecho.
 * mode = 'fast': sempre cópia sem perda, mas o início "escorrega" para o keyframe
 *   anterior (limitação do stream copy). Retorna o início realmente usado.
 *
 * Retorna { actualStart, reencoded }.
 */
async function performCut(inputPath, outputPath, start, end, onProgress, mode = 'precise', format = null) {
  const duration = end - start;

  // Mudar a proporção obriga a recodificar — não existe cópia de streams que
  // redimensione. O modo Rápido é ignorado de propósito quando há formato: a
  // interface já desabilita a opção, e a garantia aqui evita que as duas
  // pontas discordem e o usuário receba um vídeo fora do formato pedido.
  if (format) {
    await runCutCommand(buildPreciseCut(inputPath, outputPath, start, end, format), duration, onProgress);
    return { actualStart: start, reencoded: true };
  }

  const keyframe = await findKeyframeAtOrBefore(inputPath, start);

  if (mode === 'fast') {
    const copyStart = keyframe !== null ? keyframe : start;
    await runCutCommand(buildCopyCut(inputPath, outputPath, copyStart, end), end - copyStart, onProgress);
    return { actualStart: copyStart, reencoded: false };
  }

  // Modo preciso: se o início já é um keyframe, a cópia sem perda também é exata.
  if (keyframe !== null && Math.abs(keyframe - start) <= KEYFRAME_EXACT_TOLERANCE) {
    try {
      await runCutCommand(buildCopyCut(inputPath, outputPath, keyframe, end), end - keyframe, onProgress);
      return { actualStart: keyframe, reencoded: false };
    } catch (err) {
      console.warn('Cópia sem perda falhou, recodificando o trecho...', err.message);
    }
  }

  await runCutCommand(buildPreciseCut(inputPath, outputPath, start, end), duration, onProgress);
  return { actualStart: start, reencoded: true };
}

/**
 * Gera o arquivo de UM item da sequência, seja ele vídeo ou foto.
 *
 * É o ponto único por onde todo item passa — quem chama não precisa saber de
 * qual tipo se trata. Um tipo novo (áudio, título, transição) entra aqui.
 */
async function renderClip(clip, outputPath, onProgress, cutMode, format, imageFrame = null) {
  if (clip.kind === 'image') {
    const duration = Math.max(IMAGE_MIN_DURATION, clip.end - clip.start);
    const framing = normalizeFraming(clip.framing);

    // Só consulta o tamanho da foto quando ele muda alguma coisa — enquadramento
    // padrão dispensa a consulta e o caminho composto.
    const imageSize = isDefaultFraming(framing) ? null : await probeFrameSize(clip.sourcePath);

    await runCutCommand(
      buildImageClip(clip.sourcePath, outputPath, duration, {
        format: format || imageFrame,
        framing,
        imageSize
      }),
      duration,
      onProgress
    );
    return { actualStart: 0, reencoded: true, kind: 'image' };
  }

  // Vídeo com enquadramento personalizado: recompor a imagem só é possível
  // recodificando, então o modo Rápido não se aplica (a interface já avisa).
  const framing = normalizeFraming(clip.framing);
  if (!isDefaultFraming(framing)) {
    const duration = clip.end - clip.start;
    const mediaSize = await probeFrameSize(clip.sourcePath);

    if (mediaSize) {
      const frame = format || imageFrame
        ? { width: (format || imageFrame).width, height: (format || imageFrame).height }
        : { width: evenRound(mediaSize.width), height: evenRound(mediaSize.height) };

      const probe = await probeBasics(clip.sourcePath);
      await runCutCommand(
        buildFramedCut(clip.sourcePath, outputPath, clip.start, clip.end, {
          frame, framing, mediaSize, hasAudio: probe.hasAudio
        }),
        duration,
        onProgress
      );
      return { actualStart: clip.start, reencoded: true, kind: 'video' };
    }
    console.warn('Não foi possível ler as dimensões de', clip.sourcePath, '— enquadramento ignorado.');
  }

  const info = await performCut(
    clip.sourcePath, outputPath, clip.start, clip.end, onProgress, cutMode, format
  );
  return { ...info, kind: 'video' };
}

// 7. Seleção de múltiplos vídeos para mesclar
ipcMain.handle('select-multiple-videos', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecione os Vídeos para Mesclar',
    filters: [
      { name: 'Vídeos', extensions: ['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'ts'] }
    ],
    properties: ['openFile', 'multiSelections']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths;
});

// 8. Mesclar vídeos
ipcMain.handle('merge-videos', async (event, { videoPaths, outputDir, baseName, format }) => {
  const safeBase = sanitizeFileName(baseName) || 'videos_mesclados';
  const outputPath = uniquePath(outputDir, `${safeBase}.mp4`);
  const requested = normalizeFormat(format);

  event.sender.send('merge-status', { status: 'processing', message: 'Verificando faixa de áudio dos vídeos...' });

  try {
    // 1. Presença de áudio e duração de cada vídeo
    const probes = await Promise.all(videoPaths.map(probeBasics));

    // 2. Concat Demuxer rápido — só se os arquivos forem de fato idênticos em
    //    codec/resolução/pix_fmt/áudio. O demuxer não valida isso sozinho e
    //    geraria um arquivo quebrado sem sinalizar erro.
    try {
      event.sender.send('merge-status', { status: 'processing', message: 'Verificando compatibilidade dos formatos...' });
      if (!(await canConcatByDemux(videoPaths))) {
        throw new Error('Vídeos com formatos/resoluções diferentes');
      }
      // Com formato pedido, a junção sem perda só serve se os vídeos JÁ
      // estiverem nele — do contrário sairia no formato errado, sem aviso.
      if (requested && !(await allMatchFormat(videoPaths, requested))) {
        throw new Error('Vídeos fora do formato de saída escolhido');
      }
      event.sender.send('merge-status', { status: 'processing', message: 'Mesclando sem perda de qualidade...' });
      await performConcatDemux(videoPaths, outputPath, (percent) => {
        event.sender.send('merge-progress', { percent });
      });
      event.sender.send('merge-status', { status: 'success', message: 'Concluído!' });
      return { success: true, path: outputPath, method: 'demux' };
    } catch (err) {
      console.log('Concat Demux falhou ou formatos são incompatíveis. Transcodificando...', err);
      event.sender.send('merge-status', { status: 'processing', message: 'Processando e transcodificando vídeos (pode demorar)...' });
      
      // 3. Fallback: Filter Complex Concat (mais lento, mas une qualquer formato e resolução)
      const target = await resolveConcatTarget(videoPaths, requested);
      event.sender.send('merge-status', {
        status: 'processing',
        message: `Padronizando para ${target.width}x${target.height} @ ${target.fps}fps...`
      });
      await performComplexConcat(videoPaths, probes, outputPath, (percent) => {
        event.sender.send('merge-progress', { percent });
      }, target);
      event.sender.send('merge-status', { status: 'success', message: 'Concluído!' });
      return { success: true, path: outputPath, method: 'transcode' };
    }
  } catch (globalErr) {
    console.error('Erro na mesclagem:', globalErr);
    event.sender.send('merge-status', { status: 'error', message: `Falha: ${globalErr.message}` });
    throw globalErr;
  }
});

// Helper Concat Demuxer
function performConcatDemux(videoPaths, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const tempDir = app.getPath('temp');
    const listFilePath = path.join(tempDir, `merge_list_${Date.now()}.txt`);
    
    // Formata os caminhos de arquivo para o FFmpeg demuxer
    const fileContent = videoPaths.map(p => `file '${p.replace(/'/g, "'\\''").replace(/\\/g, '/')}'`).join('\n');
    fs.writeFileSync(listFilePath, fileContent, 'utf8');

    ffmpeg(listFilePath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions('-c copy')
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent) {
          onProgress(Math.min(Math.round(progress.percent), 99));
        }
      })
      .on('end', () => {
        try { fs.unlinkSync(listFilePath); } catch (e) {}
        onProgress(100);
        resolve();
      })
      .on('error', (err) => {
        try { fs.unlinkSync(listFilePath); } catch (e) {}
        reject(err);
      })
      .run();
  });
}

// Descobre a MAIOR resolução e o MAIOR fps entre os arquivos, para não degradar
// material de alta qualidade ao padronizar (antes era fixo em 1280x720 / 30fps).
async function pickCommonTarget(videoPaths) {
  let width = 0;
  let height = 0;
  let fps = 0;

  for (const p of videoPaths) {
    const info = await new Promise((resolve) => {
      ffmpeg.ffprobe(p, (err, metadata) => {
        if (err) return resolve(null);
        const v = metadata.streams.find((s) => s.codec_type === 'video');
        if (!v) return resolve(null);
        let rate = 0;
        const rateStr = v.avg_frame_rate || v.r_frame_rate;
        if (rateStr && rateStr !== '0/0') {
          const [num, den] = rateStr.split('/').map(Number);
          if (num > 0 && den > 0) rate = num / den;
        }
        resolve({ width: v.width || 0, height: v.height || 0, fps: rate });
      });
    });
    if (!info) continue;
    if (info.width > width) width = info.width;
    if (info.height > height) height = info.height;
    if (info.fps > fps) fps = info.fps;
  }

  // Dimensões pares são obrigatórias para o yuv420p do libx264
  width = Math.max(2, Math.round((width || 1280) / 2) * 2);
  height = Math.max(2, Math.round((height || 720) / 2) * 2);
  fps = Math.min(Math.max(Math.round(fps || 30), 1), 120);

  // 'contain' ao padronizar por conta própria: quando o usuário não pediu um
  // formato, o app não tem o direito de descartar imagem por iniciativa própria.
  return { width, height, fps, fit: 'contain' };
}

// Alvo da junção: o formato escolhido manda; sem ele, deduz dos próprios
// arquivos. O fps vem sempre da dedução — o formato define enquadramento, não
// cadência, e forçar 30fps em material 60fps seria uma perda silenciosa.
// Quadro em que as fotos devem nascer numa sequência sem formato definido.
// Prioriza os vídeos: eles é que ditam a "tela" do resultado. Só de fotos,
// usa a maior delas.
async function resolveImageFrame(clips) {
  const videoPaths = [...new Set(
    clips.filter((c) => c.kind !== 'image').map((c) => c.sourcePath)
  )];
  if (videoPaths.length > 0) return pickCommonTarget(videoPaths);

  const photoPaths = [...new Set(clips.map((c) => c.sourcePath))];
  const sizes = (await Promise.all(photoPaths.map(probeImageSize))).filter(Boolean);
  if (sizes.length === 0) return null;

  return {
    width: evenRound(Math.max(...sizes.map((s) => s.width))),
    height: evenRound(Math.max(...sizes.map((s) => s.height))),
    fps: IMAGE_CLIP_FPS,
    fit: 'contain'
  };
}

async function resolveConcatTarget(filePaths, format) {
  const detected = await pickCommonTarget(filePaths);
  if (!format) return detected;
  return { width: format.width, height: format.height, fps: detected.fps, fit: format.fit };
}

// Helper Filter Complex Concat
function performComplexConcat(videoPaths, probes, outputPath, onProgress, target) {
  return new Promise((resolve, reject) => {
    const resolved = target || { width: 1280, height: 720, fps: 30, fit: 'contain' };
    const { fps } = resolved;
    let command = ffmpeg();

    videoPaths.forEach(p => {
      command = command.input(p);
    });

    let filterString = '';
    // Redimensionamento uniforme e ajuste de framerate para evitar descompassos.
    // O enquadramento (tarjas ou corte) vem do alvo — nunca estica a imagem.
    const scaleChain = buildScaleFilter(resolved);
    videoPaths.forEach((_, index) => {
      filterString += `[${index}:v]${scaleChain},fps=${fps}[v${index}];`;
    });

    // Todo trecho precisa de faixa de áudio para o concat casar vídeo com som.
    // Para os mudos, geramos silêncio COM DURAÇÃO: sem o `d=`, a fonte é
    // infinita e o filtro concat nunca alcança o fim daquele trecho.
    videoPaths.forEach((_, index) => {
      const probe = probes[index] || { hasAudio: false, duration: 0 };
      if (probe.hasAudio) {
        filterString += `[${index}:a]aresample=44100[a${index}];`;
      } else {
        const silence = Math.max(0.05, probe.duration || 0);
        filterString += `aevalsrc=0:s=44100:d=${silence.toFixed(3)}[a${index}];`;
      }
    });

    // Concatena tudo
    videoPaths.forEach((_, index) => {
      filterString += `[v${index}][a${index}]`;
    });
    
    filterString += `concat=n=${videoPaths.length}:v=1:a=1[v][a]`;

    command
      .complexFilter(filterString)
      .map('[v]')
      .map('[a]')
      .outputOptions([
        '-c:v libx264',
        '-preset fast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-ar 44100'
      ])
      .output(outputPath)
      .on('progress', (progress) => {
        if (progress.percent) {
          onProgress(Math.min(Math.round(progress.percent), 99));
        } else {
          onProgress(50); // Fallback parcial
        }
      })
      .on('end', () => {
        onProgress(100);
        resolve();
      })
      .on('error', (err) => {
        reject(err);
      })
      .run();
  });
}
