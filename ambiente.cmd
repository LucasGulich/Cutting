@echo off
REM ============================================================================
REM  Prepara as verificacoes usadas pelos demais scripts.
REM  Chamado por executar.cmd, testar.cmd e empacotar.cmd - nao rode direto.
REM ============================================================================

where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [ERRO] Node.js nao encontrado.
    echo         Instale o Node.js LTS ^(https://nodejs.org^) e abra o terminal de novo.
    echo.
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo.
    echo  [ERRO] npm nao encontrado. Reinstale o Node.js.
    echo.
    exit /b 1
)

REM  Sem node_modules o app nao abre. Instala sozinho na primeira vez.
if not exist "%~dp0node_modules" (
    echo.
    echo  Primeira execucao: instalando as dependencias ^(npm install^)...
    echo.
    pushd "%~dp0"
    call npm install
    set "RESULTADO=%errorlevel%"
    popd
    if not "%RESULTADO%"=="0" (
        echo.
        echo  [ERRO] Falha no npm install.
        echo.
        exit /b 1
    )
)

exit /b 0
