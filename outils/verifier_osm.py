"""Compare une base OpenStreetMap locale (vue3d/osm_local.py) au vrai Overpass,
sur quelques lieux publics : les éléments et ce que les lecteurs en tirent.

    python outils/verifier_osm.py donnees/osm.sqlite

Overpass est en ligne, la base a la date de son extrait : un écart peut être une
modification d'OpenStreetMap postérieure, à vérifier sur la date de l'élément (le
2026-11-06, les 3 voies qui différaient à Strasbourg sur 773 dataient toutes
d'après l'extrait). Une lecture à la fois, sur deux serveurs publics déjà
chargés ; un lieu qu'Overpass ne sert pas est signalé et passé.
"""

import logging
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from vue3d.monuments import fetch_monuments, monuments_pour_emprise
from vue3d.osm_local import lecteur
from vue3d.scene import emprise, point_normalise
from vue3d.signalisation import _requete_bloc as requete_signaux
from vue3d.signalisation import rectangle_bloc as rectangle_signaux
from vue3d.signalisation import signaux_du_bloc
from vue3d.vitesses import BLOC_M, _requete_bloc as requete_voies
from vue3d.vitesses import lambert93, overpass, rectangle_bloc, voies_du_bloc

LIEUX = [("Strasbourg, cathédrale", 48.5818, 7.7510), ("Lyon, Fourvière", 45.7623, 4.8223),
         ("Aix-en-Provence, Rotonde", 43.5263, 5.4454), ("Ajaccio, port", 41.9192, 8.7386)]


def ids(reponse):
    return [(e["type"], e["id"]) for e in reponse["elements"]]


def comparer(nom, direct, local, tirer=None):
    """Une ligne de bilan ; True si les éléments et ce que le lecteur en tire
    sont les mêmes."""
    a, b = ids(direct), ids(local)
    meme_resultat = tirer(direct) == tirer(local)
    ecart = sorted(set(a) ^ set(b))
    bilan = f"  {nom:12} Overpass {len(a):5}, base {len(b):5}"
    if a == b:
        bilan += " : mêmes éléments, même ordre"
    elif not ecart:
        bilan += " : mêmes éléments, ORDRE différent"
    else:
        bilan += f" : {len(ecart)} d'écart, {ecart[:6]}"
    print(f"{bilan} ; résultat {'identique' if meme_resultat else 'DIFFÉRENT'}", flush=True)
    return a == b and meme_resultat


def main():
    logging.disable(logging.INFO)
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    base = lecteur(sys.argv[1])
    identiques = posees = 0
    for nom, lat, lon in LIEUX:
        print(nom, flush=True)
        try:
            x, y = lambert93(lon, lat)
            bloc = (int(x // BLOC_M), int(y // BLOC_M))
            bbox = emprise(*point_normalise(lat, lon), 500)
            questions = [
                ("monuments", lambda: fetch_monuments(*bbox, extrait=False), base.monuments, bbox,
                 lambda r: monuments_pour_emprise(*bbox, r, {"features": []})),
                ("limites", lambda: overpass(requete_voies(*bloc)), base.voies, rectangle_bloc(*bloc), voies_du_bloc),
                ("panneaux", lambda: overpass(requete_signaux(*bloc)), base.signaux,
                 rectangle_signaux(*bloc), signaux_du_bloc),
            ]
            for question, direct, local, rectangle, tirer in questions:
                reponse = direct()
                debut = time.monotonic()
                de_la_base = local(*rectangle)
                print(f"    base lue en {1000 * (time.monotonic() - debut):.1f} ms", flush=True)
                posees += 1
                identiques += comparer(question, reponse, de_la_base, tirer)
        except Exception as exc:
            print(f"  Overpass n'a pas répondu : {str(exc)[:100]}", flush=True)
    print(f"{identiques} questions identiques sur {posees}")


if __name__ == "__main__":
    main()
