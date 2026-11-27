@echo off
rem Installeur Windows du serveur (docs/etape3-5-prise-en-main.md, par. 1.2) : lance outils\installer.ps1 avec
rem Windows PowerShell 5.1 et transmet les arguments (-Arreter, -Demarrer, -Desinstaller, -Reconnecter, -Oui, -Reseau,
rem -Donnees, -Port, -Essai, -Etat, -Profil). Double-clic : pause a la fin pour lire le resume ; avec des arguments, ou depuis
rem une invite de commandes deja ouverte : pas de pause. Ce fichier reste en ASCII (cmd le lit dans la page de code OEM).
setlocal DisableDelayedExpansion
rem Lance depuis PowerShell 7 (& "...\installer.cmd"), PSModulePath pointe vers les modules de PowerShell 7 : Windows
rem PowerShell 5.1 ne trouve alors plus Get-FileHash. Vide (local a ce fichier), 5.1 reprend ses chemins par defaut.
set "PSModulePath="
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0outils\installer.ps1" %*
set "CODE=%ERRORLEVEL%"
if not "%~1"=="" exit /b %CODE%
rem Double-clic : cmd.exe /c ""...\installer.cmd" " ; invite ouverte : cmd.exe seul.
setlocal EnableDelayedExpansion
set "LIGNE=!cmdcmdline!"
if /i not "!LIGNE:/c=!"=="!LIGNE!" pause
exit /b %CODE%
