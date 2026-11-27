# Retour depuis l'application (étape 3.9, I2) : adaptateur Godot 4 du protocole décrit dans
# docs/retours-depuis-une-application.md. Rien de propre au jeu : une touche ouvre un petit formulaire, le retour part
# vers le serveur de retours, ancré sur la ref de l'objet visé (méta « retours_ref » = "sorte:ref", la même que dans le
# data.json de l'exporteur), avec une capture de l'écran.
#
# Réglages (Projet → Paramètres du projet, section retours_app) :
#   retours_app/serveur   adresse du serveur (https://retours.exemple.fr)
#   retours_app/projet    id du projet sur le serveur
#   retours_app/touche    touche qui ouvre le formulaire (F8 par défaut)
#   retours_app/actif     "debug" (défaut : builds de débogage seulement), "toujours" ou "jamais"
# Le jeton n'est jamais dans le projet ni dans un build exporté : il est obtenu par appairage (code à autoriser dans le
# navigateur du testeur) et gardé dans user://retours_app.cfg, sur la machine du testeur seulement.
#
# Utilisable sans formulaire (tests, bouton maison) :
#   RetoursApp.envoyer(texte, cible = "", categorie = "bug", capture = null)   # cible "" : celle visée (cible_courante())
#   RetoursApp.appairer()                       # signal code_appairage(code, adresse), puis appaire(nom) ou erreur(message)
#   RetoursApp.cible_courante() -> String       # "sorte:ref" de l'objet visé, ou ""
extends Node

signal envoye(id: String)
signal erreur(message: String)
signal code_appairage(code: String, adresse: String)
signal appaire(nom: String)

const FICHIER_JETON := "user://retours_app.cfg"
const MAX_COTE := 1920
const CATEGORIES := [["bug", "Bug"], ["idee", "Idée"], ["texte", "Texte ou nom"], ["fort", "Trop fort"], ["faible", "Trop faible"], ["autre", "Autre"]]

var serveur := ""
var projet := ""
var jeton := ""
var _touche := KEY_F8
var _formulaire: CanvasLayer = null
var _capture: Image = null
var _cible := ""
# Branchements faits par le formulaire (signal, fonction), débranchés à sa fermeture : un succès ne laisse pas une
# fonction d'erreur branchée sur des nœuds libérés, et inversement.
var _branches: Array = []

func _brancher(s: Signal, f: Callable) -> void:
	s.connect(f)
	_branches.append([s, f])

func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	serveur = str(ProjectSettings.get_setting("retours_app/serveur", "")).trim_suffix("/")
	projet = str(ProjectSettings.get_setting("retours_app/projet", ""))
	var t := str(ProjectSettings.get_setting("retours_app/touche", "F8"))
	var k := OS.find_keycode_from_string(t)
	if k != KEY_NONE:
		_touche = k
	var cfg := ConfigFile.new()
	if cfg.load(FICHIER_JETON) == OK and str(cfg.get_value("jeton", "serveur", "")) == serveur and str(cfg.get_value("jeton", "projet", "")) == projet:
		jeton = str(cfg.get_value("jeton", "valeur", ""))

func actif() -> bool:
	var mode := str(ProjectSettings.get_setting("retours_app/actif", "debug"))
	if mode == "jamais" or serveur == "" or projet == "":
		return false
	return mode == "toujours" or OS.is_debug_build()

# La touche doit marcher quoi que fasse l'application. Essai sur un vrai jeu : les nœuds de la scène reçoivent les
# événements avant les nœuds autochargés, et le jeu en consommait. D'où deux voies : l'événement (_input), et l'état de
# la touche relu à chaque image (_process), qui ne dépend d'aucun événement.
var _appuyee := false

func _input(e: InputEvent) -> void:
	if not actif() or _formulaire != null:
		return
	if e is InputEventKey and e.pressed and not e.echo and e.keycode == _touche:
		get_viewport().set_input_as_handled()
		ouvrir()

func _process(_d: float) -> void:
	var p := Input.is_key_pressed(_touche)
	if p and not _appuyee and _formulaire == null and actif():
		ouvrir()
	_appuyee = p

# --- Cible : l'objet visé ---------------------------------------------------------------------------------------
# Contrôle survolé (ou un de ses parents) qui porte la méta « retours_ref » ; sinon la scène courante ; sinon "".
func cible_courante() -> String:
	var n: Node = get_viewport().gui_get_hovered_control()
	while n != null:
		if n.has_meta("retours_ref"):
			return str(n.get_meta("retours_ref"))
		n = n.get_parent()
	var s := get_tree().current_scene
	if s != null and s.has_meta("retours_ref"):
		return str(s.get_meta("retours_ref"))
	return ""

# --- Capture --------------------------------------------------------------------------------------------------
func capturer() -> Image:
	var im := get_viewport().get_texture().get_image()
	if im == null:
		return null
	var w := im.get_width()
	var h := im.get_height()
	if w > MAX_COTE or h > MAX_COTE:
		var k := float(MAX_COTE) / float(maxi(w, h))
		im.resize(int(w * k), int(h * k), Image.INTERPOLATE_BILINEAR)
	return im

# --- Envoi ----------------------------------------------------------------------------------------------------
func envoyer(texte: String, cible := "", categorie := "bug", capture: Image = null) -> void:
	if jeton == "":
		erreur.emit("pas encore appairé : appelle appairer()")
		return
	if cible == "":
		cible = cible_courante()
	var captures: Array = []
	if capture != null:
		var png := capture.save_png_to_buffer()
		var r := await _requete(HTTPClient.METHOD_POST, "/api/p/%s/captures" % projet, png, "image/png")
		if r.code != 201:
			erreur.emit("capture refusée (%d) : %s" % [r.code, r.message])
			return
		captures.append(r.corps.id)
	var corps := {"text": texte, "cat": categorie, "cible": cible, "captures": captures,
		"contexte": "%s %s · %s · %d×%d" % [ProjectSettings.get_setting("application/config/name", ""), ProjectSettings.get_setting("application/config/version", ""), OS.get_name(), get_viewport().get_visible_rect().size.x, get_viewport().get_visible_rect().size.y]}
	var r2 := await _requete(HTTPClient.METHOD_POST, "/api/p/%s/retours/app" % projet, JSON.stringify(corps).to_utf8_buffer(), "application/json")
	if r2.code == 201:
		envoye.emit(str(r2.corps.id))
	elif r2.code == 401:
		_oublier_jeton()
		erreur.emit("jeton refusé : il faut appairer à nouveau")
	else:
		erreur.emit("retour refusé (%d) : %s" % [r2.code, r2.message])

# --- Appairage (code à autoriser dans le navigateur) -------------------------------------------------------------
func appairer() -> void:
	var poste := "%s · %s" % [str(ProjectSettings.get_setting("application/config/name", "Application")).substr(0, 40), OS.get_name()]
	var r := await _requete(HTTPClient.METHOD_POST, "/api/appairage", JSON.stringify({"poste": poste, "projet": projet, "role": "retour"}).to_utf8_buffer(), "application/json", false)
	if r.code != 201:
		erreur.emit("appairage refusé (%d) : %s" % [r.code, r.message])
		return
	var code_appareil := str(r.corps.code_appareil)
	code_appairage.emit(str(r.corps.code), "%s/appairage?code=%s" % [serveur, str(r.corps.code)])
	var pause := float(r.corps.intervalle)
	var fin := Time.get_ticks_msec() + 10 * 60 * 1000
	while Time.get_ticks_msec() < fin:
		await get_tree().create_timer(pause, true, false, true).timeout
		var l := await _requete(HTTPClient.METHOD_POST, "/api/appairage/jeton", JSON.stringify({"code_appareil": code_appareil}).to_utf8_buffer(), "application/json", false)
		if l.code == 202 or (l.code == 429 and str(l.corps.get("code", "")) == "slow_down"):
			continue
		if l.code == 200:
			jeton = str(l.corps.jeton)
			var cfg := ConfigFile.new()
			cfg.set_value("jeton", "serveur", serveur)
			cfg.set_value("jeton", "projet", projet)
			cfg.set_value("jeton", "valeur", jeton)
			cfg.save(FICHIER_JETON)
			appaire.emit(str(l.corps.nom))
			return
		erreur.emit("appairage : %s" % l.message)
		return
	erreur.emit("appairage expiré : recommence")

func _oublier_jeton() -> void:
	jeton = ""
	DirAccess.remove_absolute(ProjectSettings.globalize_path(FICHIER_JETON))

func _requete(methode: int, chemin: String, corps: PackedByteArray, type: String, avec_jeton := true) -> Dictionary:
	var h := HTTPRequest.new()
	h.timeout = 30
	add_child(h)
	var entetes := PackedStringArray(["Content-Type: " + type])
	if avec_jeton:
		entetes.append("Authorization: Bearer " + jeton)
	var e := h.request_raw(serveur + chemin, entetes, methode, corps)
	if e != OK:
		h.queue_free()
		return {"code": 0, "corps": {}, "message": "requête impossible (%d)" % e}
	var res: Array = await h.request_completed
	h.queue_free()
	var texte := (res[3] as PackedByteArray).get_string_from_utf8()
	var j = JSON.parse_string(texte) if texte != "" else {}
	if typeof(j) != TYPE_DICTIONARY:
		j = {}
	var message := str(j.get("message", "")) if res[0] == HTTPRequest.RESULT_SUCCESS else "serveur injoignable"
	return {"code": int(res[1]), "corps": j, "message": message}

# --- Formulaire -------------------------------------------------------------------------------------------------
func ouvrir() -> void:
	_capture = capturer()
	_cible = cible_courante()
	_formulaire = CanvasLayer.new()
	_formulaire.layer = 128
	add_child(_formulaire)
	# Plein écran (les clics ne passent pas au jeu derrière), formulaire centré avec une marge.
	var centre := CenterContainer.new()
	centre.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_formulaire.add_child(centre)
	var fond := PanelContainer.new()
	fond.custom_minimum_size = Vector2(460, 0)
	centre.add_child(fond)
	var marge := MarginContainer.new()
	for c in ["margin_left", "margin_top", "margin_right", "margin_bottom"]:
		marge.add_theme_constant_override(c, 14)
	fond.add_child(marge)
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 8)
	marge.add_child(v)
	var titre := Label.new()
	titre.text = "Retour sur : " + (_cible if _cible != "" else "cet écran (sans fiche)")
	v.add_child(titre)
	if jeton == "":
		var info := Label.new()
		info.autowrap_mode = TextServer.AUTOWRAP_WORD
		info.text = "Cette copie n'est pas encore reliée au serveur de retours."
		v.add_child(info)
		var b := Button.new()
		b.text = "Relier (un code à autoriser dans ton navigateur)"
		v.add_child(b)
		b.pressed.connect(func():
			b.disabled = true
			_brancher(code_appairage, func(code, adresse): info.text = "Ouvre %s dans ton navigateur (où tu es connecté) et autorise le code %s." % [adresse, code]; OS.shell_open(adresse))
			_brancher(appaire, func(_n): fermer.call_deferred(); ouvrir.call_deferred())
			_brancher(erreur, func(m): info.text = m; b.disabled = false)
			appairer())
	else:
		var texte := TextEdit.new()
		texte.custom_minimum_size = Vector2(440, 110)
		texte.placeholder_text = "Ce qui ne va pas, ce que tu voudrais voir…"
		v.add_child(texte)
		var cat := OptionButton.new()
		for c in CATEGORIES:
			cat.add_item(c[1])
		v.add_child(cat)
		var avec := CheckBox.new()
		avec.text = "Joindre une capture de l'écran"
		avec.button_pressed = _capture != null
		avec.disabled = _capture == null
		v.add_child(avec)
		var etat := Label.new()
		v.add_child(etat)
		var envoi := Button.new()
		envoi.text = "Envoyer"
		v.add_child(envoi)
		envoi.pressed.connect(func():
			if texte.text.strip_edges() == "":
				etat.text = "Écris d'abord ton retour."
				return
			envoi.disabled = true
			etat.text = "Envoi…"
			if _branches.is_empty():
				_brancher(envoye, func(_id): fermer.call_deferred())
				_brancher(erreur, func(m): etat.text = m; envoi.disabled = false)
			envoyer(texte.text.strip_edges(), _cible, CATEGORIES[cat.selected][0], _capture if avec.button_pressed else null))
		texte.grab_focus.call_deferred()
	var annuler := Button.new()
	annuler.text = "Fermer"
	v.add_child(annuler)
	annuler.pressed.connect(fermer)

func fermer() -> void:
	for b in _branches:
		if (b[0] as Signal).is_connected(b[1]):
			(b[0] as Signal).disconnect(b[1])
	_branches.clear()
	if _formulaire != null:
		_formulaire.queue_free()
		_formulaire = null
	_capture = null
