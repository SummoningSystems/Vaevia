# Active le greffon : ajoute le nœud autochargé RetoursApp et ses réglages (Paramètres du projet → retours_app).
@tool
extends EditorPlugin

const REGLAGES := [["retours_app/serveur", ""], ["retours_app/projet", ""], ["retours_app/touche", "F8"], ["retours_app/actif", "debug"]]

func _enter_tree() -> void:
	for r in REGLAGES:
		if not ProjectSettings.has_setting(r[0]):
			ProjectSettings.set_setting(r[0], r[1])
		ProjectSettings.set_initial_value(r[0], r[1])
	ProjectSettings.add_property_info({"name": "retours_app/actif", "type": TYPE_STRING, "hint": PROPERTY_HINT_ENUM, "hint_string": "debug,toujours,jamais"})
	add_autoload_singleton("RetoursApp", "res://addons/retours_app/retours_app.gd")

func _exit_tree() -> void:
	remove_autoload_singleton("RetoursApp")
