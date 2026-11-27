# Image du serveur (étapes 1 à 3.5). Contexte de build : la racine du dépôt de l'outil (l'image a besoin de site/ pour
# construire les pages) ; serveur/Dockerfile.dockerignore n'y laisse entrer que le nécessaire.
# Serveur d'équipe : docker-compose.yml à la racine (serveur/README.md, section « Docker Compose ») :
#   docker compose up -d
#   docker compose exec wdd cat /donnees/lien-admin.txt     (lien d'invitation admin au premier démarrage)
# Sans Compose :
#   docker build -f serveur/Dockerfile -t wdd-serveur .
#   docker run -d -p 127.0.0.1:8080:8080 -v wdd-donnees:/donnees --name wdd wdd-serveur
#   docker exec wdd cat /donnees/lien-admin.txt
FROM node:24-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /outil
COPY serveur/package.json serveur/package.json
COPY VERSION VERSION
COPY serveur/src serveur/src
# Méta-interface (étape 3) : fichiers statiques servis sous « / » (serveur/ui/tests/ exclu du contexte).
COPY serveur/ui serveur/ui
COPY site/build.js site/build.js
COPY site/valider-notes.js site/valider-notes.js
COPY site/changements.js site/changements.js
COPY site/gabarit site/gabarit
COPY site/retours site/retours
RUN mkdir -p /donnees /sauvegardes && chown node:node /donnees /sauvegardes
# Sauvegardes (étape 3.7, A1) : un volume à part, pour qu'une restauration ou une perte du volume des données les épargne.
ENV WDD_DONNEES=/donnees WDD_SAUVEGARDE=/sauvegardes WDD_HOTE=0.0.0.0 WDD_PORT=8080
VOLUME /donnees
VOLUME /sauvegardes
USER node
EXPOSE 8080
# Santé (étape 3.5, § 1.1 et § 1.3) : GET /api/sante par le fetch de Node (pas de curl dans l'image), sur 127.0.0.1 et
# le port d'écoute (WDD_PORT). La route répond avant le contrôle de Host : elle vaut aussi avec WDD_URL_PAGES, où
# 127.0.0.1 est un hôte inconnu (421 partout ailleurs).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
	CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.WDD_PORT||8080)+'/api/sante',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.status===200?0:1),()=>process.exit(1))"]
CMD ["node", "serveur/src/principal.ts"]
