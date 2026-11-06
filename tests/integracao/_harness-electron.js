// Roda DENTRO do Electron (não com node): sobe o app de verdade, exercita os
// handlers e a interface, e imprime uma linha "RESULTADOS:<json>".
// Quem lê isso e transforma em testes é electron.test.js.
//
// A janela fica invisível e os dados do app vão para uma pasta temporária:
// nada do que está em %APPDATA% do Cutting é tocado.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { app, BrowserWindow, ipcMain } = require('electron');

const PROJ = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cutting-e2e-'));

app.setPath('userData', path.join(tmp, 'userData'));
app.setAppPath(PROJ);

const ffmpegPath = require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');
const ffprobePath = require('@ffprobe-installer/ffprobe').path.replace('app.asar', 'app.asar.unpacked');

const resultados = [];
const checar = (nome, ok, detalhe) => resultados.push({ nome, ok: !!ok, detalhe: detalhe === undefined ? '' : String(detalhe) });
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function gerar(args) {
  const r = spawnSync(ffmpegPath, ['-y', '-v', 'error', ...args], { encoding: 'utf8', timeout: 60000 });
  if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
}

function probe(arquivo) {
  const r = spawnSync(ffprobePath, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', arquivo], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const j = JSON.parse(r.stdout);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  return {
    duracao: Number(j.format.duration),
    temVideo: j.streams.some((s) => s.codec_type === 'video'),
    codecAudio: a ? a.codec_name : null
  };
}

const errosDoConsole = [];
app.on('browser-window-created', (e, w) => {
  // Invisível, mas "visível" para o Chromium (senão ele estrangula os timers)
  w.setOpacity(0);
  w.setSkipTaskbar(true);
  w.setPosition(-4000, -4000);
  w.webContents.setBackgroundThrottling(false);
  w.webContents.on('console-message', (event, level, message) => {
    if (level >= 3) errosDoConsole.push(message);
  });
  w.webContents.on('render-process-gone', (ev, d) => errosDoConsole.push(`render-process-gone: ${d.reason}`));
});

require(path.join(PROJ, 'main.js'));

const guarda = setTimeout(() => {
  console.log('RESULTADOS:' + JSON.stringify([...resultados, { nome: 'harness terminou no prazo', ok: false, detalhe: 'estourou 150s' }]));
  app.exit(2);
}, 150000);

app.whenReady().then(async () => {
  try {
    await executar();
  } catch (e) {
    checar('harness sem exceção', false, e && e.stack || e);
  }
  clearTimeout(guarda);
  console.log('RESULTADOS:' + JSON.stringify(resultados));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  app.exit(0);
});

async function executar() {
  // ----- mídias de teste -----
  const video = path.join(tmp, 'Reunião teste.mp4');
  const semAudio = path.join(tmp, 'mudo.mp4');
  const wav = path.join(tmp, 'trilha.wav');
  gerar(['-f', 'lavfi', '-i', 'testsrc=d=2:s=320x180:r=10', '-f', 'lavfi', '-i', 'sine=f=880:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  gerar(['-f', 'lavfi', '-i', 'testsrc=d=2:s=320x180:r=10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', semAudio]);
  gerar(['-f', 'lavfi', '-i', 'sine=f=440:d=2', wav]);

  const handler = (canal) => ipcMain._invokeHandlers.get(canal);
  const ev = { sender: { send() {} } };
  const tracks = [{ id: 1, kind: 'video', muted: false }, { id: 2, kind: 'audio', muted: false }];
  const item = (extra) => ({ speed: 1, volume: 1, muted: false, normalize: false, transition: 'fade', framing: null, ...extra });

  // ----- handler: export-timeline-audio -----
  const saidaA = path.join(tmp, 'saida-a'); fs.mkdirSync(saidaA);
  const soAudio = await handler('export-timeline-audio')(ev, {
    tracks, texts: [], outputDir: saidaA, baseName: 'so_audio', audioFormat: 'mp3', background: '#000000',
    items: [item({ id: 1, trackId: 2, sourcePath: wav, kind: 'audio', timelineStart: 0, sourceStart: 0, sourceEnd: 2 })]
  });
  const pSoAudio = probe(soAudio.path);
  checar('export-timeline-audio: montagem só de áudio gera mp3 sem vídeo', pSoAudio && !pSoAudio.temVideo && pSoAudio.codecAudio === 'mp3', JSON.stringify(pSoAudio));
  checar('export-timeline-audio: duração da montagem', pSoAudio && Math.abs(pSoAudio.duracao - 2) < 0.3, pSoAudio && pSoAudio.duracao);

  const comVideo = await handler('export-timeline-audio')(ev, {
    tracks, texts: [{ content: 'Título que não pode quebrar' }], outputDir: saidaA, baseName: 'video_e_audio', audioFormat: 'm4a', background: '#000000',
    items: [
      item({ id: 1, trackId: 1, sourcePath: video, kind: 'video', timelineStart: 0, sourceStart: 0, sourceEnd: 2 }),
      item({ id: 2, trackId: 2, sourcePath: wav, kind: 'audio', timelineStart: 1, sourceStart: 0, sourceEnd: 1 })
    ]
  });
  const pComVideo = probe(comVideo.path);
  checar('export-timeline-audio: vídeo + trilha vira m4a só com áudio', pComVideo && !pComVideo.temVideo && pComVideo.codecAudio === 'aac', JSON.stringify(pComVideo));

  const repetido = await handler('export-timeline-audio')(ev, {
    tracks, texts: [], outputDir: saidaA, baseName: 'so_audio', audioFormat: 'mp3', background: '#000000',
    items: [item({ id: 1, trackId: 2, sourcePath: wav, kind: 'audio', timelineStart: 0, sourceStart: 0, sourceEnd: 1 })]
  });
  checar('export-timeline-audio: não sobrescreve arquivo existente', path.basename(repetido.path) === 'so_audio (2).mp3' && fs.existsSync(soAudio.path), path.basename(repetido.path));

  const formatoRuim = await handler('export-timeline-audio')(ev, {
    tracks, texts: [], outputDir: saidaA, baseName: 'formato_ruim', audioFormat: 'ogg', background: '#000000',
    items: [item({ id: 1, trackId: 2, sourcePath: wav, kind: 'audio', timelineStart: 0, sourceStart: 0, sourceEnd: 1 })]
  });
  checar('export-timeline-audio: formato desconhecido cai em mp3', path.extname(formatoRuim.path) === '.mp3', formatoRuim.path);

  const temp = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('cutting_au_'));
  checar('export-timeline-audio: não deixa pasta temporária para trás', temp.length === 0, temp.join(','));

  // ----- handler: separate-audio -----
  const sep1 = await handler('separate-audio')(ev, { sourcePath: video });
  checar('separate-audio: grava "<nome> (áudio).m4a" ao lado do vídeo', sep1.ok && path.basename(sep1.path) === 'Reunião teste (áudio).m4a' && path.dirname(sep1.path) === path.dirname(video), JSON.stringify(sep1));
  const pSep = sep1.ok ? probe(sep1.path) : null;
  checar('separate-audio: o arquivo é só áudio, com a duração do vídeo', pSep && !pSep.temVideo && Math.abs(pSep.duracao - 2) < 0.3, JSON.stringify(pSep));

  const sep2 = await handler('separate-audio')(ev, { sourcePath: video });
  checar('separate-audio: reaproveita a extração enquanto o vídeo não muda', sep2.ok && sep2.reused === true && sep2.path === sep1.path, JSON.stringify(sep2));

  const futuro = new Date(Date.now() + 60000);
  fs.utimesSync(video, futuro, futuro);
  const sep3 = await handler('separate-audio')(ev, { sourcePath: video });
  checar('separate-audio: vídeo modificado gera extração nova, sem apagar a antiga', sep3.ok && sep3.reused === false && sep3.path !== sep1.path && fs.existsSync(sep1.path), JSON.stringify(sep3));

  const sep4 = await handler('separate-audio')(ev, { sourcePath: semAudio });
  checar('separate-audio: vídeo sem áudio devolve erro claro, sem criar arquivo', sep4.ok === false && /áudio/.test(sep4.error) && !fs.existsSync(path.join(tmp, 'mudo (áudio).m4a')), JSON.stringify(sep4));

  const ext1 = await handler('extract-audio')(ev, { sourcePath: semAudio });
  checar('extract-audio: vídeo sem áudio recusa antes de abrir o diálogo', ext1.ok === false && /áudio/.test(ext1.error), JSON.stringify(ext1));

  // ----- interface -----
  const win = BrowserWindow.getAllWindows()[0];
  if (win.webContents.isLoading()) await new Promise((r) => win.webContents.once('did-finish-load', r));
  await dormir(500);
  const js = (codigo) => win.webContents.executeJavaScript(codigo, true);

  checar('interface: carregou sem erro no console', errosDoConsole.length === 0, errosDoConsole.join(' | '));

  const globais = await js(`({
    tempo: typeof window.CuttingTempo,
    isSimple: typeof isSimpleTimeline,
    formatTime: typeof formatTime,
    separar: typeof separateAudioFromClip,
    exportar: typeof exportAudioOnly,
    confirmar: typeof askConfirm
  })`);
  checar('interface: lib/linhadotempo.js carregou e o renderer enxerga as funções',
    globais.tempo === 'object' && Object.entries(globais).every(([, v]) => v === 'object' || v === 'function'), JSON.stringify(globais));

  // Seletor "Salvar Como": só áudio força "Somente áudio"
  const modo = await js(`(() => {
    initTracks(); sources.length = 0; clips.length = 0;
    joinModeForcedAudio = false; selectJoinMode.value = 'merged';
    sources.push({ id: 1, kind: 'audio', path: 'a.wav', name: 'a.wav', duration: 5, peaks: null });
    clips.push({ id: 1, trackId: 2, sourceId: 1, timelineStart: 0, start: 0, end: 5 });
    updateExportAvailability();
    const soAudio = {
      valor: selectJoinMode.value,
      videoDesabilitado: [...selectJoinMode.options].filter((o) => o.value !== 'audio').every((o) => o.disabled),
      grupoAudioVisivel: !audioFormatGroup.classList.contains('hidden'),
      grupoVideoOculto: videoFormatGroup.classList.contains('hidden'),
      botao: btnExport.textContent,
      dica: joinModeHint.textContent
    };
    sources.push({ id: 2, kind: 'video', path: 'v.mp4', name: 'v.mp4', duration: 5, peaks: null });
    clips.push({ id: 2, trackId: 1, sourceId: 2, timelineStart: 0, start: 0, end: 5 });
    updateExportAvailability();
    const comVideo = {
      valor: selectJoinMode.value,
      tudoHabilitado: [...selectJoinMode.options].every((o) => !o.disabled),
      grupoAudioOculto: audioFormatGroup.classList.contains('hidden'),
      botao: btnExport.textContent
    };
    selectJoinMode.value = 'audio'; updateExportAvailability();
    const escolhido = { valor: selectJoinMode.value, dica: joinModeHint.textContent, botao: btnExport.textContent, dicaNome: outputNameHint.textContent };
    return { soAudio, comVideo, escolhido };
  })()`);
  checar('interface: montagem só de áudio vem em "Somente áudio" e trava as opções de vídeo',
    modo.soAudio.valor === 'audio' && modo.soAudio.videoDesabilitado && modo.soAudio.grupoAudioVisivel && modo.soAudio.grupoVideoOculto && modo.soAudio.botao === 'Salvar Áudio' && /só tem áudio/.test(modo.soAudio.dica), JSON.stringify(modo.soAudio));
  checar('interface: ao ganhar vídeo, volta para "vídeo único" e destrava tudo',
    modo.comVideo.valor === 'merged' && modo.comVideo.tudoHabilitado && modo.comVideo.grupoAudioOculto && modo.comVideo.botao === 'Cortar e Salvar', JSON.stringify(modo.comVideo));
  checar('interface: escolher áudio com vídeo mantém a escolha e avisa que a imagem sai',
    modo.escolhido.valor === 'audio' && /não vai para o arquivo/.test(modo.escolhido.dica) && /\.mp3/.test(modo.escolhido.dicaNome), JSON.stringify(modo.escolhido));

  // Confirmação com atraso
  const atraso = await js(`(async () => {
    const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
    const p = askConfirm({ title: 'T', message: 'M', confirmLabel: 'Aceitar', cancelLabel: 'Voltar', confirmDelaySeconds: 2 });
    const inicio = { desabilitado: btnConfirmOk.disabled, rotulo: btnConfirmOk.textContent };
    btnConfirmOk.click();                       // clique durante a espera não pode valer
    await dorme(100);
    const aindaAberto = !confirmModal.classList.contains('hidden');
    await dorme(2200);
    const fim = { desabilitado: btnConfirmOk.disabled, rotulo: btnConfirmOk.textContent };
    btnConfirmOk.click();
    const resposta = await p;
    return { inicio, aindaAberto, fim, resposta };
  })()`);
  checar('confirmação com atraso: botão apagado com contagem no rótulo', atraso.inicio.desabilitado && /Aceitar \(2\)/.test(atraso.inicio.rotulo), JSON.stringify(atraso.inicio));
  checar('confirmação com atraso: clique durante a espera não confirma', atraso.aindaAberto, JSON.stringify(atraso));
  checar('confirmação com atraso: depois do prazo o botão volta e confirma', !atraso.fim.desabilitado && atraso.fim.rotulo === 'Aceitar' && atraso.resposta === true, JSON.stringify(atraso.fim));

  const cancelando = await js(`(async () => {
    const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
    const p = askConfirm({ title: 'T', message: 'M', confirmLabel: 'Aceitar', confirmDelaySeconds: 3 });
    await dorme(300);
    btnConfirmCancel.click();
    const resposta = await p;
    await dorme(100);
    return { resposta, desabilitado: btnConfirmOk.disabled, fechado: confirmModal.classList.contains('hidden') };
  })()`);
  checar('confirmação com atraso: cancelar na espera responde "não" e solta o botão', cancelando.resposta === false && !cancelando.desabilitado && cancelando.fechado, JSON.stringify(cancelando));

  const semAtraso = await js(`(async () => {
    const p = askConfirm({ title: 'T', message: 'M', confirmLabel: 'Sair' });
    const habilitado = !btnConfirmOk.disabled;
    btnConfirmCancel.click(); await p;
    return habilitado;
  })()`);
  checar('confirmação sem atraso (as de sempre): botão habilitado na hora', semAtraso === true);

  // ----- fluxo completo pela interface -----
  const saidaUi = path.join(tmp, 'saida-ui'); fs.mkdirSync(saidaUi);
  const fluxo = await js(`(async () => {
    const dorme = (ms) => new Promise((r) => setTimeout(r, ms));
    initTracks(); sources.length = 0; clips.length = 0; joinModeForcedAudio = false;
    await addSources(${JSON.stringify([video, wav])});
    const fv = sources.find((s) => s.path === ${JSON.stringify(video)});
    const fa = sources.find((s) => s.path === ${JSON.stringify(wav)});
    const clipeVideo = addItemFromSource(fv.id, baseTrack().id, 0);
    const clipeTrilha = addItemFromSource(fa.id, audioTracks()[0].id, 0);

    // 1. separar áudio do vídeo
    const antes = clips.length;
    await separateAudioFromClip(clipeVideo.id);
    const novoClipe = clips[clips.length - 1];
    const novaFonte = sources.find((s) => s.id === novoClipe.sourceId);
    const separar = {
      clipesAntes: antes, clipesDepois: clips.length,
      videoMudo: clipeVideo.muted === true,
      novaFonteAudio: !!novaFonte && novaFonte.kind === 'audio' && /\\(áudio\\)( \\(\\d+\\))?\\.m4a$/.test(novaFonte.path),
      mesmoPonto: novoClipe.timelineStart === clipeVideo.timelineStart && novoClipe.start === clipeVideo.start,
      faixaDeAudio: trackById(novoClipe.trackId).kind === 'audio',
      naoSobrepoeTrilha: novoClipe.trackId !== clipeTrilha.trackId
    };

    // 2. salvar como áudio COM vídeo na montagem: pede confirmação de 3s
    outputDirPath = ${JSON.stringify(saidaUi)};
    inputOutputName.value = 'montagem';
    selectAudioFormat.value = 'mp3';
    selectJoinMode.value = 'audio';
    updateExportAvailability();
    const reabrir = () => { exportStepForm.classList.remove('hidden'); exportStepProgress.classList.add('hidden'); delete exportModal.dataset.busy; };
    reabrir();

    btnExport.click();
    await dorme(400);
    const confirmacao = {
      aberta: !confirmModal.classList.contains('hidden'),
      titulo: confirmModalTitle.textContent,
      desabilitado: btnConfirmOk.disabled,
      rotulo: btnConfirmOk.textContent,
      detalhes: [...confirmModalDetails.children].map((li) => li.textContent),
      exportacaoIniciou: !exportStepProgress.classList.contains('hidden')
    };

    // 2b. cancelar não exporta nada
    btnConfirmCancel.click();
    await dorme(300);
    const cancelou = { exportacaoIniciou: !exportStepProgress.classList.contains('hidden'), formVisivel: !exportStepForm.classList.contains('hidden') };

    // 2c. confirmar depois dos 3s exporta
    btnExport.click();
    await dorme(3400);
    const depois = { desabilitado: btnConfirmOk.disabled, rotulo: btnConfirmOk.textContent };
    btnConfirmOk.click();
    for (let i = 0; i < 120 && btnCloseProgress.classList.contains('hidden'); i++) await dorme(250);
    const exportou = { texto: exportProgressText.textContent, alvo: lastExportTarget, titulo: exportModalTitle.textContent };

    // 3. só áudio na montagem (sem imagem): exporta sem confirmar
    for (const c of clips.filter((c) => sourceById(c.sourceId).kind !== 'audio')) removeClip(c.id);
    reabrir(); updateExportAvailability();
    btnExport.click();
    await dorme(500);
    const semImagem = { confirmou: !confirmModal.classList.contains('hidden'), iniciou: !exportStepProgress.classList.contains('hidden') };
    for (let i = 0; i < 120 && btnCloseProgress.classList.contains('hidden'); i++) await dorme(250);
    const semImagemTexto = exportProgressText.textContent;

    return { separar, confirmacao, cancelou, depois, exportou, semImagem, semImagemTexto,
             assinaturaMarcada: lastExportedEditorSignature !== null };
  })()`);

  checar('fluxo: separar áudio cria o bloco de áudio no mesmo ponto e silencia o vídeo',
    fluxo.separar.clipesDepois === fluxo.separar.clipesAntes + 1 && fluxo.separar.videoMudo && fluxo.separar.novaFonteAudio && fluxo.separar.mesmoPonto && fluxo.separar.faixaDeAudio, JSON.stringify(fluxo.separar));
  checar('fluxo: o áudio separado não cai por cima de outra trilha ocupada', fluxo.separar.naoSobrepoeTrilha, JSON.stringify(fluxo.separar));
  checar('fluxo: salvar só áudio com vídeo abre a confirmação, apagada, com a contagem',
    fluxo.confirmacao.aberta && fluxo.confirmacao.desabilitado && /\(\d\)/.test(fluxo.confirmacao.rotulo) && /áudio/i.test(fluxo.confirmacao.titulo) && !fluxo.confirmacao.exportacaoIniciou, JSON.stringify(fluxo.confirmacao));
  checar('fluxo: a confirmação diz o que será perdido', fluxo.confirmacao.detalhes.some((d) => /vídeo/.test(d)) && fluxo.confirmacao.detalhes.some((d) => /não é alterada/.test(d)), JSON.stringify(fluxo.confirmacao.detalhes));
  checar('fluxo: cancelar a confirmação não exporta e volta ao formulário', !fluxo.cancelou.exportacaoIniciou && fluxo.cancelou.formVisivel, JSON.stringify(fluxo.cancelou));
  checar('fluxo: passados os 3s o botão libera', !fluxo.depois.desabilitado && fluxo.depois.rotulo === 'Salvar só o áudio', JSON.stringify(fluxo.depois));
  checar('fluxo: confirmar exporta o áudio', /Áudio gerado: montagem\.mp3/.test(fluxo.exportou.texto) && fluxo.exportou.titulo === 'Exportando Áudio', JSON.stringify(fluxo.exportou));
  checar('fluxo: montagem só de áudio exporta direto, sem confirmação', !fluxo.semImagem.confirmou && fluxo.semImagem.iniciou && /Áudio gerado: montagem \(2\)\.mp3/.test(fluxo.semImagemTexto), JSON.stringify([fluxo.semImagem, fluxo.semImagemTexto]));

  const gerados = fs.readdirSync(saidaUi).sort();
  checar('fluxo: os dois arquivos de áudio existem, sem vídeo, com som', gerados.length === 2 && gerados.every((f) => { const p = probe(path.join(saidaUi, f)); return p && !p.temVideo && p.codecAudio === 'mp3' && p.duracao > 1; }), gerados.join(', '));

  checar('interface: nenhum erro de console durante todo o fluxo', errosDoConsole.length === 0, errosDoConsole.join(' | '));
}
