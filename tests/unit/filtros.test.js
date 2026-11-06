const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../../lib/filtros');

// --- números ---------------------------------------------------------------

test('clampNumber: prende o valor no intervalo', () => {
  assert.equal(F.clampNumber(5, 0, 3), 3);
  assert.equal(F.clampNumber(-5, 0, 3), 0);
  assert.equal(F.clampNumber(2, 0, 3), 2);
});

test('evenRound: sempre par e nunca menor que 2 (o yuv420p exige dimensões pares)', () => {
  assert.equal(F.evenRound(1081), 1082);
  assert.equal(F.evenRound(1080), 1080);
  assert.equal(F.evenRound(0), 2);
  assert.equal(F.evenRound(-10), 2);
  assert.equal(F.evenRound(607.5) % 2, 0);
});

test('numberOr: separa "não informado" de zero (o 0 é um valor válido)', () => {
  assert.equal(F.numberOr(0, 1), 0);
  assert.equal(F.numberOr('0', 1), 0);
  assert.equal(F.numberOr(2.5, 1), 2.5);
  assert.equal(F.numberOr(undefined, 1), 1);
  assert.equal(F.numberOr(null, 1), 1);
  assert.equal(F.numberOr('', 1), 1);
  assert.equal(F.numberOr('abc', 1), 1);
  assert.equal(F.numberOr(NaN, 1), 1);
  assert.equal(F.numberOr(Infinity, 1), 1);
});

// --- formato de saída --------------------------------------------------------

test('normalizeFormat: sem formato ou formato inválido vira null (manter o original)', () => {
  assert.equal(F.normalizeFormat(null), null);
  assert.equal(F.normalizeFormat(undefined), null);
  assert.equal(F.normalizeFormat({ width: 'abc', height: 100 }), null);
  assert.equal(F.normalizeFormat({ width: 1, height: 1 }), null);
});

test('normalizeFormat: dimensões ímpares viram pares e o ajuste padrão é preencher', () => {
  assert.deepEqual(F.normalizeFormat({ width: 1081, height: 1921 }), { width: 1082, height: 1922, fit: 'cover' });
});

test('normalizeFormat: só "contain" é aceito como alternativa de ajuste', () => {
  assert.equal(F.normalizeFormat({ width: 100, height: 100, fit: 'contain' }).fit, 'contain');
  assert.equal(F.normalizeFormat({ width: 100, height: 100, fit: 'qualquer' }).fit, 'cover');
});

// --- enquadramento ----------------------------------------------------------

test('normalizeFraming: sem nada, devolve o enquadramento padrão', () => {
  assert.deepEqual(F.normalizeFraming(undefined), {
    zoom: 1, offsetX: 0, offsetY: 0, background: { mode: 'color', color: '#000000' }
  });
});

test('normalizeFraming: zoom e deslocamento ficam dentro dos limites', () => {
  assert.equal(F.normalizeFraming({ zoom: 99 }).zoom, F.IMAGE_MAX_ZOOM);
  assert.equal(F.normalizeFraming({ zoom: 0.01 }).zoom, F.IMAGE_MIN_ZOOM);
  assert.equal(F.normalizeFraming({ offsetX: 9, offsetY: -9 }).offsetX, 2);
  assert.equal(F.normalizeFraming({ offsetX: 9, offsetY: -9 }).offsetY, -2);
});

test('normalizeFraming: cor inválida volta para preto e só "blur" muda o modo do fundo', () => {
  assert.equal(F.normalizeFraming({ background: { color: 'vermelho' } }).background.color, '#000000');
  assert.equal(F.normalizeFraming({ background: { color: '#FF00aa' } }).background.color, '#FF00aa');
  assert.equal(F.normalizeFraming({ background: { mode: 'blur' } }).background.mode, 'blur');
  assert.equal(F.normalizeFraming({ background: { mode: 'x' } }).background.mode, 'color');
});

test('isDefaultFraming: reconhece o enquadramento intocado e qualquer mexida', () => {
  const base = F.normalizeFraming({});
  assert.equal(F.isDefaultFraming(base), true);
  assert.equal(F.isDefaultFraming(F.normalizeFraming({ zoom: 1.2 })), false);
  assert.equal(F.isDefaultFraming(F.normalizeFraming({ offsetX: 0.1 })), false);
  assert.equal(F.isDefaultFraming(F.normalizeFraming({ background: { mode: 'blur' } })), false);
});

test('computeMediaLayout: mídia da mesma proporção ocupa o quadro todo', () => {
  const layout = F.computeMediaLayout({ width: 1920, height: 1080 }, { width: 1920, height: 1080 }, F.normalizeFraming({}));
  assert.deepEqual(layout, { drawWidth: 1920, drawHeight: 1080, x: 0, y: 0 });
});

test('computeMediaLayout: vídeo 16:9 em quadro vertical é encaixado e centralizado', () => {
  const layout = F.computeMediaLayout({ width: 1920, height: 1080 }, { width: 1080, height: 1920 }, F.normalizeFraming({}));
  assert.equal(layout.drawWidth, 1080);
  assert.equal(layout.drawHeight % 2, 0);
  assert.equal(layout.x, 0);
  assert.equal(layout.y, Math.round((1920 - layout.drawHeight) / 2));
});

test('computeMediaLayout: zoom amplia e deslocamento é fração do quadro', () => {
  const frame = { width: 1000, height: 500 };
  const media = { width: 1000, height: 500 };
  const dobro = F.computeMediaLayout(media, frame, F.normalizeFraming({ zoom: 2 }));
  assert.equal(dobro.drawWidth, 2000);
  assert.equal(dobro.drawHeight, 1000);

  const deslocado = F.computeMediaLayout(media, frame, F.normalizeFraming({ offsetX: 0.5 }));
  assert.equal(deslocado.x, 500);
});

// --- ajustes do trecho ------------------------------------------------------

test('normalizeAdjust: sem ajustes, devolve os padrões', () => {
  assert.deepEqual(F.normalizeAdjust({}), {
    speed: 1, opacity: 1, rotate: 0, flipH: false, flipV: false,
    color: null, blurRegion: null, chroma: null
  });
  assert.deepEqual(F.normalizeAdjust(undefined), F.normalizeAdjust({}));
});

test('normalizeAdjust: velocidade fica entre 0,1x e 10x', () => {
  assert.equal(F.normalizeAdjust({ speed: 50 }).speed, 10);
  assert.equal(F.normalizeAdjust({ speed: 0.01 }).speed, 0.1);
  assert.equal(F.normalizeAdjust({ speed: 0 }).speed, 1);
  assert.equal(F.normalizeAdjust({ speed: 'abc' }).speed, 1);
});

test('normalizeAdjust: giro só aceita múltiplos de 90', () => {
  for (const r of [0, 90, 180, 270]) assert.equal(F.normalizeAdjust({ rotate: r }).rotate, r);
  assert.equal(F.normalizeAdjust({ rotate: 45 }).rotate, 0);
  assert.equal(F.normalizeAdjust({ rotate: '90' }).rotate, 90);
});

test('normalizeAdjust: opacidade vai de 0 a 1, e zero é zero', () => {
  assert.equal(F.normalizeAdjust({ opacity: 2 }).opacity, 1);
  assert.equal(F.normalizeAdjust({ opacity: -1 }).opacity, 0);
  assert.equal(F.normalizeAdjust({ opacity: 0 }).opacity, 0);
});

test('normalizeAdjust: cor sem nenhuma mudança vira null', () => {
  assert.equal(F.normalizeAdjust({ color: { brightness: 0, contrast: 1, saturation: 1 } }).color, null);
});

test('normalizeAdjust: cor é limitada aos intervalos do filtro eq', () => {
  const c = F.normalizeAdjust({ color: { brightness: 2, contrast: 5, saturation: -1 } }).color;
  assert.deepEqual(c, { brightness: 1, contrast: 3, saturation: 0 });
});

test('normalizeAdjust: cor com campos faltando usa o padrão (nunca NaN no filtro)', () => {
  const c = F.normalizeAdjust({ color: { brightness: 0.2 } }).color;
  assert.deepEqual(c, { brightness: 0.2, contrast: 1, saturation: 1 });
});

test('normalizeAdjust: chroma exige cor #rrggbb válida', () => {
  assert.equal(F.normalizeAdjust({ chroma: { color: 'verde' } }).chroma, null);
  const ok = F.normalizeAdjust({ chroma: { color: '#00ff00' } }).chroma;
  assert.equal(ok.color, '#00ff00');
  assert.equal(ok.similarity, 0.3);
  assert.equal(ok.blend, 0.1);
});

test('normalizeAdjust: borrão de região pequena demais é ignorado e o resto é limitado a 0–1', () => {
  assert.equal(F.normalizeAdjust({ blurRegion: { x: 0.1, y: 0.1, w: 0.005, h: 0.5 } }).blurRegion, null);
  const r = F.normalizeAdjust({ blurRegion: { x: 5, y: -5, w: 3, h: 0.5 } }).blurRegion;
  assert.deepEqual(r, { x: 1, y: 0, w: 1, h: 0.5 });
});

test('hasAdjustments: só é verdadeiro quando algo realmente muda a imagem', () => {
  const n = (c) => F.normalizeAdjust(c);
  assert.equal(F.hasAdjustments(n({})), false);
  assert.ok(F.hasAdjustments(n({ rotate: 90 })));
  assert.ok(F.hasAdjustments(n({ flipH: true })));
  assert.ok(F.hasAdjustments(n({ flipV: true })));
  assert.ok(F.hasAdjustments(n({ opacity: 0.5 })));
  assert.ok(F.hasAdjustments(n({ color: { brightness: 0.1, contrast: 1, saturation: 1 } })));
  assert.ok(F.hasAdjustments(n({ chroma: { color: '#00ff00' } })));
  assert.ok(F.hasAdjustments(n({ blurRegion: { x: 0, y: 0, w: 0.5, h: 0.5 } })));
});

// --- cadeia de filtros -------------------------------------------------------

test('buildAdjustChain: sem ajustes devolve string vazia', () => {
  assert.equal(F.buildAdjustChain(F.normalizeAdjust({})), '');
});

test('buildAdjustChain: giros', () => {
  assert.equal(F.buildAdjustChain(F.normalizeAdjust({ rotate: 90 })), 'transpose=1');
  assert.equal(F.buildAdjustChain(F.normalizeAdjust({ rotate: 180 })), 'transpose=1,transpose=1');
  assert.equal(F.buildAdjustChain(F.normalizeAdjust({ rotate: 270 })), 'transpose=2');
});

test('buildAdjustChain: espelhos, cor, chroma e opacidade', () => {
  assert.equal(F.buildAdjustChain(F.normalizeAdjust({ flipH: true })), 'hflip');
  assert.equal(F.buildAdjustChain(F.normalizeAdjust({ flipV: true })), 'vflip');
  assert.equal(
    F.buildAdjustChain(F.normalizeAdjust({ color: { brightness: 0.2, contrast: 1.5, saturation: 0.5 } })),
    'eq=brightness=0.200:contrast=1.500:saturation=0.500'
  );
  assert.equal(
    F.buildAdjustChain(F.normalizeAdjust({ chroma: { color: '#00ff00' } })),
    'format=yuva420p,chromakey=0x00ff00:0.300:0.100'
  );
  assert.equal(
    F.buildAdjustChain(F.normalizeAdjust({ opacity: 0.5 })),
    'format=yuva420p,colorchannelmixer=aa=0.500'
  );
});

test('buildAdjustChain: a ordem é girar, espelhar, cor, chroma, opacidade', () => {
  const chain = F.buildAdjustChain(F.normalizeAdjust({
    rotate: 90, flipH: true, flipV: true,
    color: { brightness: 0.1, contrast: 1, saturation: 1 },
    chroma: { color: '#00ff00' }, opacity: 0.5
  }));
  const ordem = ['transpose=1', 'hflip', 'vflip', 'eq=', 'chromakey', 'colorchannelmixer'];
  const posicoes = ordem.map((p) => chain.indexOf(p));
  assert.ok(posicoes.every((p) => p >= 0), `faltou algum filtro em: ${chain}`);
  assert.deepEqual([...posicoes].sort((a, b) => a - b), posicoes);
});

test('buildBlurRegionGraph: sem tamanho da mídia, passa direto', () => {
  assert.equal(F.buildBlurRegionGraph('in', 'out', { x: 0, y: 0, w: 1, h: 1 }, null), '[in]null[out]');
});

test('buildBlurRegionGraph: recorta, borra e devolve no mesmo lugar', () => {
  const g = F.buildBlurRegionGraph('in', 'out', { x: 0.1, y: 0.2, w: 0.5, h: 0.5 }, { width: 1000, height: 500 });
  assert.match(g, /crop=500:250:100:100/);
  assert.match(g, /overlay=100:100\[out\]/);
  assert.match(g, /^\[in\]split=2/);
});

test('buildAtempoChain: velocidades dentro de 0,5–2 usam um filtro só', () => {
  assert.equal(F.buildAtempoChain(1), 'atempo=1.0000');
  assert.equal(F.buildAtempoChain(2), 'atempo=2.0000');
  assert.equal(F.buildAtempoChain(0.5), 'atempo=0.5000');
});

test('buildAtempoChain: fora do intervalo encadeia filtros', () => {
  assert.equal(F.buildAtempoChain(4), 'atempo=2.0000,atempo=2.0000');
  assert.equal(F.buildAtempoChain(0.25), 'atempo=0.5000,atempo=0.5000');
});

test('buildAtempoChain: o produto dos passos é a velocidade pedida, e cada passo é válido', () => {
  for (const speed of [0.1, 0.25, 0.3, 0.5, 0.75, 1, 1.5, 2, 3, 4.5, 8, 10]) {
    const passos = F.buildAtempoChain(speed).split(',').map((s) => Number(s.replace('atempo=', '')));
    const produto = passos.reduce((a, b) => a * b, 1);
    assert.ok(Math.abs(produto - speed) < 0.001, `velocidade ${speed}: produto ${produto}`);
    assert.ok(passos.every((p) => p >= 0.5 && p <= 2), `velocidade ${speed}: passo fora de 0.5–2 em ${passos}`);
  }
});

test('buildScaleFilter: encaixar (contain) usa pad, preencher (cover) usa crop', () => {
  assert.equal(
    F.buildScaleFilter({ width: 1080, height: 1920, fit: 'contain' }),
    'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,setsar=1'
  );
  assert.equal(
    F.buildScaleFilter({ width: 1080, height: 1920, fit: 'cover' }),
    'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1'
  );
});

// --- composição de uma mídia no quadro --------------------------------------

const quadro = { width: 1280, height: 720 };
const layout = { drawWidth: 1280, drawHeight: 720, x: 0, y: 0 };

test('buildMediaComposite: fundo de cor usa 0x… (o # é comentário no parser do ffmpeg)', () => {
  const g = F.buildMediaComposite(quadro, layout, { mode: 'color', color: '#112233' }, null);
  assert.match(g, /color=c=0x112233:s=1280x720\[bg\]/);
  assert.ok(!g.includes('#'));
  assert.match(g, /\[bg\]\[fg\]overlay=0:0\[v\]$/);
});

test('buildMediaComposite: fundo desfocado usa a própria mídia em miniatura', () => {
  const g = F.buildMediaComposite(quadro, layout, { mode: 'blur', color: '#000000' }, null);
  assert.match(g, /split=2\[bgsrc\]\[fgsrc\]/);
  assert.match(g, /boxblur=4:2/);
});

test('buildMediaComposite: com áudio, mapeia a entrada para [a]', () => {
  const comAudio = F.buildMediaComposite(quadro, layout, { mode: 'color', color: '#000000' }, '0:a');
  assert.match(comAudio, /;\[0:a\]anull\[a\]$/);
  const semAudio = F.buildMediaComposite(quadro, layout, { mode: 'color', color: '#000000' }, null);
  assert.ok(!semAudio.includes('[a]'));
});

test('buildMediaComposite: pré-cadeia (velocidade) vira um passo nomeado', () => {
  const g = F.buildMediaComposite(quadro, layout, { mode: 'color', color: '#000000' }, null, undefined, undefined, 'setpts=PTS/2');
  assert.match(g, /^\[0:v\]setpts=PTS\/2\[srcpre\];/);
  assert.match(g, /\[srcpre\]null\[fgsrc\]/);
});

test('buildMediaComposite: ajustes entram entre a fonte e o enquadramento', () => {
  const adjust = F.normalizeAdjust({ rotate: 90, blurRegion: { x: 0, y: 0, w: 0.5, h: 0.5 } });
  const g = F.buildMediaComposite(quadro, layout, { mode: 'color', color: '#000000' }, null, adjust, { width: 640, height: 360 });
  assert.match(g, /\[fgsrc\]transpose=1\[fgadj\]/);
  assert.match(g, /\[fgadj\]split=2\[brbase\]\[brcut\]/);
  assert.match(g, /\[fgblur\]scale=1280:720/);
});
