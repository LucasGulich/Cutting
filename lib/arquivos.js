// Nomes de arquivo seguros no Windows.
// Extraído do main.js: sem Electron, sem janela, sem estado — por isso
// pode ser testado com `node --test`. Ver docs/TESTES.md.

const fs = require('fs');
const path = require('path');

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

module.exports = { sanitizeFileName, uniquePath };
