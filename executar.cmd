@echo off
REM ============================================================================
REM  Cutting - executa em modo desenvolvimento
REM  Abre o aplicativo direto do codigo-fonte. Feche a janela para encerrar.
REM  Para ver o efeito de uma mudanca, feche e rode de novo.
REM ============================================================================
chcp 65001 >nul
cd /d "%~dp0"

call "%~dp0ambiente.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo  Abrindo o Cutting...
echo.

call npm start

if errorlevel 1 (
    echo.
    echo  [ERRO] O aplicativo terminou com erro. Veja a mensagem acima.
    echo.
    pause
)
