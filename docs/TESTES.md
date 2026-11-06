# Testes

> Como o Cutting é testado, o que cada camada protege e, principalmente, **a
> regra de ouro: funcionalidade nova só está pronta com teste.**

## Em uma frase

200 testes, uns 20 segundos, um comando:

```cmd
testar.cmd          (ou: npm test)
```

Eles rodam com o `node --test`, que já vem no Node. **Nenhuma dependência de
teste foi instalada**: o projeto continua com as mesmas três dependências.
Pede Node 22 ou superior (o `package.json` declara em `engines`).

## As três camadas

```
tests\
├─ unit\            129 testes · ~0,5 s · só código, nada é executado
├─ integracao\       71 testes · ~20 s  · FFmpeg de verdade e Electron de verdade
└─ (test_backend.js, na raiz)           · os 9 testes originais, embrulhados
```

| Camada | Pergunta que responde | Quando falha, o problema é… |
|---|---|---|
| **unit** | "Esta função, dada esta entrada, devolve isto?" | a regra (um cálculo, uma montagem de filtro) |
| **integração, FFmpeg** | "O FFmpeg de verdade aceita e produz o que a gente espera?" | o comando ou o grafo que o app monta |
| **integração, Electron** | "O app sobe, a tela reage e o arquivo sai?" | a ligação entre as partes (tela ↔ main ↔ FFmpeg) |

### O que cada arquivo cobre

| Arquivo | O que cobre |
|---|---|
| `unit\arquivos.test.js` | Nome de arquivo seguro no Windows; nunca sobrescrever (`uniquePath`) |
| `unit\filtros.test.js` | Normalização de formato, enquadramento e ajustes; cadeia de filtros (giro, cor, chroma, opacidade); `atempo` encadeado; escala encaixar/preencher |
| `unit\montagem.test.js` | Duração com velocidade; volume efetivo; transições; o **grafo de composição** (sobreposição, trilhas, mix de áudio, texto) |
| `unit\audio.test.js` | Argumentos do FFmpeg para converter, separar e exportar como áudio, em cada formato, com e sem recorte |
| `unit\linhadotempo.test.js` | `formatTime`/`parseTimeToSeconds` (com ida e volta); montagem "simples"; faixa livre; clipe de áudio separado; seletor "Salvar Como"; texto da confirmação |
| `integracao\filtros.integracao.test.js` | O FFmpeg **aceita** cada variação de grafo; escala dá o tamanho exato; velocidade muda a duração; mix de áudio mede o volume de verdade |
| `integracao\audio.integracao.test.js` | Cada formato sai sem vídeo, com o codec e a duração certos; M4A de AAC copia o fluxo; caminho com acento e espaço |
| `integracao\electron.test.js` | Handlers reais (`export-timeline-audio`, `separate-audio`, `extract-audio`) e a **interface de ponta a ponta**: separar áudio, confirmação de 3 s, exportar, sem erro no console |
| `integracao\legado.test.js` | Roda o `test_backend.js` e transforma o `❌` dele em falha de verdade |

## A regra de ouro

**Toda funcionalidade nova entra com teste, no mesmo trabalho. Todo bug
corrigido entra com o teste que o teria pego.**

O que testar depende do que foi feito:

| Se você mexeu em… | Escreva |
|---|---|
| Uma regra, cálculo ou montagem de texto/filtro | Teste **unit** (em `lib\`) |
| Um comando ou grafo do FFmpeg | Teste de **integração FFmpeg**: rode no FFmpeg e confira o arquivo que saiu |
| Um handler novo no `main.js` | Verificação no `_harness-electron.js` (handler real, com mídia sintética) |
| Um botão, modal ou fluxo de tela | Verificação de **interface** no mesmo harness |
| Um bug | O teste que falha por causa dele, **antes** de corrigir |

A ordem importa nos bugs: escreva o teste, **veja-o falhar**, corrija, veja
passar. Foi assim que dois bugs reais apareceram (veja o fim deste arquivo).

## Princípios

**Teste o código de verdade, nunca uma cópia.** O `test_backend.js` original
recopia funções dentro do teste (`sanitize`, `uniquePath`): se o código real
quebrasse, ele continuava passando. Por isso a lógica pura mora em `lib\`, e o
`main.js`, o `renderer.js` e os testes importam o **mesmo** arquivo.

**Cada teste é uma frase.** O nome diz o comportamento, não a função:
`itemVolume: 0% é silêncio, e não 100% (volume 0 sem estar mudo)`. Quando
falhar, a lista de falhas já conta a história.

**A falha explica.** Passe a mensagem de diagnóstico no `assert`, com o valor
que veio: `assert.ok(r.ok, \`grafo recusado: ${graph}\n${r.erro}\`)`.

**Nunca toque nos dados do usuário.** Os testes usam pasta temporária
(`os.tmpdir()`), e o harness do Electron redireciona o `userData` para uma
pasta descartável. O `%APPDATA%` do Cutting fica intacto.

**Mídia sintética e pequena.** Os testes geram os próprios vídeos e sons com o
FFmpeg (`testsrc`, `sine`) em 320×180 e 2 s. Nada de arquivo de mídia no
repositório.

**Confira o conteúdo, não só "não deu erro".** Um comando pode terminar com
sucesso e gerar o arquivo errado. Por isso os testes medem: `ffprobe` para
codec, duração e streams; `volumedetect` para saber se o som é audível ou
silêncio.

## Como escrever

### Unit

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { itemVolume } = require('../../lib/montagem');

test('itemVolume: 0% é silêncio, e não 100%', () => {
  assert.equal(itemVolume({ volume: 0 }), 0);
});
```

Funções puras novas vão para `lib\` e ganham um bloco de testes em
`tests\unit\`. Carregam com `require` no Node; no navegador, o
`lib\linhadotempo.js` vira `window.CuttingTempo` (veja `DESENVOLVIMENTO.md`).

### Integração com FFmpeg

```js
const A = require('./_ajudas');

test('exportar como MP3 sai sem vídeo', (t) => {
  const dir = A.pastaTemporaria(t);                 // some sozinha no fim
  const video = A.criarVideo(dir, 'v', { segundos: 3 });
  const saida = path.join(dir, 's.mp3');
  assert.ok(A.ffmpeg(args).ok);
  assert.equal(A.probe(saida).temVideo, false);
});
```

`_ajudas.js` tem: `pastaTemporaria`, `criarVideo`, `criarAudio`, `ffmpeg`,
`probe`, `picoDb`.

### Interface e handlers (Electron)

Acrescente uma chamada a `checar(nome, ok, detalhe)` no
`_harness-electron.js`. Ele roda **dentro** do Electron, com a janela
invisível; `js('…')` executa código na tela e devolve o resultado. O
`electron.test.js` transforma cada `checar` em um teste, então a falha aponta
a verificação exata.

## Armadilhas já pagas

Cada uma custou tempo e está aqui para não custar de novo.

| Armadilha | O que fazer |
|---|---|
| `node --test tests\unit` (pasta) | No Node 24 trata como arquivo e falha. Use glob: `"tests/unit/*.test.js"` |
| Fonte `color=` do FFmpeg não tem fim | Sempre limite: `-t`, `-shortest` ou `-frames:v`. Sem isso o teste **trava** |
| `volumedetect` de silêncio em AAC | Mede **−91 dB**, não `-inf`. Considere silêncio abaixo de −80 dB |
| `node --test` com `^` ou aspas no `package.json` | No cmd, `^` precisa estar entre aspas duplas |
| Script de teste que não sai com erro | O `test_backend.js` imprime `❌` e sai com 0. Não confie no código de saída dele sozinho |
| Janela do Electron em segundo plano | O Chromium estrangula timers. O harness usa opacidade 0 e `setBackgroundThrottling(false)`, em vez de `hide()` |

## O que os testes já pegaram

Ao escrever os testes unitários da montagem e dos filtros, dois bugs que já
estavam no código apareceram:

1. **Volume 0% saía a 100%.** O código usava `Number(volume) || 1`, e o `0` é
   falso: um trecho com o controle de volume no mínimo (sem estar mudo)
   exportava no volume máximo. Estava em três lugares. Agora existe
   `itemVolume()`, testado, e o mix foi conferido com o `volumedetect`.
2. **Cor parcial gerava `contrast=NaN`.** Faltando um campo, `Number(undefined)`
   é `NaN`, que passa pelo `clamp` sem ser corrigido, e o FFmpeg recusaria o
   filtro. Agora `numberOr()` devolve o padrão.

## O que ainda **não** está coberto

Ser honesto sobre isso é parte do roteiro.

- **Transições** (`xfade`/`acrossfade` em `buildBaseWithTransitions`) e a
  **normalização do trecho da base** (`buildNormalizedItem`): dependem do
  `fluent-ffmpeg` e ainda moram no `main.js`. O caminho é extrair o que for
  texto para `lib\`.
- **Títulos e legendas** (`buildTextChain`): usa fonte do sistema e arquivos
  temporários.
- **Corte por keyframe** e o modo Rápido: só pelo `test_backend.js`.
- **Salvar e abrir projeto `.cutting`**, desfazer/refazer, recuperação
  automática.
- **Arrastar e soltar** na linha do tempo, zoom, atalhos de teclado.
- **O diálogo de salvar** do `extract-audio` (a parte sem diálogo está coberta).

Ao mexer em qualquer um desses, o trabalho **começa** extraindo a parte pura e
cobrindo-a, e só depois muda o comportamento.

Voltar: [DESENVOLVIMENTO.md](DESENVOLVIMENTO.md)
