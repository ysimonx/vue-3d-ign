"""Prépare la base OpenStreetMap locale (vue3d/osm_local.py) depuis l'extrait
France de Geofabrik.

    pip install osmium                      # hors requirements, comme ifcopenshell
    curl -L -o donnees/france-latest.osm.pbf \\
        https://download.geofabrik.de/europe/france-latest.osm.pbf
    python outils/preparer_osm.py donnees/france-latest.osm.pbf donnees/osm.sqlite

La base est écrite à côté de la sortie et mise à sa place entière à la fin : le
service, qui la rouvre à chaque lecture, voit la nouvelle sans redémarrer.

Trois passages sur le fichier, parce qu'il range les nœuds, puis les ways, puis
les relations : les relations d'abord, pour savoir quels ways elles demandent ;
puis les nœuds et les ways ; puis ces ways-là, qui n'ont souvent aucun tag.
"""

import logging
import os
import sys
import time

import osmium
import osmium.filter

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from vue3d.osm_local import (CLES_PORTEUSES, CLES_SIGNAUX, CLES_VOIES, COUCHES, TYPES_SIGNAUX,
                             Ecrivain)

journal = logging.getLogger("preparer_osm")


def _tags(objet, cles=None):
    if cles is None:
        return {t.k: t.v for t in objet.tags}
    return {k: objet.tags[k] for k in cles if k in objet.tags}


def _geometrie(way):
    """[(nœud, {lon, lat})] des nœuds situés : un way qui sort de l'extrait perd
    ceux d'au-delà de son contour."""
    return [(n.ref, {"lon": n.lon, "lat": n.lat}) for n in way.nodes if n.location.valid()]


def relations(pbf):
    """{relation : (tags, [(rôle, way)])} des parties de bâtiments."""
    trouvees = {}
    for r in osmium.FileProcessor(pbf, osmium.osm.RELATION).with_filter(
            osmium.filter.KeyFilter("building:part")):
        if r.tags["building:part"] != "no":
            trouvees[r.id] = (_tags(r), [(m.role, m.ref) for m in r.members if m.type == "w"])
    return trouvees


def noeuds_et_voies(pbf, ecrivain):
    """Les panneaux, les parties en ways, les voies à limite, les voies à panneau."""
    panneaux = set()
    for o in osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations().with_filter(
            osmium.filter.KeyFilter("highway", "building:part")):
        if o.is_node():
            if o.tags.get("highway") in TYPES_SIGNAUX and o.location.valid():
                panneaux.add(o.id)
                ecrivain.ajouter("signaux", {"type": "node", "id": o.id, "lon": o.location.lon,
                                             "lat": o.location.lat, "tags": _tags(o, CLES_SIGNAUX)})
            continue
        partie = o.tags.get("building:part", "no") != "no"
        route = "highway" in o.tags
        limite = route and any(k in o.tags for k in CLES_VOIES)
        porteuse = route and not panneaux.isdisjoint(n.ref for n in o.nodes)
        if not (partie or limite or porteuse):
            continue
        situes = _geometrie(o)
        if len(situes) < 2:
            continue
        geometrie = [p for _, p in situes]
        base = {"type": "way", "id": o.id, "geometry": geometrie}
        if partie:
            ecrivain.ajouter("monuments", {**base, "tags": _tags(o)})
        if limite:
            ecrivain.ajouter("voies", {**base, "tags": _tags(o, CLES_VOIES)})
        if porteuse:
            ecrivain.ajouter("porteuses", {**base, "tags": _tags(o, CLES_PORTEUSES),
                                           "nodes": [n for n, _ in situes]})


def membres(pbf, ids):
    """{way : géométrie} des membres des relations."""
    trouves = {}
    for w in (osmium.FileProcessor(pbf, osmium.osm.NODE | osmium.osm.WAY).with_locations()
              .with_filter(osmium.filter.EntityFilter(osmium.osm.WAY))
              .with_filter(osmium.filter.IdFilter(ids))):
        trouves[w.id] = [p for _, p in _geometrie(w)]
    return trouves


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    pbf, sortie = sys.argv[1:]
    debut = time.monotonic()

    def etape(message, *args):
        journal.info("%4.0f s  " + message, time.monotonic() - debut, *args)

    date = osmium.io.Reader(pbf, osmium.osm.NOTHING).header().get("osmosis_replication_timestamp", "")[:10]
    etape("Extrait du %s", date or "?")
    rel = relations(pbf)
    etape("%d relations de parties", len(rel))
    ecrivain = Ecrivain(sortie)
    noeuds_et_voies(pbf, ecrivain)
    etape("Nœuds et ways : %s", ecrivain.comptes)
    geometries = membres(pbf, {w for _, ms in rel.values() for _, w in ms})
    for r, (tags, ms) in rel.items():
        lignes = [{"role": role, "geometry": geometries[w]} for role, w in ms if geometries.get(w)]
        if lignes:
            ecrivain.ajouter("monuments", {"type": "relation", "id": r, "tags": tags, "members": lignes})
    vides = [c for c in COUCHES if not ecrivain.comptes[c]]
    if vides:
        sys.exit(f"Couches vides : {vides}, base non écrite")
    ecrivain.fermer(date)
    etape("%s : %s, %.0f Mo", sortie, ecrivain.comptes, os.path.getsize(sortie) / 1e6)


if __name__ == "__main__":
    main()
