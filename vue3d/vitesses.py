"""Limitations de vitesse de la vue en voiture : OpenStreetMap, sinon la règle.

Aucune base nationale des vitesses maximales autorisées n'est publiée : prévue
pour 2017 par le Comité interministériel de la sécurité routière, puis par la
loi pour une République numérique, elle ne l'était toujours pas en 2018, et
rien depuis. La BD TOPO n'a qu'une vitesse moyenne estimée
(`vitesse_moyenne_vl`, 40 km/h sur la route des Crêtes de Cassis, 75 au
Ventoux) et un champ `vitesse_collaborative` vide : 0 tronçon sur 4 648 autour
de Rousset, de la Corniche de Marseille, de Cassis et du Ventoux, le
2026-10-22. OpenStreetMap porte la limite (`maxspeed`) sur 43 % des voies
autour de Rousset — autoroutes 65 sur 65, routes principales 153 sur 176,
rues 43 sur 338 —, 16 % à Marseille, 22 % à Cassis, 100 % sur la D974 du
Ventoux. Licence ODbL : la page cite OpenStreetMap.

Une couche à part, par carré de la voiture (vue3d/carres.py) : pour chaque
tronçon carrossable BD TOPO qui touche le carré, la limite dans chacun de ses
deux sens. Les voies OSM sont lues par bloc de 2 km, seize carrés d'une seule
requête Overpass : le 2026-10-22, un bloc prenait 30 s le long de l'A7 à
Montélimar (321 voies, 251 Ko) et 88 s au centre de Marseille (339 voies,
274 Ko), et deux instances sur trois n'avaient pas répondu ; le soir, 3 à
4 min par bloc autour de Rousset. Un bloc lu est gardé pour toujours, comme
le carré, et la page demande les limitations aussi loin devant que les
bâtiments. Sur la D17 de la route Cézanne, OSM donne 80 km/h ; au centre de
Rousset, 43 tronçons sur 192 ont une limite OSM, la règle donne 50 aux
autres.

Faute de limite OSM, la règle générale du code de la route (article R413-2),
marquée comme telle : 50 km/h en agglomération (`urbain` BD TOPO), 130 sur
une autoroute, 110 sur une route à chaussées séparées, 80 sur une autre route
à double sens. Rien sur une bretelle, un rond-point ou un chemin, que la
signalisation locale règle ; et les départements revenus à 90 km/h ne sont
publiés nulle part : la règle dit 80.

Format, JSON gzippé : `vitesses`, une ligne par tronçon, [id (cleabs), dans
le sens de sa géométrie, dans l'autre sens, OSM dans le premier (1) ou règle
(0), de même dans l'autre] — km/h, null inconnue.
"""

import collections
import gzip
import json
import math
import os
import tempfile
import threading
import time
from datetime import date

import requests
from shapely import LineString, Point, STRtree

from .carres import (ACCES_ECARTE, CARRE_M, ETATS_ECARTES, NATURES_ECARTEES, CarreIndisponible,
                     emprise_carre, lambert93, verifier_carre, wgs84)
from .couches import COUCHE_ROUTES, SRS_LAMBERT93, lire_couche
from .geopf import LectureAbandonnee
from .monuments import OVERPASS_ATTENTE_S, OVERPASS_TIMEOUT_S, OVERPASS_TOURS, OVERPASS_URLS

# Version de la couche et de son contenu : un carré change de dossier avec elle.
VITESSES_VERSION = 1
# Les voies OSM lues par bloc de BLOC_M de côté, avec une marge d'un écart
# admis : une voie au bord d'un bloc sert aux tronçons du bloc voisin.
BLOC_M = 2000
BLOC_VERSION = 1
# Deux requêtes Overpass à la fois au plus, pour tout le service, la
# signalisation comprise (vue3d/signalisation.py) : la politique des
# instances publiques, deux places par adresse.
_PLACES_OVERPASS = threading.BoundedSemaphore(2)

# Le rapprochement d'un tronçon BD TOPO et d'une voie OSM : un point tous les
# PAS_M le long du tronçon, hors de ses BOUT_M premiers et derniers mètres
# (le carrefour, où passent les voies d'à côté) ; la voie OSM la plus proche
# à moins de ECART_MAX_M, de même axe à CAP_MAX_DEG près. La limite retenue
# dans un sens est celle d'au moins PART_MIN des points.
PAS_M = 10
BOUT_M = 5
ECART_MAX_M = 12
CAP_MAX_DEG = 35
PART_MIN = 0.5

# Les valeurs symboliques de `maxspeed` en France (wiki OpenStreetMap,
# « Key:maxspeed »).
SYMBOLES = {"fr:urban": 50, "fr:rural": 80, "fr:motorway": 130, "fr:zone30": 30, "fr:zone:30": 30,
            "fr:zone20": 20, "fr:zone:20": 20}
KM_PAR_MILLE = 1.609344
VITESSE_MAX_PLAUSIBLE = 150


def valeur_maxspeed(texte):
    """La limite en km/h d'une valeur `maxspeed` d'OSM ; None si elle n'en
    donne pas une seule (« none », « signals », « 30;50 », « walk »…)."""
    if texte is None:
        return None
    t = str(texte).strip().lower()
    if t in SYMBOLES:
        return SYMBOLES[t]
    mph = t.endswith("mph")
    t = t.removesuffix("mph").removesuffix("km/h").strip()
    if not t.isdigit():
        return None
    v = int(t)
    if mph:
        v = round(v * KM_PAR_MILLE)
    return v if 0 < v <= VITESSE_MAX_PLAUSIBLE else None


def regle_generale(nature, urbain):
    """La limite qu'impose le code de la route sans panneau ; None quand elle
    dépend de la signalisation locale."""
    if nature == "Type autoroutier":
        return 110 if urbain else 130
    if nature in ("Route à 1 chaussée", "Route à 2 chaussées"):
        if urbain:
            return 50
        return 110 if nature == "Route à 2 chaussées" else 80
    return None


# --- Les voies OSM, par bloc --------------------------------------------------------------------

def _requete_bloc(bi, bj):
    x0, y0 = bi * BLOC_M - ECART_MAX_M, bj * BLOC_M - ECART_MAX_M
    x1, y1 = (bi + 1) * BLOC_M + ECART_MAX_M, (bj + 1) * BLOC_M + ECART_MAX_M
    coins = [wgs84(x, y) for x in (x0, x1) for y in (y0, y1)]
    w, s = min(c[0] for c in coins), min(c[1] for c in coins)
    e, n = max(c[0] for c in coins), max(c[1] for c in coins)
    return ('[out:json][timeout:120];'
            f'way["highway"][~"^maxspeed(:forward|:backward)?$"~"."]({s:.7f},{w:.7f},{n:.7f},{e:.7f});'
            'out tags geom;')


def overpass(requete):
    """Réponse JSON d'Overpass, en essayant chaque instance.

    Raises:
        requests.RequestException si toutes ont échoué.
    """
    dernier = None
    with _PLACES_OVERPASS:
        for tour in range(OVERPASS_TOURS):
            for url in OVERPASS_URLS:
                try:
                    reponse = requests.post(url, data={"data": requete}, headers={"User-Agent": "vue-3d-ign"},
                                            timeout=OVERPASS_TIMEOUT_S)
                    if not reponse.ok:
                        raise requests.RequestException(f"HTTP {reponse.status_code} sur {url}")
                    donnees = reponse.json()
                    # Une requête trop longue rend un 200 avec une remarque, et
                    # des éléments tronqués : ce n'est pas une réponse.
                    if "remark" in donnees and "runtime error" in str(donnees["remark"]):
                        raise requests.RequestException(f"{url} : {donnees['remark'][:120]}")
                    return donnees
                except (requests.RequestException, ValueError) as exc:
                    # ValueError : une instance saturée rend une page HTML en 200.
                    dernier = exc
            if tour < OVERPASS_TOURS - 1:
                time.sleep(OVERPASS_ATTENTE_S)
    raise requests.RequestException(f"Overpass injoignable : {dernier}")


def voies_du_bloc(brut):
    """Les voies OSM utiles d'une réponse Overpass : [[avant, arrière],
    [x0, y0, x1, y1, …]] en mètres Lambert-93, au décimètre ; avant et
    arrière dans le sens de la voie OSM, None inconnue."""
    voies = []
    for w in brut.get("elements", []):
        tags, geom = w.get("tags") or {}, w.get("geometry") or []
        commune = valeur_maxspeed(tags.get("maxspeed"))
        avant = valeur_maxspeed(tags.get("maxspeed:forward")) or commune
        arriere = valeur_maxspeed(tags.get("maxspeed:backward")) or commune
        if (avant is None and arriere is None) or len(geom) < 2:
            continue
        ligne = []
        for p in geom:
            x, y = lambert93(p["lon"], p["lat"])
            ligne += [round(x, 1), round(y, 1)]
        voies.append([[avant, arriere], ligne])
    return voies


class BlocsOsm:
    """Les voies OSM par bloc, sur disque : `dossier`/carres/osm-vitesses-v<n>/<bi>/<bj>.json.gz,
    écrites d'un bloc ; en mémoire les derniers lus. `lire` : (bi, bj) ->
    réponse Overpass brute, injectable pour les tests."""

    MEMOIRE = 8

    def __init__(self, dossier, lire=None):
        self.dossier = os.path.join(dossier, "carres", f"osm-vitesses-v{BLOC_VERSION}")
        self.lire = lire or (lambda bi, bj: overpass(_requete_bloc(bi, bj)))
        self._memoire = collections.OrderedDict()
        self._verrous = {}
        self._verrou = threading.Lock()

    def _verrou_de(self, cle):
        with self._verrou:
            return self._verrous.setdefault(cle, threading.Lock())

    def obtenir(self, bi, bj):
        """Les voies du bloc ; deux demandes du même bloc n'en font qu'une lecture.

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
                    voies = json.load(f)["voies"]
            else:
                voies = voies_du_bloc(self.lire(bi, bj))
                octets = gzip.compress(json.dumps({"version": BLOC_VERSION, "bloc": [bi, bj],
                                                   "lu": date.today().isoformat(), "voies": voies},
                                                  separators=(",", ":")).encode())
                os.makedirs(os.path.dirname(chemin), exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=os.path.dirname(chemin))
                with os.fdopen(fd, "wb") as f:
                    f.write(octets)
                os.replace(tmp, chemin)
            with self._verrou:
                self._memoire[cle] = voies
                while len(self._memoire) > self.MEMOIRE:
                    self._memoire.popitem(last=False)
            return voies


# --- Le rapprochement ---------------------------------------------------------------------------

def _points(xy):
    """Les points d'échantillonnage d'une polyligne [(x, y), …] : (x, y, dx, dy)."""
    cum = [0.0]
    for (xa, ya), (xb, yb) in zip(xy, xy[1:]):
        cum.append(cum[-1] + math.hypot(xb - xa, yb - ya))
    longueur = cum[-1]
    if longueur <= 0:
        return []
    if longueur < 2 * BOUT_M + PAS_M:
        abscisses = [longueur / 2]
    else:
        n = max(1, int((longueur - 2 * BOUT_M) // PAS_M))
        abscisses = [BOUT_M + (longueur - 2 * BOUT_M) * (k + 0.5) / n for k in range(n)]
    sortie, k = [], 0
    for s in abscisses:
        while k < len(cum) - 2 and cum[k + 1] < s:
            k += 1
        l = (cum[k + 1] - cum[k]) or 1
        u = (s - cum[k]) / l
        (xa, ya), (xb, yb) = xy[k], xy[k + 1]
        sortie.append((xa + (xb - xa) * u, ya + (yb - ya) * u, (xb - xa) / l, (yb - ya) / l))
    return sortie


class Rapprocheur:
    """Les segments des voies OSM d'une zone, indexés."""

    def __init__(self, voies):
        self.segments = []                       # (x0, y0, x1, y1, avant, arrière)
        geometries = []
        for (avant, arriere), ligne in voies:
            for k in range(0, len(ligne) - 2, 2):
                x0, y0, x1, y1 = ligne[k:k + 4]
                if (x0, y0) == (x1, y1):
                    continue
                self.segments.append((x0, y0, x1, y1, avant, arriere))
                geometries.append(LineString([(x0, y0), (x1, y1)]))
        self.arbre = STRtree(geometries) if geometries else None
        self.geometries = geometries

    def limites(self, xy):
        """Les limites OSM d'un tronçon [(x, y), …] : (dans son sens, dans l'autre), None inconnue."""
        points = _points(xy)
        if not points or self.arbre is None:
            return None, None
        votes = (collections.Counter(), collections.Counter())
        cos_max = math.cos(math.radians(CAP_MAX_DEG))
        for x, y, dx, dy in points:
            p = Point(x, y)
            meilleur = None
            for i in self.arbre.query(p, predicate="dwithin", distance=ECART_MAX_M):
                x0, y0, x1, y1, avant, arriere = self.segments[i]
                l = math.hypot(x1 - x0, y1 - y0)
                cos = ((x1 - x0) * dx + (y1 - y0) * dy) / l
                if abs(cos) < cos_max:
                    continue
                d = self.geometries[i].distance(p)
                if meilleur is None or d < meilleur[0]:
                    meilleur = (d, cos > 0, avant, arriere)
            if meilleur is None:
                continue
            _, meme_sens, avant, arriere = meilleur
            sens, contresens = (avant, arriere) if meme_sens else (arriere, avant)
            if sens is not None:
                votes[0][sens] += 1
            if contresens is not None:
                votes[1][contresens] += 1
        sortie = []
        for compte in votes:
            if not compte:
                sortie.append(None)
                continue
            valeur, n = compte.most_common(1)[0]
            sortie.append(valeur if n >= PART_MIN * len(points) else None)
        return tuple(sortie)


def _blocs(xy):
    """Les blocs que touche une polyligne, marge d'un écart admis comprise."""
    xs, ys = [p[0] for p in xy], [p[1] for p in xy]
    return {(bi, bj)
            for bi in range(math.floor((min(xs) - ECART_MAX_M) / BLOC_M), math.floor((max(xs) + ECART_MAX_M) / BLOC_M) + 1)
            for bj in range(math.floor((min(ys) - ECART_MAX_M) / BLOC_M), math.floor((max(ys) + ECART_MAX_M) / BLOC_M) + 1)}


def vitesses_du_carre(geojson, voies_par_bloc):
    """Les limites des tronçons carrossables d'une réponse WFS en Lambert-93.

    `voies_par_bloc` : (bi, bj) -> voies OSM du bloc (BlocsOsm.obtenir).
    """
    troncons = []
    for f in geojson.get("features", []):
        p, g = f.get("properties") or {}, f.get("geometry") or {}
        if (p.get("etat_de_l_objet") in ETATS_ECARTES or p.get("nature") in NATURES_ECARTEES
                or p.get("acces_vehicule_leger") == ACCES_ECARTE or p.get("fictif")
                or g.get("type") != "LineString" or len(g.get("coordinates") or []) < 2):
            continue
        troncons.append((p, [(c[0], c[1]) for c in g["coordinates"]]))
    blocs = sorted(set().union(*(_blocs(xy) for _, xy in troncons))) if troncons else []
    voies = [v for b in blocs for v in voies_par_bloc(*b)]
    rapprocheur = Rapprocheur(voies)
    sortie = []
    for p, xy in troncons:
        osm = rapprocheur.limites(xy)
        regle = regle_generale(p.get("nature"), bool(p.get("urbain")))
        sortie.append([p.get("cleabs"),
                       osm[0] if osm[0] is not None else regle, osm[1] if osm[1] is not None else regle,
                       int(osm[0] is not None), int(osm[1] is not None)])
    return sortie


def fetch_vitesses(i, j, blocs):
    """Les limites des tronçons du carré (i, j).

    Raises:
        CarreIndisponible si les tronçons ou un bloc OSM n'ont pas pu être
        lus : rien n'est écrit.
    """
    verifier_carre(i, j)
    try:
        routes = lire_couche(COUCHE_ROUTES, *emprise_carre(i, j), srs=SRS_LAMBERT93)
        vitesses = vitesses_du_carre(routes, blocs.obtenir)
    except (requests.RequestException, LectureAbandonnee) as exc:
        raise CarreIndisponible(str(exc)) from exc
    return {
        "version": VITESSES_VERSION, "carre": [i, j], "taille": CARRE_M, "lu": date.today().isoformat(),
        "source": "OpenStreetMap (ODbL), sinon la règle générale du code de la route",
        "vitesses": vitesses,
    }
