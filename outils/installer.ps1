<#
Installeur Windows du serveur (docs/etape3-5-prise-en-main.md, § 1.2), lancé par installer.cmd à la racine du dépôt :
  installer.cmd [-Oui] [-Reseau] [-Donnees <dossier>] [-Port <n>]
  installer.cmd -Arreter | -Demarrer | -Desinstaller | -Reconnecter | -Restaurer <dossier d'une sauvegarde>
  (dans PowerShell : & "<chemin>\installer.cmd" -Arreter ; dans cmd, sans « & »)
  installer.cmd -Essai -Donnees <dossier temporaire> -Etat <dossier temporaire> [-Port <n>] [-Profil <dossier>] [...]
Windows PowerShell 5.1, sans module externe. Ce fichier est ENREGISTRÉ EN UTF-8 AVEC BOM : sans BOM, PowerShell 5.1 le
lit en ANSI, et les accents comme les « ✓ » se cassent.

Ce qu'il fait (une ligne par étape : « ✓ » fait, « – » sans objet, « ✗ » échec) : prérequis (Node ≥ 24, Git), dossiers
(données, journal, installation.json), port, démarrage du serveur en arrière-plan et sans fenêtre (PID dans
serveur.pid), démarrage avec Windows (raccourci dans le dossier Démarrage), CLI dans le PATH utilisateur, raccourci
Claude Code, attente de /api/sante, navigateur (lien admin de lien-admin.txt, jamais affiché dans la console, ou
l'accueil), résumé (avec la phrase à dire à son agent pour brancher un dépôt de code).
- Raccourci Claude Code : seulement si %USERPROFILE%\.claude existe, proposé (oui par défaut) : copie de
  methode\integrations\claude\SKILL.md dans %USERPROFILE%\.claude\skills\site-retours-outil\SKILL.md. Un fichier
  différent déjà là n'est remplacé que sur un « oui » explicite (non par défaut, donc jamais avec -Oui). L'empreinte
  SHA-256 de la copie posée est retenue dans claude-skill.txt (dossier d'état) : -Desinstaller ne retire le fichier
  que s'il lui est identique. Jamais en -Essai, sauf avec -Profil <dossier> (tests), qui remplace %USERPROFILE% et ne
  peut pas mener au vrai %USERPROFILE%\.claude (profil réel lu par GetFolderPath, chemins réels : sinon code 2).
  Cette copie personnelle porte le même nom que celle qu'« outil installer » pose dans chaque dépôt
  (.claude/skills/site-retours-outil) ; Claude Code prend la personnelle d'abord (documentation de Claude Code, non
  rejoué ici) : le résumé dit de relancer l'installeur après chaque mise à jour de l'outil.
- État de l'installation : %LOCALAPPDATA%\Vaevia (installation.json = {outil, donnees, port, url}, sans
  secret, lu par « outil brancher » ; serveur.log ; serveur.pid). Données par défaut : …\Vaevia\donnees.
  Un dossier de données existant d'ailleurs n'est jamais pris par défaut : -Donnees <dossier> pour s'en servir.
- Serveur déjà lancé mais démarré avant la dernière modification de l'outil (serveur/src, serveur/ui, site) : il exécute
  l'ancien code ; l'installeur propose de le redémarrer (oui par défaut, donc aussi avec -Oui et -Essai).
- -Restaurer <dossier> (étape 3.7, A1) : arrête le serveur, restaure la sauvegarde (node serveur/src/restaurer.ts :
  manifeste vérifié, anciennes données gardées à côté, contrôles), puis relance le serveur.
- -Reconnecter : lien de reconnexion du premier admin actif (node serveur/src/lien.ts … reconnexion --admin), ouvert
  dans le navigateur ; démarre le serveur s'il ne tourne pas.
- -Essai (tests) : exige -Etat, et -Donnees pour l'installation (les autres actions lisent installation.json) ; jamais
  winget, ni PATH, ni dossier Démarrage, ni navigateur, ni question, ni raccourci Claude Code sans -Profil ; jamais le port 8080 (sans -Port : le premier
  libre de 8081 à 8099) ; les liens sont écrits sur la sortie.
- Un seul serveur par dossier de données : le serveur y tient serveur.verrou (serveur/src/verrou.ts) ; l'installeur le
  lit et refuse, avant d'écrire quoi que ce soit, un dossier déjà servi par un autre serveur.
- serveur.pid : « <PID> <heure de démarrage du processus, ticks UTC> ». Un processus n'est « le nôtre » (à attendre, à
  arrêter) que si le PID et l'heure concordent et que sa ligne de commande contient principal.ts de ce dépôt ; dans le
  doute (ligne illisible, WMI en échec), il ne l'est pas, et il n'est jamais arrêté.
- PATH utilisateur : lu brut et réécrit avec son type (REG_EXPAND_SZ garde ses %…%), au lieu de
  [Environment]::SetEnvironmentVariable (qui développe et écrit en REG_SZ) ; jamais setx. L'entrée <outil>\cli n'est
  retirée par -Desinstaller que si l'installeur l'a ajoutée (cli-path.txt dans le dossier d'état).
Codes de sortie : 0 succès, 1 échec, 2 usage (options inconnues et -Port invalide compris). Seule exception : une option
à valeur donnée sans valeur (« -Port » seul, en dernier) est refusée par PowerShell avant le script (message rouge,
code 1).
#>
[CmdletBinding(PositionalBinding = $false)]
param(
	[switch]$Arreter,
	[switch]$Demarrer,
	[switch]$Desinstaller,
	[switch]$Reconnecter,
	# Étape 3.7, A1 : dossier d'une sauvegarde (sauvegarde-AAAAMMJJ-HHMMSS) à restaurer.
	[string]$Restaurer = '',
	[switch]$Oui,
	[switch]$Essai,
	[switch]$Reseau,
	[string]$Donnees = '',
	[string]$Etat = '',
	# -Essai seulement : dossier qui tient lieu de %USERPROFILE% pour le raccourci Claude Code (tests).
	[string]$Profil = '',
	# Chaîne, validée par le script : « -Port abc » est une erreur d'usage (code 2), pas une erreur de PowerShell.
	[string]$Port = '',
	# Tout le reste (option inconnue, argument en trop) : erreur d'usage.
	[Parameter(ValueFromRemainingArguments = $true)][string[]]$Inconnus = @()
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# Nom de l'outil (même constante que NOM_INSTALLATION de cli/commun.ts).
$NOM = 'Vaevia'
$NODE_MIN = 24
$RACINE = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PRINCIPAL = Join-Path $RACINE 'serveur\src\principal.ts'
$LIEN_TS = Join-Path $RACINE 'serveur\src\lien.ts'
$RESTAURER_TS = Join-Path $RACINE 'serveur\src\restaurer.ts'
$CLI = Join-Path $RACINE 'cli'
$LANCER = '"' + (Join-Path $RACINE 'installer.cmd') + '"'
$CLE_ENVIRONNEMENT = 'HKCU:\Environment'
$RACCOURCI = "$NOM (serveur).lnk"
$POWERSHELL = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$UTF8 = New-Object System.Text.UTF8Encoding $false
$LIEN_VALIDE = '^https?://[^\s/]+/invitation/[A-Za-z0-9_-]{20,100}$'
$SKILL_SOURCE = Join-Path $RACINE 'methode\integrations\claude\SKILL.md'
$SKILL_RELATIF = 'skills\site-retours-outil\SKILL.md' # relatif au dossier .claude de l'utilisateur

class ErreurUsage : System.Exception { ErreurUsage([string]$m) : base($m) { } }
class Echec : System.Exception { Echec([string]$m) : base($m) { } }

# --- Affichage ----------------------------------------------------------------------------------------------------
function Ecrire-Etape([string]$etat, [string]$texte) {
	switch ($etat) {
		'ok' { Write-Host "✓ $texte" -ForegroundColor Green }
		'sans' { Write-Host "– $texte" -ForegroundColor DarkGray }
		default { Write-Host "✗ $texte" -ForegroundColor Red }
	}
}
function Ecrire-Info([string]$texte) { Write-Host "  $texte" }
function Ecrire-Avertissement([string]$texte) { Write-Host "  ! $texte" -ForegroundColor Yellow }

# Question O/N. -Oui : la réponse par défaut ; -Essai : jamais de question (réponse par défaut).
function Demander([string]$question, [bool]$defaut) {
	if ($Oui -or $Essai) { return $defaut }
	$choix = if ($defaut) { '(O/n)' } else { '(o/N)' }
	try { $r = Read-Host "  $question $choix" } catch { return $defaut }
	$r = "$r".Trim().ToLowerInvariant()
	if ($r -eq '') { return $defaut }
	return ($r -eq 'o' -or $r -eq 'oui' -or $r -eq 'y' -or $r -eq 'yes')
}

# --- Chemins ------------------------------------------------------------------------------------------------------
function Chemin-Complet([string]$p) {
	return [IO.Path]::GetFullPath([IO.Path]::Combine((Get-Location -PSProvider FileSystem).ProviderPath, $p)).TrimEnd('\')
}
function Est-Dans([string]$chemin, [string]$dossier) {
	$c = $chemin.TrimEnd('\'); $d = $dossier.TrimEnd('\')
	return ($c -ieq $d) -or $c.StartsWith($d + '\', [StringComparison]::OrdinalIgnoreCase)
}
function Ecrire-Texte([string]$fichier, [string]$texte) { [IO.File]::WriteAllText($fichier, $texte, $UTF8) }
# Chemin réel (jonctions, liens symboliques, lecteurs subst, noms courts), résolu comme le fait le serveur
# (realpathSync.native dans serveur/src/config.ts) : par Node, sur le plus long ancêtre existant, la suite (qui n'existe
# pas encore) ajoutée telle quelle. Sans Node, ou en cas d'échec : le chemin complet seul.
function Chemin-Reel([string]$p) {
	$p = Chemin-Complet $p
	$ancetre = $p; $suite = ''
	while ($ancetre -and -not (Test-Path -LiteralPath $ancetre)) {
		$feuille = Split-Path -Leaf $ancetre
		$suite = if ($suite) { $feuille + '\' + $suite } else { $feuille }
		$ancetre = Split-Path -Parent $ancetre
	}
	$node = Trouver-Programme 'node'
	if (-not $ancetre -or -not $node) { return $p }
	try { $r = Lancer-Programme $node @('-e', 'process.stdout.write(require("fs").realpathSync.native(process.argv[1]))', $ancetre) } catch { return $p }
	if ($r.Code -ne 0 -or -not $r.Sortie) { return $p }
	$reel = $r.Sortie.TrimEnd('\')
	if ($suite) { return $reel + '\' + $suite }
	return $reel
}
# Dans le dépôt de l'outil, par le chemin donné ou par son chemin réel (une jonction vers le dépôt ne passe pas).
$script:RacineReelle = ''
function Est-DansDepot([string]$chemin) {
	if (Est-Dans (Chemin-Complet $chemin) $RACINE) { return $true }
	if (-not $script:RacineReelle) { $script:RacineReelle = Chemin-Reel $RACINE }
	$reel = Chemin-Reel $chemin
	return (Est-Dans $reel $script:RacineReelle) -or (Est-Dans $reel $RACINE)
}


# --- Programmes ---------------------------------------------------------------------------------------------------
# Argument pour la ligne de commande Windows (règles de CommandLineToArgvW).
function Format-Argument([string]$a) {
	if ($a -ne '' -and $a -notmatch '[\s"]') { return $a }
	$b = $a -replace '(\\*)"', '$1$1\"'
	$b = $b -replace '(\\+)$', '$1$1'
	return '"' + $b + '"'
}
# Lance un programme et attend sa fin ; sorties lues en UTF-8. Sans passer par les flux de PowerShell : une ligne sur
# la sortie d'erreur n'y devient pas une erreur (5.1, $ErrorActionPreference = 'Stop').
function Lancer-Programme([string]$exe, [string[]]$arguments) {
	$psi = New-Object System.Diagnostics.ProcessStartInfo
	$psi.FileName = $exe
	$psi.Arguments = (@($arguments | ForEach-Object { Format-Argument $_ }) -join ' ')
	$psi.UseShellExecute = $false
	$psi.CreateNoWindow = $true
	$psi.RedirectStandardOutput = $true
	$psi.RedirectStandardError = $true
	$psi.StandardOutputEncoding = $UTF8
	$psi.StandardErrorEncoding = $UTF8
	$psi.WorkingDirectory = $RACINE
	$p = [System.Diagnostics.Process]::Start($psi)
	$sortie = $p.StandardOutput.ReadToEndAsync()
	$erreurs = $p.StandardError.ReadToEndAsync()
	$p.WaitForExit()
	return [pscustomobject]@{ Code = $p.ExitCode; Sortie = $sortie.Result; Erreurs = $erreurs.Result }
}
function Trouver-Programme([string]$nom) {
	$c = Get-Command $nom -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
	if ($c) { return $c.Source }
	return $null
}
# Node ≥ 24 : rend le chemin de node.exe, ou $null (absent ou trop ancien ; $script:VersionNode dit laquelle).
$script:VersionNode = ''
function Trouver-Node {
	# Étape 3.9, A7 : le Node livré dans le paquet hors ligne (<dépôt>\node\node.exe) passe avant celui du PATH : sur un
	# réseau isolé, ni winget ni téléchargement.
	$livre = Join-Path $RACINE 'node\node.exe'
	$node = if (Test-Path -LiteralPath $livre -PathType Leaf) { $livre } else { Trouver-Programme 'node' }
	if (-not $node) { $script:VersionNode = ''; return $null }
	try { $v = (Lancer-Programme $node @('--version')).Sortie.Trim() } catch { $v = '' }
	$script:VersionNode = $v
	if ($v -match '^v(\d+)\.' -and [int]$Matches[1] -ge $NODE_MIN) { return $node }
	return $null
}
# PATH de ce processus relu depuis le registre (après winget, qui ne change que les nouveaux processus).
function Relire-Path {
	$m = [Environment]::GetEnvironmentVariable('Path', 'Machine')
	$u = [Environment]::GetEnvironmentVariable('Path', 'User')
	$env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}

# --- Ce que -Essai ne fait jamais : winget, PATH, Démarrage, navigateur (chacun passe par une seule fonction) -------
function Installer-Winget([string]$id) {
	if ($Essai) { return $false }
	$winget = Trouver-Programme 'winget'
	if (-not $winget) { return $false }
	# Lancé sans tube : avec « | Out-Host », une question de winget écrite sans fin de ligne (contrats de la source au
	# premier usage) restait invisible, fenêtre figée. Source « winget » seule, contrats acceptés : la personne vient de
	# répondre oui à « L'installer avec winget ? ». Rend $true si winget a réussi (code 0).
	try {
		$p = Start-Process -FilePath $winget -ArgumentList @('install', '--id', $id, '-e', '--source', 'winget', '--accept-source-agreements', '--accept-package-agreements') -NoNewWindow -Wait -PassThru
		$code = $p.ExitCode
	} catch { Ecrire-Avertissement "winget : $($_.Exception.Message)"; $code = -1 }
	Relire-Path
	if ($null -ne $code -and $code -ne 0) { Ecrire-Avertissement ('winget a échoué (code 0x{0:X8})' -f [int]$code); return $false }
	return $true
}
# Rend $true si le navigateur a été lancé ; sinon, dit quoi ouvrir à la main ($sinon).
function Ouvrir-Navigateur([string]$url, [string]$sinon) {
	if ($Essai) { return $true }
	if ($url -notmatch '^https?://[^\s"]+$') { throw ([Echec]::new("adresse refusée pour le navigateur")) }
	try { Start-Process $url | Out-Null; return $true }
	catch { Ecrire-Avertissement "navigateur non ouvert ($($_.Exception.Message)) : $sinon"; return $false }
}
function Chemin-Raccourci {
	if ($Essai) { return $null }
	$demarrage = [Environment]::GetFolderPath('Startup')
	if (-not $demarrage) { return $null }
	return (Join-Path $demarrage $RACCOURCI)
}
function Creer-Raccourci([string]$chemin) {
	if ($Essai) { return }
	$shell = New-Object -ComObject WScript.Shell
	$r = $shell.CreateShortcut($chemin)
	$r.TargetPath = $POWERSHELL
	$r.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $PSCommandPath + '" -Demarrer -Oui'
	$r.WorkingDirectory = $RACINE
	$r.WindowStyle = 7
	$r.Description = "Démarre le serveur $NOM (installer.cmd -Demarrer)"
	$r.Save()
}
function Retirer-Raccourci {
	$c = Chemin-Raccourci
	if ($c -and (Test-Path -LiteralPath $c)) { Remove-Item -LiteralPath $c -Force; return $true }
	return $false
}
# PATH utilisateur ($CLE_ENVIRONNEMENT, valeur Path) lu brut : les %…% ne sont pas développés, et son type est gardé
# (REG_EXPAND_SZ sur un Windows neuf). [Environment]::SetEnvironmentVariable développerait tout et écrirait en REG_SZ ;
# setx tronque à 1024 caractères. Après écriture, WM_SETTINGCHANGE prévient l'Explorateur (nouveaux terminaux).
function Lire-PathUtilisateur {
	$cle = Get-Item -LiteralPath $CLE_ENVIRONNEMENT -ErrorAction SilentlyContinue
	if (-not $cle -or ($cle.GetValueNames() -notcontains 'Path')) { return [pscustomobject]@{ Valeur = ''; Type = 'ExpandString' } }
	return [pscustomobject]@{ Valeur = [string]$cle.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); Type = [string]$cle.GetValueKind('Path') }
}
function Ecrire-PathUtilisateur([string]$valeur, [string]$type) {
	if ($type -ne 'String') { $type = 'ExpandString' }
	Set-ItemProperty -LiteralPath $CLE_ENVIRONNEMENT -Name 'Path' -Value $valeur -Type $type
	Annoncer-Environnement
}
function Annoncer-Environnement {
	try {
		if (-not ('Wdd.Annonce' -as [type])) {
			Add-Type -Namespace 'Wdd' -Name 'Annonce' -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
		}
		$r = [UIntPtr]::Zero
		[void][Wdd.Annonce]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)
	} catch { Ecrire-Avertissement "PATH écrit, mais les programmes ouverts n'ont pas été prévenus ($($_.Exception.Message)) : fermer la session pour qu'il vaille partout" }
}
function Entrees-PathUtilisateur { return @((Lire-PathUtilisateur).Valeur -split ';' | Where-Object { $_ -ne '' }) }
function Est-EntreeCli([string]$e) { return [Environment]::ExpandEnvironmentVariables($e.Trim()).TrimEnd('\') -ieq $CLI }
function Cli-DansPath { return [bool](@(Entrees-PathUtilisateur | Where-Object { Est-EntreeCli $_ }).Count) }
function Ajouter-CliPath {
	if ($Essai) { return }
	$p = Lire-PathUtilisateur
	$v = $p.Valeur
	$nouveau = if (-not $v) { $CLI } elseif ($v.EndsWith(';')) { $v + $CLI } else { $v + ';' + $CLI }
	Ecrire-PathUtilisateur $nouveau $p.Type
	# Retenu pour -Desinstaller : une entrée que l'utilisateur avait mise lui-même n'est jamais retirée.
	Ecrire-Texte $FICHIER_PATH_AJOUTE "$CLI`r`n"
}
# Rend 'retire', 'absent' (ajoutée par l'installeur, mais plus là), 'pas-ajoute' (laissée), ou 'essai'.
function Retirer-CliPath {
	if ($Essai) { return 'essai' }
	if (-not (Test-Path -LiteralPath $FICHIER_PATH_AJOUTE)) { return 'pas-ajoute' }
	$p = Lire-PathUtilisateur
	$avant = @($p.Valeur -split ';')
	$apres = @($avant | Where-Object { -not (Est-EntreeCli $_) })
	$r = 'absent'
	if ($apres.Count -ne $avant.Count) { Ecrire-PathUtilisateur ($apres -join ';') $p.Type; $r = 'retire' }
	Remove-Item -LiteralPath $FICHIER_PATH_AJOUTE -Force -ErrorAction SilentlyContinue
	return $r
}

# --- Raccourci Claude Code (skill utilisateur site-retours-outil) -------------------------------------------------
# Dossier .claude de l'utilisateur : <-Profil>\.claude en -Essai (rien sans -Profil), %USERPROFILE%\.claude sinon ;
# $null s'il n'y a pas de base. Qu'il existe ou non, c'est à l'appelant de le voir.
function Dossier-Claude {
	if ($Essai) { if (-not $Profil) { return $null }; return (Join-Path (Chemin-Complet $Profil) '.claude') }
	if (-not $env:USERPROFILE) { return $null }
	return (Join-Path $env:USERPROFILE '.claude')
}
function Empreinte([string]$f) { return [string](Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash }
# claude-skill.txt : « <SHA-256 de la copie posée> » puis « <chemin> ». Rend l'empreinte retenue pour ce chemin, ou ''.
function Empreinte-Posee([string]$cible) {
	if (-not (Test-Path -LiteralPath $FICHIER_SKILL_POSE)) { return '' }
	try { $l = @([IO.File]::ReadAllLines($FICHIER_SKILL_POSE, $UTF8)) } catch { return '' }
	if ($l.Count -ge 2 -and $l[0] -match '^[0-9A-F]{64}$' -and $l[1] -ieq $cible) { return $l[0] }
	return ''
}
# Copie octet pour octet (jamais Get-Content / Set-Content, qui réencodent sous 5.1), puis empreinte retenue.
function Copier-Skill([string]$cible) {
	[void](New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cible))
	[IO.File]::Copy($SKILL_SOURCE, $cible, $true)
	Ecrire-Texte $FICHIER_SKILL_POSE "$(Empreinte $cible)`r`n$cible`r`n"
}
# Étape de l'installation : une ligne « ✓ » (posé, déjà à jour) ou « – » (sans objet, non demandé, laissé tel quel).
# $script:SkillPresent : le chemin de la copie quand elle est celle de l'outil (posée, à jour ou mise à jour), pour la
# ligne du résumé : même nom que la copie d'un dépôt (outil installer), elle passe avant elle dans Claude Code.
$script:SkillPresent = ''
function Poser-SkillClaude {
	if ($Essai -and -not $Profil) { Ecrire-Etape 'sans' 'Raccourci Claude Code : sans objet (-Essai sans -Profil)'; return }
	$dossier = Dossier-Claude
	if (-not $dossier -or -not (Test-Path -LiteralPath $dossier -PathType Container)) {
		Ecrire-Etape 'sans' "Raccourci Claude Code : sans objet (pas de dossier $(if ($dossier) { $dossier } else { '%USERPROFILE%\.claude' }))"
		return
	}
	if (-not (Test-Path -LiteralPath $SKILL_SOURCE)) { Ecrire-Etape 'sans' "Raccourci Claude Code : modèle introuvable ($SKILL_SOURCE)"; return }
	$cible = Join-Path $dossier $SKILL_RELATIF
	if (-not (Test-Path -LiteralPath $cible)) {
		if (Demander "Ajouter le raccourci Claude Code (skill site-retours-outil, $cible) ?" $true) { Copier-Skill $cible; $script:SkillPresent = $cible; Ecrire-Etape 'ok' "Raccourci Claude Code : $cible" }
		else { Ecrire-Etape 'sans' 'Raccourci Claude Code : non demandé' }
		return
	}
	$actuelle = Empreinte $cible
	if ($actuelle -eq (Empreinte $SKILL_SOURCE)) {
		# Déjà identique : l'empreinte n'est retenue que si c'est déjà la nôtre (un fichier posé par l'utilisateur reste à lui).
		if (Empreinte-Posee $cible) { Ecrire-Texte $FICHIER_SKILL_POSE "$actuelle`r`n$cible`r`n" }
		$script:SkillPresent = $cible
		Ecrire-Etape 'ok' "Raccourci Claude Code : $cible déjà à jour"
		return
	}
	# Une copie posée par l'installeur et pas modifiée depuis : mise à jour proposée (oui par défaut). Tout autre fichier
	# différent : remplacé seulement sur un « oui » explicite.
	if ((Empreinte-Posee $cible) -eq $actuelle) { $q = "Mettre à jour le raccourci Claude Code ($cible) ?"; $defaut = $true }
	else { $q = "$cible existe et diffère de celui de l'outil : le remplacer ?"; $defaut = $false }
	if (Demander $q $defaut) { Copier-Skill $cible; $script:SkillPresent = $cible; Ecrire-Etape 'ok' "Raccourci Claude Code : $cible mis à jour" }
	else { Ecrire-Etape 'sans' "Raccourci Claude Code : $cible différent de celui de l'outil, laissé tel quel" }
}
# -Desinstaller : retire la copie seulement si elle est identique à celle qui a été posée (claude-skill.txt), puis son
# dossier s'il est vide. Une copie modifiée est laissée (et l'empreinte gardée).
function Retirer-SkillClaude {
	if ($Essai -and -not $Profil) { Ecrire-Etape 'sans' 'Raccourci Claude Code : sans objet (-Essai sans -Profil)'; return }
	$dossier = Dossier-Claude
	if (-not $dossier) { Ecrire-Etape 'sans' 'Raccourci Claude Code : sans objet (USERPROFILE non défini)'; return }
	$cible = Join-Path $dossier $SKILL_RELATIF
	$posee = Empreinte-Posee $cible
	if (-not (Test-Path -LiteralPath $cible)) {
		if ($posee) { Remove-Item -LiteralPath $FICHIER_SKILL_POSE -Force -ErrorAction SilentlyContinue }
		Ecrire-Etape 'sans' 'Raccourci Claude Code : absent'
		return
	}
	if (-not $posee) { Ecrire-Etape 'sans' "Raccourci Claude Code : $cible n'a pas été posé par l'installeur, laissé tel quel"; return }
	if ((Empreinte $cible) -ne $posee) { Ecrire-Etape 'sans' "Raccourci Claude Code : $cible modifié depuis sa pose, laissé tel quel"; return }
	Remove-Item -LiteralPath $cible -Force
	$parent = Split-Path -Parent $cible
	if (-not @(Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue).Count) { Remove-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue }
	Remove-Item -LiteralPath $FICHIER_SKILL_POSE -Force -ErrorAction SilentlyContinue
	Ecrire-Etape 'ok' "Raccourci Claude Code : $cible retiré"
}


# --- Réseau -------------------------------------------------------------------------------------------------------
function Tester-Sante([int]$p) {
	try {
		$req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$p/api/sante")
		$req.Proxy = $null
		$req.Timeout = 2000
		$req.ReadWriteTimeout = 2000
		$rep = $req.GetResponse()
		try {
			$lecteur = New-Object System.IO.StreamReader($rep.GetResponseStream())
			$texte = $lecteur.ReadToEnd()
			return ([int]$rep.StatusCode -eq 200) -and ($texte -match '"ok"\s*:\s*true')
		} finally { $rep.Close() }
	} catch { return $false }
}
# Port libre : personne n'y répond sur 127.0.0.1, et on peut l'y ouvrir. (Pas d'essai d'écoute sur 0.0.0.0 : le
# pare-feu de Windows ouvrirait une fenêtre pour powershell.exe.)
function Port-Libre([int]$p) {
	$client = New-Object System.Net.Sockets.TcpClient
	try {
		$essai = $client.BeginConnect('127.0.0.1', $p, $null, $null)
		if ($essai.AsyncWaitHandle.WaitOne(300) -and $client.Connected) { return $false }
	} catch { } finally { $client.Close() }
	$ecoute = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $p)
	try { $ecoute.Start(); return $true } catch { return $false } finally { try { $ecoute.Stop() } catch { } }
}
function Url-Installation([int]$p, [bool]$reseau) {
	if ($reseau) { return "http://$([System.Net.Dns]::GetHostName().ToLowerInvariant()):$p" }
	return "http://127.0.0.1:$p"
}
function Url-Bouclage([string]$url) { return $url -match '^http://(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$' }

# --- État de l'installation -----------------------------------------------------------------------------------------
function Lire-Installation {
	if (-not (Test-Path -LiteralPath $FICHIER_INSTALLATION)) { return $null }
	try {
		$o = [IO.File]::ReadAllText($FICHIER_INSTALLATION, $UTF8).TrimStart([char]0xFEFF) | ConvertFrom-Json
		if (-not $o.donnees -or -not $o.url -or -not $o.port) { throw "champs manquants" }
		return [pscustomobject]@{ outil = [string]$o.outil; donnees = [string]$o.donnees; port = [int]$o.port; url = [string]$o.url }
	} catch {
		Ecrire-Avertissement "$FICHIER_INSTALLATION illisible ($($_.Exception.Message)) : ignoré"
		return $null
	}
}
function Ecrire-Installation($inst) {
	$o = [ordered]@{ outil = $inst.outil; donnees = $inst.donnees; port = $inst.port; url = $inst.url }
	Ecrire-Texte $FICHIER_INSTALLATION (($o | ConvertTo-Json) + "`r`n")
}
# serveur.pid : « <PID> <heure de démarrage en ticks UTC> » ; rend {Id, Debut}, ou $null (absent, illisible, ancien
# format sans l'heure : jamais pris pour le nôtre).
function Lire-Pid {
	if (-not (Test-Path -LiteralPath $FICHIER_PID)) { return $null }
	$t = [IO.File]::ReadAllText($FICHIER_PID).Trim()
	if ($t -match '^(\d{1,10}) (\d{1,19})$') { return [pscustomobject]@{ Id = [int]$Matches[1]; Debut = [long]$Matches[2] } }
	return $null
}
function Ecrire-Pid($p) { Ecrire-Texte $FICHIER_PID "$($p.Id) $($p.Debut)`r`n" }
# Heure de démarrage d'un processus (ticks UTC) ; 0 si illisible.
function Debut-Processus($proc) { try { return [long]$proc.StartTime.ToUniversalTime().Ticks } catch { return [long]0 } }
# Le processus {Id, Debut} existe et c'est bien le nôtre : même PID et même heure de démarrage (un PID repris par un
# autre programme n'a pas la même), et sa ligne de commande contient principal.ts de ce dépôt (node), ou la ligne de
# lancement de Lancer-Serveur (le cmd qui lance node, si node n'a pas été trouvé à temps). Dans le doute (ligne de
# commande illisible, WMI en échec) : pas le nôtre, donc jamais attendu ni arrêté.
function Pid-Vivant($p) {
	if (-not $p -or $p.Id -le 0 -or $p.Debut -le 0) { return $false }
	$proc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
	if (-not $proc -or (Debut-Processus $proc) -ne $p.Debut) { return $false }
	try { $w = Get-CimInstance Win32_Process -Filter "ProcessId=$($p.Id)" -ErrorAction Stop | Select-Object -First 1 } catch { return $false }
	if (-not $w -or -not $w.CommandLine) { return $false }
	$ligne = [string]$w.CommandLine
	if ($proc.ProcessName -ieq 'node') { return $ligne.IndexOf($PRINCIPAL, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
	if ($proc.ProcessName -ieq 'cmd') { return $ligne.IndexOf('%WDD_I_PRINCIPAL%', [StringComparison]::OrdinalIgnoreCase) -ge 0 }
	return $false
}
# Serveur qui tient le verrou du dossier des données (<données>\serveur.verrou, serveur/src/verrou.ts) : {Id, Port}, ou
# $null. Seulement s'il est vraisemblablement vivant : PID présent, pas démarré après le verrou (PID repris), et un
# serveur répond à /api/sante sur le port du verrou. Sinon (verrou laissé par taskkill /F, un arrêt de Windows...), le
# serveur lancé juge lui-même et reprend le verrou périmé ; un refus de sa part se voit à l'attente (journal).
function Serveur-DesDonnees([string]$dossier) {
	$f = Join-Path $dossier 'serveur.verrou'
	if (-not (Test-Path -LiteralPath $f)) { return $null }
	try {
		$v = [IO.File]::ReadAllText($f, $UTF8) | ConvertFrom-Json
		$id = [int]$v.pid; $port = [string]$v.port; $debut = [string]$v.debut
	} catch { return $null }
	if ($id -le 0) { return $null }
	$proc = Get-Process -Id $id -ErrorAction SilentlyContinue
	if (-not $proc) { return $null }
	$debutProc = Debut-Processus $proc
	$debutVerrou = [DateTime]::MinValue
	if ($debutProc -gt 0 -and [DateTime]::TryParse($debut, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AdjustToUniversal, [ref]$debutVerrou)) {
		if ($debutProc -gt $debutVerrou.AddSeconds(30).Ticks) { return $null }
	}
	if ($port -notmatch '^\d{1,5}$' -or [int]$port -lt 1 -or [int]$port -gt 65535 -or -not (Tester-Sante ([int]$port))) { return $null }
	return [pscustomobject]@{ Id = $id; Port = $port }

}
# Refuse (✗, rend $true) un dossier de données servi par un autre serveur que celui de cette installation : deux
# serveurs sur les mêmes données écriraient tous deux dans la base et les dépôts de design.
function Refuser-DonneesServies([string]$dossier, [string]$etiquette) {
	$autre = Serveur-DesDonnees $dossier
	if (-not $autre) { return $false }
	$notre = Lire-Pid
	if ($notre -and $notre.Id -eq $autre.Id -and (Pid-Vivant $notre)) { return $false }
	Ecrire-Etape 'echec' "$etiquette : un serveur utilise déjà ce dossier de données (PID $($autre.Id), port $($autre.Port)) : l'arrêter d'abord"
	Ecrire-Info "Dossier : $dossier. Deux serveurs sur les mêmes données se gêneraient (base, dépôts de design)."
	Ecrire-Info "Si aucun serveur ne tourne avec ces données, supprimer $(Join-Path $dossier 'serveur.verrou')."
	return $true
}
# Accès ouverts aux autres comptes du poste (Tout le monde, Utilisateurs authentifiés, Utilisateurs, Invités) :
# avertissement seulement. lien-admin.txt y donne les droits d'admin, outil.sqlite y garde comptes et sessions.
function Avertir-AccesOuverts([string]$dossier) {
	try { $acl = Get-Acl -LiteralPath $dossier } catch { return }
	$ouverts = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', 'S-1-5-32-546')
	$noms = @()
	foreach ($r in @($acl.Access)) {
		if ([string]$r.AccessControlType -ne 'Allow') { continue }
		try { $sid = $r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { continue }
		if ($ouverts -contains $sid -and $noms -notcontains [string]$r.IdentityReference) { $noms += [string]$r.IdentityReference }
	}
	if (-not $noms.Count) { return }
	$moi = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
	Ecrire-Avertissement "le dossier des données est ouvert à d'autres comptes de ce poste ($($noms -join ', ')) : ils pourraient lire lien-admin.txt (droits d'admin) et la base."
	Ecrire-Avertissement "Pour le réserver à ton compte (et à SYSTEM, aux administrateurs) : icacls `"$dossier`" /inheritance:r /grant:r *$($moi):(OI)(CI)F *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F"
}

# --- Serveur --------------------------------------------------------------------------------------------------------
# Arrière-plan, sans fenêtre : cmd.exe caché lance node, sortie et erreurs ajoutées au journal (une seule redirection
# possible par fichier avec Start-Process : cmd fait « >> journal 2>&1 »). Le PID écrit est celui du node.exe enfant
# (celui qui écoute) ; à défaut de le trouver, celui de cmd (l'arrêt prend tout l'arbre).
function Avertir-Reseau([string]$url) {
	Ecrire-Avertissement "-Reseau : écoute sur 0.0.0.0 ($url). HTTP en clair, l'administration et les pages sur la même origine : seulement sur un réseau de confiance."
	Ecrire-Avertissement "Aucune règle de pare-feu n'est créée : elle peut être nécessaire pour les autres postes (Windows peut demander d'autoriser node.exe)."
}
function Lancer-Serveur($inst, [string]$node) {
	$hote = if (Url-Bouclage $inst.url) { '127.0.0.1' } else { '0.0.0.0' }
	$entete = "`r`n=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') : démarrage par installer.ps1 (port $($inst.port), écoute $hote) ===`r`n"
	if ($hote -eq '0.0.0.0') { $entete += "=== -Reseau : écoute sur le réseau ($($inst.url)), en HTTP clair ; repris à chaque démarrage tant que l'installation n'est pas refaite sans -Reseau ===`r`n" }
	try { [IO.File]::AppendAllText($JOURNAL, $entete, $UTF8) }
	catch [System.IO.IOException] { throw ([Echec]::new("journal $JOURNAL inaccessible ($($_.Exception.Message)) : un autre serveur l'utilise sans doute encore ; l'arrêter d'abord ($LANCER -Arreter)")) }
	$sauve = @{}
	foreach ($v in @(Get-ChildItem Env: | Where-Object { $_.Name -like 'WDD_*' })) { $sauve[$v.Name] = $v.Value; Remove-Item -LiteralPath "Env:$($v.Name)" }
	try {
		$env:WDD_DONNEES = $inst.donnees
		$env:WDD_PORT = [string]$inst.port
		$env:WDD_HOTE = $hote
		if ($hote -eq '0.0.0.0') { $env:WDD_URL = $inst.url }
		# Aucun chemin littéral dans la ligne de cmd : il y développerait les %…% (journal « a%OS%b » écrit dans
		# « aWindows_NTb »). Les chemins passent par des variables, que cmd ne développe qu'une fois, sans relire les %
		# de leur valeur ; /v:off : pas de « !…! » non plus.
		$env:WDD_I_NODE = $node
		$env:WDD_I_PRINCIPAL = $PRINCIPAL
		$env:WDD_I_JOURNAL = $JOURNAL
		$ligne = '/d /v:off /s /c ""%WDD_I_NODE%" "%WDD_I_PRINCIPAL%" >>"%WDD_I_JOURNAL%" 2>&1"'
		$cmd = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList $ligne -WorkingDirectory $RACINE -WindowStyle Hidden -PassThru
	} finally {
		foreach ($n in @('WDD_DONNEES', 'WDD_PORT', 'WDD_HOTE', 'WDD_URL', 'WDD_I_NODE', 'WDD_I_PRINCIPAL', 'WDD_I_JOURNAL')) { Remove-Item -LiteralPath "Env:$n" -ErrorAction SilentlyContinue }
		foreach ($k in $sauve.Keys) { Set-Item -LiteralPath "Env:$k" -Value $sauve[$k] }
	}
	$p = [pscustomobject]@{ Id = $cmd.Id; Debut = (Debut-Processus $cmd) }
	for ($i = 0; $i -lt 50; $i++) {
		try {
			$enfant = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($cmd.Id) AND Name='node.exe'" -ErrorAction Stop | Select-Object -First 1
		} catch { $enfant = $null; break }
		if ($enfant) {
			$proc = Get-Process -Id ([int]$enfant.ProcessId) -ErrorAction SilentlyContinue
			if ($proc) { $p = [pscustomobject]@{ Id = [int]$enfant.ProcessId; Debut = (Debut-Processus $proc) } }
			break
		}
		if ($cmd.HasExited) { break }
		Start-Sleep -Milliseconds 100
	}
	Ecrire-Pid $p
	return $p
}
function Arreter-Pid($p) {
	if (-not (Pid-Vivant $p)) { return $false }
	$taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
	[void](Lancer-Programme $taskkill @('/PID', [string]$p.Id, '/T', '/F'))
	for ($i = 0; $i -lt 50 -and (Pid-Vivant $p); $i++) { Start-Sleep -Milliseconds 100 }
	if (Pid-Vivant $p) { throw ([Echec]::new("le serveur (PID $($p.Id)) ne s'arrête pas")) }
	return $true
}
# Fin du journal, lue en UTF-8 ; hors -Essai, les liens d'invitation y sont masqués.
function Montrer-Journal {
	if (-not (Test-Path -LiteralPath $JOURNAL)) { return }
	Ecrire-Info "Fin du journal ($JOURNAL) :"
	foreach ($l in @(Get-Content -LiteralPath $JOURNAL -Encoding UTF8 -Tail 20)) {
		if (-not $Essai) { $l = $l -replace '/invitation/[A-Za-z0-9_-]+', '/invitation/…(masqué)' }
		Write-Host "    $l"
	}
}
# Attente de /api/sante : 30 s au plus, abandon dès que notre processus est mort (un autre serveur sur ce port ne
# donne pas un faux « prêt »). Rend 'ok', 'mort' (arrêté, ou jamais lancé) ou 'delai'.
function Attendre-Sante($inst, $p) {
	$fin = (Get-Date).AddSeconds(30)
	while ((Get-Date) -lt $fin) {
		if (-not (Pid-Vivant $p)) { return 'mort' }
		if (Tester-Sante $inst.port) { if (Pid-Vivant $p) { return 'ok' } else { return 'mort' } }
		Start-Sleep -Milliseconds 300
	}
	return 'delai'
}
# Dernière modification du code que le serveur exécute (serveur/src, serveur/ui, site), en ticks UTC ; 0 si illisible.
function Date-Code {
	$max = [long]0
	foreach ($d in @('serveur\src', 'serveur\ui', 'site')) {
		$dir = Join-Path $RACINE $d
		if (-not (Test-Path -LiteralPath $dir)) { continue }
		foreach ($f in @(Get-ChildItem -LiteralPath $dir -Recurse -File -ErrorAction SilentlyContinue)) { $t = [long]$f.LastWriteTimeUtc.Ticks; if ($t -gt $max) { $max = $t } }
	}
	return $max
}
# Démarre le serveur de l'installation s'il ne tourne pas ; rend $true s'il répond. Ne touche ni au port ni au fichier.
# Un serveur qui tourne sur un code plus ancien que le dépôt (mise à jour de l'outil depuis son démarrage) est redémarré
# si l'on accepte (oui par défaut) : sinon il garde l'ancien comportement jusqu'au prochain démarrage.
function Assurer-Serveur($inst, [string]$node, [string]$etiquette) {
	$p = Lire-Pid
	if ((Pid-Vivant $p) -and (Tester-Sante $inst.port)) {
		$code = Date-Code
		if ($code -le $p.Debut) {
			Ecrire-Etape 'sans' "$etiquette : le serveur tourne déjà (PID $($p.Id)), pas relancé"
			return $true
		}
		$quand = ([DateTime]::new($code, [DateTimeKind]::Utc)).ToLocalTime().ToString('dd/MM/yyyy HH:mm')
		Ecrire-Avertissement "le serveur (PID $($p.Id)) a démarré avant la dernière mise à jour de l'outil ($quand) : il exécute l'ancien code"
		if (-not (Demander 'Redémarrer le serveur maintenant ?' $true)) {
			Ecrire-Etape 'sans' "$etiquette : le serveur tourne déjà (PID $($p.Id)), pas relancé (ancien code ; $LANCER -Arreter puis $LANCER -Demarrer pour le mettre à jour)"
			return $true
		}
		if (-not (Arreter-Pid $p)) { Ecrire-Etape 'echec' "$etiquette : le serveur (PID $($p.Id)) ne s'arrête pas"; return $false }
		Remove-Item -LiteralPath $FICHIER_PID -Force -ErrorAction SilentlyContinue
		# Étape 3.9, A4 : sauvegarde avant de relancer sur le nouveau code (la base peut être montée de version au démarrage).
		$s = $null
		try { $s = Lancer-Programme $node @((Join-Path $RACINE 'serveur\src\sauvegarde.ts'), $inst.donnees) } catch { $s = $null }
		if ($s -and $s.Code -eq 0) { Ecrire-Etape 'ok' "Sauvegarde avant mise à jour : $(($s.Sortie.Trim() -split "`n")[-1])" }
		else { Ecrire-Avertissement "sauvegarde avant mise à jour impossible : $(if ($s) { ($s.Erreurs + $s.Sortie).Trim() } else { 'node introuvable' }) ; le serveur est relancé quand même (la sauvegarde planifiée reste active)" }
		Ecrire-Etape 'ok' "$etiquette : ancien serveur arrêté (PID $($p.Id)), relancé avec le code à jour"
	}
	if (Pid-Vivant $p) {
		# Le nôtre, mais muet : peut-être en train de démarrer.
		if ((Attendre-Sante $inst $p) -eq 'ok') { Ecrire-Etape 'sans' "$etiquette : le serveur tourne déjà (PID $($p.Id)), pas relancé"; return $true }
		Ecrire-Avertissement "le serveur (PID $($p.Id)) ne répond pas : arrêté puis relancé"
		[void](Arreter-Pid $p)
	}
	if (Refuser-DonneesServies $inst.donnees $etiquette) { return $false }
	if (-not (Port-Libre $inst.port)) {
		Ecrire-Etape 'echec' "$etiquette : le port $($inst.port) est pris par un autre programme"
		Ecrire-Info "Libère-le, ou réinstalle sur un autre port : $LANCER -Port <n>"
		return $false
	}
	$p = Lancer-Serveur $inst $node
	Ecrire-Etape 'ok' "$etiquette : serveur lancé en arrière-plan (PID $($p.Id)), journal $JOURNAL"
	return $null # lancé, pas encore attendu
}
function Attente-Etape($inst) {
	$p = Lire-Pid
	$r = Attendre-Sante $inst $p
	if ($r -eq 'ok') { Ecrire-Etape 'ok' "Attente : le serveur répond ($($inst.url))"; return $true }
	if ($r -eq 'mort') { Ecrire-Etape 'echec' "Attente : le serveur s'est arrêté au démarrage (voir le journal ci-dessous)" }
	else { Ecrire-Etape 'echec' "Attente : le serveur ne répond pas après 30 s" }
	Montrer-Journal
	if (Pid-Vivant $p) { [void](Arreter-Pid $p) }
	Remove-Item -LiteralPath $FICHIER_PID -Force -ErrorAction SilentlyContinue
	return $false
}

function Lien-Fichier([string]$donnees) {
	$f = Join-Path $donnees 'lien-admin.txt'
	if (-not (Test-Path -LiteralPath $f)) { return $null }
	$l = ([IO.File]::ReadAllText($f, $UTF8) -split "`n")[0].Trim()
	if ($l -match $LIEN_VALIDE) { return $l }
	return $null
}

# --- Actions --------------------------------------------------------------------------------------------------------
function Exiger-Node {
	$node = Trouver-Node
	if ($node) { return $node }
	$quoi = if ($script:VersionNode) { "Node $($script:VersionNode) trop ancien" } else { 'Node introuvable dans le PATH' }
	throw ([Echec]::new("$quoi : Node $NODE_MIN ou plus est requis (installer.cmd sans option le propose)"))
}
function Exiger-Installation {
	$inst = Lire-Installation
	if (-not $inst) { throw ([Echec]::new("aucune installation dans $DOSSIER_ETAT : lancer d'abord $LANCER")) }
	if ($Essai -and $inst.port -eq 8080) { throw ([ErreurUsage]::new("-Essai : le port 8080 n'est jamais utilisé (installation.json en indique 8080)")) }
	return $inst
}

function Action-Installer {
	# 1. Prérequis
	$node = Trouver-Node
	$git = Trouver-Programme 'git'
	$prerequis = @(
		@{ ok = [bool]$node; nom = 'Node.js'; id = 'OpenJS.NodeJS'; lien = 'https://nodejs.org/fr/download' },
		@{ ok = [bool]$git; nom = 'Git'; id = 'Git.Git'; lien = 'https://git-scm.com/download/win' })
	foreach ($manque in $prerequis) {
		if ($manque.ok) { continue }
		$quoi = if ($manque.nom -eq 'Node.js' -and $script:VersionNode) { "Node.js $($script:VersionNode) trop ancien ($NODE_MIN ou plus)" } else { "$($manque.nom) introuvable dans le PATH" }
		$winget = if ($Essai) { $null } else { Trouver-Programme 'winget' }
		if ($winget -and (Demander "$quoi. L'installer avec « winget install --id $($manque.id) -e » ?" $true)) {
			if (-not (Installer-Winget $manque.id)) {
				Ecrire-Etape 'echec' "Prérequis : winget n'a pas installé $($manque.nom)"
				Ecrire-Info "Télécharger : $($manque.lien) ; puis relancer installer.cmd dans une nouvelle fenêtre."
				return 1
			}
		} else {
			Ecrire-Etape 'echec' "Prérequis : $quoi"
			Ecrire-Info "Télécharger : $($manque.lien) ; puis relancer installer.cmd dans une nouvelle fenêtre."
			return 1
		}
	}
	if (-not $node) { $node = Trouver-Node }
	if (-not $git) { $git = Trouver-Programme 'git' }
	if (-not $node -or -not $git) {
		Ecrire-Etape 'echec' "Prérequis : toujours introuvables après winget ; fermer cette fenêtre et relancer installer.cmd"
		foreach ($manque in $prerequis) {
			if (($manque.nom -eq 'Node.js' -and -not $node) -or ($manque.nom -eq 'Git' -and -not $git)) { Ecrire-Info "Sinon, télécharger $($manque.nom) : $($manque.lien)" }
		}
		return 1
	}
	Ecrire-Etape 'ok' "Prérequis : Node $($script:VersionNode), Git"

	# 2. Dossiers (rien n'est créé avant les refus : dépôt de l'outil, données servies par un autre serveur)
	$inst = Lire-Installation
	$donneesDir = if ($Donnees) { Chemin-Complet $Donnees } elseif ($inst) { $inst.donnees } else { Join-Path $DOSSIER_ETAT 'donnees' }
	if (Est-DansDepot $donneesDir) { throw ([ErreurUsage]::new("dossier des données ($donneesDir) dans le dépôt de l'outil ($RACINE) : choisir un dossier hors de ce dépôt")) }
	# Notre serveur tourne (PID vivant) : ni port ni données ne changent ; Assurer-Serveur vérifie /api/sante.
	$lance = [bool]($inst -and (Pid-Vivant (Lire-Pid)))
	if ($lance -and ($donneesDir -ine $inst.donnees)) {
		Ecrire-Etape 'echec' "Dossiers : le serveur de cette installation tourne avec $($inst.donnees)"
		Ecrire-Info "Pour changer de dossier de données : $LANCER -Arreter, puis relancer avec -Donnees."
		return 1
	}
	if (Refuser-DonneesServies $donneesDir 'Dossiers') { return 1 }
	$nouveau = -not (Test-Path -LiteralPath (Join-Path $donneesDir 'outil.sqlite'))
	[void](New-Item -ItemType Directory -Force -Path $donneesDir)
	Ecrire-Etape 'ok' "Dossiers : données $donneesDir$(if ($nouveau) { ' (nouveau)' } else { ' (existant)' })"
	Ecrire-Info "Journal : $JOURNAL ; installation : $FICHIER_INSTALLATION"
	Avertir-AccesOuverts $donneesDir

	# 3. Port
	if ($lance) {
		if ($PortN -and $PortN -ne $inst.port) {
			Ecrire-Etape 'echec' "Port : le serveur tourne déjà sur le port $($inst.port) ; $LANCER -Arreter, puis relancer avec -Port $PortN"
			return 1
		}
		$portChoisi = $inst.port
		Ecrire-Etape 'sans' "Port : $portChoisi (serveur déjà lancé)"
	} elseif ($PortN) {
		if (-not (Port-Libre $PortN)) { Ecrire-Etape 'echec' "Port : $PortN est pris par un autre programme"; return 1 }
		$portChoisi = $PortN
		Ecrire-Etape 'ok' "Port : $portChoisi"
	} elseif ($inst -and -not ($Essai -and $inst.port -eq 8080) -and (Port-Libre $inst.port)) {
		$portChoisi = $inst.port
		Ecrire-Etape 'ok' "Port : $portChoisi (celui de l'installation)"
	} else {
		$premier = if ($Essai) { 8081 } else { 8080 }
		$portChoisi = 0
		foreach ($p in $premier..8099) { if (Port-Libre $p) { $portChoisi = $p; break } }
		if (-not $portChoisi) { Ecrire-Etape 'echec' "Port : aucun port libre de $premier à 8099 ; relancer avec -Port <n>"; return 1 }
		Ecrire-Etape 'ok' "Port : $portChoisi"
	}
	$url = if ($lance) { $inst.url } else { Url-Installation $portChoisi ([bool]$Reseau) }
	if ($lance -and ([bool]$Reseau -eq (Url-Bouclage $inst.url))) { Ecrire-Avertissement "le serveur tourne déjà en $(if (Url-Bouclage $inst.url) { 'local' } else { 'réseau' }) : pour changer -Reseau, $LANCER -Arreter d'abord" }
	# installation.json n'est écrit qu'une fois le serveur prêt (étape 7) : un échec laisse l'ancien tel quel.
	$inst = [pscustomobject]@{ outil = $RACINE; donnees = $donneesDir; port = $portChoisi; url = $url }

	# 4. Démarrage
	if (-not (Url-Bouclage $url)) { Avertir-Reseau $url }
	$r = Assurer-Serveur $inst $node 'Démarrage'
	if ($r -eq $false) { return 1 }

	# 5. Démarrage avec Windows
	if ($Essai) { Ecrire-Etape 'sans' 'Démarrage avec Windows : sans objet (-Essai)' }
	else {
		$c = Chemin-Raccourci
		if (-not $c) { Ecrire-Etape 'sans' 'Démarrage avec Windows : dossier Démarrage introuvable' }
		elseif (Test-Path -LiteralPath $c) { Creer-Raccourci $c; Ecrire-Etape 'ok' "Démarrage avec Windows : raccourci déjà présent ($c)" }
		elseif (Demander 'Lancer le serveur au démarrage de Windows ?' $true) { Creer-Raccourci $c; Ecrire-Etape 'ok' "Démarrage avec Windows : raccourci $c" }
		else { Ecrire-Etape 'sans' 'Démarrage avec Windows : non demandé' }
	}

	# 6. CLI dans le PATH
	if ($Essai) { Ecrire-Etape 'sans' 'CLI dans le PATH : sans objet (-Essai)' }
	elseif (Cli-DansPath) { Ecrire-Etape 'ok' "CLI dans le PATH : $CLI déjà présent" }
	elseif (Demander "Ajouter la CLI « outil » ($CLI) au PATH de l'utilisateur ?" $true) { Ajouter-CliPath; Ecrire-Etape 'ok' "CLI dans le PATH : $CLI ajouté (pour les nouveaux terminaux)" }
	else { Ecrire-Etape 'sans' 'CLI dans le PATH : non demandé' }

	# 6 bis. Raccourci Claude Code (skill utilisateur ; jamais en -Essai sans -Profil)
	Poser-SkillClaude

	# 7. Attente, puis installation.json
	if (-not (Attente-Etape $inst)) { return 1 }
	Ecrire-Installation $inst

	# 8. Navigateur
	$lien = Lien-Fichier $donneesDir
	$fichierLien = Join-Path $donneesDir 'lien-admin.txt'
	if ($Essai) {
		Ecrire-Etape 'sans' 'Navigateur : sans objet (-Essai)'
		if ($lien) { Write-Host "Lien admin (-Essai) : $lien" } else { Write-Host "Accueil (-Essai) : $url/" }
	} elseif ($lien) {
		if (Ouvrir-Navigateur $lien "ouvre le lien écrit dans le fichier $fichierLien (à garder pour toi), ou relance $LANCER") {
			Ecrire-Etape 'ok' 'Navigateur : lien de création du compte admin ouvert (à garder pour toi : il donne les droits d''admin)'
		} else { Ecrire-Etape 'echec' "Navigateur : non ouvert ; le lien de création du compte admin est dans $fichierLien" }
	} else {
		if (Ouvrir-Navigateur "$url/" "ouvre $url/ dans ton navigateur") { Ecrire-Etape 'ok' "Navigateur : accueil ouvert ($url/)" }
		else { Ecrire-Etape 'echec' "Navigateur : non ouvert ; l'accueil est $url/" }
	}

	# 9. Résumé
	Write-Host ''
	Write-Host "Serveur : $url/"
	Ecrire-Info "Données : $donneesDir"
	Ecrire-Info "Journal : $JOURNAL"
	Ecrire-Info "Commandes, depuis une invite de commandes (cmd) ; dans PowerShell, mettre « & » devant (& $LANCER -Arreter) ; le double-clic sur installer.cmd ne prend pas d'option :"
	Ecrire-Info "  Arrêter : $LANCER -Arreter ; relancer : $LANCER -Demarrer"
	Ecrire-Info "  Restaurer une sauvegarde (Administration, bloc Sauvegarde) : $LANCER -Restaurer <dossier de la sauvegarde>"
	Ecrire-Info "  Lien admin perdu ou session expirée : $LANCER -Reconnecter"
	Ecrire-Info "  Désinstaller (les données sont gardées) : $LANCER -Desinstaller"
	Ecrire-Info "  Autre port, écoute réseau, autres données : $LANCER -Port <n> | -Reseau | -Donnees <dossier>"
	if (-not (Url-Bouclage $url)) {
		Ecrire-Avertissement "-Reseau : HTTP en clair, administration et pages sur la même origine ; règle de pare-feu peut-être nécessaire."
		Ecrire-Avertissement "-Reseau vaut aussi à chaque démarrage de Windows (raccourci) et à chaque -Demarrer. Pour revenir en local : $LANCER -Arreter, puis $LANCER sans -Reseau."
	}
	# Phrase à dire à son agent (Claude Code, Codex…), ouvert dans le dépôt du code : elle nomme la CLI et la commande
	# de départ. L'id du projet vient de l'Administration ; l'écran du projet donne la phrase complète.
	Write-Host ''
	Write-Host 'Brancher un dépôt de code : crée le projet (Administration), puis dis à ton agent, ouvert dans ce dépôt :'
	Ecrire-Info "« Branche ce dépôt sur le serveur de retours $url (projet <P>) avec la CLI outil : lance outil methode et suis le § 0 (si outil manque : $url/outil). »"
	Ecrire-Info "<P> : l'id du projet ; la phrase complète est sur l'écran du projet, bloc « Brancher un dépôt de code »."
	Ecrire-Info "Il faut la CLI outil dans le PATH du poste ($CLI ; dans un nouveau terminal après l'installation)."
	if ($script:SkillPresent) {
		Ecrire-Info "Raccourci Claude Code ($script:SkillPresent) : cette copie personnelle passe avant celle d'un dépôt branché (même nom, site-retours-outil) ; relance $LANCER après chaque mise à jour de l'outil pour la garder à jour."
	}
	return 0
}

function Action-Arreter {
	$p = Lire-Pid
	if (Arreter-Pid $p) { Ecrire-Etape 'ok' "Serveur arrêté (PID $($p.Id))" }
	else { Ecrire-Etape 'sans' 'Aucun serveur de cette installation ne tourne' }
	Remove-Item -LiteralPath $FICHIER_PID -Force -ErrorAction SilentlyContinue
	return 0
}

# Étape 3.7, A1 : arrêt, restauration (restaurer.ts vérifie tout avant d'écrire, garde les anciennes données à côté et
# les remet en place si le contrôle échoue), relance. Le serveur est relancé même après un échec (données d'avant).
function Action-Restaurer {
	$inst = Exiger-Installation
	$node = Exiger-Node
	$src = Chemin-Complet $Restaurer
	if (-not (Test-Path -LiteralPath (Join-Path $src 'manifeste.json'))) { Ecrire-Etape 'echec' "Restauration : $src n'est pas une sauvegarde (manifeste.json absent)"; return 1 }
	[void](Action-Arreter)
	if (Refuser-DonneesServies $inst.donnees 'Restauration') { return 1 }
	$r = Lancer-Programme $node @($RESTAURER_TS, $src, $inst.donnees)
	$texte = ("$($r.Sortie)$($r.Erreurs)").Trim()
	if ($r.Code -eq 0) { Ecrire-Etape 'ok' "Restauration : $($texte -replace '^OK ', '')" }
	else { Ecrire-Etape 'echec' "Restauration : $($texte -replace '^ÉCHEC ', '')" }
	$d = Action-Demarrer
	if ($r.Code -ne 0) { return 1 }
	return $d
}

function Action-Demarrer {
	$inst = Exiger-Installation
	$node = Exiger-Node
	# Une installation -Reseau se relance en réseau (raccourci du dossier Démarrage compris) : toujours le dire.
	if (-not (Url-Bouclage $inst.url)) { Avertir-Reseau $inst.url; Ecrire-Info "Pour revenir en local : $LANCER -Arreter, puis $LANCER sans -Reseau." }
	$r = Assurer-Serveur $inst $node 'Démarrage'
	if ($r -eq $false) { return 1 }
	if ($r -eq $null -and -not (Attente-Etape $inst)) { return 1 }
	Ecrire-Info "Serveur : $($inst.url)/"
	return 0
}

function Action-Desinstaller {
	$present = Test-Path -LiteralPath $FICHIER_INSTALLATION
	$inst = Lire-Installation
	[void](Action-Arreter)
	if ($Essai) { Ecrire-Etape 'sans' 'Démarrage avec Windows et PATH : sans objet (-Essai)' }
	else {
		if (Retirer-Raccourci) { Ecrire-Etape 'ok' 'Démarrage avec Windows : raccourci retiré' } else { Ecrire-Etape 'sans' 'Démarrage avec Windows : pas de raccourci' }
		switch (Retirer-CliPath) {
			'retire' { Ecrire-Etape 'ok' "PATH : $CLI retiré (pour les nouveaux terminaux)" }
			'absent' { Ecrire-Etape 'sans' "PATH : $CLI n'y était plus" }
			default { Ecrire-Etape 'sans' "PATH : $CLI n'a pas été ajouté par l'installeur, laissé tel quel" }
		}
	}
	Retirer-SkillClaude
	if ($present) {
		Remove-Item -LiteralPath $FICHIER_INSTALLATION -Force -ErrorAction SilentlyContinue
		Ecrire-Etape 'ok' "Installation retirée ($FICHIER_INSTALLATION)"
	} else { Ecrire-Etape 'sans' "Aucune installation dans $DOSSIER_ETAT (pas d'installation.json)" }
	if ($inst) {
		Ecrire-Info "Données gardées : $($inst.donnees)"
		Ecrire-Info "Pour réinstaller avec ces données : $LANCER -Donnees `"$($inst.donnees)`""
		Ecrire-Info 'Pour tout effacer : supprimer ce dossier à la main.'
	}
	return 0
}

function Action-Reconnecter {
	$inst = Exiger-Installation
	$node = Exiger-Node
	if (-not (Url-Bouclage $inst.url)) { Avertir-Reseau $inst.url }
	$r = Assurer-Serveur $inst $node 'Serveur'
	if ($r -eq $false) { return 1 }
	if ($r -eq $null -and -not (Attente-Etape $inst)) { return 1 }
	$fichierLien = Join-Path $inst.donnees 'lien-admin.txt'
	$res = Lancer-Programme $node @($LIEN_TS, '--donnees', $inst.donnees, 'reconnexion', '--admin', '--url', $inst.url)
	$lien = $res.Sortie.Trim()
	if ($res.Code -ne 0 -or $lien -notmatch $LIEN_VALIDE) {
		# Pas encore d'admin : le lien de création du premier démarrage sert à sa place.
		$creation = Lien-Fichier $inst.donnees
		if ($res.Code -eq 1 -and $creation) {
			Ecrire-Etape 'sans' "Aucun compte admin encore : c'est le lien de création du compte admin qui sert"
			$lien = $creation
		} else {
			Ecrire-Etape 'echec' 'Lien de reconnexion : refusé'
			foreach ($l in @($res.Erreurs -split "`r?`n" | Where-Object { $_ })) { Ecrire-Info $l }
			return 1
		}
	} else { Ecrire-Etape 'ok' "Lien de reconnexion créé (7 jours, une seule fois ; aussi dans $fichierLien)" }
	if ($Essai) { Write-Host "Lien de reconnexion (-Essai) : $lien" }
	elseif (Ouvrir-Navigateur $lien "ouvre le lien écrit dans le fichier $fichierLien (à garder pour toi)") { Ecrire-Etape 'ok' 'Navigateur : lien ouvert' }
	else { Ecrire-Etape 'echec' "Navigateur : non ouvert ; le lien est dans $fichierLien" }
	return 0
}

# --- Principal ------------------------------------------------------------------------------------------------------
$encodageAvant = $null
try { $encodageAvant = [Console]::OutputEncoding; [Console]::OutputEncoding = $UTF8 } catch { }
$code = 0
try {
	try {
		if ($Inconnus.Count) { throw ([ErreurUsage]::new("option ou argument inconnu : $($Inconnus -join ' ')")) }
		$actions = @($Arreter, $Demarrer, $Desinstaller, $Reconnecter, ($Restaurer -ne '') | Where-Object { $_ })
		if ($actions.Count -gt 1) { throw ([ErreurUsage]::new('-Arreter, -Demarrer, -Desinstaller, -Reconnecter et -Restaurer : une seule à la fois')) }
		$installation = $actions.Count -eq 0
		$PortN = 0
		if ($Port -ne '') {
			if ($Port -notmatch '^\d{1,5}$' -or [int]$Port -lt 1 -or [int]$Port -gt 65535) { throw ([ErreurUsage]::new("-Port : un nombre de 1 à 65535 (reçu « $Port »)")) }
			$PortN = [int]$Port
		}
		if (-not $installation -and ($PortN -or $Reseau -or ($Donnees -and -not $Essai))) { throw ([ErreurUsage]::new('-Port, -Reseau et -Donnees ne servent qu''à l''installation (relancer installer.cmd avec ces options)')) }
		if ($Essai) {
			if (-not $Etat) { throw ([ErreurUsage]::new('-Essai exige -Etat <dossier temporaire> (et -Donnees <dossier temporaire> pour l''installation)')) }
			if ($installation -and -not $Donnees) { throw ([ErreurUsage]::new('-Essai exige -Donnees <dossier temporaire> et -Etat <dossier temporaire>')) }
			if ($PortN -eq 8080) { throw ([ErreurUsage]::new('-Essai : le port 8080 n''est jamais utilisé')) }
			$DOSSIER_ETAT = Chemin-Complet $Etat
			# Les commandes proposées (résumé, messages) portent -Essai -Etat, que -Essai exige.
			$LANCER = "$LANCER -Essai -Etat `"$DOSSIER_ETAT`""
		} else {
			if ($Etat) { throw ([ErreurUsage]::new('-Etat ne sert qu''avec -Essai')) }
			if ($Profil) { throw ([ErreurUsage]::new('-Profil ne sert qu''avec -Essai (le raccourci Claude Code va sinon dans %USERPROFILE%\.claude)')) }
			if (-not $env:LOCALAPPDATA) { throw ([Echec]::new('LOCALAPPDATA non défini : dossier de l''installation introuvable')) }
			$DOSSIER_ETAT = Join-Path $env:LOCALAPPDATA $NOM
		}
		# Chemins réels compris (jonction, subst) : rien n'est créé avant ces refus.
		if (Est-DansDepot $DOSSIER_ETAT) { throw ([ErreurUsage]::new("dossier d'état ($DOSSIER_ETAT) dans le dépôt de l'outil : choisir un dossier hors de ce dépôt")) }
		if ($Essai -and $Donnees -and (Est-DansDepot $Donnees)) { throw ([ErreurUsage]::new("dossier des données ($(Chemin-Complet $Donnees)) dans le dépôt de l'outil ($RACINE) : choisir un dossier hors de ce dépôt")) }
		if ($Profil -and (Est-DansDepot $Profil)) { throw ([ErreurUsage]::new("-Profil ($(Chemin-Complet $Profil)) dans le dépôt de l'outil : choisir un dossier hors de ce dépôt")) }
		# -Essai ne touche jamais au poste : -Profil ne doit pas mener au vrai .claude de l'utilisateur (le profil réel est
		# lu par GetFolderPath, qui ne dépend pas de la variable USERPROFILE ; chemins réels : jonction, subst, noms courts).
		# Seul ce .claude est refusé, pas tout le profil : les dossiers temporaires des tests sont sous le profil.
		if ($Profil) {
			$profilReel = [Environment]::GetFolderPath('UserProfile')
			if ($profilReel -and (Est-Dans (Chemin-Reel (Join-Path (Chemin-Complet $Profil) '.claude')) (Chemin-Reel (Join-Path $profilReel '.claude')))) {
				throw ([ErreurUsage]::new("-Profil ($(Chemin-Complet $Profil)) mène au vrai dossier .claude de l'utilisateur ($(Join-Path $profilReel '.claude')) : -Essai n'y écrit jamais ; choisir un dossier temporaire"))
			}
		}
		$FICHIER_INSTALLATION = Join-Path $DOSSIER_ETAT 'installation.json'
		$JOURNAL = Join-Path $DOSSIER_ETAT 'serveur.log'
		$FICHIER_PID = Join-Path $DOSSIER_ETAT 'serveur.pid'
		$FICHIER_PATH_AJOUTE = Join-Path $DOSSIER_ETAT 'cli-path.txt'
		$FICHIER_SKILL_POSE = Join-Path $DOSSIER_ETAT 'claude-skill.txt'
		if ($installation -or $Demarrer -or $Reconnecter -or $Restaurer) { [void](New-Item -ItemType Directory -Force -Path $DOSSIER_ETAT) }
		if ($Essai) { Write-Host "Essai : état dans $DOSSIER_ETAT (ni winget, ni PATH, ni Démarrage, ni navigateur)" }

		if ($Arreter) { $code = Action-Arreter }
		elseif ($Demarrer) { $code = Action-Demarrer }
		elseif ($Desinstaller) { $code = Action-Desinstaller }
		elseif ($Reconnecter) { $code = Action-Reconnecter }
		elseif ($Restaurer) { $code = Action-Restaurer }
		else { $code = Action-Installer }
	} catch [ErreurUsage] {
		Ecrire-Etape 'echec' $_.Exception.Message
		Ecrire-Info 'usage : installer.cmd [-Oui] [-Reseau] [-Donnees <dossier>] [-Port <n>] | -Arreter | -Demarrer | -Desinstaller | -Reconnecter [-Essai -Etat <dossier> (-Donnees <dossier> pour l''installation) [-Profil <dossier>]]'
		$code = 2
	} catch [Echec] {
		Ecrire-Etape 'echec' $_.Exception.Message
		$code = 1
	} catch {
		Ecrire-Etape 'echec' "erreur inattendue : $($_.Exception.Message)"
		$code = 1
	}
} finally {
	if ($encodageAvant) { try { [Console]::OutputEncoding = $encodageAvant } catch { } }
}
exit $code
