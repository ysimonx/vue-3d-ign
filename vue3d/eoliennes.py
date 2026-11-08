"""Éoliennes d'OpenStreetMap : où elles sont, la hauteur de leur moyeu et le
diamètre de leur rotor.

La BD TOPO place les éoliennes (`construction_ponctuelle`, nature « Eolienne » :
11 090 en France le 8 novembre 2026, dont 10 277 avec une hauteur), mais n'en
dit qu'une hauteur, sans dire ce qu'elle mesure. OpenStreetMap en compte autant
en métropole (10 918, `power=generator` et `generator:source=wind`) et porte de
quoi dessiner une éolienne : la hauteur en bout de pale (`height`, 82 %), celle
du moyeu (`height:hub`, 77 %), le diamètre du rotor (`rotor:diameter`, 80 %), la
puissance (98 %), le modèle et l'exploitant, versés pour l'essentiel des
données des DREAL. Licence ODbL, « © contributeurs OpenStreetMap », comme les
monuments (vue3d/monuments.py).

Mesures du 8 novembre 2026 sur ces 10 918 éoliennes, lues à Overpass
(`python outils/mesure_eoliennes.py osm`) :

- **`height` est la hauteur en bout de pale.** Sur les 8 373 qui portent les
  trois dimensions, (height − height:hub) / (rotor:diameter / 2) vaut 1,00 en
  médiane, et tombe entre 0,8 et 1,2 pour 96 % d'entre elles (COHERENCE).
- **Les 4 % qui restent mêlent trois erreurs**, relevées une à une : une
  altitude au lieu d'une hauteur (un moyeu à 428 m sous un bout de pale à
  200 m, un rotor de 163 m), le rayon du rotor au lieu de son diamètre (41 m
  sur une E-82), la hauteur totale et celle du moyeu inversées (84 et 119 m
  sur une E-70). Deux des trois dimensions suffisent à fixer le moyeu et le
  rotor : on garde la paire la plus vraisemblable, celle dont le rapport du
  moyeu au bout de pale est le plus proche de la médiane, 0,645, et qui tombe
  entre 0,5 et 0,75 (RAPPORT_MOYEU_BORNES). Ces bornes tiennent 98 % des
  paires ; au-delà de 0,75, on ne trouve que les trois erreurs, et du petit
  éolien. Faute de `height:hub`, `height` est aussi parfois le moyeu (80 m sur
  une MM82, dont le rotor fait 82 m) : c'est une paire de plus. Des dimensions
  dont aucune paire n'est vraisemblable ne disent rien.
- **Le petit éolien** a un mât haut pour son rotor (RAPPORT_PETIT) : moins de
  100 kW, ou sans puissance un rotor de moins de 20 m.
- **Une hauteur seule** (370 éoliennes) est tantôt le bout de pale, tantôt le
  moyeu : à Fruges, treize E-70 portent `height=84`, leur moyeu, quand la BD
  TOPO leur donne 122 à 125 m. Elle est celle des deux, moyeu ou bout de pale
  médians de sa classe de puissance, dont elle est le plus proche : contre la
  hauteur BD TOPO (voir plus bas), 291 bonnes réponses sur 329, quand la
  prendre toujours pour le bout de pale n'en donne que 205.
- **Replis, marqués `estime`.** Une hauteur totale seule donne un moyeu à
  0,645 fois elle et le rotor du reste. Sinon, la puissance décide : le rotor
  et le moyeu médians de sa classe passent de 3 m pour moins de 100 kW à 150 m
  au-delà de 4 MW (PAR_PUISSANCE) ; sans puissance, les médianes de toutes,
  92,5 m de rotor et 91 m de moyeu. 16 % des éoliennes n'ont aucune des trois
  dimensions, et 15 % ont leur puissance.

**La BD TOPO ne sert pas de repli de position** (`python outils/mesure_eoliennes.py
bdtopo`). Sur quatre parcs — le plateau d'Aumelas et l'Escandorgue (Hérault ; Le
Caylar n'a d'éolienne à moins de 5 km ni dans l'une ni dans l'autre), Fruges
(Pas-de-Calais), Bouin (Vendée) —, ses 174 éoliennes ont toutes leur jumelle OSM
à moins de 20 m, à 1,5 à 3,7 m en médiane selon le parc, et OSM n'en a pas une
de plus. Sur toute la métropole, 94 % de ses 11 001 éoliennes ont leur jumelle
OSM (1,6 m d'écart médian) ; des 644 autres, 401 sont en projet ou en
construction : il ne manque à OSM que 243 éoliennes en service, 2,3 %, que la
couche n'irait chercher qu'au prix d'une seconde source. Sa hauteur, elle, est
le bout de pale : la plus proche de lui 8 069 fois sur 8 204 éoliennes OSM aux
dimensions connues, à moins de 10 % 7 578 fois. À Aumelas seulement, elle vaut
68 m pour tout le parc. Elle reste une piste de repli pour les éoliennes OSM
sans dimensions (CONTRIBUTING.md).

**Emprise : celle de l'anneau**, comme les lignes à haute tension
(vue3d/lignes.py) : une éolienne de 150 m se voit de plusieurs kilomètres.

**Ce que le LiDAR en voit.** Le MNH ne garde pas les éoliennes : sur 25 mâts
couverts par le LiDAR HD, il ne montre qu'une fois quelque chose à moins de 3 m
du point OSM, 2 m de haut, et pas le mât, qui en fait 67.
Le nuage de points, lui, les classe en « sursol pérenne » (classe 64), mât,
nacelle et pales : son mât donne le rayon que dessine la vue
(`python outils/mesure_eoliennes.py lidar`, static/js/scene/couches/eoliennes.js).
Rien ne passe donc par les houppiers, et la couche est à part, chargée après
la scène, comme les monuments.
"""

import math
import re

from .monuments import DECIMALES, BlocsMonuments, _nombre, interroger_overpass

# Format de la couche. L'incrémenter ne refait que la couche, pas les scènes.
EOLIENNES_VERSION = 1

# Les réponses d'Overpass gardées par bloc de 0,05° (3,5 à 4 km d'est en ouest,
# 5,6 km du sud au nord), et non par 0,01° comme les monuments : la couche
# couvre l'anneau, 5,6 km de côté en zone de 1 000 m, et non l'emprise. Les
# 793 scènes du cache de production rejouées dans l'ordre où elles ont été
# construites, le 8 novembre 2026 :
#
#     bloc    requêtes    blocs écrits    rectangle des manquants
#     0,01°   437         14 249          41,4 km² en médiane (153 au plus)
#     0,02°   389          4 489          49,7 km² (177 au plus)
#     0,05°   316          1 205          86,2 km² (268 au plus)
#     0,10°   248            577          173 km² (527 au plus)
#
# Une éolienne pèse 520 octets dans la réponse (5,9 Mo pour les 11 176 de la
# France entière) : un grand rectangle reste une petite réponse. 0,05° : un quart
# de requêtes en moins, douze fois moins de fichiers, sans demander à une
# instance saturée des surfaces de 500 km².
BLOCS_PAR_DEGRE = 20
BLOCS_VERSION = 1

# (height − height:hub) / (rotor:diameter / 2) d'une éolienne dont les trois
# dimensions se tiennent : 96 % des 8 373 qui les portent.
COHERENCE = (0.8, 1.2)
# Moyeu / bout de pale : 0,645 en médiane sur les 8 029 qui se tiennent (0,63 au
# premier quartile, 0,67 au troisième) ; bornes en tête de module.
RAPPORT_MOYEU = 0.645
RAPPORT_MOYEU_BORNES = (0.5, 0.75)
# Le petit éolien a un mât haut pour son rotor : un rotor de 3,7 m sur 10,4 m
# de mât (Skystream). Sur les 12 éoliennes de moins de 100 kW qui portent le
# moyeu et une autre dimension, le rapport va de 0,78 à 0,90, 0,833 en médiane.
# Sans puissance, un rotor de moins de 20 m le désigne : aucun rotor entre 17 et
# 25 m en métropole.
PETIT_KW = 100
PETIT_ROTOR_M = 20
RAPPORT_PETIT = 0.833
RAPPORT_PETIT_BORNES = (0.75, 0.95)
# Rotor, moyeu et bout de pale médians par classe de puissance, en mètres :
# (puissance inférieure à, en kW ; rotor ; moyeu ; bout de pale). Sur les
# éoliennes qui portent chacune des dimensions ; la puissance les départage
# nettement :
#
#     classe            éoliennes   rotor : p25  médiane  p75   moyeu   bout de pale
#     moins de 100 kW        66        2,4    3,2    3,6     10,4      12,2
#     100 kW à 1 MW         644       48     52     53       51        76
#     1 à 2 MW              421       62     75     77       68       103,2
#     2 à 2,5 MW          6 074       82     90    100       85       130
#     2,5 à 3 MW            722       90    100    103      100       149,8
#     3 à 4 MW            2 099      112    117    131       94,5     150
#     4 MW et plus          664      136    150    154      114       180
PAR_PUISSANCE = ((100, 3.2, 10.4, 12.2), (1000, 52.0, 51.0, 76.0), (2000, 75.0, 68.0, 103.2),
                 (2500, 90.0, 85.0, 130.0), (3000, 100.0, 100.0, 149.8), (4000, 117.0, 94.5, 150.0),
                 (math.inf, 150.0, 114.0, 180.0))
# Sans puissance : rotor et moyeu médians de toutes (8 725 et 8 455 éoliennes).
ROTOR_PAR_DEFAUT_M = 92.5
MOYEU_PAR_DEFAUT_M = 91.0
FILTRE = '["power"="generator"]["generator:source"="wind"]'


def _requete(west, south, east, north):
    rectangle = f"({south},{west},{north},{east})"
    return (f"[out:json][timeout:60];\n(node{FILTRE}{rectangle};\n way{FILTRE}{rectangle};\n);\n"
            "out tags center;")


def fetch_eoliennes(west, south, east, north):
    """Réponse Overpass brute des éoliennes de l'emprise : les nœuds, et les
    ways (le pied dessiné en contour) avec leur centre.

    Raises:
        requests.RequestException si toutes les instances ont échoué.
    """
    return interroger_overpass(_requete(west, south, east, north))


def position(element):
    """{lon, lat} d'une éolienne : le nœud, ou le centre d'un way ; None sans."""
    if element.get("type") == "node":
        return {"lon": element["lon"], "lat": element["lat"]}
    return element.get("center")


class BlocsEoliennes(BlocsMonuments):
    """Lecteur des éoliennes d'une emprise, à la place de `fetch_eoliennes` :
    même réponse, lue par blocs sur disque (`dossier`/carres/osm-eoliennes-v<n>/
    <bi>/<bj>.json.gz), écrits d'un bloc, comme les monuments. Une éolienne est
    rangée dans le bloc de sa place ; un bloc sans éolienne est un fait gardé,
    un échec n'écrit rien.

    La réponse ne porte que les éoliennes dont la place est dans l'emprise,
    les nœuds puis les ways : Overpass y ajoute les ways qui la touchent sans
    que leur centre y soit, qu'eoliennes_pour_emprise écarte de toute façon.
    """

    COUCHE = "osm-eoliennes"
    VERSION = BLOCS_VERSION
    PAR_DEGRE = BLOCS_PAR_DEGRE
    LIBELLE = "Éoliennes OSM"

    @staticmethod
    def _overpass(*rectangle):
        return fetch_eoliennes(*rectangle)

    @staticmethod
    def _extrait(*emprise):
        return None

    @staticmethod
    def _points(element):
        place = position(element)
        return [place] if place else []

    @staticmethod
    def _rendu(element, rectangle):
        west, south, east, north = rectangle.bounds
        place = position(element)
        return bool(place) and west <= place["lon"] <= east and south <= place["lat"] <= north

    @staticmethod
    def _ordre(element):
        return element["type"] != "node", element["id"]


def _positif(texte):
    """Une dimension : « 150 », « 150 m », « 54,3 » ; None si absente, illisible,
    nulle ou négative."""
    v = _nombre(texte)
    return v if v is not None and v > 0 else None


def puissance_kw(texte):
    """« 2.5 MW », « 2,5 MW », « 2. MW », « 800 kW », « 3 W » ; la première
    d'une liste (« 3.3 MW;3 MW ») ; None sinon (« yes », « small_installation »)."""
    if not texte:
        return None
    m = re.fullmatch(r"\s*(\d+(?:[.,]\d*)?)\s*(MW|kW|W)\s*", str(texte).split(";")[0])
    if not m:
        return None
    return float(m.group(1).replace(",", ".")) * {"MW": 1000, "kW": 1, "W": 0.001}[m.group(2)]


def dimensions(tags):
    """(hauteur du moyeu, diamètre du rotor, estime) d'après les tags d'une
    éolienne, en mètres ; `estime` nomme celles qui viennent d'un repli
    (`h_moyeu`, `d_rotor`), vide si les tags les donnent ou les déduisent.
    Règles et mesures en tête de module."""
    total, moyeu, rotor = (_positif(tags.get(k)) for k in ("height", "height:hub", "rotor:diameter"))
    kw = puissance_kw(tags.get("generator:output:electricity"))
    petite = kw < PETIT_KW if kw is not None else rotor is not None and rotor < PETIT_ROTOR_M
    rapport, (bas, haut) = (RAPPORT_PETIT, RAPPORT_PETIT_BORNES) if petite else (RAPPORT_MOYEU,
                                                                                 RAPPORT_MOYEU_BORNES)

    def vraisemblable(paire):
        m, r = paire
        return m > 0 and r > 0 and bas <= m / (m + r / 2) <= haut

    if (moyeu and rotor and vraisemblable((moyeu, rotor))
            and (total is None or COHERENCE[0] <= (total - moyeu) / (rotor / 2) <= COHERENCE[1])):
        return moyeu, rotor, []
    # Chaque paire de dimensions fixe le moyeu et le rotor.
    paires = []
    if moyeu and rotor:
        paires.append((moyeu, rotor))
    if total and rotor:
        paires.append((total - rotor / 2, rotor))
        if moyeu is None:
            # `height` mis pour le moyeu, faute de `height:hub`.
            paires.append((total, rotor))
    if total and moyeu:
        # Un moyeu plus haut que le bout de pale : les deux sont inversées.
        paires.append((moyeu, 2 * (total - moyeu)) if total > moyeu else (total, 2 * (moyeu - total)))
    paires = [p for p in paires if vraisemblable(p)]
    if paires:
        moyeu, rotor = min(paires, key=lambda p: abs(p[0] / (p[0] + p[1] / 2) - rapport))
        return moyeu, rotor, []
    if sum(v is not None for v in (total, moyeu, rotor)) > 1:
        total = moyeu = rotor = None
    if kw is not None:
        _, rotor_classe, moyeu_classe, total_classe = next(c for c in PAR_PUISSANCE if kw < c[0])
    elif petite:
        _, rotor_classe, moyeu_classe, total_classe = PAR_PUISSANCE[0]
    else:
        rotor_classe, moyeu_classe, total_classe = ROTOR_PAR_DEFAUT_M, MOYEU_PAR_DEFAUT_M, None
    if total and (total_classe is None or abs(total - total_classe) <= abs(total - moyeu_classe)):
        return rapport * total, 2 * (1 - rapport) * total, ["h_moyeu", "d_rotor"]
    if total:
        # Plus proche du moyeu de sa classe que de son bout de pale : `height`
        # mis pour le moyeu.
        moyeu = total
    estime = []
    if moyeu is None:
        moyeu = moyeu_classe
        estime.append("h_moyeu")
    if rotor is None:
        rotor = rotor_classe
        estime.append("d_rotor")
    return moyeu, rotor, estime


def _modele(tags):
    """« Vestas V110-2.2MW » : le fabricant devant le modèle, s'il n'y est pas déjà."""
    fabricant, modele = tags.get("manufacturer"), tags.get("model")
    if fabricant and modele and not modele.lower().startswith(fabricant.lower()):
        return f"{fabricant} {modele}"
    return modele or fabricant


def eoliennes_pour_emprise(west, south, east, north, brut):
    """Les éoliennes de l'emprise, prêtes pour la vue.

    Args:
        brut: réponse Overpass de `fetch_eoliennes`, ou de ses blocs.

    Returns:
        dict(eoliennes=[{lon, lat, h_moyeu, d_rotor, h_total, nom, ref,
        operateur, modele, puissance_kw, estime, mer, osm, source}]) ; None si
        l'emprise n'en a aucune, le cas de presque partout. `h_total` est le
        moyeu plus le demi-rotor, la hauteur dessinée ; `osm`, l'objet
        (« node/123 ») ; `mer`, vrai en mer (`offshore=yes`).
    """
    eoliennes = []
    for e in brut.get("elements", []):
        place = position(e)
        if not place or not (west <= place["lon"] <= east and south <= place["lat"] <= north):
            continue
        tags = e.get("tags") or {}
        moyeu, rotor, estime = dimensions(tags)
        kw = puissance_kw(tags.get("generator:output:electricity"))
        eoliennes.append({
            "lon": round(place["lon"], DECIMALES), "lat": round(place["lat"], DECIMALES),
            "h_moyeu": round(moyeu, 1), "d_rotor": round(rotor, 1), "h_total": round(moyeu + rotor / 2, 1),
            "nom": tags.get("name"), "ref": tags.get("ref"), "operateur": tags.get("operator"),
            "modele": _modele(tags), "puissance_kw": round(kw, 1) if kw is not None else None,
            "estime": estime, "mer": tags.get("offshore") == "yes",
            "osm": f"{e['type']}/{e['id']}", "source": "osm",
        })
    return {"eoliennes": eoliennes} if eoliennes else None
