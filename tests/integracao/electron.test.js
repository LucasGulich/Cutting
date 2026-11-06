// Sobe o Electron de verdade (janela invisível, dados numa pasta temporária) e
// transforma cada verificação do harness em um teste. Cobre o que os testes
// puros não alcançam: handlers IPC reais e a interface.
//
// Um teste por verificação, para que a falha diga exatamente o que quebrou.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

test('Electron: handlers reais e interface', { timeout: 180000 }, async (t) => {
  const electron = require('electron');   // no Node, devolve o caminho do executável
  const harness = path.join(__dirname, '_harness-electron.js');

  const r = spawnSync(electron, [harness], { encoding: 'utf8', timeout: 170000, windowsHide: true });
  const linha = (r.stdout || '').split('\n').find((l) => l.startsWith('RESULTADOS:'));

  assert.ok(linha, `o harness não devolveu resultados.\nstdout: ${r.stdout}\nstderr: ${(r.stderr || '').slice(-1500)}`);
  const resultados = JSON.parse(linha.slice('RESULTADOS:'.length));
  assert.ok(resultados.length > 10, `poucos resultados (${resultados.length})`);

  for (const res of resultados) {
    await t.test(res.nome, () => {
      assert.ok(res.ok, `FALHOU: ${res.nome}\nDetalhe: ${res.detalhe}`);
    });
  }
});
