const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sanitizeFileName, uniquePath } = require('../../lib/arquivos');

test('sanitizeFileName: tira o que o Windows proíbe em nome de arquivo', () => {
  assert.equal(sanitizeFileName('meu:video/ilegal*'), 'meuvideoilegal');
  assert.equal(sanitizeFileName('a<b>c"d|e?f\\g'), 'abcdefg');
});

test('sanitizeFileName: tira caracteres de controle', () => {
  assert.equal(sanitizeFileName('a\x00b\x1Fc'), 'abc');
});

test('sanitizeFileName: junta espaços repetidos e apara as pontas', () => {
  assert.equal(sanitizeFileName('  espaços   demais  '), 'espaços demais');
});

test('sanitizeFileName: tira pontos das pontas, mas mantém os do meio', () => {
  assert.equal(sanitizeFileName('...pontas...'), 'pontas');
  assert.equal(sanitizeFileName('v1.2.final'), 'v1.2.final');
});

test('sanitizeFileName: mantém acentos e nomes normais', () => {
  assert.equal(sanitizeFileName('Vídeo da Conceição_01'), 'Vídeo da Conceição_01');
  assert.equal(sanitizeFileName('normal_123'), 'normal_123');
});

test('sanitizeFileName: devolve vazio para entrada que não é texto ou ficou vazia', () => {
  assert.equal(sanitizeFileName(undefined), '');
  assert.equal(sanitizeFileName(null), '');
  assert.equal(sanitizeFileName(42), '');
  assert.equal(sanitizeFileName(''), '');
  assert.equal(sanitizeFileName('???'), '');
});

test('sanitizeFileName: limita a 120 caracteres', () => {
  assert.equal(sanitizeFileName('a'.repeat(300)).length, 120);
});

// ---------------------------------------------------------------------------

function pastaTemporaria(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutting-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('uniquePath: nome livre volta como veio', (t) => {
  const dir = pastaTemporaria(t);
  assert.equal(uniquePath(dir, 'novo.mp4'), path.join(dir, 'novo.mp4'));
});

test('uniquePath: nome ocupado ganha (2), sem sobrescrever', (t) => {
  const dir = pastaTemporaria(t);
  fs.writeFileSync(path.join(dir, 'ocupado.mp4'), 'x');
  assert.equal(path.basename(uniquePath(dir, 'ocupado.mp4')), 'ocupado (2).mp4');
});

test('uniquePath: segue contando enquanto houver conflito', (t) => {
  const dir = pastaTemporaria(t);
  fs.writeFileSync(path.join(dir, 'a.mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'a (2).mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'a (3).mp3'), 'x');
  assert.equal(path.basename(uniquePath(dir, 'a.mp3')), 'a (4).mp3');
});

test('uniquePath: preserva a extensão, inclusive nos formatos de áudio', (t) => {
  const dir = pastaTemporaria(t);
  for (const ext of ['mp3', 'm4a', 'wav', 'flac']) {
    fs.writeFileSync(path.join(dir, `x.${ext}`), 'x');
    assert.equal(path.basename(uniquePath(dir, `x.${ext}`)), `x (2).${ext}`);
  }
});
