# Desenvolvimento

> Ambiente, estrutura, padrões e o checklist de "pronto". É o roteiro para
> mexer no Cutting sem quebrar o que já funciona.

## Os scripts

Todos na raiz, com duplo clique ou pelo terminal:

```cmd
executar.cmd      abre o Cutting direto do código-fonte, para testar
testar.cmd        roda os 200 testes
empacotar.cmd     gera dist\Cutting-v<versão>-win32-x64.zip, pronto para enviar
ambiente.cmd      confere Node e npm e instala as dependências (chamado pelos outros)
```

Direto pelo npm, quando quiser mais controle:

```cmd
npm start                  executa
npm test                   toda a bateria
npm run test:unit          só os testes puros (meio segundo)
npm run test:integracao    só FFmpeg e Electron
npm run test:legado        o test_backend.js original, sozinho
npm run dist               só o executável, sem o zip
```

Para rodar **um** arquivo de teste:

```cmd
node --test tests/unit/filtros.test.js
```

O `empacotar.cmd` recusa começar se o Cutting estiver aberto, lê a versão do
`package.json` (ela não é escrita em lugar nenhum: não tem como divergir do
que foi empacotado) e junta tudo em um zip. Quem recebe descompacta e dá duplo
clique no `Cutting.exe`.

## Estrutura

```
Cutting\
├─ main.js            processo principal: janela, diálogos, orquestração do FFmpeg
├─ preload.js         ponte entre os dois processos (contextIsolation ligado)
├─ renderer.js        a interface: linha do tempo, monitor, painéis, atalhos
├─ index.html  style.css
├─ lib\               a lógica PURA, sem Electron e sem tela  ← testada
│  ├─ arquivos.js         nome seguro, nunca sobrescrever
│  ├─ filtros.js          filtros do FFmpeg e normalização dos ajustes
│  ├─ montagem.js         tempo, volume, transições, grafo de composição
│  ├─ audio.js            argumentos do FFmpeg para trabalhar só com áudio
│  └─ linhadotempo.js     regras da linha do tempo (carrega no app e nos testes)
├─ tests\
│  ├─ unit\
│  └─ integracao\
├─ test_backend.js    os 9 testes originais do FFmpeg
├─ docs\
└─ *.cmd              executar, testar, empacotar, ambiente
```

## Onde cada coisa mora

A pergunta que decide: **isso precisa de Electron ou da tela?**

```
        ┌───────────────────────────────────────────┐
        │ renderer.js     o que se vê e se clica    │  só liga a tela às regras
        └─────────────────────┬─────────────────────┘
                              │  window.api  (preload.js)
        ┌─────────────────────▼─────────────────────┐
        │ main.js         diálogos, disco, FFmpeg   │  só orquestra
        └─────────────────────┬─────────────────────┘
                              │ chama
        ┌─────────────────────▼─────────────────────┐
        │ lib\            regras e montagem de texto│  PURA: é aqui que se testa
        └───────────────────────────────────────────┘
```

| Se é… | Vai para |
|---|---|
| Cálculo, decisão, montagem de filtro ou de argumento do FFmpeg | `lib\` |
| Abrir diálogo, ler/gravar disco, executar o FFmpeg, mandar progresso | `main.js` |
| Expor um handler novo ao renderer | `main.js` + `preload.js` |
| Pintar a tela, ligar botão, abrir modal | `renderer.js` |

**Nada de regra de negócio dentro de botão.** O clique chama uma função; a
função decide usando o `lib\`. É o que permite testar a decisão sem abrir a
tela, e é o mesmo princípio do MyApp ("a tela chama o serviço, sempre").

### Como uma função vai para `lib\`

- **Recebe tudo por parâmetro.** Nada de `tracks`, `clips` ou `sources`
  globais: `isSimpleTimeline({ tracks, clips, texts })`.
- **Não toca em DOM, `fs` de projeto nem Electron.**
- **Exporta com `module.exports`** (arquivos do `main`) ou no formato duplo do
  `linhadotempo.js` (que o navegador também carrega).
- No `renderer.js`, desestrutura de `window.CuttingTempo` no topo do arquivo.
  A tag `<script src="lib/linhadotempo.js">` **precisa vir antes** do
  `renderer.js` no `index.html`.

## Convenções

**Idioma.** Comentários, mensagens de tela e erros em português correto, **com
acentuação**, escritos com acento desde o início (nunca por substituição em
massa: ela já quebrou identificadores). Nomes de funções seguem o estilo do
arquivo em que você está.

**Comentários explicam o porquê, não o quê.** `// incrementa` não ajuda;
`// o atempo vem ANTES do adelay: acelerar depois deslocaria o silêncio da
frente` explica uma decisão.

**Erros dizem o que fazer.** `'Este arquivo não tem faixa de áudio.'`, não
`'ffmpeg exit 1'`. Handlers devolvem `{ ok: false, error }` em vez de lançar
quando o erro é esperado.

**Nunca sobrescrever em silêncio.** Todo arquivo de saída passa por
`uniquePath`; todo nome digitado, por `sanitizeFileName`.

**Retorno visual em toda ação.** Botão que demora mostra o que está fazendo
("Separando...") e fica desabilitado; o que sai vai para o Explorer ou aparece
na linha do tempo.

## Padrões que já existem (reutilize, não reinvente)

| Preciso de… | Use |
|---|---|
| Confirmar algo que descarta trabalho | `askConfirm({...})`. Com `confirmDelaySeconds: 3` o botão espera, com a contagem no rótulo — para avisos que **precisam ser lidos** |
| Abrir um modal | Registre em `MODALS` (Esc e clique no fundo passam a funcionar sozinhos) |
| Arquivo de saída sem conflito | `uniquePath(dir, nome)` |
| Nome de arquivo vindo do usuário | `sanitizeFileName(texto)` |
| Rodar o FFmpeg só para áudio | `runFfmpegAudio(args)` com argumentos de `lib\audio.js` |
| Volume de um trecho | `itemVolume(item)` — nunca `Number(v) \|\| 1` |
| Número com padrão | `numberOr(valor, padrão)` — nunca `Number(v) \|\| padrão` quando 0 é válido |
| Progresso de exportação | `notifyItem` / `notifyOverall` (veja `export-timeline`) |

## Definição de pronto

Marque tudo antes de dar uma tarefa por concluída:

- [ ] **A regra nova está em `lib\`**, não dentro de handler ou botão.
- [ ] **Tem teste unit** para a regra, incluindo os casos de borda (zero,
      vazio, valor inválido, limite).
- [ ] **Tem teste de integração** se mexe em comando ou grafo do FFmpeg: o
      FFmpeg de verdade aceita e o arquivo que sai foi conferido.
- [ ] **Tem verificação de interface** no harness se mexe em tela ou em
      handler: o fluxo completo roda.
- [ ] **Se foi um bug**, o teste que o pega foi escrito **antes** e foi visto
      falhando.
- [ ] **`testar.cmd` está verde**: todos, não só os novos.
- [ ] **Testado na mão** com `executar.cmd` (o harness não vê estética, foco,
      arrastar e soltar).
- [ ] **Documentação atualizada**: `docs\`, README (recurso novo, contagem de
      testes) e a nota do hub, **junto** com a mudança, não depois.
- [ ] **Versão** no `package.json` se o recurso vai para quem recebe o zip.
- [ ] Nada de segredo, caminho absoluto da sua máquina ou dado real em teste.

## Armadilhas já pagas

Cada uma custou tempo. Ficam registradas para não custar de novo.

**`Number(x) || padrão` trata 0 como ausente.** O volume em 0% exportava a
100%. Use `numberOr` / `itemVolume`, que separam "não informado" de "zero".

**`Number(undefined)` é `NaN`, e `NaN` passa pelo `clamp`.** O resultado vai
direto para o filtro do FFmpeg (`contrast=NaN`) e ele recusa. Valide com
`Number.isFinite`.

**`#` é comentário no parser de filtros do FFmpeg.** Cor vai como `0xRRGGBB`.

**Entrada de stream no `-map` não leva colchetes** (`0:a`), rótulo de filtro
leva (`[amixed]`). O `.map()` do `fluent-ffmpeg` recoloca os colchetes sempre:
por isso essas opções vão direto em `outputOptions`.

**Fonte `color=` e `sine=` do lavfi não terminam.** Limite com `-t`,
`-shortest` ou `-frames:v`, no app e nos testes.

**Declaração `let`/`const` no meio do `renderer.js` pode estourar** se algo a
usar antes na inicialização (zona morta temporal). Estado novo vai junto do
estado existente, no topo; funções que precisam ser alcançadas cedo, como
`function`.

**`test_backend.js` não falha de verdade.** Imprime `❌` e sai com código 0. O
`legado.test.js` embrulha e corrige isso.

**Armadilhas do cmd** (já evitadas no `empacotar.cmd`): parêntese em `echo`
dentro de bloco `if (...)` fecha o bloco antes da hora; `for /f` chamando
PowerShell com parênteses trava sem mensagem. Por isso a versão é lida via
arquivo temporário.

**`npm run dist` sobrescreve `dist\Cutting-win32-x64`.** Os `.rar`/`.zip` de
versões antigas ao lado não são tocados.

## Fluxo de trabalho para uma mudança

1. **Entenda o que já existe**: leia o trecho, o teste dele e a nota do hub.
2. **Escreva o teste primeiro** (ou, num bug, o teste que o reproduz). Veja
   falhar.
3. **Implemente** a regra em `lib\`; o `main.js`/`renderer.js` só ligam.
4. **`npm run test:unit`** a cada passo: leva meio segundo.
5. **Integração e interface** quando mexer em FFmpeg ou tela.
6. **`executar.cmd`** e use de verdade.
7. **Documente** e suba a versão se for o caso.
8. **`empacotar.cmd`** só quando tudo estiver verde.

## Diagnóstico

| Sintoma | Onde olhar |
|---|---|
| Não abre numa máquina de cliente | `diagnostico.bat`, dentro da pasta `Cutting-win32-x64` |
| Exportação falha | O comando do FFmpeg vai para o console (`Composição FFmpeg: …`); rode-o à mão |
| Teste de interface falha | `electron.test.js` mostra o **detalhe** da verificação; rode `node_modules\.bin\electron tests\integracao\_harness-electron.js` para ver a saída crua |
| `npm test` trava | Algum teste com fonte infinita sem `-t`; todos têm `timeout`, mas aponte o culpado pelo nome |

Veja também: [TESTES.md](TESTES.md)
