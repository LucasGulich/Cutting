@echo off
REM ============================================================================
REM  Cutting - roda a bateria de testes automatizados do backend (FFmpeg)
REM ============================================================================
chcp 65001 >nul
cd /d "%~dp0"

call "%~dp0ambiente.cmd"
if errorlevel 1 (
    pause
    exit /b 1
)

echo.
echo  Rodando os testes...
echo.

call npm test

echo.
pause
