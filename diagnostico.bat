@echo off
REM ============================================================
REM  Diagnostico do Cutting — rode ESTE arquivo na maquina que
REM  esta dando erro, deixando ele DENTRO da pasta Cutting-win32-x64.
REM  No fim, um arquivo diagnostico.txt fica ao lado, pronto para
REM  ser enviado.
REM ============================================================
setlocal
cd /d "%~dp0"
set SAIDA=%~dp0diagnostico.txt

echo Coletando informacoes... isso leva alguns segundos.
echo.

> "%SAIDA%" echo ===== DIAGNOSTICO DO CUTTING =====
>> "%SAIDA%" echo Data: %DATE% %TIME%
>> "%SAIDA%" echo.

>> "%SAIDA%" echo --- WINDOWS ---
powershell -NoProfile -Command "$o=Get-CimInstance Win32_OperatingSystem; 'Nome    : ' + $o.Caption; 'Versao  : ' + $o.Version; 'Build   : ' + $o.BuildNumber; 'Arquit. : ' + $o.OSArchitecture" >> "%SAIDA%" 2>&1
>> "%SAIDA%" echo.
>> "%SAIDA%" echo (O Cutting exige Windows 10 build 17763 ou superior, 64 bits)
>> "%SAIDA%" echo.

>> "%SAIDA%" echo --- ARQUIVOS ESSENCIAIS ---
call :checar "Cutting.exe"
call :checar "resources\app.asar"
call :checar "resources\app.asar.unpacked\node_modules\ffmpeg-static\ffmpeg.exe"
call :checar "resources\app.asar.unpacked\node_modules\@ffprobe-installer\win32-x64\ffprobe.exe"
call :checar "ffmpeg.dll"
call :checar "libGLESv2.dll"
call :checar "resources.pak"
call :checar "icudtl.dat"
call :checar "v8_context_snapshot.bin"
>> "%SAIDA%" echo.

>> "%SAIDA%" echo --- TAMANHO DA PASTA ---
powershell -NoProfile -Command "$f=Get-ChildItem -Recurse -File; 'Arquivos: ' + $f.Count; 'Tamanho : {0:N0} MB' -f (($f ^| Measure-Object Length -Sum).Sum/1MB)" >> "%SAIDA%" 2>&1
>> "%SAIDA%" echo (Esperado: cerca de 94 arquivos e ~690 MB. Bem menos indica copia incompleta.)
>> "%SAIDA%" echo.

>> "%SAIDA%" echo --- ARQUIVOS BLOQUEADOS PELO WINDOWS ---
powershell -NoProfile -Command "$b=Get-ChildItem -Recurse -File ^| Where-Object { Get-Item $_.FullName -Stream Zone.Identifier -ErrorAction SilentlyContinue }; if ($b) { 'BLOQUEADOS: ' + $b.Count; $b ^| Select-Object -First 5 ^| ForEach-Object { $_.Name } } else { 'Nenhum arquivo bloqueado.' }" >> "%SAIDA%" 2>&1
>> "%SAIDA%" echo.

>> "%SAIDA%" echo --- TENTATIVA DE EXECUCAO (com log) ---
>> "%SAIDA%" echo (a janela pode abrir e fechar; feche-a se ficar aberta)
"%~dp0Cutting.exe" --enable-logging=stderr --v=1 >> "%SAIDA%" 2>&1
>> "%SAIDA%" echo.
>> "%SAIDA%" echo Codigo de saida: %ERRORLEVEL%
>> "%SAIDA%" echo.
>> "%SAIDA%" echo ===== FIM =====

echo.
echo Pronto. Foi gerado o arquivo:
echo   %SAIDA%
echo.
echo Abra ele e me envie o conteudo.
pause
goto :eof

:checar
if exist "%~1" (
  >> "%SAIDA%" echo   [OK]     %~1
) else (
  >> "%SAIDA%" echo   [FALTA]  %~1
)
goto :eof
