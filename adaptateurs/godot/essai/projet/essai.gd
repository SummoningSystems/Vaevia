# Essai du greffon : jeton passé en argument (-- --jeton=…), deux envois (cible de la scène, cible explicite) avec
# capture, puis la touche F8 ouvre bien le formulaire. Écrit RESULTAT … sur la sortie, puis quitte.
extends Control

func _ready() -> void:
	var jeton := ""
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--jeton="):
			jeton = a.substr(8)
	# Mode appairage : le greffon demande un code, essai.mjs l'autorise par l'API, le greffon reçoit son jeton.
	if "--appairer" in OS.get_cmdline_user_args():
		# La sortie de Godot est retenue quand elle va dans un tube : le code part aussi dans un fichier (--code=<chemin>).
		var fichier := ""
		for a in OS.get_cmdline_user_args():
			if a.begins_with("--code="):
				fichier = a.substr(7)
		RetoursApp.code_appairage.connect(func(code, adresse):
			print("RESULTAT code ", code, " ", adresse)
			var f := FileAccess.open(fichier, FileAccess.WRITE)
			f.store_string(code)
			f.close())
		RetoursApp.erreur.connect(func(m): print("RESULTAT erreur ", m); get_tree().quit())
		RetoursApp.appairer()
		var nom = await RetoursApp.appaire
		print("RESULTAT appaire ", nom)
		RetoursApp.envoyer("Essai Godot : après appairage", "plante:basilic", "texte", null)
		print("RESULTAT envoi3 ", await _attendre())
		get_tree().quit()
		return
	RetoursApp.jeton = jeton
	for i in 5:
		await get_tree().process_frame
	print("RESULTAT cible_courante ", RetoursApp.cible_courante())
	RetoursApp.envoyer("Essai Godot : écran d'accueil", "", "bug", RetoursApp.capturer())
	var r1 = await _attendre()
	print("RESULTAT envoi1 ", r1)
	RetoursApp.envoyer("Essai Godot : la tomate", "plante:tomate", "idee", null)
	var r2 = await _attendre()
	print("RESULTAT envoi2 ", r2)
	var k := InputEventKey.new()
	k.keycode = KEY_F8
	k.pressed = true
	Input.parse_input_event(k)
	for i in 3:
		await get_tree().process_frame
	var f = RetoursApp._formulaire
	print("RESULTAT formulaire ", f != null)
	if f != null:
		var t: Label = f.get_child(0).get_child(0).get_child(0).get_child(0).get_child(0)
		print("RESULTAT titre ", t.text)
		var v: VBoxContainer = f.get_child(0).get_child(0).get_child(0).get_child(0)
		var texte: TextEdit = v.get_child(1)
		var etat: Label = v.get_child(4)
		var envoi: Button = v.get_child(5)
		texte.text = "Essai Godot : par le formulaire"
		var bon: String = RetoursApp.projet
		RetoursApp.projet = "inexistant"
		envoi.pressed.emit()
		var t1 := Time.get_ticks_msec()
		while etat.text in ["", "Envoi…"]:
			if Time.get_ticks_msec() - t1 > 15000: break
			await get_tree().process_frame
		print("RESULTAT echec_formulaire ", etat.text, " | ouvert=", RetoursApp._formulaire != null)
		RetoursApp.projet = bon
		envoi.pressed.emit()
		t1 = Time.get_ticks_msec()
		while RetoursApp._formulaire != null and Time.get_ticks_msec() - t1 < 15000:
			await get_tree().process_frame
		print("RESULTAT formulaire_envoye ", RetoursApp._formulaire == null, " branches=", RetoursApp._branches.size())
	get_tree().quit()

func _attendre() -> String:
	var fini := [""]
	var ok := func(id): fini[0] = "ok " + id
	var ko := func(m): fini[0] = "erreur " + m
	RetoursApp.envoye.connect(ok, CONNECT_ONE_SHOT)
	RetoursApp.erreur.connect(ko, CONNECT_ONE_SHOT)
	var t0 := Time.get_ticks_msec()
	while fini[0] == "" and Time.get_ticks_msec() - t0 < 15000:
		await get_tree().process_frame
	if RetoursApp.envoye.is_connected(ok): RetoursApp.envoye.disconnect(ok)
	if RetoursApp.erreur.is_connected(ko): RetoursApp.erreur.disconnect(ko)
	return fini[0] if fini[0] != "" else "délai dépassé"
