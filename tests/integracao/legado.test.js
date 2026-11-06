// O test_backend.js (os 9 testes originais do FFmpeg) imprime ❌ quando um teste
// falha, mas termina com código 0 — então, sozinho, uma falha passa batida.
// Este embrulho roda o arquivo e transforma o ❌ em falha de verdade.
//
// Atenção: aquele arquivo recopia algumas funções em vez de importar o código
// real; o que protege o código real são os testes de unit/ e integracao/.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

test('test_backend.js (testes originais do FFmpeg): nenhum ❌', { timeout: 240000 }, () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'test_backend.js')], {
    encoding: 'utf8', timeout: 230000, cwd: path.join(__dirname, '..', '..')
  });
  const saida = (r.stdout || '') + (r.stderr || '');

  assert.equal(r.status, 0, `saiu com código ${r.status}\n${saida.slice(-2000)}`);
  const falhas = saida.split('\n').filter((l) => l.includes('❌'));
  assert.deepEqual(falhas, [], `testes originais falharam:\n${falhas.join('\n')}`);
  const passaram = saida.split('\n').filter((l) => /^✔ Teste \d+:/.test(l));
  assert.ok(passaram.length >= 9, `esperava 9 testes passando, vieram ${passaram.length}\n${saida.slice(-2000)}`);
});
