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
./run_container.sh                               # l'image sous container d'Apple (macOS 26) au lieu de Docker ; pas de CoreML
node outils/verifier-geometrie.mjs               # géométrie de la page, exécutée sous Node
node outils/verifier-modules.mjs                 # ordre d'évaluation des modules des pages
node outils/verifier-recherche.mjs               # recherche d'un lieu, exécutée sous Node
node outils/verifier-export.mjs essai.ifc essai.gml   # exports IFC et CityGML, exécutés sous Node
node outils/verifier-solaire.mjs http://localhost:8080   # ensoleillement des toits contre PVGIS (réseau)
node outils/mesure-ecarts-toits.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003"   # toits contre le nuage LiDAR (puppeteer-core)
python outils/valider_ifc.py essai.ifc           # validation par ifcopenshell (pip install ifcopenshell pytest, hors requirements)
python outils/valider_citygml.py essai.gml       # géométrie du CityGML ; son schéma : citygml-tools validate essai.gml
python outils/reparer_anneaux.py cache --essai   # anneau des scènes en cache relu au WMTS natif ; sans --essai, réécrit
python3 -m http.server -d outils 8000            # visionneuse-ifc.html : un IFC exporté, relu par web-ifc, propriétés au clic
npm install puppeteer-core && node outils/essai-navigateur.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003"
node outils/essai-voiture.mjs "http://localhost:8080/voiture?simu=1&lat=48.8706&lon=2.3055&vitesse=50" 60 voiture.png   # la vue en voiture, conduite simulée
node outils/film-voiture.mjs "http://localhost:8080/voiture?simu=1&lat=48.8532&lon=2.3692&vers=48.8483,2.3958&versnom=Nation&vitesse=40" docs/demo/demo-voiture-paysage.mp4   # film d'un trajet simulé (vers = destination)
```

## Architecture

```
vue3d/
  app.py        l'application Flask et l'état du service (cache, stocks, quotas) ; quota de scènes neuves par IP (VUE3D_QUOTA, VUE3D_PROXY derrière un proxy)
  routes/       les routes, un blueprint par page : scene.py (/, /api/scene, /api/ortho, /api/monuments, /api/ouvrages, /api/nuage, /api/piscines, /api/navires, /api/vehicules, /api/panneaux, /api/dpe, /api/dvf, /api/bornes, /api/solaire, /api/avancement, POST /api/reconstruire, GET et POST /api/avis), voiture.py (/voiture, /api/carre, /api/vegetation, /api/vitesses, /api/signalisation, /api/bornes-bloc, POST /api/signalement), service.py (/api/tuile, /api/sante)
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
  nuage.py      bâti du nuage de points LiDAR HD (dalles COPC lues par plages, via geopf) ; ouvrages ajourés en points : couche à part, lue en deux temps (carré proche, puis zone entière)
  vehicules.py  véhicules, piscines et navires lus sur l'orthophoto par un réseau ONNX : couche à part, optionnelle (VUE3D_VEHICULES) ; les navires gardés sur l'eau, mer comprise (communes BD TOPO, RGE ALTI)
  releves.py    détections gardées par rectangle de terrain (cache/releves/) : un point décalé ne détecte que la bande nouvelle
  solaire.py    année type de PVGIS (direct, diffus, global des 8 760 heures) : couche à part, lue au clic seulement, datée ; l'ensoleillement des toits se calcule dans la page, sur le GPU (couches/solaire.js)
  panneaux.py   panneaux solaires du registre OpenPVMapper (SQLite R-tree) : couche à part, optionnelle (VUE3D_PANNEAUX)
  dpe.py        DPE de l'ADEME rattachés aux bâtiments (RNB, sinon adresse à 5 m) : couche à part, lue au clic seulement, datée
  dvf.py        ventes DVF (fichiers Etalab) jointes aux parcelles du cadastre IGN : couche à part, lue au clic seulement, datée
  bornes.py     bornes de recharge (Base nationale des IRVE, API tabulaire de data.gouv.fr) réunies par station : couche à part, lue au clic seulement, datée ; pour la voiture, par bloc de 4 km (cache/carres/bornes-v1/), relu après 7 jours
  carres.py     carrés de 500 m de la vue en voiture, grille Lambert-93 : bâtiments, routes, et voies ferrées et passerelles au-dessus du sol (`ponts`), BD TOPO lus en EPSG:2154 (cache/carres/), sans scène ni MNH ; leurs arbres en couche à part (/api/vegetation, houppiers.py sur le MNH à 0,5 m) ; quota à part (CARRES_PAR_HEURE)
  vitesses.py   limitations de vitesse des carrés de la voiture (/api/vitesses) : maxspeed OpenStreetMap (Overpass, par bloc de 2 km gardé dans cache/carres/), rapproché des tronçons BD TOPO sens par sens, sinon règle générale marquée estimée ; couche à part
  signalisation.py  stops, cédez-le-passage et feux de la voiture (/api/signalisation) : nœuds OpenStreetMap et leurs voies (Overpass, par bloc de 2 km gardé dans cache/carres/, mêmes places que vitesses.py), rattachés au tronçon BD TOPO et au sens ; sans sens saisi, vers le carrefour le plus proche ; un feu de carrefour sur chaque tronçon qui y arrive ; couche à part
  geopf.py      GET avec reprise sur la Géoplateforme ; 8 places pour tout le service, lectures groupées abandonnées au premier échec
  avis.py       👍 et 👎 des visiteurs sur le rendu d'une scène, comptés pour tous, un par adresse IP : journal cache/avis/avis.jsonl où tout s'ajoute (le dernier avis d'une adresse compte), captures et mot des 👎 ; lus dans la page privée des visites, hors du dépôt
  signalements.py  le bouton ⚠ de la vue en voiture : capture de l'écran et état du sol gardés dans cache/signalements/ (<id>.json, <id>.jpg), bornés en taille, en nombre et par adresse
  tuiles.py     tuiles WMTS de la page (ortho, plan) : stock servi, sinon redirection vers l'IGN ; une tuile refusée au navigateur est relue ici et gardée 90 jours (cache/tuiles/)
  static/index.html   la page de la scène : son HTML, et deux scripts en ligne qui partent avant tout (tiroir, demande de la scène)
  static/css/scene.css   sa feuille de style
  static/js/scene/    ses modules ES (three.js r160), chargés par main.js dans l'ordre de leurs effets : socle/, terrain/, batiments/, couches/ (une couche par module), vegetation/, export/, interface/, geometrie/
  static/voiture.html la vue en voiture, page à part : un monde qui défile en Lambert-93, sol en tuiles WMTS sur le RGE ALTI, carrés chargés le long de la route prévue sur le graphe BD TOPO, voiture calée sur la route
  static/css/voiture.css, static/js/voiture/   sa feuille de style et ses modules : socle/ (paramètres, Lambert-93, monde, rendu, état partagé), sol/, carres/, route/ (graphe, tunnels : l'altitude sous terre, voiture, limitations, signalisation : panneaux au bord de la route et prochain annoncé, simulation), couches/ (bornes), interface/
  static/js/commun/   ce que les deux pages partagent : tuiles (fonds, RGE ALTI), règles des bâtiments et des arbres
  static/favicon.svg, favicon-32.png, apple-touch-icon.png   le logo de la page, tiré de docs/logo/
docs/logo/      le logo « Tuile » : SVG avec et sans le nom (vectorisé), icône, aperçu GitHub
```

Pas de base de données, pas de clé d'API, pas de build front : les pages sont
des fichiers statiques, modules ES compris, et lisent le point dans leur URL.

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
- **Les modules d'une page s'évaluent dans l'ordre de leurs effets.** `main.js`
  les importe dans cet ordre, et aucun n'importe un module à effets placé plus
  loin : ES l'évaluerait avant lui, et les attentes de la scène changeraient
  d'ordre (le relief posé avant les bâtiments, ou l'inverse). Un module venu
  avant s'inscrit chez le suivant (`poserSurLeRelief`, `ajouterCiblesSurvol`,
  `citerSource`, `quandLeFondChange`…) ou passe par un rappel
  (`redessinerBatiments`) ; `outils/verifier-modules.mjs` le vérifie. Un état
  n'est réaffecté que par son module : les autres appellent ses fonctions.
- **La géométrie d'un houppier ne doit jamais se retourner** : rayon croissant
  avec la couronne, hauteur décroissante du sommet au bord, dessous qui remonte
  vers le tronc, lobage partagé par tous les anneaux. Un défaut ici passe
  inaperçu à forte opacité et saute aux yeux à 30 %.

## Méthode de travail

- **Mesurer avant de changer un seuil.** Chaque constante des modules de calcul
  porte en commentaire la mesure qui l'a fixée. Un nouveau seuil se justifie de
  la même façon, sur des données réelles.
- **La géométrie se vérifie en exécutant le vrai code**, pas en le relisant :
  extraire les fonctions des modules de la page (`outils/source-page.mjs`) et
  les exécuter sous Node avec un THREE minimal a trouvé des facettes
  retournées que la lecture avait ratées.
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
