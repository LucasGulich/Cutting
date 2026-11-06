@echo off
REM ============================================================================
REM  Cutting - gera o programa pronto para entregar a outra pessoa.
REM
REM  Saida principal:  dist\Cutting-v<versao>-win32-x64.zip
REM
REM  A pasta Cutting-win32-x64 leva tudo embutido (Electron e FFmpeg): quem
REM  receber so precisa descompactar e dar duplo clique no Cutting.exe.
REM  Nao instala nada, nao precisa de Node.
REM ============================================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

call "%~dp0ambiente.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

REM ---- 1/4 - o Cutting nao pode estar aberto ---------------------------------
REM  Um Cutting em execucao segura os arquivos da pasta dist, e o empacotamento
REM  falha no meio do caminho. Melhor barrar aqui, com o motivo claro.

tasklist /fi "imagename eq Cutting.exe" 2>nul | find /i "Cutting.exe" >nul && (
    echo.
    echo  [ERRO] O Cutting esta aberto e segura os arquivos que precisam ser
    echo         regravados. Feche-o e rode este script de novo.
    echo.
    pause
    exit /b 1
)

REM ---- 2/4 - versao, lida do package.json ------------------------------------
REM  Lida e nao escrita aqui: a versao muda em um lugar so e nao diverge do
REM  que foi empacotado.

node -p "require('./package.json').version" > "%TEMP%\cutting-versao.txt" 2>nul
set /p VERSAO=<"%TEMP%\cutting-versao.txt"
del /q "%TEMP%\cutting-versao.txt" 2>nul

if not defined VERSAO (
    echo  [ERRO] Nao consegui ler a versao do package.json.
    pause
    exit /b 1
)

echo.
echo  ============================================================
echo   Empacotando o Cutting %VERSAO%
echo  ============================================================
echo.

REM ---- 3/4 - gerar o executavel ----------------------------------------------
echo  [1/3] Gerando o executavel (demora alguns minutos)...
call npm run dist
if errorlevel 1 (
    echo.
    echo  [ERRO] Falha ao empacotar. Veja a mensagem acima.
    echo.
    pause
    exit /b 1
)

if not exist "dist\Cutting-win32-x64\Cutting.exe" (
    echo.
    echo  [ERRO] O empacotamento terminou, mas nao achei dist\Cutting-win32-x64\Cutting.exe
    echo.
    pause
    exit /b 1
)

REM ---- 4/4 - compactar -------------------------------------------------------
REM  A saida fica em dist\, junto das versoes anteriores. O "npm run dist"
REM  so regrava a pasta Cutting-win32-x64, entao os arquivos antigos ficam.

echo  [2/3] Compactando para envio...
set "ZIP=dist\Cutting-v%VERSAO%-win32-x64.zip"
if exist "%ZIP%" del /q "%ZIP%"

powershell -NoProfile -Command "Compress-Archive -Path 'dist\Cutting-win32-x64' -DestinationPath '%ZIP%' -CompressionLevel Optimal -Force"
if errorlevel 1 (
    echo  [ERRO] Falha ao compactar.
    pause
    exit /b 1
)

set "TAMANHO=0"
for %%f in ("%ZIP%") do set /a TAMANHO=%%~zf/1048576

echo  [3/3] Pronto.

echo.
echo  ============================================================
echo   PRONTO
echo  ============================================================
echo.
echo   Envie este arquivo:
echo.
echo       %CD%\%ZIP%
echo       (cerca de %TAMANHO% MB)
echo.
echo   Quem receber precisa:
echo     1. Descompactar a pasta Cutting-win32-x64 em qualquer lugar
echo     2. Dar duplo clique em Cutting.exe
echo     3. Se aparecer a tela azul do Windows, clicar em
echo        "Mais informacoes" e depois "Executar assim mesmo"
echo        (e normal: o programa nao tem assinatura digital paga)
echo.
echo   Se der erro na maquina dele, peca para rodar o diagnostico.bat
echo   dentro da pasta Cutting-win32-x64.
echo.
pause
