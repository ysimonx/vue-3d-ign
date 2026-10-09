# Journal des changements

Le projet n'a pas de versions numérotées : ce qui tient lieu de version est le
**format de la scène** (`SCENE_VERSION` dans `vue3d/scene.py`). L'incrémenter
invalide tout le cache — chaque lieu est reconstruit à sa première ouverture —
et c'est donc à lui que ce journal s'accroche. Les changements qui ne touchent
pas la scène (page, outils, documentation) sont rangés sous la version en
cours à leur date.

Les plus récents en premier. Les chiffres cités sont ceux mesurés au moment du
changement, sur des lieux publics ; le détail et la méthode sont dans les
messages de commit et dans les commentaires des modules.

## Scène v14 — 1er octobre 2026

### Ajouté

- **Un décalage ne redétecte que la bande nouvelle.** Ce que les réseaux
  voient sur l'orthophoto (véhicules et piscines) est désormais gardé par
  rectangle de terrain, dans `cache/releves/`, et non plus seulement dans la
  couche d'un point : la couche d'un point se réunit des relevés qui
  couvrent son emprise, et seul ce qu'aucun ne couvre est détecté. Après une
  flèche (un quart de zone), les détections passent de 9,2 à 4,2 s à Gordes
  sur l'emprise par défaut, et de 64 à 23 s en zone de 1 000 m (CoreML, Mac
  M4) ; un point entre deux lieux déjà vus ne détecte plus rien, et une
  nouvelle version de la scène réutilise les relevés. Pour voir entier ce
  qui chevauche la limite de deux relevés, chacun détecte sur une image
  élargie d'une marge (12,8 m pour les véhicules, 25,6 m pour les
  piscines) : la première ouverture d'un lieu coûte 10 à 20 % de plus. Sur
  24 décalages autour de six centres de villes, la limite n'est pas plus mal
  vue que le reste. « Reconstruire la scène » efface aussi les relevés de
  l'emprise. Les couches déjà en cache restent servies telles quelles.

- **Décaler la scène d'un clic.** Quatre flèches, N, E, S et O, au bord de la
  vue, là où chaque point cardinal se trouve à l'écran ; elles tournent avec
  la vue, comme la boussole. Une flèche décale le point d'un quart du côté de
  la zone (89 m du nord au sud et 64 m d'est en ouest à Gordes, pour la zone
  par défaut) : un point pris à quelques dizaines de mètres près se rattrape
  sans retaper de coordonnées. La nouvelle scène s'ouvre avec la caméra au
  même endroit par rapport au point, et l'orbite arrêtée le reste. Le nouveau
  point est arrondi comme la clé du cache : un aller-retour retombe sur la
  scène de départ.

- **Une démo filmée.** `outils/demo-video.mjs` tourne la démo de la page
  dans un Chrome sans écran — la tour Eiffel en points LiDAR d'abord, puis
  orbite, toits mesurés, végétation, course du soleil et saisons, véhicules
  et piscines, l'abbaye du Mont-Saint-Michel — en trois formats : YouTube (1080p, panneau
  visible), LinkedIn (1080×1350, vue seule, texte court) et un
  GIF de quatorze secondes dans le README. Chaque image est
  capturée à horloge figée (requestAnimationFrame et performance.now repris
  à la page), si bien que l'orbite et l'ombre figée en mouvement sont celles
  de la page, à la cadence exacte de la vidéo. Muette : une voix off, la
  vôtre ou de synthèse, se monte sur demande, une phrase par séquence.

- **Le nuage de points LiDAR HD, et les ouvrages ajourés tels qu'ils sont
  mesurés.** Une nouvelle couche (`/api/nuage`) lit, après la scène, les
  points du bâti dans les dalles LiDAR HD de l'IGN — bâtiments, tabliers,
  sursol pérenne —, par plages d'octets, sans télécharger les dalles
  entières. La tour Eiffel, que la BD TOPO extrude en cubes de 99 m de côté
  et que le MNH perd au-dessus de 199 m, y est entière, des arches à
  l'antenne (321 m). Un bâtiment dont le LiDAR voit le sol à travers
  l'emprise, et une structure dedans, est un ouvrage ajouré : il est dessiné
  en points à la place de son volume — la tour Eiffel, l'Arc de Triomphe sous
  ses arches, la Grande Arche de La Défense, les verrières du Grand Palais et
  de Saint-Lazare, la Canopée des Halles, une cour que la BD TOPO couvre.
  Seuil mesuré sur 1 356 emprises autour de 21 lieux ; un bâtiment plus
  récent que le relevé LiDAR, qui n'y voit que le sol, garde son volume. Le
  reste du bâti, allégé, s'affiche au bouton « Nuage LiDAR ». La lecture
  prend 10 à 90 s à la première ouverture d'un lieu. Couche en version 2 :
  la fiche d'un bâtiment dessiné en points dit pourquoi — la part de son
  emprise où le LiDAR voit le sol et une structure, ou l'ouvrage ajouré dont
  il est un étage —, et il se désigne toujours au survol et au clic.

- **Les troncs s'effacent dans le feuillage.** Opaques d'un bout à l'autre,
  ils se lisaient comme des poteaux à travers des houppiers transparents à
  30 % — 2 009 arbres sur 2 160 en ont un à Gordes. Le tronc est désormais
  presque opaque au pied et s'efface en montant : il ancre l'arbre au sol et
  se perd dans le houppier. Comparé sur la même vue à un tronc à 60 %
  d'opacité, affiné ou absent ; son ombre portée reste celle d'un tronc
  plein.

- **La vue en mouvement allégée.** Pendant une orbite, un glisser ou un
  zoom, l'ombre portée n'est plus redessinée à chaque image : elle ne dépend
  que du soleil et de la scène, que la page surveille, et suit aussitôt
  l'heure ou une couche qui arrive. À Gordes en zone de 1 000 m, sur un Mac
  M1, l'orbite passe de 15 à 30 images par seconde, Notre-Dame à 1 000 m de
  30 à 60, sans rien changer à l'image. Si le mouvement rame encore (moins
  de 25 images par seconde), les arbres passent, le temps du mouvement, en
  formes simples de 36 faces au lieu de 200 — même emprise, même hauteur,
  mêmes couleurs —, et la forme détaillée revient à l'arrêt : Gordes à
  1 000 m y tourne à 60 images par seconde. La page le dit d'un message. Le
  conseil de masquer la végétation ne vient plus qu'ensuite, si la vue rame
  toujours.

- **Un conseil quand l'orbite rame.** Si l'orbite tombe sous 25 images par
  seconde (image médiane de plus de 40 ms sur 4 s), la vue propose de masquer
  la végétation, d'un clic. C'est elle qui pèse : sur un Mac M1, Gordes en
  zone de 1 000 m (19 312 arbres) tourne à 20 images par seconde avec elle,
  à 60 sans ; Notre-Dame à 1 000 m, à 30 avec elle, ne déclenche pas le
  conseil. Il n'est donné qu'une fois par page.

- **Chercher un lieu par son adresse ou son nom.** Un seul champ remplace
  la latitude et la longitude : il suggère, dès le troisième caractère, les
  adresses de la Base Adresse Nationale et les lieux nommés de l'IGN
  (« château de Chambord »), par le géocodage de la Géoplateforme, sans clé.
  Flèches et Entrée choisissent ; des coordonnées collées, dans un ordre ou
  dans l'autre, sont reconnues telles quelles. L'outre-mer, que les scènes
  ne couvrent pas, est écarté. Au-dessus des coordonnées, le panneau affiche
  le nom du lieu choisi, sinon la commune du point. Ce nom n'entre jamais
  dans l'URL : un lien partagé ne porte pas d'adresse lisible.

- **Les tours de refroidissement.** La BD TOPO n'en donne qu'un bâtiment
  rond et une hauteur, et le LiDAR ne voit pas leur coque : à Gardanne, la
  tour de 139 m sortait en bâtiment d'un étage « sous les arbres », avec une
  aiguille de 135 m en son centre. Un bâtiment rond de plus de 60 m que le
  LiDAR ne voit pas est désormais dessiné en coque hyperbolique, au galbe de
  convention (col à 0,58 fois le pied, aux quatre cinquièmes de la hauteur).
  Les centrales nucléaires restent absentes : la BD TOPO n'en contient rien.
- **Les détecteurs sur CoreML, hors conteneur.** Lancé sans Docker sur un
  Mac, le serveur fait tourner les réseaux des véhicules et des piscines sur
  CoreML : à Gordes, 0,8 s au lieu de 2,8 pour `rtmdet`, 5 s au
  lieu de 16 pour `yolo`, et des couches identiques à l'octet. Sur une zone
  de 1 000 m, piscines et véhicules sont prêts avec la scène (114 s) ; dans
  le conteneur, sur un autre lieu, `yolo` arrivait dix minutes après elle.
  `VUE3D_MOTEUR=processeur` s'en passe ; le conteneur, qui n'a pas CoreML, ne
  change pas.
- **Deux scripts de lancement** : `run_docker.sh` repart de zéro dans
  Docker avec les deux détecteurs ; `run_macOS_CoreML.sh` lance le
  service sans Docker, détecteurs sur CoreML, et refuse de démarrer si le
  conteneur tient déjà le port.
- **Un bouton « ↻ Reconstruire la scène »** dans le panneau. Il relit à
  l'IGN la scène et toutes ses couches (monuments, ouvrages, véhicules,
  piscines, panneaux), d'après ses données du moment : le dossier est mis
  de côté, la page rechargée le reconstruit avec sa barre d'attente, et si
  l'IGN ne répond pas, l'ancienne scène revient, complète. Pour ne pas
  charger la Géoplateforme, une même scène ne se reconstruit qu'une fois
  toutes les 10 minutes, et pas pendant qu'elle ou une de ses couches se
  calcule ; le refus dit pourquoi. Route : `POST /api/reconstruire`.

### Modifié

- **L'orbite tourne à 60 images par seconde dans une forêt.** À
  Porquerolles en zone de 1 000 m (17 613 houppiers), sous Metal, fenêtre de
  1 728 × 1 080 en Retina, orbite en marche, deux essais alternés, vue par
  défaut et vue rapprochée : 47-50 et 35-37 images par seconde avant, 60 et
  60 après. Deux changements :
  - Les houppiers forment un maillage indexé : chaque sommet d'anneau est
    écrit une fois, et non une fois par face qui le touche, et les triangles
    dégénérés contre le sommet et le centre du dessous disparaissent (180
    faces par houppier au lieu de 200) ; les troncs perdent leurs couvercles,
    l'un dans le feuillage, l'autre sous le sol. À lui seul : 56-59 et 50-53
    images par seconde. La page s'affiche en 0,8 à 0,9 s au lieu de 1,2 à
    1,7, ses tâches longues tombent de 1,3-1,6 s à 0,6-0,8 s, les tableaux
    de la végétation de 400 à 100 Mo, le tas JavaScript de 560 à 180 Mo.
  - La végétation est découpée en tuiles de 125 m. En mouvement, une tuile à
    plus de 200 m de la caméra passe en forme simple ; à l'arrêt, tout
    redevient détaillé. Une tuile hors du champ n'est plus dessinée. Toute la
    végétation ne passe en forme simple, comme avant, que si la vue rame
    encore.
  À l'arrêt, rien ne change à l'œil, à deux détails près, mesurés à caméra
  et soleil fixes : 4 % des pixels bougent d'au plus 8 niveaux sur 255 (le
  décalage de l'ombre reçue suit des normales lissées), et une route ou un
  cours d'eau sous les arbres se voit plus souvent par transparence, les
  tuiles se dessinant de la plus lointaine à la plus proche.
- **Toitures et houppiers se calculent dix fois plus vite.** Chaque
  bâtiment relisait la grille MNH entière, en Python, et la segmentation des
  arbres la parcourait toute à chaque passe. Sur Gordes en
  zone de 1 000 m (672 bâtiments, 19 312 houppiers), le calcul passe de 100 s
  à 8,5 s, et la scène entière, lectures comprises, de 114 s à 17 s. La
  scène est la même à l'octet : son format et son cache ne changent pas.
- **Une scène se construit quatre à quinze fois plus vite.** De la demande à
  la scène servie, cache vide, au calme, médianes de trois essais alternés
  sur un Mac M4 hors conteneur : Gordes 5,7 s → 0,84 s ; Gordes en zone de
  1 000 m 16,7 s → 3,9 s ; Strasbourg en zone de 1 000 m 42,3 s → 6,3 s.
  Dans le conteneur, mêmes conditions : Gordes 7,8 s → 1,0 s ; Gordes en zone
  de 1 000 m 24,6 s → 3,9 s ; Strasbourg en zone de 1 000 m 67,5 s → 4,5 s.
  La scène est la même à l'octet (horodatage des réponses WFS mis à part) :
  ni son format ni le cache ne changent.
  - Les seize lectures de la Géoplateforme partent ensemble, huit requêtes
    au plus en cours pour tout le service : en zone de 1 000 m, environ 3 s
    au lieu de 11 à 14 s. Pendant l'attente, la page nomme celles qu'on
    attend encore (« étape 14 sur 18 : hauteurs du sursol, orthophoto et
    1 autre »).
  - Les toitures se calculent sur un bassin de processus, un par cœur et
    seize au plus (`VUE3D_TOITS_PROCESSUS`, 1 pour aucun), qui naît au
    démarrage du service ; sur un cœur, chaque toit se calcule déjà cinq
    fois plus vite. Strasbourg en zone de 1 000 m : 28 s de toitures avant,
    environ 1 s au bassin. La scène arrive toujours d'un seul tenant : une
    couche des toits à part, calculée du centre vers le bord, a été évaluée
    puis écartée (1 à 3 s à gagner, au prix de deux invariants).
  - Les houppiers se calculent trois à cinq fois plus vite, et pendant les
    toitures du bassin, qu'ils ne lisent pas.
  - Tout le calcul (toitures, houppiers et le reste), bassin chaud, au
    calme : Strasbourg en zone de 1 000 m 30 s → 1,25 s ; Gordes en zone de
    1 000 m 5,5 s → 0,69 s.
- **Véhicules et piscines arrivent jusqu'à six fois plus tôt.** L'orthophoto
  à 0,2 m, que chaque détection relisait, est lue une seule fois, ses tuiles
  ensemble, et chaque réseau reçoit plusieurs tuiles à la fois (au
  processeur, jamais plus d'appels que la moitié des cœurs). Hors conteneur
  sur CoreML, au calme, depuis la demande de la scène, médianes de trois :

  | | piscines | `rtmdet` | `yolo` |
  |---|---|---|---|
  | Gordes | 5,7 → 1,8 s | 5,7 → 2,4 s | 9,8 → 6,4 s |
  | Gordes, zone de 1 000 m | 16,8 → 5,2 s | 25,9 → 9,1 s | 73 → 41 s |
  | Strasbourg, zone de 1 000 m | 42,6 → 6,5 s | 42,7 → 9,7 s | 73 → 39 s |

  Dans le conteneur, au processeur, mêmes conditions :

  | | piscines | `rtmdet` | `yolo` |
  |---|---|---|---|
  | Gordes | 7,9 → 3,2 s | 11,4 → 7,0 s | 46 → 28 s |
  | Gordes, zone de 1 000 m | 27,7 → 12,5 s | 73 → 36 s | 5 min 37 → 3 min 21 |
  | Strasbourg, zone de 1 000 m | 68 → 13 s | 82 → 35 s | 5 min 30 → 3 min 08 |

  Les couches sont les mêmes à l'octet. Au processeur, donc dans le
  conteneur, les détections s'interrompent tant qu'une scène se construit,
  30 s au plus par tuile, pour lui laisser les cœurs ; deux orthophotos lues
  d'avance au plus restent en mémoire. Le service en demande davantage avec `tous` : dans le
  conteneur, 1,2 Go au pic sur l'emprise par défaut au lieu de 0,8 ; 1,9 à
  2,0 Go en zone de 1 000 m au lieu de 1,4.
- **La page affiche une scène deux à trois fois plus vite.** De la réponse
  du serveur à la première image complète, scène en cache, Chrome sur un Mac
  M4, médianes de trois essais alternés : Gordes 0,51 s → 0,20 s ; Gordes en
  zone de 1 000 m 1,8 s → 0,56 s ; Strasbourg en zone de 1 000 m 2,4 s →
  0,88 s. La végétation s'écrit dans des tableaux typés, normales et sphères
  englobantes se calculent sans les objets intermédiaires de three.js, une
  surface de toit mesurée ne recoupe plus l'emprise entière à chaque maille,
  et les programmes du GPU se compilent pendant que le serveur répond. À
  l'arrivée des ouvrages et des monuments, l'image ne se fige plus que 0,07 s
  à Gordes en zone de 1 000 m au lieu de 1,7 s, et 0,2 s à Strasbourg au
  lieu de 1,4 s. Les géométries affichées sont les mêmes à l'octet.
- **La page demande sa scène en même temps que three.js**, et l'orthophoto
  et les couches à part dès la scène reçue, avant de construire ses
  maillages. Le gain se limite à un aller-retour par couche en local ; sur un
  lien lent, les couches ne prennent plus de bande passante à la scène.
- **La barre d'attente avance au rythme réel de la construction** :
  lectures 50 %, toitures 30 %, houppiers 20 %, d'après les durées mesurées
  à Gordes et à Strasbourg en zone de 1 000 m. Les lectures finissant
  désormais en 3 s environ, elle restait à 89 % pendant tout le calcul.
- **Le navigateur revalide la scène et ses couches à chaque visite**, au
  lieu de les garder un jour : une scène reconstruite apparaît aussitôt.
  Tant que le fichier n'a pas été réécrit, la réponse est un 304 sans
  corps, un aller-retour.

### Corrigé

- **Une cour n'est plus un ouvrage ajouré.** À Châlons-en-Champagne, un
  immeuble de 95 logements était dessiné en points : sa seule emprise BD TOPO
  couvre ses ailes et la cour qu'elles entourent, où le LiDAR voit le sol
  (33 %). Un bâtiment n'est plus ajouré que si le LiDAR voit le sol SOUS une
  structure — treillis, verrière, arche : 21 à 99 % pour la tour Eiffel,
  l'Arc de Triomphe, la Grande Arche, les verrières du Grand Palais et de
  Saint-Lazare, la Canopée des Halles ; 5 à 12 % pour les cours ouvertes,
  16 % au plus pour un bâtiment ordinaire, sur 1 009 emprises autour de
  quinze lieux. Une emprise de moins de 50 m², une fois son pourtour retiré,
  n'est plus jugée. Couche du nuage en version 3.

- **La page réessaie seule quand la scène n'est pas disponible.** Après un
  503 (un service de l'IGN n'a pas répondu) ou une connexion coupée (le
  serveur relancé pendant l'attente, que Firefox annonçait par « NetworkError
  when attempting to fetch resource »), elle affiche la cause et redemande
  la scène après 30 s, 1 min, 2 min puis 5 min, huit fois au plus : il
  n'est plus besoin de la recharger. Le 2 octobre 2026, la Géoplateforme a
  mis plus de dix minutes à se remettre. Un point invalide ou hors de France
  n'est pas réessayé.
- **`run_macOS_CoreML.sh` démarre sur un clone neuf.** Lancé avec les deux
  détecteurs par défaut, il s'arrêtait aussitôt : les réseaux ne sont pas
  dans le dépôt, seule l'image Docker les fabriquait. Au premier lancement,
  il les exporte désormais lui-même (`outils/preparer_modeles.sh`, une
  minute environ sur un Mac M4), avec les versions de l'image : RTMDet-R
  identique à l'octet, YOLO à la date d'export près. Il crée aussi le
  `.venv` en Python 3.12 et y installe les dépendances, et refuse un
  `.venv` dans une autre version (en 3.14, 0 houppier) : seul prérequis,
  uv ou python3.12. L'erreur, pour qui lance le serveur autrement, donne la
  commande d'export.
- **Une scène en échec ne lance plus de requête.** Quand une lecture
  échoue, celles qui attendent leur place ne partent plus et celles en cours
  ne réessaient plus : dans un scénario rejoué hors réseau, 16 requêtes
  partaient, dont 7 après l'échec, contre 8 et aucune depuis. Le message
  d'erreur nomme la lecture en panne. Il en va de même des tuiles de
  l'orthophoto des détections.
- **La suite de tests n'appelle plus la Géoplateforme.** Une application de
  test lançait la vraie lecture des ouvrages.
- **Une cheminée posée sur un bâtiment n'est plus effacée.** Un point de la
  BD TOPO dans une emprise bâtie était laissé au toit du bâtiment, quelle que
  soit sa hauteur : la cheminée de 295 m de la centrale de Provence, à
  Gardanne, disparaissait dans son socle de 32,8 m. Elle n'est plus écartée
  que si elle ne dépasse pas le bâtiment (de 15 %) ou si la hauteur du
  bâtiment est inconnue. Sur 17 points en bâtiment de hauteur déclarée autour
  de quatorze sites industriels, un seul tenait vraiment sous son toit.
- **Les très hautes cheminées gardent leur largeur.** Le LiDAR en perd le
  sommet (Gardanne culmine à 155 m dans le MNH, Porcheville à 92 m pour
  220 m) : leur rayon mesuré était jeté, et la page les dessinait en aiguille
  de 4 m de rayon au plus. Le fût, isolé, donne désormais sa largeur —
  environ 9 m de rayon à Gardanne.

## Scène v13 — 30 septembre 2026

### Ajouté

- **Une zone plus grande, au choix.** Le sélecteur « Zone » du panneau, ou
  `zone=` dans l'URL, fixe le côté nord-sud de la scène, de 150 à 1 000 m
  (arrondi à 50 m). L'emprise par défaut (~356 m) ne change pas et garde son
  cache. Autour d'un site de la vallée de la chimie à Lyon, 1 000 m donnent 301
  bâtiments, 17 réservoirs et 4 constructions élevées contre 50, 7 et 2 ; la
  construction prend environ cinq minutes. L'anneau de relief, le brouillard,
  le recul de la caméra et les ombres suivent la taille de la zone.

### Corrigé

- **Une lecture WFS n'est plus tronquée à 5 000 objets.** Le service s'arrête
  là sans erreur (5 000 bâtiments rendus sur 9 948 au centre de Paris).
  L'emprise est désormais coupée en quatre jusqu'à ce que chaque morceau
  tienne en une réponse.
- **Les véhicules d'une zone élargie sont détectés à 0,2 m.** L'orthophoto
  des détections était plafonnée à 2 048 px : à 1 000 m elle revenait à
  0,49 m, les voitures y étaient 2,5 fois trop petites et presque toutes
  écartées (une dizaine). Lue en tuiles, elle garde sa résolution : 301
  véhicules au même endroit.
- **La mosaïque d'orthophoto garde ses proportions au-delà de 2 048 px.** Ses
  deux côtés étaient plafonnés chacun de son côté, ce qui l'aurait étirée.

- **Le château de Chambord n'est plus réduit à ses terrasses.** Son donjon et
  ses tours, un tiers de l'emprise, étaient pris pour « un arbre au-dessus du
  toit » et écartés. Là où l'orthophoto ne voit pas de vert, ce niveau haut
  est le bâtiment : il reçoit sa forme mesurée au LiDAR. 26 bâtiments sur
  1 516 y gagnent, dont un immeuble d'Annecy de 22,5 m dessiné à 3,7 m.
- **Un toit résumé ne dépasse plus de son bâtiment.** Posé sur sa boîte
  entière, il débordait de 31 % de l'emprise en médiane (391 toits, huit
  lieux) : vu du ciel, un rectangle de photo aérienne plus grand que la
  maison. Il est découpé sur l'emprise, pignons compris — une tour ronde
  d'OpenStreetMap porte un toit rond.
- **Les toits plats portent la photo aérienne**, comme ce que les corps de
  toit laissent à découvert, au lieu de la couleur des murs.
- Les marches d'une surface mesurée prennent la teinte du toit, plus celle
  des murs : les tours coniques ne se mouchettent plus d'orange.
- **Chaque détection s'affiche dès qu'elle est prête.** La page attendait
  la couche entière — véhicules des deux détecteurs et piscines, jusqu'à
  quarante secondes dans le conteneur avec `tous` — avant de rien montrer.
  Les piscines ont maintenant leur fichier et leur route (`/api/piscines`),
  chaque détecteur de véhicules le sien (`/api/vehicules?detecteur=…`), et
  la page les demande l'un après l'autre, du rapide au lent, en dessinant
  chaque couche à son arrivée ; `/api/sante` lui dit les détecteurs du
  service. La couche des véhicules passe en version 3.
- **La couche des véhicules et des piscines n'est plus gardée un jour par le
  navigateur.** À la même adresse, elle change avec le détecteur du service
  et avec sa version : après une reconstruction de l'image, un lieu déjà
  visité montrait encore ses véhicules sans ses piscines. Elle est
  maintenant revalidée à chaque demande, le serveur répondant 304 tant que
  rien n'a changé.

### Ajouté

- **Un lien « Recentrer la scène sur ce bâtiment »** : la scène est
  toujours cadrée sur son point, et un bâtiment coupé par le bord se lit
  mieux au centre de la sienne. Un clic sur un bâtiment épingle son
  infobulle, qui ne suit plus la souris et porte ce lien et celui de Street
  View, jusqu'au prochain clic sur la scène ; la fiche du panneau les a
  aussi.
- **Les véhicules de l'orthophoto, en option.** Lancé avec
  `VUE3D_VEHICULES=rtmdet`, `yolo` ou `tous`, le service lit les véhicules
  sur l'orthophoto à 0,2 m avec un réseau à boîtes orientées, et la vue les
  pose en volume, à leur couleur, sur la pente. Une couche à part
  (`/api/vehicules`), calculée après la scène et gardée dans un fichier au nom
  du détecteur ; la scène ne change pas, son cache non plus. Par défaut
  (`aucun`), rien ne change : ni dépendance, ni poids, même image. Mesuré sur
  Gordes et Carcassonne : 91 et 178 véhicules pour `rtmdet` en 3 à 6 s, 146
  et 140 pour `yolo` en 14 à 35 s, 169 et 188 pour les deux ensemble. Le
  LiDAR, lui, ne voit pas les véhicules (0,0 m sur un parking plein), et
  l'analyse d'image classique en retrouvait 8 sur 61.
- **Les panneaux solaires, en option** (`VUE3D_PANNEAUX=oui`). Pas un
  réseau de plus : le registre OpenPVMapper (G. Kasmi, CC-BY 4.0), où
  DeepPVMapper a relevé 471 449 installations en toiture sur la BD ORTHO de
  toute la France, est téléchargé à la construction de l'image et rangé
  dans une base SQLite à index spatial (119 Mo). Chaque installation est
  posée sur le toit tel que la vue le dessine, avec sa surface, sa puissance
  et l'année de la photo. Les poids publiés du réseau lui-même ont été
  essayés d'abord : 79 % d'exactitude sur leur propre jeu de test, rien de
  trouvé sur Gordes ni Carcassonne — on lit le résultat des auteurs.
- **Les piscines avec.** La même option lit aussi les piscines de
  l'orthophoto — la BD TOPO n'a pas celles des particuliers — et la vue les
  pose en bassins, à la couleur de leur eau : 13 à Gordes et 9 à Carcassonne
  pour `rtmdet`, 8 et 8 pour `yolo`, 14 et 9 pour les deux, en une
  demi-seconde de plus. Des 21 taches bleues des deux orthophotos, toutes
  des piscines, `rtmdet` en couvre 20. La couche passe en version 2 : elle
  est recalculée à la première ouverture de chaque lieu, les scènes non.
- `outils/exporter_vehicules.py` convertit les réseaux en ONNX à la
  construction de l'image — leurs poids ne sont pas dans le dépôt —, et
  `outils/mesure_vehicules.py` rejoue la mesure sur des lieux réels.
- `outils/verifier-geometrie.mjs` : exécute sous Node les fonctions
  géométriques de la page et vérifie orientation, fermeture et volumes ; il
  couvre aussi les volumes des véhicules et leur pose sur une pente.

## Scène v12 — 30 septembre 2026

### Corrigé

- **Plus de végétation plus haute que les monuments.** À Notre-Dame de Paris,
  les flèches des grues du chantier, au-dessus des arbres des quais, sortaient
  en houppiers de 52 à 88 m — plus hauts que les tours (69 m) —, et le débord
  des tours sur leur emprise en houppiers et en masses de 60 à 66 m. Hors des
  forêts BD TOPO, où les vrais arbres montent à 43 m (sapins des Vosges), le
  sursol de plus de 40 m n'est plus dessiné. Seuil fixé sur 22 lieux, dont six
  forêts.
- **Plus d'arbres dans l'eau.** Le laser ne revient pas de l'eau : entre deux
  quais, le modèle de hauteur lit leur hauteur en pleine rivière. 438 des
  1 175 houppiers de la scène de Notre-Dame étaient plantés dans la Seine,
  verte à l'orthophoto ; il en reste 807, sur les quais et dans les squares.
  Les étendues d'eau permanentes sortent du sursol, en retrait de 3 m sur la
  rive pour garder le feuillage qui la surplombe. Même effet à Strasbourg, à
  Lyon, au Pont du Gard.

### Limites connues

- En forêt, où rien n'est plafonné, un arbre accroché à une falaise garde une
  hauteur comptée depuis le pied de la paroi : 7 houppiers de 42 à 60 m à
  Rocamadour.
- Le plafond efface aussi ce qui dépasse d'un bâtiment hors de son emprise,
  comme le toit du Stade de France, qui n'était qu'une couronne de masses.

## Scène v11 — 30 septembre 2026

### Ajouté

- **Réservoirs et constructions ponctuelles** de la BD TOPO, dans la scène
  (`vue3d/constructions.py`) : citernes et châteaux d'eau montés à leur
  hauteur, torchères, cheminées, antennes et mâts d'éclairage. Hauteur BD
  TOPO, à défaut LiDAR ; l'infobulle dit laquelle. Bouton **Réservoirs, mâts**.
- **Les citernes sortent du sursol.** Sur quatre parcs de stockage, 2 426
  houppiers et masses sur 5 400 étaient posés sur l'un des 156 réservoirs ; à
  Feyzin, il en reste 82 sur 545.
- **Couche des ouvrages**, chargée après la scène (`vue3d/ouvrages.py`,
  `GET /api/ouvrages`) : murs, ponts, voies ferrées et terrains de sport. La
  hauteur d'un mur ou d'un pont est l'altitude de ses sommets BD TOPO moins le
  relief : 30 murs de rempart de 3 à 25 m à Carcassonne, l'aqueduc du Pont du
  Gard à 47,8 m du Gardon. Les masses de sursol qu'un mur ou un tablier
  explique lui laissent la place. Bouton **Murs, ponts, rails**.
- La couche des ouvrages a sa propre version (`OUVRAGES_VERSION`), dans le nom
  de son fichier de cache : la changer ne reconstruit aucune scène.
- Deux lieux d'exemple : le Pont du Gard et le parc de stockage de la
  raffinerie de Feyzin.
- `outils/mesure_constructions.py`, pour refaire les mesures qui ont fixé les
  seuils.

### Modifié

- La construction d'une scène compte 18 étapes au lieu de 16.
- Le cache sert les couches chargées après la scène — monuments OSM, ouvrages
  — par un même chemin, avec un bassin de fils par source.
- Extrait OpenStreetMap des lieux d'exemple rafraîchi au 30 septembre : le
  Mont-Saint-Michel y passe de 37 à 31 parties, OSM ayant retiré la Porte du
  Roi et cinq parties sans nom. Les règles de remplacement tiennent.

### Limites connues

- Un pont n'est que son tablier : la BD TOPO ne décrit ni piles ni arches.
- Éoliennes, croix, calvaires et murs de soutènement ne sont pas dessinés.

## Scène v10 — 30 septembre 2026

### Modifié

- **Bâtiments coupés au bord de la scène** (`vue3d/batiments.py`). Le WFS rend
  un bâtiment entier dès qu'il touche l'emprise, mais la grille des hauteurs
  s'arrête à son bord : le château de Versailles, une emprise plus grande que
  la scène, n'était qu'une dalle sous la photo aérienne. Coupé à 1,25 m du
  bord, il est mesuré comme les autres ; sa fiche le dit.
- Les cours intérieures restent ouvertes, murs compris.
- Le lieu par défaut devient le village de Gordes.
- Le bouton « Monuments OSM » n'apparaît que si la vue en dessine des parties.

## Scène v9 — 28 septembre 2026

### Modifié

- **Les monuments OSM deviennent une couche à part** (`GET /api/monuments`),
  demandée une fois la scène affichée : OpenStreetMap répond de 0,6 s à plus
  de 100 s et tombe parfois, la scène ne l'attend plus et n'échoue plus avec
  lui.
- Extrait OSM embarqué pour les lieux d'exemple du README : ils n'attendent
  jamais Overpass.

### Corrigé

- L'orbite démarre avec la scène, et non avec la page.

## Scène v8 — 28 septembre 2026

### Ajouté

- **Toits en pans** (`vue3d/pans.py`) : là où le toit résumé s'écarte du LiDAR
  de plus de 0,7 m, des plans ajustés au modèle de hauteur, fermés par leurs
  murs. Un volume est vérifié fermé ou n'est pas publié. 87 % des toits
  proposés à Gordes, 55 % à Strasbourg, à 8-12 cm du LiDAR.
- Suivi de la construction d'une scène, étape par étape
  (`GET /api/avancement`).
- Guide du contributeur (`CONTRIBUTING.md`) et outils de mesure du prototype
  LoD2 des toitures.

### Modifié

- Le bouton « Toits mesurés » est allumé au départ.

### Corrigé

- « Ma position » recentre la scène quand on en est sorti.
- Chemin de cache absolu : en local, l'orthophoto répondait 404.

## Scène v7 — 28 septembre 2026

### Corrigé

- Profil minimal publié pour les bâtiments illisibles : une cabane sous les
  arbres retombait sur des hauteurs BD TOPO contaminées par la canopée (8,1 m
  de murs pour 3 m).
- Les hauteurs BD TOPO ne sont plus relevées du terrain médian : la pente
  était comptée deux fois.

## Scènes v1 à v6 — 27 septembre 2026

### Ajouté

- **Première version** : bâtiments BD TOPO et toits mesurés au LiDAR HD,
  houppiers segmentés arbre par arbre sur le modèle de hauteur à 0,5 m, relief
  RGE ALTI drapé de la photo aérienne, course du soleil et ombres portées.
  Cache disque par point : une scène est complète ou n'existe pas.
- v2 : anneau de relief grossier sur 2 km de côté autour de la scène.
- v3 : surface mesurée du toit, là où le toit résumé s'écarte du LiDAR.
- v4 : étendues et cours d'eau de la BD TOPO.
- v5 : lignes à haute tension et hauteur de leurs pylônes.
- v6 : monuments en 3D d'OpenStreetMap (`building:part`), là où le LiDAR
  manque — l'abbaye du Mont-Saint-Michel, flèche comprise.
- Routes en rubans sur le relief, fond Plan IGN, crédits selon les sources
  affichées, lieux à essayer.
