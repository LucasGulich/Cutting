const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Caminho real de um arquivo vindo de drag & drop.
// File.path foi descontinuado no Electron; webUtils é o caminho suportado.
function getDroppedFilePath(file) {
  try {
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      return webUtils.getPathForFile(file);
    }
  } catch (err) {
    // cai no fallback abaixo
  }
  return file && file.path ? file.path : null;
}

// Helper: registra um listener e devolve a função que o remove.
// Evita repetição e garante que nenhuma subscrição fique vazando entre exportações.
function subscribe(channel) {
  return (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on(channel, subscription);
    return () => ipcRenderer.removeListener(channel, subscription);
  };
}

contextBridge.exposeInMainWorld('api', {
  // --- Drag & drop ---
  getDroppedFilePath,

  // --- Seleção de arquivos e pastas ---
  selectVideo: () => ipcRenderer.invoke('select-video'),
  selectMultipleVideos: () => ipcRenderer.invoke('select-multiple-videos'),
  selectImages: () => ipcRenderer.invoke('select-images'),
  selectAudio: () => ipcRenderer.invoke('select-audio'),
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),

  // --- Análise e preview ---
  getVideoMetadata: (filePath) => ipcRenderer.invoke('get-video-metadata', filePath),
  createPreview: (filePath) => ipcRenderer.invoke('create-preview', filePath),
  getImageAverageColor: (filePath) => ipcRenderer.invoke('get-image-average-color', filePath),

  // Envoltória do áudio para desenhar a onda: 1200 picos (0–100) cobrindo a
  // mídia inteira. Devolve null quando não há faixa de áudio.
  getAudioPeaks: (filePath) => ipcRenderer.invoke('get-audio-peaks', filePath),

  // --- Só áudio ---
  // Converte a mídia (ou o trecho start–end, em segundos da fonte) para um
  // arquivo de áudio escolhido pelo usuário. → { ok, path } | { ok:false, canceled } | { ok:false, error }
  extractAudio: ({ sourcePath, start, end, suggestedName }) =>
    ipcRenderer.invoke('extract-audio', { sourcePath, start, end, suggestedName }),

  // Exporta a linha do tempo como arquivo só de áudio. Mesmo payload do
  // exportTimeline (tracks, items) + { outputDir, baseName, audioFormat }, com
  // audioFormat: 'mp3' | 'm4a' | 'wav' | 'flac'. → { path, outputDir, duration }
  exportTimelineAudio: (payload) => ipcRenderer.invoke('export-timeline-audio', payload),

  // Grava o áudio do vídeo num .m4a ao lado dele, para virar um item de faixa
  // de áudio. → { ok, path, reused } | { ok:false, error }
  separateAudio: (sourcePath) => ipcRenderer.invoke('separate-audio', { sourcePath }),

  // --- Exportação ---
  // clips: [{ id, sourcePath, start, end, kind, framing }] — a ordem é a ordem final
  //   kind: 'video' | 'image' (foto exibida pelo tempo entre start e end)
  //   framing (só foto): { zoom, offsetX, offsetY, background: { mode, color } }
  //     zoom 1 = foto inteira no quadro; offsets em fração do quadro;
  //     background.mode: 'color' (cor sólida) | 'blur' (a própria foto desfocada)
  // mode: 'precise' | 'fast'   joinMode: 'separate' | 'merged'
  // format: null (original) | { width, height, fit: 'contain' | 'cover' }
  exportClips: ({ clips, outputDir, baseName, mode, joinMode, format }) =>
    ipcRenderer.invoke('export-clips', { clips, outputDir, baseName, mode, joinMode, format }),

  // Exporta a LINHA DO TEMPO inteira (faixas, sobreposição, trilha de áudio).
  //   tracks: [{ id, kind: 'video'|'audio', muted }]  — ordem = empilhamento
  //   Trechos vizinhos que se SOBREPÕEM na linha do tempo formam uma transição:
  //   a sobreposição é a duração dela, e `transition` diz o tipo (nomes do
  //   filtro xfade: fade, dissolve, wipeleft, circleopen…).
  //   items:  [{ id, trackId, sourcePath, kind, timelineStart, transition,
  //              sourceStart, sourceEnd, framing, volume, muted }]
  //   split:  null (um arquivo só) | [{ id, start, end, name }]
  //           Com a lista, a montagem é composta e DEPOIS recortada nesses
  //           pedaços — é assim que "arquivos separados" também leva as faixas
  //           de cima, as trilhas e os textos. O retorno traz `parts` no lugar
  //           de `path`.
  // Sempre recodifica: compor camadas não permite cópia de streams.
  exportTimeline: (payload) => ipcRenderer.invoke('export-timeline', payload),

  // Quanto o início de cada clipe recuaria no modo Rápido (sem perda)
  previewFastDrift: (clips) => ipcRenderer.invoke('preview-fast-drift', clips),

  mergeVideos: (videoPaths, outputDir, baseName, format) =>
    ipcRenderer.invoke('merge-videos', { videoPaths, outputDir, baseName, format }),

  revealPath: (targetPath) => ipcRenderer.invoke('reveal-path', targetPath),

  // --- Projeto (.cutting) ---
  // Guarda a montagem e os CAMINHOS das mídias, não as mídias em si.
  // projectRead devolve { ok, data, missing: [{ name, path }] } — `missing`
  // lista as mídias que saíram do lugar desde que o projeto foi salvo.
  projectSaveDialog: (suggestedName) => ipcRenderer.invoke('project-save-dialog', suggestedName),
  projectOpenDialog: () => ipcRenderer.invoke('project-open-dialog'),
  projectWrite: (filePath, data) => ipcRenderer.invoke('project-write', { filePath, data }),
  projectRead: (filePath) => ipcRenderer.invoke('project-read', filePath),

  // Quais caminhos ainda existem: { caminho: true|false }
  filesExist: (paths) => ipcRenderer.invoke('files-exist', paths),

  // Recuperação automática (arquivo próprio, na pasta de dados do app)
  autosaveWrite: (data) => ipcRenderer.invoke('project-autosave-write', data),
  autosaveRead: () => ipcRenderer.invoke('project-autosave-read'),
  autosaveClear: () => ipcRenderer.invoke('project-autosave-clear'),

  // --- Ciclo de vida da janela ---
  // O main pede licença antes de fechar; o renderer confirma o recebimento
  // (ack) e depois responde se pode prosseguir.
  onAppCloseRequested: subscribe('app-close-requested'),
  ackCloseRequest: () => ipcRenderer.send('close-ack'),
  respondToClose: (allow) => ipcRenderer.send('close-response', allow),

  // --- Progresso (Corte / Sequência) ---
  onCutProgress: subscribe('cut-progress'),
  onCutStatus: subscribe('cut-status'),
  onExportOverall: subscribe('export-overall'),

  // --- Progresso (Mesclagem) ---
  onMergeProgress: subscribe('merge-progress'),
  onMergeStatus: subscribe('merge-status')
});
