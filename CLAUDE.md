# CLAUDE.md

Vue 3D d'un lieu de France métropolitaine, reconstruite à partir des données
ouvertes de l'IGN. Un serveur Flask construit une **scène** autour d'un point et
la met en cache sur disque ; une page three.js unique l'affiche. Présentation et
méthode : [README.md](README.md).

## Commandes

```bash
python3.12 -m venv .venv && . .venv/bin/activate   # 3.12, comme l'image ; pas 3.14 (0 houppier)
pip install -r requirements.txt pytest          # dépendances
pytest                                           # tests Python (réseau jamais appelé)
VUE3D_CACHE=./cache flask --app vue3d.app run --port 8080   # serveur local
docker compose up -d --build                     # conteneur, port 8080 (VUE3D_PORT)
VUE3D_VEHICULES=rtmdet docker compose up -d --build   # avec la couche des véhicules (aucun | rtmdet | yolo | tous)
VUE3D_PANNEAUX=oui docker compose up -d --build        # avec les panneaux solaires du registre OpenPVMapper (CC-BY 4.0)
./run_macOS_CoreML.sh                            # sans Docker, les deux détecteurs sur CoreML (Mac)
node outils/verifier-geometrie.mjs               # géométrie de la page, exécutée sous Node
node outils/verifier-recherche.mjs               # recherche d'un lieu, exécutée sous Node
npm install puppeteer-core && node outils/essai-navigateur.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003"
```

## Architecture

```
vue3d/
  app.py        Flask : /, /api/scene, /api/ortho, /api/monuments, /api/ouvrages, /api/nuage, /api/piscines, /api/vehicules, /api/panneaux, /api/avancement, /api/sante, POST /api/reconstruire
  scene.py      assemblage d'une scène, cache disque par point arrondi
  couches.py    lecture WFS (bâtiments, végétation, BD Forêt, routes)
  batiments.py  bâtiments découpés sur l'emprise, en retrait du bord
  mnh.py        hauteurs du sursol, LiDAR HD, repli MNS − MNT
  toits.py      gouttière, faîtage, corps de toit, surface du toit, bâtiments sous les arbres ; bassin de processus né au démarrage (VUE3D_TOITS_PROCESSUS, 16 au plus)
  pans.py       toit en pans : plans ajustés au MNH, volume fermé et vérifié
  houppiers.py  segmentation des arbres sur la grille à 0,5 m
  constructions.py  réservoirs et constructions ponctuelles BD TOPO, retirés du sursol des houppiers
  ortho.py      indice de verdure ExG, mosaïque d'orthophoto
  relief.py     RGE ALTI quantifié au décimètre, anneau de relief alentour
  eau.py        étendues et cours d'eau BD TOPO, découpés sur l'emprise
  lignes.py     lignes à haute tension et hauteur de leurs supports
  monuments.py  parties de monuments OSM (building:part), seule source hors IGN
  ouvrages.py   murs, ponts, voies ferrées, terrains de sport : couche à part, chargée après la scène
  nuage.py      bâti du nuage de points LiDAR HD (dalles COPC lues par plages, via geopf) ; ouvrages ajourés en points : couche à part
  vehicules.py  véhicules et piscines lus sur l'orthophoto par un réseau ONNX : couche à part, optionnelle (VUE3D_VEHICULES)
  releves.py    détections gardées par rectangle de terrain (cache/releves/) : un point décalé ne détecte que la bande nouvelle
  panneaux.py   panneaux solaires du registre OpenPVMapper (SQLite R-tree) : couche à part, optionnelle (VUE3D_PANNEAUX)
  geopf.py      GET avec reprise sur la Géoplateforme ; 8 places pour tout le service, lectures groupées abandonnées au premier échec
  static/index.html   la page entière : HTML, CSS et JavaScript (three.js r160)
```

Pas de base de données, pas de clé d'API, pas de build front : la page est un
fichier statique qui lit le point dans son URL.

Les couches des véhicules et des panneaux sont les seules dépendances
optionnelles : sans `VUE3D_VEHICULES`, ni onnxruntime ni réseau ne sont
chargés ; sans `VUE3D_PANNEAUX`, aucune base n'est lue ; les tests ne
demandent jamais ni l'un ni l'autre (`/donnees/` est ignoré par git). Les poids (RTMDet-R, Apache-2.0 ; YOLO11-OBB, AGPL-3.0 ;
tous deux entraînés sur DOTA, usage académique) ne doivent **jamais** entrer
dans le dépôt : ils sont exportés par `outils/exporter_vehicules.py` dans
l'étage `export` du Dockerfile.

## Invariants — à ne pas défaire

- **Une scène est complète ou n'existe pas.** Le cache ne périme jamais, donc
  une scène écrite pendant une panne reste fausse pour toujours. Toute source en
  échec lève `SceneIncomplete` et rien n'est écrit. Distinguer « la donnée
  n'existe pas ici » (un fait : `fetch_relief` rend `None` hors couverture) de
  « on n'a pas pu la lire » (un incident). Ne jamais ajouter un
  `try/except` qui avale une erreur de source pour « publier quand même ».
- **Les refus de la Géoplateforme sont sporadiques.** `get_avec_reprise`
  réessaie tout échec, 4xx compris ; une requête rejetée en 400 a répondu 200
  six fois de suite rejouée à l'identique.
- **WMS 1.3.0 en EPSG:4326 : la BBOX s'écrit `lat,lon`.** Inversée, le service
  répond 200 avec une dalle vide. Une image en EPSG:4326 doit avoir des côtés
  proportionnels à l'étendue en **mètres**, sinon elle sort étirée.
- **La grille MNH à 0,5 m est lue une fois** et passée aux toitures et aux
  houppiers ; elle n'est jamais embarquée dans la scène (1,9 Mo d'entrée de
  calcul).
- **Ce qui touche au MNH ou aux houppiers va dans la scène ; le reste peut
  être une couche à part.** Une couche chargée après la scène (monuments,
  ouvrages) a son fichier de cache, sa version, et la même règle : écrite
  entière ou pas du tout. Elle ne lit de la scène que ses résultats.
- **Un toit en pans est fermé ou n'est pas publié.** `pans.py` vérifie le
  volume transmis, après quantification : chaque arête portée par exactement
  deux triangles, en sens opposés. Sinon il rend None et le toit garde sa
  surface mesurée. Ne jamais publier un volume « presque » fermé.
- **Un calcul plus rapide rend la même scène, au bit près.** Le cache ne
  périme pas : une scène reconstruite doit être celle d'avant. Un raccourci
  garde les mêmes opérations flottantes dans le même ordre (`sum()` de Python
  3.12 est compensée, `x ** 2` n'est pas `x * x`), et se vérifie contre le
  calcul d'origine (`tests/references_toits.py`). Le bassin des toitures
  (`toits.py`) ne sert qu'au service, qui l'autorise : ses processus
  réexécutent le script principal, qu'un script de mesure doit garder derrière
  `if __name__ == "__main__"` s'il passe `processus=`. Les houppiers ne lisent
  pas les toits : `assembler` les calcule pendant les toitures du bassin ; si
  la végétation devait un jour lire les toits, retirer ce recouvrement.
- **Une scène en échec ne lance plus de requête.** Toute requête vers la
  Géoplateforme passe par `geopf.place()`, toute lecture lancée en parallèle
  par `geopf.en_parallele` ou `Groupe.soumettre` : au premier échec, les
  lectures qui attendent leur place ne partent plus. Un fil nu y échappe.
- **La géométrie d'un houppier ne doit jamais se retourner** : rayon croissant
  avec la couronne, hauteur décroissante du sommet au bord, dessous qui remonte
  vers le tronc, lobage partagé par tous les anneaux. Un défaut ici passe
  inaperçu à forte opacité et saute aux yeux à 30 %.

## Méthode de travail

- **Mesurer avant de changer un seuil.** Chaque constante des modules de calcul
  porte en commentaire la mesure qui l'a fixée. Un nouveau seuil se justifie de
  la même façon, sur des données réelles.
- **La géométrie se vérifie en exécutant le vrai code**, pas en le relisant :
  extraire les fonctions de `index.html` et les exécuter sous Node avec un
  THREE minimal a trouvé des facettes retournées que la lecture avait ratées.
- **La page se vérifie dans un navigateur** avec `outils/essai-navigateur.mjs` :
  les tests Python ne voient aucun chemin du rendu. Le script échoue à la
  moindre erreur JavaScript ou requête en échec.
- **Données publiques uniquement dans le dépôt.** Exemples et captures sur des
  lieux publics (monuments, centres de villages), jamais l'adresse d'un
  particulier.

## Conventions

- Code, commentaires, messages de commit et documentation en **français**.
- Les commentaires expliquent le **pourquoi**, mesure à l'appui, pas le quoi.
- Messages de commit au format `type(portée): résumé`, corps explicatif ; pas de
  trailer `Co-Authored-By`.
- Tout changement de `SCENE_VERSION`, ou visible de l'utilisateur, s'inscrit
  dans [CHANGELOG.md](CHANGELOG.md).
- Toujours lancer toute la suite `pytest` avant de conclure.
