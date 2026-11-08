"""Compare une base OpenStreetMap locale (vue3d/osm_local.py) au vrai Overpass,
sur quelques lieux publics : les éléments et ce que les lecteurs en tirent.

    python outils/verifier_osm.py donnees/osm.sqlite [base en service]

Avec la base en service, vérifie aussi que la nouvelle n'a rien perdu en route.
Sort avec 0 si la base est bonne, 1 si elle ne l'est pas, 2 si Overpass a trop
peu répondu pour le dire : ~/Services/rafraichir-osm.sh ne remplace la base en
service que sur un 0.

Overpass est en ligne, la base a la date de son extrait : un écart peut être une
modification d'OpenStreetMap postérieure, à vérifier sur la date de l'élément (le
2026-11-06, les 3 voies qui différaient à Strasbourg sur 773 dataient toutes
d'après l'extrait). Une lecture à la fois, sur deux serveurs publics déjà
chargés ; un lieu qu'Overpass ne sert pas est signalé et passé.
"""

import logging
import os
import sqlite3
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from vue3d.eoliennes import eoliennes_pour_emprise, fetch_eoliennes, position
from vue3d.monuments import _lignes, fetch_monuments, monuments_pour_emprise
from vue3d.osm_local import COUCHES, lecteur
from vue3d.scene import emprise, emprise_anneau, point_normalise
from vue3d.signalisation import _requete_bloc as requete_signaux
from vue3d.signalisation import rectangle_bloc as rectangle_signaux
from vue3d.signalisation import signaux_du_bloc
from vue3d.vitesses import BLOC_M, _requete_bloc as requete_voies
from vue3d.vitesses import lambert93, overpass, rectangle_bloc, voies_du_bloc

LIEUX = [("Strasbourg, cathédrale", 48.5818, 7.7510), ("Lyon, Fourvière", 45.7623, 4.8223),
         ("Aix-en-Provence, Rotonde", 43.5263, 5.4454), ("Ajaccio, port", 41.9192, 8.7386),
         ("Fruges, parc éolien", 50.5285, 2.0850)]


# Part d'éléments qui peuvent différer d'Overpass : la base a un ou deux jours de
# retard sur lui. Le 2026-11-06, à deux jours de son extrait, sur douze questions
# et 4 733 éléments, 3 voies de Strasbourg sur 773 (0,4 %), modifiées depuis, et
# aucune ailleurs. 2 % laisse passer une ville très éditée, pas une base fausse.
ECART_ADMIS = 0.02
# Questions qui doivent avoir eu une réponse, sur vingt, pour conclure : la
# moitié, comme quand il y en avait douze.
QUESTIONS_MIN = 10
# Part de chaque couche de la base en service qu'une nouvelle base doit garder :
# OpenStreetMap ne perd pas 5 % de ses voies en un mois, un extrait tronqué si.
VOLUME_MIN = 0.95


def ids(reponse):
    return [(e["type"], e["id"]) for e in reponse["elements"]]


def identiques(direct, local):
    """Le même élément vu d'Overpass et de la base : mêmes points, mêmes nœuds, et
    les tags que la base garde. Overpass en porte d'autres, qu'elle ne lit pas.
    Le centre d'une éolienne dessinée en way, la base le tire des nœuds, Overpass
    aussi : à un millionième de degré près, 11 cm (14 sur 10 918 s'écartaient d'un
    dix-millionième le 2026-11-09)."""
    if "center" in local:
        return (all(abs(direct["center"][k] - local["center"][k]) <= 1e-6 for k in ("lat", "lon"))
                and all((direct.get("tags") or {}).get(k) == v for k, v in local["tags"].items()))
    if direct["type"] == "node":
        points = lambda e: [(e["lat"], e["lon"])]
    else:
        points = lambda e: [[(p["lat"], p["lon"]) for p in ligne] for ligne in _lignes(e)]
    return (points(direct) == points(local)
            and all((direct.get("tags") or {}).get(k) == v for k, v in local["tags"].items())
            and ("nodes" not in local or direct.get("nodes") == local["nodes"]))


def ecart(direct, local):
    """(éléments qui diffèrent, éléments comparés), ordre compris : un élément
    à la mauvaise place compte comme un élément différent."""
    a, b = {(e["type"], e["id"]): e for e in direct["elements"]}, {(e["type"], e["id"]): e for e in local["elements"]}
    communs = set(a) & set(b)
    differents = len(set(a) ^ set(b)) + sum(not identiques(a[c], b[c]) for c in communs)
    ordre = [c for c in ids(direct) if c in communs] != [c for c in ids(local) if c in communs]
    return differents + (len(communs) if ordre else 0), len(set(a) | set(b))


def verdict(ecarts, questions_min=QUESTIONS_MIN):
    """Le code de sortie, d'après [(éléments qui diffèrent, éléments comparés)]."""
    if any(n > ECART_ADMIS * total for n, total in ecarts):
        return 1
    return 0 if len(ecarts) >= questions_min else 2


def comparer(nom, direct, local, tirer):
    """Une ligne de bilan ; (éléments qui diffèrent, éléments comparés)."""
    n, total = ecart(direct, local)
    bilan = f"  {nom:12} Overpass {len(direct['elements']):5}, base {len(local['elements']):5} : {n} d'écart"
    print(f"{bilan} ; résultat {'identique' if tirer(direct) == tirer(local) else 'DIFFÉRENT'}", flush=True)
    return n, total


def volumes(nouvelle, actuelle):
    """Ce que chaque base contient ; False si la nouvelle a perdu quelque chose,
    ou si elle est plus ancienne que celle en service."""
    def contenu(chemin):
        # Une base d'avant les éoliennes n'en a pas la table : zéro.
        base = sqlite3.connect(f"file:{chemin}?mode=ro", uri=True)
        try:
            tables = {t for (t,) in base.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            return (base.execute("SELECT valeur FROM meta WHERE cle = 'date'").fetchone()[0],
                    {c: base.execute(f"SELECT count(*) FROM {c}").fetchone()[0] if c in tables else 0
                     for c in COUCHES})
        finally:
            base.close()

    (date_n, comptes_n), (date_a, comptes_a) = contenu(nouvelle), contenu(actuelle)
    print(f"Base du {date_n} : {comptes_n}\nEn service, du {date_a} : {comptes_a}", flush=True)
    return date_n >= date_a and all(comptes_n[c] >= VOLUME_MIN * comptes_a[c] for c in COUCHES)


def main():
    logging.disable(logging.INFO)
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    if len(sys.argv) == 3 and not volumes(*sys.argv[1:]):
        print("Base refusée : plus ancienne, ou amputée d'une couche")
        sys.exit(1)
    base = lecteur(sys.argv[1])
    ecarts = []
    for nom, lat, lon in LIEUX:
        print(nom, flush=True)
        try:
            x, y = lambert93(lon, lat)
            bloc = (int(x // BLOC_M), int(y // BLOC_M))
            bbox = emprise(*point_normalise(lat, lon), 500)
            anneau = emprise_anneau(*point_normalise(lat, lon))
            west, south, east, north = anneau

            def eoliennes_direct():
                # Overpass rend aussi les ways qui touchent l'anneau sans que leur
                # centre y soit : la base ne les garde pas, la couche non plus.
                return {"elements": [e for e in fetch_eoliennes(*anneau)["elements"]
                                     if west <= position(e)["lon"] <= east and south <= position(e)["lat"] <= north]}

            questions = [
                ("monuments", lambda: fetch_monuments(*bbox, extrait=False), base.monuments, bbox,
                 lambda r: monuments_pour_emprise(*bbox, r, {"features": []})),
                ("éoliennes", eoliennes_direct, base.eoliennes, anneau,
                 lambda r: eoliennes_pour_emprise(*anneau, r)),
                ("limites", lambda: overpass(requete_voies(*bloc)), base.voies, rectangle_bloc(*bloc), voies_du_bloc),
                ("panneaux", lambda: overpass(requete_signaux(*bloc)), base.signaux,
                 rectangle_signaux(*bloc), signaux_du_bloc),
            ]
            for question, direct, local, rectangle, tirer in questions:
                reponse = direct()
                debut = time.monotonic()
                de_la_base = local(*rectangle)
                print(f"    base lue en {1000 * (time.monotonic() - debut):.1f} ms", flush=True)
                ecarts.append(comparer(question, reponse, de_la_base, tirer))
        except Exception as exc:
            print(f"  Overpass n'a pas répondu : {str(exc)[:100]}", flush=True)
    print(f"{len(ecarts)} questions comparées, {sum(n for n, _ in ecarts)} éléments d'écart "
          f"sur {sum(t for _, t in ecarts)}")
    sys.exit(verdict(ecarts))


if __name__ == "__main__":
    main()
