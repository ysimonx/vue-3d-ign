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

## Scène v15 — 15 octobre 2026

### Ajouté

- **Partager une vue** (3 novembre 2026) : un bouton sur la vue donne un
  lien qui la rouvre telle quelle — la caméra, le jour et l'heure du soleil,
  les couches allumées ou éteintes (`vue=`, `jour=`, `heure=`, `couches=`).
  Au doigt, la feuille de partage de l'appareil ; ailleurs, le lien copié.
  À l'ouverture, chaque couche est remise dans son état dès qu'elle arrive,
  et l'orbite ne démarre pas d'elle-même ; les paramètres du lien quittent
  ensuite l'adresse, que la flèche de décalage ou la recherche reprennent.
- **Les feuillus sans feuilles dans l'ensoleillement des toits** (3 novembre
  2026). Les arbres faisaient une ombre opaque toute l'année. Ils laissent
  maintenant passer 3 % du soleil en feuilles et 46 % sans, mesurés sur des
  arbres de rue (Konarska et al., 2014) : un pin, un résineux ou un chêne
  vert au premier taux toute l'année, un feuillu au second du 26 octobre au
  7 avril, d'après le chêne pédonculé du réseau RENECOFOR. Sur une zone de
  1 000 m, la part du soleil perdue à l'ombre ne baisse que de 0,1 à
  0,2 point ; le gain va aux toits sous des feuillus, jusqu'à 14 % au
  Champ-de-Mars. Le calcul prend 1,5 à 3,6 s en zone de 1 000 m, 8 s en
  zone de 2 000 m.
- **L'ensoleillement des toits** (31 octobre 2026), au bouton
  « Ensoleillement » : chaque toit peint du soleil qu'il reçoit sur une
  année, du brun au jaune pâle, en kWh/m²/an ; au survol, la valeur au
  point ; dans la fiche, la moyenne du toit, son meilleur endroit, ce que
  l'ombre lui fait perdre, sa surface favorable (au moins 70 % du meilleur
  plan dégagé du lieu) et un ordre de grandeur de la puissance et de la
  production possibles. Le climat est l'année type de PVGIS (Commission
  européenne), lue au premier clic par la nouvelle couche `/api/solaire`,
  datée et gardée avec la scène ; l'ombre est celle de tout ce que la vue
  dessine — bâtiments, toits mesurés, arbres, relief —, calculée par le
  navigateur sur la carte graphique pour environ 330 directions du soleil et
  du ciel : 1,7 s à Gordes, 2,5 s à Strasbourg en zone de 1 000 m sur un Mac
  M4, 6 s en zone de 2 000 m. Sur un plan dégagé, le calcul reste à 3 % près
  de PVGIS sur les plans favorables de quatre lieux
  (`outils/verifier-solaire.mjs`).
- **Viaducs ferroviaires, métro aérien et passerelles dans la vue en voiture**
  (24 octobre 2026). Seuls les ponts que la route emprunte étaient dessinés ;
  ce qui l'enjambe l'est aussi maintenant, à l'altitude de son tablier : les
  voies ferrées au-dessus du sol sur leur ballast (le métro aérien du
  boulevard de Grenelle, 7 à 13 m au-dessus du terrain), et les passerelles,
  sans piles (la passerelle Simone-de-Beauvoir franchit la Seine d'un bond).
  Les carrés passent en version 3 : relus à la Géoplateforme à leur première
  demande, avec les voies ferrées, lues en même temps que le reste.
- **Les tunnels dans la vue en voiture** (24 octobre 2026). Jusqu'ici, la
  voiture suivait le relief et passait par-dessus la colline ; elle passe
  maintenant dessous. La route souterraine va en ligne droite d'une entrée
  à l'autre : l'altitude que donne la BD TOPO manque à Toulon et au
  Mont-Blanc, et passe au-dessus du terrain sur un sommet sur cinq au
  Prado-Carénage. Chaque entrée a sa tête, un mur de béton percé d'une
  voûte noire. Quand la route prévue passe sous terre, une voûte
  translucide la montre à travers le relief, et la caméra suit la voiture
  dans le tunnel : on n'y voit plus que la voûte, la route et la voiture,
  sur le noir de la roche. La 2D reste au-dessus de la carte. Sans GPS, la
  voiture file jusqu'à la sortie au lieu de se figer au bout de 40 s ; la
  conduite simulée perd le GPS sous terre, comme une vraie.
- **« Macron démission ! » dans le cortège** (23 octobre 2026) : un second
  chant de foule, tiré d'une vidéo de Luc Auffret place de la République
  (repris avec son accord), alterne avec « Tous ensemble » d'une vague à
  l'autre. L'enregistrement n'en a que 4,5 s nettes : une boucle de deux
  tours (3,2 s, 40 Ko), en vagues plus courtes, de 8 à 15 s, pour ne pas
  tourner en rond. Même sonie que le premier (−21 LUFS seul ; le brouhaha à
  −25, le chœur des slogans à −16).
- **Un chant de tribune dans le cortège** (23 octobre 2026) : « Tous
  ensemble, ouais ! », enregistré dans une tribune, s'élève par vagues de 12
  à 32 s au-dessus du brouhaha, plus longues et plus proches quand l'élan
  monte, un tiers du temps au plus. Les tambours, à contretemps, s'effacent
  sous lui ; un slogan lancé le fait taire, un élan sous 30 aussi ; de loin,
  il arrive étouffé. Premier son enregistré du jeu : une boucle de 23,3 s (sept
  tours du chant), coupée là où l'enregistrement se ressemble le plus,
  285 Ko lus au premier départ du cortège. Seul, il sonne à −24 dB, entre le
  brouhaha (−28) et le chœur des slogans (−19).
- **Les bornes de recharge dans la vue en voiture** (23 octobre 2026), au
  bouton « Bornes » : celles de la Base nationale des IRVE, à 3 km autour de
  la voiture et le long de la route prévue, en pastilles teintes de leur
  puissance comme sur la page de la scène, dessinées par-dessus les
  bâtiments, comme les repères d'un GPS. Un toucher ouvre la fiche de la
  station : distance, opérateur, points de charge, puissance, prises, accès.
  Chacune a sa portée selon sa puissance (600 m jusqu'à 22 kW, 2 km jusqu'à
  149, 4 km au-delà) et une pastille qui en recouvre une plus puissante
  s'efface : à l'Étoile, six pastilles au lieu d'un ruban de plusieurs
  centaines. Lues au serveur par bloc de 4 km (`/api/bornes-bloc`, 0,5 s à
  la campagne, 8 à 35 s au cœur de Paris la première fois), gardées une
  semaine ; le choix du bouton est retenu d'une visite à l'autre, `bornes=0`
  ou `bornes=1` l'emporte.
- **Signaler un défaut de la vue en voiture** (23 octobre 2026) : un bouton ⚠
  au-dessus du compteur, comme celui de Coyote. Un appui envoie au serveur
  une capture de l'écran, la position et l'état du sol (tuiles sous la
  voiture et autour, leur photo et sa part de blanc pur, leurs altitudes,
  le cache du navigateur, le GPU, les pauses de l'onglet) ; le serveur les
  garde dans `cache/signalements/` (`POST /api/signalement`, 3 Mo, 300
  gardés, 30 par heure et par adresse avec le quota), la page affiche leur
  numéro. Sans réseau, le signalement attend et repart seul. Le bandeau dit
  aussi ce que la page voit manquer sous la voiture ou 60 m devant, après
  5 s : sol absent, sans photo, photo blanche, sans relief ou mal posé, et
  le bouton s'allume. Né d'une photo prise dans une Tesla : le sol sans
  photo près de la voiture, sans aucun refus de tuile au serveur ni « tuile
  en attente », et entier au même endroit sur un ordinateur.
- **Les limitations de vitesse dans la vue en voiture** (22 octobre 2026) :
  un panneau à côté du compteur, pour la route et le sens où l'on roule, et
  sa source dessous. « OpenStreetMap » quand la limite y est relevée
  (`maxspeed`, rapproché des tronçons BD TOPO à 12 m près et dans leur
  axe) ; « estimée », panneau gris, sinon : la règle générale du code de la
  route, 50 km/h en agglomération, 80 sur une route, 110 à chaussées
  séparées, 130 sur autoroute. Aucune base nationale n'est publiée, et la
  BD TOPO n'a qu'une vitesse moyenne estimée. La vitesse passe au rouge
  au-delà de la limite ; `vitesse=limite` fait rouler la conduite simulée
  aux limitations. Couche à part (`/api/vitesses`), lue à Overpass par bloc
  de 2 km gardé pour toujours : 30 s à 4 min par bloc neuf le jour de sa
  mise en service.
- **La vue en voiture** (20 octobre 2026), au bouton en forme de voiture sous
  « Ma position », ou `/voiture` : une page à part, qui suit la position
  comme un GPS, pour l'écran d'un téléphone ou d'une voiture. La scène ne
  pouvait pas suivre : une zone de 1 000 m se traverse en 40 s à 90 km/h,
  quand une scène demande 10 à 30 s et que la prod en limite la
  construction à 20 par heure.
  - **Un monde qui défile**, en Lambert-93 : le sol en tuiles de
    l'orthophoto ou du Plan IGN posées sur le RGE ALTI, fines près de la
    caméra et là où la voiture sera dans 6 et 12 s ; les bâtiments par
    carrés de 500 m de la BD TOPO seule (`/api/carre`, 0,12 à 0,33 s et 5 à
    34 Ko par carré), chargés le long de la route prévue et libérés
    derrière. À 130 km/h sur l'A7, ils sont prêts 5,4 à 5,9 km devant la
    voiture, à 60 images par seconde (Chrome, Mac M4).
  - **La route prévue**, tracée en bleu : la route où l'on roule, prolongée
    sur le graphe BD TOPO (tout droit, sur la même voie, de même
    importance ; aux ronds-points, la sortie la plus proche du cap
    d'entrée), sur 2 à 6 km selon la vitesse. Sentiers, escaliers, pistes
    cyclables et galeries marchandes n'en sont pas.
  - **Les arbres** (même jour, en couche à part : `/api/vegetation`) :
    ceux de la scène, découpés un par un sur le MNH du LiDAR HD à 0,5 m,
    avec l'orthophoto, la BD TOPO et la BD Forêt (1,1 à 4,6 s de lecture
    et 0,1 à 0,2 s de découpe par carré), sur 250 m de part et d'autre de
    la route et 2 km devant. Houppiers en facettes et cônes de conifères,
    translucides (45 %), à la couleur de leur port, effacés à moins de 15 m
    de la caméra ; trois appels de dessin par carré.
    Jusqu'à 93 000 arbres et 3,1 millions de triangles à Gordes, toujours à
    60 images par seconde ; bouton **Arbres** pour un écran trop lent. Les
    bords de toit que le LiDAR voit hors des emprises BD TOPO, classés en
    végétation par une photo un peu verte, en sont écartés : à Paris, ils
    faisaient 80 % des « arbres » de plus de 8 m, des poteaux verts de 15 m
    le long des façades (la scène les garde, transparents). De même pour
    les tabliers des ponts, que le LiDAR voit comme un arbre : 23
    houppiers de 6 m sur un pont qui franchit l'A7.
  - **Les routes et les ponts** (même jour) : les tronçons de chaque carré,
    découpés à son bord, en rubans sur le relief à la largeur de chaussée
    BD TOPO (60 %, la photo de l'asphalte passe ; effacés sur le plan), et
    les ponts en tabliers à l'altitude de leurs tronçons — celle du tablier,
    de 598 à 676 m sur le viaduc de Millau —, avec parapets et piles là où
    le vide dépasse 3 m. Les tronçons fictifs, qui ne font que raccorder le
    réseau, ne sont pas dessinés (format des carrés en version 2).
  - **La caméra plus basse** : 45 m de recul sous 18°, soit 17 m au-dessus
    de la voiture à l'arrêt et 22 m à 130 km/h, contre 38 et 59 m, et la
    voiture plus bas dans l'écran, vers 71 % de sa hauteur (60 % avant).
    Elle ne change jamais d'angle pour un obstacle — montée au-dessus des
    toits voisins, elle sautait sans cesse dans un village : les bâtiments
    et les arbres qui la frôlent ou la séparent de la voiture s'effacent.
  - **Les tuiles gardées dans la voiture** : les photos, le plan et les
    altitudes de l'IGN, qui n'ont aucun en-tête de cache et se relisaient
    à chaque trajet sur le réseau mobile, sont rangés par la page dans le
    stockage du navigateur (15 000 tuiles au plus, un cache par trimestre).
    À Rousset, le même trajet refait : sol net sous la voiture après 1 s
    au lieu de 11,5 s, 44 tuiles lues sur le réseau au lieu de 433, et
    autant sans réseau du tout. Les photos fines et les altitudes d'une
    bande de 120 m de part et d'autre de la route prévue sont de plus
    chargées d'avance sur 2 km : dans la seconde moitié d'une coupure de
    réseau d'une minute à 110 km/h, sur un trajet neuf, le sol reste net
    sous la voiture 60 % du temps, contre 12 % sans. Une tuile manquée
    (pas de réseau, IGN en panne) est notée, gardée d'une session à
    l'autre, et redemandée plus tard, les plus demandées d'abord ; le
    panneau d'état dit combien attendent le réseau.
  - **Une destination pour la conduite simulée** : `vers=lat,lon` (et
    `versnom`) ; la page lit les carrés entre départ et arrivée, calcule le
    plus court chemin sur le graphe BD TOPO (sens interdits respectés,
    grands axes préférés), la voiture simulée le suit en ralentissant dans
    les virages et s'arrête à l'arrivée ; la route bleue est l'itinéraire,
    le panneau dit la distance qui reste. De la Bastille à la Nation :
    2 202 m par le faubourg Saint-Antoine. `outils/film-voiture.mjs` en
    tire un film, muet, image par image (`attente=1` : la voiture attend au
    départ que tout soit chargé).
  - **La voiture** calée sur la route, vue de derrière ou de dessus, avec
    la vitesse, le nom de la rue et le cartouche de la route (A7, D15) ;
    entre deux relevés, elle avance le long de la route, et dans un tunnel,
    jusqu'à 40 s sans GPS. Les façades entre la caméra et elle s'ajourent ;
    la nuit, le ciel et la photo s'assombrissent ; l'écran reste allumé là
    où le navigateur le permet.
  - **Une conduite simulée**, `?simu=1&lat=…&lon=…&vitesse=…`, pour
    l'essayer sans rouler, et `outils/essai-voiture.mjs` pour la vérifier
    dans un navigateur.
- **Un second jeu : le cortège**, par le bouton **Cortège** en vol (ou
  `?jeu=cortege`). Il s'agit de mener une marche pacifique, de la place de
  la scène jusqu'à son arrivée, par les rues de la BD TOPO, avec le plus de
  monde, sans que la préfecture l'interrompe. Refait de fond en comble le
  jour de sa sortie : la première version se jouait presque seule, et elle
  était muette.
  - **L'arrivée et le parcours déclaré.** On clique l'arrivée ; sans clic
    au bout de 10 s, la page choisit une place dégagée, à 400 à 700 m par
    les rues. Le plus court chemin devient le parcours déclaré, tracé en
    tirets verts au sol. Le drone suit la tête et filme.
  - **Deux jauges.** L'**élan**, l'énergie de la foule : haut, il presse le
    pas et entraîne les passants ; sous 30, des gens rentrent chez eux. Le
    silence, le soleil, l'attente et le gaz l'usent. La **tension**, la
    patience de la préfecture : elle monte hors du parcours déclaré, contre
    un cordon, avec des casseurs dans les rangs ; à 70, les sommations ; à
    100, la préfecture interrompt le cortège.
  - **Les slogans**, touches **1** à **4** ou boutons en bas de la vue :
    l'ambiance (élan), l'appel aux passants, le calme (tension, casseurs
    isolés, négociation), et ceux de la ville, au nom de la commune et des
    rues (« Gordes, debout ! »), quand l'élan dépasse 60. Chacun a sa
    recharge ; le même registre deux fois de suite porte moitié moins.
  - **Le son**, tout de synthèse : un brouhaha qui suit la foule et son
    élan, des tambours au pas, des sifflets, et chaque slogan lancé au
    mégaphone puis repris en chœur, sur son rythme et ses voyelles, le
    texte affiché au-dessus de la tête. **M** le coupe.
  - **Les passants**, par grappes sur les trottoirs, d'autant plus nombreux
    que la rue est bordée de logements et de commerces (BD TOPO). Leur
    nombre s'affiche au-dessus d'eux ; « Aux passants » les appelle, et une
    tête pleine d'élan les entraîne. Le parcours le plus court n'est pas le
    plus peuplé.
  - **Les cordons.** La préfecture ferme d'emblée quelques rues qui partent
    du parcours, puis une ou deux devant le cortège en marche. Arrêté
    devant, on négocie (**N**) : un sit-in, qui aboutit d'autant plus vite
    que la tension est basse ; ou l'on fait demi-tour (**↓**).
  - **Les groupes** (lycéens, soignants, gilets jaunes, agriculteurs,
    habitants du quartier : trois par partie) attendent à quelques rues
    qu'on passe les prendre.
  - **Les casseurs** approchent pour s'infiltrer. **F**, ou un clic sur
    eux, envoie le service d'ordre les escorter dehors. Un casseur laissé
    faire met le feu, parfois une barricade devant la tête ; le gaz qui
    répond disperse ceux qui s'y trouvent.
  - **Personne n'est frappé.** Les cordons bloquent sans charger, et le gaz
    ne répond qu'aux incidents.
  - **À l'arrivée, un rassemblement** autour d'un camion sono : prises de
    parole, applaudissements, fumigènes de couleur. Puis le bilan : des
    étoiles pour le monde arrivé, l'élan moyen et le calme, un score, le
    record gardé dans le navigateur.
  - **Les commandes de la marche** ne changent pas : **← →** la branche au
    prochain carrefour, qu'une flèche au sol annonce avec le nom de la
    rue ; **↑ ↓** la cadence ; **↓** à l'arrêt fait demi-tour. Une rue
    étroite étire le cortège et le ralentit, un boulevard le resserre, une
    montée le ralentit.
  - **Des parties au pilote**, à midi le 19 octobre. Place de la République,
    en variant les slogans : 1 330 participants à l'arrivée sur 1 200 au
    départ (130 passants), élan moyen 77, en 1 min 58 s. À Gordes, sans
    un slogan : 571 à l'arrivée, élan moyen 13, en 3 min 36 s ; avec :
    1 340, élan moyen 66.
  - Les enjeux sont ceux des manifestations de l'automne 2026 : un parcours
    négocié avec la préfecture, des cortèges débordés par des casseurs et
    interrompus avant leur terme.
  - Rien dans la scène ni dans le cache. Le film `cortege carre`
    (`outils/demo-video.mjs`) en joue une partie, de la place de la
    République au canal Saint-Martin, **avec le son du jeu** : le film étant
    capturé image par image, la page y reçoit un `OfflineAudioContext` réglé
    sur l'heure du film, et la piste, rendue à la fin et ramenée à −16 LUFS,
    est montée sous la vidéo. `SON=0` la retire.
- **Un logo, la Tuile** : une carte de neuf cases en perspective
  isométrique, dont celle du centre se lève en volume, à l'orange de la page.
  Il remplace l'arbre du favicon, sert d'icône à la page ajoutée à l'écran
  d'accueil, précède le titre du panneau et ouvre le README (versions claire
  et sombre). Les fichiers sont dans `docs/logo/`, avec l'aperçu des liens
  vers le dépôt GitHub.
- **Le service sous `container`, l'outil d'Apple, à la place de Docker
  Desktop.** `run_container.sh` construit le même `Dockerfile` et lance le
  service dans une petite machine virtuelle Linux (macOS 26, Apple silicon,
  `brew install container`), avec les variables et les défauts de
  `docker-compose.yml`. Il lui donne tous les cœurs et 4 Go, au lieu du
  1 Go par défaut de `container`, et garde les scènes dans le volume
  `vue-3d-ign-scenes`. Pas de CoreML : les détecteurs y tournent au
  processeur, comme sous Docker.
- **Un jeu en drone : la traque.** En vol, le bouton **Traque** lâche dans la
  scène un petit bonhomme, Vladimir, une figurine, qui court sur les
  routes BD TOPO de véhicule en véhicule : il en choisit un à 30 à 150 m par
  la route, y va par le plus court chemin, s'y cache quelques secondes, et
  détale quand le drone approche à moins de 45 m. Toutes les 15 s, un indice
  au milieu de la vue dit de quel côté tourner (« Tournez à droite »,
  « Demi-tour »…), avec sa distance, le point cardinal, s'il court ou se
  cache, une grande flèche et un bip ; la petite flèche du bandeau, en haut
  à gauche, passait inaperçue. **F**, ou **TIR** au doigt, tire sous le
  réticule rouge, un clic ou un toucher tire là où il désigne. Touché, il
  tombe, une nouvelle manche commence 5 s plus tard, loin du drone ; le
  meilleur temps est gardé dans le navigateur. `?jeu=traque` ouvre la page
  dans la traque, drone décollé. À Gordes, il reste à 16 m d'un véhicule en médiane, contre 132 m
  au hasard des carrefours. Rien dans la scène ni dans le cache ; sans la
  couche des véhicules, il court au hasard des routes.
- **Une zone de 2 000 m**, par `&zone=2000` dans l'URL ; la
  zone par défaut reste de 1 000 m, et ses scènes sont les mêmes à l'octet
  (Gordes et 700 m, vérifié contre la version d'avant). Quatre fois la
  surface, à la même finesse :
  - la grille de hauteurs à 0,5 m (3 971 px du nord au sud), le terrain sous
    les toits et la verdure de l'orthophoto se lisent en tuiles de 2 048 px,
    le plafond du WMS : au-delà, toits et houppiers auraient perdu leur
    résolution ;
  - la mosaïque d'orthophoto garde 0,49 m par pixel (4 096 px, en tuiles,
    réencodée à la qualité du WMS), le relief sa maille de 2 m (1 024
    points), l'anneau sa maille de 44 m (256 points) ;
  - les fonds en tuiles WMTS de l'anneau et du Plan IGN descendent d'un
    zoom : 582 tuiles au lieu de 1 624 à Gordes.

  À Gordes, la scène se construit en 9,5 s au lieu de 4,4 (1 564 bâtiments,
  81 875 houppiers, 3,8 Mo gzippés au lieu de 1,1) ; son calcul tient 3,2 Go
  de mémoire au pic au lieu de 0,87 : le service n'en construit qu'une à la
  fois au-delà de 1 000 m (`Cache.GRANDES_ZONES_ENSEMBLE`), les autres
  attendent leur tour. Le nuage LiDAR HD n'y est lu que sur le kilomètre
  central (`nuage.NUAGE_COTE_MAX_M`) : sur la zone entière, la Géoplateforme
  répondait 429 en 7 s, et quatre fois les 2,7 Go de mémoire mesurés à
  1 000 m n'auraient pas tenu. Les exports pèsent 250 Mo en IFC et 1,1 Go
  en CityGML. Le sélecteur **Zone** ne la propose pas : en ligne, la vue
  y rame (81 875 houppiers à Gordes, quatre fois ceux de 1 000 m) ; il
  l'affiche quand l'URL la demande.
- **Une visionneuse IFC de contrôle**, `outils/visionneuse-ifc.html` : un
  fichier exporté (⬇ IFC 4), glissé sur la page, relu par web-ifc (That Open
  Company, MPL-2.0) comme un autre logiciel le lirait — chaque volume tel que
  tiré du fichier, son repère (IfcMapConversion), le compte par classe, et
  au clic la classe et les propriétés d'un objet. À Notre-Dame de Paris, en
  zone de 1 000 m : 24,4 Mo, 979 bâtiments, 3 679 arbres, lus en 0,8 s. Elle
  sert au film `export` de la série de démos (`node outils/demo-video.mjs
  export carre|paysage`) : les deux exports cliqués, puis l'IFC rouvert,
  la cathédrale et un arbre du square Jean-XXIII sélectionnés.
- **L'onglet porte l'adresse postale du point** : « 1 Place du Château,
  84220 Gordes · Vue 3D IGN ». La plus proche selon le géocodage inverse de
  l'IGN, qui n'en rend pas au-delà de 200 à 300 m : sur quinze lieux publics,
  elle est à 2 à 126 m du point. Le nom choisi dans la recherche la précède
  — « Arc de Triomphe — 9 Place Charles de Gaulle, 75116 Paris » —, sauf
  s'il y est déjà (une adresse, une commune). En forêt ou sur l'eau, sans
  adresse, l'onglet prend le nom du panneau, ou reste « Vue 3D IGN ».
- **Les bornes de recharge pour véhicules électriques**, au clic sur leur
  bouton, comme les DPE : une borne par station, et au-dessus une pastille à
  éclair teinte de sa puissance la plus haute (jusqu'à 22 kW, 23 à 149 kW,
  150 kW et plus). Survol ou toucher : opérateur, points de charge,
  puissances, prises, accès, horaires ; le clic l'épingle avec « Recentrer
  la scène sur cette station » et « Y aller ».
  - Source : la Base nationale des IRVE, consolidée chaque jour par
    data.gouv.fr (Licence Ouverte 2.0), lue sur l'emprise par l'API
    tabulaire, sans télécharger le fichier de 101 Mo : 0,7 s pour les 108
    points de charge de 7 stations autour de l'Opéra, à Paris. Datée,
    gardée avec la scène, relue par « Reconstruire la scène » ; une lecture
    incomplète n'écrit rien.
  - La pastille garde sa taille à l'écran : une borne de 1,6 m n'est qu'un
    pixel vue de 900 m, et le doigt doit la trouver. Une station sous un
    toit (parking souterrain, adresse prise au milieu d'un îlot : la
    première des sept de l'Opéra) a sa pastille 4 m au-dessus du toit.
- **« Y aller »** sur un bâtiment (infobulle épinglée et fiche) et sur une
  station de recharge : l'itinéraire dans Plans sur iPhone et iPad, dans
  Google Maps ailleurs. Une page ne peut pas guider une voiture : sur l'écran
  d'une Tesla, l'itinéraire s'ouvre dans Google Maps ; depuis le téléphone,
  le partage vers l'application Tesla l'envoie à la voiture.
- **La recherche trouve « borne de recharge aubagne »** : un mot tapé de
  quatre lettres ou plus couvre aussi les mots qui commencent par lui
  (« recharge », « Borne de rechargement électrique »), et la borne de l'IGN
  passe devant celles d'autres communes.
- **Chercher un lieu nommé, une entreprise ou un commerce**, en plus d'une
  adresse : « mairie bouc bel air », « pharmacie bouc bel air », « notaire
  aix en provence ». Les lieux nommés de l'IGN étaient déjà demandés, mais
  avec les adresses, sur un seul score où toute rue de la commune passait
  devant : sans le « de », la mairie de Bouc-Bel-Air (0,39) restait hors des
  quinze rues (0,42 à 0,54). Les deux index sont lus séparément, et ce qui
  porte tous les mots tapés passe en tête, au pluriel près (« notaire » :
  « Aix Mistral Notaires »).
  - Les entreprises viennent de l'API Recherche d'entreprises de l'État
    (SIRENE), sans clé : en activité seulement, et seulement si leur nom ou
    leur enseigne porte les mots tapés — sinon « gordes » rendait des
    sociétés « Gord » de Moulins. Trois au plus, l'enseigne la plus proche
    de la recherche d'abord ; une entreprise du même lieu qu'un lieu nommé
    proposé (les sociétés du musée d'Orsay, à 97 à 122 m ; les associations
    d'Airbus Helicopters, jusqu'à 662 m de l'usine) ou de la même adresse
    qu'une autre (0 à 26 m) n'est pas proposée deux fois.
  - Un entrepreneur individuel porte le nom d'une personne : il n'est
    trouvé que par son enseigne.
  - `verifier-recherche.mjs` rejoue ces cas sur des réponses enregistrées
    (`outils/recherche-exemples.json`, collectivités, établissements publics
    et grandes sociétés seulement), et un exemple fictif pour les
    entrepreneurs individuels.
- **Recentrer la scène sur un arbre, un véhicule, un bateau ou une
  piscine**, comme sur un bâtiment. Un clic (ou un toucher) épingle leur
  infobulle avec « Recentrer la scène sur ce véhicule », qui recharge la
  page centrée sur l'objet, à la même zone. Au doigt, sans survol, c'est
  ce toucher qui montre l'infobulle. Essayé au port de Monaco, souris et
  doigt : le lien tombe au centre de l'objet (moins de 0,5 m).
- **Un guide de prise en main.** Il s'ouvre de lui-même à la première
  visite, pendant que la scène se construit, puis par le bouton « ? » sous
  les commandes de la vue : tourner, zoomer, se déplacer, la fiche d'un
  bâtiment, changer de lieu, ce qui s'affiche, le drone, ma position. Les
  gestes suivent l'appareil — au doigt dès que l'écran est tactile, comme
  celui d'une Tesla qui annonce pourtant un pointeur fin —, avec une
  bascule vers la souris. Un navigateur piloté (essais, démos filmées) ne
  le voit pas s'ouvrir seul ; `essai-navigateur.mjs` l'ouvre, bascule les
  gestes et le referme.

- **Le nuage LiDAR HD se lit en deux temps.** En zone de 800 m et plus, la
  page demande d'abord un carré de 400 m autour du point (`/api/nuage?…&proche=1`),
  l'affiche dès qu'il est lu, puis la zone entière, qui le remplace. Le carré
  coûte le quart des octets de la zone (44 Mo sur 159 à Gordes, 27 sur 107 à
  la tour Eiffel, en zone de 1 000 m) : l'ouvrage visé, presque toujours au
  centre, apparaît bien avant le reste. La zone entière relit ce carré : la
  couche complète arrive un peu plus tard qu'avant.
  - Le carré est calé sur les mailles de la zone entière, et n'y sont jugés
    que les bâtiments qu'il contient entiers : ses ouvrages ajourés sont
    aussi ceux de la zone entière, rien n'apparaît pour disparaître ensuite.
  - La couche entière ne change pas, et celles déjà en cache restent
    valables : déjà lue, elle répond seule à la demande du carré.
- **Les toits dessinés sont vérifiés contre le nuage LiDAR HD**, à la fin de
  chacune de ses deux lectures (le carré proche, puis la zone entière) et à
  chaque bouton des toits. Les toits sont tirés du MNH à 0,5 m ; les points
  « bâtiment » bruts du nuage en sont un contrôle indépendant. Pour chaque
  toit, le point le plus haut de chaque mètre carré, à plus de 1 m du
  contour, est comparé au toit à sa verticale :
  - la fiche du bâtiment dit son **décalage** (l'écart médian) et la part de
    ses points **hors de sa forme**, à plus de 0,5 m du toit une fois le
    décalage ôté ; au-delà de 40 %, le toit est « en écart » ;
  - le panneau compte les toits vérifiés et ceux en écart ;
  - avec « Nuage LiDAR » allumé, ces points sont colorés : bleus sous le
    toit, rouges au-dessus, gris pâle à ±0,25 m.
  - Mesuré en zone de 1 000 m, en médiane : les pans mesurés ont 11 % de
    leurs points hors de leur forme à Gordes, 13 % à la tour Eiffel (aucun
    toit en écart à Gordes, un sur 17 à la tour), les toits plats aucun ; les
    toits résumés en deux pans, de 21 à 55 %. Sur le coteau provençal des
    toits-terrasses, les huit villas passées en pans ont de 2 à 20 % de leurs
    points hors de leur forme, de 9 à 85 % quand on éteint « Toits mesurés ».
  - `outils/mesure-ecarts-toits.mjs` relève ces chiffres dans la vraie page.
- **Les tuiles refusées par l'IGN sont relues et gardées par le serveur.**
  La Géoplateforme refuse par épisodes une tuile d'orthophoto ou de Plan IGN
  qui existe : 253 refus en une visite le 15 octobre vers 17 h 15, aucun
  ensuite. La page réessayait une fois après 1,5 s ; au second refus, un trou
  ou une tuile floue restait, à l'horizon surtout. Elle demande désormais
  chaque tuile au serveur (`/api/tuile/<couche>/<z>/<x>/<y>`), qui sert celles
  qu'il a en stock et redirige les autres vers l'IGN, où le navigateur les lit
  comme avant. Une tuile refusée, la page la fait relire au serveur
  (`?relire=1`) : il la lit avec reprises, la garde et la rend — à tous les
  visiteurs ensuite.
  - Ce n'est pas le débit : 576 tuiles lues 12 à la fois, 576 une à une
    toutes les 100 ms, aucun refus de part et d'autre. La page n'espace donc
    pas ses demandes.
  - Rien de ce qu'envoie un navigateur n'entre au stock : l'IGN ne donnant
    ni ETag ni date de modification, une image reçue ne se vérifie pas.
  - Une tuile gardée est effacée au bout de 90 jours, l'IGN renouvelant
    l'orthophoto ; une purge passe une fois par jour.
  - Deux relectures à la fois pour tout le service, refusées aussitôt
    au-delà (503) : elles prennent des places à la Géoplateforme et des fils
    au serveur. Avec `VUE3D_QUOTA`, 1 000 relectures par heure et par
    adresse IP. Une tuile vraiment absente (la mer au large, l'étranger) est
    retenue une journée, en mémoire, sans être redemandée.
  - Essayé dans un navigateur sous refus simulés (une tuile sur cinq) : 81
    refusées, 81 relues ; à la visite suivante, 82 servies du stock.
  - `outils/essai-navigateur.mjs` ne compte plus comme erreur un refus de
    l'IGN que le serveur a rattrapé, et dit combien de tuiles viennent du
    stock.

### Modifié

- **Le code des pages et du serveur, rangé** (24 octobre 2026) : la page de
  la scène et la vue en voiture ne sont plus deux fichiers de 10 700 et 3 800
  lignes, mais leur HTML, une feuille de style chacune (`static/css/`) et des
  modules ES (`static/js/scene/`, `static/js/voiture/`, et ce qu'elles
  partagent dans `static/js/commun/`), toujours sans build. Les routes du
  serveur sont rangées par page, en blueprints Flask (`vue3d/routes/`).
  Rien ne change à l'écran : à Gordes et sur les Champs-Élysées, à horloge
  figée, les deux vues rendent la même image au pixel près.
  `outils/verifier-modules.mjs` garde l'ordre où les modules s'évaluent, qui
  est celui de leurs effets. Rien dans la scène ni dans le cache.
- **Les jeux sont retirés** (23 octobre 2026) : la traque et le cortège
  quittent la page, avec leurs boutons **Traque** et **Cortège**, leurs
  chants enregistrés (`static/son/`) et leurs films dans
  `outils/demo-video.mjs`. `?jeu=` ne lance plus rien. La vue 3D garde le
  drone, et la vue en voiture ne change pas. La page perd 4 440 lignes, le
  tiers de son code. Rien dans la scène ni dans le cache.
- **La voiture à sa taille réelle** (22 octobre 2026), dans la vue en
  voiture de derrière : grossie dès le recul par défaut (×1,9), elle faisait
  3,5 m de large et couvrait 70 % de la route sous elle. Elle ne grossit plus
  qu'au-delà de 60 m de recul, comme l'icône d'un GPS ; la vue de dessus ne
  change pas.
- **Le bouton de la vue en voiture, à côté du drone** (22 octobre 2026) :
  les deux façons de se déplacer côte à côte, sous le bouton du nuage LiDAR,
  plutôt que la voiture sous « Ma position ».
- **Le jeu des incendies est retiré**, un jour après son arrivée : son
  bouton **Feux** disparaît, `?jeu=1` ouvre de nouveau la traque, et le film
  `feux` quitte `outils/demo-video.mjs`. Le cortège garde ses figures, ses
  flammes et sa fumée.
- **À l'ouverture, la scène entière est dans le cadre.** La caméra se tenait
  à 180 m du point, réglés pour l'ancienne emprise de 356 m : en zone de
  1 000 m, on ne voyait que le centre. Elle recule désormais, sous le même
  angle, jusqu'à voir le milieu des quatre côtés de l'emprise, d'après la
  zone, le relief et la forme de la vue : à Gordes, 321 m en zone de 350 m,
  906 m à 1 000 m, 1 856 m à 2 000 m ; plus loin sur un téléphone en
  portrait, plus étroit (2 078 m à 1 000 m).
- **La page s'ouvre là où l'on est.** Sans point dans l'URL, elle propose
  de se géolocaliser : position déjà autorisée, ou autorisée à la demande,
  la scène se construit autour d'elle, repère de « Ma position » suivi.
  Sinon — refus, demande restée sans réponse 10 s, position hors de France
  métropolitaine ou indisponible —, elle s'ouvre sur la tour Eiffel, nuage
  LiDAR allumé, la tour entière dans le cadre ; une autorisation donnée
  après coup y emmène quand même. Le village de Gordes n'est plus le lieu
  par défaut. Un lien avec `?lat=…&lon=…` ne demande jamais la position.
- **Le bouton du nuage LiDAR aussi sur la vue**, au-dessus du drone, accordé
  à celui du panneau.
- **« Ma position » est une icône sur la vue**, sous le bouton plein écran,
  et non plus un bouton du panneau : sur téléphone, le panneau est replié.
  Ses messages (localisation en cours, refus, https exigé) s'affichent aussi
  sur la vue ; le détail reste dans le panneau.
- **Les toits-terrasses ne sont plus dessinés en pente.** Le toit résumé —
  deux pans, un toit par faîtage, pyramide — met une pente dès que le haut
  du toit dépasse le bas de 0,5 m : la marche entre deux terrasses, ou la
  pente du terrain sous un toit plat, suffisait. Et les pans mesurés n'en
  prenaient la place qu'à plus de 0,7 m d'écart au LiDAR, qu'un toit de 1 m
  de dénivelé posé sur des terrasses n'atteint pas. Un toit dont les pans à
  moins de 3° portent 80 % des cellules reçoit désormais ses pans, quel que
  soit l'écart : chaque terrasse à sa hauteur, un mur à chaque marche.
  - Signalé sur un coteau provençal de villas récentes à toits-terrasses
    étagés : sept villas sur 369 bâtiments y passent en pans, toutes grises
    sur l'orthophoto. Aucun toit ne change à Gordes (672 bâtiments) ni à
    Strasbourg (1 374) ; tous les autres toits sont identiques à l'octet.
  - Un pan plat ne compte que s'il s'étend sur environ 3,5 m de large : sur
    une annexe étroite, la pente en travers ne se lit pas, et un appentis de
    cour à Strasbourg passait pour plat.
  - Les toitures d'une scène coûtent un peu plus : 5,4 s → 5,8 s à
    Strasbourg en zone de 1 000 m, sur un seul processus.

### Corrigé

- **Les ponts effondrés de la vue en voiture** (24 octobre 2026), signalé
  depuis une Tesla : la BD TOPO pose parfois l'intérieur d'un tablier sur la
  route qu'il franchit. Le pont de la route de Simiane au-dessus de la D6 est
  à 231 et 232 m à ses deux bouts, mais à 228 m au droit de l'autoroute, soit
  1,5 m au-dessus de sa chaussée. Un tablier ne descend plus sous la droite
  qui joint ses deux bouts ; 22 des 415 tronçons de pont du cache de prod
  creusaient de plus d'un mètre. Et, à l'approche d'un pont, la route ne
  plonge plus dans le creux que le relief lisse au pied de la culée (plus de
  3 m pour un bout de route sur six qui touchent un pont) : sur ses 30
  derniers mètres, elle garde son altitude BD TOPO quand elle passe le
  relief. La voiture et la route prévue suivent.
- **Le sol flou sous la voiture, quand l'IGN refuse une tuile d'altitude**
  (24 octobre 2026), signalé deux fois depuis une Tesla : deux tuiles du RGE
  ALTI refusées en 400, qui répondaient 200 une heure plus tard, laissaient
  le sol au zoom 12 (un aplat beige sous la voiture) sur une cinquantaine de
  kilomètres. La page rejoue désormais tout refus d'une tuile d'altitude,
  trois fois à 1,5 s d'écart, comme le serveur le fait déjà ; au premier
  échec, le sol se pose aussitôt sur le relief de la tuile mère, un peu plus
  lisse, au lieu d'attendre un second échec. Refus simulé à Aix sur un
  réseau bridé : le sol fin vient en 12 s au lieu de 22, autant que sans
  refus.
- **La traque et le cortège qui ne démarraient pas à Aix-en-Provence**
  (23 octobre 2026) : la BAN y écrit chaque voie avec deux espaces
  (« Rue  Paul Bert », « Cours  Mirabeau »), et le nom de la voie, coupé sur
  une seule, laissait un mot vide qui arrêtait le graphe des rues sur une
  erreur. Les deux boutons ne faisaient rien. Le nom est désormais coupé sur
  toute suite de blancs.
- **Le sol flou sous la voiture, d'Aix à Rousset** (23 octobre 2026), trouvé
  par les signalements d'une Tesla : une tuile d'altitude du RGE ALTI coupée
  par le réseau en plein corps entrait au cache du navigateur, puis en était
  relue et refusée à chaque essai, sans jamais repartir au réseau ni compter
  parmi les tuiles en attente. Sur toute son emprise (57 × 78 km, jusqu'à
  5,625° E), plus aucune tuile du zoom 13 ne se construisait : le sol
  retombait au zoom 12, une photo de 10 km agrandie en aplat sous la voiture,
  dès qu'une tuile plus fine manquait. Une tuile d'altitude n'est plus gardée
  qu'entière (256 × 256 flottants), une copie abîmée est effacée et relue ;
  après deux échecs de ses altitudes, une tuile du sol se pose sur le niveau
  de sa mère ; un 404 d'altitude (7/32/132, de Digne au Verdon, pris pour la
  mer) est redemandé deux fois avant de valoir absence. Le bandeau dit aussi
  « Sol flou », avec ce qui bloque la tuile plus fine.
- **La mer blanche de la vue en voiture** (22 octobre 2026) : au large,
  l'orthophoto de l'IGN n'est pas absente mais d'un blanc pur, entière dès le
  zoom 15 à 7 km au sud de Cassis. Vue de la route des Crêtes, la mer sortait
  blanche jusqu'à l'horizon ; elle prend désormais la teinte de la mer des
  tuiles côtières, là où l'image est blanche au niveau de la mer.
- **Les longues arêtes est-ouest de l'anneau de relief** (21 octobre 2026,
  Sainte-Victoire, Regagnas) : le WMS de l'IGN, qui fournissait l'anneau
  autour de la scène, y glisse toutes les 8 lignes environ une ligne prise
  130 m plus au nord. Sur un versant, chacune devenait un mur ou une bande
  sombre d'un bout à l'autre de l'anneau, jusqu'à 190 m de haut sous la
  Sainte-Victoire. L'anneau est désormais lu dans les tuiles natives du RGE
  ALTI, comme l'horizon : écart médian à une référence plus fine de 0,5 m
  au lieu de 2,5 à 2,8 m, 25 m au plus au lieu de 117 à 196 m, même poids.
  Presque toutes les scènes vallonnées du cache avaient 20 à 40 lignes
  fausses sur 128 : `outils/reparer_anneaux.py` relit leur anneau sans les
  reconstruire, rien d'autre dans la scène n'en dépendant.
- **Pincer pour zoomer, en drone et au cortège.** En vol, la page coupe les
  gestes de la vue, et deux doigts n'y faisaient plus rien. Ils règlent
  désormais le recul de la caméra, comme la molette, y compris pendant le
  choix de l'arrivée du cortège, pour viser une rue au téléphone. Un
  pincement n'est plus pris pour un toucher : il posait l'arrivée.
- **Une vue d'ensemble au départ du cortège.** L'arrivée posée, la caméra
  recule 6 s pour cadrer le cortège, l'arrivée, les groupes et les cordons,
  chacun avec son nom. Le cadre tient dans la part de l'écran que ne couvrent
  ni le bandeau, ni les croix, ni la barre des slogans. Un toucher passe la
  vue. Vus de loin, en cours de partie, le cortège et les cordons gardent
  leur nom. Les étiquettes prennent la largeur de leur texte, et un peu
  moins de place sur un téléphone en portrait.
- **Le sol de la vue en voiture qui restait gris** (Tesla, autour de
  Rousset) : une photo dont la relecture échouait — zone sans réseau, ou
  épisode de 404 de l'IGN où le serveur, qui relit deux tuiles à la fois,
  répond « occupé » — était tenue pour absente, et toutes les tuiles plus
  fines de la zone n'étaient plus jamais demandées ; les tuiles grossières
  qui les habillaient en attendant pouvaient de plus être évincées. Après
  15 s de coupure et 35 s de réseau, 274 tuiles montrées sur 274 restaient
  grises ; aucune désormais : seul un 404 confirmé vaut absence, une panne
  est redemandée de 4 à 20 s plus tard, une image ou une altitude qui ne
  répond pas est abandonnée au bout de 10 ou 15 s, et les ancêtres d'une
  tuile montrée restent. La route prévue évite aussi les culs-de-sac, et
  charge les bâtiments sur 1 km autour de la voiture quand elle finit en
  impasse : au centre de Rousset, elle s'arrêtait au bout de 250 à 800 m.
- **Les sapins et les chênes verts de la BD Forêt** : « Sapin, épicéa »
  contient « pin », et les sapins des Vosges sortaient en pins parasols, sur
  un long fût nu ; les chênes verts, « Chênes sempervirents » dans la BD
  Forêt v2, n'étaient jamais reconnus et passaient en feuillus. Trouvé en
  portant la règle à la vue en voiture, contre les valeurs réelles de la
  couche (350 massifs « Sapin, épicéa » dans les Vosges, 124 « Chênes
  sempervirents » autour de Gordes).
- **Les boutons de la vue tiennent sur un petit écran.** En vol, leur
  colonne descendait à 464 px du haut ; avec le pad du drone, il fallait
  650 px. Sur un téléphone en paysage (390 px), Cortège et « ? » sortaient
  de l'écran, et un bouton passait sous la flèche ▶. La colonne s'arrête
  désormais au-dessus des crédits, ou du pad, et se poursuit à sa gauche.
- **« Ma position » recentre la scène quand on en est sorti.** Rappuyer sur
  le bouton pendant le suivi l'arrêtait, et la scène restait où elle était :
  dans une Tesla en marche, on ne se retrouvait plus. Hors de la scène, le
  bouton la recentre désormais sur la position, et la vue annonce la
  sortie ; dans la scène, il arrête le suivi comme avant. Et une page déjà
  recentrée une fois ne se recentrait plus jamais, même au bouton rallumé :
  seule la reprise automatique qui suit un recentrage s'en abstient.
- **Le pincement à deux doigts zoome de nouveau, sur téléphone comme sur
  l'écran d'une Tesla.** Pour remplacer la molette d'OrbitControls (un
  facteur fixe par événement, qu'un pavé tactile compose jusqu'à faire
  plonger la caméra), la page coupait son zoom : dans three.js, cela coupe
  aussi le pincement, et deux doigts ne faisaient plus que déplacer la vue.
  Le zoom d'OrbitControls reste désormais actif pour le tactile ; la molette
  est interceptée avant lui, au même facteur qu'avant (×1,1618 pour 100 px,
  vérifié dans le navigateur, sans le ×0,95 d'OrbitControls en plus).
- **Des murs de 96 km autour de la scène, au port de Monaco.** Au bord de
  la mer, le WMS du RGE ALTI mêle son −99 999 aux altitudes voisines : 372
  pixels de −99 955 à −82 158 m, à côté de 827 vrais trous (0,3 %, relief
  accepté). Le serveur ne comptait comme trous que les −99 999 : le plus bas
  de ces mélanges devenait le zéro de la grille, et tout le reste saturait
  les entiers 16 bits, à −96 678 m. L'anneau et l'horizon, justes, montaient
  d'autant au-dessus de la scène, cousue à l'anneau par des murs.
  - Une altitude sous −20 m est un trou, élargi de 6 m (mesuré à Monaco,
    Menton, Nice : le mélange déborde de ~6 m quelle que soit la maille) ;
    l'anneau suivait déjà le même seuil. Un relief de plus de 3 276,7 m
    d'étendue n'est plus plafonné : son pas grandit.
  - La page bouche les trous de proche en proche depuis leur bord, plus par
    la moyenne de la grille, qui aurait posé le coin de mer de Monaco à 30 m
    (rivage entre 0,5 et 6,8 m). Son propre repli sur le WMS suit la même
    règle que le serveur, et elle écarte un relief déjà en cache sous −20 m.
  - `SCENE_VERSION` inchangée : seul un relief à trous change, et des 155
    scènes des deux caches, une seule en avait — Monaco, purgée en prod.

### Limites connues

- Un toit-terrasse que l'orthophoto voit vert (toit végétalisé, sans doute)
  reste « sous les arbres », en volume pâle : la planéité ne suffit pas à le
  distinguer d'un houppier, que la segmentation trouve plat aussi.
- Avec « Toits mesurés » éteint, le toit résumé reste en pente.
- Le pied des toits mesurés (pans, surfaces) est posé sur le point bas du
  RGE ALTI sous le contour, quand le serveur les mesure depuis celui du sol
  LiDAR : leur décalage au nuage est de −0,4 à −0,6 m en médiane, contre
  +0,1 à +0,4 m pour les toits plats.
- En ville dense, la couche du nuage, allégée à 250 000 points hors des
  ouvrages ajourés, garde un point pour 1,5 à 2 m de bâti en zone de
  1 000 m : à Strasbourg, les pans mesurés y paraissent à 47 % hors de leur
  forme, à 35 % dans le carré proche, plus dense.

## Scène v14 — 1er octobre 2026

### Ajouté

- **Les bateaux, à flot.** Avec un détecteur (`VUE3D_VEHICULES`), les
  bateaux que l'orthophoto montre sur l'eau sont posés en volume : bassins
  des ports, lacs, rivières, et la mer, que la BD TOPO ne dessine pas. Les
  mêmes réseaux, classe « ship », sur l'orthophoto déjà lue : une seconde
  de plus en zone de 1 000 m sur CoreML. 433 bateaux au port Hercule de
  Monaco, 283 en rade de Villefranche, 211 à Saint-Tropez, 195 sur le lac
  d'Annecy, six péniches sous Notre-Dame ; aucun à Gordes, Carcassonne ou
  Lyon. Bouton « Bateaux », infobulle, route `/api/navires`.
  - Seulement sur l'eau : les voitures des quais que `rtmdet` prend pour des
    navires sous 0,3, les voiliers à terre sur leur aire (Annecy), les
    véhicules d'un pont de la Seine restent dehors.
  - La mer est ce qui n'est dans aucune commune, là où le RGE ALTI est au
    niveau de la mer ou troué ; un bateau y doit être clair : les
    brise-lames immergés de la Croisette, que `yolo` annonce à 0,6-0,8, ne
    passent pas.
  - Coque effilée aux deux bouts et superstructures de convention, en quatre
    gabarits selon la longueur : la boîte ne dit pas où est l'étrave, et
    trois façons de la deviner, jugées sur 112 bateaux, n'en donnaient le
    bon sens que deux fois sur trois.
  - Limite : en mer, un ponton de plage passe parfois pour un yacht (un sur
    dix à Cannes).

- **Un quota de scènes neuves par visiteur, pour un service public.**
  `VUE3D_QUOTA=20` limite chaque adresse IP à vingt lieux construits par
  heure glissante ; au-delà, l'API répond 429 avec `Retry-After`, et la page
  affiche le message. Une scène neuve coûte une trentaine de requêtes à la
  Géoplateforme, qui limite l'adresse du serveur : un seul visiteur ne fait
  plus attendre tous les autres. Ce sont les scènes qui comptent, pas les
  requêtes : la page qui ouvre un lieu neuf en lance plusieurs sur le même
  point. Les scènes en cache, et leurs couches, restent ouvertes. Derrière
  un proxy, `VUE3D_PROXY=1` lit l'adresse dans `X-Forwarded-For`. Rien par
  défaut.

- **L'export CityGML 2.0, pour les SIG.** À côté de l'IFC, le bouton
  « CityGML 2.0 » écrit le même contexte pour FME, 3DCityDB, FZKViewer :
  bâtiments en LOD2 (une surface de toit, de mur ou de sol par face plane,
  les cours en trous), une partie (`bldg:BuildingPart`) par emprise quand un
  bâtiment en a plusieurs, arbres en objets de végétation avec hauteur et
  diamètre du houppier, masses en objets génériques, relief en TIN.
  Coordonnées absolues en Lambert-93, altitudes NGF, au millimètre.
  - Les triangles des maillages sont réunis en polygones plans : un mur
    extrudé devient un rectangle, un toit-terrasse son emprise trouée de ses
    cours ; un triangle plat rejoint son voisin.
  - Les toits en pans et les surfaces mesurées n'ont pas de plancher : leur
    sol est retrouvé au pied des murs (38 bâtiments sur 247 à Gordes).
  - Les 428 parties OSM de la cathédrale de Strasbourg sortent en 311
    parties ; fondues en un seul volume, elles se recoupaient, et leurs sols
    tombaient en 1 132 triangles.
  - Lourd : 47 Mo à Gordes, dont 28 pour les arbres, 172 Mo en zone de
    1 000 m avec les masses ; en géométrie explicite, que tous les logiciels
    lisent.
  - Valide contre les schémas de CityGML 2.0 (`citygml-tools validate`) et,
    géométrie comprise, par `outils/valider_citygml.py` : anneaux, planéité à
    1 cm, cours, orientation des toits et des sols, arbres fermés et tournés
    vers l'extérieur, à Gordes, Strasbourg et en zone de 1 000 m.

- **L'export BIM, en IFC 4.** Le bouton « Télécharger l'IFC 4 » du panneau
  écrit le contexte du lieu pour un logiciel de conception (Revit, ArchiCAD,
  Vectorworks, Allplan, Bonsai) : le relief de l'emprise, les bâtiments tels
  qu'affichés (toits en pente ou plats, mesurés ou résumés, parties OSM),
  les arbres et, sur demande, les masses de sursol. Le fichier est écrit
  dans le navigateur, sans requête au serveur, en une à quelques secondes :
  8,7 Mo à Gordes, 24 Mo en zone de 1 000 m, 35 Mo avec les masses.
  - Maillages triangulés (IfcTriangulatedFaceSet, vue de référence), un
    élément par bâtiment BD TOPO avec ses propriétés (identifiant, usage,
    étages, hauteur et sa source, forme du toit) ; arbres en forme simple,
    houppier et tronc fermés ; relief à 2 m, 4 m en zone de 1 000 m.
  - Le houppier exporté descend à la verticale à son bord, comme la forme
    détaillée : sans cela, la forme simple se retournait sur un profil
    mesuré qui remonte vers le bord, 1 848 houppiers et masses sur 418 839
    des scènes en cache (0,44 %). La vue garde sa forme simple, qu'elle ne
    montre qu'en mouvement.
  - Géoréférencé en Lambert-93, altitudes NGF-IGN69 (IGN78 en Corse) :
    origine entière au point (IfcMapConversion), nord vrai (−1,6° à Gordes,
    +5,4° à Brest). Les emprises BD TOPO y tombent à 0,4 mm près en médiane,
    3 cm au plus sur les toits en pans, quantifiés au dixième de maille.
  - Bâtiments et arbres ont leur hauteur mesurée : la vue les enfonce de
    0,5 m dans le terrain, sommet compris, sauf les toits mesurés ; l'export
    les relève, le pied toujours enfoncé.
  - Les GlobalId sont tirés de l'identifiant BD TOPO : un bâtiment garde le
    sien d'un export à l'autre.
  - Vérifié par `node outils/verifier-export.mjs` (Lambert-93 au millimètre
    de pyproj, maillages fermés et orientés, fichier cohérent) et
    `python outils/valider_ifc.py` (schéma, règles EXPRESS et géométrie, avec
    ifcopenshell) ; l'essai du navigateur télécharge le fichier.
  - Pas encore exportés : réservoirs, mâts et tours de refroidissement, murs,
    ponts et voies ferrées, eau, routes et lignes électriques, ni les
    ouvrages ajourés que la vue dessine en points (la tour Eiffel).

- **L'horizon : le paysage jusqu'à 60 km.** Au-delà de l'anneau,
  l'orthophoto de l'IGN en tuiles, du zoom 9 au zoom 17, d'autant plus
  grossières qu'elles sont loin de la caméra ou hors de son champ, drapée
  sur le RGE ALTI, sous un ciel et une brume qui suivent l'heure. De Gordes,
  on voit le Ventoux ; du Mont-Saint-Michel, la baie jusqu'à la mer. Le
  bouton « Horizon », allumé à l'ouverture, rend le fond sombre d'avant.
  - Le relief vient des tuiles natives de la pyramide RGE ALTI (WMTS), pas
    du WMS : à ces échelles, celui-ci répète une ligne sur quatre (le relief
    sortait en gradins) et refuse au-delà de 40 requêtes par seconde.
  - L'ouverture de Gordes lit 4,8 Mo d'orthophoto et 2,3 Mo d'altitudes,
    puis 0,9 Mo par tour d'orbite ; la première version en lisait 36 Mo.
  - En mer et à l'étranger, où le RGE ALTI n'a pas d'altitude, AWS Terrain
    Tiles comble les trous : Kehl ne tombe plus 140 m sous le Rhin. La photo
    de l'IGN, elle, s'arrête à la frontière.
  - Avec l'horizon, l'anneau prend sa photo au zoom 16 au lieu de 15 : plus
    de brouillard proche pour la cacher.

- **Un drone, au clavier.** Le bouton « Drone » pilote un quadricoptère vu
  de derrière : flèches pour avancer et tourner, Q et D pour glisser, espace
  et Maj pour monter et descendre, molette pour le recul de la caméra, Échap
  pour rendre la main à la souris. Il quitte la scène et survole l'horizon,
  se pose sur ce qu'il survole — terrain, anneau, horizon ou toit — sans
  jamais passer dessous, et la caméra monte sur les toits plutôt que de les
  traverser. Le curseur « vitesse » règle sa vitesse de pointe, 3 m/s par
  cran, jusqu'à 216 km/h.

- **Les Tabagn's des Gadz'Arts, en démo.** `node outils/demo-video.mjs
  gadzarts` filme en 73 s les huit campus Arts et Métiers dans l'ordre de
  leur fondation (Châlons 1806, Angers 1815, Aix 1843, Cluny 1891, Lille
  1900, Paris 1912, Bordeaux-Talence 1963, Metz 1997), le soleil allant de
  8 h 30 à 18 h 30 d'un campus à l'autre. Un mouvement de caméra par campus,
  le nuage LiDAR HD allumé en cours de plan, l'année en intertitre, et des
  photos de Wikimedia Commons à comparer (gravure de 1879 à Châlons, carte
  postale de 1907 à Aix, autochrome de 1916 du clocher de Cluny…), lues au
  tournage avec leur licence vérifiée. `MUSIQUE` pose un morceau sous un film
  sans voix, après un carton qui prévient du chant. L'outil gagne des
  intertitres, des tirages photo, le soleil réglé image par image, le
  bâtiment principal d'un campus et le sommet de son nuage.

- **Une démo des sites industriels, au carré.** `node outils/demo-video.mjs
  industrie` filme en 58 s, en zone de 1 000 m et en zooms, la raffinerie
  TotalEnergies de Gonfreville-l'Orcher, l'usine Arkema de Pierre-Bénite et
  la centrale EDF de Cordemais : les volumes de la BD TOPO, puis le nuage
  LiDAR HD, allumé de près. Il y voit 173, 302 et 144 structures que la BD
  TOPO ne modélise pas (îlots d'au moins 10 m² de points bâtis à plus de 2 m
  du sol, hors de ses bâtiments, réservoirs, constructions ponctuelles,
  ponts et murs) : unités de procédé, racks de tuyauteries, convoyeurs. Les
  trois orthophotos ont été vérifiées non floutées, aussi nettes que celles
  de Honfleur ou de Gordes.

- **Une démo des DPE et des ventes, au carré.** `node outils/demo-video.mjs
  foncier` tourne à Honfleur, en zone de 1 000 m autour du Vieux Bassin, un
  film muet de 51 s en 1080 × 1080 pour LinkedIn, tout en zooms, sans
  orbite : un clic sur « DPE », la répartition des étiquettes d'un immeuble
  de la vieille ville, un clic sur « Ventes DVF », puis les deux ensemble. Un cartouche y tient la légende des couleurs, et les médianes
  des ventes. Rien d'une vente ni d'une adresse n'y figure, seulement des
  couleurs et des chiffres réunis.

- **DPE et ventes immobilières, au clic.** Deux boutons du panneau,
  éteints à l'ouverture, et deux couches à part (`/api/dpe`, `/api/dvf`) :
  rien n'est demandé à l'ADEME ni à DVF tant qu'on ne clique pas.
  « DPE » lit les diagnostics de performance énergétique de l'ADEME
  (logements existants et neufs, depuis juillet 2021) et colore chaque
  bâtiment selon son étiquette énergie médiane, de A à G ; la fiche d'une
  maison liste ses DPE, celle d'un immeuble n'en donne que la répartition.
  Le bâtiment est désigné par l'identifiant RNB du DPE, sinon par son point
  d'adresse à 5 m près : sur 1 715 DPE de huit lieux dont le RNB fait foi,
  la règle de l'adresse trouve le bon bâtiment 93 % du temps quand le point
  tombe dedans, 75 % entre 2 et 5 m, et se trompe une fois sur trois
  au-delà. « Ventes DVF » lit les ventes de 2021 à 2025 (fichiers DVF
  géolocalisées d'Etalab, parcelles du cadastre IGN) : parcelles vendues
  teintées par leur prix au m² médian, bâtiment posé dessus de la même
  couleur et cerné de cyan, ventes au survol et au clic, prix médian des
  maisons et des appartements dans le panneau. Le contour est un trait de
  2,5 px sur une carte graphique, d'un pixel sur un rendu logiciel
  (SwiftShader, llvmpipe), où compiler son shader gelait la page une
  quarantaine de secondes. Pas de DVF en
  Alsace-Moselle : la page le dit. Les deux couches sont datées, gardées
  avec la scène, et relues par « Reconstruire la scène ». Sans clé : API de
  l'ADEME et fichiers d'Etalab, sous Licence Ouverte 2.0, cités dans les
  crédits dès que leur couche est affichée.

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

- **Sur téléphone et sur l'écran d'une voiture, la vue prend tout l'écran.**
  Sous 780 px de large ou 520 px de haut, le panneau passait au-dessus de la
  vue et lui prenait près de la moitié de l'écran (380 px sur 844 sur un
  iPhone) ; c'est désormais un tiroir, ouvert par ☰ et refermé par ×, Échap
  ou un toucher à côté. Un bâtiment touché ouvre sa fiche par « Voir la
  fiche », une parcelle vendue ses ventes. Au doigt, l'aide parle de pincer
  plutôt que de molette, et boutons et champs grandissent.
  - Un bouton plein écran, sur la vue sous la boussole ; en plein écran, le
    panneau passe aussi en tiroir. Absent sur l'iPhone, qui n'a pas l'API :
    la page ajoutée à l'écran d'accueil s'y ouvre sans barre.
  - Le drone quitte les boutons d'affichage pour la vue, sous le plein
    écran : il est de la navigation. Sur un écran tactile, deux croix de
    touches à l'écran le pilotent comme le clavier.
  - Corrigé : sur un téléphone en paysage, la vue gardait la largeur de son
    canvas et débordait de l'écran, boussole et crédits coupés. Les
    infobulles ne sortent plus de la vue.

- **La page s'ouvre en zone de 1 000 m.** Sans `zone=` dans l'URL, elle
  demande la plus grande zone plutôt que l'emprise de 356 m du serveur : la
  première construction y prend 4 s à Gordes et 6 s à Strasbourg sur un Mac
  M4. Les liens déjà partagés sans zone s'ouvrent donc en 1 000 m. Le
  sélecteur propose 350, 500, 700 et 1 000 m ; l'API, sans `zone=`, garde son
  emprise de 356 m et ses scènes en cache. Les fichiers exportés portent
  toujours leur zone dans leur nom (`-z1000`).

- **L'essai dans le navigateur fait voler le drone.**
  `outils/essai-navigateur.mjs` le fait décoller, avancer deux secondes, lit
  sa vitesse, puis vérifie qu'Échap rend la main à la souris.

- **Une tuile refusée se redemande une fois.** La Géoplateforme oppose de
  loin en loin un 404 à une tuile d'orthophoto qui existe (au zoom 16 à
  Gordes, servie cinq fois de suite ensuite) : le trou restait dans la photo
  de l'anneau. L'horizon fait de même avant de tenir une tuile pour absente.

- **L'essai dans le navigateur clique « DPE » et « Ventes DVF ».**
  `outils/essai-navigateur.mjs` les allume, attend leur section du panneau
  et relève la fiche du bâtiment visé, puis les éteint avant le décalage :
  il lit désormais aussi l'ADEME, le cadastre et les fichiers DVF.

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
