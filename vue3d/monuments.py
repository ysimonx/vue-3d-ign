"""Monuments en 3D : les `building:part` d'OpenStreetMap, pour les bâtiments
que la BD TOPO résume trop.

La BD TOPO ne décrit un bâtiment que par son emprise et deux altitudes de
toit ; sans LiDAR HD, un monument devient un prisme coiffé d'un toit inventé.
Au Mont-Saint-Michel — où la dalle LiDAR livrée la plus proche est à 14 km —
La Merveille (20 m × 67 m, 16 m entre gouttière et faîtage BD TOPO) sortait en
toblerone. OpenStreetMap, lui, porte un vrai modèle 3D de l'abbaye : 31
parties (`building:part`) avec hauteurs et formes de toit, nef et flèche
comprises.

Cette couche est la seule du projet hors données IGN : licence ODbL, créditée
« © contributeurs OpenStreetMap » par la vue. Elle ne remplace la BD TOPO que
là où elle est plus riche ; partout ailleurs la scène l'ignore (aucune partie,
la couche est nulle).

Trois règles, mesurées sur l'abbaye du Mont-Saint-Michel le 28 septembre 2026,
sur 37 parties. Au 30, OSM n'en porte plus que 31 — la Porte du Roi et cinq
parties sans nom, toutes sans hauteur, ont été retirées — et les mesures
refaites donnent les mêmes règles : 8 bâtiments remplacés au lieu de 9, le
trou entre l'îlot abbatial (94 % et plus) et le village (moins de 30 %) s'est
élargi, la seule enveloppe reste l'église abbatiale.

- **Remplacement.** OSM et la BD TOPO ne découpent pas le bâti pareil : les
  emprises BD TOPO du complexe abbatial ne sont couvertes qu'à 29-100 % par
  l'union brute des parties, la pire étant justement La Merveille (29 %). La
  même union dilatée de 5 m couvre l'îlot abbatial à 86-100 %, et les maisons
  du village à 55 % au plus : un bâtiment BD TOPO est remplacé quand la
  dilatation en couvre au moins les deux tiers, seuil au milieu du trou.
- **Hauteurs de repli.** 8 des 31 parties de l'abbaye n'ont pas de `height`,
  dont les grandes nommées (La Merveille, Le Châtelet…), et rien au-dessus
  d'elles n'en a : on prend alors la hauteur BD TOPO du bâtiment qui contient
  le centroïde de la partie — une mesure —, à défaut `building:levels` × 3 m
  — une convention —, à défaut 6 m, et la partie est marquée `estime`.
- **Enveloppes.** La partie « Église abbatiale » porte 78,5 m — la flèche —
  sur les 1 565 m² du vaisseau entier : dessinée telle quelle, c'est une tour.
  Elle recouvre pourtant 13 parties mesurées plus basses (26 à 53 m), qu'elle
  rendrait invisibles ; or on ne cartographie pas des parties pour qu'elles
  soient avalées. Une partie qui en recouvre d'autres, mesurées et plus
  basses, est donc une enveloppe : sa hauteur passe au repli ci-dessus. Sur
  l'abbaye, la règle ne touche que celle-là — ni la tour-lanterne ni la
  flèche, qui ne recouvrent rien.
"""

import contextlib
import functools
import gzip
import json
import logging
import math
import os
import tempfile
import threading
import time
from datetime import date

import numpy as np
import requests
import shapely
from shapely.geometry import LineString, Polygon, box, shape

journal = logging.getLogger(__name__)

# Instances publiques d'Overpass, essayées dans l'ordre : l'instance
# principale a rendu un 504 et une page d'erreur HTML pendant le développement,
# les miroirs ont répondu. Chaque échec se rejoue sur la suivante. Plus que
# deux : le 6 novembre 2026, overpass.kumi.systems s'est révélé un alias DNS de
# overpass.private.coffee, et une lecture en échec attendait deux fois 90 s le
# même serveur à chaque tour (362 s en médiane sur douze jours).
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
OVERPASS_TOURS = 2
OVERPASS_ATTENTE_S = 3
OVERPASS_TIMEOUT_S = 90
# Fils du service qui peuvent attendre Overpass à la fois, monuments, limites
# de vitesse et signalisation réunis. Le service n'en a que huit : le 6
# novembre 2026, Overpass saturé, huit /api/monuments d'un seul visiteur, qui
# déplaçait le point, les ont tous tenus, jusqu'à 16 min, et les tuiles, la
# page et /api/sante ont attendu derrière eux jusqu'à 224 s. Sur douze jours
# de journal, 2 156 s à huit fils pleins, dont 1 865 avec quatre fils ou plus
# chez Overpass ; il en tient trois au plus 91,5 % du temps où une requête
# dure, et cette borne n'aurait laissé que 331 s pleines.
OVERPASS_ATTENTES = 3
_attentes_overpass = threading.BoundedSemaphore(OVERPASS_ATTENTES)
# Réponses Overpass des lieux d'exemple du README, embarquées dans le dépôt
# (outils/extraire_monuments_exemples.py, licence ODbL). Mesuré le 2026-09-28
# sur les trois instances : de 0,6 s à plus de 100 s pour la même requête,
# avec des 504, et autant pour une emprise sans aucune partie. Les exemples,
# première impression du projet, n'attendent donc pas Overpass et n'échouent
# jamais à cause de lui.
EXTRAIT_EXEMPLES = os.path.join(os.path.dirname(__file__), "donnees",
                                "monuments_exemples.json.gz")

# Les réponses d'Overpass gardées par bloc de 0,01° (1,1 km sur 0,8 km environ),
# et non plus par point : décaler le point ne relit rien, et une lecture qui ne
# trouve aucune partie, sept sur dix, sert aussi aux voisins. Une requête couvre
# le rectangle des blocs manquants. Douze jours de journal rejoués, 386 lectures
# de 0,55 km² en moyenne :
#
#     bloc    une requête par bloc    rectangle des manquants
#     0,01°   634                     209, 2,6 km² (3,4 au plus)
#     0,02°   344                     192, 6,2 km² (13,7 au plus)
#     0,05°   223                     162, 29,5 km² (85,3 au plus)
#
# 0,01° : presque tout le gain, sans demander à une instance saturée des
# surfaces cinq à vingt fois plus grandes.
BLOCS_PAR_DEGRE = 100
BLOCS_VERSION = 1
# Formes de toit OSM rendues par la vue. Les formes proches sont rabattues sur
# elles ; les autres (dome, skillion…) restent un sommet plat, comme une partie
# sans forme.
FORMES = {"gabled": "deux_pans", "hipped": "deux_pans",
          "pyramidal": "pyramide", "round": "pyramide"}
# Partie en pente sans `roof:height` : médiane de roof:height / petit côté sur
# les 11 parties de l'abbaye qui portent les deux (0,32 à 1,08 hors flèche).
TOIT_PART_COTE = 0.65
# Mètres par niveau quand seul `building:levels` est connu — la même
# convention que HAUTEUR_PAR_ETAGE dans la vue.
METRES_PAR_NIVEAU = 3.0
HAUTEUR_PAR_DEFAUT_M = 6.0
# Dilatation et seuil du remplacement, mesurés en tête de module.
REMPLACEMENT_DILATATION_M = 5.0
REMPLACEMENT_PART = 2 / 3
# Une partie B est « recouverte » par A quand A en contient au moins 80 % :
# assez pour tolérer les contours qui débordent d'un mètre, assez strict pour
# qu'un simple chevauchement de voisines ne fasse pas d'enveloppe.
ENVELOPPE_RECOUVREMENT = 0.8
# Arrondi des coordonnées : 7 décimales, un centimètre.
DECIMALES = 7


@contextlib.contextmanager
def attente_overpass(indisponible):
    """Une des OVERPASS_ATTENTES places, le temps qu'un fil du service attend
    Overpass, verrou de sa lecture compris : à prendre avant lui, ou la file
    se reformerait derrière le verrou d'un même point.

    Raises:
        `indisponible`(message) sans attendre si toutes sont prises : rien
        n'est écrit, les pages réessaient.
    """
    if not _attentes_overpass.acquire(blocking=False):
        raise indisponible("Overpass tarde et d'autres demandes l'attendent déjà")
    try:
        yield
    finally:
        _attentes_overpass.release()


def _requete(west, south, east, north):
    return (
        "[out:json][timeout:60];\n"
        f'(  way["building:part"]["building:part"!="no"]({south},{west},{north},{east});\n'
        f'   relation["building:part"]["building:part"!="no"]({south},{west},{north},{east});\n'
        ");\nout geom;"
    )


def cle_emprise(west, south, east, north):
    """Clé d'une emprise dans l'extrait embarqué : au micro-degré."""
    return ",".join(f"{v:.6f}" for v in (west, south, east, north))


@functools.lru_cache(maxsize=1)
def _extrait():
    """L'extrait embarqué, lu une fois ; vide s'il n'est pas là."""
    try:
        with gzip.open(EXTRAIT_EXEMPLES, "rt", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {"emprises": {}}


def _extrait_de(west, south, east, north):
    """La réponse de l'extrait embarqué pour cette emprise ; None sinon."""
    local = _extrait()["emprises"].get(cle_emprise(west, south, east, north))
    if local is None:
        return None
    journal.info("Monuments OSM : extrait embarqué du %s pour %s",
                 _extrait().get("date"), local["lieu"])
    return {"elements": local["elements"]}


def fetch_monuments(west, south, east, north, extrait=True):
    """Réponse Overpass brute des `building:part` de l'emprise.

    Pour un lieu d'exemple du README, la réponse est lue dans l'extrait
    embarqué (extrait=False l'ignore : c'est ainsi qu'on le rafraîchit).

    Raises:
        requests.RequestException si toutes les instances ont échoué : la
        scène ne doit pas se figer sans ses monuments (elle est complète ou
        n'existe pas), l'appelant réessaiera.
    """
    if extrait:
        local = _extrait_de(west, south, east, north)
        if local is not None:
            return local
    dernier = None
    for tour in range(OVERPASS_TOURS):
        for url in OVERPASS_URLS:
            try:
                reponse = requests.post(
                    url, data={"data": _requete(west, south, east, north)},
                    headers={"User-Agent": "vue-3d-ign"},
                    timeout=OVERPASS_TIMEOUT_S)
                if not reponse.ok:
                    raise requests.RequestException(
                        f"HTTP {reponse.status_code} sur {url}")
                donnees = reponse.json()
                # Une requête trop longue rend un 200 avec une remarque, et
                # des éléments tronqués : gardée dans un bloc, ils manqueraient
                # pour toujours.
                if "remark" in donnees and "runtime error" in str(donnees["remark"]):
                    raise requests.RequestException(f"{url} : {donnees['remark'][:120]}")
                return donnees
            except (requests.RequestException, ValueError) as exc:
                # ValueError : les instances saturées rendent une page HTML
                # en 200, vue en développement sur l'instance principale.
                dernier = exc
        if tour < OVERPASS_TOURS - 1:
            time.sleep(OVERPASS_ATTENTE_S)
    raise requests.RequestException(f"Overpass injoignable : {dernier}")


def _lignes(element):
    """Les lignes d'un way, ou des membres d'une relation : [[{lat, lon}, …], …]."""
    if element.get("type") == "way":
        lignes = [element.get("geometry")]
    else:
        lignes = [m.get("geometry") for m in element.get("members", [])]
    return [g for g in lignes if g]


def _blocs(west, south, east, north):
    """Les blocs que touche un rectangle, dans l'ordre : [(bi, bj), …]."""
    return [(bi, bj)
            for bi in range(math.floor(west * BLOCS_PAR_DEGRE), math.floor(east * BLOCS_PAR_DEGRE) + 1)
            for bj in range(math.floor(south * BLOCS_PAR_DEGRE), math.floor(north * BLOCS_PAR_DEGRE) + 1)]


def touche(element, rectangle):
    """Comme le filtre d'Overpass : un nœud dans le rectangle, ou un segment
    qui le traverse. Pas une aire : une partie qui l'englobe n'y était pas."""
    return any(LineString([(p["lon"], p["lat"]) for p in ligne]).intersects(rectangle)
               for ligne in _lignes(element) if len(ligne) >= 2)


class BlocsMonuments:
    """Lecteur des parties OSM d'une emprise, à la place de `fetch_monuments` :
    même réponse, lue par blocs sur disque (`dossier`/carres/osm-monuments-v<n>/
    <bi>/<bj>.json.gz, écrits d'un bloc, sans date de péremption comme les voies
    de vitesses.py). Un bloc sans aucune partie est un fait, gardé comme tel ; un
    échec n'écrit rien. `lire` : (west, south, east, north) -> réponse Overpass
    brute, injectable pour les tests.
    """

    def __init__(self, dossier, lire=None):
        self.dossier = os.path.join(dossier, "carres", f"osm-monuments-v{BLOCS_VERSION}")
        self.lire = lire or (lambda *rectangle: fetch_monuments(*rectangle, extrait=False))
        self._verrous = {}
        self._verrou = threading.Lock()

    def _chemin(self, bi, bj):
        return os.path.join(self.dossier, str(bi), f"{bj}.json.gz")

    def _verrou_de(self, bloc):
        with self._verrou:
            return self._verrous.setdefault(bloc, threading.Lock())

    def __call__(self, west, south, east, north):
        """La réponse d'Overpass pour l'emprise : les éléments qui la touchent,
        dans son ordre (les ways puis les relations, par identifiant) : les
        blocs en portent aussi autour d'elle, et monuments_pour_emprise
        dessine tout ce qu'il reçoit.

        Raises:
            requests.RequestException si un bloc manquant n'a pas pu être lu.
        """
        local = _extrait_de(west, south, east, north)
        if local is not None:
            return local
        blocs = _blocs(west, south, east, north)
        self._completer([b for b in blocs if not os.path.exists(self._chemin(*b))])
        elements = {}
        for bloc in blocs:
            with gzip.open(self._chemin(*bloc), "rt", encoding="utf-8") as f:
                for e in json.load(f)["elements"]:
                    elements[e["type"] != "way", e["id"]] = e
        rectangle = box(west, south, east, north)
        return {"elements": [elements[c] for c in sorted(elements)
                             if touche(elements[c], rectangle)]}

    def _completer(self, blocs):
        """Lit les blocs qui manquent encore une fois leurs verrous pris, en
        une requête ; verrous pris dans l'ordre de `_blocs`, deux lectures qui
        se recouvrent ne peuvent pas s'attendre l'une l'autre."""
        verrous = [self._verrou_de(b) for b in blocs]
        for verrou in verrous:
            verrou.acquire()
        try:
            manquants = [b for b in blocs if not os.path.exists(self._chemin(*b))]
            if not manquants:
                return
            bis, bjs = [b[0] for b in manquants], [b[1] for b in manquants]
            brut = self.lire(min(bis) / BLOCS_PAR_DEGRE, min(bjs) / BLOCS_PAR_DEGRE,
                             (max(bis) + 1) / BLOCS_PAR_DEGRE, (max(bjs) + 1) / BLOCS_PAR_DEGRE)
            par_bloc = {b: [] for b in manquants}
            for e in brut.get("elements", []):
                points = [p for ligne in _lignes(e) for p in ligne]
                if not points:
                    continue
                lons, lats = [p["lon"] for p in points], [p["lat"] for p in points]
                garde = {k: v for k, v in e.items() if k not in ("bounds", "nodes")}
                for b in _blocs(min(lons), min(lats), max(lons), max(lats)):
                    if b in par_bloc:
                        par_bloc[b].append(garde)
            for bloc, elements in par_bloc.items():
                self._ecrire(bloc, elements)
            journal.info("Monuments OSM : %d bloc(s) lu(s), %d élément(s)", len(manquants),
                         len(brut.get("elements", [])))
        finally:
            for verrou in verrous:
                verrou.release()

    def _ecrire(self, bloc, elements):
        chemin = self._chemin(*bloc)
        octets = gzip.compress(json.dumps({"version": BLOCS_VERSION, "bloc": list(bloc),
                                           "lu": date.today().isoformat(), "elements": elements},
                                          separators=(",", ":")).encode())
        os.makedirs(os.path.dirname(chemin), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(chemin))
        with os.fdopen(fd, "wb") as f:
            f.write(octets)
        os.replace(tmp, chemin)

    def oublier(self, west, south, east, north):
        """Efface les blocs de l'emprise : « Reconstruire la scène » relit ses
        parties, et les points voisins aussi, à leur prochaine couche."""
        for bloc in _blocs(west, south, east, north):
            with contextlib.suppress(FileNotFoundError):
                os.remove(self._chemin(*bloc))


def _nombre(texte):
    """« 12 », « 12.5 », « 12,5 » ou « 12 m » ; None sinon."""
    if texte is None:
        return None
    try:
        return float(str(texte).replace(",", ".").replace("m", "").strip())
    except ValueError:
        return None


def _anneaux(brut):
    """(tags, anneau fermé [(lon, lat), …]) de chaque way et outer de relation."""
    for e in brut.get("elements", []):
        tags = e.get("tags") or {}
        if e.get("type") == "way" and e.get("geometry"):
            geoms = [e["geometry"]]
        elif e.get("type") == "relation":
            geoms = [m.get("geometry") for m in e.get("members", [])
                     if m.get("role") == "outer" and m.get("geometry")]
        else:
            continue
        for g in geoms:
            pts = [(p["lon"], p["lat"]) for p in g]
            if len(pts) >= 4 and pts[0] == pts[-1]:
                yield tags, pts


def _cote_min_m(polygone_m):
    # Un contour parfaitement aligné sur les axes fait diviser GEOS par zéro
    # dans oriented_envelope ; le résultat reste juste, on tait l'avertissement.
    with np.errstate(divide="ignore", invalid="ignore"):
        r = polygone_m.minimum_rotated_rectangle.exterior.coords
    return min(math.hypot(r[1][0] - r[0][0], r[1][1] - r[0][1]),
               math.hypot(r[2][0] - r[1][0], r[2][1] - r[1][1]))


def monuments_pour_emprise(west, south, east, north, brut, batiments):
    """Parties de monuments OSM de l'emprise, prêtes pour la scène.

    Args:
        brut: réponse Overpass de `fetch_monuments`.
        batiments: GeoJSON BD TOPO des bâtiments, pour les hauteurs de repli
            et la liste des bâtiments remplacés.

    Returns:
        dict(parties=[{contour, h, h0, toit, nom, bat, estime}],
             remplaces=[cleabs…]) ; None si l'emprise n'a aucune partie.
        `toit` est None (sommet plat) ou {forme, h, orientation}.
    """
    lat0 = (south + north) / 2
    kx = 111320 * math.cos(math.radians(lat0))

    def en_m(geom):
        return shapely.transform(geom, lambda a: a * [kx, 111320])

    bati = []
    for f in (batiments or {}).get("features", []):
        try:
            g = shape(f["geometry"]).buffer(0)
        except Exception:
            continue
        if not g.is_empty:
            bati.append((g, en_m(g), f.get("properties") or {}))

    brutes = []
    for tags, pts in _anneaux(brut):
        poly = Polygon(pts).buffer(0)
        if poly.is_empty or poly.area == 0:
            continue
        centre = poly.representative_point()
        contenant = next((p for g, _, p in bati if g.contains(centre)), None)
        if contenant is None:
            # Un bâtiment coupé par le bord de la scène (vue3d/batiments.py)
            # ne contient plus le centre d'une partie qui en sort avec lui :
            # elle reste la sienne, celle du bâtiment coupé qui la recouvre le
            # plus.
            recouvre = [(g.intersection(poly).area, p) for g, _, p in bati
                        if p.get("coupe") and g.intersects(poly)]
            aire, p = max(recouvre, key=lambda r: r[0], default=(0, None))
            contenant = p if aire > 0 else None
        brutes.append({"tags": tags, "pts": pts, "poly_m": en_m(poly),
                       "contenant": contenant,
                       "h_osm": _nombre(tags.get("height"))})

    # Détection des enveloppes : une partie mesurée qui recouvre une autre
    # partie mesurée plus basse l'avalerait — sa hauteur est celle du sommet
    # du bâtiment, pas du volume, et repart sur le repli.
    for a in brutes:
        if a["h_osm"] is None:
            continue
        for b in brutes:
            if (b is a or b["h_osm"] is None or b["h_osm"] > a["h_osm"]
                    or not b["poly_m"].area):
                continue
            if (b["poly_m"].intersection(a["poly_m"]).area / b["poly_m"].area
                    >= ENVELOPPE_RECOUVREMENT):
                a["h_osm"] = None
                break

    parties, polys_m = [], []
    for e in brutes:
        tags, pts, poly_m, contenant = e["tags"], e["pts"], e["poly_m"], e["contenant"]
        h0 = _nombre(tags.get("min_height")) or 0.0
        h = e["h_osm"]
        estime = h is None
        if h is None:
            h = _nombre(contenant.get("hauteur")) if contenant else None
        if h is None:
            niveaux = _nombre(tags.get("building:levels"))
            h = niveaux * METRES_PAR_NIVEAU if niveaux else None
        if h is None:
            h = HAUTEUR_PAR_DEFAUT_M
        h = max(h, h0 + 1.0)

        toit = None
        forme = FORMES.get(tags.get("roof:shape"))
        if forme:
            h_toit = _nombre(tags.get("roof:height"))
            if h_toit is None:
                h_toit = TOIT_PART_COTE * _cote_min_m(poly_m)
            h_toit = min(h_toit, h - h0)
            orientation = tags.get("roof:orientation")
            toit = {"forme": forme, "h": round(h_toit, 1),
                    "orientation": orientation if orientation in ("along", "across") else None}

        parties.append({
            "contour": [[round(x, DECIMALES), round(y, DECIMALES)] for x, y in pts],
            "h": round(h, 1), "h0": round(h0, 1), "toit": toit,
            "nom": tags.get("name"),
            "bat": (contenant or {}).get("cleabs"),
            "estime": estime,
        })
        polys_m.append(poly_m)

    if not parties:
        return None
    zone = shapely.unary_union(polys_m).buffer(REMPLACEMENT_DILATATION_M)
    remplaces = [p.get("cleabs") for _, g_m, p in bati
                 if p.get("cleabs") and g_m.area
                 and g_m.intersection(zone).area / g_m.area >= REMPLACEMENT_PART]
    return {"parties": parties, "remplaces": remplaces}
