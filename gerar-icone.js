// Utilitário temporário: gera build/icon.ico a partir da marca do app.
//
// O Windows exige .ico para o ícone do executável — PNG solto não serve. Mas o
// .ico moderno pode CONTER PNGs, que é o que permite fundo transparente e
// bordas suaves. É isso que montamos aqui: um PNG por tamanho, empacotados no
// contêiner .ico.
//
// A marca é desenhada uma vez em 256px pelo próprio Electron (janela
// transparente) e reduzida pelo ffmpeg. Renderizar direto em 16px não funciona:
// o Windows não entrega captura de janelas minúsculas.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ffmpegBinary = require('ffmpeg-static');
const TAMANHOS = [16, 24, 32, 48, 64, 128, 256];
const SAIDA = path.join(__dirname, 'build');

// Selo arredondado com o degradê do app e o símbolo em branco. Fora do selo é
// transparente — é o que tira o quadrado branco do ícone.
const ARTE_DETALHADA = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="54" fill="url(#g)"/>
  <g transform="translate(128 128) scale(6.2) translate(-12 -12)" fill="#ffffff">
    <path d="M7 22H9C10.1 22 11 21.1 11 20V13H7C5.9 13 5 13.9 5 15V20C5 21.1 5.9 22 7 22Z"/>
    <path d="M17 22H15C13.9 22 13 21.1 13 20V13H17C18.1 13 19 13.9 19 15V20C19 21.1 18.1 22 17 22Z"/>
    <path d="M11 11V4C11 2.9 10.1 2 9 2H7C5.9 2 5 2.9 5 4V11H11Z"/>
    <path d="M13 11V4C13 2.9 13.9 2 15 2H17C18.1 2 19 2.9 19 4V11H13Z"/>
  </g>
  <circle cx="128" cy="128" r="11" fill="#ffffff"/>
</svg>`;

// Sem o ponto central e com as lâminas maiores: é o que sobrevive a 16px
const ARTE_PEQUENA = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#8b5cf6"/>
      <stop offset="1" stop-color="#ec4899"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="240" height="240" rx="54" fill="url(#g)"/>
  <g transform="translate(128 128) scale(7.4) translate(-12 -12)" fill="#ffffff">
    <path d="M7 22H9C10.1 22 11 21.1 11 20V13H7C5.9 13 5 13.9 5 15V20C5 21.1 5.9 22 7 22Z"/>
    <path d="M17 22H15C13.9 22 13 21.1 13 20V13H17C18.1 13 19 13.9 19 15V20C19 21.1 18.1 22 17 22Z"/>
    <path d="M11 11V4C11 2.9 10.1 2 9 2H7C5.9 2 5 2.9 5 4V11H11Z"/>
    <path d="M13 11V4C13 2.9 13.9 2 15 2H17C18.1 2 19 2.9 19 4V11H13Z"/>
  </g>
  
</svg>`;

const escalar = (origem, destino, lado) => new Promise((resolve, reject) => {
  execFile(ffmpegBinary, [
    '-v', 'error', '-i', origem,
    '-vf', `scale=${lado}:${lado}:flags=lanczos`,
    '-pix_fmt', 'rgba', '-y', destino
  ], (e) => (e ? reject(e) : resolve()));
});

function empacotarIco(imagens) {
  const cabecalho = Buffer.alloc(6);
  cabecalho.writeUInt16LE(0, 0);            // reservado
  cabecalho.writeUInt16LE(1, 2);            // tipo 1 = ícone
  cabecalho.writeUInt16LE(imagens.length, 4);

  // Cada entrada aponta para onde o PNG começa dentro do arquivo
  let deslocamento = 6 + imagens.length * 16;
  const entradas = imagens.map(({ lado, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(lado >= 256 ? 0 : lado, 0); // 0 significa 256
    e.writeUInt8(lado >= 256 ? 0 : lado, 1);
    e.writeUInt8(0, 2);                      // cores da paleta (0 = sem paleta)
    e.writeUInt8(0, 3);                      // reservado
    e.writeUInt16LE(1, 4);                   // planos
    e.writeUInt16LE(32, 6);                  // bits por pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(deslocamento, 12);
    deslocamento += png.length;
    return e;
  });

  return Buffer.concat([cabecalho, ...entradas, ...imagens.map((i) => i.png)]);
}

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(SAIDA, { recursive: true });

    // As duas artes saem de UMA captura, lado a lado, e são recortadas depois.
    // Criar uma segunda janela transparente falha neste Electron (ERR_FAILED),
    // então é mais simples desenhar tudo de uma vez.
    const html = path.join(SAIDA, '_render.html');
    fs.writeFileSync(html,
      '<html><body style="margin:0;background:transparent;display:flex">'
      + ARTE_DETALHADA + ARTE_PEQUENA + '</body></html>', 'utf8');

    const janela = new BrowserWindow({
      width: 512, height: 256,
      show: false, frame: false, transparent: true, backgroundColor: '#00000000'
    });
    await janela.loadFile(html);
    await new Promise((r) => setTimeout(r, 600));

    const par = path.join(SAIDA, '_par.png');
    fs.writeFileSync(par, (await janela.webContents.capturePage()).toPNG());
    janela.destroy();
    fs.unlinkSync(html);

    if (fs.statSync(par).size < 1000) throw new Error('a captura das artes saiu vazia');

    const recortar = (x, destino) => new Promise((resolve, reject) => {
      execFile(ffmpegBinary, ['-v', 'error', '-i', par,
        '-vf', `crop=256:256:${x}:0`, '-pix_fmt', 'rgba', '-y', destino],
        (e) => (e ? reject(e) : resolve()));
    });

    await recortar(0, path.join(SAIDA, 'icon-256.png'));
    await recortar(256, path.join(SAIDA, 'arte-pequena.png'));
    fs.unlinkSync(par);

    console.log('artes renderizadas em 256px');
  } catch (err) {
    console.log('FALHOU:', err && err.message ? err.message : err);
    app.exit(1);
    return;
  }
  app.exit(0);
});
