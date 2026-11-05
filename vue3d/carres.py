"""Carrés de la vue en voiture : bâtiments et routes BD TOPO, par 500 m.

La page de la voiture (static/voiture.html) avance sur un monde qui défile :
elle ne peut pas attendre une scène, qui demande 10 à 30 s par kilomètre
carré et que la prod limite à 20 par heure et par visiteur, quand une voiture
à 90 km/h traverse une zone de 1 000 m en 40 s. Elle lit donc des carrés de
la grille Lambert-93, faits des seules couches BD TOPO qui se lisent d'une
requête : 0,14 à 0,20 s par couche sur un carré de 500 m, mesuré le
2026-10-20 à Paris (Opéra), à Gordes et le long de l'A7 à Montélimar, de 46
à 49 Ko compressés pour les bâtiments, de 16 à 29 Ko pour les routes ; les
voies ferrées, lues en même temps, de 0,10 à 0,20 s (le 2026-10-24, aux
mêmes lieux, à Grenelle et à la Part-Dieu). Ni LiDAR, ni MNH, ni
végétation : la page y gagne de quoi charger plusieurs kilomètres devant
elle.

Un carré est la règle des scènes en petit : complet ou absent, jamais
périmé, écrit d'un bloc. Une couche en échec lève CarreIndisponible et rien
n'est écrit.

La végétation est une couche à part (`fetch_vegetation`), lue comme celle
de la scène et pour les mêmes raisons (vue3d/houppiers.py) : le MNH à 0,5 m,
l'orthophoto verte, les bâtiments, les zones de végétation BD TOPO et la BD
Forêt. Plus lourde — 1,1 à 4,6 s de lectures et 0,1 à 0,2 s de découpe par
carré, mesuré le 2026-10-20 à Paris (Opéra), à Gordes et le long de l'A7 —,
elle ne retarde jamais les bâtiments : la page la demande après eux, et
plus près de la route.

Format, JSON gzippé, coordonnées en décimètres depuis le coin sud-ouest du
carré (`origine`, en mètres Lambert-93) :

- `batiments` : ceux dont le premier sommet tombe dans le carré — le WFS rend
  tout ce qui touche l'emprise, et un bâtiment à cheval sur deux carrés
  sortirait deux fois. Chacun : `id` (cleabs), `usage`, `sol`, `gouttiere`,
  `faitage` (altitudes BD TOPO, m), `hauteur`, `etages`, `polygones` (anneaux
  [x0, y0, x1, y1, …], le premier extérieur) ;
- `routes` : tous les tronçons carrossables qui touchent le carré, entiers,
  pour que le graphe de la page se raccorde d'un carré à l'autre (elle les
  dédoublonne par `id`). Chacun : `id`, `nom` (BAN), `numero` (« D56 »),
  `importance` (1 à 6), `nature`, `sol` (-1 tunnel, 0, 1 pont…), `sens`
  (« 2 » double, « + » sens direct, « - » inverse, « » sans objet), `voies`,
  `largeur`, `acces` (null s'il est libre, sinon la valeur BD TOPO : « A
  péage », « Restreint aux ayants droit »…), `fictif` (présent et vrai pour
  un tronçon qui ne fait que raccorder le réseau, à travers une place :
  gardé pour le graphe, pas dessiné), `ligne` [x0, y0, z0, x1, y1, z1, …] (z
  en décimètres d'altitude) ;
- `ponts` : ce qui passe au-dessus du sol sans que la voiture le prenne, et
  qu'elle voit en passant dessous — viaducs ferroviaires, métro aérien,
  passerelles (sentiers, escaliers, pistes cyclables) —, entiers comme les
  routes. Chacun : `id`, `nature` (BD TOPO), `ferre` (vrai pour une voie
  ferrée), `sol`, `largeur` (m : la chaussée, ou 4 m par voie ferrée, comme
  la scène), `ligne`. Leur altitude BD TOPO est celle du tablier, comme pour
  les ponts routiers : de 7 à 13 m au-dessus du terrain sur le métro aérien
  de Grenelle, jusqu'à 99 m à Garabit, 11 m en médiane sur les 26
  passerelles d'un kilomètre du 13e arrondissement.
"""

import gzip
import json
import math
import os
import re
import tempfile
import threading
from datetime import date

import numpy as np
import requests
import shapely
from shapely.geometry import shape

from .couches import (COUCHE_BATIMENTS, COUCHE_FORET, COUCHE_ROUTES, COUCHE_VEGETATION,
                      SRS_LAMBERT93, lire_couche)
from .geopf import LectureAbandonnee, en_parallele
from .houppiers import HOUPPIERS_RESOLUTION_M, houppiers_pour_emprise
from .mnh import dimensions_grille, fetch_mnh_grid
from .ortho import fetch_exg_grid
from .ouvrages import COUCHES as COUCHES_OUVRAGES, LARGEUR_PAR_VOIE_M

# Version du format et de son contenu : le cache ne périme jamais, un carré
# change de dossier avec elle. La page la met dans l'adresse du carré, que le
# navigateur garde une semaine. 2 : `fictif` sur les routes. 3 : `ponts`.
CARRES_VERSION = 3
COUCHE_VOIES_FERREES = COUCHES_OUVRAGES["voies"]
# 500 m : la moitié d'une zone de la page, de quoi charger finement le long
# de la route sans lire tout un kilomètre de part et d'autre. Une réponse de
# 255 à 382 bâtiments aux trois lieux mesurés, loin des 5 000 du plafond WFS.
CARRE_M = 500
# La France métropolitaine en Lambert-93, Corse comprise, en carrés : de
# Brest (x ≈ 145 km) à Menton et la Corse (x ≈ 1 240 km), de Bonifacio
# (y ≈ 6 040 km) à Dunkerque (y ≈ 7 110 km), avec une marge.
CARRES_I = (0, 1_300_000 // CARRE_M)
CARRES_J = (6_000_000 // CARRE_M, 7_200_000 // CARRE_M)
# Carrés neufs par heure et par adresse IP, chaque couche comptée à part
# (bâtiments, arbres, limitations, signalisation), quand le service a un
# quota de scènes (VUE3D_QUOTA). Mesuré en conduite simulée sur l'A7 à
# 130 km/h (outils/essai-voiture.mjs) : 6,3 carrés de bâtiments et ~6
# d'arbres par kilomètre ; les limitations et la signalisation suivent les
# bâtiments, soit ~3 200 carrés par heure ; le double, pour une heure
# d'autoroute sans refus. Un carré déjà lu ne compte pas.
CARRES_PAR_HEURE = 6500
# Ce qu'une voiture ne prend pas : le graphe de la page n'y passerait pas.
# Les galeries marchandes sont des « Route à 1 chaussée » dont l'accès est
# « Physiquement impossible » (Galerie de la Madeleine, Galerie des Champs) :
# la voiture simulée y entrait, sous les immeubles.
NATURES_ECARTEES = ("Sentier", "Escalier", "Piste cyclable")
ACCES_ECARTE = "Physiquement impossible"
ETATS_ECARTES = ("En projet", "En construction")
SENS = {"Double sens": "2", "Sens direct": "+", "Sens inverse": "-"}


# Version de la couche de végétation, dans son propre dossier. 2 : sans les
# houppiers des ponts.
VEGETATION_VERSION = 2
# Marge de lecture autour du carré : un houppier dont le sommet y tombe est
# lu en entier (RAYON_MAX_VEGETATION_M = 9 m, et la fenêtre de lissage).
VEGETATION_MARGE_M = 15
# Côté maximal de la grille : un carré de 500 m et sa marge, à 0,5 m, en
# font 1 070 au plus (convergence des méridiens comprise).
VEGETATION_PIXELS_MAX = 2048
# Débords de toit : un houppier fin (rayon équivalent sous 0,12 fois la
# hauteur) collé à un bâtiment (à moins de 2 m de son emprise) est le bord
# d'un toit que l'emprise BD TOPO ne couvre pas, et que l'orthophoto un peu
# verte a fait classer en végétation. Mesuré sur un carré de Paris (8e) :
# 827 des 1 037 houppiers de 8 m et plus étaient de telles aiguilles, à
# 94 % à moins de 2 m d'un bâtiment (0,1 m en médiane, 13 cellules,
# allongement 2,2), contre 13 % des autres (7,1 m, 132 cellules) ; dans un
# carré boisé de Gordes, 87 sur 1 185, à 2 % seulement près du bâti. Vus
# opaques, de la rue, c'étaient des poteaux verts de 15 m le long des
# façades. La scène les garde, transparents : son cache ne périme pas.
DEBORD_RAPPORT = 0.12
DEBORD_DISTANCE_M = 2.0
# Un pont : son tablier dépasse du sol comme un arbre, et le LiDAR ne voit
# pas ce qui pousse dessous. Tout houppier dont le sommet tombe sur un
# tronçon au-dessus du sol, à sa demi-largeur et PONT_MARGE_M près, en est
# un morceau : 23 houppiers de 6 m en médiane sur les deux tronçons du pont
# qui franchit l'A7 au nord de Montélimar, dessinés en arbres sur le tablier.
PONT_MARGE_M = 3.0
# Largeur d'un pont sans largeur de chaussée : celle d'une route à deux voies.
LARGEUR_PONT_M = 5.5
# Ports des arbres, ceux de la page (PORTS, static/js/scene/vegetation/formes.js),
# dans l'ordre des codes transmis.
PORTS = ("feuillu", "chene_vert", "pin", "conifere", "peuplier", "arbuste")


class CarreIndisponible(Exception):
    """Une couche du carré n'a pas pu être lue : rien n'a été écrit."""


class CarreHorsEmprise(ValueError):
    """Le carré n'est pas en France métropolitaine."""


def verifier_carre(i, j):
    """
    Raises:
        CarreHorsEmprise si le carré (i, j) n'est pas servi.
    """
    if not (CARRES_I[0] <= i < CARRES_I[1] and CARRES_J[0] <= j < CARRES_J[1]):
        raise CarreHorsEmprise(f"Le carré {i}, {j} est hors de France métropolitaine, seule servie.")


# Lambert-93 (RGF93, GRS80), constantes de l'IGN (ALG0019), comme la page et
# vue3d/nuage.py : un sommet de Gordes rendu par le WFS en EPSG:2154 et en
# EPSG:4326 se retrouve au centième de mètre (tests/test_carres.py).
_L93_E, _L93_N, _L93_C = 0.0818191910428158, 0.7256077650532670, 11754255.426096
_L93_XS, _L93_YS, _L93_LON0 = 700000, 12655612.049876, math.radians(3)


def lambert93(lon, lat):
    """(x, y) Lambert-93 d'une longitude et d'une latitude en degrés."""
    phi = math.radians(lat)
    s = math.sin(phi)
    iso = math.log(math.tan(math.pi / 4 + phi / 2) * ((1 - _L93_E * s) / (1 + _L93_E * s)) ** (_L93_E / 2))
    r = _L93_C * math.exp(-_L93_N * iso)
    g = _L93_N * (math.radians(lon) - _L93_LON0)
    return _L93_XS + r * math.sin(g), _L93_YS - r * math.cos(g)


def wgs84(x, y):
    """(lon, lat) en degrés d'un point Lambert-93 : la latitude par point fixe."""
    dx, dy = x - _L93_XS, _L93_YS - y
    r, g = math.hypot(dx, dy), math.atan2(dx, dy)
    iso = -math.log(r / _L93_C) / _L93_N
    phi = 2 * math.atan(math.exp(iso)) - math.pi / 2
    for _ in range(12):
        s = _L93_E * math.sin(phi)
        suivant = 2 * math.atan(((1 + s) / (1 - s)) ** (_L93_E / 2) * math.exp(iso)) - math.pi / 2
        if abs(suivant - phi) < 1e-12:
            phi = suivant
            break
        phi = suivant
    return math.degrees(_L93_LON0 + g / _L93_N), math.degrees(phi)


def emprise_carre(i, j):
    """(ouest, sud, est, nord) du carré, en mètres Lambert-93."""
    return i * CARRE_M, j * CARRE_M, (i + 1) * CARRE_M, (j + 1) * CARRE_M


def _dm(v, origine):
    return round((v - origine) * 10)


def _nombre(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _anneaux(geometrie):
    """Polygones d'un (Multi)Polygon GeoJSON, chacun liste d'anneaux de sommets."""
    if not geometrie:
        return []
    if geometrie.get("type") == "Polygon":
        return [geometrie["coordinates"]]
    if geometrie.get("type") == "MultiPolygon":
        return geometrie["coordinates"]
    return []


def batiments_du_carre(geojson, i, j):
    """Les bâtiments du carré, au format compact (voir le module)."""
    x0, y0, x1, y1 = emprise_carre(i, j)
    sortie = []
    for f in geojson.get("features", []):
        p = f.get("properties") or {}
        if p.get("etat_de_l_objet") in ETATS_ECARTES:
            continue
        polygones = [[a for a in poly if len(a) >= 4] for poly in _anneaux(f.get("geometry"))]
        polygones = [poly for poly in polygones if poly]
        if not polygones:
            continue
        premier = polygones[0][0][0]
        if not (x0 <= premier[0] < x1 and y0 <= premier[1] < y1):
            continue
        sortie.append({
            "id": p.get("cleabs"),
            "usage": p.get("usage_1"),
            "sol": _nombre(p.get("altitude_minimale_sol")),
            "gouttiere": _nombre(p.get("altitude_minimale_toit")),
            "faitage": _nombre(p.get("altitude_maximale_toit")),
            "hauteur": _nombre(p.get("hauteur")),
            "etages": _nombre(p.get("nombre_d_etages")),
            "polygones": [[[c for s in anneau for c in (_dm(s[0], x0), _dm(s[1], y0))]
                           for anneau in poly] for poly in polygones],
        })
    return sortie


def _ligne(coordonnees, x0, y0):
    """[x0, y0, z0, …] en décimètres depuis (x0, y0), z en décimètres d'altitude ou None."""
    ligne = []
    for s in coordonnees:
        z = s[2] if len(s) > 2 and _nombre(s[2]) is not None and s[2] > -1000 else None
        ligne += [_dm(s[0], x0), _dm(s[1], y0), None if z is None else round(z * 10)]
    return ligne


def _niveau(p):
    """La position par rapport au sol d'un tronçon BD TOPO (0 si elle manque)."""
    v = p.get("position_par_rapport_au_sol")
    return int(v) if str(v).lstrip("-").isdigit() else 0


def _lineaire(f):
    g = f.get("geometry") or {}
    return g.get("type") == "LineString" and len(g.get("coordinates") or []) >= 2


def routes_du_carre(geojson, i, j):
    """Les tronçons carrossables qui touchent le carré, au format compact."""
    x0, y0, _, _ = emprise_carre(i, j)
    sortie = []
    for f in geojson.get("features", []):
        p = f.get("properties") or {}
        if (p.get("etat_de_l_objet") in ETATS_ECARTES or p.get("nature") in NATURES_ECARTEES
                or p.get("acces_vehicule_leger") == ACCES_ECARTE or not _lineaire(f)):
            continue
        ligne = _ligne(f["geometry"]["coordinates"], x0, y0)
        importance = p.get("importance")
        route = {
            "id": p.get("cleabs"),
            "nom": p.get("nom_voie_ban_gauche") or p.get("nom_voie_ban_droite")
                   or p.get("nom_collaboratif_gauche") or p.get("nom_collaboratif_droite"),
            "numero": p.get("cpx_numero"),
            "importance": int(importance) if str(importance).isdigit() else 6,
            "nature": p.get("nature"),
            "sol": _niveau(p),
            "sens": SENS.get(p.get("sens_de_circulation"), ""),
            "voies": _nombre(p.get("nombre_de_voies")),
            "largeur": _nombre(p.get("largeur_de_chaussee")),
            "acces": None if p.get("acces_vehicule_leger") in (None, "Libre") else p["acces_vehicule_leger"],
            "ligne": ligne,
        }
        if p.get("fictif"):
            route["fictif"] = True
        sortie.append(route)
    return sortie


def ponts_du_carre(voies, routes, i, j):
    """Les voies ferrées et les passerelles au-dessus du sol qui touchent le
    carré, entières, au format compact (voir le module)."""
    x0, y0, _, _ = emprise_carre(i, j)
    sortie = []
    for geojson, ferre in ((voies, True), (routes, False)):
        for f in geojson.get("features", []):
            p = f.get("properties") or {}
            if (p.get("etat_de_l_objet") in ETATS_ECARTES or _niveau(p) <= 0 or not _lineaire(f)
                    or (not ferre and p.get("nature") not in NATURES_ECARTEES)):
                continue
            if ferre:
                largeur = (_nombre(p.get("nombre_de_voies")) or 1) * LARGEUR_PAR_VOIE_M.get(p.get("largeur"), 4.0)
            else:
                largeur = _nombre(p.get("largeur_de_chaussee"))
            sortie.append({"id": p.get("cleabs"), "nature": p.get("nature"), "ferre": ferre, "sol": _niveau(p),
                           "largeur": largeur, "ligne": _ligne(f["geometry"]["coordinates"], x0, y0)})
    return sortie


def fetch_carre(i, j):
    """Le carré (i, j), lu à la Géoplateforme : bâtiments, routes et voies
    ferrées ensemble.

    Raises:
        CarreIndisponible si l'une des trois couches n'a pas pu être lue.
    """
    emprise = emprise_carre(i, j)
    try:
        batiments, routes, voies = en_parallele(
            lambda: lire_couche(COUCHE_BATIMENTS, *emprise, srs=SRS_LAMBERT93),
            lambda: lire_couche(COUCHE_ROUTES, *emprise, srs=SRS_LAMBERT93),
            lambda: lire_couche(COUCHE_VOIES_FERREES, *emprise, srs=SRS_LAMBERT93))
    except (requests.RequestException, LectureAbandonnee) as exc:
        raise CarreIndisponible(str(exc)) from exc
    return {
        "version": CARRES_VERSION, "carre": [i, j], "taille": CARRE_M,
        "origine": [emprise[0], emprise[1]], "lu": date.today().isoformat(),
        "batiments": batiments_du_carre(batiments, i, j),
        "routes": routes_du_carre(routes, i, j),
        "ponts": ponts_du_carre(voies, routes, i, j),
    }


def port(houppier):
    """Le port d'un arbre, comme portDe de la page : l'essence BD Forêt v2,
    puis la nature BD TOPO, puis le profil mesuré (portMesure)."""
    e = (houppier.get("essence") or "").lower()
    n = (houppier.get("nature") or "").lower()
    # « Sapin, épicéa » contient « pin » : le mot seul. Le chêne vert est
    # « Chênes sempervirents » dans la BD Forêt v2.
    if re.search(r"\bpins?\b", e):
        return "pin"
    if re.search("sapin|épicéa|epicea|douglas|mélèze|meleze", e):
        return "conifere"
    if re.search("vert|sempervirent", e):
        return "chene_vert"
    if "peuplier" in e:
        return "peuplier"
    if re.search("chêne|chene|hêtre|hetre|châtaignier|chataignier|robinier|feuillu", e):
        return "feuillu"
    if "conif" in e or re.search("conif|sineux", n):
        return "conifere"
    if re.search("verger|vigne|lande|haie", n):
        return "arbuste"
    p = houppier.get("profil") or []
    if len(p) < 4:
        return "feuillu"
    if p[3] >= 0.85:
        return "pin"
    if p[1] <= 0.75:
        return "conifere"
    return "feuillu"


def debords_de_toit(houppiers, batiments):
    """Indices des houppiers qui sont des bords de toit (DEBORD_RAPPORT,
    DEBORD_DISTANCE_M) ; `batiments` en GeoJSON WGS84."""
    fins = [k for k, h in enumerate(houppiers) if h["r"] < DEBORD_RAPPORT * h["h"]]
    geoms = []
    for f in (batiments or {}).get("features", []):
        try:
            geoms.append(shape(f["geometry"]))
        except Exception:
            continue
    if not fins or not geoms:
        return set()
    # En mètres autour du premier sommet : la distance est celle du sol.
    lat0 = houppiers[fins[0]]["lat"]
    echelle = np.array([111320 * math.cos(math.radians(lat0)), 111320])
    en_metres = lambda c: c * echelle
    bati = shapely.transform(np.array(geoms, dtype=object), en_metres)
    points = shapely.transform(shapely.points([[houppiers[k]["lon"], houppiers[k]["lat"]] for k in fins]),
                               en_metres)
    proches, _ = shapely.STRtree(bati).query(points, predicate="dwithin", distance=DEBORD_DISTANCE_M)
    return {fins[k] for k in proches.tolist()}


def sur_un_pont(houppiers, routes):
    """Indices des houppiers posés sur un pont (PONT_MARGE_M) ; `routes` en
    GeoJSON WGS84 de la BD TOPO."""
    if not houppiers:
        return set()
    echelle = np.array([111320 * math.cos(math.radians(houppiers[0]["lat"])), 111320])
    en_metres = lambda c: c * echelle
    ponts = []
    for f in (routes or {}).get("features", []):
        p = f.get("properties") or {}
        try:
            if int(p.get("position_par_rapport_au_sol")) < 1:
                continue
            largeur = p.get("largeur_de_chaussee") or LARGEUR_PONT_M
            ponts.append(shapely.transform(shape(f["geometry"]), en_metres).buffer(largeur / 2 + PONT_MARGE_M))
        except (TypeError, ValueError, KeyError):
            continue
    if not ponts:
        return set()
    points = shapely.transform(shapely.points([[h["lon"], h["lat"]] for h in houppiers]), en_metres)
    dedans, _ = shapely.STRtree(ponts).query(points, predicate="within")
    return set(dedans.tolist())


def arbres_du_carre(houppiers, i, j, batiments=None, routes=None):
    """Les houppiers dont le sommet tombe dans le carré : [x, y, h, r, port],
    x et y en décimètres depuis son coin sud-ouest, h et r en décimètres, port
    un indice de PORTS. Les masses de sursol (murs, véhicules) n'en sont pas,
    ni les bords de toit (debords_de_toit), quand `batiments` est donné, ni
    les morceaux de pont (sur_un_pont), quand `routes` l'est."""
    x0, y0, x1, y1 = emprise_carre(i, j)
    debords = debords_de_toit(houppiers, batiments) | sur_un_pont(houppiers, routes)
    sortie = []
    for k, h in enumerate(houppiers):
        if k in debords:
            continue
        x, y = lambert93(h["lon"], h["lat"])
        if not (x0 <= x < x1 and y0 <= y < y1):
            continue
        sortie.append([round((x - x0) * 10), round((y - y0) * 10), round(h["h"] * 10),
                       round(h["r"] * 10), PORTS.index(port(h))])
    return sortie


def fetch_vegetation(i, j):
    """Les arbres du carré (i, j), découpés comme ceux de la scène.

    Raises:
        CarreIndisponible si une lecture a échoué : rien n'est écrit.
    """
    verifier_carre(i, j)
    x0, y0, x1, y1 = emprise_carre(i, j)
    m = VEGETATION_MARGE_M
    coins = [wgs84(x, y) for x in (x0 - m, x1 + m) for y in (y0 - m, y1 + m)]
    w, s = min(c[0] for c in coins), min(c[1] for c in coins)
    e, n = max(c[0] for c in coins), max(c[1] for c in coins)
    largeur, hauteur = dimensions_grille(w, s, e, n, HOUPPIERS_RESOLUTION_M, VEGETATION_PIXELS_MAX)
    try:
        grille, exg, batiments, zones, forets, routes = en_parallele(
            lambda: fetch_mnh_grid(w, s, e, n, resolution_m=HOUPPIERS_RESOLUTION_M,
                                   max_pixels=VEGETATION_PIXELS_MAX),
            lambda: fetch_exg_grid(w, s, e, n, largeur, hauteur),
            lambda: lire_couche(COUCHE_BATIMENTS, w, s, e, n),
            lambda: lire_couche(COUCHE_VEGETATION, w, s, e, n),
            lambda: lire_couche(COUCHE_FORET, w, s, e, n),
            lambda: lire_couche(COUCHE_ROUTES, w, s, e, n))
    except (requests.RequestException, LectureAbandonnee, ValueError) as exc:
        raise CarreIndisponible(str(exc)) from exc
    houppiers = houppiers_pour_emprise(w, s, e, n, batiments, zones, forets, grille, exg)
    return {
        "version": VEGETATION_VERSION, "carre": [i, j], "taille": CARRE_M,
        "origine": [x0, y0], "lu": date.today().isoformat(),
        # lidar_hd : hauteurs mesurées ; mns_mnt : estimées par
        # photogrammétrie ; null : ni l'un ni l'autre ici.
        "source": houppiers["source"], "couvert": houppiers["couvert"], "ports": list(PORTS),
        "arbres": arbres_du_carre(houppiers["houppiers"], i, j, batiments, routes),
    }


class Carres:
    """Les carrés lus, sur disque : `dossier`/carres/<couche>v<version>/<i>/<j>.json.gz.

    Hors du dossier des versions de scène : un carré ne dépend pas de
    SCENE_VERSION. `lire` : (i, j) -> dict, injectable pour les tests ;
    `couche` : préfixe du dossier, vide pour les bâtiments et les routes
    (`carres/v1`), « vegetation- » pour les arbres.
    """

    def __init__(self, dossier, lire=fetch_carre, couche="", version=CARRES_VERSION):
        self.dossier = os.path.join(dossier, "carres", f"{couche}v{version}")
        self.lire = lire
        self._verrous = {}
        self._verrou_global = threading.Lock()

    def chemin(self, i, j):
        return os.path.join(self.dossier, str(i), f"{j}.json.gz")

    def present(self, i, j):
        return os.path.exists(self.chemin(i, j))

    def _verrou(self, cle):
        with self._verrou_global:
            return self._verrous.setdefault(cle, threading.Lock())

    def obtenir(self, i, j):
        """Le chemin du carré, lu au besoin ; deux demandes du même carré
        n'en font qu'une lecture.

        Raises:
            CarreHorsEmprise, CarreIndisponible.
        """
        verifier_carre(i, j)
        chemin = self.chemin(i, j)
        if os.path.exists(chemin):
            return chemin
        with self._verrou((i, j)):
            if os.path.exists(chemin):
                return chemin
            carre = self.lire(i, j)
            octets = gzip.compress(json.dumps(carre, ensure_ascii=False,
                                              separators=(",", ":")).encode())
            os.makedirs(os.path.dirname(chemin), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(chemin))
            with os.fdopen(fd, "wb") as f:
                f.write(octets)
            os.replace(tmp, chemin)
        return chemin
