"""OpenStreetMap sans Overpass : une base locale des seuls objets que le service lit.

Les monuments, les éoliennes, les limites de vitesse et la signalisation lisent
OpenStreetMap.
À Overpass public, c'était la source la plus lente du service et la seule qui
l'ait figé (vue3d/monuments.py) : 40 s en médiane et 250 s au neuvième décile sur
douze jours de lectures, 17 échecs le 4 novembre 2026. Saturée, son instance
principale répond elle-même que l'accès public vise les outils conduits par un
humain, et qu'un usage automatisé doit avoir sa propre instance.

**Pourquoi une base et pas une instance.** Le service ne pose à Overpass que
quatre questions, toujours sur un rectangle : les parties de bâtiments, les
éoliennes, les voies qui portent une limite, les stops, cédez-le-passage et feux
avec les voies qui les portent. Une instance complète saurait répondre à toutes les autres, pour
des dizaines de gigaoctets et un service de plus à faire tourner.

**Comment elle est servie.** Comme le registre des panneaux (vue3d/panneaux.py) :
`outils/preparer_osm.py` lit une fois l'extrait France de Geofabrik et range ces
objets dans une base SQLite avec un index spatial R-tree par couche. Ses réponses
ont la forme de celles d'Overpass, pour les lecteurs de monuments.py,
eoliennes.py, vitesses.py et signalisation.py, qui ne voient pas la différence.

**Une base d'avant les éoliennes** (novembre 2026) reste au format 1 et sert
le reste : la table manque, et les éoliennes se lisent à Overpass jusqu'à la
base suivante (`BaseOsm.a_les_eoliennes`). Sans `VUE3D_OSM`, rien
n'est lu, et le service interroge Overpass comme avant.

**Ce que la base change.** Ses données ont la date de l'extrait, et ne suivent
OpenStreetMap que quand on la reconstruit. Elle s'arrête au contour de l'extrait,
quelques kilomètres au-delà de la frontière par endroits, Monaco compris : Genève,
Bâle et Kehl n'y sont pas, où les données de l'IGN manquent aussi. Licence ODbL,
« © contributeurs OpenStreetMap », comme la vue le cite déjà.
"""

import json
import logging
import os
import sqlite3
import struct

from shapely.geometry import box

from .monuments import touche

journal = logging.getLogger(__name__)

# Format de la base : une base d'un autre format arrête le démarrage. Une
# table de plus (les éoliennes) ne le change pas : un lecteur ne lit que les
# siennes.
OSM_VERSION = 1
# Les tables de la base, une par question posée à Overpass, plus les voies des
# panneaux : une limite sans panneau n'a pas à porter ses nœuds.
COUCHES = ("monuments", "voies", "signaux", "porteuses", "eoliennes")
# Ce que les lecteurs regardent, seul gardé : voies_du_bloc, signaux_du_bloc.
# Les parties gardent tous leurs tags, hauteurs et formes de toit.
CLES_VOIES = ("maxspeed", "maxspeed:forward", "maxspeed:backward")
CLES_SIGNAUX = ("highway", "direction", "traffic_signals:direction")
CLES_PORTEUSES = ("highway",)
TYPES_SIGNAUX = ("stop", "give_way", "traffic_signals")
# Les tags que lit eoliennes_pour_emprise, et les deux qui font une éolienne.
CLES_EOLIENNES = ("power", "generator:source", "height", "height:hub", "rotor:diameter",
                  "generator:output:electricity", "manufacturer", "model", "name", "ref", "operator",
                  "offshore")
# Dans la base, une ligne est une suite d'entiers de 1e-7 degré, l'unité
# d'OpenStreetMap : divisés, ils redonnent au bit près les flottants d'Overpass.
_UNITE = 10 ** 7
_PAQUET = 20000


def _en_blob(ligne):
    entiers = [round(v * _UNITE) for p in ligne for v in (p["lon"], p["lat"])]
    return struct.pack(f"<{len(entiers)}i", *entiers)


def _en_ligne(entiers):
    return [{"lat": entiers[i + 1] / _UNITE, "lon": entiers[i] / _UNITE}
            for i in range(0, len(entiers), 2)]


def _du_blob(blob):
    return _en_ligne(struct.unpack(f"<{len(blob) // 4}i", blob))


def _points(element):
    """Tous les points d'un élément de la forme d'Overpass."""
    if element["type"] == "node":
        return [element]
    if element["type"] == "way":
        return element["geometry"]
    return [p for m in element["members"] for p in m["geometry"]]


class Ecrivain:
    """Range des éléments de la forme d'Overpass dans une base neuve, écrite à
    côté de `sortie` et mise à sa place entière par `fermer`."""

    def __init__(self, sortie):
        self.sortie = sortie
        self._tmp = f"{sortie}.tmp"
        if os.path.exists(self._tmp):
            os.remove(self._tmp)
        self.base = sqlite3.connect(self._tmp)
        # Une base qu'un échec fait jeter : ni journal ni attente du disque.
        self.base.executescript("PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;"
                                "CREATE TABLE meta (cle TEXT PRIMARY KEY, valeur TEXT);")
        for c in COUCHES:
            self.base.executescript(f"""
                CREATE TABLE {c} (id INTEGER PRIMARY KEY, type TEXT, osm INTEGER, tags TEXT,
                                  ligne BLOB, membres TEXT, noeuds BLOB);
                CREATE VIRTUAL TABLE {c}_emprises USING rtree(id, lon_min, lon_max, lat_min, lat_max);
            """)
        self.comptes = dict.fromkeys(COUCHES, 0)
        self._lignes = {c: [] for c in COUCHES}
        self._emprises = {c: [] for c in COUCHES}

    def ajouter(self, couche, e):
        points = _points(e)
        if not points:
            return
        self.comptes[couche] += 1
        n = self.comptes[couche]
        lons, lats = [p["lon"] for p in points], [p["lat"] for p in points]
        membres = None
        if e["type"] == "relation":
            membres = json.dumps([[m["role"], [round(v * _UNITE) for p in m["geometry"]
                                               for v in (p["lon"], p["lat"])]]
                                  for m in e["members"]], separators=(",", ":"))
        noeuds = e.get("nodes")
        self._lignes[couche].append((
            n, e["type"], e["id"], json.dumps(e.get("tags") or {}, ensure_ascii=False, separators=(",", ":")),
            None if membres else _en_blob(points), membres,
            struct.pack(f"<{len(noeuds)}q", *noeuds) if noeuds else None))
        self._emprises[couche].append((n, min(lons), max(lons), min(lats), max(lats)))
        if len(self._lignes[couche]) >= _PAQUET:
            self._vider(couche)

    def _vider(self, couche):
        self.base.executemany(f"INSERT INTO {couche} VALUES (?, ?, ?, ?, ?, ?, ?)", self._lignes[couche])
        self.base.executemany(f"INSERT INTO {couche}_emprises VALUES (?, ?, ?, ?, ?)", self._emprises[couche])
        self._lignes[couche], self._emprises[couche] = [], []

    def fermer(self, date):
        """Met la base à sa place, avec la date de ses données."""
        for c in COUCHES:
            self._vider(c)
        self.base.executemany("INSERT INTO meta VALUES (?, ?)",
                              [("version", str(OSM_VERSION)), ("date", date)])
        self.base.commit()
        self.base.close()
        os.replace(self._tmp, self.sortie)


def _element(type_, osm, tags, ligne, membres, noeuds):
    e = {"type": type_, "id": osm, "tags": json.loads(tags)}
    if type_ == "node":
        e.update(_du_blob(ligne)[0])
    elif type_ == "way":
        e["geometry"] = _du_blob(ligne)
        if noeuds:
            e["nodes"] = list(struct.unpack(f"<{len(noeuds) // 8}q", noeuds))
    else:
        e["members"] = [{"role": role, "geometry": _en_ligne(entiers)}
                        for role, entiers in json.loads(membres)]
    return e


class OsmMalConfigure(RuntimeError):
    """`VUE3D_OSM` désigne une base introuvable ou d'un autre format : erreur de
    déploiement, dite au démarrage."""


class BaseOsm:
    """Les quatre questions du service, sur un rectangle (west, south, east,
    north) : mêmes réponses qu'Overpass, mêmes éléments dans le même ordre."""

    def __init__(self, chemin):
        self.chemin = chemin
        base = sqlite3.connect(f"file:{chemin}?mode=ro", uri=True)
        try:
            tables = {t for (t,) in base.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
        finally:
            base.close()
        self.a_les_eoliennes = "eoliennes" in tables

    def _elements(self, couche, west, south, east, north):
        # Une connexion par lecture, comme les panneaux : les lectures partent
        # de plusieurs fils, et une base refaite est vue sans redémarrage.
        base = sqlite3.connect(f"file:{self.chemin}?mode=ro", uri=True)
        try:
            lignes = base.execute(
                f"SELECT c.type, c.osm, c.tags, c.ligne, c.membres, c.noeuds FROM {couche}_emprises e "
                f"JOIN {couche} c ON c.id = e.id "
                "WHERE e.lon_max >= ? AND e.lon_min <= ? AND e.lat_max >= ? AND e.lat_min <= ?",
                (west, east, south, north)).fetchall()
        finally:
            base.close()
        return [_element(*ligne) for ligne in lignes]

    def monuments(self, west, south, east, north):
        """Les parties de bâtiments, comme `monuments.fetch_monuments` : les
        ways puis les relations, par identifiant."""
        rectangle = box(west, south, east, north)
        return {"elements": sorted((e for e in self._elements("monuments", west, south, east, north)
                                    if touche(e, rectangle)),
                                   key=lambda e: (e["type"] != "way", e["id"]))}

    def eoliennes(self, west, south, east, north):
        """Les éoliennes dont la place est dans le rectangle, comme
        `eoliennes.BlocsEoliennes` : les nœuds puis les ways, par identifiant ;
        un way n'a que son centre, comme dans `out center`."""
        trouvees = [{"type": "way", "id": e["id"], "center": e["geometry"][0], "tags": e["tags"]}
                    if e["type"] == "way" else e
                    for e in self._elements("eoliennes", west, south, east, north)]
        return {"elements": sorted(trouvees, key=lambda e: (e["type"] != "node", e["id"]))}

    def voies(self, west, south, east, north):
        """Les voies qui portent une limite, comme `vitesses._requete_bloc`."""
        rectangle = box(west, south, east, north)
        return {"elements": sorted((e for e in self._elements("voies", west, south, east, north)
                                    if touche(e, rectangle)), key=lambda e: e["id"])}

    def signaux(self, west, south, east, north):
        """Les panneaux du rectangle puis les voies qui les portent, entières,
        comme `signalisation._requete_bloc`. Une voie qui porte un panneau du
        rectangle le traverse forcément : son emprise suffit à la trouver."""
        noeuds = sorted((e for e in self._elements("signaux", west, south, east, north)
                         if west <= e["lon"] <= east and south <= e["lat"] <= north),
                        key=lambda e: e["id"])
        ids = {e["id"] for e in noeuds}
        return {"elements": noeuds + sorted(
            (e for e in self._elements("porteuses", west, south, east, north)
             if not ids.isdisjoint(e["nodes"])), key=lambda e: e["id"])}


def lecteur(chemin=None):
    """La `BaseOsm` de `VUE3D_OSM` (chemin de la base SQLite) ; None si la
    variable est vide, OpenStreetMap se lit alors à Overpass.

    Raises:
        OsmMalConfigure si la base est introuvable ou d'un autre format.
    """
    chemin = (os.environ.get("VUE3D_OSM", "") if chemin is None else chemin).strip()
    if not chemin:
        return None
    commande = f"python outils/preparer_osm.py france-latest.osm.pbf {chemin}"
    if not os.path.exists(chemin):
        raise OsmMalConfigure(f"VUE3D_OSM={chemin} : base introuvable ; {commande}")
    base = sqlite3.connect(f"file:{chemin}?mode=ro", uri=True)
    try:
        meta = dict(base.execute("SELECT cle, valeur FROM meta").fetchall())
    finally:
        base.close()
    if meta.get("version") != str(OSM_VERSION):
        raise OsmMalConfigure(f"VUE3D_OSM={chemin} : format {meta.get('version')}, "
                              f"{OSM_VERSION} attendu ; {commande}")
    journal.info("OpenStreetMap : base locale %s, données du %s", chemin, meta.get("date"))
    lue = BaseOsm(chemin)
    if not lue.a_les_eoliennes:
        journal.warning("OpenStreetMap : base d'avant les éoliennes, lues à Overpass ; %s", commande)
    return lue
