"""Signalisation des carrefours de la vue en voiture : stops, cédez-le-passage
et feux d'OpenStreetMap.

Aucune base publique ne recense les panneaux, et la BD TOPO n'en porte pas.
OpenStreetMap place un stop, un cédez-le-passage ou un feu sur un nœud de la
voie (`highway=stop`, `give_way`, `traffic_signals`), avec le sens où il
s'applique (`direction=forward` ou `backward`, celui de la voie). Le
2026-11-04, sur environ 2 km autour du centre de Rousset, d'Aix-en-Provence,
de Montélimar et de Gordes : 26, 16, 32 et 13 stops ; 39, 38, 147 et 10
cédez-le-passage ; 0, 175, 6 et 0 feux. Le sens manque à 20 stops et
cédez-le-passage sur 65 à Rousset, à 9 sur 256 ailleurs. Ce qui n'est pas
saisi manque : la page cite OpenStreetMap et n'en fait pas une garantie.
Licence ODbL.

Une couche à part, par carré de la voiture (vue3d/carres.py), comme les
limitations (vue3d/vitesses.py), dont elle partage les places d'Overpass : les
panneaux sont lus par bloc de 2 km, avec les voies qui les portent, et gardés
pour toujours ; puis chacun est rattaché au tronçon BD TOPO le plus proche et
au sens où il s'applique. Un feu posé au carrefour lui-même vaut pour chaque
tronçon qui y arrive. Un stop ou un cédez-le-passage sans sens vaut pour qui
roule vers le carrefour le plus proche, où il se dresse.

Format, JSON gzippé : `signaux`, une ligne par panneau et par sens où il
s'applique : [type (« stop », « cedez », « feu »), id du tronçon (cleabs),
sens (1 : celui de sa géométrie, -1 : l'autre), abscisse en mètres depuis le
début du tronçon].
"""

import collections
import gzip
import json
import math
import os
import tempfile
import threading
from datetime import date

import requests
from shapely import LineString, Point, STRtree

from .carres import (ACCES_ECARTE, CARRE_M, ETATS_ECARTES, NATURES_ECARTEES, CarreIndisponible,
                     emprise_carre, lambert93, verifier_carre, wgs84)
from .couches import COUCHE_ROUTES, SRS_LAMBERT93, lire_couche
from .geopf import LectureAbandonnee
from .vitesses import BLOC_M, overpass

# Version de la couche et de son contenu : un carré change de dossier avec elle.
SIGNALISATION_VERSION = 1
BLOC_VERSION = 1

TYPES = {"stop": "stop", "give_way": "cedez", "traffic_signals": "feu"}
# Les voies où roule une voiture : un feu sur un passage piéton est aussi sur
# le trottoir dessiné (`footway`), qui n'en fait pas un carrefour.
ROULANTES = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
             "living_street", "service", "road", "track"}

# Les tronçons lus autour du carré, pour voir les carrefours de ses bords.
MARGE_M = 50
# Un panneau se rattache au tronçon le plus proche à moins de ECART_MAX_M, de
# même axe que sa voie OSM à CAP_MAX_DEG près, comme une limitation : le
# 2026-11-04, sur les quatre lieux, 486 panneaux hors carrefour sont à 0,8 m
# de leur tronçon en médiane, 4,7 m pour 95 %, 8 au-delà de 12 m. Un feu
# posé au carrefour même se rattache au nœud BD TOPO d'au moins trois
# tronçons le plus proche, à moins de CARREFOUR_MAX_M (les 16 d'Aix sont à
# moins de 10 m du leur), et se pose sur chaque tronçon qui y arrive à
# RECUL_M du nœud : la distance médiane au carrefour des 134 feux posés sur
# leur approche (10 à 20 m pour la moitié d'entre eux).
ECART_MAX_M = 12
CAP_MAX_DEG = 35
CARREFOUR_MAX_M = 20
RECUL_M = 14
# Deux panneaux d'un même type à moins de DOUBLON_M sur un même tronçon et
# dans le même sens n'en font qu'un : un feu au carrefour et celui de son
# approche.
DOUBLON_M = 15


def _roulante(tags):
    h = tags.get("highway", "")
    return h in ROULANTES or h.endswith("_link")


def _cap(xa, ya, xb, yb):
    """Le cap de a vers b, en degrés depuis le nord du quadrillage."""
    return math.degrees(math.atan2(xb - xa, yb - ya)) % 360


def rectangle_bloc(bi, bj):
    """Le rectangle (west, south, east, north) à lire pour le bloc."""
    x0, y0 = bi * BLOC_M - 1, bj * BLOC_M - 1
    x1, y1 = (bi + 1) * BLOC_M + 1, (bj + 1) * BLOC_M + 1
    coins = [wgs84(x, y) for x in (x0, x1) for y in (y0, y1)]
    return (round(min(c[0] for c in coins), 7), round(min(c[1] for c in coins), 7),
            round(max(c[0] for c in coins), 7), round(max(c[1] for c in coins), 7))


def _requete_bloc(bi, bj):
    w, s, e, n = rectangle_bloc(bi, bj)
    return ('[out:json][timeout:120];'
            f'node["highway"~"^(stop|give_way|traffic_signals)$"]({s:.7f},{w:.7f},{n:.7f},{e:.7f})->.n;'
            '.n out body;way(bn.n)["highway"];out geom;')


def signaux_du_bloc(brut):
    """Les panneaux d'une réponse Overpass : [type, x, y, axe, caps, carrefour]
    en mètres Lambert-93 au décimètre. `axe` : le cap de la voie qui le porte
    (None sans voie) ; `caps` : les caps de circulation où il s'applique, None
    s'il faut les déduire ; `carrefour` : 1 si le nœud joint au moins trois
    branches de voies roulantes."""
    elements = brut.get("elements", [])
    noeuds = {e["id"]: e for e in elements if e.get("type") == "node"}
    porteuses = collections.defaultdict(list)          # nœud → [(géométrie, rang)]
    for w in elements:
        if w.get("type") != "way" or not _roulante(w.get("tags") or {}):
            continue
        ids, geom = w.get("nodes") or [], w.get("geometry") or []
        if len(ids) != len(geom) or len(ids) < 2:
            continue
        for k, nid in enumerate(ids):
            if nid in noeuds:
                porteuses[nid].append((geom, k))
    signaux = []
    for nid, n in noeuds.items():
        tags = n.get("tags") or {}
        type_ = TYPES.get(tags.get("highway"))
        if type_ is None or "lon" not in n:
            continue
        x, y = lambert93(n["lon"], n["lat"])
        voies = porteuses.get(nid, [])
        branches = sum(1 if k in (0, len(g) - 1) else 2 for g, k in voies)
        axe = None
        if voies:
            g, k = voies[0]
            a, b = g[max(k - 1, 0)], g[min(k + 1, len(g) - 1)]
            axe = _cap(*lambert93(a["lon"], a["lat"]), *lambert93(b["lon"], b["lat"]))
        carrefour = branches >= 3
        sens = tags.get("traffic_signals:direction") if type_ == "feu" else None
        sens = (sens or tags.get("direction") or "").strip().lower()
        caps = None
        if len(voies) == 1 and not carrefour:
            if sens == "forward":
                caps = [axe]
            elif sens == "backward":
                caps = [(axe + 180) % 360]
            elif sens == "both" or type_ == "feu":
                # Un feu hors carrefour, sans sens : celui d'un passage
                # piéton, qui arrête les deux sens.
                caps = [axe, (axe + 180) % 360]
        signaux.append([type_, round(x, 1), round(y, 1), None if axe is None else round(axe, 1),
                        None if caps is None else [round(c, 1) for c in caps], int(carrefour)])
    return signaux


class BlocsSignaux:
    """Les panneaux OSM par bloc, sur disque : `dossier`/carres/osm-signaux-v<n>/<bi>/<bj>.json.gz,
    écrits d'un bloc ; en mémoire les derniers lus. `lire` : (bi, bj) ->
    réponse Overpass brute, injectable pour les tests."""

    MEMOIRE = 8

    def __init__(self, dossier, lire=None):
        self.dossier = os.path.join(dossier, "carres", f"osm-signaux-v{BLOC_VERSION}")
        self.lire = lire or (lambda bi, bj: overpass(_requete_bloc(bi, bj)))
        self._memoire = collections.OrderedDict()
        self._verrous = {}
        self._verrou = threading.Lock()

    def _verrou_de(self, cle):
        with self._verrou:
            return self._verrous.setdefault(cle, threading.Lock())

    def obtenir(self, bi, bj):
        """Les panneaux du bloc ; deux demandes du même bloc n'en font qu'une lecture.

        Raises:
            requests.RequestException si Overpass n'a pas répondu : rien n'est écrit.
        """
        cle = (bi, bj)
        with self._verrou_de(cle):
            with self._verrou:
                if cle in self._memoire:
                    self._memoire.move_to_end(cle)
                    return self._memoire[cle]
            chemin = os.path.join(self.dossier, str(bi), f"{bj}.json.gz")
            if os.path.exists(chemin):
                with gzip.open(chemin, "rt", encoding="utf-8") as f:
                    signaux = json.load(f)["signaux"]
            else:
                signaux = signaux_du_bloc(self.lire(bi, bj))
                octets = gzip.compress(json.dumps({"version": BLOC_VERSION, "bloc": [bi, bj],
                                                   "lu": date.today().isoformat(), "signaux": signaux},
                                                  separators=(",", ":")).encode())
                os.makedirs(os.path.dirname(chemin), exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=os.path.dirname(chemin))
                with os.fdopen(fd, "wb") as f:
                    f.write(octets)
                os.replace(tmp, chemin)
            with self._verrou:
                self._memoire[cle] = signaux
                while len(self._memoire) > self.MEMOIRE:
                    self._memoire.popitem(last=False)
            return signaux


# --- Le rattachement aux tronçons ---------------------------------------------------------------

class Troncons:
    """Les tronçons carrossables d'une réponse WFS, leurs segments indexés et
    le nombre de tronçons à chaque nœud."""

    def __init__(self, geojson):
        self.troncons = []                       # (cleabs, [(x, y)], [abscisses], sens de circulation)
        self.segments = []                       # (rang du tronçon, rang du segment)
        geometries = []
        self.noeuds = collections.defaultdict(list)    # (x, y) au cm → [(rang, 1 s'il y finit, -1 s'il y commence)]
        for f in geojson.get("features", []):
            p, g = f.get("properties") or {}, f.get("geometry") or {}
            if (p.get("etat_de_l_objet") in ETATS_ECARTES or p.get("nature") in NATURES_ECARTEES
                    or p.get("acces_vehicule_leger") == ACCES_ECARTE or p.get("fictif")
                    or g.get("type") != "LineString" or len(g.get("coordinates") or []) < 2):
                continue
            xy = [(c[0], c[1]) for c in g["coordinates"]]
            cum = [0.0]
            for (xa, ya), (xb, yb) in zip(xy, xy[1:]):
                cum.append(cum[-1] + math.hypot(xb - xa, yb - ya))
            if cum[-1] <= 0:
                continue
            t = len(self.troncons)
            self.troncons.append((p.get("cleabs"), xy, cum, p.get("sens_de_circulation")))
            for k in range(len(xy) - 1):
                if xy[k] != xy[k + 1]:
                    self.segments.append((t, k))
                    geometries.append(LineString([xy[k], xy[k + 1]]))
            self.noeuds[self._cle(xy[0])].append((t, -1))
            self.noeuds[self._cle(xy[-1])].append((t, 1))
        self.geometries = geometries
        self.arbre = STRtree(geometries) if geometries else None
        self._carrefours = [(cle, liens) for cle, liens in self.noeuds.items() if len(liens) >= 3]

    @staticmethod
    def _cle(xy):
        return round(xy[0], 2), round(xy[1], 2)

    def degre(self, xy):
        return len(self.noeuds.get(self._cle(xy), ()))

    def permis(self, t, sens):
        """Le sens `sens` (1, -1) est-il permis sur le tronçon `t` ?"""
        circulation = self.troncons[t][3]
        return not (circulation == "Sens direct" and sens < 0) and not (circulation == "Sens inverse" and sens > 0)

    def projeter(self, x, y, axe):
        """Le point du tronçon le plus proche de (x, y) à moins de ECART_MAX_M,
        d'axe proche de `axe` s'il est donné : (rang, abscisse, cap du
        segment), ou None."""
        if self.arbre is None:
            return None
        p = Point(x, y)
        cos_max = math.cos(math.radians(CAP_MAX_DEG))
        meilleur = None
        for i in self.arbre.query(p, predicate="dwithin", distance=ECART_MAX_M):
            t, k = self.segments[i]
            _, xy, cum, _ = self.troncons[t]
            (xa, ya), (xb, yb) = xy[k], xy[k + 1]
            cap = _cap(xa, ya, xb, yb)
            if axe is not None and abs(math.cos(math.radians(cap - axe))) < cos_max:
                continue
            d = self.geometries[i].distance(p)
            if meilleur is None or d < meilleur[0]:
                l = cum[k + 1] - cum[k]
                u = max(0.0, min(1.0, ((x - xa) * (xb - xa) + (y - ya) * (yb - ya)) / (l * l)))
                meilleur = (d, t, cum[k] + l * u, cap)
        return None if meilleur is None else meilleur[1:]

    def carrefour_proche(self, x, y):
        """Le nœud d'au moins trois tronçons le plus proche à moins de
        CARREFOUR_MAX_M : ses liens [(rang, 1 ou -1)], ou None."""
        meilleur = None
        for (cx, cy), liens in self._carrefours:
            d = math.hypot(cx - x, cy - y)
            if d <= CARREFOUR_MAX_M and (meilleur is None or d < meilleur[0]):
                meilleur = (d, liens)
        return None if meilleur is None else meilleur[1]


def _sens_vers_le_carrefour(troncons, t, s):
    """Le sens de qui roule vers le bout du tronçon `t` qui est un carrefour
    (au moins trois tronçons) ; vers le plus proche de l'abscisse `s` si
    aucun ne l'est, ou les deux. Appliquée aux panneaux dont OSM donne le
    sens, la règle le retrouve pour 69 stops sur 72 et 202 cédez-le-passage
    sur 208 (2026-11-04, les quatre lieux)."""
    _, xy, cum, _ = troncons.troncons[t]
    debut, fin = troncons.degre(xy[0]) >= 3, troncons.degre(xy[-1]) >= 3
    if debut != fin:
        return 1 if fin else -1
    return 1 if cum[-1] - s < s else -1


def signaux_du_carre(geojson, signaux, i, j):
    """Les panneaux du carré (i, j) rattachés aux tronçons d'une réponse WFS
    en Lambert-93 : [type, cleabs, sens, abscisse]."""
    troncons = Troncons(geojson)
    x0, y0, x1, y1 = emprise_carre(i, j)
    sortie = []

    def ajouter(type_, t, sens, s):
        if not troncons.permis(t, sens):
            return
        cleabs, _, cum, _ = troncons.troncons[t]
        s = round(min(max(s, 0.0), cum[-1]), 1)
        for autre in sortie:
            if autre[:3] == [type_, cleabs, sens] and abs(autre[3] - s) < DOUBLON_M:
                return
        sortie.append([type_, cleabs, sens, s])

    for type_, x, y, axe, caps, carrefour in signaux:
        if not (x0 <= x < x1 and y0 <= y < y1):
            continue
        if type_ == "feu" and carrefour:
            for t, bout in troncons.carrefour_proche(x, y) or ():
                longueur = troncons.troncons[t][2][-1]
                ajouter(type_, t, bout, longueur - RECUL_M if bout > 0 else RECUL_M)
            continue
        if carrefour:
            # Un stop ou un cédez-le-passage au nœud même du carrefour : on
            # ne sait pas laquelle des voies qui s'y croisent il arrête.
            continue
        projete = troncons.projeter(x, y, axe)
        if projete is None:
            continue
        t, s, cap = projete
        if caps is None:
            ajouter(type_, t, _sens_vers_le_carrefour(troncons, t, s), s)
            continue
        for c in caps:
            ajouter(type_, t, 1 if math.cos(math.radians(c - cap)) > 0 else -1, s)
    return sortie


def fetch_signalisation(i, j, blocs):
    """Les panneaux du carré (i, j).

    Raises:
        CarreIndisponible si les tronçons ou le bloc OSM n'ont pas pu être
        lus : rien n'est écrit.
    """
    verifier_carre(i, j)
    x0, y0, x1, y1 = emprise_carre(i, j)
    try:
        signaux = blocs.obtenir(math.floor(x0 / BLOC_M), math.floor(y0 / BLOC_M))
        routes = lire_couche(COUCHE_ROUTES, x0 - MARGE_M, y0 - MARGE_M, x1 + MARGE_M, y1 + MARGE_M,
                             srs=SRS_LAMBERT93)
    except (requests.RequestException, LectureAbandonnee) as exc:
        raise CarreIndisponible(str(exc)) from exc
    return {
        "version": SIGNALISATION_VERSION, "carre": [i, j], "taille": CARRE_M, "lu": date.today().isoformat(),
        "source": "OpenStreetMap (ODbL)",
        "signaux": signaux_du_carre(routes, signaux, i, j),
    }
