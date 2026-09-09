// Etapa 2 da geração do ícone (roda no node, sem Electron): reduz o PNG de
// 256px para os demais tamanhos e empacota tudo num .ico.
//
// O .ico moderno pode CONTER PNGs — é o que preserva a transparência e as
// bordas suaves em todos os tamanhos.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegBinary = require('./node_modules/ffmpeg-static');

const TAMANHOS = [16, 24, 32, 48, 64, 128, 256];
const SAIDA = path.join(__dirname, 'build');
const GRANDE = path.join(SAIDA, 'icon-256.png');
const PEQUENA = path.join(SAIDA, 'arte-pequena.png');

// Abaixo disto o desenho detalhado vira borrão: esses tamanhos usam a arte
// simplificada (lâminas maiores, sem o ponto central).
const LIMITE_ARTE_PEQUENA = 32;

if (!fs.existsSync(GRANDE)) throw new Error('build/icon-256.png não existe — rode gerar-icone.js antes');

const imagens = [];
for (const lado of TAMANHOS) {
  const arquivo = path.join(SAIDA, `icon-${lado}.png`);
  const origem = lado <= LIMITE_ARTE_PEQUENA && fs.existsSync(PEQUENA) ? PEQUENA : GRANDE;
  if (lado !== 256) {
    execFileSync(ffmpegBinary, [
      '-v', 'error', '-i', origem,
      '-vf', `scale=${lado}:${lado}:flags=lanczos`,
      '-pix_fmt', 'rgba', '-y', arquivo
    ]);
  }
  imagens.push({ lado, png: fs.readFileSync(arquivo) });
}

const cabecalho = Buffer.alloc(6);
cabecalho.writeUInt16LE(0, 0);              // reservado
cabecalho.writeUInt16LE(1, 2);              // tipo 1 = ícone
cabecalho.writeUInt16LE(imagens.length, 4);

let deslocamento = 6 + imagens.length * 16;
const entradas = imagens.map(({ lado, png }) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(lado >= 256 ? 0 : lado, 0);  // 0 significa 256
  e.writeUInt8(lado >= 256 ? 0 : lado, 1);
  e.writeUInt8(0, 2);                       // paleta (0 = sem paleta)
  e.writeUInt8(0, 3);                       // reservado
  e.writeUInt16LE(1, 4);                    // planos
  e.writeUInt16LE(32, 6);                   // bits por pixel
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(deslocamento, 12);
  deslocamento += png.length;
  return e;
});

fs.writeFileSync(path.join(SAIDA, 'icon.ico'),
  Buffer.concat([cabecalho, ...entradas, ...imagens.map((i) => i.png)]));

const render = path.join(SAIDA, '_render.html');
if (fs.existsSync(render)) fs.unlinkSync(render);

console.log('build/icon.ico:', imagens.map((i) => `${i.lado}px`).join(', '),
  '—', fs.statSync(path.join(SAIDA, 'icon.ico')).size, 'bytes');
