// ==========================================================================
// CUTTING - Renderer
//
// MODELO DE DADOS (pensado para expansão)
//
//   sources : [{ id, kind, path, name, duration, width, height, codec, fps,
//                size, hasAudio, previewPath }]
//       Cada mídia importada. kind = 'video' | 'image'.
//       Vídeo: o preview é gerado sob demanda (lazy), na primeira vez que a
//       fonte é ativada — importar 10 vídeos é instantâneo.
//       Foto: não precisa de preview nenhum, o próprio arquivo é exibido.
//
//   tracks  : [{ id, kind: 'video'|'audio', name, muted }]
//       As FAIXAS. A ordem do array é a ordem de empilhamento: a primeira faixa
//       de vídeo é a base, e as seguintes ficam SOBRE ela. Faixas de áudio se
//       somam ao som da base.
//
//   clips   : [{ id, trackId, sourceId, timelineStart, start, end,
//                framing, volume, muted }]
//       Os ITENS da montagem. `timelineStart` é a posição na linha do tempo;
//       `start`/`end` são o trecho DENTRO da fonte. Um item aponta para sua
//       fonte, então trechos de vídeos diferentes convivem na mesma faixa.
//       Para foto, start é sempre 0 e `end` é o tempo que ela fica na tela —
//       assim `end - start` continua sendo a duração do item, e todo o resto
//       do código funciona sem saber que aquele item é uma foto.
//
//       O nome `clips` ficou por continuidade: é a lista de itens de todas as
//       faixas, e não só da sequência principal.
//
// Para adicionar recursos novos (transições, volume por clipe, filtros...),
// acrescente campos ao clipe e trate-os em buildExportPayload()/main.js.
// ==========================================================================

// --- ESTADO: TELA DE CORTE ---
let sources = [];
let clips = [];
let tracks = [];
let activeSourceId = null;
let activeTrackId = null;     // faixa que recebe o próximo item adicionado
let sourceIdCounter = 0;
let clipIdCounter = 0;
let trackIdCounter = 0;

// Zoom da linha do tempo, em pixels por segundo
let pixelsPerSecond = 70;


let outputDirPath = null;
let lastExportTarget = null; // caminho para o botão "Abrir Pasta"


// --- ESTADO: TELA DE MESCLAGEM ---
let mergeVideoPaths = [];
let mergeVideosDurations = [];
let mergeVideosSizes = [];   // { width, height } por vídeo, para o aviso de formato
let mergeOutputDirPath = null;
let currentPlayingIndex = 0;
let isMergeTimelineDragging = false;
let isPlayingMergePreview = false;

// --- ESTADO: ENQUADRAMENTO ---
// O enquadramento do painel vive em CADA FONTE (source.framing), e não numa
// variável só: o ajuste feito numa foto não deve vazar para o próximo vídeo,
// já que zoom e fundo dependem da proporção e da intenção daquela mídia.
// Ao adicionar um trecho, ele leva uma CÓPIA do enquadramento da fonte.
// Com `editingClipId` preenchido, as mudanças vão direto para aquele trecho.
let editingClipId = null;

// Item selecionado na linha do tempo. Selecionar é o gesto natural para "quero
// mexer neste", então selecionar também coloca o item em edição.
let selectedClipId = null;
// Conjunto da seleção múltipla (Ctrl para somar, Shift para intervalo)
const selectedClipIds = new Set();

// --- CONSTANTES ---
const MIN_CLIP_DURATION = 0.1; // segundos
const STORAGE_KEYS = {
  outputDir: 'cutting.outputDir',
  mergeOutputDir: 'cutting.mergeOutputDir',
  timelineHeight: 'cutting.timelineHeight',
  recentProjects: 'cutting.recentProjects'
};

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'tif', 'tiff'];
const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'wma'];
const DEFAULT_IMAGE_DURATION = 5;   // segundos que a foto fica na tela
const MAX_IMAGE_DURATION = 600;

// Zoom da foto dentro do quadro. 1 = foto inteira encaixada.
const IMAGE_MIN_ZOOM = 0.1;
const IMAGE_MAX_ZOOM = 5;

const defaultFraming = () => ({
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  background: { mode: 'color', color: '#000000' }
});

// Cópia profunda: `background` é objeto, então um spread raso deixaria os
// trechos compartilhando a mesma referência de fundo.
const cloneFraming = (framing) => ({
  zoom: framing.zoom,
  offsetX: framing.offsetX,
  offsetY: framing.offsetY,
  background: { ...framing.background }
});

const extensionOf = (filePath) => String(filePath).split('.').pop().toLowerCase();
const isImagePath = (filePath) => IMAGE_EXTENSIONS.includes(extensionOf(filePath));
const isAudioPath = (filePath) => AUDIO_EXTENSIONS.includes(extensionOf(filePath));

// Formatos de saída. Acrescentar um novo é acrescentar uma linha aqui — a lista
// do <select>, as dicas e o aviso de corte saem todos desta tabela.
const OUTPUT_FORMATS = [
  { id: 'original', label: 'Original (não alterar)',
    hint: 'Mantém a proporção e a resolução de cada vídeo.' },
  { id: '16:9', label: '16:9 — 1920×1080 (Full HD)', width: 1920, height: 1080,
    hint: 'YouTube, Twitch, TVs, cursos e lives horizontais.' },
  { id: '9:16', label: '9:16 — 1080×1920 (Vertical)', width: 1080, height: 1920,
    hint: 'TikTok, Reels do Instagram, Shorts do YouTube, Kwai.' },
  { id: '1:1', label: '1:1 — 1080×1080 (Quadrado)', width: 1080, height: 1080,
    hint: 'Feed do Instagram (clássico), Facebook, LinkedIn.' },
  { id: '4:5', label: '4:5 — 1080×1350 (Retrato)', width: 1080, height: 1350,
    hint: 'Feed do Instagram — ocupa mais tela no celular.' },
  { id: '3:2', label: '3:2 — 1440×960', width: 1440, height: 960,
    hint: 'Fotos e vídeos de câmeras DSLR, Pinterest, blogs.' },
  { id: '4:3', label: '4:3 — 1440×1080 (Clássico)', width: 1440, height: 1080,
    hint: 'Vídeos antigos, iPad, apresentações, câmeras compactas.' }
];

const formatById = (id) => OUTPUT_FORMATS.find((f) => f.id === id) || OUTPUT_FORMATS[0];

// ==========================================================================
// ELEMENTOS DA UI
// ==========================================================================
const $ = (id) => document.getElementById(id);

// Telas e navegação
const homeScreen = $('home-screen');
const cutScreen = $('cut-screen');
const mergeScreen = $('merge-screen');
const btnMenuCut = $('btn-menu-cut');
const btnMenuMerge = $('btn-menu-merge');
const btnMenuOpen = $('btn-menu-open');
const recentList = $('recent-list');
const recentEmpty = $('recent-empty');
const btnBackHome = $('btn-back-home');
const btnMergeBackHome = $('btn-merge-back-home');

// Atalhos (modal)
const btnShortcuts = $('btn-shortcuts');
const btnProjectSave = $('btn-project-save');
const btnProjectOpen = $('btn-project-open');
const projectNameLabel = $('project-name');
const projectStatus = $('project-status');
const shortcutsModal = $('shortcuts-modal');
const btnCloseShortcuts = $('btn-close-shortcuts');

// Importação e biblioteca (corte)
const btnSelectVideo = $('btn-select-video');
const btnSelectImage = $('btn-select-image');
const btnAddAudioSource = $('btn-add-audio-source');
const mediaGrid = $('media-grid');
const mediaEmpty = $('media-empty');
const loadingPreview = $('loading-preview');
const loadingTitle = $('loading-title');
const loadingSubtitle = $('loading-subtitle');

// Abas da coluna esquerda
const tabMedia = $('tab-media');
const tabProps = $('tab-props');
const panelMedia = $('panel-media');
const panelProps = $('panel-props');
const propsEmpty = $('props-empty');
const propsBody = $('props-body');
const propsHeadline = $('props-headline');
const groupTrim = $('group-trim');
const groupFraming = $('group-framing');
const groupVolume = $('group-volume');
const btnAddTitle = $('btn-add-title');
const btnAddSubtitle = $('btn-add-subtitle');
const textLane = $('text-lane');
const textOverlays = $('text-overlays');
const groupText = $('group-text');
const inputTextContent = $('input-text-content');
const inputTextStart = $('input-text-start');
const inputTextDuration = $('input-text-duration');
const inputTextSize = $('input-text-size');
const textSizeReadout = $('text-size-readout');
const inputTextColor = $('input-text-color');
const btnTextBold = $('btn-text-bold');
const btnTextOutline = $('btn-text-outline');
const inputTextBg = $('input-text-bg');
const rowTextBg = $('row-text-bg');
const inputTextBgColor = $('input-text-bg-color');
const inputTextBgOpacity = $('input-text-bg-opacity');
const textBgOpacityReadout = $('text-bg-opacity-readout');
const textPositionHint = $('text-position-hint');
const btnTextRemove = $('btn-text-remove');
const inputNormalize = $('input-normalize');
const inputClipIn = $('input-clip-in');
const inputClipOut = $('input-clip-out');
const btnClipInHere = $('btn-clip-in-here');
const btnClipOutHere = $('btn-clip-out-here');
const rowClipDuration = $('row-clip-duration');
const inputClipDuration = $('input-clip-duration');
const durationPresets = $('duration-presets');
const rowClipName = $('row-clip-name');
const inputClipName = $('input-clip-name');
const groupAdjust = $('group-adjust');
const inputSpeed = $('input-speed');
const speedPresets = $('speed-presets');
const speedHint = $('speed-hint');
const inputOpacity = $('input-opacity');
const opacityReadout = $('opacity-readout');
const btnRotateLeft = $('btn-rotate-left');
const btnRotateRight = $('btn-rotate-right');
const btnFlipH = $('btn-flip-h');
const btnFlipV = $('btn-flip-v');
const inputBrightness = $('input-brightness');
const brightnessReadout = $('brightness-readout');
const inputContrast = $('input-contrast');
const contrastReadout = $('contrast-readout');
const inputSaturation = $('input-saturation');
const saturationReadout = $('saturation-readout');
const btnResetColor = $('btn-reset-color');
const inputChromaColor = $('input-chroma-color');
const btnChromaToggle = $('btn-chroma-toggle');
const btnChromaPick = $('btn-chroma-pick');
const rowChromaSimilarity = $('row-chroma-similarity');
const inputChromaSimilarity = $('input-chroma-similarity');
const chromaSimilarityReadout = $('chroma-similarity-readout');
const btnBlurRegion = $('btn-blur-region');
const btnBlurClear = $('btn-blur-clear');
const blurHint = $('blur-hint');
const blurRegionBox = $('blur-region-box');

const groupTransition = $('group-transition');
const selectTransition = $('select-transition');
const inputTransitionDuration = $('input-transition-duration');
const transitionHint = $('transition-hint');

// Monitor
const videoElement = $('video-element');
const imageElement = $('image-element');
const videoBgElement = $('video-bg-element');
const videoBElement = $('video-b-element');
const imageBElement = $('image-b-element');
const transitionVeil = $('transition-veil');
const overlayLayers = $('overlay-layers');
const mediaStage = $('media-stage');
const mediaFrame = $('media-frame');
const mediaFrameBg = $('media-frame-bg');
const mediaFrameCaption = $('media-frame-caption');
const btnPlayPause = $('btn-play-pause');
const playIcon = $('play-icon');
const pauseIcon = $('pause-icon');
const btnFrameBack = $('btn-frame-back');
const btnFrameForward = $('btn-frame-forward');
const btnGoStart = $('btn-go-start');
const btnGoEnd = $('btn-go-end');
const btnMute = $('btn-mute');
const iconVolume = $('icon-volume');
const iconMuted = $('icon-muted');
const inputVolume = $('input-volume');
const selectSpeed = $('select-speed');
const timeCurrentDisp = $('time-current');
const timeDurationDisp = $('time-duration');

// Enquadramento (dentro do painel de propriedades)
const inputImageZoom = $('input-image-zoom');
const zoomReadout = $('zoom-readout');
const btnZoomIn = $('btn-zoom-in');
const btnZoomOut = $('btn-zoom-out');
const btnFitImage = $('btn-fit-image');
const btnFillImage = $('btn-fill-image');
const btnResetFraming = $('btn-reset-framing');
const segmentedBackground = $('segmented-background');
const bgColorRow = $('bg-color-row');
const inputBgColor = $('input-bg-color');
const colorSwatches = $('color-swatches');
const btnPickFromImage = $('btn-pick-from-image');
const blurOptionLabel = $('blur-option-label');

// Áudio do trecho
const inputItemVolume = $('input-item-volume');
const itemVolumeReadout = $('item-volume-readout');
const itemVolumeHint = $('item-volume-hint');
const btnItemMute = $('btn-item-mute');

// Ferramentas da linha do tempo
const btnSplit = $('btn-split');
const btnClipDuplicate = $('btn-clip-duplicate');
const btnClipDelete = $('btn-clip-delete');
const btnUndo = $('btn-undo');
const btnRedo = $('btn-redo');
const btnZoomTimelineIn = $('btn-zoom-timeline-in');
const btnZoomTimelineOut = $('btn-zoom-timeline-out');
const btnZoomFit = $('btn-zoom-fit');
const timelineZoomReadout = $('timeline-zoom-readout');
// Exportação (corte) — agora em modal
const btnOpenExport = $('btn-open-export');
const exportModal = $('export-modal');
const btnCloseExportModal = $('btn-close-export-modal');
const btnCancelExport = $('btn-cancel-export');
const exportStepForm = $('export-step-form');
const exportStepProgress = $('export-step-progress');
const exportModalTitle = $('export-modal-title');
const exportSummary = $('export-summary');
const outputPathDisplay = $('output-path-display');
const btnSelectOutput = $('btn-select-output');
const inputOutputName = $('input-output-name');
const outputNameHint = $('output-name-hint');
const selectJoinMode = $('select-join-mode');
const btnExport = $('btn-export');

// Progresso (corte)
const exportProgressBarFill = $('export-progress-bar-fill');
const exportProgressText = $('export-progress-text');
const exportResultsList = $('export-results-list');
const btnCloseProgress = $('btn-close-progress');
const btnOpenFolder = $('btn-open-folder');

// Mesclagem
const mergeDropZone = $('merge-drop-zone');
const btnSelectMergeVideos = $('btn-select-merge-videos');
const mergePlayerWrapper = $('merge-player-wrapper');
const mergeVideoElement = $('merge-video-element');
const btnMergeRewind = $('btn-merge-rewind');
const btnMergePlayPause = $('btn-merge-play-pause');
const btnMergeForward = $('btn-merge-forward');
const mergePlayIcon = $('merge-play-icon');
const mergePauseIcon = $('merge-pause-icon');
const mergeCurrentVideoTitle = $('merge-current-video-title');
const mergeTimeDisplay = $('merge-time-display');
const mergeTimelineContainer = $('merge-timeline-container');
const mergeTimelineProgressBar = $('merge-timeline-progress-bar');
const mergeTimelinePlayhead = $('merge-timeline-playhead');
const mergeListPlaceholder = $('merge-list-placeholder');
const mergeList = $('merge-list');
const mergeVideosCounterDisp = $('merge-videos-counter');
const btnMergeAddMore = $('btn-merge-add-more');
const btnOpenMergeExport = $('btn-open-merge-export');
const mergeExportModal = $('merge-export-modal');
const btnCloseMergeModal = $('btn-close-merge-modal');
const btnCancelMergeExport = $('btn-cancel-merge-export');
const mergeStepForm = $('merge-step-form');
const mergeStepProgress = $('merge-step-progress');
const mergeSummary = $('merge-summary');
const mergeOutputPathDisplay = $('merge-output-path-display');
const btnMergeSelectOutput = $('btn-merge-select-output');
const inputMergeOutputName = $('input-merge-output-name');
const btnMergeExport = $('btn-merge-export');
const mergeProgressBarFill = $('merge-progress-bar-fill');
const mergeProgressText = $('merge-progress-text');
const btnMergeCloseProgress = $('btn-merge-close-progress');
const btnMergeOpenFolder = $('btn-merge-open-folder');


// Linha do tempo em faixas
const timelineSection = $('timeline-section');
const timelineResizer = $('timeline-resizer');
const editorShell = $('editor-shell');
const trackHeaders = $('track-headers');
const timelineScroll = $('timeline-scroll');
const timelineInner = $('timeline-inner');
const timelineRuler = $('timeline-ruler');
const timelineRows = $('timeline-rows');
const timelineEmpty = $('timeline-empty');
const timelineTotal = $('timeline-total');
const btnAddVideoTrack = $('btn-add-video-track');
const btnAddAudioTrack = $('btn-add-audio-track');
const inputTimelineZoom = $('input-timeline-zoom');

// Formato de saída
const selectOutputFormat = $('select-output-format');
const outputFormatHint = $('output-format-hint');
const fitChoice = $('fit-choice');
const segmentedFit = $('segmented-fit');
const fitWarning = $('fit-warning');
const selectMergeFormat = $('select-merge-format');
const mergeFormatHint = $('merge-format-hint');
const mergeFitChoice = $('merge-fit-choice');
const mergeSegmentedFit = $('merge-segmented-fit');
const mergeFitWarning = $('merge-fit-warning');

// Confirmação (descartar trabalho)
const confirmModal = $('confirm-modal');
const confirmModalTitle = $('confirm-modal-title');
const confirmModalMessage = $('confirm-modal-message');
const confirmModalDetails = $('confirm-modal-details');
const btnCloseConfirmModal = $('btn-close-confirm-modal');
const btnConfirmCancel = $('btn-confirm-cancel');
const btnConfirmOk = $('btn-confirm-ok');
const btnConfirmSave = $('btn-confirm-save');

// ==========================================================================
// AUXILIARES E FORMATADORES
// ==========================================================================

function getFileName(filePath) {
  return String(filePath).split(/[\\/]/).pop();
}

function stripExtension(fileName) {
  return fileName.replace(/\.[^.]+$/, '');
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
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

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(Math.max(0, decimals))) + ' ' + sizes[i];
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// ==========================================================================
// NAVEGAÇÃO ENTRE TELAS
// ==========================================================================

btnMenuCut.addEventListener('click', () => switchScreen(cutScreen));
btnMenuMerge.addEventListener('click', () => switchScreen(mergeScreen));

btnBackHome.addEventListener('click', async () => {
  if (!(await confirmDiscard(editorLossDetails()))) return;
  resetEditorState();
  switchScreen(homeScreen);
});

btnMergeBackHome.addEventListener('click', async () => {
  if (!(await confirmDiscard(mergeLossDetails()))) return;
  resetMergeState();
  switchScreen(homeScreen);
});

function switchScreen(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  screen.classList.add('active');
}

const isCutScreenActive = () => cutScreen.classList.contains('active');

// ==========================================================================
// MODAIS
//
// Registro central: qualquer modal fecha com Esc ou clique no fundo, e os
// atalhos de teclado do editor ficam suspensos enquanto algum estiver aberto.
// Para adicionar um modal novo, basta incluí-lo aqui.
// ==========================================================================
const MODALS = [shortcutsModal, exportModal, mergeExportModal, confirmModal];

const openModals = () => MODALS.filter((m) => !m.classList.contains('hidden'));
const isModalOpen = () => openModals().length > 0;

// Ordem de abertura, para o Esc agir sobre o modal mais acima e não sobre o
// primeiro da lista — o de confirmação pode abrir por cima do de exportação.
const modalStack = [];

// Quem abre um modal pode registrar o que fazer quando ele for fechado por
// QUALQUER via (X, Cancelar, Esc, clique no fundo). É o que permite ao modal
// de confirmação resolver sua Promise sem espalhar essa lógica pelos botões.
const modalDismissHandlers = new Map();

function topModal() {
  for (let i = modalStack.length - 1; i >= 0; i--) {
    if (!modalStack[i].classList.contains('hidden')) return modalStack[i];
  }
  return openModals().pop() || null; // fallback caso algo abra fora da pilha
}

function openModal(modal, onDismiss) {
  const index = modalStack.indexOf(modal);
  if (index !== -1) modalStack.splice(index, 1);
  modalStack.push(modal);

  if (onDismiss) modalDismissHandlers.set(modal, onDismiss);
  modal.classList.remove('hidden');
}

function closeModal(modal) {
  const index = modalStack.indexOf(modal);
  if (index !== -1) modalStack.splice(index, 1);
  modal.classList.add('hidden');

  const onDismiss = modalDismissHandlers.get(modal);
  if (onDismiss) {
    modalDismissHandlers.delete(modal);
    onDismiss();
  }
}

// Onde o botão do mouse foi pressionado, independente de onde for solto.
// Capturado no document para valer também quando o gesto começa dentro do
// card e termina no fundo.
let pressOriginTarget = null;
document.addEventListener('mousedown', (e) => {
  pressOriginTarget = e.button === 0 ? e.target : null;
}, true);

MODALS.forEach((modal) => {
  // Clique no fundo escuro fecha — mas só quando o gesto INTEIRO aconteceu no
  // fundo. Sem checar a origem, selecionar o texto de dentro do card e soltar
  // o botão fora fechava o modal: o evento `click` dispara no ancestral comum
  // do mousedown e do mouseup, que nesse caso é o próprio overlay. Por isso a
  // decisão fica no `mouseup`, comparando os dois extremos do gesto.
  modal.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (pressOriginTarget !== modal || e.target !== modal) return;
    if (modal.dataset.busy) return;
    closeModal(modal);
  });
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = topModal();
  if (open && !open.dataset.busy) {
    e.preventDefault();
    e.stopPropagation();
    closeModal(open);
  }
}, true);

btnShortcuts.addEventListener('click', () => openModal(shortcutsModal));
btnCloseShortcuts.addEventListener('click', () => closeModal(shortcutsModal));

// --------------------------------------------------------------------------
// Modal de confirmação
//
// askConfirm() devolve uma Promise: true = confirmou, false = desistiu. Sempre
// que uma ação for descartar trabalho, ela passa por aqui. Preferido ao
// confirm() nativo por dois motivos: mantém a identidade visual do app e não
// bloqueia o processo do renderer (um alert() nativo já travou o app aqui).
// --------------------------------------------------------------------------
let confirmResolve = null;

function settleConfirm(result) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(result);
}

function askConfirm({
  title,
  message,
  details = [],
  confirmLabel = 'Sair sem salvar',
  cancelLabel = 'Continuar editando',
  offerSave = false
}) {
  // Uma confirmação por vez: se já houver outra na tela, ela é cancelada.
  if (confirmResolve) settleConfirm(false);

  confirmModalTitle.textContent = title;
  confirmModalMessage.textContent = message;

  confirmModalDetails.innerHTML = '';
  confirmModalDetails.classList.toggle('hidden', details.length === 0);
  details.forEach((text) => {
    const item = document.createElement('li');
    item.textContent = text; // textContent: nomes de arquivo entram aqui
    confirmModalDetails.appendChild(item);
  });

  btnConfirmOk.textContent = confirmLabel;
  btnConfirmCancel.textContent = cancelLabel;
  // 'Salvar projeto' só faz sentido quando há uma montagem para salvar
  btnConfirmSave.classList.toggle('hidden', !offerSave);

  return new Promise((resolve) => {
    confirmResolve = resolve;
    // Fechar por X, Esc ou clique no fundo equivale a desistir da ação.
    openModal(confirmModal, () => settleConfirm(false));
    // O foco começa na opção segura: um Enter reflexo não descarta nada.
    btnConfirmCancel.focus();
  });
}

// settleConfirm() antes de fechar: o handler de dispensa vira no-op e não há
// risco de resolver a mesma Promise duas vezes.
btnConfirmOk.addEventListener('click', () => {
  settleConfirm(true);
  closeModal(confirmModal);
});
btnConfirmCancel.addEventListener('click', () => closeModal(confirmModal));

// Salvar resolve a confirmação como "pode prosseguir": o motivo do aviso era o
// trabalho não salvo, e ele deixou de existir. Se o usuário desistir no
// seletor de arquivo, a confirmação continua aberta.
btnConfirmSave.addEventListener('click', async () => {
  if (!(await saveProject(false))) return;
  settleConfirm(true);
  closeModal(confirmModal);
});
btnCloseConfirmModal.addEventListener('click', () => closeModal(confirmModal));

// ==========================================================================
// TRABALHO NÃO SALVO
//
// Nada aqui é persistido em disco: voltar ao menu ou fechar o app descarta a
// montagem inteira. Estas funções dizem O QUE seria perdido, para que a
// confirmação seja específica em vez de um "tem certeza?" genérico.
//
// Uma sequência já exportada com sucesso não conta como pendente até ser
// alterada de novo — daí a comparação por assinatura, e não um simples flag.
// ==========================================================================

// ==========================================================================
// DESFAZER / REFAZER
//
// Guarda fotografias do DOCUMENTO (mídias, faixas, itens e seleção) — não da
// tela. Mexer na agulha, no zoom ou na aba aberta não entra no histórico:
// desfazer tem que voltar o que você construiu, não onde você estava olhando.
//
// Estados inteiros, e não uma lista de operações inversas: a montagem é pequena
// (dezenas de objetos simples) e a alternativa exigiria uma função de desfazer
// por ação, que é onde esse tipo de código costuma apodrecer.
// ==========================================================================

const HISTORY_LIMIT = 60;
let historyPast = [];
let historyFuture = [];
let historyPresent = null;

function snapshotDocument() {
  return JSON.stringify({
    sources, tracks, clips, texts,
    activeTrackId, selectedClipId, selectedTextId,
    selectedClipIds: [...selectedClipIds],
    sourceIdCounter, clipIdCounter, trackIdCounter, textIdCounter
  });
}

function restoreDocument(snapshot) {
  const state = JSON.parse(snapshot);
  sources = state.sources;
  tracks = state.tracks;
  clips = state.clips;
  // Projetos salvos antes dos títulos não têm a lista: entram sem texto nenhum
  texts = state.texts || [];
  activeTrackId = state.activeTrackId;
  selectedClipId = state.selectedClipId;
  selectedTextId = state.selectedTextId === undefined ? null : state.selectedTextId;
  selectedClipIds.clear();
  state.selectedClipIds.forEach((id) => selectedClipIds.add(id));
  sourceIdCounter = state.sourceIdCounter;
  clipIdCounter = state.clipIdCounter;
  trackIdCounter = state.trackIdCounter;
  textIdCounter = state.textIdCounter || 0;

  // Os contadores voltam junto de propósito: sem isso, refazer poderia gerar
  // um id já usado e dois itens diferentes passariam a responder pelo mesmo.
  playhead = clamp(playhead, 0, sequenceDuration());
  editingClipId = selectedClipId;
}

// Chamada DEPOIS de cada mudança. Compara com o presente para não empilhar
// fotografias iguais (um arraste que não saiu do lugar, por exemplo).
function commitHistory() {
  const snapshot = snapshotDocument();
  if (snapshot === historyPresent) return;

  if (historyPresent !== null) historyPast.push(historyPresent);
  if (historyPast.length > HISTORY_LIMIT) historyPast.shift();
  historyPresent = snapshot;
  historyFuture = [];
  updateHistoryButtons();
}

function resetHistory() {
  historyPast = [];
  historyFuture = [];
  historyPresent = snapshotDocument();
  updateHistoryButtons();
}

function undo() {
  if (historyPast.length === 0) return;
  historyFuture.unshift(historyPresent);
  historyPresent = historyPast.pop();
  restoreDocument(historyPresent);
  stopMonitor();
  renderAll();
  updateHistoryButtons();
}

function redo() {
  if (historyFuture.length === 0) return;
  historyPast.push(historyPresent);
  historyPresent = historyFuture.shift();
  restoreDocument(historyPresent);
  stopMonitor();
  renderAll();
  updateHistoryButtons();
}

function updateHistoryButtons() {
  btnUndo.disabled = historyPast.length === 0;
  btnRedo.disabled = historyFuture.length === 0;
  updateProjectLabel();
}

// ==========================================================================
// PROJETO (.cutting) E SALVAMENTO AUTOMÁTICO
//
// O arquivo guarda a MONTAGEM e os CAMINHOS das mídias — não as mídias. Um
// projeto tem poucos KB e abre na hora; em troca, mover ou apagar um vídeo
// quebra o vínculo, e por isso avisamos quais faltam ao abrir.
//
// O salvamento automático é uma REDE DE SEGURANÇA, não um substituto do
// "Salvar": vai para a pasta de dados do app e só é oferecido se o programa
// tiver sido fechado com trabalho pendente.
// ==========================================================================

const PROJECT_VERSION = 1;
const AUTOSAVE_INTERVAL_MS = 20000;

let projectPath = null;         // arquivo aberto, ou null se nunca foi salvo
let savedSnapshot = null;       // como o documento estava no último salvamento
let autosaveTimer = null;

const projectDisplayName = () =>
  projectPath ? stripExtension(getFileName(projectPath)) : 'Sem projeto';

// "Tem trabalho não salvo?" — a mesma pergunta que o histórico já sabe
// responder, comparando o documento com o estado do último salvamento.
const projectIsDirty = () => {
  const now = snapshotDocument();
  if (savedSnapshot === null) return sources.length > 0 || clips.length > 0;
  return now !== savedSnapshot;
};

function updateProjectLabel() {
  projectNameLabel.textContent = projectDisplayName() + (projectIsDirty() ? ' •' : '');
  projectNameLabel.classList.toggle('dirty', projectIsDirty());
}

// Ajustes de exportação também são do projeto: reabrir e ter que reescolher
// formato e pasta de saída seria só trabalho repetido.
function exportSettings() {
  const fit = segmentedFit.querySelector('input:checked');
  return {
    outputName: inputOutputName.value,
    outputDir: outputDirPath,
    formatId: selectOutputFormat.value,
    fit: fit ? fit.value : 'cover',
    joinMode: selectJoinMode.value
  };
}

function applyExportSettings(settings) {
  if (!settings) return;
  inputOutputName.value = settings.outputName || '';
  if (settings.outputDir) {
    outputDirPath = settings.outputDir;
    outputPathDisplay.value = settings.outputDir;
  }
  if (settings.formatId !== undefined && formatById(settings.formatId)) {
    selectOutputFormat.value = settings.formatId;
    selectOutputFormat.dispatchEvent(new Event('change'));
  }
  const fit = segmentedFit.querySelector(`input[value="${settings.fit}"]`);
  if (fit) fit.checked = true;
  if (settings.joinMode) selectJoinMode.value = settings.joinMode;
}

function buildProjectFile() {
  return {
    app: 'Cutting',
    version: PROJECT_VERSION,
    savedAt: new Date().toISOString(),
    document: JSON.parse(snapshotDocument()),
    settings: exportSettings()
  };
}

// Recoloca o documento na tela. As prévias de vídeo NÃO são restauradas: elas
// vivem na pasta temporária do sistema e podem ter sido apagadas entre uma
// sessão e outra. Ficam em null e voltam a ser geradas sob demanda.
function applyProjectFile(file) {
  const doc = file.document || {};
  // Os padrões cobrem projetos salvos por versões anteriores, que não tinham
  // todos estes campos. restoreDocument() é o mesmo caminho do desfazer, então
  // o que vale aqui vale lá.
  restoreDocument(JSON.stringify({
    sources: doc.sources || [],
    tracks: doc.tracks || [],
    clips: doc.clips || [],
    texts: doc.texts || [],
    activeTrackId: doc.activeTrackId || null,
    selectedClipId: doc.selectedClipId || null,
    selectedTextId: doc.selectedTextId === undefined ? null : doc.selectedTextId,
    selectedClipIds: doc.selectedClipIds || [],
    sourceIdCounter: doc.sourceIdCounter || 0,
    clipIdCounter: doc.clipIdCounter || 0,
    trackIdCounter: doc.trackIdCounter || 0,
    textIdCounter: doc.textIdCounter || 0
  }));

  sources.forEach((source) => {
    if (source.kind === 'video') source.previewPath = null;
  });

  activeSourceId = sources.length ? sources[0].id : null;
  applyExportSettings(file.settings);

  stopMonitor();
  playhead = 0;
  renderAll();
  resetHistory();
}

async function saveProject(askWhere) {
  let target = projectPath;
  if (askWhere || !target) {
    const suggested = projectPath
      ? stripExtension(getFileName(projectPath))
      : (inputOutputName.value.trim() || 'projeto');
    target = await window.api.projectSaveDialog(suggested);
    if (!target) return false;
  }

  const result = await window.api.projectWrite(target, buildProjectFile());
  if (!result.ok) {
    alert(`Não foi possível salvar o projeto:\n\n${result.error}`);
    return false;
  }

  projectPath = result.path;
  savedSnapshot = snapshotDocument();
  rememberProject(projectPath);
  // Com o trabalho no disco, a cópia de recuperação perdeu a razão de existir
  await window.api.autosaveClear();
  updateProjectLabel();
  showProjectStatus(`Projeto salvo em ${getFileName(projectPath)}`);
  return true;
}

async function openProject() {
  if (!(await confirmDiscard(editorLossDetails()))) return;

  const filePath = await window.api.projectOpenDialog();
  if (!filePath) return;
  await loadProjectFrom(filePath);
}

async function loadProjectFrom(filePath) {
  const result = await window.api.projectRead(filePath);
  if (!result.ok) {
    alert(`Não foi possível abrir o projeto:\n\n${result.error}`);
    return false;
  }

  applyProjectFile(result.data);
  projectPath = result.path;
  savedSnapshot = snapshotDocument();
  rememberProject(projectPath);
  updateProjectLabel();

  // Mídia que saiu do lugar: o projeto abre mesmo assim, porque o resto da
  // montagem continua válido — mas exportar com ela quebraria, então o aviso
  // é explícito e nomeia os arquivos.
  if (result.missing && result.missing.length > 0) {
    alert(
      `${plural(result.missing.length, 'mídia não foi encontrada', 'mídias não foram encontradas')} ` +
      `no lugar de origem:\n\n${result.missing.map((m) => m.path).join('\n')}\n\n` +
      'O projeto abriu, mas esses trechos não vão exportar até que os arquivos voltem.'
    );
  }
  return true;
}

// --- Salvamento automático ---
//
// Grava sozinho enquanto há trabalho pendente. Se um projeto já tem arquivo, o
// automático continua valendo: ele cobre o intervalo entre um Ctrl+S e outro.
function startAutosave() {
  if (autosaveTimer) return;
  autosaveTimer = setInterval(async () => {
    if (!isCutScreenActive()) return;
    if (!projectIsDirty()) return;
    if (sources.length === 0 && clips.length === 0) return;

    await window.api.autosaveWrite({ ...buildProjectFile(), projectPath });
    showProjectStatus(`Cópia de recuperação salva às ${new Date().toLocaleTimeString('pt-BR')}`);
  }, AUTOSAVE_INTERVAL_MS);
}

// Na abertura do app: se sobrou uma cópia de recuperação, é porque a sessão
// anterior terminou sem salvar. Oferece uma vez e depois some.
async function offerRecovery() {
  const saved = await window.api.autosaveRead();
  if (!saved || !saved.data) return;

  const when = saved.savedAt ? new Date(saved.savedAt).toLocaleString('pt-BR') : 'a última sessão';
  const restore = await askConfirm({
    title: 'Recuperar trabalho anterior?',
    message: `O Cutting foi fechado com uma montagem não salva (${when}).`,
    details: ['Você pode recuperá-la agora ou descartar e começar do zero.'],
    confirmLabel: 'Recuperar',
    cancelLabel: 'Descartar'
  });

  if (!restore) {
    await window.api.autosaveClear();
    return;
  }

  switchScreen(cutScreen);
  applyProjectFile(saved.data);
  projectPath = saved.data.projectPath || null;
  savedSnapshot = null;           // recuperado ≠ salvo: continua pendente
  updateProjectLabel();
  showProjectStatus('Montagem recuperada — salve o projeto para não perder de novo.');
}

btnProjectSave.addEventListener('click', () => saveProject(false));
btnProjectOpen.addEventListener('click', openProject);

// Recado curto no cabeçalho. Salvar não abre modal — interromper a edição para
// dizer "salvo" seria pior que o silêncio.
let projectStatusTimer = null;
function showProjectStatus(text) {
  projectStatus.textContent = text;
  projectStatus.classList.remove('hidden');
  clearTimeout(projectStatusTimer);
  projectStatusTimer = setTimeout(() => projectStatus.classList.add('hidden'), 4000);
}

// ==========================================================================
// ÁREA DE TRANSFERÊNCIA (Ctrl+C / Ctrl+V)
// ==========================================================================

let clipboard = [];

function copySelection() {
  const chosen = selectedClips();
  if (chosen.length === 0) return;

  // O menor início vira a origem, para colar preservando o espaçamento
  const origin = Math.min(...chosen.map((c) => c.timelineStart));
  clipboard = chosen.map((c) => ({
    sourceId: c.sourceId,
    trackId: c.trackId,
    offset: c.timelineStart - origin,
    start: c.start,
    end: c.end,
    name: c.name || null,
    framing: cloneFraming(c.framing || defaultFraming()),
    volume: c.volume,
    muted: c.muted
  }));
}

// Cola na AGULHA, na mesma faixa de origem quando ela ainda existe. É o
// comportamento que se espera de um editor: o ponto de inserção é onde você
// está olhando, não onde o original estava.
function pasteClipboard() {
  if (clipboard.length === 0) return;

  const created = [];
  clipboard.forEach((entry) => {
    const source = sourceById(entry.sourceId);
    if (!source) return;                       // mídia removida desde a cópia

    const track = trackAccepts(trackById(entry.trackId), source)
      ? trackById(entry.trackId)
      : targetTrackFor(source);

    clipIdCounter++;
    const clip = {
      id: clipIdCounter,
      trackId: track.id,
      sourceId: source.id,
      timelineStart: Math.max(0, playhead + entry.offset),
      start: entry.start,
      end: entry.end,
      name: entry.name,
      framing: cloneFraming(entry.framing),
      volume: entry.volume,
      muted: entry.muted
    };
    clips.push(clip);
    created.push(clip);
  });

  if (created.length === 0) return;

  selectedClipIds.clear();
  created.forEach((c) => selectedClipIds.add(c.id));
  selectedClipId = created[created.length - 1].id;
  editingClipId = selectedClipId;

  renderAll();
  commitHistory();
}

// ==========================================================================
// FAIXAS
//
// A base é a primeira faixa de vídeo. As faixas de vídeo seguintes ficam SOBRE
// ela (sobreposição), e as de áudio somam ao som. Toda consulta de "a sequência
// principal" passa por baseItems(), que ordena por posição no tempo — a ordem
// do array `clips` não significa mais nada, quem manda é o timelineStart.
// ==========================================================================

function createTrack(kind, name) {
  trackIdCounter++;
  const track = { id: trackIdCounter, kind, name: name || `${kind === 'audio' ? 'A' : 'V'}${trackIdCounter}`, muted: false };
  tracks.push(track);
  return track;
}

// Faixas mínimas para começar: uma de vídeo e uma de áudio.
function initTracks() {
  tracks = [];
  trackIdCounter = 0;
  const base = createTrack('video', 'V1');
  createTrack('audio', 'A1');
  activeTrackId = base.id;
}

const trackById = (id) => tracks.find((t) => t.id === id) || null;
const videoTracks = () => tracks.filter((t) => t.kind === 'video');
const audioTracks = () => tracks.filter((t) => t.kind === 'audio');
const baseTrack = () => videoTracks()[0] || null;
const activeTrack = () => trackById(activeTrackId) || baseTrack();

const itemsOfTrack = (trackId) =>
  clips.filter((c) => c.trackId === trackId).sort((a, b) => a.timelineStart - b.timelineStart);

// Itens da faixa principal, na ordem em que aparecem no tempo
const baseItems = () => {
  const base = baseTrack();
  return base ? itemsOfTrack(base.id) : [];
};

const clipSpeed = (clip) => clamp(Number(clip && clip.speed) || 1, 0.1, 10);

// Duração NA LINHA DO TEMPO: o trecho da fonte dividido pela velocidade.
// Um corte de 10s a 2x ocupa 5s na montagem.
const clipDuration = (clip) => Math.max(0, (clip.end - clip.start) / clipSpeed(clip));
const clipEnd = (clip) => clip.timelineStart + clipDuration(clip);

// Duração total = onde termina o item que vai mais longe. Deixou de ser a soma
// das durações: com posição no tempo existem vazios e sobreposições.
const sequenceDuration = () => clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);

// A montagem é "simples" quando cabe no caminho antigo de exportação — aquele
// que consegue cortar SEM PERDA. Basta uma faixa de vídeo usada, itens colados
// desde o zero, nada de sobreposição nem trilha.
function isSimpleTimeline() {
  const base = baseTrack();
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
  if (texts.some((t) => String(t.content || '').trim())) return false;

  let cursor = 0;
  for (const item of baseItems()) {
    if (Math.abs(item.timelineStart - cursor) > 0.02) return false;
    cursor = clipEnd(item);
  }
  return true;
}

const editorSignature = () => JSON.stringify(
  clips.map((c) => [c.trackId, c.sourceId, c.timelineStart, c.start, c.end, c.volume, c.muted])
);

// Cor dos vazios da linha do tempo: acompanha o fundo escolhido no primeiro
// trecho, para o intervalo não destoar do resto da montagem.
function timelineBackgroundColor() {
  const first = baseItems()[0];
  const color = first && first.framing && first.framing.background
    ? first.framing.background.color
    : '#000000';
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#000000';
}
const mergeSignature = () => JSON.stringify(mergeVideoPaths);

let lastExportedEditorSignature = null;
let lastExportedMergeSignature = null;

const plural = (n, singular, pluralForm) => `${n} ${n === 1 ? singular : pluralForm}`;

// Devolve a lista do que se perde na tela de corte; vazia = nada a confirmar.
function editorLossDetails() {
  if (!sources.length && !clips.length) return [];
  if (clips.length && editorSignature() === lastExportedEditorSignature) return [];
  // Já salvo em um .cutting e sem mudança desde então: não há o que perder
  if (!projectIsDirty()) return [];

  const details = [];
  if (clips.length) {
    details.push(
      `${plural(clips.length, 'trecho montado', 'trechos montados')} — ` +
      `${formatTime(sequenceDuration(), false)} de sequência`
    );
  }
  if (sources.length) {
    // Fala "mídias" quando há foto na jogada: dizer "vídeos" seria impreciso
    const photos = sources.filter((s) => s.kind === 'image').length;
    details.push(photos > 0
      ? `${plural(sources.length, 'mídia carregada', 'mídias carregadas')} (${photos} foto${photos > 1 ? 's' : ''})`
      : plural(sources.length, 'vídeo carregado', 'vídeos carregados'));
  }
  return details;
}

function mergeLossDetails() {
  if (!mergeVideoPaths.length) return [];
  if (mergeSignature() === lastExportedMergeSignature) return [];
  return [`${plural(mergeVideoPaths.length, 'vídeo', 'vídeos')} na lista de mesclagem`];
}

// Pergunta antes de descartar. Sem nada pendente, passa direto — a proteção
// não pode virar um clique a mais em toda navegação.
async function confirmDiscard(details) {
  if (!details.length) return true;
  const allow = await askConfirm({
    title: 'Descartar a edição?',
    message: projectPath
      ? `Há mudanças que ainda não foram gravadas em ${getFileName(projectPath)}. Ao sair, você perde:`
      : 'Esta montagem ainda não foi salva em nenhum projeto. Ao sair, você perde:',
    details,
    confirmLabel: 'Descartar e sair',
    cancelLabel: 'Continuar editando',
    offerSave: true
  });
  // Descartar é uma decisão explícita: oferecer a recuperação na próxima
  // abertura contrariaria o que o usuário acabou de escolher.
  if (allow) await window.api.autosaveClear();
  return allow;
}

// Fechar o app: o main pede licença e espera a resposta. As duas telas contam,
// porque a montagem de uma sobrevive enquanto se mexe na outra.
window.api.onAppCloseRequested(async () => {
  window.api.ackCloseRequest(); // sinal de vida: destrava o timeout do main

  let allow;
  const exporting = MODALS.some((m) => m.dataset.busy);

  if (exporting) {
    // Aviso mais forte: aqui não se perde só a montagem, o arquivo de saída
    // fica pela metade no disco.
    allow = await askConfirm({
      title: 'Exportação em andamento',
      message: 'Fechar agora interrompe o processamento e deixa o arquivo de saída incompleto.',
      confirmLabel: 'Interromper e fechar',
      cancelLabel: 'Continuar exportando'
    });
  } else {
    const details = [...editorLossDetails(), ...mergeLossDetails()];
    allow = details.length === 0 || await askConfirm({
      title: 'Fechar sem salvar?',
      message: 'Esta montagem não fica salva em lugar nenhum. Ao fechar, você perde:',
      details,
      confirmLabel: 'Fechar sem salvar',
      cancelLabel: 'Continuar editando'
    });
  }

  window.api.respondToClose(allow);
});

// ==========================================================================
// 1. FLUXO DE CORTE — FONTES DE VÍDEO
// ==========================================================================

const activeSource = () => sources.find((s) => s.id === activeSourceId) || null;
const sourceById = (id) => sources.find((s) => s.id === id) || null;
const isImageClip = (clip) => {
  const source = clip && sourceById(clip.sourceId);
  return !!source && source.kind === 'image';
};
const isVideoClip = (clip) => !!clip && !isImageClip(clip);
const activeDuration = () => {
  const source = activeSource();
  return source ? source.duration : 0;
};

btnSelectVideo.addEventListener('click', handleVideoSelection);
btnSelectImage.addEventListener('click', handleImageSelection);
btnAddAudioSource.addEventListener('click', handleAudioSelection);
// O arrastar-e-soltar de arquivos é tratado na própria biblioteca

function collectDroppedPaths(event) {
  const paths = [];
  const files = event.dataTransfer ? event.dataTransfer.files : [];
  for (let i = 0; i < files.length; i++) {
    const filePath = window.api.getDroppedFilePath(files[i]);
    if (filePath) paths.push(filePath);
  }
  return paths;
}

async function handleVideoSelection() {
  const filePaths = await window.api.selectMultipleVideos();
  if (filePaths && filePaths.length > 0) {
    await addSources(filePaths);
  }
}

async function handleImageSelection() {
  const filePaths = await window.api.selectImages();
  if (filePaths && filePaths.length > 0) {
    await addSources(filePaths);
  }
}

async function handleAudioSelection() {
  const filePaths = await window.api.selectAudio();
  if (filePaths && filePaths.length > 0) {
    await addSources(filePaths);
  }
}

// Lê as dimensões de uma foto sem tocar no ffmpeg: o próprio navegador já
// decodifica a imagem, então isso é instantâneo.
function readImageSize(filePath) {
  return new Promise((resolve, reject) => {
    const probe = new Image();
    probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => reject(new Error('Formato de imagem não suportado'));
    probe.src = toFileUrl(filePath);
  });
}

const toFileUrl = (filePath) => `file:///${String(filePath).replace(/\\/g, '/')}`;

// Importa fontes, vídeos ou fotos. Só lê metadados aqui (rápido); o preview de
// vídeo é gerado sob demanda, e foto não precisa de preview nenhum.
async function addSources(paths) {
  const newPaths = paths.filter((p) => !sources.some((s) => s.path === p));
  if (newPaths.length === 0) return;

  showLoading('Analisando mídias...', 'Lendo duração, resolução e codecs.');

  const failed = [];
  let firstAddedId = null;

  for (let i = 0; i < newPaths.length; i++) {
    const filePath = newPaths[i];
    loadingSubtitle.textContent = `${getFileName(filePath)} (${i + 1} de ${newPaths.length})`;

    try {
      let source;

      if (isImagePath(filePath)) {
        const size = await readImageSize(filePath);
        sourceIdCounter++;
        source = {
          id: sourceIdCounter,
          kind: 'image',
          path: filePath,
          name: getFileName(filePath),
          duration: 0,           // foto não tem duração própria; quem define é o trecho
          width: size.width,
          height: size.height,
          codec: 'imagem',
          fps: 30,
          size: 0,
          hasAudio: false,
          previewPath: filePath, // exibida direto, sem conversão
          framing: defaultFraming()
        };
      } else if (isAudioPath(filePath)) {
        // Áudio não tem imagem: o ffprobe dá a duração, o resto fica em zero.
        const metadata = await window.api.getVideoMetadata(filePath);
        sourceIdCounter++;
        source = {
          id: sourceIdCounter,
          kind: 'audio',
          path: filePath,
          name: getFileName(filePath),
          duration: metadata.duration || 0,
          width: 0,
          height: 0,
          codec: metadata.audioCodec || 'áudio',
          fps: 0,
          size: metadata.size,
          hasAudio: true,
          previewPath: filePath,
          framing: defaultFraming()
        };
      } else {
        const metadata = await window.api.getVideoMetadata(filePath);
        sourceIdCounter++;
        source = {
          id: sourceIdCounter,
          kind: 'video',
          path: filePath,
          name: getFileName(filePath),
          duration: metadata.duration || 0,
          width: metadata.width,
          height: metadata.height,
          codec: metadata.codec,
          fps: metadata.fps || 30,
          size: metadata.size,
          hasAudio: metadata.hasAudio,
          previewPath: null,
          framing: defaultFraming()
        };
      }

      sources.push(source);
      if (firstAddedId === null) firstAddedId = source.id;
    } catch (err) {
      console.error('Falha ao ler', filePath, err);
      failed.push(getFileName(filePath));
    }
  }

  if (failed.length > 0) {
    alert(`Não foi possível ler ${failed.length} arquivo(s):\n\n${failed.join('\n')}`);
  }

  if (sources.length === 0) {
    hideLoading();
    return;
  }

  // Sugere um nome de saída na primeira importação
  if (!inputOutputName.value.trim()) {
    inputOutputName.value = stripExtension(sources[0].name);
  }

  // Destaca a primeira mídia nova (ou mantém a atual, se já havia uma)
  if (activeSourceId === null && firstAddedId !== null) activeSourceId = firstAddedId;

  hideLoading();
  renderAll();
}

// Selecionar na biblioteca é só destacar: o monitor mostra a MONTAGEM, não a
// mídia isolada. Quem quiser ver a mídia arrasta ela para uma faixa.
function setActiveSource(sourceId) {
  activeSourceId = sourceId;
  renderMediaLibrary();
  return Promise.resolve();
}

// Tirar uma mídia da biblioteca tira junto os trechos que vieram dela — não
// faria sentido manter na montagem um trecho sem arquivo de origem.
function removeSource(sourceId) {
  const source = sourceById(sourceId);
  if (!source) return;

  const related = clips.filter((c) => c.sourceId === sourceId);
  if (related.length > 0) {
    const ok = confirm(
      `"${source.name}" tem ${related.length} trecho(s) na linha do tempo.\n\n` +
      `Remover a mídia remove esses trechos também. Continuar?`
    );
    if (!ok) return;
  }

  clips = clips.filter((c) => c.sourceId !== sourceId);
  sources = sources.filter((s) => s.id !== sourceId);

  if (!clips.some((c) => c.id === selectedClipId)) selectItem(null);
  if (activeSourceId === sourceId) activeSourceId = sources.length ? sources[0].id : null;

  if (sources.length === 0) {
    resetEditorState();
    return;
  }

  playhead = clamp(playhead, 0, sequenceDuration());
  renderAll();
  commitHistory();
}

// Garante que a fonte tem um arquivo reproduzível no monitor. Vídeos que nunca
// foram abertos ainda não têm preview — geramos sob demanda, com aviso.
async function ensurePreviewFor(source) {
  if (!source || source.kind !== 'video' || source.previewPath) return true;

  showLoading('Preparando visualização...', `${source.name} — convertendo para reprodução fluida.`);
  try {
    source.previewPath = await window.api.createPreview(source.path);
    return true;
  } catch (err) {
    console.error('Erro ao gerar preview:', err);
    alert(`Não foi possível preparar a visualização de "${source.name}".\n\nO corte ainda funciona, mas sem prévia.`);
    return false;
  } finally {
    hideLoading();
  }
}

// ==========================================================================
// ENQUADRAMENTO (foto e vídeo)
//
// O quadro na tela reproduz a PROPORÇÃO DA SAÍDA, então o que se vê ali é o
// que sai no vídeo. Os números guardados são relativos (zoom a partir do
// encaixe, deslocamento em fração do quadro), e não pixels, para a mesma
// escolha valer em qualquer resolução — 1080p ou 4K.
//
// O backend refaz exatamente esta conta em computeMediaLayout(): se um dos dois
// lados mudar de fórmula, a prévia deixa de corresponder ao resultado.
// ==========================================================================

const isDefaultFraming = (framing) => !framing || (
  framing.zoom === 1 &&
  framing.offsetX === 0 &&
  framing.offsetY === 0 &&
  framing.background.mode === 'color' &&
  framing.background.color === '#000000'
);

const hasCustomFraming = (framing) => !isDefaultFraming(framing);

// Algum trecho da sequência tem enquadramento personalizado? Isso obriga a
// recodificar, então influencia a disponibilidade do modo Rápido.
// Trecho com o som mexido: volume, mudo ou normalização. Como o corte sem
// perda só copia os streams, qualquer um deles obriga a recodificar.
const hasAudioTweaks = (clip) => !!clip && (
  !!clip.muted ||
  (clip.volume !== undefined && clip.volume !== 1) ||
  !!clip.normalize
);

const sequenceHasFraming = () =>
  clips.some((c) => hasCustomFraming(c.framing) || hasAdjustments(c) || hasAudioTweaks(c));

// Proporção do quadro de saída. Depende do Formato escolhido na exportação;
// sem formato, a "tela" é ditada pelos vídeos da montagem.
function outputFrame() {
  const format = currentCutFormat();
  if (format) {
    return { width: format.width, height: format.height, label: `${format.width}×${format.height}` };
  }

  const videos = sources.filter((s) => s.kind === 'video' && s.width);
  if (videos.length > 0) {
    const biggest = videos.reduce((a, b) => (b.width * b.height > a.width * a.height ? b : a));
    return {
      width: biggest.width,
      height: biggest.height,
      label: `${biggest.width}×${biggest.height}, do vídeo`
    };
  }

  const media = activeSource();
  if (media && media.width) {
    return { width: media.width, height: media.height, label: 'tamanho da própria mídia' };
  }
  return { width: 16, height: 9, label: '16:9' };
}

// Tamanho e posição da mídia dentro do quadro, em PORCENTAGEM do quadro.
// Mesma fórmula do computeMediaLayout() do main.js, só em unidades relativas.
// `rotate` chega junto porque girar 90° troca os lados da mídia e, com isso,
// muda o encaixe dela no quadro. A exportação já calcula assim; o monitor
// precisa da mesma conta para mostrar o mesmo enquadramento.
function framingLayout(source, framing, frame, rotate) {
  const frameRatio = frame.width / frame.height;
  const quarter = rotate === 90 || rotate === 270;
  const mediaRatio = quarter
    ? (source.height || 1) / (source.width || 1)
    : (source.width || 1) / (source.height || 1);

  // "Encaixe" (zoom 1): a mídia inteira dentro do quadro
  let fitWidth = 100;
  let fitHeight = 100;
  if (mediaRatio > frameRatio) fitHeight = 100 * (frameRatio / mediaRatio);
  else fitWidth = 100 * (mediaRatio / frameRatio);

  const drawWidth = fitWidth * framing.zoom;
  const drawHeight = fitHeight * framing.zoom;

  return {
    width: drawWidth,
    height: drawHeight,
    left: (100 - drawWidth) / 2 + framing.offsetX * 100,
    top: (100 - drawHeight) / 2 + framing.offsetY * 100
  };
}

// Zoom que faz a mídia PREENCHER o quadro (o mínimo para não sobrar fundo)
function fillZoomFor(source, frame) {
  const frameRatio = frame.width / frame.height;
  const mediaRatio = (source.width || 1) / (source.height || 1);
  return mediaRatio > frameRatio ? mediaRatio / frameRatio : frameRatio / mediaRatio;
}

// Mantém o vídeo de fundo colado no principal. A tolerância evita reposicionar
// a cada frame — buscar toda hora engasgaria a reprodução sem ganho visível,
// já que o fundo está desfocado de qualquer forma.
function syncBlurVideo() {
  if (videoBgElement.classList.contains('hidden') || !videoBgElement.src) return;

  if (Math.abs(videoBgElement.currentTime - videoElement.currentTime) > 0.25) {
    videoBgElement.currentTime = videoElement.currentTime;
  }
  if (videoElement.paused && !videoBgElement.paused) videoBgElement.pause();
  if (!videoElement.paused && videoBgElement.paused) videoBgElement.play().catch(() => {});
}

['timeupdate', 'play', 'pause', 'seeked', 'ratechange'].forEach((event) => {
  videoElement.addEventListener(event, () => {
    videoBgElement.playbackRate = videoElement.playbackRate;
    syncBlurVideo();
  });
});

// O painel edita ou o enquadramento da fonte ativa (que será copiado no
// próximo trecho adicionado), ou um trecho já montado.
// O enquadramento pertence sempre ao TRECHO selecionado na linha do tempo.
// Não existe mais "enquadramento da fonte": o monitor mostra a montagem, e
// enquadrar sem um trecho escolhido não teria onde ser aplicado.
const framingTarget = () => {
  const clip = selectedClip();
  if (!clip) return null;
  if (!clip.framing) clip.framing = defaultFraming();
  return clip.framing;
};

// Aplica uma mudança e repinta. Editando um trecho da sequência, a lista
// também precisa refletir (a duração aparece lá).
function updateFraming(changes) {
  const target = framingTarget();
  if (!target) return;

  Object.assign(target, changes);
  target.zoom = clamp(target.zoom, IMAGE_MIN_ZOOM, IMAGE_MAX_ZOOM);

  syncFramingControls();
  renderMonitor();
}

// Espelha o estado nos controles (usado ao trocar de foto ou de trecho)
function syncFramingControls() {
  const framing = framingTarget();
  if (!framing) return;

  inputImageZoom.value = String(Math.round(framing.zoom * 100));
  zoomReadout.textContent = `${Math.round(framing.zoom * 100)}%`;
  inputBgColor.value = framing.background.color;

  const radio = segmentedBackground.querySelector(`input[value="${framing.background.mode}"]`);
  if (radio) radio.checked = true;
  bgColorRow.classList.toggle('hidden', framing.background.mode !== 'color');
}

// --- Controles de zoom ---
inputImageZoom.addEventListener('input', () => {
  updateFraming({ zoom: Number(inputImageZoom.value) / 100 });
});

const stepZoom = (factor) => {
  const framing = framingTarget();
  if (framing) updateFraming({ zoom: framing.zoom * factor });
};
btnZoomIn.addEventListener('click', () => stepZoom(1.1));
btnZoomOut.addEventListener('click', () => stepZoom(1 / 1.1));

btnFitImage.addEventListener('click', () => updateFraming({ zoom: 1, offsetX: 0, offsetY: 0 }));

btnFillImage.addEventListener('click', () => {
  const source = activeSource();
  if (!source) return;
  updateFraming({ zoom: fillZoomFor(source, outputFrame()), offsetX: 0, offsetY: 0 });
});

btnResetFraming.addEventListener('click', () => updateFraming({ offsetX: 0, offsetY: 0 }));

// Roda do mouse sobre o quadro dá zoom
mediaFrame.addEventListener('wheel', (e) => {
  const framing = framingTarget();
  if (!framing) return;
  e.preventDefault();
  updateFraming({ zoom: framing.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08) });
}, { passive: false });

// Arrastar a foto reposiciona. O deslocamento é convertido para fração do
// quadro, que é a unidade guardada.
let framingDrag = null;

mediaFrame.addEventListener('mousedown', (e) => {
  const framing = framingTarget();
  if (!framing || e.button !== 0) return;
  e.preventDefault();

  const rect = mediaFrame.getBoundingClientRect();
  framingDrag = {
    startX: e.clientX,
    startY: e.clientY,
    baseX: framing.offsetX,
    baseY: framing.offsetY,
    width: rect.width,
    height: rect.height
  };
  mediaFrame.classList.add('dragging');
});

window.addEventListener('mousemove', (e) => {
  if (!framingDrag) return;
  updateFraming({
    offsetX: framingDrag.baseX + (e.clientX - framingDrag.startX) / framingDrag.width,
    offsetY: framingDrag.baseY + (e.clientY - framingDrag.startY) / framingDrag.height
  });
});

window.addEventListener('mouseup', () => {
  if (!framingDrag) return;
  framingDrag = null;
  mediaFrame.classList.remove('dragging');
});

// --- Fundo ---
segmentedBackground.addEventListener('change', () => {
  const checked = segmentedBackground.querySelector('input:checked');
  const framing = framingTarget();
  if (!checked || !framing) return;
  updateFraming({ background: { ...framing.background, mode: checked.value } });
});

inputBgColor.addEventListener('input', () => {
  const framing = framingTarget();
  if (framing) updateFraming({ background: { mode: 'color', color: inputBgColor.value } });
});

colorSwatches.addEventListener('click', (e) => {
  const swatch = e.target.closest('.swatch');
  if (!swatch) return;
  updateFraming({ background: { mode: 'color', color: swatch.dataset.color } });
});

// Cor média da própria foto: o fundo "conversa" com a imagem em vez de brigar.
// A conta é feita no processo principal, via ffmpeg — ler os pixels de um
// arquivo local pelo canvas esbarra na política de origem do navegador.
btnPickFromImage.addEventListener('click', async () => {
  const source = activeSource();
  if (!source || source.kind !== 'image') return;

  btnPickFromImage.disabled = true;
  const original = btnPickFromImage.textContent;
  btnPickFromImage.textContent = 'Lendo...';
  try {
    const color = await window.api.getImageAverageColor(source.path);
    if (color) updateFraming({ background: { mode: 'color', color } });
    else alert('Não foi possível ler a cor predominante desta foto.');
  } finally {
    btnPickFromImage.disabled = false;
    btnPickFromImage.textContent = original;
  }
});

// ==========================================================================
// PAINEL DE EDIÇÃO DO TRECHO (coluna esquerda, aba "Editar Trecho")
//
// Selecionar um bloco na linha do tempo abre este painel apontando para ele.
// Tudo que se edita de um trecho está aqui: recorte, enquadramento e áudio.
// ==========================================================================

function showDock(which) {
  const props = which === 'props';
  tabMedia.classList.toggle('active', !props);
  tabProps.classList.toggle('active', props);
  panelMedia.classList.toggle('hidden', props);
  panelProps.classList.toggle('hidden', !props);
}

tabMedia.addEventListener('click', () => showDock('media'));
tabProps.addEventListener('click', () => {
  if (!tabProps.disabled) showDock('props');
});

function renderPropsPanel() {
  const clip = selectedClip();
  const source = clip ? sourceById(clip.sourceId) : null;
  const text = selectedText();

  tabProps.disabled = !clip && !text;
  propsEmpty.classList.toggle('hidden', !!clip || !!text);
  propsBody.classList.toggle('hidden', !clip && !text);

  // Um título selecionado ocupa o painel inteiro: os controles de trecho não
  // têm o que editar nele, e deixá-los visíveis só confundiria.
  renderTextPanel();
  if (text) {
    [groupTrim, groupTransition, groupFraming, groupAdjust, groupVolume]
      .forEach((g) => g.classList.add('hidden'));
    propsHeadline.innerHTML =
      '<strong>Texto na montagem</strong>' +
      '<span>Aparece por cima de tudo. Arraste no monitor para posicionar.</span>';
    return;
  }

  if (!clip || !source) {
    if (!panelProps.classList.contains('hidden')) showDock('media');
    return;
  }

  const isImage = source.kind === 'image';
  const isAudio = source.kind === 'audio';
  const duration = clipDuration(clip);
  const track = trackById(clip.trackId);
  const many = selectedClipIds.size > 1;

  propsHeadline.innerHTML = many
    ? `<strong>${selectedClipIds.size} trechos selecionados</strong>` +
      `<span>Volume, duplicar e excluir valem para todos. ` +
      `Recorte e enquadramento pedem um só.</span>`
    : `<strong>${escapeHtml(clipLabel(clip))}</strong>` +
      `<span>${escapeHtml(track ? track.name : '—')} · ${escapeHtml(source.name)} · ` +
      `começa em ${formatTime(clip.timelineStart, false)} · ${formatTime(duration)}</span>`;

  // Renomear o trecho aqui é o caminho principal: é onde o nome aparece.
  // Não sobrescreve enquanto o campo está em uso, senão apagaria o que está
  // sendo digitado a cada repintura.
  rowClipName.classList.toggle('hidden', many);
  if (!many && document.activeElement !== inputClipName) {
    inputClipName.value = clipLabel(clip);
  }

  // Recorte, transição e enquadramento são de UM trecho: com vários
  // selecionados eles sairiam errados em todos menos um, então saem de cena.
  groupTrim.classList.toggle('hidden', many);
  if (many) groupTransition.classList.add('hidden');
  else renderTransitionGroup(clip);

  // Foto se ajusta por DURAÇÃO; vídeo e áudio, por início e fim dentro da fonte
  rowClipDuration.classList.toggle('hidden', !isImage);
  inputClipIn.parentElement.classList.toggle('hidden', isImage);
  inputClipOut.parentElement.classList.toggle('hidden', isImage);
  durationPresets.classList.toggle('hidden', !isImage);

  if (isImage) {
    inputClipDuration.value = String(Number(duration.toFixed(3)));
  } else {
    inputClipIn.value = formatTime(clip.start);
    inputClipOut.value = formatTime(clip.end);
  }

  // Enquadramento é geometria de imagem: áudio não tem
  groupFraming.classList.toggle('hidden', isAudio || many);
  // Foto não tem faixa de áudio para regular. Em lote, basta um trecho com som
  // para o controle fazer sentido.
  const anyWithAudio = selectedClips().some((c) => {
    const s = sourceById(c.sourceId);
    return s && s.kind !== 'image';
  });
  groupVolume.classList.toggle('hidden', many ? !anyWithAudio : isImage);

  blurOptionLabel.textContent = isImage ? 'Desfoque da foto' : 'Desfoque do vídeo';

  syncFramingControls();
  syncVolumeControls(clip);
  renderAdjustGroup(clip);
}
// ==========================================================================
// AJUSTES DO TRECHO (velocidade, opacidade, giro, cor, chroma, borrão)
//
// Todos moram no item, e todos aparecem no monitor antes de exportar. A
// prévia usa CSS onde o CSS alcança; o que ele não faz (chroma) é sinalizado
// em vez de mostrar algo diferente do arquivo final.
// ==========================================================================

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

function updateClipAdjust(changes) {
  const clip = selectedClip();
  if (!clip) return;
  Object.assign(clip, changes);
  renderAll();
  commitHistory();
}

function renderAdjustGroup(clip) {
  const source = clip && sourceById(clip.sourceId);
  const isAudio = source && source.kind === 'audio';
  const isImage = source && source.kind === 'image';

  // Áudio não tem imagem para ajustar
  groupAdjust.classList.toggle('hidden', !clip || isAudio);
  if (!clip || isAudio) return;

  const speed = clipSpeed(clip);
  inputSpeed.value = String(Number(speed.toFixed(2)));
  // Foto não tem movimento: a velocidade não muda nada nela
  inputSpeed.disabled = isImage;
  speedPresets.classList.toggle('hidden', isImage);
  speedHint.textContent = isImage
    ? 'Foto não tem velocidade — ajuste a duração no Recorte.'
    : speed === 1
      ? 'Normal. Abaixo de 1x é câmera lenta, acima é acelerado.'
      : `${formatTime((clip.end - clip.start), false)} de material em ` +
        `${formatTime(clipDuration(clip), false)} na montagem.`;

  const opacity = clip.opacity === undefined ? 1 : clip.opacity;
  inputOpacity.value = String(Math.round(opacity * 100));
  opacityReadout.textContent = `${Math.round(opacity * 100)}%`;

  const color = clipColor(clip);
  inputBrightness.value = String(Math.round(color.brightness * 100));
  brightnessReadout.textContent = String(Math.round(color.brightness * 100));
  inputContrast.value = String(Math.round(color.contrast * 100));
  contrastReadout.textContent = String(Math.round(color.contrast * 100));
  inputSaturation.value = String(Math.round(color.saturation * 100));
  saturationReadout.textContent = String(Math.round(color.saturation * 100));

  btnFlipH.classList.toggle('active', !!clip.flipH);
  btnFlipV.classList.toggle('active', !!clip.flipV);

  const chroma = clip.chroma;
  btnChromaToggle.textContent = chroma ? 'Desativar' : 'Ativar';
  btnChromaToggle.classList.toggle('active', !!chroma);
  rowChromaSimilarity.classList.toggle('hidden', !chroma);
  if (chroma) {
    inputChromaColor.value = chroma.color;
    inputChromaSimilarity.value = String(Math.round(chroma.similarity * 100));
    chromaSimilarityReadout.textContent = String(Math.round(chroma.similarity * 100));
  }

  btnBlurRegion.classList.toggle('active', blurRegionArming);
  btnBlurClear.disabled = !clip.blurRegion;
  blurHint.textContent = clip.blurRegion
    ? 'Região marcada. Arraste de novo no monitor para trocar.'
    : blurRegionArming
      ? 'Agora clique e arraste sobre o monitor para marcar a área.'
      : 'Para tapar rosto, placa ou documento. Clique e arraste sobre o monitor.';
}

// --- Velocidade ---
inputSpeed.addEventListener('change', () => {
  const raw = parseFloat(String(inputSpeed.value).replace(',', '.'));
  updateClipAdjust({ speed: clamp(Number.isFinite(raw) ? raw : 1, 0.1, 10) });
});

speedPresets.addEventListener('click', (e) => {
  const button = e.target.closest('.chip-btn');
  if (button) updateClipAdjust({ speed: Number(button.dataset.speed) });
});

// --- Opacidade ---
inputOpacity.addEventListener('input', () => {
  const clip = selectedClip();
  if (!clip) return;
  clip.opacity = Number(inputOpacity.value) / 100;
  opacityReadout.textContent = `${inputOpacity.value}%`;
  renderMonitor();
});
inputOpacity.addEventListener('change', () => { renderAll(); commitHistory(); });

// --- Girar e espelhar ---
btnRotateLeft.addEventListener('click', () => {
  const clip = selectedClip();
  if (clip) updateClipAdjust({ rotate: (((clip.rotate || 0) - 90) + 360) % 360 });
});
btnRotateRight.addEventListener('click', () => {
  const clip = selectedClip();
  if (clip) updateClipAdjust({ rotate: ((clip.rotate || 0) + 90) % 360 });
});
btnFlipH.addEventListener('click', () => {
  const clip = selectedClip();
  if (clip) updateClipAdjust({ flipH: !clip.flipH });
});
btnFlipV.addEventListener('click', () => {
  const clip = selectedClip();
  if (clip) updateClipAdjust({ flipV: !clip.flipV });
});

// --- Cor ---
//
// Enquanto arrasta, só repinta o monitor; o histórico registra no 'change',
// para um arraste inteiro virar uma entrada só.
function applyColorLive() {
  const clip = selectedClip();
  if (!clip) return;
  clip.color = {
    brightness: Number(inputBrightness.value) / 100,
    contrast: Number(inputContrast.value) / 100,
    saturation: Number(inputSaturation.value) / 100
  };
  brightnessReadout.textContent = inputBrightness.value;
  contrastReadout.textContent = inputContrast.value;
  saturationReadout.textContent = inputSaturation.value;
  renderMonitor();
}

[inputBrightness, inputContrast, inputSaturation].forEach((el) => {
  el.addEventListener('input', applyColorLive);
  el.addEventListener('change', () => { renderAll(); commitHistory(); });
});

btnResetColor.addEventListener('click', () => updateClipAdjust({ color: defaultColor() }));

// --- Chroma key ---
btnChromaToggle.addEventListener('click', () => {
  const clip = selectedClip();
  if (!clip) return;
  updateClipAdjust({
    chroma: clip.chroma ? null : { color: inputChromaColor.value, similarity: 0.3, blend: 0.1 }
  });
});

inputChromaColor.addEventListener('input', () => {
  const clip = selectedClip();
  if (!clip || !clip.chroma) return;
  clip.chroma = { ...clip.chroma, color: inputChromaColor.value };
  renderMonitor();
});
inputChromaColor.addEventListener('change', () => { renderAll(); commitHistory(); });

inputChromaSimilarity.addEventListener('input', () => {
  const clip = selectedClip();
  if (!clip || !clip.chroma) return;
  clip.chroma = { ...clip.chroma, similarity: Number(inputChromaSimilarity.value) / 100 };
  chromaSimilarityReadout.textContent = inputChromaSimilarity.value;
});
inputChromaSimilarity.addEventListener('change', () => { renderAll(); commitHistory(); });

btnChromaPick.addEventListener('click', async () => {
  const clip = selectedClip();
  const source = clip && sourceById(clip.sourceId);
  if (!source) return;
  const color = await window.api.getImageAverageColor(source.path);
  if (!color) return;
  inputChromaColor.value = color;
  updateClipAdjust({ chroma: { ...(clip.chroma || { similarity: 0.3, blend: 0.1 }), color } });
});

// --- Borrar região ---
//
// Marcar é um gesto sobre o MONITOR, então o botão só "arma" e o desenho
// acontece lá. A região é guardada em fração do quadro, para valer em
// qualquer resolução de saída.
let blurRegionArming = false;
let blurRegionDrag = null;

btnBlurRegion.addEventListener('click', () => {
  blurRegionArming = !blurRegionArming;
  mediaFrame.classList.toggle('arming-blur', blurRegionArming);
  renderPropsPanel();
});

btnBlurClear.addEventListener('click', () => {
  blurRegionArming = false;
  mediaFrame.classList.remove('arming-blur');
  updateClipAdjust({ blurRegion: null });
});

mediaFrame.addEventListener('mousedown', (e) => {
  if (!blurRegionArming || e.button !== 0) return;
  const clip = selectedClip();
  if (!clip) return;

  const box = selectedMediaBox();
  if (!box || box.width <= 0 || box.height <= 0) return;

  e.preventDefault();
  e.stopPropagation();
  const rect = mediaFrame.getBoundingClientRect();
  blurRegionDrag = { rect, box };
  const first = pointInMedia(e, rect, box);
  blurRegionDrag.x0 = first.x;
  blurRegionDrag.y0 = first.y;
}, true);

// Ponto do mouse convertido em fração da mídia (e não do quadro inteiro)
function pointInMedia(e, rect, box) {
  const frameX = (e.clientX - rect.left) / rect.width;
  const frameY = (e.clientY - rect.top) / rect.height;
  return {
    x: clamp((frameX - box.left) / box.width, 0, 1),
    y: clamp((frameY - box.top) / box.height, 0, 1)
  };
}

window.addEventListener('mousemove', (e) => {
  if (!blurRegionDrag) return;
  const { rect, box, x0, y0 } = blurRegionDrag;
  const point = pointInMedia(e, rect, box);
  const x1 = point.x;
  const y1 = point.y;

  const clip = selectedClip();
  if (!clip) return;
  clip.blurRegion = {
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0)
  };
  renderMonitor();
});

window.addEventListener('mouseup', () => {
  if (!blurRegionDrag) return;
  blurRegionDrag = null;
  blurRegionArming = false;
  mediaFrame.classList.remove('arming-blur');

  const clip = selectedClip();
  // Um clique sem arrastar não vira região: seria um borrão invisível
  if (clip && clip.blurRegion && (clip.blurRegion.w < 0.02 || clip.blurRegion.h < 0.02)) {
    clip.blurRegion = null;
  }
  renderAll();
  commitHistory();
});

// Traduz os ajustes do trecho para CSS, para o monitor mostrar o mesmo que o
// arquivo vai ter. O chroma não tem equivalente em CSS e fica de fora — a
// legenda avisa, em vez de mostrar algo que não corresponde.
function cssFiltersFor(clip) {
  if (!clip) return '';
  const color = clipColor(clip);
  const parts = [];
  if (color.brightness !== 0) parts.push(`brightness(${1 + color.brightness})`);
  if (color.contrast !== 1) parts.push(`contrast(${color.contrast})`);
  if (color.saturation !== 1) parts.push(`saturate(${color.saturation})`);
  return parts.join(' ');
}

function cssTransformFor(clip) {
  if (!clip) return '';
  const parts = [];
  if (clip.rotate) parts.push(`rotate(${clip.rotate}deg)`);
  if (clip.flipH) parts.push('scaleX(-1)');
  if (clip.flipV) parts.push('scaleY(-1)');
  return parts.join(' ');
}

// Aplica os ajustes ao elemento que está no monitor
function applyClipVisuals(element, clip) {
  if (!element) return;
  element.style.filter = cssFiltersFor(clip);
  element.style.opacity = clip && clip.opacity !== undefined ? String(clip.opacity) : '';

  // Girar 90° troca as dimensões; o elemento já é posicionado com a proporção
  // final calculada, então basta a rotação visual sobre o próprio centro.
  const transform = cssTransformFor(clip);
  element.style.transform = transform;
  element.style.transformOrigin = 'center center';
}

// Retângulo do borrão desenhado sobre o monitor.
//
// A região é guardada em fração da MÍDIA, não do quadro: é onde o ffmpeg
// aplica o borrão. Com tarja preta ou zoom, os dois não coincidem, então o
// desenho passa pela caixa da mídia (`layout`) para cair no mesmo lugar que
// vai sair no arquivo.
function renderBlurRegionOverlay(clip, layout) {
  const region = clip && clip.blurRegion;
  blurRegionBox.classList.toggle('hidden', !region || !layout);
  if (!region || !layout) return;
  blurRegionBox.style.left = `${layout.left + region.x * layout.width}%`;
  blurRegionBox.style.top = `${layout.top + region.y * layout.height}%`;
  blurRegionBox.style.width = `${region.w * layout.width}%`;
  blurRegionBox.style.height = `${region.h * layout.height}%`;
}

// Caixa da mídia do trecho selecionado, em fração do quadro. Usada para
// converter o gesto do mouse (que acontece sobre o quadro) em coordenadas
// da mídia.
function selectedMediaBox() {
  const clip = selectedClip();
  const source = clip && sourceById(clip.sourceId);
  if (!source) return null;
  const layout = framingLayout(source, clip.framing || defaultFraming(), outputFrame(), clip.rotate);
  return {
    left: layout.left / 100, top: layout.top / 100,
    width: layout.width / 100, height: layout.height / 100
  };
}

function syncVolumeControls(clip) {
  const volume = clip.volume === undefined ? 1 : clip.volume;
  const muted = !!clip.muted;
  inputItemVolume.value = String(Math.round(volume * 100));
  inputItemVolume.disabled = muted;
  itemVolumeReadout.textContent = muted ? 'mudo' : `${Math.round(volume * 100)}%`;
  btnItemMute.classList.toggle('off', muted);
  inputNormalize.checked = !!clip.normalize;
}

// ==========================================================================
// ÁUDIO: ONDA SONORA, NORMALIZAR E ISOLAR FAIXA (SOLO)
// ==========================================================================

// --- Isolar faixa (solo) ---
//
// Solo mexe só no SOM. Desligar a faixa (o outro botão) tira o item inteiro do
// vídeo; isolar serve para conferir uma trilha sem perder a imagem de vista.
const anyTrackSoloed = () => tracks.some((t) => t.solo);

// Faixa que não se ouve: ou está desligada, ou alguém está isolado e não é ela.
const trackIsSilent = (track) =>
  !!track && (!!track.muted || (anyTrackSoloed() && !track.solo));

function toggleTrackSolo(trackId) {
  const track = trackById(trackId);
  if (!track) return;
  track.solo = !track.solo;
  renderAll();
  commitHistory();
}

// --- Normalizar volume ---
inputNormalize.addEventListener('change', () => {
  const targets = selectedClips();
  if (!targets.length) return;
  targets.forEach((clip) => { clip.normalize = inputNormalize.checked; });
  renderAll();
  commitHistory();
});

// --- Onda sonora ---
//
// Os picos vêm do ffmpeg (envoltória em 1200 baldes cobrindo a mídia inteira) e
// ficam guardados na fonte. Um bloco desenha só a fatia dele: como os baldes
// cobrem o arquivo todo, recortar é uma regra de três, sem reler o áudio.
const peaksPending = new Set();

function requestPeaks(source) {
  if (!source || source.kind === 'image') return;
  if (source.peaks !== undefined || peaksPending.has(source.id)) return;
  if (source.kind === 'video' && !source.hasAudio) {
    source.peaks = null;
    return;
  }

  peaksPending.add(source.id);
  window.api.getAudioPeaks(source.path).then((peaks) => {
    peaksPending.delete(source.id);
    source.peaks = peaks || null;   // null = mídia sem áudio; não tenta de novo
    if (peaks) renderTimeline();
  }).catch(() => {
    peaksPending.delete(source.id);
    source.peaks = null;
  });
}

// Desenha a onda do trecho dentro do bloco. O canvas é criado com a largura em
// pixels de verdade (limitada), para a onda não sair borrada nem custar caro
// com a linha do tempo muito ampliada.
const WAVE_MAX_WIDTH = 1600;

function drawClipWaveform(canvas, clip, source, widthPx, heightPx) {
  const peaks = source && source.peaks;
  if (!peaks || !peaks.length || widthPx < 4) return false;

  const duration = source.duration || 0;
  if (duration <= 0) return false;

  const width = Math.min(WAVE_MAX_WIDTH, Math.max(4, Math.round(widthPx)));
  const height = Math.max(8, Math.round(heightPx));
  canvas.width = width;
  canvas.height = height;

  // Fatia dos baldes que corresponde ao recorte do trecho
  const from = Math.floor((clip.start / duration) * peaks.length);
  const to = Math.ceil((clip.end / duration) * peaks.length);
  const slice = Math.max(1, to - from);

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.38)';

  const middle = height / 2;
  for (let x = 0; x < width; x++) {
    const a = from + Math.floor((x / width) * slice);
    const b = from + Math.max(a + 1, Math.floor(((x + 1) / width) * slice));

    let peak = 0;
    for (let i = a; i < b && i < peaks.length; i++) {
      if (peaks[i] > peak) peak = peaks[i];
    }
    const half = Math.max(0.5, (peak / 100) * middle);
    ctx.fillRect(x, middle - half, 1, half * 2);
  }
  return true;
}

// --- Recorte ---
//
// Mexer no início dentro da fonte NÃO deve arrastar o trecho no tempo: quem
// posiciona é a linha do tempo. Só a duração muda.
function applyTrimFromFields() {
  const clip = selectedClip();
  const source = clip && sourceById(clip.sourceId);
  if (!clip || !source || source.kind === 'image') return;

  const limit = source.duration || Infinity;
  let start = clamp(parseTimeToSeconds(inputClipIn.value), 0, limit);
  let end = clamp(parseTimeToSeconds(inputClipOut.value), 0, limit);

  if (end - start < MIN_CLIP_DURATION) end = Math.min(limit, start + MIN_CLIP_DURATION);
  clip.start = start;
  clip.end = end;
  renderAll();
  commitHistory();
}

inputClipIn.addEventListener('change', applyTrimFromFields);
inputClipOut.addEventListener('change', applyTrimFromFields);

// --- Renomear o TRECHO ---
//
// O nome fica no item, não na mídia: o mesmo vídeo pode entrar cinco vezes na
// montagem com nomes diferentes ("abertura", "depoimento", "encerramento").
// Sem nome próprio, ele mostra o nome do arquivo de origem.
const clipLabel = (clip) => {
  if (clip && clip.name) return clip.name;
  const source = clip && sourceById(clip.sourceId);
  return source ? stripExtension(source.name) : '—';
};

function applyClipNameFromField() {
  const clip = selectedClip();
  if (!clip) return;

  const wanted = inputClipName.value.trim();
  // Vazio devolve o nome do arquivo: é o jeito de "limpar" um apelido
  const next = wanted || null;
  if (next === (clip.name || null)) {
    inputClipName.value = clipLabel(clip);
    return;
  }
  clip.name = next;
  renderAll();
  commitHistory();
}

inputClipName.addEventListener('change', applyClipNameFromField);
inputClipName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    // Aplica direto em vez de contar com o blur: o evento 'change' só dispara
    // quando o próprio usuário sujou o campo, o que torna o caminho frágil.
    applyClipNameFromField();
    inputClipName.blur();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    const clip = selectedClip();
    if (clip) inputClipName.value = clipLabel(clip);
    inputClipName.blur();
  }
});

// ==========================================================================
// TRANSIÇÕES
//
// Uma transição é a SOBREPOSIÇÃO entre dois trechos vizinhos da mesma faixa:
// os dois se misturam durante aquele tempo. Guardar assim, e não como um item
// próprio, mantém uma verdade só na linha do tempo — o que se vê (os blocos
// encostados ou sobrepostos) é exatamente o que a exportação faz.
//
// A consequência precisa estar clara na tela: a montagem ENCURTA pelo tempo da
// transição, porque os dois trechos passam a ocupar o mesmo instante.
// ==========================================================================

const transitionLabel = (id) => {
  const found = TRANSITIONS.find((t) => t.id === id);
  return found ? found.label.replace(' (padrão)', '') : id;
};

const TRANSITIONS = [
  { id: 'fade', label: 'Dissolver (padrão)' },
  { id: 'fadeblack', label: 'Passar pelo preto' },
  { id: 'fadewhite', label: 'Passar pelo branco' },
  { id: 'dissolve', label: 'Dissolver granulado' },
  { id: 'wipeleft', label: 'Cortina para a esquerda' },
  { id: 'wiperight', label: 'Cortina para a direita' },
  { id: 'wipeup', label: 'Cortina para cima' },
  { id: 'wipedown', label: 'Cortina para baixo' },
  { id: 'slideleft', label: 'Deslizar para a esquerda' },
  { id: 'slideright', label: 'Deslizar para a direita' },
  { id: 'circleopen', label: 'Círculo abrindo' },
  { id: 'circleclose', label: 'Círculo fechando' },
  { id: 'radial', label: 'Radial' },
  { id: 'smoothleft', label: 'Suave para a esquerda' },
  { id: 'smoothright', label: 'Suave para a direita' },
  { id: 'pixelize', label: 'Pixelizar' }
];

TRANSITIONS.forEach((t) => {
  const option = document.createElement('option');
  option.value = t.id;
  option.textContent = t.label;
  selectTransition.appendChild(option);
});

// O trecho imediatamente anterior na mesma faixa (o outro lado da emenda)
function previousOnTrack(clip) {
  const siblings = itemsOfTrack(clip.trackId);
  const index = siblings.findIndex((c) => c.id === clip.id);
  return index > 0 ? siblings[index - 1] : null;
}

// Quanto os dois se sobrepõem hoje = duração da transição
function transitionDuration(clip) {
  const previous = previousOnTrack(clip);
  if (!previous) return 0;
  return Math.max(0, clipEnd(previous) - clip.timelineStart);
}

// Limite: a transição não pode engolir nenhum dos dois trechos
function maxTransitionFor(clip) {
  const previous = previousOnTrack(clip);
  if (!previous) return 0;
  const shorter = Math.min(clipDuration(previous), clipDuration(clip));
  return Math.max(0, shorter - MIN_CLIP_DURATION);
}

// Ajustar a transição reposiciona ESTE trecho e empurra os seguintes da faixa,
// mantendo o encadeamento — senão abriria um buraco atrás dele.
function setTransition(clip, seconds, type) {
  const previous = previousOnTrack(clip);
  if (!previous) return;

  const wanted = clamp(seconds, 0, maxTransitionFor(clip));
  const target = clipEnd(previous) - wanted;
  const shift = target - clip.timelineStart;

  itemsOfTrack(clip.trackId).forEach((other) => {
    if (other.timelineStart >= clip.timelineStart - 0.0001) {
      other.timelineStart = Math.max(0, other.timelineStart + shift);
    }
  });

  clip.transition = wanted > 0 ? (type || clip.transition || 'fade') : null;
  renderAll();
  commitHistory();
}

function renderTransitionGroup(clip) {
  const previous = clip ? previousOnTrack(clip) : null;
  const source = clip && sourceById(clip.sourceId);
  const isAudio = source && source.kind === 'audio';

  // Sem trecho anterior não há emenda; em áudio, a mistura é o crossfade que o
  // próprio motor aplica, sem escolha de efeito visual.
  groupTransition.classList.toggle('hidden', !previous || isAudio);
  if (!previous || isAudio) return;

  const current = transitionDuration(clip);
  inputTransitionDuration.value = String(Number(current.toFixed(2)));
  inputTransitionDuration.max = String(Number(maxTransitionFor(clip).toFixed(2)));
  selectTransition.value = clip.transition || 'fade';
  selectTransition.disabled = current <= 0;

  transitionHint.textContent = current > 0
    ? `A montagem fica ${formatTime(current)} mais curta por causa desta transição.`
    : 'Duração 0 = corte seco. Aumente para os trechos se misturarem.';
}

inputTransitionDuration.addEventListener('change', () => {
  const clip = selectedClip();
  if (!clip) return;
  const raw = parseFloat(String(inputTransitionDuration.value).replace(',', '.'));
  setTransition(clip, Number.isFinite(raw) ? raw : 0, selectTransition.value);
});

selectTransition.addEventListener('change', () => {
  const clip = selectedClip();
  if (!clip) return;
  clip.transition = selectTransition.value;
  renderAll();
  commitHistory();
});

// F2 leva direto ao campo do nome, como nos gerenciadores de arquivo
function focusClipRename() {
  const clip = selectedClip();
  if (!clip) return;
  showDock('props');
  renderPropsPanel();
  inputClipName.focus();
  inputClipName.select();
}

// "Usar a posição da agulha": converte o instante da montagem para um instante
// DENTRO da fonte, que é a unidade dos campos de recorte.
function playheadInsideClip(clip) {
  return clip.start + clamp(playhead - clip.timelineStart, 0, clipDuration(clip));
}

btnClipInHere.addEventListener('click', () => {
  const clip = selectedClip();
  if (!clip || isImageClip(clip)) return;
  inputClipIn.value = formatTime(playheadInsideClip(clip));
  applyTrimFromFields();
});

btnClipOutHere.addEventListener('click', () => {
  const clip = selectedClip();
  if (!clip || isImageClip(clip)) return;
  inputClipOut.value = formatTime(playheadInsideClip(clip));
  applyTrimFromFields();
});

inputClipDuration.addEventListener('change', () => {
  const clip = selectedClip();
  if (!clip) return;
  const raw = parseFloat(String(inputClipDuration.value).replace(',', '.'));
  const seconds = clamp(Number.isFinite(raw) ? raw : DEFAULT_IMAGE_DURATION, MIN_CLIP_DURATION, MAX_IMAGE_DURATION);
  setClipDuration(clip.id, seconds);
});

durationPresets.addEventListener('click', (e) => {
  const button = e.target.closest('.chip-btn');
  const clip = selectedClip();
  if (!button || !clip) return;
  setClipDuration(clip.id, Number(button.dataset.seconds));
});

// --- Áudio do trecho ---
// Volume e mudo valem para todo o conjunto: ajustar cinco trechos um a um
// seria justamente o que a seleção múltipla existe para evitar.
inputItemVolume.addEventListener('input', () => {
  const chosen = selectedClips();
  if (chosen.length === 0) return;
  const volume = Number(inputItemVolume.value) / 100;
  chosen.forEach((c) => { c.volume = volume; });
  syncVolumeControls(selectedClip() || chosen[0]);
  renderTimeline();
  applyMonitorAudio();
});

btnItemMute.addEventListener('click', () => {
  const chosen = selectedClips();
  if (chosen.length === 0) return;
  const muted = !(selectedClip() || chosen[0]).muted;
  chosen.forEach((c) => { c.muted = muted; });
  syncVolumeControls(selectedClip() || chosen[0]);
  renderTimeline();
  applyMonitorAudio();
});

// --- Ferramentas da linha do tempo ---
// Excluir e duplicar valem para TODO o conjunto selecionado
btnClipDelete.addEventListener('click', () => {
  const chosen = selectedClips();
  if (chosen.length === 0) return;
  const ids = new Set(chosen.map((c) => c.id));
  clips = clips.filter((c) => !ids.has(c.id));
  selectItem(null);
  playhead = clamp(playhead, 0, sequenceDuration());
  renderAll();
  commitHistory();
});

btnClipDuplicate.addEventListener('click', () => {
  // Do último para o primeiro: duplicar empurra o que vem depois na faixa, e
  // ir de trás para frente evita que um deslocamento afete os ainda por copiar.
  selectedClips()
    .sort((a, b) => b.timelineStart - a.timelineStart)
    .forEach((clip) => duplicateClip(clip.id));
});

// Dividir corta o trecho no ponto da agulha, gerando dois itens encostados.
// A parte da direita continua de onde a esquerda parou DENTRO da fonte, senão
// a emenda repetiria conteúdo.
btnSplit.addEventListener('click', splitSelectedAtPlayhead);

function splitSelectedAtPlayhead() {
  const clip = selectedClip();
  if (!clip) return;

  const offset = playhead - clip.timelineStart;
  if (offset < MIN_CLIP_DURATION || offset > clipDuration(clip) - MIN_CLIP_DURATION) return;

  const cutInSource = clip.start + offset;

  clipIdCounter++;
  const right = {
    ...clip,
    id: clipIdCounter,
    timelineStart: clip.timelineStart + offset,
    start: cutInSource,
    end: clip.end,
    framing: cloneFraming(clip.framing || defaultFraming())
  };
  clip.end = cutInSource;

  clips.push(right);
  selectItem(right.id);
  renderAll();
  commitHistory();
}

// Só faz sentido dividir com a agulha DENTRO do trecho selecionado
function canSplitSelected() {
  const clip = selectedClip();
  if (!clip) return false;
  const offset = playhead - clip.timelineStart;
  return offset >= MIN_CLIP_DURATION && offset <= clipDuration(clip) - MIN_CLIP_DURATION;
}

// A importação acontece na coluna da biblioteca, então o aviso de progresso
// mora ali — sem esconder o monitor, que continua mostrando a montagem.
function showLoading(title, subtitle) {
  loadingTitle.textContent = title;
  loadingSubtitle.textContent = subtitle || '';
  loadingPreview.classList.remove('hidden');
}

function hideLoading() {
  loadingPreview.classList.add('hidden');
}

function resetEditorState() {
  stopMonitor();
  videoElement.pause();
  videoElement.src = '';
  imageElement.src = '';
  imageElement.classList.add('hidden');
  videoElement.classList.remove('hidden');
  videoBgElement.classList.add('hidden');
  overlayLayers.innerHTML = '';

  sources = [];
  clips = [];
  texts = [];
  textIdCounter = 0;
  selectedTextId = null;
  initTracks();
  activeSourceId = null;
  playhead = 0;
  lastExportTarget = null;
  lastExportedEditorSignature = null;
  editingClipId = null;
  selectItem(null);

  showDock('media');
  hideLoading();
  inputOutputName.value = '';

  // Zerar o editor também zera o vínculo com o arquivo de projeto: o que ficar
  // na tela a partir daqui é uma montagem nova, não o projeto que estava aberto.
  projectPath = null;
  savedSnapshot = null;

  closeModal(exportModal);
  renderAll();
  resetHistory();
}
// ==========================================================================
// ITENS DA MONTAGEM
// ==========================================================================

// Faixa que pode receber a mídia: áudio só entra em faixa de áudio, e
// vídeo/foto só em faixa de vídeo.
const trackAccepts = (track, source) =>
  !!track && !!source && track.kind === (source.kind === 'audio' ? 'audio' : 'video');

function targetTrackFor(source) {
  const current = activeTrack();
  if (trackAccepts(current, source)) return current;

  const wanted = source.kind === 'audio' ? 'audio' : 'video';
  return tracks.find((t) => t.kind === wanted) || createTrack(wanted);
}

// Onde encaixar um item novo: logo depois do último item daquela faixa.
function appendPositionFor(trackId) {
  const items = itemsOfTrack(trackId);
  return items.length === 0 ? 0 : clipEnd(items[items.length - 1]);
}

// Duração inicial de uma mídia recém-solta na linha do tempo: o vídeo e o áudio
// entram INTEIROS (aparar é feito depois, na linha do tempo ou no painel), e a
// foto entra com a duração padrão.
function initialSpanFor(source) {
  if (source.kind === 'image') return { start: 0, end: DEFAULT_IMAGE_DURATION };
  return { start: 0, end: source.duration || DEFAULT_IMAGE_DURATION };
}

/**
 * Cria um item na linha do tempo a partir de uma mídia da biblioteca.
 * É o ponto único de entrada — usado pelo arraste e pelo duplo clique.
 */
function addItemFromSource(sourceId, trackId, timelineStart) {
  const source = sourceById(sourceId);
  if (!source) return null;

  const track = trackAccepts(trackById(trackId), source)
    ? trackById(trackId)
    : targetTrackFor(source);

  const span = initialSpanFor(source);
  clipIdCounter++;
  const clip = {
    id: clipIdCounter,
    trackId: track.id,
    sourceId: source.id,
    timelineStart: Math.max(0, timelineStart === undefined ? appendPositionFor(track.id) : timelineStart),
    start: span.start,
    end: span.end,
    framing: defaultFraming(),
    volume: 1,
    muted: false
  };

  clips.push(clip);
  activeTrackId = track.id;
  selectItem(clip.id);
  renderAll();
  commitHistory();
  return clip;
}


// Duração de um trecho de foto já na sequência, editável direto na lista
function setClipDuration(clipId, seconds) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;
  clip.end = clip.start + clamp(seconds, MIN_CLIP_DURATION, MAX_IMAGE_DURATION);
  renderAll();
  commitHistory();
}

function removeClip(clipId) {
  clips = clips.filter((c) => c.id !== clipId);
  selectedClipIds.delete(clipId);
  if (selectedClipId === clipId) selectItem(null);
  if (editingClipId === clipId) editingClipId = null;
  renderAll();
  commitHistory();
}

// Duplica logo DEPOIS do original no tempo, empurrando o que vinha a seguir na
// mesma faixa — senão a cópia nasceria exatamente sobre o original.
function duplicateClip(clipId) {
  const original = clips.find((c) => c.id === clipId);
  if (!original) return;

  const duration = clipDuration(original);
  const insertAt = clipEnd(original);

  itemsOfTrack(original.trackId).forEach((item) => {
    if (item.timelineStart >= insertAt - 0.001) item.timelineStart += duration;
  });

  clipIdCounter++;
  clips.push({
    ...original,
    id: clipIdCounter,
    timelineStart: insertAt,
    framing: cloneFraming(original.framing || defaultFraming())
  });
  selectItem(clipIdCounter);
  renderAll();
  commitHistory();
}

// Troca de lugar no TEMPO com o vizinho da mesma faixa. Com posições livres, a
// ordem do array deixou de significar algo — o que se troca são os instantes.
function moveClip(clipId, offset) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;

  const siblings = itemsOfTrack(clip.trackId);
  const index = siblings.findIndex((c) => c.id === clipId);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= siblings.length) return;

  const other = siblings[target];
  const clipStart = clip.timelineStart;
  const otherStart = other.timelineStart;

  // Preserva o encadeamento: o que vinha primeiro continua começando onde o
  // primeiro começava, mesmo que as durações sejam diferentes.
  if (offset < 0) {
    clip.timelineStart = otherStart;
    other.timelineStart = otherStart + clipDuration(clip);
  } else {
    other.timelineStart = clipStart;
    clip.timelineStart = clipStart + clipDuration(other);
  }
  renderAll();
}

// Move um item no tempo, sem deixar entrar em terreno negativo
function setClipPosition(clipId, seconds) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;
  clip.timelineStart = Math.max(0, seconds);
  renderAll();
}

// Troca um item de faixa (só entre faixas do mesmo tipo)
function setClipTrack(clipId, trackId) {
  const clip = clips.find((c) => c.id === clipId);
  const track = trackById(trackId);
  const source = clip && sourceById(clip.sourceId);
  if (!clip || !track || !source) return;

  const wanted = source.kind === 'audio' ? 'audio' : 'video';
  if (track.kind !== wanted) return;

  clip.trackId = trackId;
  renderAll();
}

// Levar a agulha para o começo do trecho é o equivalente a "ver este trecho":
// o monitor mostra a montagem, então basta posicionar.
function playClip(clip) {
  seekTimeline(clip.timelineStart);
}

// ==========================================================================
// LINHA DO TEMPO EM FAIXAS (interface)
//
// Uma linha por faixa, itens como blocos posicionados por timelineStart. As
// posições na tela saem sempre de `pixelsPerSecond`, então mudar o zoom não
// exige recalcular nada guardado — só repintar.
// ==========================================================================

const TRACK_ROW_HEIGHT = 46;
const SNAP_PIXELS = 7;          // imã das bordas, em pixels de tela
const HANDLE_HIT_PIXELS = 8;    // largura da zona de aparar

const secondsToPx = (seconds) => seconds * pixelsPerSecond;
const pxToSeconds = (px) => px / pixelsPerSecond;

// Selecionar um bloco é o gesto de "quero mexer neste": abre o painel de
// edição apontando para ele. `editingClipId` acompanha para o enquadramento
// e o áudio nunca divergirem do que está selecionado.
//
// `selectedClipId` é o trecho PRINCIPAL (o último clicado) — é dele que o
// painel mostra recorte e enquadramento. `selectedClipIds` é o conjunto todo,
// usado pelas ações que fazem sentido em lote: mover, excluir, duplicar,
// volume.
//
//   modo 'toggle' (Ctrl) : acrescenta ou tira um do conjunto
//   modo 'range'  (Shift): pega tudo entre o principal e o clicado, na faixa
function selectItem(clipId, mode) {
  // Trecho e texto não convivem selecionados: o painel mostra um de cada vez
  if (clipId !== null) selectedTextId = null;

  if (clipId === null) {
    selectedClipIds.clear();
    selectedClipId = null;
    editingClipId = null;
    return;
  }

  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;

  if (mode === 'toggle') {
    if (selectedClipIds.has(clipId) && selectedClipIds.size > 1) {
      selectedClipIds.delete(clipId);
      // O principal saiu do conjunto: promove qualquer um dos que restaram
      if (selectedClipId === clipId) selectedClipId = [...selectedClipIds][0];
      editingClipId = selectedClipId;
      return;
    }
    selectedClipIds.add(clipId);
  } else if (mode === 'range' && selectedClipId !== null) {
    const anchor = clips.find((c) => c.id === selectedClipId);
    // Intervalo só faz sentido dentro de uma faixa: entre faixas diferentes
    // "o que está no meio" seria ambíguo, então ali só acrescenta.
    if (anchor && anchor.trackId === clip.trackId) {
      const siblings = itemsOfTrack(clip.trackId);
      const from = siblings.findIndex((c) => c.id === anchor.id);
      const to = siblings.findIndex((c) => c.id === clipId);
      siblings.slice(Math.min(from, to), Math.max(from, to) + 1)
        .forEach((c) => selectedClipIds.add(c.id));
    } else {
      selectedClipIds.add(clipId);
    }
  } else {
    selectedClipIds.clear();
    selectedClipIds.add(clipId);
  }

  selectedClipId = clipId;
  editingClipId = clipId;
  showDock('props');

  // Traz a agulha para dentro do trecho quando ela está fora dele. Sem isso o
  // monitor mostrava OUTRO trecho enquanto você editava este — dava a impressão
  // de que o ajuste não estava valendo.
  if (playhead < clip.timelineStart || playhead >= clipEnd(clip)) {
    playhead = clamp(clip.timelineStart, 0, sequenceDuration());
    stopMonitor();
  }
}

// Trechos do conjunto que ainda existem
const selectedClips = () =>
  clips.filter((c) => selectedClipIds.has(c.id));

const selectedClip = () => clips.find((c) => c.id === selectedClipId) || null;

// Largura útil: a duração da montagem com uma folga, e nunca menor que a área
// visível — assim sempre há espaço para arrastar um item para frente.
function timelineWidthPx() {
  const withPadding = secondsToPx(sequenceDuration() + 4);
  return Math.max(withPadding, timelineScroll.clientWidth || 600);
}

// Intervalo entre marcas da régua, escolhido para não virar um borrão em zoom
// baixo nem ficar esparso em zoom alto.
function rulerStep() {
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  return candidates.find((step) => secondsToPx(step) >= 55) || 900;
}

function renderRuler(width) {
  timelineRuler.innerHTML = '';
  timelineRuler.style.width = `${width}px`;

  const step = rulerStep();
  const last = pxToSeconds(width);
  for (let t = 0; t <= last; t += step) {
    const mark = document.createElement('div');
    mark.className = 'ruler-mark';
    mark.style.left = `${secondsToPx(t)}px`;
    mark.textContent = formatTime(t, false);
    timelineRuler.appendChild(mark);
  }
}

function renderTrackHeaders() {
  // O canto vazio alinha a coluna de nomes com a régua
  // O canto vazio alinha com a régua, e logo abaixo vem a pista de texto —
  // ela precisa nascer aqui porque este bloco é reconstruído a cada render.
  trackHeaders.innerHTML =
    '<div class="ruler-corner"></div>' +
    '<div class="text-lane-header" title="Títulos e legendas">T</div>';

  // De cima para baixo na tela: as faixas de vídeo em ordem inversa (a de cima
  // é a que fica SOBRE as outras), depois as de áudio.
  displayTracks().forEach((track) => {
    const header = document.createElement('div');
    header.className = 'track-header' + (track.id === activeTrackId ? ' active' : '');
    header.title = track.kind === 'audio'
      ? 'Faixa de áudio — soma ao som do vídeo'
      : 'Faixa de vídeo — as de cima aparecem sobre as de baixo';

    const count = clips.filter((c) => c.trackId === track.id).length;
    header.innerHTML = `
      <span class="track-name">${escapeHtml(track.name)}<br><small>${count} item(ns)</small></span>
      <button class="track-solo ${track.solo ? 'on' : ''}"
              title="${track.solo ? 'Voltar a ouvir todas as faixas' : 'Ouvir só esta faixa (isolar)'}">S</button>
      <button class="track-toggle ${track.muted ? 'off' : ''}" title="${track.muted ? 'Ligar faixa' : 'Desligar faixa'}">
        ${track.muted ? '✕' : '●'}
      </button>
    `;

    // Reordenar a pilha: a faixa mais acima na tela é a que aparece por cima
    // no vídeo. Sem isto a prioridade ficava presa à ordem de criação.
    const order = document.createElement('div');
    order.className = 'track-order';
    const sameKind = tracks.filter((t) => t.kind === track.kind);
    const position = sameKind.findIndex((t) => t.id === track.id);
    order.innerHTML =
      `<button class="up" title="Subir na pilha" ${position === sameKind.length - 1 ? 'disabled' : ''}>▲</button>` +
      `<button class="down" title="Descer na pilha" ${position === 0 ? 'disabled' : ''}>▼</button>`;
    order.querySelector('.up').addEventListener('click', (e) => {
      e.stopPropagation();
      moveTrack(track.id, 1);
    });
    order.querySelector('.down').addEventListener('click', (e) => {
      e.stopPropagation();
      moveTrack(track.id, -1);
    });
    header.insertBefore(order, header.firstChild);

    // Clicar no cabeçalho só troca a faixa ativa. O destaque é aplicado sem
    // redesenhar: um `renderTimeline()` aqui destruía o campo de renomear no
    // meio do duplo clique — o primeiro clique reconstruía tudo e o segundo
    // caía num elemento que já não existia.
    header.addEventListener('click', () => {
      activeTrackId = track.id;
      trackHeaders.querySelectorAll('.track-header')
        .forEach((h) => h.classList.toggle('active', h === header));
    });

    // Duplo clique no nome renomeia a faixa, ali mesmo
    header.querySelector('.track-name').addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startTrackRename(track, header);
    });
    header.querySelector('.track-toggle').addEventListener('click', (e) => {
      e.stopPropagation();
      track.muted = !track.muted;
      renderAll();
      commitHistory();
    });
    header.querySelector('.track-solo').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleTrackSolo(track.id);
    });

    // Só permite remover faixas extras: a base e a primeira de áudio ficam
    if (canRemoveTrack(track)) {
      const remove = document.createElement('button');
      remove.className = 'track-toggle';
      remove.title = 'Remover faixa (e os itens dela)';
      remove.innerHTML = ICON_X;
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        removeTrack(track.id);
      });
      header.appendChild(remove);
    }

    trackHeaders.appendChild(header);
  });
}

// Ordem de exibição: vídeo de cima para baixo (invertida em relação ao
// empilhamento, porque quem está "sobre" aparece acima na tela), áudio no fim.
const displayTracks = () => [...videoTracks()].reverse().concat(audioTracks());

const canRemoveTrack = (track) => {
  const sameKind = tracks.filter((t) => t.kind === track.kind);
  return sameKind.length > 1 && sameKind[0].id !== track.id;
};

// Renomear a faixa no próprio cabeçalho: um campo por cima do nome, que some
// ao confirmar (Enter ou sair) ou ao desistir (Esc).
function startTrackRename(track, header) {
  const label = header.querySelector('.track-name');
  const input = document.createElement('input');
  input.className = 'track-rename';
  input.value = track.name;
  input.maxLength = 24;

  label.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const wanted = input.value.trim();
    if (save && wanted && wanted !== track.name) {
      track.name = wanted;
      commitHistory();
    }
    renderAll();
  };

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();                 // não deixa o atalho global reagir
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
}

// Troca a faixa de lugar na pilha, com a vizinha do MESMO tipo. `offset` +1
// sobe (aparece por cima), -1 desce. A ordem em `tracks` é a ordem de
// empilhamento, e a exportação lê dali — mudar aqui muda o vídeo final.
function moveTrack(trackId, offset) {
  const track = trackById(trackId);
  if (!track) return;

  const sameKind = tracks.filter((t) => t.kind === track.kind);
  const from = sameKind.findIndex((t) => t.id === trackId);
  const to = from + offset;
  if (from === -1 || to < 0 || to >= sameKind.length) return;

  const other = sameKind[to];
  const indexA = tracks.indexOf(track);
  const indexB = tracks.indexOf(other);
  tracks[indexA] = other;
  tracks[indexB] = track;

  renderAll();
  commitHistory();
}

function removeTrack(trackId) {
  const items = clips.filter((c) => c.trackId === trackId).length;
  if (items > 0 && !confirm(`Esta faixa tem ${items} item(ns). Remover a faixa remove os itens dela. Continuar?`)) {
    return;
  }
  clips = clips.filter((c) => c.trackId !== trackId);
  tracks = tracks.filter((t) => t.id !== trackId);
  if (activeTrackId === trackId) activeTrackId = (baseTrack() || {}).id || null;
  if (!clips.some((c) => c.id === selectedClipId)) selectItem(null);
  renderAll();
  commitHistory();
}

function renderTimeline() {
  const width = timelineWidthPx();
  timelineInner.style.width = `${width}px`;

  renderRuler(width);
  renderTrackHeaders();
  renderTextLane();
  syncHeaderGutter();

  timelineRows.innerHTML = '';
  timelineEmpty.classList.toggle('hidden', clips.length > 0);
  timelineTotal.textContent = formatTime(sequenceDuration());

  displayTracks().forEach((track) => {
    const row = document.createElement('div');
    row.className = 'timeline-row' + (track.kind === 'audio' ? ' audio' : '');
    row.style.width = `${width}px`;
    row.dataset.trackId = track.id;
    // Grade de fundo alinhada com a régua
    row.style.backgroundSize = `${secondsToPx(rulerStep())}px 100%`;

    itemsOfTrack(track.id).forEach((clip) => {
      row.appendChild(buildTimelineItem(clip, track));

      // Marca visual na emenda com transição, para ela não ficar invisível
      const overlap = transitionDuration(clip);
      if (overlap > 0.02) {
        const mark = document.createElement('div');
        mark.className = 'tl-transition';
        mark.style.left = `${secondsToPx(clip.timelineStart)}px`;
        mark.style.width = `${Math.max(4, secondsToPx(overlap))}px`;
        mark.title = `Transição de ${formatTime(overlap)} (${clip.transition || 'fade'})`;
        mark.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          selectItem(clip.id);
          renderAll();
        });
        row.appendChild(mark);
      }
    });

    // Clicar no vazio da faixa a torna ativa, limpa a seleção e leva a agulha
    row.addEventListener('mousedown', (e) => {
      if (e.target !== row) return;
      activeTrackId = track.id;
      selectItem(null);
      stopMonitor();
      seekTimeline(pxToSeconds(e.offsetX));
      renderAll();
    });

    // --- Alvo do arraste vindo da biblioteca ---
    row.addEventListener('dragover', (e) => {
      if (!libraryDrag) return;
      const source = sourceById(libraryDrag.sourceId);
      if (!trackAccepts(track, source)) return;   // tipo incompatível: não aceita
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-target');
      if (!libraryDrag) return;
      const source = sourceById(libraryDrag.sourceId);
      if (!trackAccepts(track, source)) return;
      e.preventDefault();

      // Solta onde o ponteiro está, encaixando nas bordas próximas
      const dropAt = Math.max(0, pxToSeconds(e.offsetX));
      const clip = addItemFromSource(libraryDrag.sourceId, track.id, dropAt);
      if (clip) {
        clip.timelineStart = Math.max(0, applySnap(clip.timelineStart, clip));
        renderAll();
      }
      libraryDrag = null;
    });

    timelineRows.appendChild(row);
  });

  renderPlayheadLine();
}

// A agulha percorre a régua e todas as faixas
function renderPlayheadLine() {
  const line = $('timeline-playhead-line');
  if (!line) return;
  line.style.left = `${secondsToPx(playhead)}px`;
}

// A coluna de nomes é um elemento separado da área rolável, então precisa
// acompanhar a rolagem VERTICAL na mão — senão, com várias faixas, os nomes
// ficam parados enquanto as faixas correm.
//
// A barra de rolagem HORIZONTAL come um pedaço da altura útil só do lado das
// faixas. Sem compensar, as duas colunas têm rolagens máximas diferentes: ao
// chegar no fim, a coluna de nomes para antes e os nomes saem da linha das
// faixas exatamente pela altura da barra.
function syncHeaderGutter() {
  const gutter = timelineScroll.offsetHeight - timelineScroll.clientHeight;
  trackHeaders.style.paddingBottom = `${Math.max(0, gutter)}px`;
}

timelineScroll.addEventListener('scroll', () => {
  trackHeaders.scrollTop = timelineScroll.scrollTop;
});

// Arrastar na régua move a agulha — é como se navega na montagem.
//
// A régua vive DENTRO da área rolável, então o retângulo dela já vem deslocado
// pela rolagem. Somar o scrollLeft aqui contava a rolagem duas vezes, e a
// agulha caía longe do cursor sempre que a linha do tempo não estava no começo.
function scrubFromEvent(e) {
  const rect = timelineRuler.getBoundingClientRect();
  seekTimeline(pxToSeconds(e.clientX - rect.left));
}

let scrubbing = false;

timelineRuler.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  scrubbing = true;
  stopMonitor();
  scrubFromEvent(e);
});

window.addEventListener('mousemove', (e) => {
  if (scrubbing) scrubFromEvent(e);
});

window.addEventListener('mouseup', () => {
  if (scrubbing) {
    scrubbing = false;
    renderAll();
  }
});

function buildTimelineItem(clip, track) {
  const source = sourceById(clip.sourceId);
  const duration = clipDuration(clip);
  const kind = source ? source.kind : 'video';

  const block = document.createElement('div');
  block.className = `tl-item kind-${kind}`
    + (selectedClipIds.has(clip.id) ? ' selected' : '')
    + (selectedClipIds.size > 1 && clip.id !== selectedClipId ? ' multi' : '')
    + (clip.muted || trackIsSilent(track) ? ' muted' : '');
  block.style.left = `${secondsToPx(clip.timelineStart)}px`;
  block.style.width = `${Math.max(6, secondsToPx(duration))}px`;
  block.dataset.clipId = clip.id;
  block.title = source ? source.name : 'mídia removida';

  const detail = kind === 'image'
    ? `foto · ${formatTime(duration, false)}`
    : `${formatTime(clip.start, false)} → ${formatTime(clip.end, false)}`;

  block.innerHTML = `
    <div class="tl-item-handle left"></div>
    <canvas class="tl-item-wave hidden"></canvas>
    <div class="tl-item-label">
      ${escapeHtml(clipLabel(clip))}
      <small>${escapeHtml(detail)}</small>
    </div>
    <div class="tl-item-handle right"></div>
  `;

  // A onda entra atrás do rótulo. Os picos são pedidos uma vez por mídia e
  // ficam guardados nela; até chegarem, o bloco aparece sem onda em vez de
  // segurar o desenho da linha do tempo.
  if (kind !== 'image' && source) {
    requestPeaks(source);
    const canvas = block.querySelector('.tl-item-wave');
    const width = Math.max(6, secondsToPx(duration));
    // O bloco tem 38px de altura (style.css). O vídeo cede espaço ao rótulo;
    // no áudio a onda é o conteúdo principal e ocupa quase tudo.
    const height = kind === 'audio' ? 34 : 22;
    if (drawClipWaveform(canvas, clip, source, width, height)) {
      canvas.classList.remove('hidden');
      canvas.classList.toggle('wave-audio', kind === 'audio');
    }
  }

  block.addEventListener('mousedown', (e) => startItemGesture(e, clip, block));
  return block;
}

// --- Arrastar para mover, e as bordas para aparar ---
//
// Um só handler para os três gestos: o que decide é onde o botão foi
// pressionado dentro do bloco. Assim não há três caminhos para manter em
// sincronia com o modelo.
let itemGesture = null;

function startItemGesture(e, clip, block) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  // A geometria é lida ANTES de selecionar: selecionar redesenha a linha do
  // tempo, e um bloco já removido do documento devolve um retângulo zerado —
  // o que faria todo clique parecer que aconteceu sobre a alça direita.
  const rect = block.getBoundingClientRect();
  const offsetInBlock = e.clientX - rect.left;

  let mode = 'move';
  if (offsetInBlock <= HANDLE_HIT_PIXELS) mode = 'trim-start';
  else if (rect.width - offsetInBlock <= HANDLE_HIT_PIXELS) mode = 'trim-end';

  activeTrackId = clip.trackId;

  const selectMode = (e.ctrlKey || e.metaKey) ? 'toggle' : (e.shiftKey ? 'range' : null);
  // Clicar num item já selecionado sem modificador mantém o conjunto — senão
  // arrastar vários juntos seria impossível: o primeiro clique desfaria a
  // seleção antes do arraste começar.
  if (selectMode || !selectedClipIds.has(clip.id)) {
    selectItem(clip.id, selectMode);
  } else {
    selectedClipId = clip.id;
    editingClipId = clip.id;
    showDock('props');
  }

  const source = sourceById(clip.sourceId);

  itemGesture = {
    clipId: clip.id,
    mode,
    startX: e.clientX,
    startY: e.clientY,
    baseTimelineStart: clip.timelineStart,
    baseSourceStart: clip.start,
    baseSourceEnd: clip.end,
    sourceDuration: source ? (source.kind === 'image' ? Infinity : source.duration) : Infinity,
    isImage: !!source && source.kind === 'image',
    // Mover leva o conjunto inteiro junto; aparar vale só para o item pego
    companions: mode === 'move'
      ? selectedClips().filter((c) => c.id !== clip.id).map((c) => ({ id: c.id, base: c.timelineStart }))
      : []
  };

  block.classList.add('dragging');
  renderAll();
}

// Pontos onde o arraste "gruda": o zero, a agulha e as bordas dos outros
// trechos — inclusive os de OUTRAS faixas, que é o que permite alinhar o fim
// de um áudio com o fim do vídeo.
function snapCandidates(clip) {
  const points = [0, playhead];
  clips.forEach((other) => {
    if (other.id === clip.id) return;
    if (selectedClipIds.has(other.id) && selectedClipIds.size > 1) return; // move junto
    points.push(other.timelineStart, clipEnd(other));
  });
  return points;
}

function applySnap(value, clip) {
  const tolerance = pxToSeconds(SNAP_PIXELS);
  let best = value;
  let bestDistance = tolerance;
  snapCandidates(clip).forEach((point) => {
    const distance = Math.abs(point - value);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  });
  return best;
}

window.addEventListener('mousemove', (e) => {
  if (!itemGesture) return;
  const clip = clips.find((c) => c.id === itemGesture.clipId);
  if (!clip) return;

  const deltaSeconds = pxToSeconds(e.clientX - itemGesture.startX);

  if (itemGesture.mode === 'move') {
    const raw = Math.max(0, itemGesture.baseTimelineStart + deltaSeconds);
    clip.timelineStart = Math.max(0, applySnap(raw, clip));

    // O deslocamento efetivo (já com o imã) é o mesmo para todo o conjunto,
    // preservando as distâncias entre os trechos selecionados.
    const applied = clip.timelineStart - itemGesture.baseTimelineStart;
    itemGesture.companions.forEach(({ id, base }) => {
      const other = clips.find((c) => c.id === id);
      if (other) other.timelineStart = Math.max(0, base + applied);
    });

    // Arrastar na vertical troca de faixa, se o tipo bater
    const row = document.elementFromPoint(e.clientX, e.clientY);
    const rowEl = row && row.closest ? row.closest('.timeline-row') : null;
    if (rowEl && Number(rowEl.dataset.trackId) !== clip.trackId) {
      setClipTrackSilently(clip, Number(rowEl.dataset.trackId));
    }
  } else if (itemGesture.mode === 'trim-end') {
    const maxEnd = itemGesture.isImage ? MAX_IMAGE_DURATION : itemGesture.sourceDuration;
    // O imã atua na borda como ela aparece na LINHA DO TEMPO, e depois a
    // conversão volta para o tempo dentro da fonte. É o que faz o fim de um
    // áudio longo grudar no fim do vídeo, que é onde se quer cortar.
    const speed = clipSpeed(clip);
    const wantedOnTimeline = clip.timelineStart + (itemGesture.baseSourceEnd - clip.start) / speed + deltaSeconds;
    const snapped = applySnap(wantedOnTimeline, clip);
    // De volta para tempo DENTRO da fonte: o que na linha do tempo dura 1s,
    // a 2x consome 2s de material.
    const wanted = clip.start + (snapped - clip.timelineStart) * speed;
    clip.end = clamp(wanted, clip.start + MIN_CLIP_DURATION, maxEnd);
  } else {
    // Aparar o começo encurta o item E o empurra no tempo, para o material
    // seguinte não escorregar: o que muda é onde a fonte começa.
    if (itemGesture.isImage) {
      // Foto não tem "antes": aparar o começo só muda a duração e a posição
      const wanted = clamp(
        itemGesture.baseTimelineStart + deltaSeconds,
        0,
        clipEnd(clip) - MIN_CLIP_DURATION
      );
      clip.timelineStart = wanted;
      clip.end = itemGesture.baseSourceEnd - (wanted - itemGesture.baseTimelineStart);
      clip.end = Math.max(clip.start + MIN_CLIP_DURATION, clip.end);
    } else {
      const speed = clipSpeed(clip);
      const wanted = clamp(
        itemGesture.baseSourceStart + deltaSeconds * speed,
        0,
        itemGesture.baseSourceEnd - MIN_CLIP_DURATION
      );
      const shift = (wanted - itemGesture.baseSourceStart) / speed;
      clip.start = wanted;
      clip.timelineStart = Math.max(0, itemGesture.baseTimelineStart + shift);
    }
  }

  renderTimeline();
  renderPropsPanel();
});

function setClipTrackSilently(clip, trackId) {
  const track = trackById(trackId);
  const source = sourceById(clip.sourceId);
  if (!track || !source) return;
  const wanted = source.kind === 'audio' ? 'audio' : 'video';
  if (track.kind !== wanted) return;
  clip.trackId = trackId;
  activeTrackId = trackId;
}

window.addEventListener('mouseup', () => {
  if (!itemGesture) return;
  itemGesture = null;
  document.querySelectorAll('.tl-item.dragging').forEach((el) => el.classList.remove('dragging'));
  renderAll();
  // Um arraste inteiro é UMA entrada no histórico, não uma por quadro: o
  // commit fica aqui, no fim do gesto, e não no mousemove.
  commitHistory();
});

// --- Faixas novas e trilha de áudio ---
btnUndo.addEventListener('click', undo);
btnRedo.addEventListener('click', redo);

btnAddVideoTrack.addEventListener('click', () => {
  const track = createTrack('video', `V${videoTracks().length + 1}`);
  activeTrackId = track.id;
  renderAll();
  commitHistory();
});

btnAddAudioTrack.addEventListener('click', () => {
  const track = createTrack('audio', `A${audioTracks().length + 1}`);
  activeTrackId = track.id;
  renderAll();
  commitHistory();
});

btnAddAudioSource.addEventListener('click', handleAudioSelection);

function setTimelineZoom(value) {
  // O piso é 1px/s para o "Ajustar" dar conta de montagens longas: com o antigo
  // mínimo de 10, uma montagem de poucos minutos já não cabia na tela.
  pixelsPerSecond = clamp(Math.round(value), 1, 400);
  inputTimelineZoom.value = String(pixelsPerSecond);
  timelineZoomReadout.textContent = String(pixelsPerSecond);
  renderTimeline();
}

inputTimelineZoom.addEventListener('input', () => setTimelineZoom(Number(inputTimelineZoom.value)));
btnZoomTimelineIn.addEventListener('click', () => setTimelineZoom(pixelsPerSecond * 1.35));
btnZoomTimelineOut.addEventListener('click', () => setTimelineZoom(pixelsPerSecond / 1.35));

// "Ajustar" enquadra a montagem inteira na largura visível — o jeito rápido de
// recuperar o rumo depois de dar zoom demais.
btnZoomFit.addEventListener('click', () => {
  const total = sequenceDuration();
  const width = timelineScroll.clientWidth || 600;
  if (total > 0) setTimelineZoom((width - 24) / total);
  timelineScroll.scrollLeft = 0;
});

// Roda do mouse com Ctrl dá zoom, como nos editores
timelineScroll.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  setTimelineZoom(pixelsPerSecond * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
}, { passive: false });

const ICON_UP = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>';
const ICON_PLAY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const ICON_X = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
const ICON_FRAME = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M3 5v4h2V5h4V3H5c-1.1 0-2 .9-2 2zm2 10H3v4c0 1.1.9 2 2 2h4v-2H5v-4zm14 4h-4v2h4c1.1 0 2-.9 2-2v-4h-2v4zm0-16h-4v2h4v4h2V5c0-1.1-.9-2-2-2z"/></svg>';

function renderAll() {
  renderMediaLibrary();
  renderTimeline();
  renderPropsPanel();
  renderMonitor();
  updateExportAvailability();
  updateToolbarState();
}
// ==========================================================================
// BIBLIOTECA DE MÍDIAS (coluna esquerda, aba "Mídias")
//
// Só guarda e apresenta o que foi importado. Nada entra na montagem por aqui:
// o caminho é arrastar um cartão para uma faixa da linha do tempo.
// ==========================================================================

const KIND_LABEL = { video: 'Vídeo', image: 'Foto', audio: 'Áudio' };

function renderMediaLibrary() {
  mediaGrid.innerHTML = '';
  mediaEmpty.classList.toggle('hidden', sources.length > 0);

  sources.forEach((source) => {
    const card = document.createElement('div');
    card.className = `media-card kind-${source.kind}` + (source.id === activeSourceId ? ' active' : '');
    card.draggable = true;
    card.dataset.sourceId = source.id;
    card.title = source.path;

    const meta = source.kind === 'image'
      ? (source.width ? `${source.width}×${source.height}` : 'foto')
      : formatTime(source.duration, false);

    // Vídeo e foto mostram a própria imagem; áudio, um ícone
    const thumb = source.kind === 'audio'
      ? `<div class="media-thumb icon">${ICON_AUDIO}</div>`
      : source.kind === 'image'
        ? `<div class="media-thumb"><img src="${escapeHtml(toFileUrl(source.path))}" alt="" draggable="false"></div>`
        : `<div class="media-thumb"><video src="${escapeHtml(toFileUrl(source.previewPath || source.path))}"
             muted preload="metadata"></video></div>`;

    card.innerHTML = `
      ${thumb}
      <div class="media-info">
        <span class="media-name">${escapeHtml(source.name)}</span>
        <span class="media-meta">${escapeHtml(KIND_LABEL[source.kind] || '')} · ${escapeHtml(meta)}</span>
      </div>
      <button class="media-remove" title="Remover da biblioteca">${ICON_X}</button>
    `;

    card.addEventListener('click', () => setActiveSource(source.id));
    // Duplo clique acrescenta ao fim da faixa — atalho para quem não quer arrastar
    card.addEventListener('dblclick', () => addItemFromSource(source.id, targetTrackFor(source).id));
    card.querySelector('.media-remove').addEventListener('click', (e) => {
      e.stopPropagation();
      removeSource(source.id);
    });

    card.addEventListener('dragstart', (e) => {
      libraryDrag = { sourceId: source.id };
      card.classList.add('dragging');
      // O dataTransfer precisa de alguma carga para o arraste começar no Chromium
      e.dataTransfer.setData('text/plain', String(source.id));
      e.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dragend', () => {
      libraryDrag = null;
      card.classList.remove('dragging');
      clearDropHints();
    });

    mediaGrid.appendChild(card);
  });
}

const ICON_AUDIO = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z"/></svg>';

// Arraste em curso vindo da biblioteca
let libraryDrag = null;

function clearDropHints() {
  document.querySelectorAll('.timeline-row.drop-target')
    .forEach((row) => row.classList.remove('drop-target'));
}

// Soltar arquivos direto na biblioteca também importa
[mediaGrid, mediaEmpty].forEach((zone) => {
  zone.addEventListener('dragover', (e) => {
    if (libraryDrag) return;             // arraste interno, não é importação
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    zone.classList.remove('dragover');
    if (libraryDrag) return;
    e.preventDefault();
    const paths = collectDroppedPaths(e);
    if (paths.length > 0) addSources(paths);
  });
});

// ==========================================================================
// MONITOR DA MONTAGEM
//
// O player mostra o RESULTADO no instante da agulha, e não a mídia isolada:
// a faixa de baixo entra no elemento principal, as faixas de cima viram
// camadas sobrepostas, e as trilhas de áudio tocam em paralelo.
//
// A agulha é a fonte da verdade. Ao reproduzir, ela avança pelo relógio do
// vídeo quando há vídeo tocando, e por um cronômetro quando o trecho é foto ou
// intervalo — assim um vazio na montagem também "passa" na prévia.
// ==========================================================================

let playhead = 0;
let monitorPlaying = false;
let monitorTimer = null;
let monitorLastTick = 0;
let monitorAudio = [];            // [{ clip, element }] das faixas de áudio
let monitorBaseClipId = null;     // qual item está carregado no elemento de vídeo

const monitorVolume = () => (videoElement.muted ? 0 : clamp(Number(inputVolume.value) / 100, 0, 1));

// Itens da faixa base ativos em `t`. Normalmente é um só; durante uma
// transição são DOIS, porque os trechos se sobrepõem.
function baseClipsAt(t) {
  return baseItems().filter((c) => t >= c.timelineStart - 0.001 && t < clipEnd(c) - 0.001);
}

// O trecho que manda no instante `t`: numa transição, o que ENTRA.
function baseClipAt(t) {
  const active = baseClipsAt(t);
  return active.length ? active[active.length - 1] : null;
}

// Transição acontecendo agora, com o quanto dela já passou (0 a 1)
function transitionAt(t) {
  const active = baseClipsAt(t);
  if (active.length < 2) return null;

  const outgoing = active[active.length - 2];
  const incoming = active[active.length - 1];
  const overlap = clipEnd(outgoing) - incoming.timelineStart;
  if (overlap <= 0.02) return null;

  return {
    outgoing,
    incoming,
    type: incoming.transition || 'fade',
    progress: clamp((t - incoming.timelineStart) / overlap, 0, 1)
  };
}

// Itens de sobreposição visíveis em `t`, de baixo para cima
function overlayClipsAt(t) {
  return videoTracks().slice(1)
    .filter((track) => !track.muted)
    .flatMap((track) => itemsOfTrack(track.id))
    .filter((c) => t >= c.timelineStart - 0.001 && t < clipEnd(c) - 0.001);
}

function seekTimeline(seconds) {
  playhead = clamp(seconds, 0, sequenceDuration());
  renderMonitor();
  syncMonitorAudio(true);
  // Mover a agulha muda o que dá para fazer: "Dividir" só vale com a agulha
  // DENTRO do trecho selecionado. Sem isto o botão ficava desatualizado e o
  // clique não fazia nada.
  updateToolbarState();
}

function updateToolbarState() {
  const hasSelection = !!selectedClip();
  btnClipDelete.disabled = !hasSelection;
  btnClipDuplicate.disabled = !hasSelection;
  btnSplit.disabled = !canSplitSelected();
}

// Assinatura do que está visível agora. Enquanto ela não muda, reproduzir é só
// deixar o vídeo correr — reconstruir as camadas a cada quadro faria os
// elementos de sobreposição renascerem 16 vezes por segundo, sem nunca tocar.
function monitorSignature() {
  const base = baseClipAt(playhead);
  const overlays = overlayClipsAt(playhead).map((c) => c.id).join(',');
  const transition = transitionAt(playhead);
  // A transição entra na assinatura pelo PAR de trechos, não pelo progresso:
  // o progresso muda a cada quadro e é aplicado pelo caminho barato.
  const visibleTexts = texts
    .filter((t) => playhead >= t.timelineStart - 0.001 && playhead < textEnd(t) - 0.001)
    .map((t) => t.id).join(',');
  const focus = monitorFocusClip();
  return `${base ? base.id : 'gap'}|${overlays}|${transition ? transition.outgoing.id : ''}|${visibleTexts}|${focus ? focus.id : ''}`;
}

let lastMonitorSignature = null;

// Atualização barata, para rodar durante a reprodução
function updateMonitorClock() {
  timeCurrentDisp.textContent = formatTime(playhead);
  timeDurationDisp.textContent = formatTime(sequenceDuration());
  renderPlayheadLine();
  paintTransitionProgress();
}

// ==========================================================================
// TRANSIÇÃO NO MONITOR
//
// O ffmpeg compõe a transição na exportação; aqui ela é reproduzida com duas
// camadas e CSS. Os efeitos que o CSS não alcança (círculo, radial, pixelizar)
// caem numa dissolvência — a legenda diz quando é aproximação, para o monitor
// não prometer o que o arquivo não vai entregar.
// ==========================================================================

const CSS_TRANSITIONS = new Set([
  'fade', 'dissolve', 'fadeblack', 'fadewhite',
  'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'slideleft', 'slideright'
]);

let activeTransition = null;   // { type, progress, exact } enquanto durar

// Posiciona uma mídia na camada de trás (o trecho que sai)
function showOutgoing(clip, frame) {
  const source = sourceById(clip.sourceId);
  if (!source) return;

  const isImage = source.kind === 'image';
  const layout = framingLayout(source, clip.framing || defaultFraming(), frame, clip.rotate);

  videoBElement.classList.toggle('hidden', isImage);
  imageBElement.classList.toggle('hidden', !isImage);

  const element = isImage ? imageBElement : videoBElement;
  const src = toFileUrl(isImage ? source.path : (source.previewPath || source.path));
  if (element.src !== src) {
    element.src = src;
    if (!isImage) element.load();
  }
  if (!isImage) {
    const inside = clip.start + (playhead - clip.timelineStart);
    if (Math.abs(element.currentTime - inside) > 0.35) {
      try { element.currentTime = inside; } catch (err) { /* metadados a caminho */ }
    }
    if (monitorPlaying && element.paused) element.play().catch(() => {});
    if (!monitorPlaying && !element.paused) element.pause();
  }
  applyLayout(element, layout, clip.rotate, frame);
  applyClipVisuals(element, clip);
}

function hideTransitionLayers() {
  activeTransition = null;
  videoBElement.classList.add('hidden');
  imageBElement.classList.add('hidden');
  transitionVeil.classList.add('hidden');
  videoBElement.pause();
  [videoElement, imageElement].forEach((el) => {
    el.style.opacity = '';
    el.style.clipPath = '';
    el.style.transform = '';
  });

  // Limpar as camadas apaga também os ajustes do trecho (opacidade, giro),
  // que moram nos mesmos estilos. Reaplica na saída, senão sair de uma
  // transição desfazia o que o usuário tinha configurado.
  const clip = baseClipAt(playhead);
  if (clip) {
    const source = sourceById(clip.sourceId);
    if (source) applyClipVisuals(source.kind === 'image' ? imageElement : videoElement, clip);
  }
}

// Aplica o progresso nas camadas. Só mexe em estilo, então pode rodar a cada
// quadro sem recriar nada.
function paintTransitionProgress() {
  if (!activeTransition) return;

  const info = transitionAt(playhead);
  if (!info) { hideTransitionLayers(); return; }

  const p = info.progress;
  const front = imageElement.classList.contains('hidden') ? videoElement : imageElement;
  front.style.clipPath = '';
  front.style.transform = '';
  transitionVeil.classList.add('hidden');

  switch (info.type) {
    case 'wipeleft':   front.style.clipPath = `inset(0 0 0 ${(1 - p) * 100}%)`; front.style.opacity = '1'; break;
    case 'wiperight':  front.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`; front.style.opacity = '1'; break;
    case 'wipeup':     front.style.clipPath = `inset(${(1 - p) * 100}% 0 0 0)`; front.style.opacity = '1'; break;
    case 'wipedown':   front.style.clipPath = `inset(0 0 ${(1 - p) * 100}% 0)`; front.style.opacity = '1'; break;
    case 'slideleft':  front.style.transform = `translateX(${(1 - p) * 100}%)`; front.style.opacity = '1'; break;
    case 'slideright': front.style.transform = `translateX(${-(1 - p) * 100}%)`; front.style.opacity = '1'; break;

    // Passar pelo preto/branco: some, o véu cobre, e o novo aparece
    case 'fadeblack':
    case 'fadewhite': {
      transitionVeil.classList.remove('hidden');
      transitionVeil.style.background = info.type === 'fadeblack' ? '#000' : '#fff';
      // O véu sobe até a metade e desce depois
      transitionVeil.style.opacity = String(1 - Math.abs(p - 0.5) * 2);
      front.style.opacity = p < 0.5 ? '0' : '1';
      break;
    }

    default:
      front.style.opacity = String(p);   // dissolvência
      break;
  }
}

function beginTransitionVisual(info, frame) {
  activeTransition = { type: info.type, exact: CSS_TRANSITIONS.has(info.type) };
  showOutgoing(info.outgoing, frame);
  paintTransitionProgress();
}

function renderMonitor() {
  const total = sequenceDuration();
  timeCurrentDisp.textContent = formatTime(playhead);
  timeDurationDisp.textContent = formatTime(total);
  renderPlayheadLine();
  lastMonitorSignature = monitorSignature();

  const clip = baseClipAt(playhead);
  const frame = outputFrame();
  mediaFrame.style.aspectRatio = `${frame.width} / ${frame.height}`;
  renderTextOverlays();

  const transition = transitionAt(playhead);
  // A prioridade do selecionado é da PRÉVIA, não do arquivo. Avisar evita a
  // dúvida de por que o vídeo exportado sai com outra faixa na frente.
  const foraDeOrdem = monitorFocusChangesOrder();

  mediaFrameCaption.textContent = clips.length === 0
    ? 'Nada na linha do tempo ainda'
    : foraDeOrdem
      ? 'Mostrando o trecho selecionado à frente — no vídeo exportado vale a ordem das faixas'
      : transition
        ? (CSS_TRANSITIONS.has(transition.type)
          ? `Transição: ${transitionLabel(transition.type)}`
          : `Transição: ${transitionLabel(transition.type)} — prévia aproximada`)
        : `Saída em ${frame.label}`;

  renderOverlayLayers(frame);

  // Intervalo (ou montagem vazia): só o fundo
  if (!clip) {
    videoElement.pause();
    videoElement.classList.add('hidden');
    imageElement.classList.add('hidden');
    videoBgElement.classList.add('hidden');
    mediaFrameBg.classList.remove('blurred');
    mediaFrameBg.style.backgroundImage = '';
    mediaFrameBg.style.backgroundColor = timelineBackgroundColor();
    monitorBaseClipId = null;
    hideTransitionLayers();
    renderBlurRegionOverlay(null);
    return;
  }

  const source = sourceById(clip.sourceId);
  if (!source) return;

  paintFrameBackground(source, clip.framing);
  const layout = framingLayout(source, clip.framing || defaultFraming(), frame, clip.rotate);

  if (source.kind === 'image') {
    videoElement.pause();
    videoElement.classList.add('hidden');
    imageElement.classList.remove('hidden');
    imageElement.src = toFileUrl(source.path);
    applyLayout(imageElement, layout, clip.rotate, frame);
    applyClipVisuals(imageElement, clip);
    renderBlurRegionOverlay(clip, layout);
    monitorBaseClipId = clip.id;
    if (transition) beginTransitionVisual(transition, frame);
    else hideTransitionLayers();
    return;
  }

  imageElement.classList.add('hidden');
  videoElement.classList.remove('hidden');
  applyLayout(videoElement, layout, clip.rotate, frame);
  applyClipVisuals(videoElement, clip);
  renderBlurRegionOverlay(clip, layout);

  const src = toFileUrl(source.previewPath || source.path);
  const insideSource = clip.start + (playhead - clip.timelineStart);

  if (videoElement.src !== src) {
    videoElement.src = src;
    videoElement.load();
    videoElement.addEventListener('loadedmetadata', () => {
      videoElement.currentTime = insideSource;
      if (monitorPlaying) videoElement.play().catch(() => {});
    }, { once: true });
  } else if (monitorBaseClipId !== clip.id || Math.abs(videoElement.currentTime - insideSource) > 0.35) {
    // Reposiciona ao trocar de item ou quando a agulha foi movida por fora
    videoElement.currentTime = insideSource;
  }

  const baseSilent = clip.muted || trackIsSilent(trackById(clip.trackId));
  videoElement.volume = baseSilent
    ? 0
    : clamp((clip.volume === undefined ? 1 : clip.volume) * monitorVolume(), 0, 1);
  videoElement.playbackRate = parseFloat(selectSpeed.value) || 1;
  monitorBaseClipId = clip.id;

  // Numa transição, a camada de trás recebe o trecho que sai
  if (transition) beginTransitionVisual(transition, frame);
  else hideTransitionLayers();
}

// `layout` é a caixa que a mídia deve OCUPAR no quadro. Quando o trecho está
// girado em 90°, o CSS gira o elemento depois de posicioná-lo — então ele
// precisa nascer com os lados trocados, senão a rotação o deixaria deitado
// fora da caixa. Como tudo aqui é porcentagem de eixos diferentes, a proporção
// do quadro entra na conversão.
function applyLayout(element, layout, rotate, frame) {
  let { width, height, left, top } = layout;

  if ((rotate === 90 || rotate === 270) && frame) {
    const ratio = frame.width / frame.height;
    const rotatedWidth = height / ratio;
    const rotatedHeight = width * ratio;
    left = left + width / 2 - rotatedWidth / 2;
    top = top + height / 2 - rotatedHeight / 2;
    width = rotatedWidth;
    height = rotatedHeight;
  }

  element.style.width = `${width}%`;
  element.style.height = `${height}%`;
  element.style.left = `${left}%`;
  element.style.top = `${top}%`;
}

// Fundo do quadro (cor ou desfoque da própria mídia)
function paintFrameBackground(source, framing) {
  const applied = framing || defaultFraming();
  const blurred = applied.background.mode === 'blur';
  const blurVideo = blurred && source.kind !== 'image';

  videoBgElement.classList.toggle('hidden', !blurVideo);
  if (blurVideo) {
    const src = toFileUrl(source.previewPath || source.path);
    if (videoBgElement.src !== src) {
      videoBgElement.src = src;
      videoBgElement.load();
    }
    syncBlurVideo();
  } else if (videoBgElement.src) {
    videoBgElement.pause();
  }

  if (blurred && !blurVideo) {
    mediaFrameBg.style.backgroundImage = `url("${toFileUrl(source.path)}")`;
    mediaFrameBg.style.backgroundColor = '';
    mediaFrameBg.classList.add('blurred');
  } else {
    mediaFrameBg.style.backgroundImage = '';
    mediaFrameBg.style.backgroundColor = blurVideo ? '#000000' : applied.background.color;
    mediaFrameBg.classList.remove('blurred');
  }
}

// As faixas de cima viram camadas absolutas sobre o quadro. É o que faz a
// sobreposição finalmente APARECER na prévia, e não só no arquivo exportado.
// Trecho que a PRÉVIA coloca na frente, independente da faixa.
//
// Serve para editar: sem isto, mexer no enquadramento de um trecho coberto por
// outra faixa seria às cegas. Vale só no monitor — o arquivo exportado segue a
// ordem das faixas, e a legenda do monitor avisa quando os dois divergem.
function monitorFocusClip() {
  const clip = selectedClip();
  if (!clip) return null;

  const source = sourceById(clip.sourceId);
  if (!source || source.kind === 'audio') return null;

  const track = trackById(clip.trackId);
  if (!track || track.kind !== 'video' || track.muted) return null;

  // Só se estiver no ar na posição da agulha; senão não há o que trazer à frente
  const noAr = playhead >= clip.timelineStart - 0.001 && playhead < clipEnd(clip) - 0.001;
  return noAr ? clip : null;
}

// A prévia está mostrando algo fora da ordem das faixas?
function monitorFocusChangesOrder() {
  const focus = monitorFocusClip();
  if (!focus) return false;

  const naFrente = overlayClipsAt(playhead)
    .filter((c) => {
      const s = sourceById(c.sourceId);
      return s && s.kind !== 'audio';
    })
    .pop();

  // Sem nada por cima, o trecho selecionado já era o da frente
  return naFrente ? naFrente.id !== focus.id : false;
}

function renderOverlayLayers(frame) {
  overlayLayers.innerHTML = '';

  const focus = monitorFocusClip();
  const emOrdem = overlayClipsAt(playhead);

  // O selecionado vai para o fim da fila, ou seja, para a frente
  const desenhar = focus
    ? emOrdem.filter((c) => c.id !== focus.id).concat(emOrdem.filter((c) => c.id === focus.id))
    : emOrdem;

  // Selecionado na faixa BASE: ela não está nesta lista, então a prévia a ergue
  // acima das camadas pelo CSS.
  mediaFrame.classList.toggle('base-em-foco', !!focus && !emOrdem.some((c) => c.id === focus.id));

  desenhar.forEach((clip) => {
    const source = sourceById(clip.sourceId);
    if (!source || source.kind === 'audio') return;

    const layout = framingLayout(source, clip.framing || defaultFraming(), frame, clip.rotate);
    const element = source.kind === 'image'
      ? document.createElement('img')
      : document.createElement('video');

    if (source.kind === 'image') {
      element.src = toFileUrl(source.path);
    } else {
      element.src = toFileUrl(source.previewPath || source.path);
      element.muted = true;
      element.currentTime = clip.start + (playhead - clip.timelineStart);
      if (monitorPlaying) element.play().catch(() => {});
    }

    element.className = 'overlay-item' + (focus && clip.id === focus.id ? ' em-foco' : '');
    element.draggable = false;
    applyLayout(element, layout, clip.rotate, frame);
    applyClipVisuals(element, clip);
    overlayLayers.appendChild(element);
  });
}

// --- Áudio das trilhas ---
//
// Um <audio> por item de trilha. Eles são posicionados a cada seek e seguem o
// play/pause do monitor; a mixagem de verdade é feita pelo ffmpeg na exportação.
function syncMonitorAudio(reposition) {
  const wanted = audioTracks()
    .filter((track) => !trackIsSilent(track))
    .flatMap((track) => itemsOfTrack(track.id));

  // Descarta elementos de itens que não existem mais
  monitorAudio = monitorAudio.filter(({ clip, element }) => {
    if (wanted.some((c) => c.id === clip.id)) return true;
    element.pause();
    element.src = '';
    return false;
  });

  wanted.forEach((clip) => {
    const source = sourceById(clip.sourceId);
    if (!source) return;

    let entry = monitorAudio.find((a) => a.clip.id === clip.id);
    if (!entry) {
      entry = { clip, element: new Audio(toFileUrl(source.path)) };
      monitorAudio.push(entry);
    }
    entry.clip = clip;

    const active = playhead >= clip.timelineStart - 0.001 && playhead < clipEnd(clip) - 0.001;
    entry.element.volume = clip.muted || trackIsSilent(trackById(clip.trackId))
      ? 0
      : clamp((clip.volume === undefined ? 1 : clip.volume) * monitorVolume(), 0, 1);

    if (!active) {
      if (!entry.element.paused) entry.element.pause();
      return;
    }

    const inside = clip.start + (playhead - clip.timelineStart);
    if (reposition || Math.abs(entry.element.currentTime - inside) > 0.35) {
      try { entry.element.currentTime = inside; } catch (err) { /* metadados ainda não chegaram */ }
    }
    if (monitorPlaying && entry.element.paused) entry.element.play().catch(() => {});
    if (!monitorPlaying && !entry.element.paused) entry.element.pause();
  });
}

function applyMonitorAudio() {
  const clip = baseClipAt(playhead);
  if (clip) {
    const baseSilent = clip.muted || trackIsSilent(trackById(clip.trackId));
  videoElement.volume = baseSilent
    ? 0
    : clamp((clip.volume === undefined ? 1 : clip.volume) * monitorVolume(), 0, 1);
  }
  syncMonitorAudio(false);
}

// --- Transporte ---
function playMonitor() {
  if (clips.length === 0) return;
  if (playhead >= sequenceDuration() - 0.05) playhead = 0;

  monitorPlaying = true;
  playIcon.classList.add('hidden');
  pauseIcon.classList.remove('hidden');

  renderMonitor();
  const clip = baseClipAt(playhead);
  if (clip && !isImageClip(clip)) videoElement.play().catch(() => {});

  monitorLastTick = performance.now();
  clearInterval(monitorTimer);
  monitorTimer = setInterval(tickMonitor, 60);
  syncMonitorAudio(true);
}

function stopMonitor() {
  monitorPlaying = false;
  clearInterval(monitorTimer);
  monitorTimer = null;
  videoElement.pause();
  videoBgElement.pause();
  monitorAudio.forEach(({ element }) => element.pause());
  overlayLayers.querySelectorAll('video').forEach((v) => v.pause());
  playIcon.classList.remove('hidden');
  pauseIcon.classList.add('hidden');
}

function toggleMonitor() {
  if (monitorPlaying) stopMonitor();
  else playMonitor();
}

// A agulha avança pelo relógio do VÍDEO quando há vídeo tocando (é ele quem
// dita o ritmo real), e pelo relógio de parede quando o trecho é foto ou
// intervalo — que não têm um elemento para consultar.
function tickMonitor() {
  if (!monitorPlaying) return;

  const now = performance.now();
  const elapsed = (now - monitorLastTick) / 1000;
  monitorLastTick = now;

  const clip = baseClipAt(playhead);
  if (clip && !isImageClip(clip) && !videoElement.paused) {
    playhead = clip.timelineStart + (videoElement.currentTime - clip.start);
  } else {
    playhead += elapsed * (parseFloat(selectSpeed.value) || 1);
  }

  const total = sequenceDuration();
  if (playhead >= total) {
    playhead = total;
    stopMonitor();
    renderMonitor();
    return;
  }

  // Redesenha o quadro só quando o que está visível MUDA (entrou outro trecho,
  // uma sobreposição começou ou terminou). Caso contrário, atualiza apenas o
  // relógio e a agulha — o vídeo segue tocando sem ser reposicionado.
  const signature = monitorSignature();
  if (signature !== lastMonitorSignature) renderMonitor();
  else updateMonitorClock();

  syncMonitorAudio(false);
}

btnPlayPause.addEventListener('click', toggleMonitor);
btnGoStart.addEventListener('click', () => { stopMonitor(); seekTimeline(0); });
btnGoEnd.addEventListener('click', () => { stopMonitor(); seekTimeline(sequenceDuration()); });

// Passo de um frame: usa o fps da mídia sob a agulha, com 30 como padrão
function frameStepMonitor(direction) {
  const clip = baseClipAt(playhead);
  const source = clip ? sourceById(clip.sourceId) : null;
  const fps = source && source.fps ? source.fps : 30;
  stopMonitor();
  seekTimeline(playhead + direction / fps);
}

btnFrameBack.addEventListener('click', () => frameStepMonitor(-1));
btnFrameForward.addEventListener('click', () => frameStepMonitor(1));

btnMute.addEventListener('click', () => {
  videoElement.muted = !videoElement.muted;
  iconVolume.classList.toggle('hidden', videoElement.muted);
  iconMuted.classList.toggle('hidden', !videoElement.muted);
  applyMonitorAudio();
});

inputVolume.addEventListener('input', applyMonitorAudio);
selectSpeed.addEventListener('change', () => {
  videoElement.playbackRate = parseFloat(selectSpeed.value) || 1;
});

// Arrastar a mídia no monitor reposiciona o enquadramento do trecho selecionado
mediaFrame.addEventListener('wheel', (e) => {
  const framing = framingTarget();
  if (!framing) return;
  e.preventDefault();
  updateFraming({ zoom: framing.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08) });
}, { passive: false });


// ==========================================================================
// 6. EXPORTAÇÃO
// ==========================================================================

// Restaura a última pasta usada
(function restoreOutputDirs() {
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.outputDir);
    if (saved) {
      outputDirPath = saved;
      outputPathDisplay.value = saved;
    }
    const savedMerge = localStorage.getItem(STORAGE_KEYS.mergeOutputDir);
    if (savedMerge) {
      mergeOutputDirPath = savedMerge;
      mergeOutputPathDisplay.value = savedMerge;
    }
  } catch (err) {
    // localStorage indisponível — segue sem persistência
  }
})();

btnSelectOutput.addEventListener('click', async () => {
  const dirPath = await window.api.selectOutputDir();
  if (dirPath) {
    outputDirPath = dirPath;
    outputPathDisplay.value = dirPath;
    try { localStorage.setItem(STORAGE_KEYS.outputDir, dirPath); } catch (e) {}
    updateExportAvailability();
  }
});

inputOutputName.addEventListener('input', updateExportAvailability);
selectJoinMode.addEventListener('change', () => {
  updateNameHint();
  updateExportAvailability();
});


function updateNameHint() {
  const base = inputOutputName.value.trim() || 'meu_video';
  outputNameHint.innerHTML = selectJoinMode.value === 'merged'
    ? `Um único arquivo: <code>${escapeHtml(base)}.mp4</code>`
    : `Será salvo como <code>${escapeHtml(base)}_1.mp4</code>, <code>${escapeHtml(base)}_2.mp4</code>…`;
}

function updateExportAvailability() {
  updateNameHint();
  // A disponibilidade do modo Rápido depende da MONTAGEM (enquadramento nos
  // trechos), não só do formato escolhido. Sem repintar aqui, o estado ficava
  // preso ao último "change" do seletor e podia mentir.

  // O botão da sidebar só exige trechos; pasta e nome são resolvidos no modal
  btnOpenExport.disabled = clips.length === 0;
  const ready = clips.length > 0 && !!outputDirPath && inputOutputName.value.trim().length > 0;
  btnExport.disabled = !ready;

}

// --- Abertura / fechamento do modal de exportação ---

btnOpenExport.addEventListener('click', () => {
  if (clips.length === 0) return;

  // Volta sempre para a etapa de configuração
  exportStepForm.classList.remove('hidden');
  exportStepProgress.classList.add('hidden');
  exportModalTitle.textContent = 'Cortar e Salvar';
  delete exportModal.dataset.busy;

  const total = sequenceDuration();
  const usedSources = new Set(clips.map((c) => c.sourceId)).size;
  const countOfKind = (kind) => clips.filter((c) => {
    const source = sourceById(c.sourceId);
    return source && source.kind === kind;
  }).length;

  const photoCount = countOfKind('image');
  const audioCount = countOfKind('audio');
  const overlayCount = clips.filter((c) => {
    const base = baseTrack();
    const track = trackById(c.trackId);
    return base && track && track.kind === 'video' && track.id !== base.id;
  }).length;

  exportSummary.innerHTML =
    `<strong>${clips.length}</strong> trecho${clips.length > 1 ? 's' : ''}` +
    `<span class="summary-sep">•</span><strong>${formatTime(total)}</strong> no total` +
    (usedSources > 1 ? `<span class="summary-sep">•</span>de <strong>${usedSources}</strong> mídias` : '') +
    (photoCount > 0 ? `<span class="summary-sep">•</span><strong>${photoCount}</strong> foto${photoCount > 1 ? 's' : ''}` : '') +
    (overlayCount > 0 ? `<span class="summary-sep">•</span><strong>${overlayCount}</strong> sobreposição${overlayCount > 1 ? 'ões' : ''}` : '') +
    (audioCount > 0 ? `<span class="summary-sep">•</span><strong>${audioCount}</strong> trilha${audioCount > 1 ? 's' : ''}` : '');

  openModal(exportModal);

  updateExportAvailability();
  inputOutputName.focus();
});

btnCloseExportModal.addEventListener('click', () => closeModal(exportModal));
btnCancelExport.addEventListener('click', () => closeModal(exportModal));

// Payload do caminho ANTIGO (export-clips): só a faixa principal, em ordem de
// tempo. É o que permite corte sem perda, então continua valendo quando a
// montagem é simples.
function buildExportPayload() {
  return baseItems().map((clip) => {
    const source = sourceById(clip.sourceId);
    return {
      id: clip.id,
      sourcePath: source.path,
      kind: source.kind === 'image' ? 'image' : 'video',
      start: clip.start,
      end: clip.end,
      framing: clip.framing || defaultFraming()
    };
  });
}

// Payload da COMPOSIÇÃO (export-timeline): faixas, posições e áudio.
function buildTimelinePayload() {
  return {
    tracks: tracks.map((t) => ({ id: t.id, kind: t.kind, muted: !!t.muted })),
    texts: buildTextPayload(),
    items: clips.map((clip) => {
      const source = sourceById(clip.sourceId);
      const track = trackById(clip.trackId);
      // Isolar uma faixa cala as outras sem tirá-las do vídeo. Como o `muted`
      // do item já significa "sem som", a regra vira só isto — nenhum conceito
      // novo precisa descer até o ffmpeg.
      const silencedBySolo = anyTrackSoloed() && track && !track.solo;
      return {
        id: clip.id,
        trackId: clip.trackId,
        sourcePath: source.path,
        kind: source.kind,
        timelineStart: clip.timelineStart,
        sourceStart: clip.start,
        sourceEnd: clip.end,
        framing: clip.framing || defaultFraming(),
        volume: clip.volume === undefined ? 1 : clip.volume,
        muted: !!clip.muted || !!silencedBySolo,
        normalize: !!clip.normalize,
        transition: clip.transition || 'fade',
        // Ajustes da imagem e do tempo
        speed: clipSpeed(clip),
        opacity: clip.opacity === undefined ? 1 : clip.opacity,
        rotate: clip.rotate || 0,
        flipH: !!clip.flipH,
        flipV: !!clip.flipV,
        color: clip.color || null,
        chroma: clip.chroma || null,
        blurRegion: clip.blurRegion || null
      };
    })
  };
}

// ==========================================================================
// FORMATO DE SAÍDA
//
// Um seletor por tela, ambos alimentados por OUTPUT_FORMATS. A escolha vira
// { width, height, fit } no IPC; 'original' vira null (não mexer em nada).
// ==========================================================================

function populateFormatSelect(select) {
  select.innerHTML = '';
  OUTPUT_FORMATS.forEach((format) => {
    const option = document.createElement('option');
    option.value = format.id;
    option.textContent = format.label;
    select.appendChild(option);
  });
}

populateFormatSelect(selectOutputFormat);
populateFormatSelect(selectMergeFormat);

function readFormat(select, segmented) {
  const preset = formatById(select.value);
  if (!preset.width) return null; // 'original'
  const checked = segmented.querySelector('input:checked');
  return { width: preset.width, height: preset.height, fit: checked ? checked.value : 'cover' };
}

const currentCutFormat = () => readFormat(selectOutputFormat, segmentedFit);
const currentMergeFormat = () => readFormat(selectMergeFormat, mergeSegmentedFit);

// Quanto da imagem some ao preencher um alvo de proporção diferente.
// Devolve null quando não há corte (proporções iguais) ou origem desconhecida.
function cropLoss(sourceWidth, sourceHeight, format) {
  if (!sourceWidth || !sourceHeight) return null;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = format.width / format.height;
  if (Math.abs(sourceRatio - targetRatio) < 0.01) return null;

  return sourceRatio > targetRatio
    ? { axis: 'largura', percent: (1 - targetRatio / sourceRatio) * 100 }
    : { axis: 'altura', percent: (1 - sourceRatio / targetRatio) * 100 };
}

// Aviso concreto sobre o que a escolha atual provoca nas mídias carregadas.
function describeFormatImpact(mediaList, format) {
  if (!format || mediaList.length === 0) return null;

  if (format.fit === 'cover') {
    const losses = mediaList
      .map((m) => cropLoss(m.width, m.height, format))
      .filter(Boolean);
    if (losses.length === 0) return null;
    const worst = losses.reduce((a, b) => (b.percent > a.percent ? b : a));
    return {
      level: worst.percent >= 40 ? 'warn' : 'info',
      text: `Preencher vai cortar até ${worst.percent.toFixed(0)}% da ${worst.axis} ` +
            `em ${losses.length} de ${mediaList.length} mídia(s). O que ficar fora do centro sai do quadro.`
    };
  }

  const upscaled = mediaList.filter((m) => m.width && m.width < format.width && m.height < format.height);
  if (upscaled.length > 0) {
    return {
      level: 'info',
      text: `${upscaled.length} mídia(s) têm resolução menor que ${format.width}×${format.height}. ` +
            `Ampliar não cria detalhe: o arquivo fica maior, não mais nítido.`
    };
  }
  return null;
}

function paintFormatUI({ select, hint, choice, segmented, warning, mediaList, onChange }) {
  const preset = formatById(select.value);
  const format = readFormat(select, segmented);

  hint.textContent = preset.hint;
  choice.classList.toggle('hidden', !format);

  const impact = describeFormatImpact(mediaList, format);
  warning.classList.toggle('hidden', !impact);
  if (impact) {
    warning.className = `fit-warning ${impact.level}`;
    warning.textContent = impact.text;
  }

  if (onChange) onChange(format);
}

// Mídias usadas pela sequência (para o aviso falar do que está em jogo)
const sequenceMedia = () => {
  const ids = new Set(clips.map((c) => c.sourceId));
  return sources.filter((s) => ids.has(s.id));
};

function refreshCutFormatUI() {
  paintFormatUI({
    select: selectOutputFormat,
    hint: outputFormatHint,
    choice: fitChoice,
    segmented: segmentedFit,
    warning: fitWarning,
    mediaList: sequenceMedia(),
    onChange: null
  });
}

// Mudar a proporção obriga a recodificar, e o modo Rápido existe justamente
// para não recodificar. Em vez de aceitar a combinação e ignorar a escolha em
// silêncio, a opção fica indisponível com o motivo à vista.
function refreshMergeFormatUI() {
  paintFormatUI({
    select: selectMergeFormat,
    hint: mergeFormatHint,
    choice: mergeFitChoice,
    segmented: mergeSegmentedFit,
    warning: mergeFitWarning,
    mediaList: mergeVideosSizes.filter(Boolean)
  });
}

// Mudar o formato muda a proporção do quadro, então a prévia do enquadramento
// tem que ser repintada junto — senão ela passa a mentir sobre o resultado.
selectOutputFormat.addEventListener('change', () => {

  renderMonitor();
});
segmentedFit.addEventListener('change', refreshCutFormatUI);
selectMergeFormat.addEventListener('change', refreshMergeFormatUI);
mergeSegmentedFit.addEventListener('change', refreshMergeFormatUI);

btnExport.addEventListener('click', async () => {
  if (clips.length === 0 || !outputDirPath) return;

  const joinMode = selectJoinMode.value;
  const mode = 'precise';   // o corte é sempre preciso; o modo Rápido saiu da interface
  const baseName = inputOutputName.value.trim();

  // Troca o modal para a etapa de progresso e o trava até terminar
  exportStepForm.classList.add('hidden');
  exportStepProgress.classList.remove('hidden');
  exportModal.dataset.busy = '1';
  exportModalTitle.textContent = joinMode === 'merged' ? 'Montando Vídeo Único' : 'Exportando Trechos';
  btnCloseExportModal.classList.add('hidden');
  btnCloseProgress.classList.add('hidden');
  btnOpenFolder.classList.add('hidden');
  exportResultsList.innerHTML = '';
  exportProgressBarFill.style.width = '0%';
  exportProgressText.textContent = 'Iniciando...';

  // Uma linha de status por clipe
  clips.forEach((clip, index) => {
    const source = sourceById(clip.sourceId);
    const range = source.kind === 'image'
      ? `foto por ${formatTime(clip.end - clip.start)}`
      : `${formatTime(clip.start, false)} → ${formatTime(clip.end, false)}`;
    const row = document.createElement('div');
    row.className = 'result-row';
    row.id = `result-row-${clip.id}`;
    row.innerHTML = `
      <span class="result-text">${index + 1}. ${escapeHtml(clipLabel(clip))} (${escapeHtml(range)})</span>
      <span class="result-badge" id="result-badge-${clip.id}">Aguardando...</span>
    `;
    exportResultsList.appendChild(row);
  });

  const unsubProgress = window.api.onCutProgress(({ cutId, percent }) => {
    const row = document.getElementById(`result-row-${cutId}`);
    const badge = document.getElementById(`result-badge-${cutId}`);
    if (row && (row.classList.contains('success') || row.classList.contains('error'))) return;
    if (badge) badge.textContent = percent === 100 ? 'Concluído!' : `${percent}%`;
  });

  const unsubStatus = window.api.onCutStatus(({ cutId, status, message }) => {
    const row = document.getElementById(`result-row-${cutId}`);
    const badge = document.getElementById(`result-badge-${cutId}`);
    if (row && badge) {
      row.className = `result-row ${status}`;
      badge.textContent = message;
    }
  });

  const unsubOverall = window.api.onExportOverall(({ percent, message }) => {
    exportProgressBarFill.style.width = `${percent}%`;
    exportProgressText.textContent = message || `${percent}%`;
  });

  try {
    // Composição só quando é preciso: com faixas, vazios ou trilha, o caminho
    // antigo não dá conta. Enquanto a montagem for uma faixa só de trechos
    // colados, ele é preferido porque consegue cortar SEM PERDA.
    const needsComposition = !isSimpleTimeline();

    // Em arquivos separados, os pedaços são os trechos da faixa base — mas
    // recortados da montagem COMPOSTA, não das mídias originais. Sem isto, o
    // modo separado voltava às fontes e enxergava só a faixa base: faixas de
    // cima, trilhas e textos sumiam do arquivo sem nenhum aviso.
    const pedacos = joinMode === 'separate'
      ? baseItems().map((clip) => ({
        id: clip.id,
        start: clip.timelineStart,
        end: clipEnd(clip),
        name: clipLabel(clip)
      }))
      : null;

    if (needsComposition) {
      const payload = buildTimelinePayload();
      const composed = await window.api.exportTimeline({
        ...payload,
        outputDir: outputDirPath,
        baseName,
        format: currentCutFormat(),
        background: timelineBackgroundColor(),
        split: pedacos
      });

      // Separado: o retorno vem em pedaços, não em um arquivo só
      if (composed.parts) {
        exportProgressBarFill.style.width = '100%';
        lastExportTarget = composed.outputDir;
        const okCount = composed.parts.filter((p) => p.success).length;
        const failCount = composed.parts.length - okCount;
        exportProgressText.textContent = failCount === 0
          ? `${okCount} arquivo(s) salvos com sucesso, com todas as faixas.`
          : `${okCount} salvos, ${failCount} com falha.`;
        if (failCount === 0) lastExportedEditorSignature = editorSignature();
        btnOpenFolder.classList.remove('hidden');
        return;
      }

      exportProgressBarFill.style.width = '100%';
      lastExportTarget = composed.path;
      const extras = [
        composed.overlays ? `${composed.overlays} sobreposição(ões)` : null,
        composed.audioTracks ? `${composed.audioTracks} trilha(s) de áudio` : null
      ].filter(Boolean).join(', ');
      exportProgressText.textContent =
        `Montagem gerada: ${getFileName(composed.path)}` + (extras ? ` — com ${extras}` : '');
      lastExportedEditorSignature = editorSignature();
      btnOpenFolder.classList.remove('hidden');
      return;
    }

    const result = await window.api.exportClips({
      clips: buildExportPayload(),
      outputDir: outputDirPath,
      baseName,
      mode,
      joinMode,
      format: currentCutFormat()
    });

    exportProgressBarFill.style.width = '100%';

    if (result.joinMode === 'merged') {
      lastExportTarget = result.path;
      const methodNote = result.method === 'transcode'
        ? ' (formatos diferentes foram padronizados)'
        : ' (junção sem perda)';
      exportProgressText.textContent = `Vídeo único gerado: ${getFileName(result.path)}${methodNote}`;
      lastExportedEditorSignature = editorSignature();
    } else {
      lastExportTarget = result.outputDir;
      const okCount = result.results.filter((r) => r.success).length;
      const failCount = result.results.length - okCount;
      exportProgressText.textContent = failCount === 0
        ? `${okCount} arquivo(s) salvos com sucesso.`
        : `${okCount} salvos, ${failCount} com falha.`;
      // Só marca como salvo se TUDO saiu; com falhas ainda há o que perder.
      if (failCount === 0) lastExportedEditorSignature = editorSignature();
    }

    btnOpenFolder.classList.remove('hidden');
  } catch (err) {
    console.error('Erro na exportação:', err);
    exportProgressText.textContent = `Erro ao exportar: ${err.message || err}`;
  } finally {
    unsubProgress();
    unsubStatus();
    unsubOverall();
    delete exportModal.dataset.busy;
    btnCloseExportModal.classList.remove('hidden');
    btnCloseProgress.classList.remove('hidden');
  }
});

btnOpenFolder.addEventListener('click', () => {
  if (lastExportTarget) window.api.revealPath(lastExportTarget);
});

// Fecha o modal mantendo a sequência montada, para permitir exportar de novo
// em outro formato sem precisar refazer o trabalho.
btnCloseProgress.addEventListener('click', () => {
  closeModal(exportModal);
  renderAll();
});

// ==========================================================================
// 7. ATALHOS DE TECLADO
// ==========================================================================

function isTypingInField(target) {
  if (!target) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

window.addEventListener('keydown', (e) => {
  // Com um modal aberto os atalhos do editor ficam suspensos
  // (o Esc é tratado no registro central de modais)
  if (isModalOpen()) return;
  if (!isCutScreenActive()) return;

  // F2 vale mesmo com o foco num campo — é o atalho universal de renomear,
  // e quem aperta F2 quer justamente sair dali e ir para o nome da faixa.
  if (e.key === 'F2') {
    e.preventDefault();
    focusClipRename();
    return;
  }

  // Salvar e abrir valem mesmo com o foco num campo: quem aperta Ctrl+S no meio
  // de digitar um nome quer salvar o projeto, não perder o atalho.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    saveProject(e.shiftKey);   // Shift = "Salvar como"
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
    e.preventDefault();
    openProject();
    return;
  }

  if (isTypingInField(e.target)) return;

  // Atalhos com Ctrl/Cmd vêm antes: desfazer, refazer, copiar e colar
  if (e.ctrlKey || e.metaKey) {
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    else if (key === 'c') { e.preventDefault(); copySelection(); }
    else if (key === 'v') { e.preventDefault(); pasteClipboard(); }
    else if (key === 'd') { e.preventDefault(); btnClipDuplicate.click(); }
    return;
  }

  if (e.altKey) return;

  const clip = selectedClip();

  switch (e.key) {
    case ' ':
      e.preventDefault();
      toggleMonitor();
      break;
    case 's': case 'S':
      e.preventDefault();
      if (canSplitSelected()) splitSelectedAtPlayhead();
      break;
    case 'Delete': case 'Backspace':
      e.preventDefault();
      if (selectedTextId !== null) removeSelectedText();
      else if (clip) removeClip(clip.id);
      break;
    case 'm': case 'M':
      e.preventDefault();
      btnMute.click();
      break;
    case 'Escape':
      e.preventDefault();
      selectedTextId = null;
      selectItem(null);
      renderAll();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (e.shiftKey) { stopMonitor(); seekTimeline(playhead - 5); }
      else frameStepMonitor(-1);
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (e.shiftKey) { stopMonitor(); seekTimeline(playhead + 5); }
      else frameStepMonitor(1);
      break;
    case 'Home':
      e.preventDefault();
      stopMonitor();
      seekTimeline(0);
      break;
    case 'End':
      e.preventDefault();
      stopMonitor();
      seekTimeline(sequenceDuration());
      break;
    default:
      break;
  }
});

// ==========================================================================
// 8. FLUXO DE MESCLAGEM (MERGE SCREEN)
// ==========================================================================

btnSelectMergeVideos.addEventListener('click', handleSelectMergeVideos);
btnMergeAddMore.addEventListener('click', handleSelectMergeVideos);

mergeDropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  mergeDropZone.classList.add('dragover');
});
mergeDropZone.addEventListener('dragleave', () => mergeDropZone.classList.remove('dragover'));
mergeDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  mergeDropZone.classList.remove('dragover');
  const paths = collectDroppedPaths(e);
  if (paths.length > 0) loadMergeVideos(paths);
});

async function handleSelectMergeVideos() {
  const filePaths = await window.api.selectMultipleVideos();
  if (filePaths && filePaths.length > 0) {
    loadMergeVideos(filePaths);
  }
}

async function loadMergeVideos(paths) {
  try {
    for (const filePath of paths) {
      if (!mergeVideoPaths.includes(filePath)) {
        const metadata = await window.api.getVideoMetadata(filePath);
        mergeVideoPaths.push(filePath);
        mergeVideosDurations.push(metadata.duration);
        mergeVideosSizes.push({ width: metadata.width, height: metadata.height });
      }
    }

    if (!inputMergeOutputName.value.trim() && mergeVideoPaths.length > 0) {
      inputMergeOutputName.value = `${stripExtension(getFileName(mergeVideoPaths[0]))}_mesclado`;
    }

    updateMergeListUI();

    if (mergeVideoPaths.length > 0) {
      mergeDropZone.classList.add('hidden');
      mergePlayerWrapper.classList.remove('hidden');
      btnMergeAddMore.classList.remove('hidden');
      currentPlayingIndex = Math.min(currentPlayingIndex, mergeVideoPaths.length - 1);
      loadMergePreview(currentPlayingIndex);
    }
  } catch (err) {
    console.error('Erro ao obter metadados do vídeo:', err);
    alert('Não foi possível ler um dos arquivos de vídeo selecionados.');
  }
}

function loadMergePreview(index) {
  if (index < 0 || index >= mergeVideoPaths.length) return;

  const filePath = mergeVideoPaths[index];
  mergeCurrentVideoTitle.textContent = `Tocando: ${getFileName(filePath)} (${index + 1}/${mergeVideoPaths.length})`;
  mergeVideoElement.src = `file:///${filePath.replace(/\\/g, '/')}`;
  mergeVideoElement.load();

  document.querySelectorAll('#merge-list .list-item').forEach((i) => i.classList.remove('active'));
  const activeItem = document.querySelector(`#merge-list .list-item[data-merge-idx="${index}"]`);
  if (activeItem) activeItem.classList.add('active');

  if (isPlayingMergePreview) {
    mergeVideoElement.play().catch(() => {});
  }
}

function resetMergeState() {
  mergeVideoElement.pause();
  mergeVideoElement.src = '';
  mergeVideoPaths = [];
  mergeVideosDurations = [];
  mergeVideosSizes = [];
  currentPlayingIndex = 0;
  isPlayingMergePreview = false;
  lastExportedMergeSignature = null;

  mergeDropZone.classList.remove('hidden');
  mergePlayerWrapper.classList.add('hidden');
  btnMergeAddMore.classList.add('hidden');
  inputMergeOutputName.value = '';

  updateMergeListUI();
  closeModal(mergeExportModal);
}

btnMergePlayPause.addEventListener('click', () => {
  if (mergeVideoElement.paused) {
    mergeVideoElement.play().catch(() => {});
    isPlayingMergePreview = true;
  } else {
    mergeVideoElement.pause();
    isPlayingMergePreview = false;
  }
});

mergeVideoElement.addEventListener('play', () => {
  mergePlayIcon.classList.add('hidden');
  mergePauseIcon.classList.remove('hidden');
});

mergeVideoElement.addEventListener('pause', () => {
  mergePlayIcon.classList.remove('hidden');
  mergePauseIcon.classList.add('hidden');
});

btnMergeRewind.addEventListener('click', () => {
  mergeVideoElement.currentTime = Math.max(0, mergeVideoElement.currentTime - 5);
});

btnMergeForward.addEventListener('click', () => {
  const currentDuration = mergeVideosDurations[currentPlayingIndex] || 0;
  mergeVideoElement.currentTime = Math.min(currentDuration, mergeVideoElement.currentTime + 5);
});

// Ao terminar um vídeo, encadeia o próximo — dá uma prévia da mesclagem
mergeVideoElement.addEventListener('ended', () => {
  if (currentPlayingIndex < mergeVideoPaths.length - 1) {
    currentPlayingIndex++;
    loadMergePreview(currentPlayingIndex);
  } else {
    mergeVideoElement.pause();
    isPlayingMergePreview = false;
    currentPlayingIndex = 0;
    loadMergePreview(0);
  }
});

mergeVideoElement.addEventListener('timeupdate', () => {
  const current = mergeVideoElement.currentTime;
  const currentDuration = mergeVideosDurations[currentPlayingIndex] || 0;

  mergeTimeDisplay.textContent = `${formatTime(current, false)} / ${formatTime(currentDuration, false)}`;

  if (currentDuration > 0) {
    const percent = (current / currentDuration) * 100;
    mergeTimelinePlayhead.style.left = `${percent}%`;
    mergeTimelineProgressBar.style.width = `${percent}%`;
  }
});

mergeTimelineContainer.addEventListener('mousedown', (e) => {
  isMergeTimelineDragging = true;
  seekMergeTimeline(e);
});

function seekMergeTimeline(e) {
  const currentDuration = mergeVideosDurations[currentPlayingIndex] || 0;
  if (!currentDuration) return;
  const rect = mergeTimelineContainer.getBoundingClientRect();
  const x = clamp(e.clientX - rect.left, 0, rect.width);
  mergeVideoElement.currentTime = (x / rect.width) * currentDuration;
}

function updateMergeListUI() {
  mergeVideosCounterDisp.textContent = mergeVideoPaths.length;

  const hasVideos = mergeVideoPaths.length > 0;
  mergeListPlaceholder.classList.toggle('hidden', hasVideos);
  mergeList.classList.toggle('hidden', !hasVideos);
  updateMergeExportAvailability();

  mergeList.innerHTML = '';
  mergeVideoPaths.forEach((filePath, index) => {
    const duration = mergeVideosDurations[index] || 0;

    const item = document.createElement('div');
    item.className = 'list-item' + (index === currentPlayingIndex && hasVideos ? ' active' : '');
    item.dataset.mergeIdx = index;
    item.title = filePath;

    item.innerHTML = `
      <span class="item-index">${index + 1}</span>
      <div class="item-body">
        <span class="item-title">${escapeHtml(getFileName(filePath))}</span>
        <span class="item-meta">${formatTime(duration, false)}</span>
      </div>
      <div class="item-actions">
        <button class="action-mini-btn move-up" title="Subir" ${index === 0 ? 'disabled' : ''}>${ICON_UP}</button>
        <button class="action-mini-btn move-down" title="Descer" ${index === mergeVideoPaths.length - 1 ? 'disabled' : ''}>${ICON_DOWN}</button>
        <button class="action-mini-btn delete-cut" title="Remover da lista">${ICON_TRASH}</button>
      </div>
    `;

    item.addEventListener('click', () => {
      currentPlayingIndex = index;
      loadMergePreview(index);
      updateMergeListUI();
    });

    item.querySelector('.move-up').addEventListener('click', (e) => {
      e.stopPropagation();
      swapMergeElements(index, index - 1);
    });
    item.querySelector('.move-down').addEventListener('click', (e) => {
      e.stopPropagation();
      swapMergeElements(index, index + 1);
    });
    item.querySelector('.delete-cut').addEventListener('click', (e) => {
      e.stopPropagation();
      removeMergeVideo(index);
    });

    mergeList.appendChild(item);
  });
}

function swapMergeElements(idx1, idx2) {
  if (idx2 < 0 || idx2 >= mergeVideoPaths.length) return;

  [mergeVideoPaths[idx1], mergeVideoPaths[idx2]] = [mergeVideoPaths[idx2], mergeVideoPaths[idx1]];
  [mergeVideosDurations[idx1], mergeVideosDurations[idx2]] = [mergeVideosDurations[idx2], mergeVideosDurations[idx1]];
  [mergeVideosSizes[idx1], mergeVideosSizes[idx2]] = [mergeVideosSizes[idx2], mergeVideosSizes[idx1]];

  if (currentPlayingIndex === idx1) currentPlayingIndex = idx2;
  else if (currentPlayingIndex === idx2) currentPlayingIndex = idx1;

  updateMergeListUI();
}

function removeMergeVideo(index) {
  mergeVideoPaths.splice(index, 1);
  mergeVideosDurations.splice(index, 1);
  mergeVideosSizes.splice(index, 1);

  if (currentPlayingIndex >= mergeVideoPaths.length) {
    currentPlayingIndex = Math.max(0, mergeVideoPaths.length - 1);
  }

  if (mergeVideoPaths.length === 0) {
    resetMergeState();
  } else {
    updateMergeListUI();
    loadMergePreview(currentPlayingIndex);
  }
}

btnMergeSelectOutput.addEventListener('click', async () => {
  const dirPath = await window.api.selectOutputDir();
  if (dirPath) {
    mergeOutputDirPath = dirPath;
    mergeOutputPathDisplay.value = dirPath;
    try { localStorage.setItem(STORAGE_KEYS.mergeOutputDir, dirPath); } catch (e) {}
    updateMergeExportAvailability();
  }
});

inputMergeOutputName.addEventListener('input', updateMergeExportAvailability);

function updateMergeExportAvailability() {
  btnOpenMergeExport.disabled = mergeVideoPaths.length < 2;
  btnMergeExport.disabled = !(
    mergeVideoPaths.length >= 2 &&
    mergeOutputDirPath &&
    inputMergeOutputName.value.trim().length > 0
  );
}

btnOpenMergeExport.addEventListener('click', () => {
  if (mergeVideoPaths.length < 2) return;

  mergeStepForm.classList.remove('hidden');
  mergeStepProgress.classList.add('hidden');
  delete mergeExportModal.dataset.busy;

  const total = mergeVideosDurations.reduce((sum, d) => sum + (d || 0), 0);
  mergeSummary.innerHTML =
    `<strong>${mergeVideoPaths.length}</strong> vídeos` +
    `<span class="summary-sep">•</span><strong>${formatTime(total)}</strong> no total`;

  openModal(mergeExportModal);
  refreshMergeFormatUI();
  updateMergeExportAvailability();
  inputMergeOutputName.focus();
});

btnCloseMergeModal.addEventListener('click', () => closeModal(mergeExportModal));
btnCancelMergeExport.addEventListener('click', () => closeModal(mergeExportModal));

btnMergeExport.addEventListener('click', async () => {
  if (mergeVideoPaths.length < 2 || !mergeOutputDirPath) return;

  mergeStepForm.classList.add('hidden');
  mergeStepProgress.classList.remove('hidden');
  mergeExportModal.dataset.busy = '1';
  btnCloseMergeModal.classList.add('hidden');
  btnMergeCloseProgress.classList.add('hidden');
  btnMergeOpenFolder.classList.add('hidden');
  mergeProgressBarFill.style.width = '0%';
  mergeProgressText.textContent = 'Iniciando mesclagem...';

  const unsubProgress = window.api.onMergeProgress(({ percent }) => {
    mergeProgressBarFill.style.width = `${percent}%`;
    mergeProgressText.textContent = percent === 100 ? 'Concluído!' : `Mesclando vídeos: ${percent}%`;
  });

  const unsubStatus = window.api.onMergeStatus(({ status, message }) => {
    if (status === 'success') {
      mergeProgressBarFill.style.width = '100%';
      mergeProgressText.textContent = 'Concluído!';
    } else {
      mergeProgressText.textContent = message;
    }
  });

  try {
    const result = await window.api.mergeVideos(
      mergeVideoPaths,
      mergeOutputDirPath,
      inputMergeOutputName.value.trim(),
      currentMergeFormat()
    );
    lastMergeTarget = result.path;
    mergeProgressText.textContent = `Salvo: ${getFileName(result.path)}`;
    btnMergeOpenFolder.classList.remove('hidden');
    lastExportedMergeSignature = mergeSignature();
  } catch (err) {
    console.error('Erro de mesclagem:', err);
    mergeProgressText.textContent = `Erro ao mesclar: ${err.message || err}`;
  } finally {
    unsubProgress();
    unsubStatus();
    delete mergeExportModal.dataset.busy;
    btnCloseMergeModal.classList.remove('hidden');
    btnMergeCloseProgress.classList.remove('hidden');
  }
});

let lastMergeTarget = null;

btnMergeOpenFolder.addEventListener('click', () => {
  if (lastMergeTarget) window.api.revealPath(lastMergeTarget);
});

btnMergeCloseProgress.addEventListener('click', () => closeModal(mergeExportModal));


// ==========================================================================
// TÍTULOS E LEGENDAS
//
// Texto não é mídia: não vem de arquivo nem tem recorte de origem. Por isso
// mora numa lista própria e numa pista própria da linha do tempo, em vez de
// virar um "clipe sem fonte" — o que espalharia verificações de nulo por todo
// o resto do editor.
//
// Posição e tamanho são FRAÇÃO do quadro, então o que se vê no monitor é o
// que sai no arquivo, em qualquer resolução.
// ==========================================================================

let texts = [];
let textIdCounter = 0;
let selectedTextId = null;

const MIN_TEXT_DURATION = 0.3;

const textById = (id) => texts.find((t) => t.id === id) || null;
const selectedText = () => textById(selectedTextId);
const textEnd = (text) => text.timelineStart + text.duration;

// Dois usos, dois padrões. Título: grande, no meio, sem tarja. Legenda:
// menor, embaixo, com tarja escura — que é o que a torna legível sobre
// qualquer imagem.
const TEXT_PRESETS = {
  titulo: {
    label: 'Título', content: 'Seu título aqui',
    size: 0.11, y: 0.28, color: '#ffffff', bold: true,
    background: false, backgroundColor: '#000000', backgroundOpacity: 0.5,
    outline: true, duration: 3
  },
  legenda: {
    label: 'Legenda', content: 'Sua legenda aqui',
    size: 0.055, y: 0.86, color: '#ffffff', bold: false,
    background: true, backgroundColor: '#000000', backgroundOpacity: 0.55,
    outline: false, duration: 3
  }
};

function createText(presetName, at) {
  const preset = TEXT_PRESETS[presetName] || TEXT_PRESETS.titulo;
  textIdCounter++;
  const text = {
    id: textIdCounter,
    content: preset.content,
    timelineStart: Math.max(0, at || 0),
    duration: preset.duration,
    x: 0.5,
    y: preset.y,
    size: preset.size,
    color: preset.color,
    bold: preset.bold,
    background: preset.background,
    backgroundColor: preset.backgroundColor,
    backgroundOpacity: preset.backgroundOpacity,
    outline: preset.outline
  };
  texts.push(text);
  return text;
}

function addText(presetName) {
  const text = createText(presetName, playhead);
  selectText(text.id);
  renderAll();
  commitHistory();
  // O cursor já vai para o campo: quem adiciona um título quer escrever nele
  inputTextContent.focus();
  inputTextContent.select();
}

function selectText(id) {
  selectedTextId = id;
  if (id !== null) {
    // Texto e trecho não ficam selecionados ao mesmo tempo: o painel mostra um
    // ou outro, e manter os dois faria o Delete apagar mais do que o esperado.
    selectItem(null);
    showDock('props');
  }
}

function removeSelectedText() {
  if (selectedTextId === null) return;
  texts = texts.filter((t) => t.id !== selectedTextId);
  selectedTextId = null;
  renderAll();
  commitHistory();
}

function updateSelectedText(changes, commit) {
  const text = selectedText();
  if (!text) return;
  Object.assign(text, changes);
  if (commit) {
    renderAll();
    commitHistory();
  } else {
    renderMonitor();
    renderTextLane();
  }
}

// --- Pista de texto na linha do tempo ---
function renderTextLane() {
  const width = timelineWidthPx();
  textLane.style.width = `${width}px`;
  textLane.style.backgroundSize = `${secondsToPx(rulerStep())}px 100%`;
  textLane.innerHTML = '';

  texts.forEach((text) => {
    const block = document.createElement('div');
    block.className = 'tl-text' + (text.id === selectedTextId ? ' selected' : '');
    block.style.left = `${secondsToPx(text.timelineStart)}px`;
    block.style.width = `${Math.max(8, secondsToPx(text.duration))}px`;
    block.title = text.content;
    block.innerHTML =
      '<div class="tl-item-handle left"></div>' +
      `<span class="tl-text-label">${escapeHtml(text.content.split('\n')[0] || 'texto')}</span>` +
      '<div class="tl-item-handle right"></div>';

    block.addEventListener('mousedown', (e) => startTextGesture(e, text, block));
    textLane.appendChild(block);
  });
}

// Mover e esticar, com a mesma divisão do bloco de mídia: as bordas esticam,
// o meio move.
let textGesture = null;

function startTextGesture(e, text, block) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const rect = block.getBoundingClientRect();
  const offset = e.clientX - rect.left;
  let mode = 'move';
  if (offset <= HANDLE_HIT_PIXELS) mode = 'trim-start';
  else if (rect.width - offset <= HANDLE_HIT_PIXELS) mode = 'trim-end';

  selectText(text.id);
  renderAll();

  textGesture = {
    id: text.id, mode, startX: e.clientX,
    baseStart: text.timelineStart, baseDuration: text.duration
  };
  document.body.classList.add('dragging-item');
}

window.addEventListener('mousemove', (e) => {
  if (!textGesture) return;
  const text = textById(textGesture.id);
  if (!text) return;

  const delta = pxToSeconds(e.clientX - textGesture.startX) - pxToSeconds(0);

  if (textGesture.mode === 'move') {
    text.timelineStart = Math.max(0, textGesture.baseStart + delta);
  } else if (textGesture.mode === 'trim-end') {
    text.duration = Math.max(MIN_TEXT_DURATION, textGesture.baseDuration + delta);
  } else {
    // Esticar pelo início move o começo e compensa na duração, para o fim
    // ficar parado — é o que se espera ao puxar a borda esquerda.
    const start = Math.max(0, Math.min(
      textGesture.baseStart + delta,
      textGesture.baseStart + textGesture.baseDuration - MIN_TEXT_DURATION
    ));
    text.duration = textGesture.baseStart + textGesture.baseDuration - start;
    text.timelineStart = start;
  }

  renderTextLane();
  renderMonitor();
});

window.addEventListener('mouseup', () => {
  if (!textGesture) return;
  textGesture = null;
  document.body.classList.remove('dragging-item');
  renderAll();
  commitHistory();
});

// --- Painel de propriedades ---
function renderTextPanel() {
  const text = selectedText();
  groupText.classList.toggle('hidden', !text);
  if (!text) return;

  inputTextContent.value = text.content;
  inputTextStart.value = formatTime(text.timelineStart);
  inputTextDuration.value = text.duration.toFixed(1);
  inputTextSize.value = String(Math.round(text.size * 100));
  textSizeReadout.textContent = `${Math.round(text.size * 100)}%`;
  inputTextColor.value = text.color;
  btnTextBold.classList.toggle('active', !!text.bold);
  btnTextOutline.classList.toggle('active', !!text.outline);
  inputTextBg.checked = !!text.background;
  inputTextBgColor.value = text.backgroundColor;
  inputTextBgOpacity.value = String(Math.round(text.backgroundOpacity * 100));
  textBgOpacityReadout.textContent = `${Math.round(text.backgroundOpacity * 100)}%`;
  rowTextBg.classList.toggle('hidden', !text.background);

  textPositionHint.textContent =
    `Centro em ${Math.round(text.x * 100)}% × ${Math.round(text.y * 100)}% do quadro — ` +
    'arraste o texto no monitor para mudar.';
}

inputTextContent.addEventListener('input', () => updateSelectedText({ content: inputTextContent.value }, false));
inputTextContent.addEventListener('change', () => updateSelectedText({ content: inputTextContent.value }, true));

inputTextStart.addEventListener('change', () =>
  updateSelectedText({ timelineStart: Math.max(0, parseTimeToSeconds(inputTextStart.value)) }, true));

inputTextDuration.addEventListener('change', () => {
  const raw = parseFloat(String(inputTextDuration.value).replace(',', '.'));
  updateSelectedText({ duration: Math.max(MIN_TEXT_DURATION, Number.isFinite(raw) ? raw : 3) }, true);
});

inputTextSize.addEventListener('input', () => {
  updateSelectedText({ size: Number(inputTextSize.value) / 100 }, false);
  textSizeReadout.textContent = `${inputTextSize.value}%`;
});
inputTextSize.addEventListener('change', () => updateSelectedText({}, true));

inputTextColor.addEventListener('input', () => updateSelectedText({ color: inputTextColor.value }, false));
inputTextColor.addEventListener('change', () => updateSelectedText({}, true));

btnTextBold.addEventListener('click', () => {
  const text = selectedText();
  if (text) updateSelectedText({ bold: !text.bold }, true);
});
btnTextOutline.addEventListener('click', () => {
  const text = selectedText();
  if (text) updateSelectedText({ outline: !text.outline }, true);
});

inputTextBg.addEventListener('change', () => updateSelectedText({ background: inputTextBg.checked }, true));
inputTextBgColor.addEventListener('input', () => updateSelectedText({ backgroundColor: inputTextBgColor.value }, false));
inputTextBgColor.addEventListener('change', () => updateSelectedText({}, true));
inputTextBgOpacity.addEventListener('input', () => {
  updateSelectedText({ backgroundOpacity: Number(inputTextBgOpacity.value) / 100 }, false);
  textBgOpacityReadout.textContent = `${inputTextBgOpacity.value}%`;
});
inputTextBgOpacity.addEventListener('change', () => updateSelectedText({}, true));

btnTextRemove.addEventListener('click', removeSelectedText);

btnAddTitle.addEventListener('click', () => addText('titulo'));
btnAddSubtitle.addEventListener('click', () => addText('legenda'));

// --- Prévia no monitor ---
//
// O tamanho da fonte é fração da ALTURA do quadro, a mesma conta do drawtext;
// por isso o que aparece aqui bate com o arquivo exportado.
function renderTextOverlays() {
  textOverlays.innerHTML = '';
  const frameHeight = mediaFrame.getBoundingClientRect().height;
  if (!frameHeight) return;

  texts.forEach((text) => {
    if (playhead < text.timelineStart - 0.001 || playhead >= textEnd(text) - 0.001) return;

    const element = document.createElement('div');
    element.className = 'text-overlay' + (text.id === selectedTextId ? ' selected' : '');
    element.textContent = text.content;
    element.style.left = `${text.x * 100}%`;
    element.style.top = `${text.y * 100}%`;
    element.style.fontSize = `${text.size * frameHeight}px`;
    element.style.color = text.color;
    element.style.fontWeight = text.bold ? '800' : '500';
    element.style.textShadow = text.outline
      ? '0 0 3px rgba(0,0,0,0.9), 0 0 6px rgba(0,0,0,0.7)'
      : 'none';

    if (text.background) {
      element.style.background = hexToRgba(text.backgroundColor, text.backgroundOpacity);
      element.style.padding = `${text.size * frameHeight * 0.28}px`;
    }

    element.addEventListener('mousedown', (e) => startTextDrag(e, text));
    textOverlays.appendChild(element);
  });
}

const hexToRgba = (hex, alpha) => {
  const clean = /^#[0-9a-fA-F]{6}$/.test(hex || '') ? hex : '#000000';
  const r = parseInt(clean.slice(1, 3), 16);
  const g = parseInt(clean.slice(3, 5), 16);
  const b = parseInt(clean.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
};

// Arrastar o texto no monitor posiciona onde ele vai ficar no vídeo
let textDrag = null;

function startTextDrag(e, text) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  selectText(text.id);
  renderAll();

  const rect = mediaFrame.getBoundingClientRect();
  textDrag = {
    id: text.id, rect,
    grabX: (e.clientX - rect.left) / rect.width - text.x,
    grabY: (e.clientY - rect.top) / rect.height - text.y
  };
}

window.addEventListener('mousemove', (e) => {
  if (!textDrag) return;
  const text = textById(textDrag.id);
  if (!text) return;
  const { rect, grabX, grabY } = textDrag;
  text.x = clamp((e.clientX - rect.left) / rect.width - grabX, 0, 1);
  text.y = clamp((e.clientY - rect.top) / rect.height - grabY, 0, 1);
  renderTextOverlays();
  renderTextPanel();
});

window.addEventListener('mouseup', () => {
  if (!textDrag) return;
  textDrag = null;
  renderAll();
  commitHistory();
});

// O que vai para o ffmpeg. Textos vazios não viram filtro: um drawtext sem
// conteúdo só custaria tempo de processamento.
function buildTextPayload() {
  return texts
    .filter((t) => String(t.content || '').trim().length > 0)
    .map((t) => ({
      content: t.content,
      timelineStart: t.timelineStart,
      duration: t.duration,
      x: t.x, y: t.y, size: t.size,
      color: t.color, bold: !!t.bold,
      background: !!t.background,
      backgroundColor: t.backgroundColor,
      backgroundOpacity: t.backgroundOpacity,
      outline: !!t.outline
    }));
}


// ==========================================================================
// ALTURA DA LINHA DO TEMPO
//
// Com muitas faixas, 232px não bastam. A divisória deixa esticar a área das
// faixas para cima; o que sobra fica com o monitor. Os dois têm um piso: a
// linha do tempo sem espaço para uma faixa não serve, e um monitor de 40px
// também não.
// ==========================================================================

const TIMELINE_HEIGHT_MIN = 150;
const EDITOR_TOP_MIN = 220;      // espaço mínimo para o monitor e a biblioteca

// Teto: o que sobra da janela depois de reservar o mínimo para a área de cima.
const maxTimelineHeight = () =>
  Math.max(TIMELINE_HEIGHT_MIN, editorShell.getBoundingClientRect().height - EDITOR_TOP_MIN);

function setTimelineHeight(pixels, remember) {
  const height = clamp(Math.round(pixels), TIMELINE_HEIGHT_MIN, maxTimelineHeight());
  timelineSection.style.height = `${height}px`;
  if (remember) {
    try { localStorage.setItem(STORAGE_KEYS.timelineHeight, String(height)); } catch (err) { /* sem persistência */ }
  }
  return height;
}

// Restaura a altura escolhida na sessão anterior
(function restoreTimelineHeight() {
  try {
    const saved = parseInt(localStorage.getItem(STORAGE_KEYS.timelineHeight), 10);
    if (Number.isFinite(saved)) setTimelineHeight(saved, false);
  } catch (err) {
    // localStorage indisponível — fica com a altura padrão do CSS
  }
})();

let timelineResize = null;

timelineResizer.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  timelineResize = {
    startY: e.clientY,
    startHeight: timelineSection.getBoundingClientRect().height
  };
  timelineResizer.classList.add('dragging');
  document.body.classList.add('resizing-timeline');
});

window.addEventListener('mousemove', (e) => {
  if (!timelineResize) return;
  // Arrastar para CIMA (clientY menor) aumenta a linha do tempo
  setTimelineHeight(timelineResize.startHeight + (timelineResize.startY - e.clientY), false);
});

window.addEventListener('mouseup', () => {
  if (!timelineResize) return;
  timelineResize = null;
  timelineResizer.classList.remove('dragging');
  document.body.classList.remove('resizing-timeline');
  setTimelineHeight(timelineSection.getBoundingClientRect().height, true);
});

// Duplo clique volta ao padrão — mais rápido que acertar a altura no arraste.
// Voltar ao padrão é APAGAR a altura inline: quem define o padrão é o CSS, e
// copiar o número para cá daria duas fontes de verdade para sincronizar.
timelineResizer.addEventListener('dblclick', () => {
  timelineSection.style.height = '';
  try { localStorage.removeItem(STORAGE_KEYS.timelineHeight); } catch (err) { /* sem persistência */ }
});

// Reduzir a janela pode deixar a altura guardada maior que o teto novo. Sem
// isto, o monitor sumiria e não haveria como trazê-lo de volta.
window.addEventListener('resize', () => {
  if (!timelineSection.style.height) return;
  setTimelineHeight(parseFloat(timelineSection.style.height), false);
});


// ==========================================================================
// PROJETOS RECENTES (tela inicial)
//
// A lista guarda só CAMINHOS, como o próprio arquivo de projeto. Um item que
// aponta para um arquivo que sumiu continua aparecendo, riscado: some sem
// explicação seria pior do que mostrar o que aconteceu.
// ==========================================================================

const RECENT_LIMIT = 6;

function readRecentProjects() {
  try {
    const bruto = JSON.parse(localStorage.getItem(STORAGE_KEYS.recentProjects) || '[]');
    return Array.isArray(bruto) ? bruto.filter((r) => r && typeof r.path === 'string') : [];
  } catch (err) {
    return [];
  }
}

function writeRecentProjects(lista) {
  try {
    localStorage.setItem(STORAGE_KEYS.recentProjects, JSON.stringify(lista.slice(0, RECENT_LIMIT)));
  } catch (err) {
    // localStorage indisponível — a lista simplesmente não persiste
  }
}

// Salvar ou abrir um projeto o coloca no topo da lista
function rememberProject(filePath) {
  if (!filePath) return;
  const resto = readRecentProjects().filter((r) => r.path !== filePath);
  writeRecentProjects([{ path: filePath, at: new Date().toISOString() }, ...resto]);
  renderRecentProjects();
}

function forgetProject(filePath) {
  writeRecentProjects(readRecentProjects().filter((r) => r.path !== filePath));
  renderRecentProjects();
}

// "há 2 dias" diz mais que uma data exata para algo aberto na semana passada;
// além de uma semana, a data é mais informativa que a contagem.
function quandoFoi(iso) {
  const quando = new Date(iso);
  if (Number.isNaN(quando.getTime())) return '';

  const dias = Math.floor((Date.now() - quando.getTime()) / 86400000);
  if (dias <= 0) return `hoje, ${quando.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  if (dias === 1) return 'ontem';
  if (dias < 7) return `há ${dias} dias`;
  return quando.toLocaleDateString('pt-BR');
}

async function renderRecentProjects() {
  const lista = readRecentProjects();
  recentEmpty.classList.toggle('hidden', lista.length > 0);
  recentList.innerHTML = '';
  if (lista.length === 0) return;

  const existe = await window.api.filesExist(lista.map((r) => r.path));

  lista.forEach((registro) => {
    const nome = stripExtension(getFileName(registro.path));
    const pasta = registro.path.slice(0, registro.path.length - getFileName(registro.path).length - 1);
    const sumiu = existe[registro.path] === false;

    const item = document.createElement('button');
    item.className = 'recent-item' + (sumiu ? ' sumiu' : '');
    item.title = registro.path;
    item.innerHTML =
      '<span class="recent-dot"></span>' +
      `<span class="recent-name">${escapeHtml(nome)}</span>` +
      `<span class="recent-path">${escapeHtml(pasta)}</span>` +
      `<span class="recent-when">${sumiu ? 'arquivo não encontrado' : escapeHtml(quandoFoi(registro.at))}</span>`;

    const remover = document.createElement('button');
    remover.className = 'recent-remove';
    remover.title = 'Tirar da lista';
    remover.textContent = '×';
    remover.addEventListener('click', (e) => {
      e.stopPropagation();
      forgetProject(registro.path);
    });
    item.appendChild(remover);

    item.addEventListener('click', () => abrirProjetoDaHome(registro.path));
    recentList.appendChild(item);
  });
}

// Abrir da tela inicial entra no editor e carrega o projeto. Se o arquivo não
// abrir, o aviso vem de loadProjectFrom e o editor fica vazio, pronto para uso.
async function abrirProjetoDaHome(filePath) {
  switchScreen(cutScreen);
  const ok = await loadProjectFrom(filePath);
  if (ok) rememberProject(filePath);
}

btnMenuOpen.addEventListener('click', async () => {
  const filePath = await window.api.projectOpenDialog();
  if (filePath) await abrirProjetoDaHome(filePath);
});

// ==========================================================================
// INICIALIZAÇÃO
// ==========================================================================
initTracks();
setTimelineZoom(pixelsPerSecond);
renderAll();
resetHistory();
updateMergeExportAvailability();

// A recuperação vem depois do primeiro render: ela pode trocar a tela e
// repovoar o editor, e precisa encontrar tudo já montado.
renderRecentProjects();
startAutosave();
offerRecovery();
