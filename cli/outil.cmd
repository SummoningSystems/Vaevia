@echo off
rem Lanceur de la CLI « outil » (Windows : cmd, PowerShell) : node cli\outil.ts <commande>. Node 24 requis.
rem Mettre ce dossier (cli\) dans le PATH.
rem NoDefaultCurrentDirectoryInExePath : « node » n'est jamais cherché dans le dossier courant (un node.bat ou node.exe
rem posé dans le dépôt serait sinon lancé) ; setlocal : la variable ne reste pas dans la session cmd qui appelle.
setlocal
set "NoDefaultCurrentDirectoryInExePath=1"
rem Paquet hors ligne (etape 3.9, A7) : le Node livre dans <depot>\node passe avant celui du PATH.
if exist "%~dp0..\node\node.exe" ("%~dp0..\node\node.exe" "%~dp0outil.ts" %*) else (node "%~dp0outil.ts" %*)
exit /b %ERRORLEVEL%
