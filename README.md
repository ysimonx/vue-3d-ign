<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo/logo-sombre.svg">
    <img src="docs/logo/logo-clair.svg" alt="Vue 3D IGN" width="440">
  </picture>
</h1>

Une vue 3D de n'importe quel lieu de France métropolitaine, reconstruite à partir
des **données ouvertes de l'IGN** : on donne une adresse, un lieu ou des
coordonnées, on obtient les bâtiments avec leurs vrais toits, les arbres un par un, le relief et
la photo aérienne, sous un soleil qui suit sa vraie course.

**▶ Démo en ligne : [vue-3d-ign.kysoe.com](https://vue-3d-ign.kysoe.com)** — par
exemple [Gordes](https://vue-3d-ign.kysoe.com/?lat=43.9116&lon=5.2003), ou
n'importe quelle adresse dans le champ de recherche. Le service tourne sur
une machine personnelle : une scène neuve met de quelques secondes à une
minute à se construire, et le nombre de scènes neuves par heure est limité.

![Le village de Gordes, au 21 décembre à 13 h](docs/capture-gordes.jpg)

*Gordes (Vaucluse) au 21 décembre à 13 h : 249 bâtiments, 2 160 houppiers,
84 m de relief. Orthophoto et données © IGN.*

Aucune clé d'API, aucune base de données : un script (ou un conteneur
Docker), un cache disque, et les services publics de la
[Géoplateforme](https://geoservices.ign.fr/).

![Démo : la tour Eiffel en points LiDAR, l'orbite, les ombres au fil des heures, les véhicules lus sur la photo aérienne](docs/demo/demo-readme.gif)

*Quatorze secondes de la démo : la tour Eiffel en points du nuage LiDAR HD,
l'orbite, les ombres au fil des heures, les véhicules lus sur la photo aérienne.
La démo complète, commentée, se fabrique avec `outils/demo-video.mjs`
(voir [Développer](#développer)).*

## Démarrer

Sur un Mac, sans Docker :

```bash
./run_macOS_CoreML.sh
```

Puis ouvrir <http://localhost:8080/> : sans paramètre, la page propose de se
géolocaliser et s'ouvre là où l'on est ; sans position (refusée, sans
réponse au bout de 10 s, hors de France métropolitaine, ou hors https), sur
la tour Eiffel, en points du nuage LiDAR HD. Un autre lieu se cherche dans le panneau — adresse, lieu
nommé (« château de Chambord », « mairie bouc bel air »), entreprise ou
commerce (« pharmacie bouc bel air ») ou coordonnées collées, avec
suggestions dès la frappe — ou se donne dans l'URL (`?lat=…&lon=…`). Les flèches N, E, S et O,
au bord de la vue, décalent la scène d'un quart de zone dans leur direction.
La zone chargée mesure par défaut 1 000 m du nord au
sud ; le sélecteur **Zone** du panneau la règle de 350 à 1 000 m, et
`&zone=…` dans l'URL de 150 à 2 000 m (arrondie à 50 m) — 2 000 m n'est pas
proposé au sélecteur, la vue y rame. Le temps de construction suit la surface et
la densité du bâti : à 1 000 m, 4 s à Gordes et 6 s à Strasbourg sur un Mac
M4 hors conteneur, 4 et 4,5 s dans le conteneur ; à 2 000 m, 9,5 s à Gordes,
et le service ne construit qu'une zone de plus de 1 000 m à la fois (3,2 Go
de mémoire au pic). Le nuage LiDAR HD n'y couvre que le kilomètre central.
Sans `zone=`, l'API garde une emprise d'environ 356 m, que la page ne
demande plus.

La **première** ouverture d'un lieu construit sa scène en quelques secondes
(1 s en zone de 350 m), le temps de
télécharger une grille de hauteurs à 0,5 m, d'y mesurer les toits et d'y
segmenter les arbres.
Les ouvertures suivantes sont instantanées, la scène étant gardée sur disque
dans `./cache`. Le lien **↻ Reconstruire la scène** du panneau la relit à
l'IGN, avec ses couches, au plus une fois toutes les 10 minutes. Pour changer
de port : `VUE3D_PORT=9000 ./run_macOS_CoreML.sh`.

Seul prérequis : [uv](https://docs.astral.sh/uv/) (`brew install uv`) ou
`python3.12`. Au premier lancement, le script prépare tout seul :

- **le `.venv`**, en Python 3.12 comme l'image Docker. Il refuse un `.venv`
  dans une autre version : en 3.14, la segmentation des arbres rend
  0 houppier sans la moindre erreur. À chaque lancement, il y installe les
  versions exactes des dépendances, une fraction de seconde quand elles y
  sont déjà ;
- **les réseaux** des véhicules dans `./modeles`
  (`outils/preparer_modeles.sh`) : environ 1 Go à télécharger dans un
  environnement jetable, effacé ensuite, et une minute sur un Mac M4. Le
  script active les deux détecteurs (`VUE3D_VEHICULES=tous`), parce que
  c'est sa raison d'être : sur un Mac, ils tournent sur CoreML, que le
  conteneur n'atteint pas (voir plus bas). `VUE3D_VEHICULES=aucun
  ./run_macOS_CoreML.sh` s'en passe, et n'exporte rien.

Il prend les mêmes variables que `docker-compose.yml` (`VUE3D_VEHICULES`,
`VUE3D_PANNEAUX=oui`, `VUE3D_PORT`), et `VUE3D_MOTEUR`. Ses fichiers sont à
côté du dépôt, ignorés par git : `./cache` pour les scènes, `./modeles` pour
les réseaux. Après un `git pull`, le relancer suffit : il remet les
dépendances à jour. Pour repartir de zéro, scènes comprises : `rm -rf
./cache`, et chaque lieu sera reconstruit à sa première ouverture.

Le service calcule les toitures sur un bassin de processus, un par cœur et
seize au plus, qui naît à son démarrage (`VUE3D_TOITS_PROCESSUS=1` pour s'en
passer, au prix de toitures cinq à dix fois plus lentes sur les grandes
scènes). Chacun occupe 100 à 280 Mo sous macOS après de grandes scènes,
environ 30 Mo dans le conteneur.

Ouvert sur Internet, le service peut limiter les scènes neuves de chaque
visiteur : avec `VUE3D_QUOTA=20`, une même adresse IP ne fait construire que
vingt lieux par heure glissante. Au-delà, elle reçoit une erreur 429 avec
`Retry-After`, que la page affiche. Chaque scène neuve coûte une trentaine
de requêtes à la Géoplateforme, qui limite l'adresse du serveur ; les scènes
en cache restent ouvertes à tous et ne comptent pas. Derrière un proxy
(Caddy, nginx), `VUE3D_PROXY=1` prend l'adresse du visiteur dans
`X-Forwarded-For` : sans lui, tous les visiteurs ont celle du proxy, et se
partagent un seul quota. Sans proxy, ne pas le poser : chacun
s'inventerait une adresse par requête. Ni l'un ni l'autre par défaut.

Les tuiles de fond (orthophoto, Plan IGN) passent par le serveur, qui en
garde certaines : la Géoplateforme refuse par épisodes une tuile qui existe.
Le navigateur les lit à l'IGN, où le serveur le redirige ; une tuile refusée,
le serveur la relit lui-même, la garde dans `VUE3D_CACHE/tuiles` et la sert
désormais à tous. Une tuile gardée est effacée au bout de 90 jours. Avec un
quota de scènes, une même adresse IP fait relire au plus 1 000 tuiles par
heure.

### Avec Docker

Le même service, sur le même port, partout où Docker tourne :

```bash
docker compose up -d
```

Les scènes sont gardées dans le volume `scenes`. Pour changer de port :
`VUE3D_PORT=9000 docker compose up -d`. Après une mise à jour du code, il
faut reconstruire l'image : le code y est copié, `docker compose up -d` seul
relancerait l'ancienne.

```bash
docker compose up -d --build
```

Pour repartir de zéro, scènes comprises :

```bash
docker compose down -v
docker compose up -d --build
```

`-v` supprime le volume `scenes` : chaque lieu sera reconstruit à sa première
ouverture. `run_docker.sh` enchaîne ces deux commandes avec
`VUE3D_VEHICULES=tous` : il **efface les scènes du volume** à chaque
lancement, puis reconstruit l'image avec les deux détecteurs.

```bash
./run_docker.sh                              # Docker, depuis zéro, les deux détecteurs
```

Le conteneur et le script macOS ne peuvent pas écouter le même port : le
script refuse de démarrer, en disant quoi faire, si le port est déjà écouté
(`docker compose stop` libère celui du conteneur ; revenir à Docker : Ctrl-C,
puis `docker compose start`). Les réseaux et les scènes d'une image déjà
construite se copient vers le script, ce qui évite l'export et la
reconstruction :

```bash
docker cp vue-3d-ign-vue3d-1:/modeles ./modeles
docker cp vue-3d-ign-vue3d-1:/cache ./cache       # facultatif : les scènes déjà construites
```

### Avec container, l'outil d'Apple

Sur un Mac Apple silicon sous macOS 26,
[`container`](https://github.com/apple/container) remplace Docker Desktop :
il construit le même `Dockerfile` et fait tourner chaque conteneur dans sa
propre petite machine virtuelle Linux.

```bash
brew install container                       # une fois
./run_container.sh                           # sans détecteur, comme docker compose
VUE3D_VEHICULES=tous ./run_container.sh      # les deux détecteurs, au processeur
```

Le script prend les variables de `docker-compose.yml`, avec les mêmes
défauts (`VUE3D_VEHICULES`, `VUE3D_PANNEAUX=oui`, `VUE3D_PORT`). Il démarre
le service `container` s'il ne tourne pas (le premier lancement installe le
noyau Linux), reconstruit l'image, remplace le conteneur précédent et attend
que le service réponde. Les scènes sont gardées dans le volume
`vue-3d-ign-scenes`, distinct du volume `scenes` de Docker.

```bash
container logs -f vue-3d-ign                 # journaux
container stop vue-3d-ign                    # arrêt ; relancer le script pour repartir
container volume rm vue-3d-ign-scenes        # oublier les scènes (conteneur arrêté)
container builder stop                       # rendre les 2 Go de la machine de construction
container system stop                        # tout éteindre
```

Ce qui change par rapport à Docker :

- **Pas de CoreML.** Le conteneur est un Linux, qui ne voit ni le Neural
  Engine ni le GPU : les détecteurs y tournent au processeur, comme sous
  Docker. Pour CoreML, `run_macOS_CoreML.sh`.
- **Des ressources fixées par conteneur.** `container` donne 1 Go et
  4 cœurs par défaut ; le script donne au service tous les cœurs et 4 Go
  (`VUE3D_CPUS`, `VUE3D_MEMOIRE`), puisqu'il monte à 2 Go avec `tous` en
  zone de 1 000 m. Docker Desktop partage au contraire une seule machine
  virtuelle entre tous ses conteneurs.
- **La machine de construction reste allumée** après une construction,
  avec ses 2 Go, jusqu'à `container builder stop`. Ils suffisent à exporter
  les deux réseaux, mais elle n'a que 2 cœurs : l'image `tous` s'y construit
  en 82 s, contre 69 s sous Docker Desktop avec dix cœurs (une mesure
  chacun, sur un Mac à dix cœurs).
- **Rien ne relance le conteneur** après un redémarrage du Mac : `container`
  n'a pas de politique de redémarrage. Il faut relancer le script.
- **Un volume neuf appartient à root**, là où Docker lui donne le
  propriétaire du dossier de l'image : le script le confie à l'utilisateur
  du service avant de démarrer, sinon aucune scène ne s'écrirait.

Le port est publié sur toutes les interfaces, comme avec Docker. Le script
refuse de démarrer si un autre service l'écoute déjà : `docker compose
stop` libère celui du conteneur Docker, sinon `VUE3D_PORT=8081
./run_container.sh`.

### Les véhicules, les piscines et les bateaux, en option

L'orthophoto montre des véhicules, des piscines et des bateaux ; un réseau
de neurones peut les y lire, et la vue les pose en volume. C'est une option : `tous`
par défaut dans `run_macOS_CoreML.sh`, désactivée dans l'image Docker, où
c'est un choix de construction :

```bash
VUE3D_VEHICULES=rtmdet ./run_macOS_CoreML.sh          # aucun | rtmdet | yolo | tous
docker compose down -v && VUE3D_VEHICULES=rtmdet docker compose up -d --build
```

| `VUE3D_VEHICULES` | Détecteur | Véhicules à Gordes | à Carcassonne | Piscines | Calcul par lieu |
|---|---|---|---|---|---|
| `aucun` (défaut) | — | — | — | — | — |
| `rtmdet` | RTMDet-R s (MMRotate, Apache-2.0) | 91, dont 22 des 61 d'un parking serré | 178 | 13 et 9 | 1 à 5 s |
| `yolo` | YOLO11s-OBB (Ultralytics, **AGPL-3.0**) | 146, dont 48 des 61 | 140 | 8 et 8 | 5 à 30 s |
| `tous` | l'union des deux | 169, dont 49 des 61 | 188 | 14 et 9 | 6 à 36 s |

Temps de calcul sur l'emprise de 356 m, mesurés sur un Mac à dix cœurs, hors
conteneur (CoreML) puis dans le conteneur ; quatre fois plus en zone de
1 000 m.
La scène n'attend pas ces calculs, et chaque résultat s'affiche dès qu'il est
prêt : les piscines une demi-seconde après la scène, les bateaux une
demi-seconde après elles, puis les véhicules détecteur par détecteur,
`rtmdet` avant `yolo`. Sur le processeur (le
conteneur), ils s'interrompent tant qu'une scène se construit, 30 s au plus
par tuile, pour lui laisser les cœurs.
Aucun des deux réseaux ne suffit partout : `rtmdet` lit mal un parking serré,
`yolo` est meilleur là et moins bon ailleurs ; pour les piscines, c'est
`rtmdet` qui voit le mieux.

À savoir avant de choisir :

- **Les poids ne sont pas dans le dépôt.** La construction de l'image les
  télécharge chez leurs auteurs et les convertit (une à deux minutes ;
  165 Mo de plus pour un détecteur, 240 Mo pour les deux). Ceux de YOLO sont sous AGPL-3.0 : c'est vous qui les
  embarquez en choisissant `yolo` ou `tous`. Et les deux réseaux sont
  entraînés sur [DOTA](https://captain-whu.github.io/DOTA/dataset.html), dont
  les images sont réservées à un usage académique.
- **La mémoire.** Avec `tous`, le service occupe dans le conteneur jusqu'à
  1,2 Go sur l'emprise de 356 m et 2 Go en zone de 1 000 m, contre 0,4 et
  0,9 Go sans détecteur : plusieurs tuiles passent à la fois dans chaque
  réseau.
- **Changer d'option recalcule la couche des véhicules** de chaque lieu, et
  sous Docker reconstruit l'image (une par détecteur) ; les scènes, elles,
  restent en cache. Pour garder le choix d'un lancement à l'autre, l'inscrire
  dans un fichier `.env` à côté de `docker-compose.yml`.
- **Un terrain n'est détecté qu'une fois.** Ce que les réseaux voient est
  gardé par rectangle de terrain (`./cache/releves`) : après une flèche de
  décalage, seule la bande nouvelle est détectée — 4 s au lieu de 9 à
  Gordes, 23 au lieu de 64 en zone de 1 000 m (CoreML). La première
  ouverture d'un lieu en coûte 10 à 20 % de plus : chaque détection déborde
  un peu de son rectangle, pour voir entier ce qui chevauche sa limite.
- **Ce sont les véhicules du jour de la prise de vue**, et seulement ceux que
  le réseau a reconnus : voir [Limites](#limites).
- **La variable s'appelle `VUE3D_VEHICULES` et apporte aussi les piscines
  et les bateaux** : la même lecture de l'orthophoto, une demi-seconde à une
  seconde de plus chacune. Chacune a son bouton dans la page. Loin de l'eau,
  la couche des bateaux est vide.

### Les panneaux solaires, en option

Une seconde option, indépendante de la première, pose sur les toits les
installations photovoltaïques du registre [OpenPVMapper](https://doi.org/10.5281/zenodo.19188878)
de Gabriel Kasmi (Mines Paris-PSL) : DeepPVMapper, son détecteur, a été passé
sur toute la France, et le résultat est publié sous CC-BY 4.0 — 471 449
installations résidentielles en toiture, chacune avec son polygone, sa
surface, sa puissance estimée et l'année de la photo. Ici aucun réseau ne
tourne : la construction de l'image télécharge le registre (211 Mo) et en
fait une base à index spatial (119 Mo), qu'une scène lit en quelques
millisecondes. Sans Docker, c'est `outils/preparer_panneaux.py` qui prépare
la base dans `./donnees`.

```bash
VUE3D_PANNEAUX=oui ./run_macOS_CoreML.sh
VUE3D_PANNEAUX=oui docker compose up -d --build
```

Les deux options se combinent, chacune avec son image sous Docker. Tout à
la fois — véhicules des deux détecteurs, piscines et panneaux solaires :

```bash
VUE3D_PANNEAUX=oui ./run_macOS_CoreML.sh              # les deux détecteurs y sont déjà
VUE3D_VEHICULES=tous VUE3D_PANNEAUX=oui docker compose up -d --build
```

Pour garder ce choix d'un lancement à l'autre, écrire les deux lignes dans un
fichier `.env` à côté de `docker-compose.yml`. Ce que la couche affirme, et ne dit pas : les
installations que le registre connaît, sur des photos de 2018 à 2024 ; il en
manque et il en invente, comme tout détecteur, et une installation peut être
décalée d'un ou deux mètres par rapport à notre orthophoto, prise une autre
année. Ni centrales au sol ni grandes toitures : le registre s'arrête à
36 kWc. Le registre ne dit pas la hauteur : chaque polygone est posé sur le
toit tel que la vue le dessine.

À la main, sans le script ni Docker, **avec Python 3.12**, celui de l'image :

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
VUE3D_CACHE=./cache flask --app vue3d.app run --port 8080
```

Les véhicules, à la main : exporter les réseaux une fois (dans un
environnement jetable, avec les versions de l'étage `export` du
`Dockerfile`), puis lancer le serveur avec le moteur d'inférence. C'est ce
que `run_macOS_CoreML.sh` fait.

```bash
outils/preparer_modeles.sh rtmdet ./modeles           # rtmdet | yolo | tous
pip install -r requirements-vehicules.txt               # dans .venv
VUE3D_VEHICULES=rtmdet VUE3D_MODELES=./modeles VUE3D_CACHE=./cache flask --app vue3d.app run --port 8080
```

Sur un Mac, les réseaux tournent alors sur CoreML, que le conteneur Docker
n'atteint pas : à Gordes, 0,8 s au lieu de 2,8 pour `rtmdet` et 5 s au lieu
de 16 pour `yolo` (M4), pour les mêmes couches, à l'octet. En zone de
1 000 m, les piscines suivent la scène d'une seconde ou deux, `yolo` d'une
demi-minute.
`VUE3D_MOTEUR=processeur` s'en passe ; `coreml` l'exige ; sans la variable,
CoreML est pris là où onnxruntime l'a, le processeur ailleurs.

Pas Python 3.14 : avec les mêmes versions de numpy et shapely, la segmentation
des arbres y rend 0 houppier sans la moindre erreur (2 160 en 3.12 sur Gordes,
mêmes données). Et comme le cache ne périme pas, une scène construite ainsi
resterait fausse.

### DPE, ventes immobilières et bornes de recharge, à la demande

Trois boutons du panneau, éteints à l'ouverture : rien n'est demandé à
l'ADEME, à DVF ni à data.gouv.fr tant qu'on ne clique pas, et rien n'est à
installer.

- **DPE** colore chaque bâtiment qui a des diagnostics de performance
  énergétique selon son étiquette énergie médiane, de A (vert) à G (rouge),
  murs et toit. La fiche d'une maison liste ses DPE (date, étiquettes
  énergie et climat, surface, consommation, validité) ; celle d'un
  immeuble n'en donne que la répartition des étiquettes, la médiane et la
  période. Ce sont les DPE des logements établis depuis juillet 2021 (les
  précédents ne sont plus valables), existants et neufs, de
  l'[ADEME](https://data.ademe.fr/datasets/dpe03existant). Un DPE désigne
  son bâtiment par son identifiant au Référentiel national des bâtiments
  quand il l'a (six sur dix sur huit lieux mesurés), sinon par son point
  d'adresse, à 5 m près : la fiche le dit, le bâtiment peut alors être le
  voisin. Un DPE sans bâtiment à moins de 5 m est une pastille au sol, à son
  adresse.
- **Ventes DVF** teinte les parcelles vendues depuis cinq ans (2021 à 2025
  aujourd'hui) par leur prix au m² médian, en cinq classes aux quintiles de
  l'emprise, et le bâtiment posé dessus en prend la couleur ; un contour
  cyan le distingue même quand les DPE le colorent. Le survol donne les
  dernières ventes, le clic toutes celles de la parcelle (un résumé au-delà
  de huit) ; le panneau donne le prix médian des maisons et des
  appartements. Le prix n'est ramené au m² que pour la vente d'un seul
  logement, sur sa surface bâtie déclarée. Sources : les fichiers
  [DVF géolocalisées](https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/)
  d'Etalab (DGFiP) et le Parcellaire Express de l'IGN, joints par
  l'identifiant de parcelle. **Pas de DVF en Alsace-Moselle**, où la
  publicité foncière relève du livre foncier : la page le dit.
- **Bornes de recharge** pose une borne par station de recharge pour
  véhicules électriques, et au-dessus d'elle une pastille à éclair teinte de
  sa puissance la plus haute (jusqu'à 22 kW, 23 à 149 kW, 150 kW et plus),
  de taille constante à l'écran pour se trouver de loin ; une station sous
  un toit (parking souterrain) a sa pastille au-dessus du toit. Le survol ou
  le toucher donne l'opérateur, le nombre de points de charge, les
  puissances, les prises, l'accès et les horaires ; le clic l'épingle, avec
  « Recentrer la scène » et « Y aller ». Source : la
  [Base nationale des IRVE](https://www.data.gouv.fr/fr/datasets/5448d3e0c751df01f85d0572/),
  consolidée chaque jour par data.gouv.fr, lue sur l'emprise par son API
  tabulaire.

Les trois sont datés (« lus le … ») et gardés en cache avec la scène ;
« Reconstruire la scène » les relit. Une seconde ou deux à la première
lecture, en zone de 356 m. Les conditions de réutilisation de DVF
interdisent de réidentifier les personnes et de laisser les moteurs de
recherche indexer ces données : la page ne les publie nulle part.

### L'ensoleillement des toits, à la demande

Le bouton **Ensoleillement** peint chaque toit du soleil qu'il reçoit sur une
année, en kWh/m²/an, du brun (peu) au jaune pâle (le meilleur plan du lieu).
Le survol donne la valeur au point ; la fiche du bâtiment donne celle de son
toit en moyenne et au mieux, ce que l'ombre lui fait perdre, sa surface en
pente et sa surface **favorable** — au moins 70 % du meilleur plan dégagé du
lieu, et non un seuil fixe, qui peindrait tout le Midi et presque rien du
Nord —, et un ordre de grandeur de la puissance et de la production possibles.

Le climat est l'année type de [PVGIS](https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_fr),
le service de la Commission européenne : le direct et le diffus de chacune
de ses 8 760 heures, mesurés par satellite de 2005 à 2023, l'ombre du relief
lointain déjà ôtée. Le reste de l'ombre est celle de la vue, calculée par le
navigateur sur la carte graphique : environ 250 positions du soleil et 76
directions du ciel, chacune une carte d'ombre de toute la scène —
bâtiments et toits tels que dessinés, arbres, relief et anneau jusqu'à
4 km — cumulées sur une grille des toits à 0,5 m. Un arbre laisse passer
3 % du soleil en feuilles et 46 % sans (Konarska et al., 2014) : un pin, un
résineux ou un chêne vert toute l'année au premier taux, un feuillu au second
du 26 octobre au 7 avril (chêne pédonculé, réseau RENECOFOR de l'INRAE).
En zone de 1 000 m sur un Mac M4 : 1,5 s à la tour Eiffel, 2,4 s à Gordes, 3,6 s à Strasbourg ; 8 s en
zone de 2 000 m. Le diffus suit le modèle de Muneer, celui de PVGIS : sur un
plan dégagé, le calcul reste à 3 % près de PVGIS sur les plans favorables de
quatre lieux (`outils/verifier-solaire.mjs`).

La production suppose des panneaux sur 70 % de la surface favorable, à
0,21 kWc/m², et un rendement du système de 0,79, celui que PVGIS donne pour
des pertes de 14 % : un ordre de grandeur, pas une étude. Le climat est lu au
premier clic, daté, et gardé avec la scène ; « Reconstruire la scène » le
relit.

### Partager une vue

Le bouton de partage, sur la vue, donne un lien qui la rouvre telle quelle :
la caméra à sa place, le soleil au jour et à l'heure choisis, et les couches
allumées ou éteintes comme elles l'étaient — l'ensoleillement des toits ou
les DPE se recalculent ou se relisent à l'ouverture. Au doigt, il ouvre la
feuille de partage de l'appareil ; ailleurs, il copie le lien. Le lien ne
garde que ce qui diffère d'une ouverture ordinaire : une vue laissée au jour
du jour et à midi s'ouvre au jour de qui la reçoit.

### Export BIM et SIG, en IFC 4 et CityGML 2.0

Deux boutons du panneau écrivent le contexte du lieu : le relief de
l'emprise, les bâtiments, les arbres et, si on les allume, les masses de
sursol. Le navigateur écrit le fichier lui-même, en une à quelques secondes.

- **IFC 4**, pour un logiciel de conception — Revit, ArchiCAD, Vectorworks,
  Allplan, Bonsai : des maillages, autour d'une origine au point visé. 5 à
  9 Mo dans l'emprise de 356 m, environ 25 Mo en zone de 1 000 m, 35 avec
  les masses.
- **CityGML 2.0**, pour les SIG et les maquettes urbaines — FME, 3DCityDB,
  FZKViewer : bâtiments en LOD2, une surface de toit, de mur ou de sol par
  face plane, une partie par emprise ; arbres en objets de végétation ;
  relief en TIN ; coordonnées absolues. Plus lourd : 47 Mo à Gordes, jusqu'à
  170 Mo en zone de 1 000 m avec les masses.

Pour l'un comme pour l'autre :

- **Les bâtiments tels qu'affichés** : les boutons « Toits en pente »,
  « Toits mesurés » et « Monuments OSM » décident de ce qui part, mais sans
  exagération du relief et à leur hauteur mesurée. Un élément par bâtiment
  BD TOPO, avec son identifiant, son usage, ses étages, sa hauteur et d'où
  elle vient, la forme de son toit.
- **Les arbres en forme simple**, houppier et tronc, à la hauteur et à
  l'emprise mesurées au LiDAR HD, avec l'essence dominante de leur massif
  quand la BD Forêt la donne ; le relief à 2 m, 4 m en zone de 1 000 m.
- **En Lambert-93, altitudes NGF.** Les longueurs sont celles de la carte :
  de −1 à +2,2 mm/m selon la latitude. L'IFC rapporte ses coordonnées à une
  origine entière au point visé (IfcMapConversion) et renseigne le nord vrai
  pour les études d'ensoleillement ; le CityGML les écrit en absolu.
- Un contexte à consulter et à couper, pas des murs ni des dalles à
  modifier. Chaque fichier cite ses sources ; avec des parties de monuments
  OSM, il est aussi sous ODbL.

C'est une maquette de contexte, pas un relevé : les emprises de la BD TOPO
sont à un mètre près, un toit résumé n'a que deux pans ou une pyramide, et
réservoirs, murs, ponts, eau, routes et ouvrages dessinés en points (la tour
Eiffel) ne sont pas encore exportés.

## Lieux à essayer

Des lieux publics qui montrent chacun un aspect de la vue. Les chiffres sont ceux
des scènes construites en septembre 2026 ; ils suivent les mises à jour de l'IGN.

| Lieu | Ce qu'il montre |
|---|---|
| [Gordes, village](https://vue-3d-ign.kysoe.com/?lat=43.9116&lon=5.2003) | Village perché : 84 m de relief sur l'emprise, 242 m dans l'anneau, 2 160 houppiers |
| [Château de Versailles, cour](https://vue-3d-ign.kysoe.com/?lat=48.8049&lon=2.1204) | Un monument plus grand que la scène : coupé à son bord, le château garde la surface mesurée de ses toits et ses cours ouvertes ; 146 arbres des jardins |
| [Rocamadour, basilique](https://vue-3d-ign.kysoe.com/?lat=44.7994&lon=1.6177) | Sanctuaire accroché à la falaise : 130 m de dénivelé sous les bâtiments |
| [Chamonix, église](https://vue-3d-ign.kysoe.com/?lat=45.9232&lon=6.8733) | Fond de vallée : l'anneau monte de 624 m sur les pentes alentour |
| [Abbaye du Mont-Saint-Michel](https://vue-3d-ign.kysoe.com/?lat=48.6360&lon=-1.5114) | Le rocher et sa baie. Hors LiDAR HD : l'abbaye est reprise au modèle 3D d'OpenStreetMap, flèche comprise |
| [Saint-Malo, cathédrale](https://vue-3d-ign.kysoe.com/?lat=48.6495&lon=-2.0256) | Ville close dense (249 toits mesurés) ; la mer laisse un tiers de l'anneau vide |
| [Cité de Carcassonne](https://vue-3d-ign.kysoe.com/?lat=43.2065&lon=2.3640) | 30 murs de rempart, de 3 à 25 m, et 291 bâtiments serrés sur 44 m de relief |
| [Notre-Dame de Paris](https://vue-3d-ign.kysoe.com/?lat=48.8530&lon=2.3499) | L'île de la Cité et 807 arbres des quais et des squares, la cathédrale reprise à OpenStreetMap ; ni arbre dans la Seine, ni grue de chantier prise pour un arbre de 88 m |
| [Cathédrale de Strasbourg](https://vue-3d-ign.kysoe.com/?lat=48.5819&lon=7.7510) | Tissu médiéval en plaine : toits LiDAR à plusieurs corps, et la cathédrale reprise à OpenStreetMap |
| [Château de Chambord](https://vue-3d-ign.kysoe.com/?lat=47.6162&lon=1.5171) | Le château isolé dans son domaine boisé : donjon et tours mesurés au LiDAR au-dessus des terrasses, enceinte sous sa photo aérienne, 475 houppiers |
| [Pont du Gard](https://vue-3d-ign.kysoe.com/?lat=43.9475&lon=4.5350) | Deux ponts réduits à leur tablier, faute d'arches dans la BD TOPO : l'aqueduc à 48 m du Gardon, le pont routier à 21 m |
| [Raffinerie de Feyzin, parc de stockage](https://vue-3d-ign.kysoe.com/?lat=45.6734&lon=4.8409) | 30 citernes à leur hauteur BD TOPO, dont 14 que le LiDAR ne voit pas ; hors du sursol, elles ne se couvrent plus de faux arbres (82 houppiers et masses, contre 545) |

Chaque premier chargement construit la scène, en quelques secondes.

## Ce que montre la vue

- **Les bâtiments et leurs toits.** Les murs montent à la gouttière et le toit
  rejoint le faîtage, **mesurés au LiDAR HD** quand la mesure est fiable, sinon
  déclarés par la BD TOPO. Un bâtiment en ailes reçoit un toit par corps, chacun
  sur son propre faîtage. Le bouton **Toits mesurés** remplace ce toit résumé
  là où il manque le LiDAR de plus de 0,7 m — moitié surélevée, faîtage
  décentré, îlot autour d'une cour — par des **pans** : quelques plans ajustés
  au LiDAR, faîtages nets, fermés par leurs murs. Un toit qui n'est pas fait de
  plans garde la surface même du LiDAR, plus granuleuse. Le bouton est allumé
  au départ ; éteint, tous les toits reprennent leur forme résumée. Les cours
  intérieures restent ouvertes, et un bâtiment plus grand que la scène — le
  château de Versailles, 410 m de long — est coupé à son bord et mesuré comme
  les autres ; sa fiche le dit. Un toit ne dépasse jamais de son bâtiment, et
  un toit plat porte la photo aérienne : vue du ciel, la scène se lit comme
  l'orthophoto.
- **Le bâtiment visé**, qui contient le point ou, à défaut, le plus proche à
  moins de 25 m, est en orange et sa fiche s'ouvre d'elle-même : BD TOPO,
  mesures LiDAR, distance au point, forme du toit dessiné. Un clic sur un autre
  bâtiment ouvre la sienne, avec un lien Street View orienté depuis la rue.
- **Les monuments en 3D OpenStreetMap** (`building:part`), là où la vue ne
  sait pas faire mieux : sans LiDAR HD, l'abbaye du Mont-Saint-Michel n'était
  qu'un prisme coiffé d'un toit inventé ; ses 31 parties OSM — flèche à 79 m,
  tour-lanterne, La Merveille — la remplacent. Là où le LiDAR mesure, il fait
  foi : seuls les bâtiments dont il ne sait rien (sous les arbres, profil
  rejeté) sont repris à OSM — la cathédrale de Strasbourg, que la règle
  « sous les arbres » écrasait à 3 m, y gagne son modèle complet. Le bouton
  **Monuments OSM** débraye la couche ; il n'apparaît que si la vue en dessine
  des parties. Elles arrivent après la scène : OpenStreetMap répond de 0,6 s à
  plus de 100 s, la vue ne l'attend pas et réessaie s'il ne répond pas ; une
  roue tourne en haut de la vue tant que la couche est attendue.
- **Les réservoirs et les constructions élevées** de la BD TOPO : citernes et
  châteaux d'eau montés à leur hauteur, torchères, cheminées, antennes et mâts
  d'éclairage. La hauteur est celle de la BD TOPO, à défaut celle que le LiDAR
  mesure ; l'infobulle dit laquelle. Une construction dont ni l'une ni l'autre
  ne donne la hauteur n'est pas dessinée, et un réservoir sans hauteur reste
  pâle, comme un bâtiment sous les arbres. Le bouton **Réservoirs, mâts**
  débraye la couche ; il n'apparaît que si la scène en contient.
- **Les murs, les ponts, les voies ferrées et les terrains de sport** : les
  remparts de Carcassonne à la hauteur de leurs courtines, les tabliers des
  ponts à leur altitude, les voies ferrées et tramways en rubans de ballast,
  les terrains, pistes et bassins en aplats. Cette couche arrive après la
  scène, comme les monuments OSM, et se débraye par le bouton **Murs, ponts,
  rails** ; les masses de sursol qu'un mur ou un tablier explique lui laissent
  alors la place.
- **L'eau** : lacs, retenues, bassins et rivières larges en nappes, ruisseaux en
  rubans de la largeur de leur classe, posés sur le relief.
- **Les routes**, en rubans sur le relief, à leur largeur de chaussée.
- **Les lignes à haute tension** de RTE (63 à 400 kV), jusqu'à un kilomètre
  alentour : pylônes à leur hauteur, câbles tendus entre eux. Le réseau de
  distribution d'Enedis n'est pas dans la BD TOPO.
- **Les arbres, un par un.** La végétation est segmentée houppier par houppier
  sur le modèle de hauteur à 0,5 m. Chaque arbre garde sa hauteur, son emprise,
  son allongement et son profil mesurés : un pin parasol a un sommet plat, un
  cyprès une pointe. Rien ne pousse sur l'eau, ni ne dépasse 40 m hors des
  forêts : ce que le modèle de hauteur y montre n'est pas un arbre.
- **Le relief**, drapé de la photo aérienne ou du Plan IGN, avec une
  exagération réglable. Autour de la scène, un anneau de relief plus grossier
  s'étend sur 2 km de côté : les coteaux voisins cadrent le lieu et portent
  leur ombre quand le soleil rase.
- **L'horizon** : au-delà de l'anneau, le paysage jusqu'à 60 km, en tuiles
  d'autant plus grossières qu'elles sont loin de la caméra, sous un ciel qui
  suit l'heure. Le Ventoux se voit de Gordes, la baie du Mont-Saint-Michel
  s'étend jusqu'à la mer. Le bouton « Horizon » rend le fond sombre d'avant.
- **Un drone**, au bouton en forme de quadricoptère, sur la vue sous la
  boussole : vu de derrière et piloté au clavier — flèches pour avancer et
  tourner, Q et D pour glisser, espace et Maj pour monter et descendre, la
  molette pour le recul de la caméra, Échap pour rendre la main à la souris.
  Sur un écran tactile, deux croix de touches à l'écran font de même. Il
  quitte la scène et survole l'horizon, sans jamais passer sous le sol ni
  dans un toit ; le curseur « vitesse » règle sa vitesse de pointe, jusqu'à
  216 km/h.
- **En voiture**, au bouton en forme de voiture, à côté du drone (ou
  `/voiture`) : une page à part, qui suit la position comme un GPS, sur un
  téléphone ou l'écran d'une voiture. La voiture est calée sur la route où
  l'on roule, vue de derrière (ou de dessus, bouton **2D**), avec sa vitesse
  et le nom de la rue ou le numéro de la route ; entre deux relevés du GPS,
  elle avance le long de la route. Le monde défile avec elle : la page
  prolonge la route devant soi sur le graphe de la BD TOPO (tout droit, sur
  la même voie, par la sortie d'en face aux ronds-points), la trace en bleu,
  et charge les bâtiments le long d'elle, sur 2 à 6 km selon la vitesse ; ce
  qui reste derrière est libéré. Ces bâtiments sont ceux de la BD TOPO seule,
  par carrés de 500 m : hauteurs et toits déclarés, sans LiDAR, mais 0,2 s
  par carré, quand une scène complète en demande 10 à 30. À 130 km/h sur
  l'A7, ils sont prêts 5,4 à 5,9 km devant la voiture. Les arbres suivent,
  sur 250 m de part et d'autre de la route et 2 km devant : ceux de la
  scène, découpés un par un sur le MNH du LiDAR HD, à leur hauteur et leur
  largeur mesurées, translucides, en cônes pour les conifères (bouton
  **Arbres**). Les routes sont des rubans sur le relief, à leur largeur de
  chaussée, et les ponts des tabliers à leur altitude BD TOPO, sur leurs
  piles : le viaduc de Millau franchit le Tarn, un pont passe au-dessus de
  l'autoroute. La caméra se tient à 17 m au-dessus de la voiture à
  l'arrêt, sans jamais changer d'angle : ce qui la sépare de la voiture,
  bâtiment ou arbre, s'efface. Les photos, le plan et les altitudes sont
  gardés dans le navigateur de la voiture : un trajet refait se charge
  aussitôt, même sans réseau ; ceux de la route prévue sont chargés
  d'avance sur 2 km, et une tuile manquée faute de réseau est redemandée
  plus tard. Le sol est fait des tuiles de l'orthophoto ou du Plan IGN
  (bouton **Plan**) posées sur le RGE ALTI, plus fines près de la caméra et
  là où la voiture sera dans quelques secondes. En rue étroite, les façades entre la caméra et la
  voiture s'ajourent ; la nuit, le ciel et la photo s'assombrissent. À côté
  du compteur, la limitation de vitesse de la route, dans le sens où l'on
  roule, et d'où elle vient : relevée dans OpenStreetMap (panneau rouge), ou
  estimée par la règle générale du code de la route — 50 km/h en
  agglomération, 80 sur une route, 110 à chaussées séparées, 130 sur
  autoroute — faute de donnée (panneau gris, « estimée ») ; aucune base
  nationale des limitations n'est publiée. Au-delà, la vitesse passe au
  rouge. Pour l'essayer sans rouler : `/voiture?simu=1&lat=…&lon=…&vitesse=90`, une
  conduite simulée (`vitesse=limite` : aux limitations) ; avec `&vers=lat,lon`, elle va quelque part, par le plus
  court chemin, l'itinéraire tracé en bleu et la distance qui reste affichée.
- **Sur téléphone, sur l'écran d'une voiture, ou en plein écran** (le bouton
  au-dessus du drone) : la vue prend tout l'écran, et le panneau devient un
  tiroir ouvert par ☰. Un bâtiment touché ouvre sa fiche par « Voir la fiche ».
  L'iPhone n'a pas de plein écran pour une page : ajoutée à l'écran d'accueil,
  elle s'ouvre sans la barre du navigateur.
- **Les véhicules**, si le service a été lancé avec un détecteur : ceux que
  l'orthophoto montre, à leur place et dans leur couleur du jour de la prise
  de vue, posés sur la pente. Longueur, largeur et orientation sont lues sur
  la photo ; la hauteur et la forme sont de convention, en trois gabarits
  (voiture, fourgon, autocar).
- **Les panneaux solaires**, avec une seconde option : les installations
  du registre OpenPVMapper, posées sur les toits tels qu'ils sont dessinés,
  avec leur surface, leur puissance estimée et l'année de la photo.
- **Les bateaux**, avec la même option : ceux que l'orthophoto montre sur
  l'eau — bassins des ports, lacs, rivières, et la mer, que la BD TOPO ne
  dessine pas —, à flot, dans la couleur de leur pont. 433 au port Hercule
  de Monaco, 283 en rade de Villefranche, 195 sur le lac d'Annecy, six
  péniches sous Notre-Dame. Longueur, largeur et axe sont lus sur la photo ;
  la coque, effilée aux deux bouts, et les superstructures sont de
  convention, en quatre gabarits (annexe, vedette ou voilier, yacht, grand
  yacht).
- **Les piscines**, avec la même option : celles que l'orthophoto montre,
  dans la couleur de leur eau ce jour-là. La BD TOPO n'a pas celles des
  particuliers. L'eau est de niveau, au sol du centre du bassin ; sur une
  pente, la cuve descend côté aval comme le mur d'une terrasse.
- **Le soleil**, à l'heure et au jour choisis : un curseur pour l'heure, un
  autre pour la saison, avec des crans aux solstices et à l'équinoxe. Les ombres
  portées suivent. Le panneau chiffre le **masque solaire au sud**, l'élévation
  du plus haut obstacle vu depuis la toiture du bâtiment visé ; le bouton
  **Ensoleillement** fait le compte de l'année entière, toit par toit.

## Les sources

Toutes servies sans clé par la Géoplateforme de l'IGN, sous
[Licence Ouverte Etalab 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/)
— sauf la dernière, la seule hors IGN du projet.

| Donnée | Service | Ce qu'elle apporte |
|---|---|---|
| BD TOPO, bâtiments | WFS `BDTOPO_V3:batiment` | Emprises, usage, hauteurs et altitudes de toit déclarées |
| BD TOPO, végétation | WFS `BDTOPO_V3:zone_de_vegetation` | Où est la végétation (haie, bois, forêt…), jamais sa hauteur |
| BD Forêt v2 | WFS `LANDCOVER.FORESTINVENTORY.V2:formation_vegetale` | Essence dominante d'un massif, pour la couleur des arbres |
| BD TOPO, routes | WFS `BDTOPO_V3:troncon_de_route` | Les routes, et le point de vue Street View posé sur la rue |
| BD TOPO, réseau électrique | WFS `ligne_electrique`, `pylone` | Lignes à haute tension et hauteur des pylônes |
| BD TOPO, réservoirs et constructions ponctuelles | WFS `reservoir`, `construction_ponctuelle` | Citernes et châteaux d'eau ; torchères, cheminées, antennes, mâts |
| BD TOPO, ouvrages | WFS `construction_lineaire`, `construction_surfacique`, `troncon_de_voie_ferree`, `terrain_de_sport` | Murs et ponts, par l'altitude de leurs sommets ; voies ferrées ; terrains de sport |
| LiDAR HD, MNH | WMS, grille BIL à 0,5 m | Hauteur de tout ce qui dépasse du sol : toits et arbres |
| LiDAR HD, nuage de points | Téléchargement, dalles COPC de 1 km² lues par plages | Le bâti en points ; les ouvrages ajourés (tour Eiffel, verrières) tels qu'ils sont mesurés |
| MNS − MNT | WMS, repli photogrammétrique | Le même, hors couverture LiDAR HD, en moins net |
| RGE ALTI | WMS, grille BIL ; WMTS, tuiles natives BIL | Le relief du terrain, l'anneau alentour et l'horizon |
| Orthophoto | WMS, WMTS | La photo aérienne, et l'indice de verdure qui reconnaît le feuillage |
| Plan IGN v2 | WMTS `GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2` | Le fond plan, au choix de la photo |
| Géocodage | `geocodage/search`, `geocodage/reverse` | La recherche d'un lieu (Base Adresse Nationale et lieux nommés, lus séparément), et la commune du point affiché ; appelé par le navigateur |
| BD TOPO, hydrographie | WFS `surface_hydrographique`, `troncon_hydrographique` | Étendues et cours d'eau |
| OpenStreetMap, `building:part` | API Overpass, © contributeurs OSM, [ODbL](https://www.openstreetmap.org/copyright) | Les monuments en vraie 3D, là où le LiDAR manque |
| OpenStreetMap, `maxspeed` | API Overpass, par bloc de 2 km, © contributeurs OSM, [ODbL](https://www.openstreetmap.org/copyright) | Les limitations de vitesse de la vue en voiture, rapprochées des tronçons BD TOPO |
| Parcellaire Express | WFS `CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle` | Les parcelles des ventes DVF, au clic |

Hors du territoire, en mer et à l'étranger, où le RGE ALTI n'a pas
d'altitude, l'horizon prend celle d'[AWS Terrain Tiles](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
(EU-DEM © Copernicus), le relief mondial que la vue emploie déjà en repli.

three.js est chargé depuis jsDelivr. Le lien Street View ouvre Google Maps.

À la frappe dans la recherche, hors IGN aussi : les entreprises et commerces
de l'[API Recherche d'entreprises](https://recherche-entreprises.api.gouv.fr)
de l'État (répertoire SIRENE de l'INSEE, Licence Ouverte 2.0), sans clé,
appelée par le navigateur. N'y sont proposées que les entreprises en
activité dont le nom ou l'enseigne porte les mots tapés ; un entrepreneur
individuel n'est trouvé que par son enseigne, jamais par le nom de la
personne.

Au clic seulement, hors IGN aussi : les DPE de l'API de l'ADEME
(`data.ademe.fr`, jeux `dpe03existant` et `dpe02neuf`), les fichiers DVF
géolocalisées d'Etalab (`files.data.gouv.fr/geo-dvf`) et la Base nationale
des IRVE (`tabular-api.data.gouv.fr`), sous Licence Ouverte 2.0, sans clé ;
l'année type de PVGIS (`re.jrc.ec.europa.eu`, © Union européenne,
réutilisation autorisée, source citée), sans clé elle aussi.
Le lien « Y aller » d'un bâtiment ou d'une station ouvre l'itinéraire dans
Plans (iPhone, iPad) ou Google Maps.

La couche optionnelle des panneaux solaires lit le registre
[OpenPVMapper](https://doi.org/10.5281/zenodo.19188878) (G. Kasmi, CC-BY 4.0),
téléchargé à la construction de l'image. La couche optionnelle des véhicules,
des piscines et des bateaux n'ajoute pas de source : elle relit
l'orthophoto, à 0,2 m par pixel, avec un réseau de neurones — RTMDet-R
([MMRotate](https://github.com/open-mmlab/mmrotate)) ou YOLO11-OBB
([Ultralytics](https://github.com/ultralytics/ultralytics)), au choix de qui
déploie.

## La méthode, en bref

Chaque règle a été fixée après une mesure sur des données réelles. Les
principales :

- **Toits mesurés.** Le toit résumé s'écarte du LiDAR de 0,60 m en médiane à
  Gordes, de 0,98 m à Strasbourg ; la surface n'est proposée qu'au-delà de
  0,7 m, seuil fixé sur des toits examinés un à un (40 % des toits fiables de
  Gordes, 70 % de ceux de Strasbourg). Les cellules à moins de 0,75 m du
  contour mêlent toit et sol et reprennent leurs voisines. Sur la pente, la
  surface est redressée par le terrain du LiDAR lui-même, non par le RGE ALTI,
  dont les restanques ondulaient le toit. Elle colle au LiDAR à 4 à 8 cm près.
- **Toits en pans.** Cette surface est d'abord découpée en plans, par
  croissance de régions déterministe (la scène est cachée pour toujours : pas
  de tirage au sort). À 12° et 0,15 m, les tolérances courantes, un toit de
  Strasbourg sur trois seulement se découpait : à maille fixe, le bruit de la
  normale croît avec la pente. À 25° et 0,40 m, 87 % des toits proposés à
  Gordes et 56 % à Strasbourg passent en pans, à 8-12 cm du LiDAR ; le reste
  garde la surface. Chaque volume est vérifié fermé — toute arête portée par
  deux triangles, en sens opposés — et refusé sinon, jamais approché. Mesure :
  `python outils/mesure_pans.py [lat lon]`.
- **Bâtiments coupés au bord de la scène.** Le WFS rend un bâtiment entier dès
  qu'il touche l'emprise, mais la grille des hauteurs s'arrête à son bord : un
  bâtiment qui en sortait ne recevait ni pans ni surface. Le château de
  Versailles, une seule emprise BD TOPO de 22 790 m² plus grande que la scène,
  n'était qu'une dalle sous la photo aérienne. Les bâtiments sont donc coupés
  à 1,25 m du bord, là où la grille encadre encore le morceau : 4 bâtiments
  sur 5 à Versailles, 56 sur 205 à Strasbourg, dont 3 et 22 y gagnent une
  forme mesurée. La pente du toit d'un morceau se juge à la largeur du
  bâtiment entier. Les houppiers, eux, lisent les bâtiments entiers.
- **Toitures.** Gouttière au 15e centile et faîtage au 85e des hauteurs LiDAR
  de l'emprise érodée, plutôt que le minimum et le maximum : un arbre qui
  surplombe gonfle le maximum (16 m lus sur une maison de 4 m). La mesure est
  rejetée si le haut du profil n'est pas un toit, et une toiture à moitié sous
  un arbre est relue dans le mode bas de son profil. Mais là où l'orthophoto
  ne voit pas de vert, ce « mode haut » n'est pas un arbre : c'est le bâtiment,
  sur deux niveaux — le donjon et les tours de Chambord au-dessus de ses
  terrasses, un immeuble au-dessus de sa cour. Il reçoit alors sa forme
  mesurée : 26 bâtiments sur les 50 concernés, parmi 1 516 sur dix lieux. Les altitudes de toit BD
  TOPO manquent sur près d'un tiers des bâtiments d'un site mesuré, et sont
  bruitées dans les deux sens ailleurs.
- **Un toit résumé reste sur son bâtiment.** Deux pans ou une pyramide se
  posent sur une boîte orientée selon le faîtage ; or la boîte d'une maison en
  L, d'un faîtage mesuré en biais ou d'une aile courbe déborde de l'emprise.
  Sur 391 toits résumés de huit lieux, le débord vaut 31 % de l'emprise en
  médiane, plus que l'emprise elle-même une fois sur dix : vu du ciel, un
  rectangle de photo aérienne plus grand que la maison, pelouse comprise. Le
  toit est donc découpé sur l'emprise, pignons compris, et ce que les corps
  de toit laissent à découvert — comme tout toit plat — reçoit la photo
  aérienne au lieu de la couleur des murs. Géométrie vérifiée en exécutant le
  code de la page : `node outils/verifier-geometrie.mjs`.
- **Bâtiments sous les arbres.** Le LiDAR y lit la canopée : une annexe de
  12 m² sous les feuillages lisait un toit plat à 12 m qui passait tous les tests
  de forme. L'orthophoto tranche : au-delà d'un tiers de l'emprise verte, la
  hauteur est déclarée inconnue, et le bâtiment est dessiné pâle, sans toit.
- **Végétation.** Une cellule du modèle de hauteur est de la végétation si elle
  tombe dans une zone BD TOPO, ou si l'orthophoto y est verte (indice
  ExG = 2G − R − B, seuil 4 : 93 % de la végétation reconnue pour 2 % de toits
  pris pour du vert). Les houppiers sont les bassins de la grille lissée,
  descendus depuis leurs sommets. Leur emprise au sol est une ellipse d'aire et
  d'allongement mesurés, inscrite à 80 % dans son segment pour laisser voir les
  trouées.
- **Ni dans l'eau, ni au-dessus de 40 m.** Le modèle de hauteur garde tout ce
  qui passe au-dessus du sol, et l'orthophoto ne dit que la couleur de ce sol.
  À Notre-Dame de Paris, les flèches des grues du chantier sortaient en
  houppiers de 52 à 88 m, plus hauts que les tours : hors des forêts BD TOPO,
  où les vrais arbres montent à 43 m (sapins des Vosges), rien n'est dessiné
  au-dessus de 40 m. Et le laser ne revient pas de l'eau : entre deux quais,
  le modèle lit leur hauteur en pleine rivière, et 438 des 1 175 houppiers de
  la scène étaient plantés dans la Seine, verte à l'orthophoto. Les étendues
  d'eau permanentes sortent donc du sursol, à 3 m de la rive pour garder le
  feuillage qui la surplombe.
- **Port des arbres.** L'essence BD Forêt ne décrit qu'un massif : quand elle
  dit « mixte », c'est le profil mesuré de l'arbre qui choisit son port — un
  sommet qui se maintient loin du centre est un pin, une cime effilée un
  conifère, un dôme un feuillu.
- **Bâtiments sur la pente.** Posé au point le plus bas du terrain sous son
  contour, un bâtiment ne flotte jamais côté aval ; mais son toit est relevé
  au-dessus du terrain médian de l'emprise, d'où se comptent ses hauteurs.
  Sans cela, 15 toits sur 104 passaient sous le rocher au Mont-Saint-Michel,
  13 sur 139 à Rocamadour ; relevés, 1 et 3.
- **Réservoirs et constructions ponctuelles.** Hors de toute emprise bâtie,
  une citerne est du sursol comme un autre : sur quatre scènes de raffinerie,
  2 426 houppiers et masses sur 5 400 étaient posés sur l'un des 156
  réservoirs. Leurs emprises, dilatées de 2 m, rejoignent donc le masque bâti
  de la segmentation — c'est pourquoi ils sont dans la scène et non dans une
  couche chargée après coup. Leur hauteur est celle de la BD TOPO : le LiDAR
  la confirme à 0,5 m près quand il voit le réservoir, mais sa classification
  en ignore beaucoup (14 citernes sur 30 à Feyzin, à zéro d'un bord à
  l'autre). Pour une torchère ou une cheminée, c'est l'inverse : la BD TOPO
  donne rarement la hauteur (15 torchères sur 86) et le LiDAR la mesure une
  fois sur deux, avec le rayon de la construction. Un point dans une emprise
  bâtie est laissé au toit mesuré du bâtiment.
- **Murs et ponts.** La BD TOPO ne leur donne pas de hauteur, mais leurs
  sommets portent l'altitude du haut de l'ouvrage : l'aqueduc du Pont du Gard
  y est à 47,8 m du Gardon pour 48 m réels. La hauteur est cette altitude
  moins le relief — deux sources, 1,4 m d'écart médian avec le LiDAR sur les
  remparts de Carcassonne —, d'où un seuil à 2 m, et l'abandon des murs de
  soutènement, qui ne sont qu'une marche du relief. Les masses de sursol à
  moins de 2 m d'un mur dessiné, ou sous un tablier, sont retirées : 236 sur
  2 130 à Carcassonne. Mesure : `python outils/mesure_constructions.py [lat lon]`.
- **Monuments OSM.** OSM et la BD TOPO ne découpent pas le bâti pareil : au
  Mont-Saint-Michel, l'union brute des parties ne couvre les emprises BD TOPO
  du complexe abbatial qu'à 29-100 %. La même union dilatée de 5 m couvre
  l'îlot à 86-100 % et le village à 55 % au plus : un bâtiment est remplacé
  au-dessus de deux tiers, seuil au milieu du trou. Une partie sans hauteur
  prend celle, mesurée, du bâtiment BD TOPO qui la contient. Une partie qui
  en recouvre d'autres, mesurées et plus basses — l'« Église abbatiale »
  porte les 78,5 m de la flèche sur tout le vaisseau —, est une enveloppe et
  repart sur ce même repli.
- **Une scène est complète ou n'existe pas.** Le cache ne périme pas, les
  données sources ne changeant qu'au rythme des campagnes IGN. Une scène
  construite pendant une panne resterait donc fausse pour toujours : si une
  seule source ne répond pas, rien n'est mis en cache et le serveur répond 503.
  Les lectures réessaient trois fois, refus compris, car le service renvoie des
  400 sporadiques sur des requêtes valides.

## Limites

- **France métropolitaine seulement.** Hors de cette emprise, le serveur refuse
  le point.
- **Couverture LiDAR HD en cours.** Environ 77 % des bâtiments tirés au hasard
  sont couverts ; ailleurs, le repli photogrammétrique lisse les cimes et les
  faîtages, et le panneau le signale.
- **Une scène couvre au plus 2 000 m de côté** autour du point. Au-delà, l'anneau
  ne porte que le relief (maille de 16 m) et le fond en basse résolution, sans
  bâtiment ni arbre : un bâtiment qui sort de la scène est coupé à son bord,
  et son morceau est mesuré seul — trop petit, il retombe sur les hauteurs BD
  TOPO. En bord de mer ou de frontière, ses parties hors
  couverture RGE ALTI restent vides ; l'horizon les comble.
- **L'horizon n'a que le relief et la photo** : ni bâtiment ni arbre au-delà
  de l'anneau, un relief lissé à une vingtaine de mètres près de la caméra, et
  la photo de l'IGN s'arrête à la frontière — au-delà, la plaine est blanche
  ou floue. Il lit environ 7 Mo à l'ouverture d'un lieu (Gordes), que le
  navigateur garde trois semaines.
- **Un pont n'est que son tablier.** La BD TOPO ne décrit ni piles ni arches :
  le Pont du Gard est un ruban à 48 m de la rivière. Un pont en ligne prend la
  largeur de la chaussée qu'il porte, à défaut 3 m.
- **Toutes les constructions de la BD TOPO ne sont pas dessinées** : ni les
  éoliennes (leur hauteur ne dit pas si elle compte les pales), ni les croix
  et calvaires (jamais de hauteur), ni les clochers, déjà portés par le toit
  mesuré de leur église. Une antenne ou un mât que le LiDAR ne voit pas prend
  une largeur de convention.
- **Les monuments OSM valent ce que les contributeurs y ont mis** : des
  parties sans hauteur (La Merveille, Le Châtelet) reçoivent celle de la BD
  TOPO, et l'infobulle le dit. La couche vient d'Overpass, le seul service
  hors IGN du projet.
- **Les véhicules sont un instantané, et une lecture incomplète.** Ils sont là
  où ils étaient le jour de la prise de vue, qui n'est pas celui du LiDAR. Le
  réseau en manque — un sur cinq dans un parking serré pour le meilleur des
  deux, davantage à l'ombre et sous les arbres — et ce qui manque reste à plat
  sur la photo. Il en invente peu : sur deux lieux, une seule boîte sur un
  toit, que l'emprise du bâtiment écarte, et deux boîtes longues fausses (un
  muret, trois voitures en file) que la limite de 7 m de `rtmdet` écarte. L'avant et l'arrière ne sont pas distingués, et il
  n'y a pas de vérité terrain annotée : les comptes ont été jugés à l'œil.
- **Une piscine est un rectangle**, celui de la boîte que le réseau pose sur
  le bassin, rond ou en haricot. Sur deux lieux, toutes les boîtes regardées
  sont de l'eau, à deux petits bassins près dont on ne peut jurer ; une
  piscine que la BD TOPO porte comme un bâtiment reste un bâtiment. Sur une
  pente raide, où le relief lisse les terrasses, la cuve peut descendre de
  plusieurs mètres côté aval, et le terrain recouvrir l'eau côté amont.
- **Un bateau n'est vu que sur l'eau, et sans sens de marche.** Ceux posés à
  terre (aire de carénage, remorque) sont écartés avec les voitures des quais
  que `rtmdet` prend pour des navires. La boîte ne dit pas où est l'étrave :
  la coque est effilée aux deux bouts. En mer, la photo montre aussi ce qui
  n'en est pas : les brise-lames immergés, assez sombres, sont écartés ; les
  pontons des plages, clairs, passent parfois pour des yachts (un sur dix à
  Cannes). La mer est ce qui n'est dans aucune commune, au niveau de la mer
  pour le RGE ALTI : au-delà d'une frontière, le sol étranger bas l'est
  aussi.
- **Au pied des falaises, des arbres trop hauts.** En forêt, la hauteur d'un
  arbre accroché à une paroi se compte depuis le pied de celle-ci : 7 houppiers
  de 42 à 60 m à Rocamadour. Hors forêt, le plafond de 40 m efface aussi ce
  qui dépasse d'un bâtiment hors de son emprise, comme le toit du Stade de
  France.
- **L'ensoleillement ne vaut que ce que la vue dessine.** Un arbre hors des
  massifs de la BD Forêt n'a pas d'essence connue : sa forme mesurée décide
  s'il perd ses feuilles, et un chêne vert en dôme passe pour un feuillu ;
  un bâtiment sous les arbres n'a pas de toit, donc pas de calcul ; un
  ouvrage dessiné en points (la tour
  Eiffel) ne porte pas d'ombre. Un toit tiré de la surface du LiDAR en garde
  le grain : sa carte est tachetée. Le relief exagéré fausserait les ombres :
  le calcul attend l'exagération 1. Tout est à refaire dans le navigateur à
  chaque visite (deux à huit secondes de carte graphique), dans des textures
  de 300 Mo à Gordes en zone de 1 000 m, 720 Mo en zone de 2 000 m : un
  téléphone peut n'y pas suffire.
- **La règle « sous les arbres » est sévère** dans les tissus denses et arborés,
  où l'orthophoto, qui n'est pas une vraie orthophoto, décale les feuillages
  sur les emprises voisines.

## API

| Route | Réponse |
|---|---|
| `GET /?lat=…&lon=…` | La page ; `&vue=lat,lon,hauteur,distance,azimut,elevation` pose la caméra (cible, sa hauteur au-dessus du sol, recul en mètres, azimut depuis le nord et élévation en degrés), `&jour=MM-JJ` et `&heure=13.25` le soleil, `&couches=solaire,dpe,-vegetation` les couches allumées ou éteintes (le lien du bouton de partage) |
| `GET /voiture` | La vue en voiture ; `?lat=…&lon=…` pour son départ en attendant le GPS, `&simu=1&vitesse=…` pour une conduite simulée, `&vue=2d`, `&fond=plan`, `&heure=…` |
| `GET /api/scene?lat=…&lon=…` | La scène, en JSON gzippé |
| `GET /api/ortho?lat=…&lon=…` | L'orthophoto de la scène, en JPEG |
| `GET /api/monuments?lat=…&lon=…` | La couche des monuments OSM, en JSON gzippé (`null` sans partie), que la page demande une fois la scène affichée |
| `GET /api/ouvrages?lat=…&lon=…` | La couche des murs, ponts, voies ferrées et terrains de sport, en JSON gzippé (`null` sans ouvrage), demandée elle aussi après la scène |
| `GET /api/nuage?lat=…&lon=…` | Le bâti du nuage de points LiDAR HD, en JSON gzippé (`null` hors couverture), demandé après la scène : 10 à 90 s à la première demande. Avec `&proche=1`, d'abord un carré de 400 m autour du point, que la page affiche avant la zone entière (en zone de 800 m et plus) ; au-delà de 1 000 m, le kilomètre central seulement |
| `GET /api/piscines?lat=…&lon=…` | Les piscines de l'orthophoto, en JSON gzippé, demandées après la scène ; `{"mode": "aucun", "piscines": []}` si le service n'a pas de détecteur |
| `GET /api/navires?lat=…&lon=…` | Les bateaux de l'orthophoto, sur l'eau, en JSON gzippé, demandés après les piscines ; `{"mode": "aucun", "navires": []}` si le service n'a pas de détecteur, une liste vide loin de l'eau |
| `GET /api/vehicules?lat=…&lon=…&detecteur=…` | Les véhicules vus d'un détecteur du service (`rtmdet` ou `yolo`), en JSON gzippé ; la page les demande dans l'ordre que donne `/api/sante`, du rapide au lent, et les réunit ; 400 sans le paramètre ou avec un détecteur que le service n'a pas |
| `GET /api/avancement?lat=…&lon=…` | L'étape de la construction en cours (18 au total), que la page affiche pendant l'attente |
| `GET /api/panneaux?lat=…&lon=…` | Les panneaux solaires du registre, en JSON gzippé ; `{"actif": false, "panneaux": []}` si le service n'a pas de registre |
| `GET /api/dpe?lat=…&lon=…` | Les DPE de l'ADEME réunis par bâtiment (`batiments`, par `cleabs`) et, sans bâtiment, par adresse (`adresses`), en JSON gzippé, datés (`lu_le`) ; demandés au clic seulement |
| `GET /api/dvf?lat=…&lon=…` | Les ventes DVF des parcelles de l'emprise (`parcelles`, `ventes`, `resume`), en JSON gzippé, datées ; `absent` nomme les départements sans DVF (Alsace-Moselle) ; au clic seulement |
| `GET /api/bornes?lat=…&lon=…` | Les bornes de recharge de l'emprise, réunies par station (`stations` : opérateur, points de charge, puissances, prises, accès), en JSON gzippé, datées ; au clic seulement |
| `GET /api/solaire?lat=…&lon=…` | L'année type du rayonnement au point (PVGIS) : direct normal, diffus et global horizontaux de ses 8 760 heures (`direct_normal`, `diffus_horizontal`, `global_horizontal`, W/m²), l'année de chaque mois et le décalage des mesures sur l'heure, en JSON gzippé, datée ; au clic seulement, la page en calcule l'ensoleillement des toits |
| `GET /api/carre?i=…&j=…` | Un carré de 500 m de la grille Lambert-93 (`i = x // 500`, `j = y // 500`) pour la vue en voiture : bâtiments et routes carrossables BD TOPO, en JSON gzippé, coordonnées en décimètres depuis son coin sud-ouest. Lu à la première demande (0,1 à 0,3 s), gardé ensuite ; 422 hors de France métropolitaine |
| `GET /api/vegetation?i=…&j=…` | Les arbres du même carré, découpés comme ceux de la scène (MNH à 0,5 m, orthophoto, BD TOPO, BD Forêt) : `[x, y, h, r, port]` en décimètres depuis son coin sud-ouest, `ports` nommant les indices ; `couvert` faux sans MNH. 1 à 5 s à la première demande |
| `GET /api/sante` | `{"ok": true, "vehicules": {"mode": …, "detecteurs": […]}, "panneaux": {"actif": …}}` : le contrôle de vie, et ce que le service sait détecter ou lire |
| `POST /api/reconstruire?lat=…&lon=…` | Met de côté la scène et ses couches (202) : la demande suivante les reconstruit d'après les données de l'IGN du moment, l'ancienne revenant si l'IGN ne répond pas. 429 moins de 10 min après sa construction, 409 pendant qu'elle ou une de ses couches se calcule |

Codes d'erreur : 400 sans coordonnées valides, 422 hors de France métropolitaine,
503 si un service de l'IGN, l'ADEME, les fichiers DVF ou PVGIS n'ont pas répondu
(rien n'est mis en cache, réessayer).
Tout ce qui vient du dossier d'une scène est revalidé à chaque visite (304
tant que le fichier n'a pas été réécrit) : une scène reconstruite apparaît
aussitôt.

## Développer

Pour contribuer — architecture, format de la scène, invariants, méthode de
mesure, recettes et glossaire — voir le [guide du contributeur](CONTRIBUTING.md).
Ce qui a changé d'une version de la scène à l'autre est dans le
[journal des changements](CHANGELOG.md).

```bash
python3.12 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt pytest
pytest
```

Les tests Python ne voient pas le rendu. Pour la page elle-même, un essai dans un
vrai navigateur charge un lieu, clique le bâtiment visé, change de saison,
cherche un autre lieu et s'y rend, et échoue à la moindre erreur JavaScript :

```bash
npm install puppeteer-core
node outils/essai-navigateur.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003" capture.png
node outils/essai-voiture.mjs "http://localhost:8080/voiture?simu=1&lat=48.8706&lon=2.3055&vitesse=50" 60 voiture.png   # la vue en voiture, une minute de conduite simulée
node outils/film-voiture.mjs "http://localhost:8080/voiture?simu=1&lat=48.8532&lon=2.3692&vers=48.8483,2.3958&versnom=Nation&vitesse=40" docs/demo/demo-voiture-paysage.mp4   # le film d'un trajet, de la Bastille à la Nation
node outils/verifier-recherche.mjs     # la recherche d'un lieu, sous Node, sans réseau
node outils/verifier-export.mjs essai.ifc essai.gml   # les exports, sous Node (npm install three@0.160.0)
node outils/verifier-solaire.mjs http://localhost:8080   # l'ensoleillement contre PVGIS, sous Node (three@0.160.0, réseau)
pip install ifcopenshell pytest && python outils/valider_ifc.py essai.ifc   # l'IFC, comme un logiciel le lirait
python outils/valider_citygml.py essai.gml   # la géométrie du CityGML, sans dépendance
citygml-tools validate essai.gml             # son schéma (github.com/citygml4j/citygml-tools)
python3 -m http.server -d outils 8000        # puis localhost:8000/visionneuse-ifc.html, y glisser l'IFC
```

L'essai du navigateur télécharge aussi les deux exports à côté de la
capture : `outils/valider_ifc.py` valide l'IFC (schéma, règles EXPRESS,
géométrie de chaque élément, géoréférencement), `outils/valider_citygml.py`
et `citygml-tools` le CityGML. `outils/visionneuse-ifc.html` montre l'IFC
tel qu'un autre logiciel le relit : web-ifc (That Open Company, MPL-2.0) en
tire chaque volume, et le clic sur un objet donne sa classe et ses
propriétés.

La démo filmée se tourne de la même façon, dans un Chrome sans écran, sur un
serveur qui tourne avec la couche des véhicules : la caméra suit un scénario
(la tour Eiffel en points LiDAR, puis orbite, toits, végétation, course du
soleil, véhicules, piscines), chaque image est capturée à horloge figée, et
ffmpeg assemble la vidéo, muette, légendes incrustées.

```bash
node outils/demo-video.mjs youtube     # docs/demo/demo-youtube.mp4 (1080p, panneau visible)
node outils/demo-video.mjs linkedin    # docs/demo/demo-linkedin.mp4 (1080×1350, vue seule)
node outils/demo-video.mjs readme      # docs/demo/demo-readme.gif, celui ci-dessus
node outils/demo-video.mjs foncier     # docs/demo/demo-foncier.mp4 (1080×1080, DPE et ventes à Honfleur, zone de 1 000 m, en zooms)
node outils/demo-video.mjs industrie   # docs/demo/demo-industrie.mp4 (1080×1080, trois sites industriels, BD TOPO puis LiDAR HD)
MUSIQUE=chant.mp3 node outils/demo-video.mjs gadzarts   # docs/demo/demo-gadzarts.mp4 (1080×1080, les huit campus Arts et Métiers)
# La série « fonctionnalités », un film par fonction, carré (LinkedIn) ou paysage (YouTube) :
node outils/demo-video.mjs lidar carre        # docs/demo/demo-lidar-carre.mp4 — LiDAR HD, à Chambord
node outils/demo-video.mjs recherche paysage  # docs/demo/demo-recherche-paysage.mp4 — recherche et recentrage, Versailles et Paris
#   dpe-dvf (La Rochelle), drone (lac d’Annecy), bornes (Arc de Triomphe),
#   vehicules (Saint-Tropez, détecteur requis), soleil (Chamonix),
#   export (Notre-Dame de Paris : IFC et CityGML, l'IFC rouvert dans outils/visionneuse-ifc.html),
#   ensoleillement (Strasbourg : le soleil des toits, la fiche d'un toit, le partage de la vue)
```

Le film `foncier` n'a besoin d'aucun détecteur, et ne montre des DPE et des
ventes que des couleurs et des chiffres réunis (médianes, répartition des
étiquettes d'un immeuble), jamais une vente ni une adresse : les conditions
de DVF interdisent de permettre la réidentification, et une vidéo publiée se
voit de partout. Il n'a pas de texte de voix off.

Le film `industrie` montre, sur trois sites dont l'orthophoto n'est pas
floutée (la raffinerie TotalEnergies de Gonfreville-l'Orcher, l'usine Arkema
de Pierre-Bénite, la centrale EDF de Cordemais), les volumes de la BD TOPO
puis le nuage LiDAR HD, qui y voit de 144 à 302 structures qu'elle ne
modélise pas : unités de procédé, racks de tuyauteries, convoyeurs.

Le film `gadzarts` parcourt les huit campus Arts et Métiers dans l'ordre de
leur fondation, de Châlons (1806) à Metz (1997), pendant que le soleil
traverse la journée, chacun avec son mouvement de caméra (grue, travelling,
plongée, arc, survol, recul, descente) et son nuage LiDAR HD — sauf Lille,
hors couverture en octobre 2026. Des photos de Wikimedia Commons, anciennes
ou récentes, s'y posent pour comparer : lues au tournage, jamais gardées
dans le dépôt, leur auteur et leur licence vérifiés et écrits à l'image.
`MUSIQUE` pose un morceau dessous, après le carton d'avertissement : ses
droits sont à vérifier avant de publier, comme la licence CC BY-SA de
certaines photos, qui s'étend à la vidéo.

Pour une voix off, enregistrer les phrases de `docs/demo/demo-voix-off.txt`,
une par séquence, et donner le dossier par `VOIX_DOSSIER=…` : chaque
séquence prend la durée de sa phrase. `VOIX="Audrey (Premium)"` prend à la
place une voix de synthèse de macOS.

## Logo

Le logo, la **Tuile**, est dans [docs/logo/](docs/logo/) : une carte de neuf
cases en perspective isométrique, dont celle du centre se lève en volume.
`logo-clair.svg` et `logo-sombre.svg` portent le nom, `marque-*.svg` le dessin
seul, `icone.svg` et `icone-512.png` l'icône carrée, `apercu-social.png`
l'aperçu des liens vers le dépôt (1280 × 640). Le nom est écrit en Archivo
(SIL Open Font License), vectorisé : aucun SVG ne dépend d'une police. La page
en tire son favicon et son icône d'écran d'accueil (`vue3d/static/`).

## Licence

Code sous licence [MIT](LICENSE). Les données affichées appartiennent à l'IGN et
sont diffusées sous Licence Ouverte Etalab 2.0 ; les parties de monuments et
les limitations de vitesse viennent d'OpenStreetMap (© contributeurs OSM, ODbL). Le dépôt embarque un
extrait OpenStreetMap pour les lieux d'exemple ci-dessus, sous ODbL et non sous
MIT : voir [vue3d/donnees/LICENCE.md](vue3d/donnees/LICENCE.md).

Le registre de la couche optionnelle des panneaux solaires est sous
[CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/) (OpenPVMapper,
Gabriel Kasmi) ; la page le crédite quand la couche est affichée. Les réseaux
de la couche optionnelle des véhicules ne sont ni dans le dépôt ni dans
l'image par défaut. Construire l'image avec `VUE3D_VEHICULES` les y
télécharge, sous leurs licences : Apache-2.0 pour RTMDet-R, **AGPL-3.0** pour
YOLO11-OBB, et pour les deux les conditions du jeu de données DOTA, réservé à
un usage académique.
