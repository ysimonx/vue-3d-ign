"""Nuage de points LiDAR HD de l'IGN : le bâti en points, et les ouvrages
ajourés tels qu'ils sont mesurés.

Une couche à part de la scène, comme les ouvrages (vue3d/ouvrages.py) : la vue
la demande une fois la scène affichée, elle a sa version (NUAGE_VERSION) et
son fichier de cache, écrit entier ou pas du tout.

**Pourquoi le nuage.** Le MNH, dont la scène tire ses toits et ses houppiers,
ne garde du LiDAR que le dessus de chaque demi-mètre. Une structure ajourée
n'y a ni dessous ni vide : la tour Eiffel y est un empilement de dalles
pleines que la BD TOPO extrude en cubes de 99 m de côté, et le MNH la perd au-
dessus de 199 m. Le nuage, lui, la voit des arches à l'antenne : 212 000
points « bâtiment » jusqu'à 292 m, l'antenne en « sursol pérenne » jusqu'à
321 m.

**Ce que la couche transmet.** Les points du bâti — bâtiments, tabliers de
pont, sursol pérenne, divers bâtis (CLASSES_BATI) —, pas le sol ni la
végétation, que la scène dessine déjà. Chacun à sa hauteur au-dessus du
relief RGE ALTI de la scène, que la vue lit pareil : posé sur le relief, il
retombe à son altitude, et suit l'exagération comme les bâtiments.

**Ouvrages ajourés.** Un bâtiment dont le LiDAR voit le sol sous une
structure, à travers l'emprise, n'est pas un volume plein : la vue dessine ses points à sa place,
et retire les masses de sursol qu'ils expliquent (comme les ouvrages).

**Lecture.** Chaque dalle de 1 km² est un fichier COPC : un octree LAZ dont on
ne lit, par plages d'octets, que les nœuds de l'emprise. Les plages passent
par geopf (place, reprise) comme toute requête vers la Géoplateforme : laspy
ne fait aucune requête lui-même. Lues une à une : en 40 à la fois, le défaut
de laspy, la Géoplateforme répond 429.

**En deux temps.** Sur une grande zone, la page demande d'abord un carré
autour du point (NUAGE_PROCHE_COTE_M), sa propre couche, puis la zone entière,
qui le remplace et reste la couche d'avant, au bit près. Au-delà d'une zone de
NUAGE_COTE_MAX_M, la seconde lecture n'en couvre que le carré central.
"""

import base64
import contextlib
import io
import logging
import math
import threading

import laspy
import numpy as np
import requests
import shapely
from laspy.copc import Bounds
from shapely.geometry import Polygon, shape

from .couches import lire_couche
from .geopf import en_parallele, get_avec_reprise, place

journal = logging.getLogger(__name__)

# Format de la couche. L'incrémenter ne refait que la couche, pas les scènes.
# 2 : la raison de chaque ouvrage ajouré (ajoures_detail), que la fiche dit.
# 3 : le sol vu sous une structure, et non plus le sol vu seul — une cour à
#     ciel ouvert n'est plus un ouvrage ajouré.
NUAGE_VERSION = 3

COUCHE_DALLES = "IGNF_LIDAR-HD_METADONNEE:metadata"
CLASSE_SOL = 2
# Bâtiment, tablier de pont, sursol pérenne, divers bâtis.
CLASSES_BATI = (6, 17, 64, 67)

# Octets lus par requête au moins. Les nœuds de l'octree sont gros (700 Ko en
# moyenne) : à la tour Eiffel, 30 requêtes et 20,9 Mo par blocs de 64 Ko, 28
# et 21,8 Mo par 256 Ko, 24 et 30,9 Mo par 1 Mo — le bloc ne réduit plus les
# requêtes, il lit pour rien. Mesure : python outils/mesure_nuage.py --blocs
BLOC_OCTETS = 256 * 1024

# Ouvrages ajourés. Une emprise est jugée sur une grille de 1 m, réduite de
# EROSION_M sur son pourtour : la BD TOPO annonce 2,5 m de précision
# planimétrique, et le sol vu le long d'un mur n'est pas sous le bâtiment.
#
# Ce qui la dit ajourée : le LiDAR y voit le sol SOUS une structure — sol et
# structure dans la même cellule — sur PART_SOL_SOUS_STRUCTURE de l'emprise.
# Le sol vu seul ne suffisait pas : une cour à ciel ouvert, qu'une seule
# emprise BD TOPO couvre avec ses ailes, le montre autant qu'un treillis
# (signalé à Châlons-en-Champagne, un immeuble de 95 logements dessiné en
# points). Sur 1 009 emprises autour de quinze lieux :
#
#                                          sol vu   sous une structure
#   tour Eiffel, trois étages             32-83 %        32-83 %
#   Grand Palais, nef et coupole          32, 99 %       32, 99 %
#   Canopée des Halles                      58 %           53 %
#   Grande Arche de La Défense              44 %           28 %
#   Châtelet, cour sous verrière            32 %           26 %
#   Arc de Triomphe, sous ses arches        25 %           25 %
#   verrière de Saint-Lazare                36 %           21 %
#   Châlons, ailes autour d'une cour        33 %            8 %
#   Châtelet, Bordeaux : cours ouvertes   42, 28 %       12, 5 %
#
# Au-delà de 20 %, plus que des ouvrages ajourés ; en deçà, le plus haut des
# bâtiments ordinaires est à 16 % (Bordeaux, Châtelet, La Défense). Un
# bâtiment plus récent que le relevé LiDAR, qui n'y voit que le sol d'avant
# (créés fin 2025, sol vu à 93 à 100 %), n'y a pas de structure : 0 à 2 %.
#
# L'emprise érodée doit garder CELLULES_MIN m². Les derniers faux positifs
# passaient 20 % sur 20 à 44 m² — ce qui reste d'une petite emprise après
# l'érosion, qu'un décalage de la BD TOPO fait déborder sur la rue. Le plus
# petit vrai, le sommet de la tour Eiffel, en garde 66.
#
# Le deuxième étage de la tour, sous le premier, ne voit le sol qu'à 10 % :
# il est ajouré parce qu'il chevauche un ouvrage ajouré (ajoures).
PAS_SOL_VU_M = 1.0
EROSION_M = 2.0
CELLULES_MIN = 50
PART_SOL_SOUS_STRUCTURE = 0.2
# Autour d'un ouvrage ajouré, ses points lui sont rattachés : la précision de
# l'emprise, arrondie.
MARGE_AJOURE_M = 3.0

# Hors des ouvrages ajourés, le bâti est allégé : un point par voxel de
# VOXEL_M, puis des voxels plus grands tant qu'il en reste plus de
# POINTS_HORS_AJOURES. Sur l'emprise par défaut, 250 000 à 890 000 points du
# bâti en pleine densité (16 points/m² au sol) ; un voxel de 0,5 m en garde 9
# à 400 000 — 3,2 à 5,9 Mo en base64, la tour Eiffel comprise ; en zone de
# 1 000 m à Gordes, 1,6 million, et 480 000 au voxel de 0,5 m (7 Mo).
VOXEL_M = 0.5
POINTS_HORS_AJOURES = 250_000

# Lecture en deux temps : d'abord un carré de NUAGE_PROCHE_COTE_M autour du
# point, affiché dès qu'il est lu, puis la zone entière, qui le remplace. Pas
# en deçà d'une zone de NUAGE_PROCHE_ZONE_MIN_M : le carré en couvrirait
# l'essentiel, et la zone entière le relirait pour presque rien.
#
# En zone de 1 000 m, Mo lus (secondes, très variables d'une lecture à
# l'autre) — python outils/mesure_nuage.py --zone 1000 --proche 300,400,500 :
#
#                   carré de 300 m   400 m          500 m          zone entière
#   Gordes          33,7 (13 s)      44,0 (42 s)    71,2 (74 s)    158,8 (48 s)
#   tour Eiffel     25,3 (18 s)      27,2 (10 s)    45,0 (18 s)    106,9 (29 s)
#   Strasbourg      12,4 (8 s)       24,9 (8 s)     41,7 (33 s)    (429)
#
# Les niveaux hauts de l'octree se lisent quelle que soit la boîte : 300 m ne
# coûte guère moins que 400, qui montre bien plus. 400 m, c'est le quart des
# octets de la zone entière, que la seconde lecture relit.
NUAGE_PROCHE_COTE_M = 400
NUAGE_PROCHE_ZONE_MIN_M = 800
# Au-delà d'une zone de NUAGE_COTE_MAX_M, la seconde lecture ne couvre que le
# carré central de ce côté. Mesuré le 2026-10-16 à Gordes : en zone de
# 1 000 m, 4 dalles, 159 Mo lus en 68 s et 2,7 Go de mémoire au pic ; en
# zone de 2 000 m, la Géoplateforme répond 429 en 7 s, à deux reprises, et
# quatre fois les points en demanderaient une dizaine de Go.
NUAGE_COTE_MAX_M = 1000
# Fils du service qui peuvent lire un nuage à la fois, carrés proches et
# zones entières réunis. Le service n'en a que huit, et un nuage neuf en tient
# un de 10 s à plusieurs minutes. Le 10 novembre 2026, de 8 h 21 à 8 h 25,
# quatre nuages, trois piscines et des véhicules les tenaient tous, et les
# tuiles attendaient derrière eux jusqu'à 9,5 s. Sur le journal de production
# du 15 octobre au 10 novembre 2026 (1 670 lectures du nuage de plus d'une
# demi-seconde), il y en avait trois au plus 97,8 % du temps où un nuage se
# lisait ; cette borne en aurait refusé 27, que la page redemande 30 s plus
# tard, et ôté 655 des 2 453 s à huit fils pleins (sans compter ces reprises).
# Deux en auraient refusé 110.
NUAGE_ATTENTES = 3
_attentes_nuage = threading.BoundedSemaphore(NUAGE_ATTENTES)

# Lambert-93 (RGF93, ellipsoïde GRS80), constantes de l'IGN (ALG0019) :
# excentricité, exposant, constante et pôle de la projection, méridien 3° E.
_E = 0.0818191910428158
_N = 0.7256077650532670
_C = 11754255.426096
_XS = 700000.0
_YS = 12655612.049876
_LON0 = math.radians(3.0)


def vers_lambert93(lon, lat):
    """(x, y) Lambert-93 de longitudes et latitudes en degrés."""
    lon = np.radians(np.asarray(lon, dtype=np.float64))
    lat = np.radians(np.asarray(lat, dtype=np.float64))
    s = np.sin(lat)
    iso = np.log(np.tan(np.pi / 4 + lat / 2) * ((1 - _E * s) / (1 + _E * s)) ** (_E / 2))
    r = _C * np.exp(-_N * iso)
    g = _N * (lon - _LON0)
    return _XS + r * np.sin(g), _YS - r * np.cos(g)


def depuis_lambert93(x, y):
    """(lon, lat) en degrés de coordonnées Lambert-93. La latitude se tire de
    la latitude isométrique par point fixe : dix itérations la fixent au
    millième de millimètre (le pas se divise par 150 à chacune)."""
    dx = np.asarray(x, dtype=np.float64) - _XS
    dy = np.asarray(y, dtype=np.float64) - _YS
    r = np.hypot(dx, dy)
    lon = _LON0 + np.arctan(dx / -dy) / _N
    iso = -np.log(r / _C) / _N
    lat = 2 * np.arctan(np.exp(iso)) - np.pi / 2
    for _ in range(10):
        s = np.sin(lat)
        lat = 2 * np.arctan(((1 + _E * s) / (1 - _E * s)) ** (_E / 2) * np.exp(iso)) - np.pi / 2
    return np.degrees(lon), np.degrees(lat)


@contextlib.contextmanager
def attente_nuage(indisponible):
    """Une des NUAGE_ATTENTES places, le temps qu'un fil du service lit un
    nuage, verrou de sa couche compris : à prendre avant lui, comme
    monuments.attente_overpass, ou la file se reformerait derrière le verrou
    d'un même point.

    Raises:
        `indisponible`(message) sans attendre si toutes sont prises : rien
        n'est écrit, la page réessaie.
    """
    if not _attentes_nuage.acquire(blocking=False):
        raise indisponible(f"{NUAGE_ATTENTES} nuages sont déjà en lecture")
    try:
        yield
    finally:
        _attentes_nuage.release()


def lire_plage(url, debut, fin):
    """Octets `debut` à `fin` inclus d'un fichier de la Géoplateforme, et sa
    taille totale.

    Raises:
        requests.RequestException si le service ne répond pas, ou rend autre
        chose que la plage demandée — le fichier entier, 105 Mo pour une
        dalle, n'est jamais lu par mégarde.
    """
    with place():
        reponse = get_avec_reprise(url, timeout=60, headers={"Range": f"bytes={debut}-{fin}"})
    plage = reponse.headers.get("Content-Range", "")
    if reponse.status_code != 206 or "/" not in plage:
        raise requests.RequestException(f"plage {debut}-{fin} refusée sur {url[-60:]}")
    total = int(plage.rsplit("/", 1)[1])
    if len(reponse.content) != min(fin, total - 1) - debut + 1:
        raise requests.RequestException(f"plage {debut}-{fin} incomplète sur {url[-60:]}")
    return reponse.content, total


class LecteurPlages(io.RawIOBase):
    """Fichier distant lu par plages, pour laspy : chaque lecture hors du bloc
    en mémoire en demande un nouveau, d'au moins `bloc` octets.

    `requetes` et `octets` comptent ce qui a été lu, pour la mesure."""

    def __init__(self, url, bloc=None, lire=lire_plage):
        super().__init__()
        self.url, self.bloc, self._lire = url, bloc or BLOC_OCTETS, lire
        self.requetes = self.octets = 0
        self._pos = 0
        self._debut, self._donnees = 0, b""
        self.taille = None
        self._charger(0, 1)

    def _charger(self, debut, fin):
        """Lit au moins [debut, fin[ dans le bloc en mémoire."""
        haut = max(fin, debut + self.bloc)
        if self.taille is not None:
            haut = min(haut, self.taille)
        donnees, total = self._lire(self.url, debut, haut - 1)
        self.requetes += 1
        self.octets += len(donnees)
        self.taille = total
        self._debut, self._donnees = debut, donnees

    def readable(self):
        return True

    def seekable(self):
        return True

    def tell(self):
        return self._pos

    def seek(self, decalage, depuis=io.SEEK_SET):
        if depuis == io.SEEK_SET:
            self._pos = decalage
        elif depuis == io.SEEK_CUR:
            self._pos += decalage
        else:
            self._pos = self.taille + decalage
        return self._pos

    def readinto(self, tampon):
        fin = min(self._pos + len(tampon), self.taille)
        if fin <= self._pos:
            return 0
        if not (self._debut <= self._pos and fin <= self._debut + len(self._donnees)):
            self._charger(self._pos, fin)
        k = self._pos - self._debut
        morceau = self._donnees[k:k + fin - self._pos]
        tampon[:len(morceau)] = morceau
        self._pos += len(morceau)
        return len(morceau)


def lire_points(url, x0, y0, x1, y1, lire=lire_plage):
    """Points d'une dalle COPC dans la boîte Lambert-93 [x0, x1] × [y0, y1] :
    (x, y, z, classe), et le lecteur, pour ses comptes."""
    lecteur = LecteurPlages(url, lire=lire)
    with laspy.CopcReader(lecteur) as copc:
        pts = copc.query(bounds=Bounds(mins=np.array([x0, y0, -1e4]), maxs=np.array([x1, y1, 1e4])))
    x, y = np.asarray(pts.x), np.asarray(pts.y)
    dans = (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1)
    return (x[dans], y[dans], np.asarray(pts.z)[dans],
            np.asarray(pts.classification, dtype=np.uint8)[dans]), lecteur


def boite_proche(x0, y0, x1, y1, cote_m):
    """Carré de `cote_m` au centre de la boîte Lambert-93 [x0, x1] × [y0, y1],
    coupé à elle, ses bornes à des mailles entières de la grille du sol vu
    tracée depuis (x0, y0) : ses mailles sont celles de la boîte entière, et un
    bâtiment qu'il contient y est jugé ajouré ou non comme dans la zone entière."""
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    n = math.ceil(cote_m / PAS_SOL_VU_M)
    i = math.floor((cx - cote_m / 2 - x0) / PAS_SOL_VU_M)
    j = math.floor((cy - cote_m / 2 - y0) / PAS_SOL_VU_M)
    px0, py0 = x0 + max(i, 0) * PAS_SOL_VU_M, y0 + max(j, 0) * PAS_SOL_VU_M
    return px0, py0, min(x0 + (i + n) * PAS_SOL_VU_M, x1), min(y0 + (j + n) * PAS_SOL_VU_M, y1)


def interieur_degres(x0, y0, x1, y1):
    """(ouest, sud, est, nord) en degrés contenus dans la boîte Lambert-93 :
    ses côtés ne suivent pas tout à fait les méridiens, et la page n'y vérifie
    que les toits dont elle a tous les points."""
    lon, lat = depuis_lambert93([x0, x1, x1, x0], [y0, y0, y1, y1])
    return [float(max(lon[0], lon[3])), float(max(lat[0], lat[1])),
            float(min(lon[1], lon[2])), float(min(lat[2], lat[3]))]


def fetch_nuage(west, south, east, north, lire=lire_plage, proche_m=None, cote_max_m=None):
    """Points du bâti et sol vu du LiDAR HD sur l'emprise, ou None si aucune
    dalle ne la couvre — un fait, mis en cache comme tel.

    Args:
        proche_m: lire seulement le carré de ce côté au centre de l'emprise
            (boite_proche), la première des deux lectures de la page.
        cote_max_m: de même, pour la seconde lecture d'une zone de plus de
            NUAGE_COTE_MAX_M.

    Returns:
        dict(x, y, z, classe) des points du bâti, en Lambert-93, et grilles :
        dict(x0, y0, pas, sol, bati) — vrai là où une cellule a un point de
        sol, de bâti. Avec proche_m, proche : la boîte lue, (x0, y0, x1, y1) ;
        avec cote_max_m, boite.

    Raises:
        requests.RequestException si une dalle ou leur liste n'a pu être lue.
    """
    xs, ys = vers_lambert93([west, east, east, west], [south, south, north, north])
    x0, x1, y0, y1 = float(min(xs)), float(max(xs)), float(min(ys)), float(max(ys))
    if proche_m or cote_max_m:
        x0, y0, x1, y1 = boite_proche(x0, y0, x1, y1, proche_m or cote_max_m)
        lon, lat = depuis_lambert93([x0, x1, x1, x0], [y0, y0, y1, y1])
        west, south, east, north = float(lon.min()), float(lat.min()), float(lon.max()), float(lat.max())
    dalles = {}
    for f in lire_couche(COUCHE_DALLES, west, south, east, north)["features"]:
        url = (f.get("properties") or {}).get("url_npl")
        if url:
            dalles[url.rsplit("/", 1)[-1]] = url
    if not dalles:
        return None
    lus = en_parallele(*(lambda u=u: lire_points(u, x0, y0, x1, y1, lire=lire)
                         for u in sorted(dalles.values())))
    x, y, z, classe = (np.concatenate(c) for c in zip(*(pts for pts, _ in lus)))
    lecteurs = [l for _, l in lus if l is not None]
    journal.info("Nuage : %d dalle(s), %d points, %d requêtes, %.1f Mo",
                 len(lus), len(x), sum(l.requetes for l in lecteurs),
                 sum(l.octets for l in lecteurs) / 1e6)
    nx = int(math.ceil((x1 - x0) / PAS_SOL_VU_M))
    ny = int(math.ceil((y1 - y0) / PAS_SOL_VU_M))

    def vu(quels):
        grille = np.zeros((ny, nx), dtype=bool)
        i = np.clip(((x[quels] - x0) / PAS_SOL_VU_M).astype(int), 0, nx - 1)
        j = np.clip(((y[quels] - y0) / PAS_SOL_VU_M).astype(int), 0, ny - 1)
        grille[j, i] = True
        return grille

    bati = np.isin(classe, CLASSES_BATI)
    brut = {"x": x[bati], "y": y[bati], "z": z[bati], "classe": classe[bati],
            "grilles": {"x0": x0, "y0": y0, "pas": PAS_SOL_VU_M,
                        "sol": vu(classe == CLASSE_SOL), "bati": vu(bati)}}
    if proche_m:
        brut["proche"] = (x0, y0, x1, y1)
    elif cote_max_m:
        brut["boite"] = (x0, y0, x1, y1)
    return brut


def altitudes(relief, lon, lat):
    """Altitudes du relief embarqué aux points (lon, lat), NaN hors de la
    grille : la même interpolation que relief.echantillonneur, vectorisée."""
    from .relief import RELIEF_SENTINELLE
    largeur, hauteur = relief["width"], relief["height"]
    quant = np.frombuffer(base64.b64decode(relief["altitudes"]), dtype="<i2").reshape(hauteur, largeur)
    alt = relief["zero_m"] + quant.astype(np.float64) * relief["pas_m"]
    alt[quant == RELIEF_SENTINELLE] = np.nan
    west, south, east, north = relief["bbox"]
    fx = (np.asarray(lon) - west) / (east - west) * (largeur - 1)
    fy = (north - np.asarray(lat)) / (north - south) * (hauteur - 1)
    dedans = (fx >= 0) & (fx <= largeur - 1) & (fy >= 0) & (fy <= hauteur - 1)
    fx, fy = np.where(dedans, fx, 0), np.where(dedans, fy, 0)
    x0, y0 = fx.astype(int), fy.astype(int)
    x1, y1 = np.minimum(x0 + 1, largeur - 1), np.minimum(y0 + 1, hauteur - 1)
    ax, ay = fx - x0, fy - y0
    a = ((alt[y0, x0] * (1 - ax) + alt[y0, x1] * ax) * (1 - ay)
         + (alt[y1, x0] * (1 - ax) + alt[y1, x1] * ax) * ay)
    return np.where(dedans, a, np.nan)


def _polygones_l93(geometrie):
    """Polygones shapely en Lambert-93 d'une géométrie GeoJSON en degrés."""
    geom = shapely.force_2d(shape(geometrie))
    out = []
    for poly in getattr(geom, "geoms", [geom]):
        if poly.geom_type != "Polygon" or poly.is_empty:
            continue
        anneaux = [np.asarray(poly.exterior.coords)] + [np.asarray(t.coords) for t in poly.interiors]
        l93 = [np.column_stack(vers_lambert93(a[:, 0], a[:, 1])) for a in anneaux]
        out.append(Polygon(l93[0], l93[1:]))
    return out


def parts_vues(poly, grilles):
    """(parts des cellules de l'emprise érodée où le LiDAR voit le sol, une
    structure, et les deux à la fois — le sol sous une structure —, nombre de
    cellules) ; parts None si l'emprise érodée est trop petite pour juger."""
    erode = poly.buffer(-EROSION_M)
    if erode.is_empty:
        return None, None, None, 0
    pas = grilles["pas"]
    ny, nx = grilles["sol"].shape
    gx0, gy0, gx1, gy1 = erode.bounds
    i0 = max(int((gx0 - grilles["x0"]) / pas), 0)
    i1 = min(int((gx1 - grilles["x0"]) / pas) + 1, nx)
    j0 = max(int((gy0 - grilles["y0"]) / pas), 0)
    j1 = min(int((gy1 - grilles["y0"]) / pas) + 1, ny)
    if i1 <= i0 or j1 <= j0:
        return None, None, None, 0
    I, J = np.meshgrid(np.arange(i0, i1), np.arange(j0, j1))
    cx, cy = grilles["x0"] + (I + 0.5) * pas, grilles["y0"] + (J + 0.5) * pas
    dedans = shapely.contains_xy(erode, cx, cy)
    n = int(dedans.sum())
    if n < CELLULES_MIN:
        return None, None, None, n
    J, I = J[dedans], I[dedans]
    sol, bati = grilles["sol"][J, I], grilles["bati"][J, I]
    return float(sol.mean()), float(bati.mean()), float((sol & bati).mean()), n


def ajoures(batiments, grilles):
    """(cleabs des ouvrages ajourés, leurs polygones Lambert-93, et pour chacun
    la raison : {sol, structure, sous_structure, chevauche} — parts vues sous
    l'emprise (parts_vues), None si elle est trop petite pour juger, et cleabs
    de l'ouvrage ajouré qu'elle chevauche quand c'est ce qui la fait retenir).

    Ajouré : le LiDAR voit le sol sous une structure à travers l'emprise ; ou
    l'emprise chevauche celle d'un ouvrage ajouré — la BD TOPO ne superpose
    des bâtiments que pour dire des étages."""
    polys = []
    for f in (batiments or {}).get("features", []):
        cle = (f.get("properties") or {}).get("cleabs")
        try:
            for poly in _polygones_l93(f["geometry"]):
                polys.append((cle, poly))
        except Exception:
            continue
    # Retenus, et pour chacun l'emprise dont il chevauche l'ouvrage ajouré
    # (None : retenu sur sa propre mesure).
    retenus, mesures = {}, {}
    for k, (cle, poly) in enumerate(polys):
        sol, bati, sous, _ = parts_vues(poly, grilles)
        mesures[k] = (sol, bati, sous)
        if sous is not None and sous >= PART_SOL_SOUS_STRUCTURE:
            retenus[k] = None
    pleins = [shapely.Polygon(p.exterior) for _, p in polys]
    arbre = shapely.STRtree(pleins)
    a_voir = list(retenus)
    while a_voir:
        k = a_voir.pop()
        for v in arbre.query(pleins[k]):
            v = int(v)
            if v not in retenus and pleins[k].intersection(pleins[v]).area > 1.0:
                retenus[v] = k
                a_voir.append(v)
    details = {}
    for k in sorted(retenus):
        cle = polys[k][0]
        if not cle or cle in details:
            continue
        source = retenus[k]
        details[cle] = {**{nom: None if v is None else round(v, 2) for nom, v
                           in zip(("sol", "structure", "sous_structure"), mesures[k])},
                        "chevauche": None if source is None else polys[source][0]}
    return list(details), [polys[k][1] for k in sorted(retenus)], details


def decimer(x, y, z, cote):
    """Indices d'un point par voxel de `cote` mètres, le premier rencontré."""
    if not len(x):
        return np.zeros(0, dtype=int)
    cles = np.stack([np.floor(x / cote), np.floor(y / cote), np.floor(z / cote)], axis=1).astype(np.int64)
    _, premiers = np.unique(cles, axis=0, return_index=True)
    return np.sort(premiers)


def _b64(tableau):
    return base64.b64encode(np.ascontiguousarray(tableau).tobytes()).decode()


def nuage_pour_emprise(west, south, east, north, brut, relief, batiments=None, masses=None,
                       houppiers=None):
    """La couche du nuage, prête pour la vue.

    Args:
        brut: réponse de fetch_nuage, None hors couverture.
        relief: relief de la scène ; sans lui, pas de couche — une altitude
            ne se compare pas au repli mondial de la vue.
        batiments: GeoJSON des bâtiments de la scène, pour les ajourés.
        masses, houppiers: masses de sursol et houppiers de la scène, pour
            ceux qu'ils expliquent : le MNH voit la tour Eiffel au-dessus de ses
            arches, et la scène en fait des masses — ou des houppiers, là où
            l'orthophoto montre la pelouse dessous.

    Returns:
        None, ou dict(version, origine, n, n_ajoures, lon, lat, h, classe,
        ajoures, ajoures_detail, masses_expliquees, houppiers_expliques) :
        - lon, lat : base64 d'entiers 32 bits, en 1e-7 degré depuis `origine`
          (l'angle sud-ouest de l'emprise) ;
        - h : base64 d'entiers 16 bits non signés, hauteur au-dessus du
          relief en centimètres ;
        - classe : base64 d'octets, classe LiDAR HD ;
        - les n_ajoures premiers points sont ceux des ouvrages ajourés ;
        - ajoures : cleabs des bâtiments que leurs points remplacent ;
        - ajoures_detail : pour chacun, pourquoi (voir ajoures) ;
        - masses_expliquees, houppiers_expliques : index dans `masses` et
          `houppiers` ;
        - proche, pour la première lecture (fetch_nuage, proche_m) seulement :
          (ouest, sud, est, nord) en degrés, dans le carré lu. Seuls les
          bâtiments qu'il contient entiers, marge comprise, y sont jugés : un
          bâtiment à cheval n'y a qu'une partie de ses mailles, la zone
          entière le jugera. Ses ouvrages ajourés sont donc aussi ceux de la
          zone entière.
        - boite, pour la seconde lecture d'une zone de plus de
          NUAGE_COTE_MAX_M : le carré central lu, de même ; la page n'a rien
          de plus à demander.
    """
    if brut is None or not relief or not relief.get("altitudes"):
        return None
    boite = brut.get("proche") or brut.get("boite")
    if boite:
        bx0, by0, bx1, by1 = boite

        def contenu(f):
            try:
                polys = _polygones_l93(f["geometry"])
            except Exception:
                return False
            return bool(polys) and all(
                p.bounds[0] - MARGE_AJOURE_M >= bx0 and p.bounds[1] - MARGE_AJOURE_M >= by0
                and p.bounds[2] + MARGE_AJOURE_M <= bx1 and p.bounds[3] + MARGE_AJOURE_M <= by1
                for p in polys)

        batiments = {"features": [f for f in (batiments or {}).get("features", []) if contenu(f)]}
    x, y, z, classe = brut["x"], brut["y"], brut["z"], brut["classe"]
    lon, lat = depuis_lambert93(x, y)
    h = z - altitudes(relief, lon, lat)
    garde = np.isfinite(h)
    x, y, lon, lat, h, classe = x[garde], y[garde], lon[garde], lat[garde], h[garde], classe[garde]

    cles, polys, details = ajoures(batiments, brut["grilles"])
    zone = shapely.union_all([Polygon(p.exterior).buffer(MARGE_AJOURE_M) for p in polys]) if polys else None
    dans = shapely.contains_xy(zone, x, y) if zone is not None else np.zeros(len(x), dtype=bool)
    hors = np.flatnonzero(~dans)
    cote = VOXEL_M
    garde = decimer(x[hors], y[hors], h[hors], cote)
    while len(garde) > POINTS_HORS_AJOURES:
        cote *= 1.5
        garde = decimer(x[hors], y[hors], h[hors], cote)
    hors = hors[garde]
    ordre = np.concatenate([np.flatnonzero(dans), hors])

    def expliques(elements):
        if zone is None or not elements:
            return []
        elon = np.array([e.get("lon", np.nan) for e in elements], dtype=np.float64)
        elat = np.array([e.get("lat", np.nan) for e in elements], dtype=np.float64)
        ex, ey = vers_lambert93(elon, elat)
        return np.flatnonzero(shapely.contains_xy(zone, ex, ey)).tolist()

    expliquees, houppiers_expliques = expliques(masses), expliques(houppiers)

    lon, lat, h, classe = lon[ordre], lat[ordre], h[ordre], classe[ordre]
    journal.info("Nuage%s : %d points du bâti, %d d'ouvrages ajourés (%d bâtiments), "
                 "%d masses et %d houppiers expliqués", " proche" if brut.get("proche") else "",
                 len(lon), int(dans.sum()), len(cles), len(expliquees), len(houppiers_expliques))
    proche = {cle: interieur_degres(*brut[cle]) for cle in ("proche", "boite") if brut.get(cle)}
    return {
        "version": NUAGE_VERSION,
        "origine": [west, south],
        "n": int(len(lon)),
        "n_ajoures": int(dans.sum()),
        "lon": _b64(np.round((lon - west) * 1e7).astype("<i4")),
        "lat": _b64(np.round((lat - south) * 1e7).astype("<i4")),
        "h": _b64(np.clip(np.round(h * 100), 0, 65535).astype("<u2")),
        "classe": _b64(classe.astype(np.uint8)),
        "ajoures": cles,
        "ajoures_detail": details,
        "masses_expliquees": expliquees,
        "houppiers_expliques": houppiers_expliques,
        **proche,
    }
