"""Construction d'une scène 3D autour d'un point, et son cache disque.

Une scène, c'est tout ce que la vue 3D affiche autour d'une coordonnée, dans un
carré de ±0,0016° (environ 356 m de côté) :

- les bâtiments BD TOPO, découpés sur l'emprise, et leurs toitures mesurées
  au LiDAR HD ;
- les houppiers et masses de sursol segmentés sur le MNH LiDAR HD à 0,5 m ;
- les réservoirs et constructions ponctuelles de la BD TOPO (citernes,
  torchères, cheminées, antennes), qui sortent du sursol avant la
  segmentation ;
- les routes, pour orienter Street View ;
- le relief RGE ALTI, quantifié au décimètre ;
- un anneau de relief grossier sur 2 km de côté, pour que la scène ne flotte
  pas dans le vide ;
- et, dans un fichier à part, une mosaïque d'orthophoto en une seule image.

Les monuments OSM (`building:part`), là où ils sont plus riches que la BD
TOPO, forment une couche à part (`Cache.obtenir_monuments`), que la vue
demande une fois la scène affichée. OpenStreetMap répond de 0,6 s à plus de
100 s et tombe parfois : la scène ne l'attend pas, et n'échoue pas avec lui.
La lecture d'Overpass part pourtant dès la demande de la scène, en tâche de
fond, pour que la couche soit souvent prête quand la vue la demande.

Les ouvrages de la BD TOPO (murs, ponts, voies ferrées, terrains de sport,
vue3d/ouvrages.py) suivent le même chemin (`Cache.obtenir_ouvrages`) : rien de
ce qu'ils décrivent n'entre dans un calcul de la scène, qui n'a donc pas à
échouer avec eux ni à être reconstruite quand leur format change.

Les véhicules et les piscines de l'orthophoto (vue3d/vehicules.py) sont une
troisième couche à part, optionnelle : elle n'existe que si le service a été
lancé avec un détecteur (`Cache.obtenir_vehicules`, `VUE3D_VEHICULES`). Les
panneaux solaires du registre OpenPVMapper (vue3d/panneaux.py) en sont une
quatrième, optionnelle aussi (`Cache.obtenir_panneaux`, `VUE3D_PANNEAUX`).

La construction coûte de quelques secondes à une demi-minute selon la zone et
le lieu. Ses seize lectures partent ensemble (`_lire_ensemble`) : 3 s environ
pour une zone de 1 000 m, environ une seconde pour l'emprise par défaut — le
temps de la plus longue, au lieu de 13 s et de 4 à 5 s une à une. Le
résultat est mis en cache sur disque, par point arrondi à 4 décimales (une
dizaine de mètres) : deux demandes voisines partagent la même scène.

**Une scène est complète ou n'existe pas.** Le cache ne périme pas — les
campagnes LiDAR, la BD TOPO et la BD Forêt se renouvellent au mieux une fois
l'an — donc une scène mise en cache pendant une panne resterait fausse pour
toujours. La construction distingue « la donnée n'existe pas ici », qui est un
fait (hors couverture RGE ALTI, le relief est simplement absent), de « on n'a
pas réussi à la lire », qui est un incident : rien n'est alors écrit, et la
demande suivante réessaie.
"""

import concurrent.futures
import copy
import functools
import gzip
import json
import logging
import math
import os
import shutil
import tempfile
import threading
import time

import numpy as np

from .batiments import decouper_batiments
from .constructions import (COUCHE_PONCTUELLES, COUCHE_RESERVOIRS,
                            constructions_pour_emprise)
from .couches import (COUCHE_BATIMENTS, COUCHE_FORET, COUCHE_ROUTES,
                      COUCHE_VEGETATION, lire_couche)
from .eau import (COUCHE_COURS_EAU, COUCHE_SURFACES_EAU, eau_pour_emprise,
                  masque_eau)
from .geopf import Groupe
from .lignes import COUCHE_LIGNES, COUCHE_PYLONES, lignes_pour_emprise
from .houppiers import houppiers_pour_emprise
from .mnh import dimensions_grille, fetch_mnh_grid, fetch_sol_grid
from .monuments import fetch_monuments, monuments_pour_emprise
from .ortho import fetch_exg_grid, fetch_ortho_jpeg
from .nuage import NUAGE_VERSION, fetch_nuage, nuage_pour_emprise
from .ouvrages import OUVRAGES_VERSION, fetch_ouvrages, ouvrages_pour_emprise
from .panneaux import PANNEAUX_VERSION, panneaux_pour_emprise
from .releves import MARGE_PISCINES_PX, MARGE_VEHICULES_PX, Releves, emprise_image
from .releves import rectangle as rectangle_releve
from .relief import RELIEF_TAILLE, fetch_relief, fetch_relief_anneau
from .toits import TOITS_RESOLUTION_M, toits_pour_emprise
from .vehicules import (PISCINES_VERSION, VEHICULES_VERSION, piscines_pour_emprise,
                        vehicules_pour_emprise)

journal = logging.getLogger(__name__)

# Format de la scène. L'incrémenter invalide tout le cache.
# 2 : anneau de relief autour de l'emprise.
# 3 : surface mesurée des toits fiables.
# 4 : eau de surface.
# 5 : lignes à haute tension.
# 6 : monuments OSM (building:part).
# 7 : profil minimal (hauteur inconnue) pour les bâtiments illisibles.
# 8 : toits en pans (vue3d/pans.py), préférés à la surface mesurée.
# 9 : monuments OSM hors de la scène, en couche à part (NOM_MONUMENTS).
# 10 : bâtiments découpés sur l'emprise (vue3d/batiments.py).
# 11 : réservoirs et constructions ponctuelles (vue3d/constructions.py),
#      retirés du sursol des houppiers.
# 12 : sursol plafonné à 40 m hors forêt (houppiers.SURSOL_HAUTEUR_MAX_M), et
#      retiré des étendues d'eau (eau.masque_eau).
# 13 : bâtiments à deux niveaux (toits.py) : forme mesurée plutôt que le
#      résumé du niveau bas.
# 14 : constructions ponctuelles qui dépassent leur bâtiment, fût des très
#      hautes cheminées dont le LiDAR perd le sommet, tours de
#      refroidissement (constructions.py).
SCENE_VERSION = 14
# Demi-côté de l'emprise, en degrés : ~178 m de part et d'autre du point.
SCENE_DELTA = 0.0016
# Demi-côté de l'anneau, en mètres et non en degrés : carré sur le terrain.
# La vue s'éloigne de 900 m au plus et son brouillard s'achève à 900 m de la
# caméra : au-delà d'un kilomètre du point, l'anneau ne serait jamais vu.
ANNEAU_DEMI_M = 1000
# Arrondi du point pour la clé de cache : 4 décimales, une dizaine de mètres.
SCENE_ARRONDI = 4
# Zone élargie (ou réduite) à la demande : `zone`, côté nord-sud de l'emprise
# en mètres. Sans elle, l'emprise par défaut (SCENE_DELTA, ~356 m), dont le
# cache garde son dossier. Arrondie au pas, pour que deux demandes voisines
# partagent leur scène comme le point arrondi.
#
# Plafond : la grille MNH à 0,5 m tient en une requête jusqu'à 2 048 pixels
# de côté, soit 1 024 m ; au-delà, toits et houppiers perdraient leur
# résolution. Le temps de construction et le poids de la scène croissent
# comme la surface : ×8 à 1 000 m.
ZONE_PAS_M = 50
ZONE_MIN_M = 150
ZONE_MAX_M = 1000
# Côté nord-sud de l'emprise par défaut, en mètres.
SCENE_COTE_M = 2 * SCENE_DELTA * 111320
# Étapes d'une construction, que la page affiche pendant l'attente : les
# seize lectures de construire(), puis les toitures et les houppiers
# d'assembler(). Un compteur plutôt qu'un pourcentage : les étapes sont très
# inégales (moins d'une seconde pour la plupart des lectures, plusieurs pour
# la grille MNH et les deux calculs), une part du temps serait fausse.
# Les lectures partent ensemble : l'étape k est alors « k − 1 lectures
# finies », et son libellé dit celles qu'on attend encore.
ETAPES_SCENE = 18
# Libellés des deux étapes de calcul d'assembler, toujours les dernières
# annoncées : la page pondère sa barre d'attente d'après elles
# (partConstruite), et outils/verifier-geometrie.mjs le contrôle.
ETAPES_DE_CALCUL = ("toitures", "houppiers")
# Côté maximal de la grille MNH à 0,5 m : le plafond du WMS (ZONE_MAX_M).
GRILLE_PIXELS_MAX = 2048
# Source du MNH qu'on suppose pour lire le terrain en même temps que lui : le
# LiDAR HD couvrait 77 % d'un échantillon de 60 bâtiments tirés au hasard en
# France (vue3d/mnh.py), et davantage à mesure que le programme avance.
# Ailleurs, le terrain lu pour rien l'a été en même temps que le reste — ou
# pas du tout s'il attendait encore sa place — et il est relu à la bonne
# source.
SOURCE_PROBABLE = "lidar_hd"
LECTURE_GRILLE = "hauteurs du sursol"
LECTURE_TERRAIN = "terrain sous les toits"
NOM_SCENE = "scene.json.gz"
NOM_ORTHO = "ortho.jpg"
NOM_MONUMENTS = "monuments.json.gz"
# La version de la couche est dans son nom : la changer ne refait qu'elle.
NOM_OUVRAGES = f"ouvrages-v{OUVRAGES_VERSION}.json.gz"


# Les panneaux solaires ont une seule source : le registre, à sa version.
NOM_PANNEAUX = f"panneaux-v{PANNEAUX_VERSION}.json.gz"
NOM_NUAGE = f"nuage-v{NUAGE_VERSION}.json.gz"


def nom_vehicules(detecteur):
    """Fichier des véhicules d'un détecteur. Son nom est dans celui du fichier,
    avec la version : relancer le service avec un autre ne ressert jamais la
    couche du précédent, et les deux restent en cache côte à côte. Un fichier
    par détecteur, pour que la vue montre ceux du rapide sans attendre le
    lent."""
    return f"vehicules-{detecteur}-v{VEHICULES_VERSION}.json.gz"


def nom_piscines(mode):
    """Fichier des piscines, vues de tous les détecteurs du mode."""
    return f"piscines-{mode}-v{PISCINES_VERSION}.json.gz"

# Le service couvre la France. Au-delà, les couches répondent vide et la scène
# n'aurait rien à montrer : mieux vaut le dire tout de suite.
EMPRISE_SERVIE = {"lat": (41.0, 51.6), "lon": (-5.8, 10.0)}


class SceneIncomplete(RuntimeError):
    """Une source n'a pas répondu : rien n'est mis en cache, réessayer plus tard."""


class VehiculesIndisponibles(RuntimeError):
    """L'orthophoto des véhicules ou des piscines n'a pas pu être lue, ou la
    détection a échoué : rien n'est mis en cache, la scène reste affichée
    sans eux."""


class VehiculesDesactives(RuntimeError):
    """Le service tourne sans détecteur, ou sans celui qu'on lui demande : la
    couche n'existe pas."""


class PanneauxIndisponibles(RuntimeError):
    """La base des panneaux n'a pas pu être lue : rien n'est mis en cache."""


class PanneauxDesactives(RuntimeError):
    """Le service tourne sans registre des panneaux : la couche n'existe pas."""


class HorsEmprise(ValueError):
    """Le point est hors de la zone couverte par les données IGN."""


class MonumentsIndisponibles(RuntimeError):
    """Overpass n'a pas répondu : la couche OSM n'est pas mise en cache, la
    scène reste affichée sans elle, réessayer plus tard."""


class NuageIndisponible(RuntimeError):
    """Une dalle LiDAR HD, ou leur liste, n'a pas pu être lue : rien n'est mis
    en cache, la scène reste affichée sans le nuage, réessayer plus tard."""


class OuvragesIndisponibles(RuntimeError):
    """Une couche d'ouvrages de l'IGN n'a pas répondu : rien n'est mis en
    cache, la scène reste affichée sans eux, réessayer plus tard."""


class ReconstructionRefusee(RuntimeError):
    """La scène ne peut pas être reconstruite maintenant : `code` HTTP 429
    si elle l'a été il y a trop peu de temps, 409 si elle ou l'une de ses
    couches est en cours de calcul."""

    def __init__(self, message, code):
        super().__init__(message)
        self.code = code


def point_normalise(lat, lon):
    """Point arrondi qui sert de clé, après contrôle de l'emprise servie."""
    lat, lon = float(lat), float(lon)
    if not (EMPRISE_SERVIE["lat"][0] <= lat <= EMPRISE_SERVIE["lat"][1]
            and EMPRISE_SERVIE["lon"][0] <= lon <= EMPRISE_SERVIE["lon"][1]):
        raise HorsEmprise(
            "Point hors de France métropolitaine : les données IGN n'y sont pas servies.")
    return round(lat, SCENE_ARRONDI), round(lon, SCENE_ARRONDI)


def zone_normalisee(zone):
    """Côté de la zone en mètres, arrondi au pas et borné ; None pour
    l'emprise par défaut.

    Raises:
        ValueError si `zone` n'est pas un nombre.
    """
    if zone is None or zone == "":
        return None
    cote = float(zone)
    if cote != cote:
        raise ValueError("zone n'est pas un nombre")
    cote = int(round(cote / ZONE_PAS_M) * ZONE_PAS_M)
    return min(max(cote, ZONE_MIN_M), ZONE_MAX_M)


def facteur_zone(zone):
    """Rapport du côté de la zone à celui de l'emprise par défaut."""
    return 1.0 if zone is None else zone / SCENE_COTE_M


def emprise(lat, lon, zone=None):
    """Emprise (ouest, sud, est, nord) autour d'un point.

    Le même écart en degrés dans les deux sens, comme l'emprise par défaut :
    plus étroite d'est en ouest qu'en mètres du nord au sud.
    """
    delta = SCENE_DELTA if zone is None else zone / 2 / 111320
    return lon - delta, lat - delta, lon + delta, lat + delta


def emprise_anneau(lat, lon, demi_m=ANNEAU_DEMI_M, zone=None):
    """Emprise (ouest, sud, est, nord) de l'anneau, carrée en mètres. Elle
    grandit avec la zone, que la vue regarde de plus loin."""
    demi_m *= max(1.0, facteur_zone(zone))
    dlat = demi_m / 111320
    dlon = demi_m / (111320 * math.cos(math.radians(lat)))
    return lon - dlon, lat - dlat, lon + dlon, lat + dlat


def assembler(west, south, east, north, batiments, vegetation, forets, routes,
              grille, exg, relief, anneau=None, sol=None, eau=None, lignes=None,
              avancer=None, constructions=None):
    """Contenu de la scène à partir des sources déjà obtenues.

    Séparée de `construire` pour être testable sans réseau. Les grilles MNH,
    ExG et de terrain ne sont PAS embarquées : ce sont des entrées de calcul
    de 1,9 Mo, 475 Ko et 1,4 Mo, sans usage une fois les toitures et les
    houppiers obtenus. `avancer`, s'il est donné, est appelé avec le libellé
    de chaque calcul, toujours dans cet ordre : « toitures » au début des
    toitures, « houppiers » à leur fin — les houppiers ont alors pu commencer
    avec elles. `constructions` : les couches BD TOPO (réservoirs,
    constructions ponctuelles), None sans elles.
    """
    from .toits import toitures_au_bassin
    avancer = avancer or (lambda libelle: None)
    avancer(ETAPES_DE_CALCUL[0])
    # Découpés pour les toitures et pour la vue. Les houppiers gardent les
    # bâtiments entiers : leur masque bâti s'arrête de toute façon à la
    # grille, et dans le retrait de la découpe un toit passerait pour du
    # sursol.
    decoupes = decouper_batiments(batiments, west, south, east, north)

    def vegetation_et_constructions():
        # Les constructions et les houppiers lisent la grille en tableau : la
        # liste n'est convertie qu'une fois pour les deux (0,05 s par
        # conversion sur une grille de 1 440 × 1 985).
        tableau = {**grille, "values": np.asarray(grille["values"], dtype=np.float32)}
        # Réservoirs et constructions ponctuelles sortent du sursol avec les
        # bâtiments : sans cela, une citerne se couvre de masses et de
        # houppiers (vue3d/constructions.py).
        construits, masque = constructions_pour_emprise(
            west, south, east, north, *(constructions or (None, None)), batiments, tableau)
        # L'eau aussi : entre deux quais, le MNH lit leur hauteur en pleine
        # rivière (vue3d/eau.py).
        nappes = masque_eau(eau[0], south, north) if eau else {"features": []}
        bati = {"features": ((batiments or {}).get("features", []) + masque["features"]
                             + nappes["features"])}
        return construits, houppiers_pour_emprise(west, south, east, north, bati, vegetation,
                                                  forets, tableau, exg)

    if toitures_au_bassin(decoupes):
        # Les houppiers ne lisent pas les toits. Pendant que le bassin
        # calcule les toitures, ce fil ne fait qu'attendre : les houppiers
        # se calculent dans un autre. Quand les toitures tenaient le GIL,
        # c'était plus lent (7,66 -> 8,11 s à Gordes en zone de 1 000 m).
        # Au bassin, mesuré le 2026-10-02 sur un M4 à dix cœurs chargé par
        # d'autres calculs (charge 100 à 135) : assembler, houppiers à la
        # suite puis pendant les toitures, dos à dos, médianes de huit tours
        # alternés (rapport apparié médian) :
        #
        #                         macOS (spawn)          conteneur (forkserver)
        #   Gordes, défaut        0,43 -> 0,41 s (×0,99)  0,41 -> 0,27 s (×1,45)
        #   Gordes, 1 000 m       1,83 -> 1,35 s (×1,35)  1,87 -> 1,50 s (×1,24)
        #   Strasbourg, 1 000 m   3,66 -> 3,69 s (×1,09)  4,17 -> 3,49 s (×1,23)
        #
        # Quinze séries en tout, avec celles d'un premier essai : ×1,23 en
        # médiane, de ×0,94 à ×1,51. Au calme (charge 4 à 12), dans un même
        # processus, bassin chaud, médianes de dix tours alternés, macOS :
        # Gordes 0,151 -> 0,123 s, Gordes en zone de 1 000 m 0,721 ->
        # 0,686 s, Strasbourg en zone de 1 000 m 1,54 -> 1,25 s. Le gain ne
        # dépasse pas la durée des toitures, qui s'allongent un peu : le GIL
        # est partagé avec le fil des houppiers (0,24 -> 0,30 s à Gordes en
        # zone de 1 000 m). Même scène à l'octet ; 20 à 40 Mo de plus au pic
        # de mémoire du service, à 1 000 m. Un bassin qui casse rend les
        # toitures à ce fil, à côté des houppiers : juste, plus lent.
        with concurrent.futures.ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="houppiers") as fil:
            pendant = fil.submit(vegetation_et_constructions)
            toits = toits_pour_emprise(west, south, east, north, decoupes, grille, exg, sol)
            avancer(ETAPES_DE_CALCUL[1])
            construits, veg = pendant.result()
    else:
        toits = toits_pour_emprise(west, south, east, north, decoupes, grille, exg, sol)
        avancer(ETAPES_DE_CALCUL[1])
        construits, veg = vegetation_et_constructions()
    return {
        "version": SCENE_VERSION,
        "bbox": [west, south, east, north],
        "batiments": decoupes,
        "toits": toits,
        "routes": routes,
        # Réservoirs découpés sur l'emprise et constructions ponctuelles.
        "constructions": construits,
        "houppiers": veg.get("houppiers", []),
        "masses": veg.get("masses", []),
        "vegetation": {cle: veg.get(cle) for cle in (
            "source", "couvert", "resolution_m", "seuil_m", "ortho",
            "veg_disponible", "foret_disponible", "hauteur_max", "nb_ortho")},
        # None hors couverture RGE ALTI : la vue bascule sur son repli mondial.
        "relief": relief,
        # Contient l'emprise, que la vue découpe : ses trous (mer, frontière)
        # restent vides. None si rien n'y est couvert.
        "anneau": anneau,
        # Étendues et cours d'eau, découpés sur l'emprise (vue3d/eau.py).
        "eau": eau_pour_emprise(west, south, east, north, *eau) if eau else None,
        # Sur l'emprise de l'anneau : une ligne se voit de loin (vue3d/lignes.py).
        "lignes": lignes,
    }


def construire(lat, lon, avancer=None, zone=None):
    """Construit la scène d'un point.

    Args:
        avancer: appelé ETAPES_SCENE fois, d'un seul fil, pour le suivi que
            la page affiche : au départ des lectures et à chacune qui finit,
            avec celles qu'on attend encore (`_lire_ensemble`), puis au début
            des toitures et des houppiers.
        zone: côté de l'emprise en mètres (`zone_normalisee`), None pour
            l'emprise par défaut.

    Returns:
        (octets gzip de la scène, octets JPEG de l'orthophoto).
    Raises:
        SceneIncomplete si une source n'a pas pu être lue.
    """
    avancer = avancer or (lambda libelle: None)
    west, south, east, north = emprise(lat, lon, zone)
    bbox = (west, south, east, north)
    anneau_bbox = emprise_anneau(lat, lon, zone=zone)
    # Le relief garde sa maille d'environ 1,4 m quand la zone grandit, jusqu'à
    # 512 points de côté.
    taille_relief = min(512, round(RELIEF_TAILLE * max(1.0, facteur_zone(zone))))
    # L'orthophoto et le terrain se lisent à la taille de la grille MNH, qui
    # ne dépend que de l'emprise : demandés avec elle, pas après elle.
    largeur, hauteur = dimensions_grille(*bbox, TOITS_RESOLUTION_M, GRILLE_PIXELS_MAX)

    def terrain(source):
        # Le terrain dont le MNH est tiré, pour redresser les toits sur la
        # pente : une entrée de calcul, comme le MNH, jamais embarquée.
        return fetch_sol_grid(*bbox, largeur, hauteur, source)

    couches = (
        ("bâtiments", COUCHE_BATIMENTS, bbox),
        ("zones de végétation", COUCHE_VEGETATION, bbox),
        ("BD Forêt", COUCHE_FORET, bbox),
        ("routes", COUCHE_ROUTES, bbox),
        ("étendues d'eau", COUCHE_SURFACES_EAU, bbox),
        ("cours d'eau", COUCHE_COURS_EAU, bbox),
        ("réservoirs", COUCHE_RESERVOIRS, bbox),
        ("constructions ponctuelles", COUCHE_PONCTUELLES, bbox),
        # Sur l'emprise de l'anneau : une ligne se voit de loin (vue3d/lignes.py).
        ("lignes électriques", COUCHE_LIGNES, anneau_bbox),
        ("pylônes", COUCHE_PYLONES, anneau_bbox))
    t0 = time.monotonic()
    lu = _lire_ensemble([
        # Les plus longues d'abord : 1,5 à 3,5 s chacune pour une zone de
        # 1 000 m, contre 0,1 à 0,3 s pour une couche WFS. Elles prennent
        # les premières places (geopf.place), les petites passent entre.
        # La grille à 0,5 m sert aux toitures ET aux houppiers : lue une fois.
        (LECTURE_GRILLE, functools.partial(fetch_mnh_grid, *bbox, resolution_m=TOITS_RESOLUTION_M,
                                           max_pixels=GRILLE_PIXELS_MAX)),
        ("orthophoto", functools.partial(fetch_exg_grid, *bbox, largeur, hauteur)),
        (LECTURE_TERRAIN, functools.partial(terrain, SOURCE_PROBABLE)),
        ("mosaïque d'orthophoto", functools.partial(fetch_ortho_jpeg, *bbox)),
        ("relief", functools.partial(fetch_relief, *bbox, taille=taille_relief)),
        ("relief de l'anneau", functools.partial(fetch_relief_anneau, *anneau_bbox)),
    ] + [(nom, functools.partial(lire_couche, couche, *b)) for nom, couche, b in couches],
        avancer, terrain)
    lectures_s = time.monotonic() - t0

    grille = lu[LECTURE_GRILLE]
    lignes = lignes_pour_emprise(*anneau_bbox, lu["lignes électriques"], lu["pylônes"])
    mosaique, _, _ = lu["mosaïque d'orthophoto"]
    scene = assembler(west, south, east, north, lu["bâtiments"], lu["zones de végétation"],
                      lu["BD Forêt"], lu["routes"], grille, lu["orthophoto"], lu["relief"],
                      lu["relief de l'anneau"], lu[LECTURE_TERRAIN],
                      (lu["étendues d'eau"], lu["cours d'eau"]), lignes, avancer,
                      (lu["réservoirs"], lu["constructions ponctuelles"]))
    journal.info("Scène %.4f, %.4f (zone %s) : %d bâtiment(s), %d houppier(s), source %s, "
                 "lectures en %.1f s",
                 lat, lon, zone or "par défaut", len(scene["batiments"].get("features", [])),
                 len(scene["houppiers"]), grille.get("source"), lectures_s)
    return gzip.compress(json.dumps(scene, separators=(",", ":")).encode(), 6), mosaique


def _libelle(attendues):
    """Ce que la page affiche pendant les lectures : celles qu'on attend
    encore, les plus longues en tête."""
    if len(attendues) <= 2:
        return " et ".join(attendues)
    reste = len(attendues) - 2
    return f"{attendues[0]}, {attendues[1]} et {reste} autre{'s' if reste > 1 else ''}"


def _lire_ensemble(lectures, avancer, terrain):
    """Les lectures d'une scène, toutes lancées ensemble ; {nom: résultat}.

    Une seule en échec, et la scène est incomplète : SceneIncomplete dès
    qu'on le sait, et rien n'est écrit. Les lectures forment un groupe
    (geopf.Groupe), abandonné dès l'échec : celles qui attendent encore une
    place ne partent plus, celles déjà parties ne réessaient plus et
    finissent sans que personne ne les attende. Chaque lecture ayant son
    fil, annuler leurs futurs n'arrêtait rien : hors réseau, la grille en
    échec en 0,05 s et les autres requêtes en 1 s, les 16 partaient, dont
    7 après l'échec annoncé ; 8 depuis, aucune après
    (tests/test_lectures.py). Pendant une panne, où une requête tient sa
    place jusqu'à 96 s (3 essais de 30 s et 2 attentes de 3 s), une scène
    ratée gardait ainsi les places du processus deux vagues de suite ; elle
    les rend désormais au bout de l'essai en cours.

    Une seule dépendance réelle : le terrain sous les toits est celui de la
    source du MNH. Il est lu d'emblée à SOURCE_PROBABLE (`terrain(source)`),
    dans un groupe à lui, et n'est retenu qu'une fois la grille connue. Si
    elle a une autre source, ce groupe est abandonné — la requête d'environ
    11 Mo ne part pas si elle n'a pas encore sa place — son échec éventuel
    oublié, et le terrain relu à la bonne source.

    `avancer` n'est appelé que d'ici, d'un seul fil : une fois au départ,
    puis à chaque lecture finie sauf la dernière (l'étape suivante, les
    toitures, s'annonce elle-même). L'étape k compte donc k − 1 lectures
    finies, toujours croissante, et `len(lectures)` appels en tout.

    Args:
        lectures: (nom, fonction sans argument), dans l'ordre de lancement.
    """
    ordre = {nom: i for i, (nom, _) in enumerate(lectures)}
    attendues = [nom for nom, _ in lectures]
    # Un fil par lecture, et un pour un terrain à relire : aucune n'attend un
    # fil, seulement une place vers la Géoplateforme (geopf.place).
    bassin = concurrent.futures.ThreadPoolExecutor(max_workers=len(lectures) + 1,
                                                   thread_name_prefix="lecture")
    groupe = Groupe()
    terrain_probable = Groupe(groupe)
    lu, terrain_tenu = {}, None

    def nommee(nom, lecture):
        # L'échec nommé dans le fil même de la lecture : il devient la cause
        # du groupe, que l'on rapporte même quand une lecture abandonnée à
        # cause de lui finit avant lui.
        def lire(*args):
            try:
                return lecture(*args)
            except Exception as exc:
                raise SceneIncomplete(f"{nom} illisible : {exc}") from exc
        return lire

    def finie(nom, futur):
        if groupe.abandonne():
            # Une lecture a échoué : ce qui finit maintenant a pu être
            # abandonné à cause d'elle. C'est son échec qu'on rapporte.
            raise groupe.cause or SceneIncomplete(f"{nom} abandonnée")
        lu[nom] = futur.result()                # SceneIncomplete, déjà nommée
        attendues.remove(nom)
        if attendues:
            avancer(_libelle(attendues))

    try:
        en_cours = {(terrain_probable if nom == LECTURE_TERRAIN else groupe).soumettre(
            bassin, nommee(nom, lecture)): nom for nom, lecture in lectures}
        avancer(_libelle(attendues))
        while en_cours:
            faites, _ = concurrent.futures.wait(
                en_cours, return_when=concurrent.futures.FIRST_COMPLETED)
            # Dans l'ordre de lancement : deux lectures finies ensemble
            # s'annoncent toujours dans le même ordre.
            for futur in sorted(faites, key=lambda f: ordre[en_cours[f]]):
                nom = en_cours.pop(futur, None)
                if nom is None:
                    continue                    # terrain écarté plus haut
                if nom == LECTURE_TERRAIN and LECTURE_GRILLE not in lu:
                    terrain_tenu = futur        # source pas encore connue
                    continue
                finie(nom, futur)
                if nom != LECTURE_GRILLE:
                    continue
                grille = lu[nom]
                if not grille.get("couvert"):
                    # Ni LiDAR HD ni repli photogrammétrique : la scène
                    # n'aurait ni toiture mesurée ni houppier. Le repli dépend
                    # d'un second service qui peut lui aussi tomber : on ne
                    # fige pas une scène vide.
                    raise SceneIncomplete(
                        "hauteurs du sursol indisponibles (ni LiDAR HD ni MNS − MNT)")
                if grille["source"] == SOURCE_PROBABLE:
                    if terrain_tenu is not None:
                        finie(LECTURE_TERRAIN, terrain_tenu)
                    continue
                # Le terrain lu d'emblée n'est pas celui de cette grille :
                # abandonné s'il n'est pas encore parti, oublié sinon.
                terrain_probable.abandonner()
                for autre in [f for f, n in en_cours.items() if n == LECTURE_TERRAIN]:
                    del en_cours[autre]
                terrain_tenu = None
                en_cours[groupe.soumettre(bassin, nommee(LECTURE_TERRAIN, terrain),
                                          grille["source"])] = LECTURE_TERRAIN
        return lu
    except BaseException as exc:
        groupe.abandonner(exc)
        raise
    finally:
        bassin.shutdown(wait=False, cancel_futures=True)


class SessionQuiCede:
    """Une session d'inférence (onnxruntime) dont chaque appel attend
    d'abord `attendre()` : celui du Cache, qui rend la main quand aucune
    scène n'est en construction (Cache.attendre_les_scenes). Une tuile de
    yolo dure 160 ms sur le processeur hors conteneur, 350 ms dans le
    conteneur (6,2 et 2,8 tuiles par seconde) : une scène demandée pendant
    une détection n'attend pas plus d'une tuile par appel en cours."""

    def __init__(self, session, attendre):
        self._session = session
        self._attendre = attendre

    def run(self, *args, **kwargs):
        self._attendre()
        return self._session.run(*args, **kwargs)

    def __getattr__(self, nom):
        # Appelé pour ce que l'enveloppe n'a pas, et jamais délégué pour un
        # nom spécial ni pour les siens : copy et pickle cherchent
        # __deepcopy__ ou __setstate__ sur une instance neuve, encore sans
        # _session, dont la recherche rappelait __getattr__ jusqu'au
        # RecursionError.
        if nom.startswith("__") or nom in ("_session", "_attendre"):
            raise AttributeError(nom)
        return getattr(self._session, nom)


def _sur_le_processeur(session):
    """Vrai si la session d'inférence calcule sur le processeur : son premier
    moteur est celui d'onnxruntime pour le processeur (vehicules.MOTEURS), ou
    elle ne le dit pas."""
    try:
        return session.get_providers()[0] == "CPUExecutionProvider"
    except (AttributeError, IndexError):
        return True


class Cache:
    """Scènes sur disque, une par point arrondi.

    Un verrou par point évite que deux demandes simultanées construisent deux
    fois la même scène — trente secondes et quelques mégaoctets d'appels IGN
    pour rien. L'écriture passe par un fichier temporaire renommé : une scène
    lue est toujours une scène entière.

    Les couches à part — monuments OSM, ouvrages BD TOPO — se rangent à côté
    de la scène, sous la même règle : écrites entières, ou pas du tout. Les
    détections sur l'orthophoto, elles, se rangent aussi par morceau de
    terrain, hors du dossier du point (`releves`, vue3d/releves.py) : un
    point voisin réunit sa couche de ce qui est déjà vu.

    Les détections sur l'orthophoto cèdent le processeur aux scènes.
    Chacune occupe tous les cœurs (onnxruntime) pendant des secondes, et
    jusqu'à plusieurs minutes en zone de 1 000 m sans CoreML : lancées avec
    la scène pour être prêtes avec elle, elles lui prenaient le processeur.
    Au processeur, chaque inférence attend donc qu'aucune scène ne soit en
    construction (CEDER_AU_PLUS_S, SessionQuiCede) ; l'orthophoto qu'elles
    se partagent, elle, se lit pendant ce temps.
    """

    # Au processeur, une inférence attend qu'aucune scène ne soit en
    # construction, lectures comprises (attendre_les_scenes), et non plus
    # seulement pendant ses toitures et ses houppiers. Mesuré le 2026-10-02
    # dans le conteneur, Gordes en zone de 1 000 m, avec `tous` :
    # - de bout en bout, cache vide, selon qu'elles cèdent au calcul seul,
    #   à toute la construction, ou sans détecteur : machine plus calme
    #   (charge de 19 à 59, six essais alternés), scène en 4,75 s, 4,61 s et
    #   4,76 s, dont 1,86 s, 1,69 s et 1,67 s de calcul, piscines en 17,4 s
    #   et 15,5 s ; machine chargée de 20 à 165 (11 à 14 essais), scène en
    #   5,3 s, 5,1 s et 4,8 s, à un bruit près de 4,2 à 7,3 s pour une même
    #   version ;
    # - en rejeu hors réseau (vrais Cache, réseaux et assembler ; lectures
    #   de 2,9 s, orthophoto en 2,4 s ; médianes de tours alternés), selon
    #   qu'elles cèdent au calcul seul, à toute la construction, ou sans
    #   détecteur : bassin des toitures à démarrer, comme à la première
    #   scène d'un service (quatre tours), calcul en 1,65 s, 1,33 s et
    #   1,33 s, scène en 4,89 s, 4,55 s et 4,54 s, piscines en 14,4 s et
    #   14,6 s ; bassin déjà chaud (cinq tours), scène en 4,57 s, 4,46 s et
    #   4,41 s, piscines en 14,1 s et 15,2 s.
    # Sur l'emprise par défaut, rien ne change : l'orthophoto (une tuile,
    # 1,3 s) arrive quand la scène (1,2 s en rejeu) est déjà écrite ; de
    # bout en bout (huit essais alternés), 1,52 s, 1,62 s et 1,45 s, dans un
    # bruit de 1,2 à 2,5 s.
    #
    # Au plus CEDER_AU_PLUS_S secondes par tuile : un flot de scènes sans
    # pause (plusieurs visiteurs) n'arrête pas tout à fait les détections,
    # dont chaque appel en cours passe alors une tuile par période. La plus
    # longue construction mesurée dans le conteneur, Strasbourg en zone de
    # 1 000 m, dure de 5,3 à 6,7 s (trois essais), Gordes en zone de 1 000 m
    # jusqu'à 6,3 s sous une charge de 82 : 30 s laissent passer une scène,
    # même quatre fois plus lente, sans qu'une inférence ne la retarde.
    # Pendant une panne de la Géoplateforme, une construction qui attend ses
    # reprises (jusqu'à 96 s par requête, geopf) retient les détections des
    # autres points à ce rythme d'une tuile toutes les 30 s par appel.
    CEDER_AU_PLUS_S = 30

    # Une scène se reconstruit à la demande (bouton de la page) au plus une
    # fois par RECONSTRUIRE_APRES_S, comptées depuis son écriture : chaque
    # reconstruction relit les seize sources de la scène, l'orthophoto à
    # 0,2 m des détections et les couches à part, une trentaine de requêtes
    # vers la Géoplateforme, qui limite chaque adresse IP (30 requêtes/s en
    # WFS). Un bouton pressé en boucle n'y gagnerait rien : l'IGN ne publie
    # pas ses mises à jour d'une minute à l'autre.
    RECONSTRUIRE_APRES_S = 600
    # Le dossier d'une scène mise de côté, en attendant sa reconstruction.
    MISE_DE_COTE = ".mise-de-cote"

    # Orthophotos partagées (prelire_vehicules) tenues en mémoire à la fois :
    # 54 Mo chacune en zone de 1 000 m (5 000 × 3 602 px), 6,9 Mo pour
    # l'emprise par défaut. Sans borne, chaque scène demandée pendant qu'une
    # autre se détecte gardait la sienne jusqu'à son tour sur le fil unique,
    # de une à neuf minutes par point pour yolo dans le conteneur. Deux :
    # celle qu'on détecte, et celle du point suivant, lue pendant ce temps
    # (six tuiles en 4,8 s à Gordes en zone de 1 000 m, contre 30 s à 9 min
    # de détection) ; les suivantes sont lues à leur tour, dans l'ordre.
    IMAGES_TENUES = 2

    def __init__(self, dossier, lire_monuments=fetch_monuments, lire_ouvrages=fetch_ouvrages,
                 lire_vehicules=None, lire_panneaux=None, lire_nuage=fetch_nuage):
        """`lire_vehicules` : de `vehicules.lecteur()`, ou une doublure qui a
        la même forme — `mode`, `detecteurs`, `orthophoto(emprise)` -> tableau
        RGB, `piscines(emprise, rgb=None)` et `vehicules(detecteur)` -> une
        lecture `(emprise, rgb=None)` ; `rgb` est l'orthophoto déjà lue
        (prelire_vehicules), None pour que la lecture lise la sienne. Ses
        `sessions` d'inférence, s'il en a, cèdent le processeur aux scènes
        (_qui_cede). None, et les couches des véhicules et des piscines
        n'existent pas.
        `lire_panneaux` : de `panneaux.lecteur()`, (emprise) -> installations ;
        None, et la couche des panneaux n'existe pas."""
        self.dossier = dossier
        os.makedirs(dossier, exist_ok=True)
        self._verrous = {}
        self._verrou_global = threading.Lock()
        # Constructions en cours, par point : en mémoire, comme les verrous —
        # le service tourne en un seul processus (Dockerfile).
        self._avancements = {}
        # Scènes en construction, tous points confondus : au processeur, les
        # inférences attendent qu'il n'y en ait plus (attendre_les_scenes).
        self._constructions = 0
        self._sans_scene = threading.Condition()
        # Lectures lancées en tâche de fond, par couche et par point (Future) ;
        # les lecteurs sont injectables pour les tests, qui n'appellent pas le
        # réseau. Un bassin de fils par source : Overpass peut tenir les siens
        # plus de 100 s, l'IGN n'a pas à attendre derrière lui.
        self.lire_monuments = lire_monuments
        self.lire_ouvrages = lire_ouvrages
        self.lire_vehicules = self._qui_cede(lire_vehicules)
        self.mode_vehicules = lire_vehicules.mode if lire_vehicules else None
        self.lire_panneaux = lire_panneaux
        self.lire_nuage = lire_nuage
        self._lectures = {}
        self._taches = {
            NOM_MONUMENTS: concurrent.futures.ThreadPoolExecutor(
                max_workers=2, thread_name_prefix="overpass"),
            NOM_OUVRAGES: concurrent.futures.ThreadPoolExecutor(
                max_workers=2, thread_name_prefix="ouvrages"),
            # Une lecture SQLite de quelques millisecondes.
            NOM_PANNEAUX: concurrent.futures.ThreadPoolExecutor(
                max_workers=1, thread_name_prefix="panneaux"),
        }
        if lire_vehicules:
            # Un seul fil pour toutes les détections : chacune occupe déjà
            # tous les cœurs. Elles passent dans l'ordre où elles sont
            # lancées — les piscines, puis les détecteurs du rapide au lent —
            # et deux scènes demandées ensemble attendent leur tour.
            detection = concurrent.futures.ThreadPoolExecutor(max_workers=1,
                                                              thread_name_prefix="detection")
            self._taches[nom_piscines(self.mode_vehicules)] = detection
            for detecteur in lire_vehicules.detecteurs:
                self._taches[nom_vehicules(detecteur)] = detection
            # L'orthophoto que les détections d'un point se partagent, lue à
            # part : elle arrive pendant que le fil des détections finit
            # celles d'une autre scène. Deux fils, deux scènes demandées
            # ensemble.
            self._orthophotos = concurrent.futures.ThreadPoolExecutor(
                max_workers=2, thread_name_prefix="orthophoto")
            # Lots de détections (un par appel de prelire_vehicules qui en
            # lance) : leur rang, et combien sont finis. Ils finissent dans
            # l'ordre où ils sont lancés, sur le fil unique des détections ;
            # la lecture de l'orthophoto du lot de rang r attend que
            # r − finis < IMAGES_TENUES.
            self._images = threading.Condition()
            self._lots_lances = 0
            self._lots_finis = 0
        # Les détections, gardées par morceau de terrain plutôt que par
        # point (vue3d/releves.py) : hors du dossier de la version de la
        # scène, qu'elles ne lisent pas. Et, par genre, les relevés que les
        # lots lancés vont faire (prelire_vehicules).
        self.releves = Releves(os.path.join(dossier, "releves"))
        self._releves_en_attente = {}

    def _qui_cede(self, lecteur):
        """Le lecteur des véhicules, celles de ses sessions d'inférence qui
        calculent sur le processeur remplacées par des SessionQuiCede ; tel
        quel s'il n'en a pas (None, doublure des tests). Une copie : celui
        qu'on a reçu ne change pas.

        Une session sur CoreML (hors conteneur, sur un Mac) n'attend pas :
        elle calcule sur le GPU et ne prenait que 8 % au calcul de la scène,
        quand l'attente retardait ses couches de 2 à 5 s en zone de 1 000 m."""
        sessions = getattr(lecteur, "sessions", None)
        if not isinstance(sessions, dict):
            return lecteur
        cedant = copy.copy(lecteur)
        cedant.sessions = {nom: SessionQuiCede(session, self.attendre_les_scenes)
                           if _sur_le_processeur(session) else session
                           for nom, session in sessions.items()}
        return cedant

    def attendre_les_scenes(self):
        """Rend la main quand aucune scène n'est en construction (True), ou
        au bout de CEDER_AU_PLUS_S quoi qu'il en soit (False)."""
        with self._sans_scene:
            return self._sans_scene.wait_for(lambda: not self._constructions,
                                             timeout=self.CEDER_AU_PLUS_S)

    def _construction(self, pas):
        with self._sans_scene:
            self._constructions += pas
            if not self._constructions:
                self._sans_scene.notify_all()

    def _ecrire(self, dossier, nom, octets):
        """Écrit d'un bloc : un fichier temporaire, renommé une fois complet."""
        fd, tmp = tempfile.mkstemp(dir=dossier)
        with os.fdopen(fd, "wb") as f:
            f.write(octets)
        os.replace(tmp, os.path.join(dossier, nom))

    def _dossier_point(self, lat, lon, zone=None):
        # L'emprise par défaut garde le nom de dossier d'avant les zones : son
        # cache reste valable.
        suffixe = f"_z{zone}" if zone else ""
        return os.path.join(self.dossier, f"v{SCENE_VERSION}",
                            f"{lat:.{SCENE_ARRONDI}f}_{lon:.{SCENE_ARRONDI}f}{suffixe}")

    def _verrou(self, cle):
        with self._verrou_global:
            return self._verrous.setdefault(cle, threading.Lock())

    def chemin(self, lat, lon, nom, zone=None):
        return os.path.join(self._dossier_point(lat, lon, zone), nom)

    def present(self, lat, lon, zone=None):
        return all(os.path.exists(self.chemin(lat, lon, n, zone)) for n in (NOM_SCENE, NOM_ORTHO))

    def avancement(self, lat, lon, zone=None):
        """Où en est la scène du point : prête, en construction (à quelle
        étape, depuis combien de secondes), ou pas encore commencée."""
        lat, lon = point_normalise(lat, lon)
        zone = zone_normalisee(zone)
        if self.present(lat, lon, zone):
            return {"etat": "prete"}
        a = self._avancements.get((lat, lon, zone))
        if a is None:
            return {"etat": "attente"}
        return {"etat": "construction", "etape": a["etape"], "total": ETAPES_SCENE,
                "libelle": a["libelle"], "secondes": round(time.monotonic() - a["debut"])}

    def obtenir(self, lat, lon, construire=construire, zone=None):
        """Chemin de la scène du point, construite au besoin."""
        lat, lon = point_normalise(lat, lon)
        zone = zone_normalisee(zone)
        cle = (lat, lon, zone)
        if self.present(*cle):
            return self._dossier_point(*cle)
        with self._verrou(cle):
            if self.present(*cle):              # construite pendant l'attente
                return self._dossier_point(*cle)
            debut = time.monotonic()
            etape = [0]

            def avancer(libelle):
                etape[0] += 1
                # Remplacé d'un bloc : une lecture concurrente ne voit jamais
                # l'étape d'un libellé et le libellé d'une autre.
                self._avancements[cle] = {"etape": etape[0], "libelle": libelle,
                                                 "debut": debut}

            dossier = self._dossier_point(*cle)
            ancienne = dossier + self.MISE_DE_COTE
            self._construction(1)
            try:
                # Sans zone, l'appel d'avant les zones : les constructions
                # injectées par les tests n'ont pas à la connaître.
                options = {"zone": zone} if zone else {}
                scene, mosaique = construire(lat, lon, avancer=avancer, **options)
                os.makedirs(dossier, exist_ok=True)
                # L'orthophoto d'abord, la scène ensuite : `present` teste les
                # deux, une interruption entre les deux laisse une scène
                # absente, pas une scène sans image.
                for nom, octets in ((NOM_ORTHO, mosaique), (NOM_SCENE, scene)):
                    self._ecrire(dossier, nom, octets)
                # Reconstruite : la scène mise de côté (reconstruire) ne sert plus.
                shutil.rmtree(ancienne, ignore_errors=True)
                return dossier
            except BaseException:
                # Une reconstruction qui échoue (l'IGN en panne) rend la scène
                # mise de côté : complète, elle vaut mieux qu'aucune.
                if os.path.isdir(ancienne):
                    shutil.rmtree(dossier, ignore_errors=True)
                    os.replace(ancienne, dossier)
                raise
            finally:
                # Succès ou échec, la construction n'est plus en cours, et les
                # détections reprennent.
                self._construction(-1)
                self._avancements.pop(cle, None)

    def reconstruire(self, lat, lon, zone=None):
        """Met de côté la scène du point et toutes ses couches : la demande
        suivante les reconstruit, d'après les données de l'IGN du moment.
        Si cette reconstruction échoue, la scène mise de côté revient
        (obtenir). Sans scène en cache, rien à faire : la demande suivante la
        construit de toute façon.

        Raises:
            ReconstructionRefusee (429) si la scène a été écrite il y a moins
            de RECONSTRUIRE_APRES_S ; (409) si elle se construit, ou si l'une
            de ses couches est en cours de calcul.
        """
        lat, lon = point_normalise(lat, lon)
        zone = zone_normalisee(zone)
        cle = (lat, lon, zone)
        verrou = self._verrou(cle)
        if not verrou.acquire(blocking=False):
            raise ReconstructionRefusee("la scène est en train de se construire", 409)
        try:
            if not self.present(*cle):
                return
            dossier = self._dossier_point(*cle)
            age = time.time() - os.path.getmtime(os.path.join(dossier, NOM_SCENE))
            if age < self.RECONSTRUIRE_APRES_S:
                attente = math.ceil((self.RECONSTRUIRE_APRES_S - age) / 60)
                raise ReconstructionRefusee(
                    f"la scène a été construite il y a {int(age // 60)} min : elle pourra "
                    f"être reconstruite dans {attente} min", 429)
            # Sous le verrou global : aucune couche ne peut être lancée ni
            # prise par une demande (_prelire, _obtenir_couche) pendant que le
            # dossier change de place.
            with self._verrou_global:
                du_point = [c for c in self._lectures if c[1:] == cle]
                en_cours = [c for c in du_point if not self._lectures[c].done()]
                en_cours += [c for c, v in self._verrous.items()
                             if len(c) == 4 and c[1:] == cle and v.locked()]
                if en_cours:
                    raise ReconstructionRefusee(
                        "des couches de la scène sont en cours de calcul ("
                        f"{', '.join(sorted({c[0] for c in en_cours}))}) : réessayez "
                        "quand elles sont affichées", 409)
                # Lues avant la reconstruction, leurs réponses ne servent plus.
                for c in du_point:
                    self._lectures.pop(c)
                ancienne = dossier + self.MISE_DE_COTE
                shutil.rmtree(ancienne, ignore_errors=True)
                os.replace(dossier, ancienne)
                # Ses relevés aussi (vue3d/releves.py) : les détections se
                # refont sur l'orthophoto du moment. Ils ne reviennent pas si
                # la reconstruction échoue : les couches mises de côté
                # reviennent avec la scène, et un relevé se refait.
                self.releves.oublier(rectangle_releve(*emprise(lat, lon, zone)))
            journal.info("Scène %.4f, %.4f (zone %s) mise de côté, à reconstruire",
                         lat, lon, zone or "par défaut")
        finally:
            verrou.release()

    def _prelire(self, nom, lat, lon, lire, zone=None):
        """Lance en tâche de fond la lecture d'une couche à part, si elle
        n'est ni en cache ni déjà demandée pour ce point."""
        lat, lon = point_normalise(lat, lon)
        zone = zone_normalisee(zone)
        if os.path.exists(self.chemin(lat, lon, nom, zone)):
            return
        with self._verrou_global:
            if (nom, lat, lon, zone) not in self._lectures:
                self._lectures[(nom, lat, lon, zone)] = self._taches[nom].submit(
                    lire, *emprise(lat, lon, zone))

    def _obtenir_couche(self, nom, lat, lon, construire, lire, indisponible, assembler,
                        zone=None):
        """Chemin du dossier où la couche `nom` du point est écrite.

        La couche lit la scène, qui est donc construite d'abord au besoin. La
        réponse de la source est celle de la tâche de fond si elle a été
        lancée, sinon elle est lue ici.

        Args:
            lire: lecture de la source sur une emprise.
            indisponible: exception levée, à partir du message, si la source
                n'a pas répondu — rien n'est alors écrit.
            assembler: (emprise, réponse de la source, scène) -> couche.
        """
        dossier = self.obtenir(lat, lon, construire=construire, zone=zone)
        lat, lon = point_normalise(lat, lon)
        zone = zone_normalisee(zone)
        cle = (nom, lat, lon, zone)
        chemin = os.path.join(dossier, nom)
        if os.path.exists(chemin):
            return dossier
        with self._verrou(cle):
            # Sous le verrou de la couche, que reconstruire respecte : la
            # scène a pu être mise de côté depuis le premier appel, et la
            # couche s'écrit alors à côté de la scène reconstruite.
            dossier = self.obtenir(lat, lon, construire=construire, zone=zone)
            chemin = os.path.join(dossier, nom)
            if os.path.exists(chemin):          # écrite pendant l'attente
                return dossier
            with self._verrou_global:
                tache = self._lectures.pop(cle, None)
            try:
                brut = tache.result() if tache else lire(*emprise(lat, lon, zone))
            except Exception as exc:
                raise indisponible(str(exc)) from exc
            with gzip.open(os.path.join(dossier, NOM_SCENE), "rt", encoding="utf-8") as f:
                scene = json.load(f)
            couche = assembler(emprise(lat, lon, zone), brut, scene)
            self._ecrire(dossier, nom,
                         gzip.compress(json.dumps(couche, separators=(",", ":")).encode(), 6))
            # Une lecture relancée entre-temps (page rechargée) ne sert plus.
            with self._verrou_global:
                self._lectures.pop(cle, None)
            return dossier

    def prelire_monuments(self, lat, lon, zone=None):
        """Lance la lecture d'Overpass en tâche de fond, si la couche OSM du
        point n'est ni en cache ni déjà demandée.

        Appelée à la demande de la scène : Overpass ne dépend pas de l'IGN, sa
        réponse arrive pendant la construction, et la couche est souvent prête
        quand la vue la demande.
        """
        self._prelire(NOM_MONUMENTS, lat, lon, self.lire_monuments, zone)

    def obtenir_monuments(self, lat, lon, construire=construire, zone=None):
        """Chemin du dossier où la couche OSM du point est écrite.

        La couche lit les bâtiments de la scène — les hauteurs de repli des
        parties, les bâtiments qu'elles remplacent.

        Raises:
            MonumentsIndisponibles si Overpass n'a pas répondu : rien n'est
            écrit, la demande suivante réessaie.
        """
        # Parties OSM et bâtiments BD TOPO qu'elles remplacent
        # (vue3d/monuments.py). None si l'emprise n'en a aucune — le cas de
        # presque partout, qui est un fait et se met en cache comme tel.
        return self._obtenir_couche(
            NOM_MONUMENTS, lat, lon, construire, self.lire_monuments,
            lambda message: MonumentsIndisponibles(f"monuments OSM illisibles : {message}"),
            lambda bbox, brut, scene: monuments_pour_emprise(
                *bbox, brut, scene.get("batiments") or {"features": []}), zone=zone)

    def prelire_ouvrages(self, lat, lon, zone=None):
        """Lance la lecture des couches d'ouvrages en tâche de fond : quatre
        petites lectures WFS, finies bien avant la scène."""
        self._prelire(NOM_OUVRAGES, lat, lon, self.lire_ouvrages, zone)

    def obtenir_ouvrages(self, lat, lon, construire=construire, zone=None):
        """Chemin du dossier où la couche des ouvrages du point est écrite.

        La couche lit le relief de la scène (la hauteur d'un mur est
        l'altitude de son sommet moins le relief), ses masses de sursol
        (celles qu'un ouvrage explique) et ses routes (la largeur d'un pont).

        Raises:
            OuvragesIndisponibles si une couche de l'IGN n'a pas répondu :
            rien n'est écrit, la demande suivante réessaie.
        """
        return self._obtenir_couche(
            NOM_OUVRAGES, lat, lon, construire, self.lire_ouvrages,
            lambda message: OuvragesIndisponibles(f"ouvrages illisibles : {message}"),
            lambda bbox, brut, scene: ouvrages_pour_emprise(
                *bbox, brut, scene.get("relief"), scene.get("masses"), scene.get("routes")), zone=zone)

    def obtenir_nuage(self, lat, lon, construire=construire, zone=None):
        """Chemin du dossier où la couche du nuage LiDAR HD du point est écrite.

        Lue à la demande de la vue, une fois la scène affichée, et non en
        tâche de fond avec elle : ses dalles se lisent en 10 à 90 s, une à
        une, et leurs plages tiendraient des places (geopf.place) dont la
        scène a besoin. La couche lit le relief de la scène (la hauteur d'un
        point est son altitude moins le relief), ses bâtiments (les ouvrages
        ajourés), ses masses et ses houppiers (ceux qu'ils expliquent).

        Raises:
            NuageIndisponible si une dalle n'a pas pu être lue : rien n'est
            écrit, la demande suivante réessaie.
        """
        return self._obtenir_couche(
            NOM_NUAGE, lat, lon, construire, self.lire_nuage,
            lambda message: NuageIndisponible(f"nuage LiDAR HD illisible : {message}"),
            lambda bbox, brut, scene: nuage_pour_emprise(
                *bbox, brut, scene.get("relief"), scene.get("batiments"), scene.get("masses"),
                scene.get("houppiers")),
            zone=zone)

    def prelire_panneaux(self, lat, lon, zone=None):
        """Lance la lecture du registre en tâche de fond, si le service en a un."""
        if self.lire_panneaux:
            self._prelire(NOM_PANNEAUX, lat, lon, self.lire_panneaux, zone)

    def obtenir_panneaux(self, lat, lon, construire=construire, zone=None):
        """Chemin du dossier où la couche des panneaux solaires du point est
        écrite. Elle ne lit rien de la scène, mais suit le même chemin.

        Raises:
            PanneauxDesactives si le service tourne sans registre.
            PanneauxIndisponibles si la base n'a pas pu être lue : rien n'est
            écrit, la demande suivante réessaie.
        """
        if not self.lire_panneaux:
            raise PanneauxDesactives("service lancé sans registre des panneaux solaires")
        return self._obtenir_couche(
            NOM_PANNEAUX, lat, lon, construire, self.lire_panneaux,
            lambda message: PanneauxIndisponibles(f"panneaux solaires illisibles : {message}"),
            lambda bbox, brut, scene: panneaux_pour_emprise(*bbox, brut), zone=zone)

    def _detections(self):
        """Les couches de l'orthophoto du service, dans l'ordre où elles se
        détectent : [(fichier de la couche, genre de ses relevés, lecture
        d'une image, clé de ses boîtes, marge de l'image de ses relevés)]."""
        lecteur, mode = self.lire_vehicules, self.mode_vehicules
        return [(nom_piscines(mode), f"piscines-{mode}", lecteur.piscines, "piscines",
                 MARGE_PISCINES_PX)] + [
            (nom_vehicules(d), f"vehicules-{d}", lecteur.vehicules(d), "boites", MARGE_VEHICULES_PX)
            for d in lecteur.detecteurs]

    def _relever(self, genre, lire, cle, marge_px, bbox, images=None):
        """Brut de la couche sur l'emprise, réuni des relevés qui la couvrent
        (vue3d/releves.py) ; ceux qui manquent sont détectés d'abord, sur
        `images` quand elles y sont."""
        return {cle: self.releves.relever(genre, bbox, lire, cle, self.lire_vehicules.detecteurs,
                                          marge_px, centre_dans_l_autre=cle == "piscines",
                                          images=images)}

    def prelire_vehicules(self, lat, lon, zone=None):
        """Lance en tâche de fond les détections sur l'orthophoto à 0,2 m, si
        le service a un détecteur : les piscines d'abord (une demi-seconde),
        puis les véhicules de chaque détecteur, du rapide au lent. Leur
        orthophoto se lit pendant que la scène se construit ; au processeur,
        leurs inférences attendent qu'elle soit écrite (attendre_les_scenes).

        Seul ce que les relevés déjà faits ne couvrent pas est détecté
        (vue3d/releves.py) : rien quand la couche du point se réunit de
        relevés existants, une bande d'un quart de zone après un décalage.
        Les relevés que les lots déjà lancés vont faire sont comptés comme
        faits : un point décalé pendant que le précédent se détecte ne
        refait pas ce que celui-ci est en train de voir.

        Les détections lancées ensemble se partagent une seule lecture de
        chaque orthophoto : sur une zone de 1 000 m, six tuiles de 2 048 px,
        lues trois fois l'une après l'autre avant le partage (11 à 16 s
        chaque fois), une fois ensemble depuis (5 s environ). Si cette
        lecture échoue, chaque détection retente la sienne, comme avant le
        partage : une couche ne tombe pas pour une autre. Les images ainsi
        lues d'avance sont bornées (IMAGES_TENUES)."""
        if not self.lire_vehicules:
            return
        lat, lon = point_normalise(lat, lon)
        zone = zone_normalisee(zone)
        lecteur = self.lire_vehicules
        bbox = emprise(lat, lon, zone)
        besoin = rectangle_releve(*bbox)

        def en_cours(cle):
            """Lancée, ou attendue par une demande qui la tient (verrou de
            _obtenir_couche) : relancée, une détection de yolo serait
            recalculée pour rien, cinq minutes dans le conteneur."""
            verrou = self._verrous.get(cle)
            return cle in self._lectures or (verrou is not None and verrou.locked())

        with self._verrou_global:
            # Le fichier est testé sous le verrou : écrit entre un test fait
            # plus tôt et la prise du verrou, sa tâche déjà retirée, la couche
            # était relancée (reproduit à la contre-vérification : yolo
            # détecté deux fois, une tâche restée pour toujours).
            couches = [c for c in self._detections()
                       if not en_cours((c[0], lat, lon, zone))
                       and not os.path.exists(self.chemin(lat, lon, c[0], zone))]
            if not couches:
                return
            prevus = {genre: self.releves.a_detecter(genre, besoin, marge,
                                                     self._releves_en_attente.get(genre, ()))
                      for _, genre, _, _, marge in couches}
            for genre, rects in prevus.items():
                self._releves_en_attente.setdefault(genre, []).extend(rects)
            # Une image par relevé prévu, partagée par les couches qui le
            # prévoient toutes — le cas ordinaire, leurs relevés étant faits
            # ensemble —, lue à la plus large de leurs marges.
            a_lire = {}
            for _, genre, _, _, marge in couches:
                for r in prevus[genre]:
                    a_lire[r] = max(a_lire.get(r, 0), marge)
            # Rang du lot, pris sous le verrou comme la place de ses tâches
            # dans la file : rangs et file vont dans le même ordre.
            rang, restantes = self._lots_lances, [len(couches)]
            self._lots_lances += 1

            def lire_les_images():
                with self._images:
                    self._images.wait_for(lambda: rang - self._lots_finis < self.IMAGES_TENUES)
                return {r: (marge, lecteur.orthophoto(*emprise_image(r, marge)))
                        for r, marge in a_lire.items()}

            images = self._orthophotos.submit(lire_les_images)

            def sur_les_images(genre, lire, cle, marge):
                try:
                    try:
                        rgb = images.result()
                    except Exception:
                        rgb = None              # chacune la sienne
                    return self._relever(genre, lire, cle, marge, bbox, rgb)
                finally:
                    with self._verrou_global:
                        for r in prevus[genre]:
                            self._releves_en_attente[genre].remove(r)
                    with self._images:
                        restantes[0] -= 1
                        if not restantes[0]:
                            self._lots_finis += 1
                            self._images.notify_all()

            # Les images ne sont tenues que par ces tâches : libérées avec la
            # dernière, qu'on vienne ou non chercher sa couche.
            for nom, genre, lire, cle, marge in couches:
                self._lectures[(nom, lat, lon, zone)] = self._taches[nom].submit(
                    sur_les_images, genre, lire, cle, marge)

    def _detections_si_absente(self, nom, lat, lon, zone):
        """Une couche de l'orthophoto demandée sans tâche lancée — scène
        gardée par le navigateur, servie avant un redémarrage, ou détection
        en échec à refaire : les détections qui manquent au point partent
        toutes ici, sur une seule lecture de l'orthophoto, et les demandes
        suivantes les trouvent. Celle qui a sa tâche ne relance rien."""
        if (nom, *point_normalise(lat, lon), zone_normalisee(zone)) not in self._lectures:
            self.prelire_vehicules(lat, lon, zone)

    def obtenir_piscines(self, lat, lon, construire=construire, zone=None):
        """(dossier, nom du fichier) des piscines du point.

        La couche lit les bâtiments et l'eau de la scène : une « piscine »
        sur un toit ou sur une rivière n'en est pas une.

        Raises:
            VehiculesDesactives si le service tourne sans détecteur.
            VehiculesIndisponibles si l'orthophoto n'a pas pu être lue ou si
            la détection a échoué : rien n'est écrit, la demande suivante
            réessaie.
        """
        if not self.lire_vehicules:
            raise VehiculesDesactives("service lancé sans détecteur de véhicules")
        nom, genre, lire, cle, marge = self._detections()[0]
        self._detections_si_absente(nom, lat, lon, zone)
        return self._obtenir_couche(
            nom, lat, lon, construire, lambda *bbox: self._relever(genre, lire, cle, marge, bbox),
            lambda message: VehiculesIndisponibles(f"piscines illisibles : {message}"),
            lambda bbox, brut, scene: piscines_pour_emprise(
                *bbox, brut, self.mode_vehicules, scene.get("batiments"),
                scene.get("eau")), zone=zone), nom

    def obtenir_vehicules(self, lat, lon, detecteur, construire=construire, zone=None):
        """(dossier, nom du fichier) des véhicules du point vus d'un détecteur.

        Mêmes lectures de la scène et mêmes erreurs que les piscines ;
        VehiculesDesactives aussi si le détecteur n'est pas de ce service.
        """
        if not self.lire_vehicules or detecteur not in self.lire_vehicules.detecteurs:
            raise VehiculesDesactives(f"service lancé sans le détecteur {detecteur!r}")
        nom, genre, lire, cle, marge = next(c for c in self._detections()
                                            if c[0] == nom_vehicules(detecteur))
        self._detections_si_absente(nom, lat, lon, zone)
        return self._obtenir_couche(
            nom, lat, lon, construire, lambda *bbox: self._relever(genre, lire, cle, marge, bbox),
            lambda message: VehiculesIndisponibles(f"véhicules illisibles : {message}"),
            lambda bbox, brut, scene: vehicules_pour_emprise(
                *bbox, brut, detecteur, scene.get("batiments"), scene.get("eau")), zone=zone), nom
