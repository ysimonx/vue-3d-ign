"""Véhicules et piscines visibles sur l'orthophoto, détectés par un réseau de
neurones.

Une couche à part de la scène, comme les ouvrages (vue3d/ouvrages.py), et la
seule qui soit **optionnelle** : elle demande un moteur d'inférence et un
réseau entraîné, que l'image Docker n'embarque que si on les réclame
(`VUE3D_VEHICULES`, README). Sans elle, le service est celui d'avant.

**Pourquoi l'image, et pas le LiDAR.** Le MNH LiDAR HD ne voit pas les
véhicules : sur le parking de Gordes (une soixantaine de voitures à
l'orthophoto), il lit 0,0 m partout — les points non classés sortent du
modèle de surface. Et la campagne LiDAR n'a pas la date de la prise de vue.

**Pourquoi un réseau.** L'analyse d'image classique (écart au fond médian,
composantes connexes, rectangle orienté) retrouve 8 de ces 61 voitures : les
véhicules serrés fusionnent. Deux réseaux à boîtes orientées, entraînés sur
DOTA, ont été mesurés sur l'orthophoto à 0,2 m de Gordes et de Carcassonne
(outils/mesure_vehicules.py) ; aucun ne suffit seul partout, d'où le choix
laissé à qui déploie :

- `rtmdet` : RTMDet-R s (MMRotate, Apache-2.0). Rapide (3 s), peu de faux,
  mais il répond mal sur les voitures serrées : 22 des 61 du parking de
  Gordes, 91 véhicules sur la scène ; 178 à Carcassonne ;
- `yolo` : YOLO11s-OBB (Ultralytics, **AGPL-3.0**). Le meilleur sur ce
  parking (48 sur 61, 146 sur la scène), moins bon à Carcassonne (140), et
  cinq fois plus lent (14 s) : il lui faut des tuiles agrandies 6,4 fois ;
- `tous` : l'union des deux, 169 et 188 véhicules.

Temps sur un Mac à dix cœurs ; le double ou plus dans le conteneur Docker de
la même machine (6 s et 35 s), trois à six fois moins hors conteneur avec
CoreML (`VUE3D_MOTEUR`, MOTEURS).

Les deux réseaux sont entraînés sur DOTA, dont les images sont réservées à un
usage académique ; leurs poids ne sont pas dans le dépôt, ils sont exportés à
la construction de l'image (outils/exporter_vehicules.py).

**Ce que la couche affirme.** Les véhicules du jour de la prise de vue, là où
ils étaient ce jour-là. Un parking à moitié vide à l'écran peut être un
parking plein que le réseau n'a lu qu'à moitié : ce qui manque reste à plat
sur l'orthophoto.

**Les piscines avec.** Les mêmes réseaux connaissent la classe « swimming
pool », et la BD TOPO n'a pas les piscines des particuliers. Une passe de
plus, à l'échelle native de l'orthophoto et d'une demi-seconde, les ajoute à
la couche (PISCINES) : 13 à Gordes et 9 à Carcassonne pour `rtmdet`, 8 et 8
pour `yolo`, 14 et 9 pour les deux. Ici c'est rtmdet qui voit le mieux.

**Une couche par fichier, le rapide d'abord.** Les piscines ont leur fichier
et chaque détecteur de véhicules le sien : la page demande les piscines
(prêtes une demi-seconde après la scène), puis les véhicules détecteur par
détecteur, du rapide au lent, et dessine chaque couche dès qu'elle arrive.
En mode `tous`, c'est elle qui réunit les détecteurs, avec la règle de
DOUBLON_ENTRE_DETECTEURS_M.

**Une couche est complète ou n'existe pas**, comme la scène : l'orthophoto
illisible lève, rien n'est écrit. Le nom de chaque fichier de cache porte le
détecteur (ou le mode) et la version (scene.nom_vehicules, nom_piscines) :
changer de détecteur ne ressert jamais la couche d'un autre.

**Détecté une fois par morceau de terrain.** Ce que les réseaux voient est
gardé à part, en coordonnées, par rectangle de terrain (vue3d/releves.py) :
la couche d'un point se réunit des relevés qui couvrent son emprise, et un
point décalé d'une flèche ne détecte que la bande nouvelle (`en_geographie`
fait passer les boîtes des pixels d'une image aux coordonnées).
"""

import collections
import concurrent.futures
import itertools
import logging
import math
import os

import numpy as np
from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union

from .batiments import DECOUPE_RETRAIT_M
from .ortho import fetch_ortho_rgb

journal = logging.getLogger(__name__)

# Formats des couches. Les incrémenter ne refait que la couche, pas les scènes.
# Véhicules — 2 : piscines ; 3 : un fichier par détecteur, les piscines à part.
VEHICULES_VERSION = 3
PISCINES_VERSION = 1

# Détecteurs de chaque mode, dans l'ordre où la page les demande et où leurs
# boîtes sont gardées : le rapide d'abord, pour que la vue montre ses
# véhicules sans attendre le lent ; une boîte du second qui double une boîte
# du premier est retirée. Ce que ce choix coûte : là où les deux voient la
# même voiture, c'est la boîte de rtmdet qui est dessinée.
MODES = {"aucun": (), "rtmdet": ("rtmdet",), "yolo": ("yolo",), "tous": ("rtmdet", "yolo")}
MODE_PAR_DEFAUT = "aucun"

# Résolution de l'orthophoto demandée : celle de la BD ORTHO. La mosaïque de
# la scène (0,4 m) ne suffit pas, une voiture n'y fait que 5 pixels de large.
RESOLUTION_M = 0.2
# Côté de la tuile présentée aux réseaux : celui de leur entraînement
# (outils/exporter_vehicules.py, COTE).
COTE = 1024


def _boites_rtmdet(sortie):
    """(1, N, 20) : cx, cy, l, h, angle, 15 scores."""
    return sortie[0, :, :5], sortie[0, :, 5:]


def _boites_yolo(sortie):
    """(1, 20, N) : cx, cy, l, h, 15 scores, angle."""
    s = sortie[0].T
    return np.concatenate([s[:, :4], s[:, 19:20]], axis=1), s[:, 4:19]


# Réglages de chaque détecteur, mesurés sur Gordes (G) et Carcassonne (C)
# avec outils/mesure_vehicules.py, le 2026-09-30. Sans vérité terrain annotée :
# des comptes de véhicules gardés, jugés à l'œil sur l'image annotée.
#
# `tuile_px` : côté de la tuile découpée dans l'orthophoto, agrandie à COTE.
# C'est l'échelle qui décide de tout, et elle n'est pas la même pour les deux
# réseaux :
#
#   tuile (px)     1024   768   640   512   400   320   256   200   160   128
#   rtmdet   G       19    43    78    91    37    28
#            C       25    81   163   178    93    49
#   yolo     G                                     50    72   122   146    93
#            C                                     18    70   131   140    68
#
# Trop agrandie, une voiture devient un « ship » pour les deux.
#
# `recouvrement_px` : recouvrement de deux tuiles voisines. Il en faut assez
# pour que tout véhicule tienne entier dans une tuile (une voiture : 6 m,
# 30 px). Au-delà, chaque véhicule est vu plusieurs fois, à des cadrages
# différents, et rtmdet, peu sûr de lui sur cette imagerie, y gagne :
#
#   recouvrement (px)     65      128      256      384
#   rtmdet   G            73       91       89      109
#            C           162      178      176      187
#   temps                 2 s      3 s      4 s      11 s
#
# yolo n'y gagne presque rien (32 px : 146 et 140 en 14 s ; 80 px : 152 et
# 149 en 36 s).
#
# `seuil` : score minimal, la classe la plus probable étant un véhicule.
#
#   rtmdet   seuil    0,1   0,15   0,2   0,3        yolo   0,15   0,25   0,35   0,5
#            G        130     91    65    41                167    146    121     88
#            C        201    178   158   116                166    140    116     85
#
# rtmdet annonce juste même à bas score : sur 44 boîtes de Gordes entre 0,1
# et 0,2, regardées une à une, cinq ou six faux (un muret, un trait au sol, un
# coin de cour).
#
# `longueur_max_m` : au-delà, la boîte n'est pas gardée. Les deux seules
# boîtes de plus de 7 m de rtmdet sur les deux lieux sont fausses (un muret,
# trois voitures en file fondues en une) ; la seule de yolo est un autocar.
# C'est peu, mais un autocar de 12 m posé sur un muret se voit de loin.
#
# `petit`, `gros` : indices des classes « small vehicle » et « large vehicle »
# dans l'ordre de chaque réseau. La classe n'est pas transmise : rtmdet range
# parmi les gros 37 véhicules de Carcassonne dont la longueur médiane est
# celle d'une voiture. C'est le gabarit mesuré qui fait la forme dessinée.
DETECTEURS = {
    "rtmdet": {"fichier": "vehicules-rtmdet.onnx", "tuile_px": 512, "recouvrement_px": 128,
               "seuil": 0.15, "longueur_max_m": 7.0, "petit": 4, "gros": 5,
               "boites": _boites_rtmdet},
    "yolo": {"fichier": "vehicules-yolo.onnx", "tuile_px": 160, "recouvrement_px": 32,
             "seuil": 0.25, "longueur_max_m": 14.0, "petit": 10, "gros": 9,
             "boites": _boites_yolo},
}

# Piscines : les mêmes réseaux, classe « swimming pool », dans une passe à
# eux. Mesuré sur Gordes (G) et Carcassonne (C), le 2026-09-30, chaque boîte
# regardée une à une.
#
# `tuile_px` : l'échelle native de l'orthophoto (1 024 px pour COTE). Une
# piscine, dix fois plus grande qu'une voiture, n'a pas besoin d'être
# agrandie, et le compte ne dépend guère de la tuile :
#
#   tuile (px)              1024   768   640   512   320
#   rtmdet, seuil 0,1   G     15    16    14    17    14
#                       C     10    10    10    16    11
#   yolo, seuil 0,2     G      9     9     9     8     8
#                       C      8     6     5     5     4
#   temps                   0,5 s  0,8 s 1,5 s 2,5 s  6 s
#
# `recouvrement_px` : 128 px, 25 m, plus que la plus longue piscine vue (17 m).
#
# `seuil` : bas pour rtmdet, qui annonce juste même à 0,1. Ses 25 boîtes des
# deux lieux sont de l'eau : 23 piscines franches, dont des bassins verts ou
# sombres, et deux petits bassins de 4 à 5 m dont on ne peut jurer. Dès 0,3 il
# en perd sept. Les 17 de yolo sont toutes des piscines ; en dessous de 0,2
# son compte ne bouge plus.
#
# Contre-épreuve par la couleur : des 21 taches bleues de plus de 8 m² des
# deux orthophotos, toutes des piscines, rtmdet en couvre 20 et yolo 17 ;
# celle qui échappe à rtmdet est vue de yolo.
#
# Trois de ces boîtes tombent ensuite sur un bâtiment de la scène et sont
# écartées, dont un bassin de 17 m de Gordes que la BD TOPO porte comme un
# bâtiment de 4,8 m : la scène y dessine déjà un volume.
PISCINES = {
    "rtmdet": {"tuile_px": 1024, "recouvrement_px": 128, "seuil": 0.1, "classe": 13},
    "yolo": {"tuile_px": 1024, "recouvrement_px": 128, "seuil": 0.2, "classe": 14},
}
# Gabarit d'une piscine, en mètres. Boîtes vues : de 4,2 à 16,8 m de long, de
# 3,1 à 9,4 m de large ; les bornes vont du bassin hors sol au bassin
# olympique.
PISCINE_LONGUEUR_M = (3.0, 55.0)
PISCINE_LARGEUR_M = (2.0, 30.0)

# Une boîte à moins de BORD_PX pixels du bord d'une tuile est tenue pour
# coupée par lui.
BORD_PX = 2
# Deux boîtes du même détecteur sont le même véhicule au-delà de ce
# recouvrement (intersection sur union), ou si leurs centres sont à moins de
# DOUBLON_CENTRES_M. Le seuil ne pèse pas : à 0,1, 0,3 ou 0,5, le compte ne
# bouge que d'une boîte sur les deux lieux — les annonces d'un même véhicule
# se recouvrent presque entièrement, deux voitures voisines presque pas.
DOUBLON_IOU = 0.3
DOUBLON_CENTRES_M = 1.0
# D'un détecteur à l'autre, les boîtes d'un même véhicule ne se superposent
# pas aussi bien : centres à moins de 1,5 m. À ce rayon, 68 véhicules de
# Gordes et 130 de Carcassonne sont vus des deux.
DOUBLON_ENTRE_DETECTEURS_M = 1.5

# Gabarit d'un véhicule, en mètres ; hors de là, la boîte n'est pas gardée.
# Boîtes gardées sur les deux lieux, des deux détecteurs : longueur de 3,3 à
# 6,6 m hors autocar (médiane 4,3 à 4,6 m), largeur de 1,4 à 3,1 m (médiane
# 2,0 à 2,2 m, plus qu'une carrosserie : la boîte déborde) ; les plus
# étroites sont des voitures à demi sous un arbre, les plus larges des
# fourgons avec leur ombre. Les bornes laissent de la marge autour de ces
# mesures. La longueur maximale est
# celle de chaque détecteur (`longueur_max_m`).
LONGUEUR_MIN_M = 2.5
LARGEUR_M = (1.2, 3.2)
# Arrondi des coordonnées : 7 décimales, un centimètre.
DECIMALES = 7


class VehiculesMalConfigures(RuntimeError):
    """Le mode demandé n'a pas son moteur ou son réseau : erreur de
    déploiement, dite au démarrage plutôt qu'à la première scène."""


def mode_demande(valeur=None):
    """Le mode de `VUE3D_VEHICULES`, contrôlé."""
    mode = (os.environ.get("VUE3D_VEHICULES", "") if valeur is None else valeur).strip().lower()
    mode = mode or MODE_PAR_DEFAUT
    if mode not in MODES:
        raise VehiculesMalConfigures(
            f"VUE3D_VEHICULES={mode!r} : attendu l'un de {', '.join(MODES)}.")
    return mode


# Moteurs d'onnxruntime, au choix de `VUE3D_MOTEUR`. Hors conteneur sur un
# Mac, CoreML fait tourner les réseaux sur le GPU ; le conteneur Docker de la
# même machine n'y a pas accès, et garde le processeur. Mesuré le 2026-10-01
# sur un M4 à dix cœurs, hors conteneur, par `detecter` et
# `detecter_piscines` sur Gordes :
#
#                               processeur    CoreML
#   rtmdet (20 tuiles)             2,8 s       0,8 s
#   yolo (140 tuiles)             16,4 s       5,1 s
#   piscines                       1,0 s       0,3 s
#   yolo, zone de 1 000 m            —         52 s   (1 092 tuiles)
#
# Dans le conteneur, yolo met environ 5 min sur une zone de 1 000 m. Les
# couches écrites par le serveur sont les mêmes à l'octet, d'un moteur à
# l'autre : piscines, rtmdet et yolo de Gordes.
#
# Format MLProgram, toutes les unités de calcul, 31 ms par tuile de yolo :
# le format par défaut de CoreML (NeuralNetwork) en met 64 et s'écarte de
# 0,003 sur les scores ; le Neural Engine seul, 170, plus que le processeur.
MOTEURS = {
    "processeur": ["CPUExecutionProvider"],
    "coreml": [("CoreMLExecutionProvider", {"ModelFormat": "MLProgram", "MLComputeUnits": "ALL"}),
               "CPUExecutionProvider"],
}

# Tuiles présentées en même temps à un réseau (_annonces) : chacune est
# préparée (découpe, agrandissement bicubique, ~10 ms) et passée au réseau
# dans son fil, les boîtes sont lues dans l'ordre des tuiles. Mesuré le
# 2026-10-01 sur le M4, machine chargée par d'autres calculs (charge 50 à
# 130), valeurs alternées tour après tour, médianes de cinq tours, en ms par
# tuile de yolo :
#
#   fils                        1      2      3      4      6
#   CoreML                     45     33     33
#   processeur, conteneur     477    341    271    232    201
#
# CoreML ne sert qu'une tuile à la fois sur le GPU (deux appels simultanés :
# 28 ms par tuile contre 29,5) : le second fil ne fait que préparer la
# tuile suivante pendant ce temps. Au processeur, chaque appel garde tous
# ses cœurs (intra_op_num_threads n'est pas touché, voir charger) ; les
# appels simultanés comblent les creux de chacun, d'autant mieux que la
# machine est chargée. Chaque appel de yolo en cours tient environ 300 Mo
# hors conteneur, 100 à 130 Mo dans le conteneur (pics ci-dessous) :
# 4 plutôt que 6 : l'essentiel du gain, pour 1,2 Go au plus dans le
# conteneur (7,7 Go en tout sur ce Mac). Détections entières, sans réseau,
# médianes de trois : yolo de 59,8 s à 44,3 s sur CoreML en zone de 1 000 m
# à Gordes ; de 148 s à 68 s dans le conteneur sur l'emprise par défaut.
# Couches identiques à l'octet.
#
# Ce que les appels simultanés coûtent en mémoire : yolo seul sur l'emprise
# par défaut de Gordes, mesuré le 2026-10-02 à la contre-vérification, un
# appel à la fois avec l'arène (avant) contre quatre sans elle (FILS_INFERENCE,
# charger). Dans le conteneur, le pic passe de 734-740 Mo à 1 046-1 137 Mo,
# ce qui reste après coup de 695-700 Mo à 441-535 Mo ; au processeur hors
# conteneur, le pic passe de 966-978 Mo à 1 879-1 949 Mo. Le service entier
# dans le conteneur (cgroup memory.peak, de 6 à 12 essais), scène et trois
# détections de l'emprise par défaut : 811 à 827 Mo à bc716ba, 1 351 à
# 1 508 Mo depuis, dont 373 à 382 Mo sans détecteur (scène et bassin des
# toitures) ; en zone de 1 000 m, scène, piscines et rtmdet, yolo en cours :
# 1 114 à 1 447 Mo, puis 1 906 à 2 144 Mo.
#
# Au processeur, jamais plus de la moitié des cœurs (fils_inference) : 4 n'a
# été mesuré qu'à dix cœurs, chaque appel y prend déjà tous les cœurs, et
# chacun ajoute au pic environ 300 Mo hors conteneur, 100 à 130 Mo dedans.
# Les cœurs sont ceux que le processus peut prendre (sched_getaffinity sous
# Linux : un --cpuset-cpus de Docker y compte, pas dans os.cpu_count).
FILS_INFERENCE = {"processeur": 4, "coreml": 2}


def moteur_demande(disponibles, valeur=None):
    """Le moteur de `VUE3D_MOTEUR`, contrôlé : `auto` (défaut) prend CoreML
    s'il est parmi les moteurs `disponibles` d'onnxruntime, le processeur
    sinon ; `processeur` et `coreml` l'imposent.

    Raises:
        VehiculesMalConfigures pour une valeur inconnue, ou pour `coreml`
        demandé là où onnxruntime ne l'a pas.
    """
    moteur = (os.environ.get("VUE3D_MOTEUR", "") if valeur is None else valeur).strip().lower()
    coreml = MOTEURS["coreml"][0][0] in disponibles
    if moteur in ("", "auto"):
        return "coreml" if coreml else "processeur"
    if moteur not in MOTEURS:
        raise VehiculesMalConfigures(
            f"VUE3D_MOTEUR={moteur!r} : attendu l'un de auto, {', '.join(MOTEURS)}.")
    if moteur == "coreml" and not coreml:
        raise VehiculesMalConfigures(
            "VUE3D_MOTEUR=coreml : onnxruntime n'a pas ce moteur ici "
            "(macOS hors conteneur seulement).")
    return moteur


def charger(mode, dossier, moteur=None):
    """Sessions d'inférence des détecteurs du mode, par nom.

    Raises:
        VehiculesMalConfigures si onnxruntime ou un réseau manque, ou si
        CoreML, retenu par `moteur_demande`, ne prend pas un réseau.
    """
    if not MODES[mode]:
        return {}
    try:
        import onnxruntime
    except ImportError as exc:
        raise VehiculesMalConfigures(
            f"VUE3D_VEHICULES={mode} demande onnxruntime, absent de cette installation "
            "(requirements-vehicules.txt, ou l'argument de construction de l'image).") from exc
    moteur = moteur_demande(onnxruntime.get_available_providers(), moteur)
    sessions = {}
    for nom in MODES[mode]:
        chemin = os.path.join(dossier, DETECTEURS[nom]["fichier"])
        if not os.path.exists(chemin):
            raise VehiculesMalConfigures(
                f"VUE3D_VEHICULES={mode} demande {chemin}, introuvable : "
                f"outils/preparer_modeles.sh {nom} {dossier} l'exporte (sans Docker), "
                "ou VUE3D_VEHICULES=aucun démarre sans détecteur")
        options = onnxruntime.SessionOptions()
        # Au processeur, sans l'arène d'onnxruntime, qui garde tout ce
        # qu'elle a pris : après les quatre appels simultanés de
        # FILS_INFERENCE, une session de yolo tenait encore 1 130 Mo dans le
        # conteneur (464 Mo à un appel, avant eux) ; sans elle, 350 Mo, pour
        # le même temps (232 et 242 ms par tuile, médianes alternées) et les
        # mêmes sorties. CoreML ne la remplit guère : inchangé.
        #
        # intra_op_num_threads reste celui d'onnxruntime, exprès : dans le
        # conteneur (Linux, dix cœurs), les sorties de yolo changent avec lui
        # (écart de 1e-3 sur les boîtes à 1 à 9 fils, ou 11, contre 10 par
        # défaut), et les couches avec. Sur macOS, elles n'en dépendent pas.
        options.enable_cpu_mem_arena = moteur != "processeur"
        sessions[nom] = onnxruntime.InferenceSession(chemin, options, providers=MOTEURS[moteur])
        # Un moteur qui ne s'initialise pas, onnxruntime le remplace par le
        # processeur sans lever. Cinq fois plus lent, ce repli passerait pour
        # une panne : il arrête le démarrage, et l'erreur dit comment le
        # demander.
        if moteur == "coreml" and MOTEURS["coreml"][0][0] not in sessions[nom].get_providers():
            raise VehiculesMalConfigures(
                f"CoreML n'a pas pris {chemin} : VUE3D_MOTEUR=processeur s'en passe.")
    journal.info("Moteur d'inférence : %s", moteur)
    return sessions


def _origines(etendue, tuile, recouvrement):
    """Origines des tuiles le long d'un axe : la dernière est ramenée dans
    l'image plutôt que complétée de noir, l'échelle reste la même partout."""
    if etendue <= tuile:
        return [0]
    pas = tuile - recouvrement
    return list(range(0, etendue - tuile, pas)) + [etendue - tuile]


def _coins(cx, cy, lo, la, angle):
    ux, uy = math.cos(angle) * lo / 2, math.sin(angle) * lo / 2
    vx, vy = -math.sin(angle) * la / 2, math.cos(angle) * la / 2
    return [(cx + ux + vx, cy + uy + vy), (cx + ux - vx, cy + uy - vy),
            (cx - ux - vx, cy - uy - vy), (cx - ux + vx, cy - uy + vy)]


def sans_doublons(boites, iou_max, centres_px):
    """Suppression des doublons, la boîte la plus sûre d'abord.

    Args:
        boites: [(cx, cy, longueur, largeur, angle, score, ...)], en pixels.

    Un réseau dense annonce chaque véhicule plusieurs fois ; deux annonces du
    même se recouvrent largement, deux voitures garées côte à côte presque pas.
    """
    gardees, polygones = [], []
    for b in sorted(boites, key=lambda b: -b[5]):
        poly = Polygon(_coins(*b[:5]))
        doublon = False
        for g, q in zip(gardees, polygones):
            d2 = (b[0] - g[0]) ** 2 + (b[1] - g[1]) ** 2
            if d2 < centres_px ** 2:
                doublon = True
            elif d2 < ((b[2] + g[2]) / 2) ** 2:             # assez proches pour se toucher
                inter = poly.intersection(q).area
                doublon = inter > iou_max * (poly.area + q.area - inter)
            if doublon:
                break
        if not doublon:
            gardees.append(b)
            polygones.append(poly)
    return gardees


def _couleur(rgb, cx, cy, lo, la, angle):
    """Couleur médiane du cœur de la boîte : la carrosserie, sans le sol du
    pourtour ni, pour l'essentiel, les vitres."""
    h, w = rgb.shape[:2]
    c, s = math.cos(angle), math.sin(angle)
    pts = [(cx + u * lo * c - v * la * s, cy + u * lo * s + v * la * c)
           for u in (-0.3, -0.15, 0.0, 0.15, 0.3) for v in (-0.25, 0.0, 0.25)]
    pixels = [rgb[min(max(int(y), 0), h - 1), min(max(int(x), 0), w - 1)] for x, y in pts]
    r, g, b = (int(v) for v in np.median(np.array(pixels), axis=0))
    return (r << 16) | (g << 8) | b


def _dans_l_ordre(fonction, elements, fils):
    """`fonction(e)` pour chaque élément, calculés `fils` à la fois et rendus
    dans l'ordre des éléments : ce qui en est tiré ne dépend pas de `fils`.

    Au plus 2 × `fils` résultats d'avance : les tuiles d'une zone de 1 000 m
    se comptent par milliers, leurs sorties ne s'accumulent pas.
    """
    if fils <= 1:
        for e in elements:
            yield fonction(e)
        return
    suivants = iter(elements)
    with concurrent.futures.ThreadPoolExecutor(fils, thread_name_prefix="inference") as bassin:
        en_cours = collections.deque(bassin.submit(fonction, e)
                                     for e in itertools.islice(suivants, 2 * fils))
        try:
            while en_cours:
                resultat = en_cours.popleft().result()
                en_cours.extend(bassin.submit(fonction, e) for e in itertools.islice(suivants, 1))
                yield resultat
        finally:
            # Une erreur, ici ou chez l'appelant : rien de plus n'est lancé.
            for tache in en_cours:
                tache.cancel()


def _annonces(image, session, lire_boites, tuile, recouvrement, seuil, classes, fils=1):
    """Boîtes qu'un réseau annonce sur l'image, tuile après tuile.

    Args:
        image: PIL, à RESOLUTION_M par pixel.
        tuile, recouvrement: en pixels de l'image ; la tuile est agrandie
            (ou réduite) à COTE avant d'être présentée au réseau.
        classes: indices des classes gardées. La classe la plus probable doit
            en être : une boîte que le réseau prend d'abord pour un bateau
            n'est pas un véhicule.
        fils: tuiles préparées et présentées au réseau en même temps
            (FILS_INFERENCE) ; leurs boîtes sont lues dans l'ordre des
            tuiles, les annonces sont les mêmes quel que soit `fils`.

    Returns:
        [(cx, cy, longueur, largeur, angle, score, classe)] en pixels de
        l'image, grand axe d'abord, doublons compris.
    """
    from PIL import Image
    largeur, hauteur = image.size
    echelle = tuile / COTE
    entree = session.get_inputs()[0].name
    origines = [(x0, y0) for y0 in _origines(hauteur, tuile, recouvrement)
                for x0 in _origines(largeur, tuile, recouvrement)]

    def inferer(origine):
        x0, y0 = origine
        # Une tuile plus grande que l'image est complétée de noir, en bas
        # à droite.
        morceau = Image.new("RGB", (tuile, tuile))
        morceau.paste(image.crop((x0, y0, min(x0 + tuile, largeur), min(y0 + tuile, hauteur))))
        x = np.asarray(morceau.resize((COTE, COTE), Image.BICUBIC), dtype=np.float32)
        x = np.ascontiguousarray(x.transpose(2, 0, 1)[None] / 255.0)
        return (origine, *lire_boites(session.run(None, {entree: x})[0]))

    annonces = []
    for (x0, y0), b, scores in _dans_l_ordre(inferer, origines, fils):
        classe = scores.argmax(axis=1)
        score = scores[np.arange(len(classe)), classe]
        # Bords de la tuile à l'intérieur de l'image : une boîte qui les
        # touche est celle d'un objet coupé, que la tuile voisine voit
        # entier.
        gauche, haut = (x0 > 0) * BORD_PX, (y0 > 0) * BORD_PX
        droite = tuile - (x0 + tuile < largeur) * BORD_PX
        bas = tuile - (y0 + tuile < hauteur) * BORD_PX
        for i in np.nonzero((score >= seuil) & np.isin(classe, classes))[0]:
            cx, cy, lo, la = (float(v) * echelle for v in b[i, :4])
            angle = float(b[i, 4])
            if any(not (gauche <= px <= droite and haut <= py <= bas)
                   for px, py in _coins(cx, cy, lo, la, angle)):
                continue
            if la > lo:                       # grand axe d'abord
                lo, la, angle = la, lo, angle + math.pi / 2
            annonces.append((cx + x0, cy + y0, lo, la, angle, float(score[i]), int(classe[i])))
    return annonces


def detecter(rgb, sessions, detecteurs=DETECTEURS, fils=1):
    """Véhicules d'une orthophoto.

    Args:
        rgb: image (hauteur, largeur, 3) uint8, à RESOLUTION_M par pixel.
        sessions: de `charger`, dans l'ordre de priorité des détecteurs.
        fils: tuiles présentées en même temps à chaque réseau (_annonces).

    Returns:
        [[cx, cy, longueur, largeur, angle, score, gros, couleur, detecteur]] en
        pixels de l'image ; `angle` est celui du grand axe, en radians, dans
        le repère de l'image (x vers l'est, y vers le sud).
    """
    from PIL import Image
    image = Image.fromarray(rgb)
    toutes = []
    for nom, session in sessions.items():
        d = detecteurs[nom]
        boites = [(*a[:6], int(a[6] == d["gros"]))
                  for a in _annonces(image, session, d["boites"], d["tuile_px"],
                                     d["recouvrement_px"], d["seuil"], (d["petit"], d["gros"]),
                                     fils)
                  if a[2] * RESOLUTION_M <= d["longueur_max_m"]]
        boites = sans_doublons(boites, DOUBLON_IOU, DOUBLON_CENTRES_M / RESOLUTION_M)
        rayon2 = (DOUBLON_ENTRE_DETECTEURS_M / RESOLUTION_M) ** 2
        for b in boites:
            if all((b[0] - t[0]) ** 2 + (b[1] - t[1]) ** 2 >= rayon2 for t in toutes):
                toutes.append([*b, _couleur(rgb, *b[:5]), nom])
    return toutes


def detecter_piscines(rgb, sessions, reglages=None, fils=1):
    """Piscines d'une orthophoto.

    Returns:
        [[cx, cy, longueur, largeur, angle, score, couleur, detecteur]] en
        pixels de l'image, comme `detecter`. La couleur est celle de l'eau ce
        jour-là : turquoise, verte, sombre sous une bâche.
    """
    from PIL import Image
    reglages = reglages or PISCINES
    image = Image.fromarray(rgb)
    toutes = []
    for nom, session in sessions.items():
        r = reglages[nom]
        boites = sans_doublons(
            _annonces(image, session, DETECTEURS[nom]["boites"], r["tuile_px"],
                      r["recouvrement_px"], r["seuil"], (r["classe"],), fils),
            DOUBLON_IOU, DOUBLON_CENTRES_M / RESOLUTION_M)
        for b in boites:
            # D'un détecteur à l'autre : le centre de l'une dans la boîte de l'autre.
            if all(not Polygon(_coins(*t[:5])).contains(Point(b[0], b[1])) for t in toutes):
                toutes.append([*b[:6], _couleur(rgb, *b[:5]), nom])
    return toutes


def _coeurs_disponibles():
    """Les cœurs que le processus peut prendre ; None s'ils sont inconnus."""
    if hasattr(os, "sched_getaffinity"):
        return len(os.sched_getaffinity(0)) or None
    return os.cpu_count()


def fils_inference(sessions, coeurs=None):
    """Tuiles présentées en même temps aux réseaux : FILS_INFERENCE de leur
    moteur, 1 pour une session qui ne dit pas le sien (doublure des tests).
    Au processeur, jamais plus de la moitié des `coeurs` (ceux de la machine
    par défaut), et au moins un."""
    coeurs = coeurs or _coeurs_disponibles() or 2
    fils = 1
    for session in sessions.values():
        fournisseurs = getattr(session, "get_providers", lambda: [])()
        if fournisseurs:
            moteur = "coreml" if MOTEURS["coreml"][0][0] in fournisseurs else "processeur"
            n = FILS_INFERENCE[moteur]
            if moteur == "processeur":
                n = min(n, max(1, coeurs // 2))
            fils = max(fils, n)
    return fils


class Lecteur:
    """Les lectures de la couche pour `scene.Cache` : une par fichier.

    Les piscines sont un fichier, et chaque détecteur de véhicules le sien :
    ce qui est vite lu est vite affiché, et le lent n'y change rien — sur
    une même machine, rtmdet met 3 s là où yolo en met 14, et les piscines
    une demi-seconde.

    L'orthophoto est lue une fois pour toutes : `orthophoto` la rend, et
    chaque lecture la prend en `rgb` (scene.Cache.prelire_vehicules). Sans
    elle, une lecture lit la sienne.
    """

    def __init__(self, mode, sessions, fils=None):
        self.mode = mode
        self.sessions = sessions
        self.detecteurs = tuple(sessions)
        self.fils = fils_inference(sessions) if fils is None else fils

    @staticmethod
    def _orthophoto(west, south, east, north):
        """Orthophoto à 0,2 m de l'emprise, en tableau RGB.

        Raises:
            requests.RequestException si elle n'a pas pu être lue.
        """
        return fetch_ortho_rgb(west, south, east, north, RESOLUTION_M)

    def orthophoto(self, west, south, east, north):
        """L'orthophoto que les lectures de la même emprise se partagent :
        une zone de 1 000 m en lit six tuiles de 2 048 px (ortho.ORTHO_RGB_FILS),
        que chaque lecture relisait avant le partage.

        Raises:
            requests.RequestException si elle n'a pas pu être lue.
        """
        return self._orthophoto(west, south, east, north)

    def piscines(self, west, south, east, north, rgb=None):
        """Les piscines de l'emprise, vues de tous les détecteurs du mode ;
        `rgb` : l'orthophoto de l'emprise, déjà lue."""
        if rgb is None:
            rgb = self._orthophoto(west, south, east, north)
        return {"largeur": rgb.shape[1], "hauteur": rgb.shape[0],
                "piscines": detecter_piscines(rgb, self.sessions, fils=self.fils)}

    def vehicules(self, detecteur):
        """La lecture des véhicules d'un détecteur : (emprise, rgb=None) -> brut."""
        session = {detecteur: self.sessions[detecteur]}

        def lire(west, south, east, north, rgb=None):
            if rgb is None:
                rgb = self._orthophoto(west, south, east, north)
            return {"largeur": rgb.shape[1], "hauteur": rgb.shape[0],
                    "boites": detecter(rgb, session, fils=self.fils)}
        return lire


def lecteur(mode=None, dossier=None):
    """Le `Lecteur` du mode de `VUE3D_VEHICULES` ; None en mode `aucun`, la
    couche n'existe pas. Les réseaux sont chargés ici, une fois, au démarrage
    du serveur.

    Raises:
        VehiculesMalConfigures si le mode demandé n'a pas ses réseaux.
    """
    mode = mode_demande(mode)
    if not MODES[mode]:
        return None
    sessions = charger(mode, dossier or os.environ.get("VUE3D_MODELES", "/modeles"))
    journal.info("Véhicules et piscines : mode %s (%s)", mode, ", ".join(sessions))
    return Lecteur(mode, sessions)


def _zone(geojsons, kx, ky):
    """Union, en mètres, des polygones d'une liste de géométries GeoJSON."""
    polys = []
    for g in geojsons:
        try:
            geom = shape(g).buffer(0)
        except Exception:
            continue
        if not geom.is_empty:
            polys.append(geom)
    if not polys:
        return None
    import shapely
    return shapely.transform(shapely.force_2d(unary_union(polys)), lambda c: c * [kx, ky])


def en_geographie(west, south, east, north, brut, cle):
    """Boîtes `brut[cle]` en pixels de l'orthophoto de l'emprise, de
    `detecter` ou de `detecter_piscines`, en coordonnées : [[lon, lat,
    longueur_m, largeur_m, cap, score, ...]], la suite de chaque boîte telle
    quelle. Le cap est celui du grand axe, en degrés depuis le nord vers
    l'est, de 0 à 180. C'est la forme des relevés (vue3d/releves.py), qui
    survivent à leur image."""
    brut = brut or {}
    largeur, hauteur = brut.get("largeur") or 1, brut.get("hauteur") or 1
    kx = 111320 * math.cos(math.radians((south + north) / 2))
    ky = 111320
    # Mètres par pixel, sur chaque axe : l'image est demandée à la taille de
    # l'emprise en mètres, à l'arrondi du pixel près.
    px, py = (east - west) * kx / largeur, (north - south) * ky / hauteur
    boites = []
    for cx, cy, lo, la, angle, score, *suite in brut.get(cle, []):
        # Longueur et largeur en mètres : la boîte est tournée, chaque
        # demi-axe se mesure avec les deux pas.
        c, s_ = math.cos(angle), math.sin(angle)
        longueur = lo * math.hypot(c * px, s_ * py)
        travers = la * math.hypot(s_ * px, c * py)
        lon, lat = west + cx * px / kx, north - cy * py / ky
        # Dans l'image, y descend vers le sud : vers l'est c·px, vers le nord −s·py.
        cap = math.degrees(math.atan2(c * px, -s_ * py)) % 180.0
        # Au millimètre : la couche arrondit ensuite au décimètre.
        boites.append([round(lon, DECIMALES), round(lat, DECIMALES), round(longueur, 3),
                       round(travers, 3), round(cap, 3), round(float(score), 4), *suite])
    return boites


def _poser(west, south, east, north, boites, nom, longueurs, largeurs, batiments, eau):
    """Boîtes (lon, lat, longueur_m, largeur_m, cap, couleur) -> objets de la
    couche, ceux hors gabarit ou mal placés écartés : [[lon, lat,
    longueur_m, largeur_m, cap, couleur]]."""
    kx = 111320 * math.cos(math.radians((south + north) / 2))
    ky = 111320
    interdit = [z for z in (
        _zone([f.get("geometry") for f in (batiments or {}).get("features", [])
               if f.get("geometry")], kx, ky),
        _zone([s["geometrie"] for s in (eau or {}).get("surfaces", [])], kx, ky)) if z is not None]
    # Au bord, la scène ne connaît pas les bâtiments (ils sont découpés en
    # retrait) et la boîte d'un objet coupé par le cadre n'est pas fiable.
    marge_x, marge_y = DECOUPE_RETRAIT_M / kx, DECOUPE_RETRAIT_M / ky
    gardes, ecartes = [], {"gabarit": 0, "bord": 0, "bâti ou eau": 0}
    for lon, lat, longueur, travers, cap, couleur in boites:
        if not (longueurs[0] <= longueur <= longueurs[1]
                and largeurs[0] <= travers <= largeurs[1]):
            ecartes["gabarit"] += 1
            continue
        if not (west + marge_x <= lon <= east - marge_x
                and south + marge_y <= lat <= north - marge_y):
            ecartes["bord"] += 1
            continue
        if any(z.contains(Point(lon * kx, lat * ky)) for z in interdit):
            ecartes["bâti ou eau"] += 1
            continue
        gardes.append([round(lon, DECIMALES), round(lat, DECIMALES), round(longueur, 1),
                       round(travers, 1), round(cap, 1), couleur])
    journal.info("%s : %d gardé(s) ; écartés : %s", nom, len(gardes),
                 ", ".join(f"{n} {cle}" for cle, n in ecartes.items()))
    return gardes


def vehicules_pour_emprise(west, south, east, north, brut, detecteur, batiments=None, eau=None):
    """Véhicules d'un détecteur sur l'emprise, prêts pour la vue.

    Args:
        brut: {"boites": boîtes du détecteur sur l'emprise}, en coordonnées
            (`en_geographie`) : les relevés qui la couvrent, réunis
            (releves.reunir).
        detecteur: son nom, inscrit dans la couche.
        batiments: GeoJSON des bâtiments de la scène ; un « véhicule » sur un
            toit est une lucarne ou une verrière.
        eau: eau de la scène (vue3d/eau.py) ; un « véhicule » sur l'eau est
            une barque.

    Returns:
        dict(version, detecteur, vehicules), la liste vide si l'emprise n'en
        a aucun. `vehicules` : [[lon, lat, longueur_m, largeur_m, cap,
        couleur]] — cap du grand axe en degrés depuis le nord vers l'est, de
        0 à 180 (l'avant et l'arrière ne sont pas distingués) ; couleur
        0xRRGGBB lue sur l'orthophoto. C'est la vue qui réunit les
        détecteurs d'un mode, dans leur ordre (MODES) : une boîte dont le
        centre est à moins de DOUBLON_ENTRE_DETECTEURS_M d'une boîte déjà
        dessinée n'est pas ajoutée.
    """
    brut = brut or {}
    # La longueur maximale d'un véhicule est déjà celle de son détecteur.
    vehicules = _poser(west, south, east, north,
                       [(*b[:5], b[7]) for b in brut.get("boites", [])],
                       f"Véhicules ({detecteur})", (LONGUEUR_MIN_M, math.inf), LARGEUR_M,
                       batiments, eau)
    return {"version": VEHICULES_VERSION, "detecteur": detecteur, "vehicules": vehicules}


def piscines_pour_emprise(west, south, east, north, brut, mode, batiments=None, eau=None):
    """Piscines de l'emprise, prêtes pour la vue.

    Args:
        brut: {"piscines": boîtes de tous les détecteurs du mode}, en
            coordonnées, comme pour les véhicules.
        mode: celui du lecteur, inscrit dans la couche.
        batiments, eau: comme pour les véhicules ; une « piscine » sur un
            toit est une véranda, sur l'eau un bassin que la BD TOPO dessine
            déjà.

    Returns:
        dict(version, mode, piscines) ; `piscines` comme `vehicules`
        ci-dessus, la boîte étant celle du bassin, rectangulaire ou non.
    """
    brut = brut or {}
    piscines = _poser(west, south, east, north,
                      [(*b[:5], b[6]) for b in brut.get("piscines", [])],
                      f"Piscines ({mode})", PISCINE_LONGUEUR_M, PISCINE_LARGEUR_M, batiments, eau)
    return {"version": PISCINES_VERSION, "mode": mode, "piscines": piscines}
