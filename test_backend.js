const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');

let ffmpegBinary = null;
let ffprobeBinary = null;

// Configura os caminhos do FFmpeg/FFprobe como no main.js
try {
  const ffmpegPath = require('ffmpeg-static');
  const ffprobePath = require('@ffprobe-installer/ffprobe').path;
  ffmpeg.setFfmpegPath(ffmpegPath);
  ffmpeg.setFfprobePath(ffprobePath);
  ffmpegBinary = ffmpegPath;
  ffprobeBinary = ffprobePath;
  console.log('✔ FFmpeg configurado com sucesso. Path:', ffmpegPath);
} catch (err) {
  console.error('❌ Erro ao configurar FFmpeg:', err);
  process.exit(1);
}

// --- Auxiliares de verificação de CONTEÚDO do corte ---

function execBin(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      resolve({ err, out: (stdout || '') + (stderr || '') });
    });
  });
}

// Compara o primeiro frame de `cutFile` com o frame do original em `originalTime`.
// Retorna o PSNR: Infinity = idêntico (cópia sem perda), valores altos = mesmo frame recodificado.
async function firstFramePsnr(cutFile, sourceFile, originalTime) {
  const { out } = await execBin(ffmpegBinary, [
    '-i', cutFile,
    '-ss', String(originalTime), '-i', sourceFile,
    '-filter_complex',
    '[0:v]trim=end_frame=1,setpts=0[a];[1:v]trim=end_frame=1,setpts=0[b];[a][b]psnr',
    '-f', 'null', '-'
  ]);
  const match = out.match(/average:(inf|[\d.]+)/);
  if (!match) return null;
  return match[1] === 'inf' ? Infinity : parseFloat(match[1]);
}

// Confirma que o corte REALMENTE começa no ponto pedido, e não num keyframe anterior.
// Compara a similaridade contra o ponto pedido vs. o começo do vídeo.
async function assertStartsAt(cutFile, sourceFile, expectedStart) {
  const atExpected = await firstFramePsnr(cutFile, sourceFile, expectedStart);
  const atZero = await firstFramePsnr(cutFile, sourceFile, 0);

  if (atExpected === null || atZero === null) {
    throw new Error('Não foi possível medir a origem do primeiro frame do corte.');
  }
  if (atExpected <= atZero) {
    throw new Error(
      `O corte NÃO começa em ${expectedStart}s. ` +
      `Similaridade com ${expectedStart}s = ${atExpected.toFixed(1)} dB, ` +
      `mas com 0s = ${atZero.toFixed(1)} dB (o vídeo foi salvo desde o começo).`
    );
  }
  return { atExpected, atZero };
}

// Pasta de trabalho dos testes, relativa ao proprio arquivo. O caminho
// absoluto que estava aqui so existia na maquina de quem escreveu o teste.
const tempDir = path.join(__dirname, 'dist', 'teste');
const testVideoPath = path.join(tempDir, 'synthetic_test_video.mp4');

// Cria a pasta dist se não existir
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

async function generateTestVideo() {
  console.log('Gerando vídeo sintético de teste (10 segundos)...');
  return new Promise((resolve, reject) => {
    // Usa geradores lavfi para criar tela de teste (testsrc) e tom de bip (sine)
    ffmpeg()
      .input('testsrc=duration=10:size=640x360:rate=30')
      .inputOptions(['-f lavfi'])
      .input('sine=frequency=1000:duration=10')
      .inputOptions(['-f lavfi'])
      .outputOptions([
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-c:a aac',
        '-shortest'
      ])
      .output(testVideoPath)
      .on('end', () => {
        console.log('✔ Vídeo sintético gerado com sucesso em:', testVideoPath);
        resolve();
      })
      .on('error', (err) => {
        console.error('Erro ao gerar vídeo sintético:', err);
        reject(err);
      })
      .run();
  });
}

async function runTests() {
  console.log('\n--- INICIANDO TESTES DE INTEGRAÇÃO DO BACKEND ---\n');

  // Teste 1: Gerar e Validar Vídeo de Teste
  try {
    await generateTestVideo();
  } catch (e) {
    console.error('❌ Teste 1 falhou: Não foi possível gerar vídeo de teste.');
    process.exit(1);
  }
  console.log('✔ Teste 1: Vídeo de teste disponível.');

  // Teste 2: Leitura de Metadados (ffprobe)
  let videoDuration = 0;
  try {
    videoDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(testVideoPath, (err, metadata) => {
        if (err) return reject(err);
        const duration = metadata.format.duration;
        console.log(`✔ Teste 2: Metadados lidos com sucesso. Duração: ${duration}s, Resolução: ${metadata.streams[0].width}x${metadata.streams[0].height}`);
        resolve(duration);
      });
    });
  } catch (err) {
    console.error('❌ Teste 2 falhou (Erro no ffprobe):', err);
    process.exit(1);
  }

  // Teste 3: Geração de Vídeo de Preview
  const previewPath = path.join(tempDir, 'test_preview.mp4');
  try {
    await new Promise((resolve, reject) => {
      ffmpeg(testVideoPath)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',
          '-crf 28',
          '-c:a aac',
          '-b:a 128k',
          '-movflags +faststart'
        ])
        .size('?x480')
        .output(previewPath)
        .on('end', () => {
          if (fs.existsSync(previewPath) && fs.statSync(previewPath).size > 0) {
            console.log('✔ Teste 3: Preview gerado com sucesso.');
            resolve();
          } else {
            reject(new Error('Arquivo de preview gerado está vazio.'));
          }
        })
        .on('error', reject)
        .run();
    });
  } catch (err) {
    console.error('❌ Teste 3 falhou (Erro ao gerar preview):', err);
  }

  // Teste 4: Corte Preciso de Início
  //
  // Este teste usa um vídeo com GOP LONGO (keyframes a cada 10s), que é o cenário
  // que expõe a falha: com `-c copy` o FFmpeg só consegue começar num keyframe,
  // então o corte "escorrega" para trás e o vídeo sai desde o começo.
  // Além da duração, verificamos o CONTEÚDO do primeiro frame — só medir a duração
  // aprova um corte que começa no lugar errado.
  const longGopPath = path.join(tempDir, 'test_long_gop.mp4');
  const cutStart = 12.0;
  const cutEnd = 20.0; // Duração esperada: 8 segundos
  const cutPath = path.join(tempDir, 'test_cut_precise.mp4');

  try {
    console.log('Gerando vídeo com GOP longo (keyframes a cada 10s)...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input('testsrc=duration=30:size=320x180:rate=30').inputOptions(['-f lavfi'])
        .input('sine=frequency=1000:duration=30').inputOptions(['-f lavfi'])
        .outputOptions([
          '-c:v libx264',
          '-g 300', '-keyint_min 300', '-sc_threshold 0', // força keyframes só a cada 10s
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-shortest'
        ])
        .output(longGopPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    console.log(`Cortando trecho de ${cutStart}s a ${cutEnd}s (início FORA de keyframe)...`);
    try { fs.unlinkSync(cutPath); } catch (e) {}

    // Mesma estratégia do modo "preciso" do main.js: `-ss` antes do `-i` recodificando,
    // que no FFmpeg moderno é seek rápido E exato (decodifica do keyframe e descarta o resto).
    await new Promise((resolve, reject) => {
      ffmpeg(longGopPath)
        .inputOptions([`-ss ${cutStart}`])
        .outputOptions([
          `-t ${cutEnd - cutStart}`,
          '-map 0:v:0',
          '-map 0:a?',
          '-c:v libx264',
          '-preset veryfast',
          '-crf 18',
          '-pix_fmt yuv420p',
          '-c:a aac',
          '-b:a 192k'
        ])
        .output(cutPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    if (!fs.existsSync(cutPath)) {
      throw new Error('Arquivo de corte não foi gerado.');
    }

    // 4a. Duração correta
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(cutPath, (err, metadata) => {
        if (err) return reject(err);
        resolve(parseFloat(metadata.format.duration));
      });
    });
    const expectedDuration = cutEnd - cutStart;
    if (Math.abs(duration - expectedDuration) > 0.25) {
      throw new Error(`Duração incorreta do corte: ${duration.toFixed(2)}s (esperado: ${expectedDuration.toFixed(2)}s)`);
    }

    // 4b. O corte começa REALMENTE no ponto pedido (e não no keyframe anterior / no começo)
    const psnrCheck = await assertStartsAt(cutPath, longGopPath, cutStart);

    console.log(
      `✔ Teste 4: Corte preciso de início respeitado. Duração: ${duration.toFixed(2)}s ` +
      `(esperado: ${expectedDuration.toFixed(2)}s) | 1º frame: ${psnrCheck.atExpected.toFixed(1)} dB vs ${cutStart}s ` +
      `contra ${psnrCheck.atZero.toFixed(1)} dB vs 0s`
    );
  } catch (err) {
    console.error('❌ Teste 4 falhou (Erro no corte preciso):', err.message);
  }

  // Teste 4c: Corte "rápido / sem perda" deve informar o keyframe usado
  try {
    const fastCutPath = path.join(tempDir, 'test_cut_fast.mp4');
    try { fs.unlinkSync(fastCutPath); } catch (e) {}

    // No modo rápido o início escorrega para o keyframe anterior (10s) — isso é esperado,
    // e o app avisa o usuário. O que NÃO pode acontecer é a duração explodir:
    // por isso NÃO usamos '-avoid_negative_ts make_zero' junto com `-ss` de entrada.
    const keyframeStart = 10.0;
    await new Promise((resolve, reject) => {
      ffmpeg(longGopPath)
        .inputOptions([`-ss ${keyframeStart}`])
        .outputOptions([`-t ${cutEnd - keyframeStart}`, '-map 0:v:0', '-map 0:a?', '-c copy'])
        .output(fastCutPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    const fastDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(fastCutPath, (err, metadata) => {
        if (err) return reject(err);
        resolve(parseFloat(metadata.format.duration));
      });
    });

    const expectedFast = cutEnd - keyframeStart;
    if (Math.abs(fastDuration - expectedFast) > 0.25) {
      throw new Error(`Duração incorreta: ${fastDuration.toFixed(2)}s (esperado: ${expectedFast.toFixed(2)}s). ` +
        `Isso indica o retorno de "-avoid_negative_ts make_zero" junto com o "-ss" de entrada.`);
    }

    const psnrFast = await firstFramePsnr(fastCutPath, longGopPath, keyframeStart);
    if (psnrFast !== Infinity) {
      throw new Error(`Corte sem perda não é idêntico ao original no keyframe (PSNR: ${psnrFast}).`);
    }

    console.log(`✔ Teste 4c: Corte rápido sem perda OK. Duração: ${fastDuration.toFixed(2)}s, 1º frame idêntico ao original em ${keyframeStart}s.`);
    try { fs.unlinkSync(fastCutPath); } catch (e) {}
  } catch (err) {
    console.error('❌ Teste 4c falhou:', err.message);
  }

  // Teste 5: Mesclagem (Concat Demuxer e Complex Concat)
  // Criamos dois arquivos de corte para mesclar
  const cut1Path = path.join(tempDir, 'test_part1.mp4');
  const cut2Path = path.join(tempDir, 'test_part2.mp4');
  const mergedPath = path.join(tempDir, 'test_merged.mp4');
  const listFilePath = path.join(tempDir, 'test_merge_list.txt');

  try {
    console.log('Gerando partes para testar mesclagem...');
    // Parte 1 (0s a 2s)
    await new Promise((res, rej) => {
      ffmpeg(testVideoPath).seekInput(0).duration(2).outputOptions('-c copy').output(cut1Path).on('end', res).on('error', rej).run();
    });
    // Parte 2 (5s a 7s)
    await new Promise((res, rej) => {
      ffmpeg(testVideoPath).seekInput(5).duration(2).outputOptions('-c copy').output(cut2Path).on('end', res).on('error', rej).run();
    });

    console.log('Iniciando teste de concat demuxer...');
    const fileContent = `file '${cut1Path.replace(/\\/g, '/')}'\nfile '${cut2Path.replace(/\\/g, '/')}'`;
    fs.writeFileSync(listFilePath, fileContent, 'utf8');

    await new Promise((resolve, reject) => {
      ffmpeg(listFilePath)
        .inputOptions(['-f concat', '-safe 0'])
        .outputOptions('-c copy')
        .output(mergedPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    if (fs.existsSync(mergedPath)) {
      await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(mergedPath, (err, metadata) => {
          if (err) return reject(err);
          const duration = parseFloat(metadata.format.duration);
          console.log(`✔ Teste 5: Mesclagem direta rápida concluída. Duração do vídeo mesclado: ${duration.toFixed(2)}s (esperado: 4.00s)`);
          resolve();
        });
      });
    } else {
      throw new Error('Vídeo mesclado não foi gerado.');
    }
  } catch (err) {
    console.error('❌ Teste 5 falhou (Erro na mesclagem):', err.message);
  }

  // Teste 6: Sequência MULTI-FONTE em um único vídeo
  //
  // Cenário real do novo fluxo: trechos de vídeos DIFERENTES, com resoluções
  // diferentes, na ordem escolhida pelo usuário. O concat demuxer tem que falhar
  // (parâmetros incompatíveis) e o filter_complex tem que assumir, padronizando
  // para a MAIOR resolução — e não para 720p fixo, como era antes.
  const srcA = path.join(tempDir, 'test_src_a.mp4');   // 320x180
  const srcB = path.join(tempDir, 'test_src_b.mp4');   // 640x360
  const segA = path.join(tempDir, 'test_seg_a.mp4');
  const segB = path.join(tempDir, 'test_seg_b.mp4');
  const seqPath = path.join(tempDir, 'test_sequence.mp4');
  const seqListPath = path.join(tempDir, 'test_seq_list.txt');

  try {
    console.log('Gerando duas fontes com resoluções diferentes...');
    const makeSource = (outPath, size, pattern) => new Promise((resolve, reject) => {
      ffmpeg()
        .input(`${pattern}=duration=10:size=${size}:rate=30`).inputOptions(['-f lavfi'])
        .input('sine=frequency=800:duration=10').inputOptions(['-f lavfi'])
        .outputOptions(['-c:v libx264', '-pix_fmt yuv420p', '-c:a aac', '-shortest'])
        .output(outPath)
        .on('end', resolve).on('error', reject).run();
    });
    await makeSource(srcA, '320x180', 'testsrc');
    await makeSource(srcB, '640x360', 'testsrc2');

    // Corta 3s de cada fonte (modo preciso, como o app faz)
    const cutSegment = (src, out, start, end) => new Promise((resolve, reject) => {
      ffmpeg(src)
        .inputOptions([`-ss ${start}`])
        .outputOptions([`-t ${end - start}`, '-map 0:v:0', '-map 0:a?',
          '-c:v libx264', '-preset veryfast', '-crf 18', '-pix_fmt yuv420p', '-c:a aac', '-b:a 192k'])
        .output(out)
        .on('end', resolve).on('error', reject).run();
    });
    await cutSegment(srcA, segA, 2, 5);
    await cutSegment(srcB, segB, 6, 9);

    // 6a. O concat demuxer DEVE falhar com resoluções diferentes
    fs.writeFileSync(seqListPath,
      `file '${segA.replace(/\\/g, '/')}'\nfile '${segB.replace(/\\/g, '/')}'`, 'utf8');

    // O demuxer NÃO sinaliza erro com resoluções diferentes — confirma isso,
    // pois é exatamente por essa razão que checamos a compatibilidade antes.
    let demuxWorked = true;
    try {
      await new Promise((resolve, reject) => {
        ffmpeg(seqListPath).inputOptions(['-f concat', '-safe 0'])
          .outputOptions('-c copy').output(seqPath)
          .on('end', resolve).on('error', reject).run();
      });
    } catch (e) {
      demuxWorked = false;
    }

    // Mesma lógica de canConcatByDemux() do main.js
    const signatureOf = (file) => new Promise((resolve) => {
      ffmpeg.ffprobe(file, (err, metadata) => {
        if (err) return resolve(null);
        const v = metadata.streams.find(s => s.codec_type === 'video');
        const a = metadata.streams.find(s => s.codec_type === 'audio');
        if (!v) return resolve(null);
        resolve([v.codec_name, v.width, v.height, v.pix_fmt,
          a ? a.codec_name : 'none', a ? a.sample_rate : 0, a ? a.channels : 0].join('|'));
      });
    });
    const sigs = await Promise.all([segA, segB].map(signatureOf));
    const detectedCompatible = sigs.every(s => s === sigs[0]);

    if (detectedCompatible) {
      throw new Error('A verificação de compatibilidade considerou compatíveis dois vídeos de resoluções diferentes.');
    }
    console.log(`   demuxer sozinho reportaria: ${demuxWorked ? 'SUCESSO (enganoso!)' : 'erro'} → a verificação prévia detectou a incompatibilidade e força o fallback ✔`);

    // 6b. Fallback: filter_complex padronizando para a MAIOR resolução (640x360)
    try { fs.unlinkSync(seqPath); } catch (e) {}
    const targetW = 640, targetH = 360, targetFps = 30;
    const filter =
      `[0:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps}[v0];` +
      `[1:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${targetFps}[v1];` +
      `[0:a]aresample=44100[a0];[1:a]aresample=44100[a1];` +
      `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`;

    await new Promise((resolve, reject) => {
      ffmpeg().input(segA).input(segB)
        .complexFilter(filter).map('[v]').map('[a]')
        .outputOptions(['-c:v libx264', '-preset veryfast', '-crf 23', '-c:a aac', '-b:a 128k', '-ar 44100'])
        .output(seqPath)
        .on('end', resolve).on('error', reject).run();
    });

    const seqInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(seqPath, (err, metadata) => {
        if (err) return reject(err);
        const v = metadata.streams.find(s => s.codec_type === 'video');
        resolve({
          duration: parseFloat(metadata.format.duration),
          width: v.width,
          height: v.height,
          hasAudio: metadata.streams.some(s => s.codec_type === 'audio')
        });
      });
    });

    const expectedSeq = 6.0; // 3s + 3s
    if (Math.abs(seqInfo.duration - expectedSeq) > 0.35) {
      throw new Error(`Duração da sequência incorreta: ${seqInfo.duration.toFixed(2)}s (esperado ${expectedSeq.toFixed(2)}s)`);
    }
    if (seqInfo.width !== targetW || seqInfo.height !== targetH) {
      throw new Error(`Resolução da sequência: ${seqInfo.width}x${seqInfo.height} (esperado ${targetW}x${targetH} = a maior das fontes)`);
    }
    if (!seqInfo.hasAudio) {
      throw new Error('A sequência saiu sem faixa de áudio.');
    }

    console.log(`✔ Teste 6: Sequência multi-fonte OK. ${seqInfo.duration.toFixed(2)}s, ${seqInfo.width}x${seqInfo.height}, com áudio (esperado 6.00s / 640x360).`);
  } catch (err) {
    console.error('❌ Teste 6 falhou (sequência multi-fonte):', err.message);
  }

  // Teste 7: Sanitização de nome de arquivo e caminho único
  try {
    const sanitize = (name) => String(name)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^\.+|\.+$/g, '')
      .trim()
      .slice(0, 120);

    const cases = [
      ['meu:video/ilegal*', 'meuvideoilegal'],
      ['  espaços   demais  ', 'espaços demais'],
      ['...pontas...', 'pontas'],
      ['normal_123', 'normal_123']
    ];
    for (const [input, expected] of cases) {
      const got = sanitize(input);
      if (got !== expected) throw new Error(`sanitize("${input}") = "${got}", esperado "${expected}"`);
    }

    // uniquePath: não pode sobrescrever arquivo existente
    const busy = path.join(tempDir, 'ocupado.mp4');
    fs.writeFileSync(busy, 'x');
    const uniquePath = (dir, fileName) => {
      const ext = path.extname(fileName);
      const stem = path.basename(fileName, ext);
      let candidate = path.join(dir, fileName);
      let counter = 2;
      while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${stem} (${counter})${ext}`);
        counter++;
      }
      return candidate;
    };
    const resolved = uniquePath(tempDir, 'ocupado.mp4');
    if (path.basename(resolved) !== 'ocupado (2).mp4') {
      throw new Error(`uniquePath devolveu "${path.basename(resolved)}", esperado "ocupado (2).mp4"`);
    }
    fs.unlinkSync(busy);

    console.log('✔ Teste 7: Sanitização de nomes e proteção contra sobrescrita OK.');
  } catch (err) {
    console.error('❌ Teste 7 falhou:', err.message);
  }

  // Teste 8: FORMATO DE SAÍDA — encaixar (tarjas) vs preencher (cortar)
  //
  // Verificar só a resolução final não basta: os dois modos produzem 1080x1920
  // e um deles poderia estar esticando a imagem sem ninguém perceber. Então
  // medimos o BRILHO de uma faixa no topo do quadro:
  //   encaixar  → topo é tarja preta            (luma ~0)
  //   preencher → topo é imagem                 (luma bem acima de 0)
  const fitPath = path.join(tempDir, 'test_fit_contain.mp4');
  const coverPath = path.join(tempDir, 'test_fit_cover.mp4');

  try {
    const W = 1080, H = 1920; // 9:16, a partir de uma fonte 640x360 (16:9)

    const chains = {
      contain: `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
      cover: `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1`
    };

    const renderWithFormat = (src, out, chain) => new Promise((resolve, reject) => {
      ffmpeg(src)
        .inputOptions(['-ss 2'])
        .outputOptions(['-t 3', '-map 0:v:0', '-map 0:a?', '-c:v libx264', '-preset veryfast',
          '-crf 18', '-pix_fmt yuv420p', '-c:a aac', '-b:a 192k', `-vf ${chain}`])
        .output(out)
        .on('end', resolve).on('error', reject).run();
    });

    await renderWithFormat(srcB, fitPath, chains.contain);
    await renderWithFormat(srcB, coverPath, chains.cover);

    const dimensionsOf = (file) => new Promise((resolve, reject) => {
      ffmpeg.ffprobe(file, (err, metadata) => {
        if (err) return reject(err);
        const v = metadata.streams.find(s => s.codec_type === 'video');
        resolve({ width: v.width, height: v.height, duration: parseFloat(metadata.format.duration) });
      });
    });

    // Brilho médio de uma região do primeiro frame (0 = preto absoluto)
    const regionLuma = async (file, cropExpr) => {
      const { out } = await execBin(ffmpegBinary, [
        '-i', file, '-vframes', '1',
        '-vf', `crop=${cropExpr},signalstats,metadata=print:key=lavfi.signalstats.YAVG`,
        '-f', 'null', '-'
      ]);
      const m = out.match(/lavfi\.signalstats\.YAVG=([\d.]+)/);
      if (!m) throw new Error(`Não foi possível medir o brilho de ${path.basename(file)}`);
      return parseFloat(m[1]);
    };

    const fitInfo = await dimensionsOf(fitPath);
    const coverInfo = await dimensionsOf(coverPath);

    if (fitInfo.width !== W || fitInfo.height !== H) {
      throw new Error(`Encaixar saiu em ${fitInfo.width}x${fitInfo.height}, esperado ${W}x${H}`);
    }
    if (coverInfo.width !== W || coverInfo.height !== H) {
      throw new Error(`Preencher saiu em ${coverInfo.width}x${coverInfo.height}, esperado ${W}x${H}`);
    }
    if (Math.abs(fitInfo.duration - 3) > 0.35) {
      throw new Error(`Mudar o formato alterou a duração: ${fitInfo.duration.toFixed(2)}s (esperado 3.00s)`);
    }

    // Faixa de 200px no topo do quadro.
    // Atenção ao limiar: vídeo H.264 usa faixa limitada, onde o PRETO é Y=16 e
    // não Y=0. Comparar com zero daria falso negativo numa tarja perfeita.
    const BLACK_LEVEL = 22; // 16 + folga para o ruído da compressão
    const topFit = await regionLuma(fitPath, `${W}:200:0:0`);
    const topCover = await regionLuma(coverPath, `${W}:200:0:0`);
    const middleFit = await regionLuma(fitPath, `${W}:200:0:${Math.round(H / 2 - 100)}`);

    if (topFit > BLACK_LEVEL) {
      throw new Error(`Encaixar deveria pôr tarja preta no topo, mas o brilho lá é ${topFit.toFixed(1)}`);
    }
    if (middleFit <= BLACK_LEVEL) {
      throw new Error(`Encaixar apagou a imagem: o centro do quadro também está preto (${middleFit.toFixed(1)}).`);
    }
    if (topCover <= BLACK_LEVEL) {
      throw new Error(`Preencher deveria ocupar o quadro todo, mas o topo está preto (brilho ${topCover.toFixed(1)})`);
    }

    console.log(
      `✔ Teste 8: Formato de saída OK. ${W}x${H} nos dois modos | ` +
      `topo: encaixar ${topFit.toFixed(1)} (tarja preta) vs preencher ${topCover.toFixed(1)} (imagem) | ` +
      `centro do encaixar ${middleFit.toFixed(1)} (imagem preservada).`
    );
  } catch (err) {
    console.error('❌ Teste 8 falhou (formato de saída):', err.message);
  }

  // Teste 9: FOTO vira trecho de vídeo com a duração pedida
  //
  // Além da duração, checa a faixa de ÁUDIO: sem ela a foto não emenda com os
  // vídeos na junção, e o defeito só apareceria no vídeo final montado.
  const photoPath = path.join(tempDir, 'test_photo.png');
  const photoClipPath = path.join(tempDir, 'test_photo_clip.mp4');

  try {
    // Foto sintética 801x601 — dimensões ÍMPARES de propósito: o yuv420p exige
    // largura e altura pares, então o filtro precisa corrigir isso sozinho.
    await new Promise((resolve, reject) => {
      ffmpeg().input('testsrc=duration=1:size=801x601:rate=1').inputOptions(['-f lavfi'])
        .outputOptions(['-vframes 1']).output(photoPath)
        .on('end', resolve).on('error', reject).run();
    });

    const PHOTO_SECONDS = 4;
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(photoPath).inputOptions(['-loop 1', '-framerate 30'])
        .input('anullsrc=channel_layout=stereo:sample_rate=44100').inputOptions(['-f lavfi'])
        .outputOptions([`-t ${PHOTO_SECONDS}`, '-map 0:v:0', '-map 1:a:0',
          '-c:v libx264', '-preset veryfast', '-crf 18',
          '-pix_fmt yuv420p', '-r 30', '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
          '-c:a aac', '-b:a 192k', '-shortest'])
        .output(photoClipPath)
        .on('end', resolve).on('error', reject).run();
    });

    const clipInfo = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(photoClipPath, (err, metadata) => {
        if (err) return reject(err);
        const v = metadata.streams.find(s => s.codec_type === 'video');
        resolve({
          duration: parseFloat(metadata.format.duration),
          width: v.width,
          height: v.height,
          hasAudio: metadata.streams.some(s => s.codec_type === 'audio')
        });
      });
    });

    if (Math.abs(clipInfo.duration - PHOTO_SECONDS) > 0.35) {
      throw new Error(`Duração da foto: ${clipInfo.duration.toFixed(2)}s (esperado ${PHOTO_SECONDS}.00s)`);
    }
    if (clipInfo.width % 2 !== 0 || clipInfo.height % 2 !== 0) {
      throw new Error(`Dimensões ímpares no trecho da foto: ${clipInfo.width}x${clipInfo.height}`);
    }
    if (!clipInfo.hasAudio) {
      throw new Error('O trecho da foto saiu sem faixa de áudio — não emendaria com os vídeos.');
    }

    console.log(
      `✔ Teste 9: Foto virou trecho de ${clipInfo.duration.toFixed(2)}s, ` +
      `${clipInfo.width}x${clipInfo.height} (de 801x601 ímpar), com áudio silencioso.`
    );
  } catch (err) {
    console.error('❌ Teste 9 falhou (foto como trecho):', err.message);
  }

  // Limpeza de arquivos de teste
  console.log('\nLimpando arquivos temporários de teste...');
  const pathsToClean = [testVideoPath, previewPath, cutPath, longGopPath, cut1Path, cut2Path,
    mergedPath, listFilePath, srcA, srcB, segA, segB, seqPath, seqListPath,
    fitPath, coverPath, photoPath, photoClipPath];
  pathsToClean.forEach(p => {
    try {
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch (e) {
      console.warn(`Aviso ao excluir ${p}:`, e.message);
    }
  });

  console.log('\n--- TESTES CONCLUÍDOS ---');
}

runTests();
