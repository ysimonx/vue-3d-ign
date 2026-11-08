"""Mesures de la couche des éoliennes (vue3d/eoliennes.py), sur des données réelles.

    python outils/mesure_eoliennes.py osm donnees/eoliennes-france.json
    python outils/mesure_eoliennes.py bdtopo donnees/eoliennes-france.json
    python outils/mesure_eoliennes.py lidar donnees/eoliennes-france.json
    python outils/mesure_eoliennes.py blocs ~/Services/vue-3d-ign/cache

- `osm` : les tags des éoliennes de métropole, ce que mesure `height`, les
  erreurs, les replis par classe de puissance, et ce que dimensions() en fait.
  Le fichier est la réponse d'Overpass pour la France entière : lue une fois
  (six minutes le 8 novembre 2026) et gardée là, hors du dépôt (/donnees/).
- `bdtopo` : les éoliennes de la BD TOPO contre celles d'OSM sur quatre parcs :
  positions appariées à moins de 20 m, et ce que recoupe la hauteur BD TOPO.
- `lidar` : ce que le LiDAR HD voit des mâts de ces parcs — le MNH à 0,5 m de
  la scène, puis le nuage de points, où l'on ajuste un cercle au mât, tranche
  par tranche, sous les pales.
- `blocs` : la taille des blocs d'Overpass, en rejouant les scènes d'un cache
  dans l'ordre où elles ont été construites.
"""

import collections
import json
import math
import os
import re
import statistics
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vue3d.eoliennes import (COHERENCE, FILTRE, PAR_PUISSANCE, PETIT_KW, PETIT_ROTOR_M, RAPPORT_MOYEU_BORNES,
                             _positif, dimensions, position, puissance_kw)
from vue3d.monuments import interroger_overpass
from vue3d.scene import EMPRISE_SERVIE, emprise_anneau

# Les parcs comparés : le plateau d'Aumelas et l'Escandorgue (Hérault ; Le
# Caylar n'a aucune éolienne à moins de 5 km), Fruges (Pas-de-Calais), Bouin
# (Vendée), sur un carré de 0,1° de côté du nord au sud.
PARCS = {"Aumelas": (43.535, 3.62), "Escandorgue": (43.77, 3.19), "Fruges": (50.51, 2.13),
         "Bouin": (46.96, -2.04)}
# Pour le LiDAR, trois parcs de grandes machines en plus : des V150 de 127 m de
# moyeu dans l'Aube, des E-138 de 131 m dans le Nord, des V126 de 137 m dans les
# Côtes-d'Armor.
PARCS_LIDAR = {**PARCS, "Aube (V150)": (48.6811, 3.9754), "Nord (E-138)": (50.2256, 2.9733),
               "Côtes-d'Armor (V126)": (48.0274, -2.5358)}
DEMI_COTE = 0.05
APPARIEMENT_M = 20.0
# Mâts lus dans le nuage, par parc : chacun coûte quelques secondes de COPC.
MATS_PAR_PARC = 6
TRANCHE_M = 5.0
# Points du mât : à moins de ce rayon du point OSM (2 à 4 m d'écart avec la
# BD TOPO), jusque sous la nacelle (moyeu − marge). Une pale qui descend près
# du mât y laisse quelques points, que l'ajustement écarte : un point à plus de
# ECART_CERCLE_M du premier cercle n'est pas sur le mât.
RAYON_MAT_M = 6.0
MARGE_NACELLE_M = 6.0
ECART_CERCLE_M = 0.4
SAUT_PALE_M = 0.25
POINTS_MIN = 15


def france(chemin):
    """Les éoliennes de métropole, lues à Overpass si le fichier manque."""
    if not os.path.exists(chemin):
        requete = ('[out:json][timeout:900];area["ISO3166-1"="FR"][admin_level=2]->.fr;'
                   f"(node{FILTRE}(area.fr);way{FILTRE}(area.fr););out tags center;")
        os.makedirs(os.path.dirname(chemin) or ".", exist_ok=True)
        with open(chemin, "w", encoding="utf-8") as f:
            json.dump(interroger_overpass(requete), f)
    with open(chemin, encoding="utf-8") as f:
        brut = json.load(f)
    (lat0, lat1), (lon0, lon1) = EMPRISE_SERVIE["lat"], EMPRISE_SERVIE["lon"]
    return brut, [e for e in brut["elements"] if position(e)
                  and lat0 <= position(e)["lat"] <= lat1 and lon0 <= position(e)["lon"] <= lon1]


def quartiles(valeurs):
    v = sorted(valeurs)
    if len(v) < 4:
        return f"{len(v)} : {v}"
    q = statistics.quantiles(v, n=4)
    return f"{len(v)}, p25 {q[0]:.2f}, médiane {statistics.median(v):.2f}, p75 {q[2]:.2f}"


def mesurer_osm(chemin):
    brut, met = france(chemin)
    print(f"{len(brut['elements'])} éoliennes en France, {len(met)} en métropole "
          f"({collections.Counter(e['type'] for e in met)}), base OSM du {brut['osm3s']['timestamp_osm_base']}")
    trios = [(_positif(e["tags"].get("height")), _positif(e["tags"].get("height:hub")),
              _positif(e["tags"].get("rotor:diameter")), puissance_kw(e["tags"].get("generator:output:electricity")),
              e["tags"]) for e in met]
    for nom, i in (("height", 0), ("height:hub", 1), ("rotor:diameter", 2), ("puissance, kW", 3)):
        v = [t[i] for t in trios if t[i] is not None]
        print(f"- {nom} : {len(v) / len(met):.1%}, {quartiles(v)}")
    complets = [(h, m, r) for h, m, r, _, _ in trios if h and m and r]
    rapports = [(h - m) / (r / 2) for h, m, r in complets]
    dedans = sum(COHERENCE[0] <= x <= COHERENCE[1] for x in rapports)
    print(f"\n(height − hub) / (rotor / 2) sur {len(complets)} : médiane {statistics.median(rapports):.3f}, "
          f"{dedans / len(complets):.1%} dans {COHERENCE}, {sum(0.9 <= x <= 1.1 for x in rapports) / len(complets):.1%} "
          "dans (0,9, 1,1)")
    print("  histogramme :", sorted(collections.Counter(round(x, 1) for x in rapports).items()))
    tenus = [(h, m, r) for h, m, r in complets if COHERENCE[0] <= (h - m) / (r / 2) <= COHERENCE[1]]
    print(f"moyeu / bout de pale sur les {len(tenus)} qui se tiennent : {quartiles([m / h for h, m, r in tenus])}")
    paires = [m / (m + r / 2) for h, m, r, _, _ in trios if m and r]
    print(f"moyeu / (moyeu + rotor / 2) des {len(paires)} paires : "
          f"{sum(RAPPORT_MOYEU_BORNES[0] <= x <= RAPPORT_MOYEU_BORNES[1] for x in paires) / len(paires):.1%} "
          f"dans {RAPPORT_MOYEU_BORNES} ; au-delà de 0,74 :",
          sorted((k, n) for k, n in collections.Counter(round(x, 2) for x in paires).items() if k > 0.74))
    petites = [m / h if h else m / (m + r / 2) for h, m, r, kw, _ in trios
               if m and (h or r) and (kw < PETIT_KW if kw is not None else (r or PETIT_ROTOR_M) < PETIT_ROTOR_M)]
    print(f"petit éolien, moyeu / bout de pale : {sorted(round(x, 3) for x in petites)}, "
          f"médiane {statistics.median(petites):.3f}")
    print("rotors de 15 à 30 m :", sorted(t[2] for t in trios if t[2] and 15 <= t[2] <= 30))
    print("\nPar classe de puissance (rotor | moyeu | bout de pale) :")
    bas = 0
    for haut, rotor, moyeu, bout in PAR_PUISSANCE:
        classe = [t for t in trios if t[3] is not None and bas <= t[3] < haut]
        print(f"  [{bas}, {haut}) kW, {len(classe)} : {quartiles([t[2] for t in classe if t[2]])} | "
              f"{quartiles([t[1] for t in classe if t[1]])} | {quartiles([t[0] for t in classe if t[0]])}"
              f"   (retenus : rotor {rotor}, moyeu {moyeu}, bout de pale {bout})")
        bas = haut
    motifs = collections.Counter((h is not None, m is not None, r is not None) for h, m, r, _, _ in trios)
    print("\nDimensions présentes (height, hub, rotor) :", dict(motifs))
    print(f"Aucune des trois : {motifs[False, False, False]}, dont "
          f"{sum(1 for h, m, r, p, _ in trios if not (h or m or r) and p is not None)} avec leur puissance")
    print("\nCe que dimensions() en fait :")
    issues = collections.Counter()
    for h, m, r, _, tags in trios:
        moyeu, rotor, estime = dimensions(tags)
        if estime:
            issues["repli : " + ", ".join(estime)] += 1
        elif (moyeu, rotor) == (m, r):
            issues["tags tels quels"] += 1
        else:
            issues["déduites d'une autre paire"] += 1
    for issue, n in issues.most_common():
        print(f"  {issue} : {n} ({n / len(met):.1%})")
    seules = [h for h, m, r, _, _ in trios if h and not m and not r]
    print(f"Hauteur seule : {len(seules)}, {quartiles(seules)}, au-delà de 250 m : {sum(h > 250 for h in seules)}")


def _metres(lat):
    return 111320 * math.cos(math.radians(lat)), 111320


def _parc(met, lat, lon):
    kx, _ = _metres(lat)
    dlon = DEMI_COTE * 111320 / kx
    return [e for e in met if abs(position(e)["lat"] - lat) < DEMI_COTE and abs(position(e)["lon"] - lon) < dlon], \
        (lon - dlon, lat - DEMI_COTE, lon + dlon, lat + DEMI_COTE)


def mesurer_bdtopo(chemin):
    from vue3d.constructions import COUCHE_PONCTUELLES
    from vue3d.couches import lire_couche
    _, met = france(chemin)
    bilan = collections.Counter()
    for nom, (lat, lon) in PARCS.items():
        osm, rectangle = _parc(met, lat, lon)
        bd = [f for f in lire_couche(COUCHE_PONCTUELLES, *rectangle)["features"]
              if f["properties"].get("nature") == "Eolienne"]
        kx, ky = _metres(lat)
        ecarts, proches = [], collections.Counter()
        for f in bd:
            x, y = f["geometry"]["coordinates"][:2]
            d, e = min(((math.hypot((position(e)["lon"] - x) * kx, (position(e)["lat"] - y) * ky), e) for e in osm),
                       key=lambda c: c[0], default=(math.inf, None))
            ecarts.append(d)
            h = f["properties"].get("hauteur")
            if d > APPARIEMENT_M or not h:
                continue
            moyeu, rotor, estime = dimensions(e["tags"])
            if estime:
                proches["éolienne OSM sans dimensions"] += 1
                continue
            bout = moyeu + rotor / 2
            proches["bout de pale" if abs(h - bout) < abs(h - moyeu) else "moyeu"] += 1
            if abs(h - bout) <= 0.1 * bout:
                proches["à 10 % du bout de pale"] += 1
        apparies = sum(d <= APPARIEMENT_M for d in ecarts)
        print(f"{nom} : BD TOPO {len(bd)}, OSM {len(osm)}, appariées à moins de {APPARIEMENT_M:.0f} m : "
              f"{apparies}, écart médian {statistics.median(ecarts):.1f} m ; hauteur BD TOPO "
              f"{sum(1 for f in bd if f['properties'].get('hauteur'))} fois ; plus proche du {dict(proches)}")
        bilan.update(proches)
    print("Ensemble :", dict(bilan))
    national(chemin, met)


def bdtopo_france(chemin):
    """Toutes les éoliennes de la BD TOPO, en trois pages de WFS, gardées à
    côté de la réponse d'Overpass."""
    import requests
    if not os.path.exists(chemin):
        pages = []
        while not pages or len(pages[-1]) == 5000:
            r = requests.get("https://data.geopf.fr/wfs/ows", timeout=120, headers={"User-Agent": "vue-3d-ign"},
                             params={"SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature",
                                     "TYPENAMES": "BDTOPO_V3:construction_ponctuelle",
                                     "CQL_FILTER": "nature='Eolienne'", "OUTPUTFORMAT": "application/json",
                                     "SRSNAME": "EPSG:4326", "COUNT": 5000, "STARTINDEX": 5000 * len(pages),
                                     "SORTBY": "cleabs"})
            r.raise_for_status()
            pages.append(r.json()["features"])
        with open(chemin, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": [x for p in pages for x in p]}, f)
    with open(chemin, encoding="utf-8") as f:
        (lat0, lat1), (lon0, lon1) = EMPRISE_SERVIE["lat"], EMPRISE_SERVIE["lon"]
        return [x for x in json.load(f)["features"]
                if lat0 <= x["geometry"]["coordinates"][1] <= lat1 and lon0 <= x["geometry"]["coordinates"][0] <= lon1]


def national(chemin, met):
    """BD TOPO contre OSM sur toute la métropole : positions, hauteur, et les
    hauteurs OSM seules, bout de pale ou moyeu."""
    bd = bdtopo_france(os.path.join(os.path.dirname(chemin), "eoliennes-bdtopo.json"))
    cases = collections.defaultdict(list)
    for e in met:
        p = position(e)
        cases[int(p["lon"] * 500), int(p["lat"] * 500)].append(e)

    def plus_proche(lon, lat, rayon_cases=1):
        kx, ky = _metres(lat)
        i, j = int(lon * 500), int(lat * 500)
        return min(((math.hypot((position(e)["lon"] - lon) * kx, (position(e)["lat"] - lat) * ky), e)
                    for di in range(-rayon_cases, rayon_cases + 1) for dj in range(-rayon_cases, rayon_cases + 1)
                    for e in cases[i + di, j + dj]), key=lambda c: c[0], default=(math.inf, None))

    paires, seules_bd = [], []
    for f in bd:
        d, e = plus_proche(*f["geometry"]["coordinates"][:2])
        (paires.append((f, e, d)) if d <= APPARIEMENT_M else seules_bd.append(f))
    print(f"\nMétropole : BD TOPO {len(bd)}, OSM {len(met)} ; appariées à moins de {APPARIEMENT_M:.0f} m : "
          f"{len(paires)} ({len(paires) / len(bd):.1%}), écart médian {statistics.median(d for *_, d in paires):.1f} m")
    print(f"BD TOPO sans OSM : {len(seules_bd)}, "
          f"{dict(collections.Counter(f['properties'].get('etat_de_l_objet') for f in seules_bd))} ; "
          f"en service dans la BD TOPO : {sum(1 for f in bd if f['properties'].get('etat_de_l_objet') == 'En service')}")
    hauteur, seules = collections.Counter(), []
    for f, e, _ in paires:
        h_bd = f["properties"].get("hauteur")
        if not h_bd:
            continue
        t = e["tags"]
        total, moyeu, rotor = (_positif(t.get(k)) for k in ("height", "height:hub", "rotor:diameter"))
        if total and not moyeu and not rotor:
            seules.append((total, h_bd, dimensions(t)))
            continue
        m, r, estime = dimensions(t)
        if estime:
            continue
        bout = m + r / 2
        hauteur["bout de pale" if abs(h_bd - bout) < abs(h_bd - m) else "moyeu"] += 1
        hauteur["à 10 % du bout de pale"] += abs(h_bd - bout) <= 0.1 * bout
    print(f"Hauteur BD TOPO, plus proche du {dict(hauteur)}")
    # Une hauteur OSM seule : le moyeu quand la BD TOPO (le bout de pale) la
    # dépasse de plus d'un cinquième.
    juste = sum((h_bd / h >= 1.2) == ("h_moyeu" not in estime) for h, h_bd, (_, _, estime) in seules)
    print(f"Hauteurs OSM seules face à une hauteur BD TOPO : {len(seules)}, dont "
          f"{sum(h_bd / h >= 1.2 for h, h_bd, _ in seules)} moyeux (BD TOPO plus haute d'un cinquième) ; "
          f"dimensions() juste {juste} fois, « toujours le bout de pale » "
          f"{sum(h_bd / h < 1.2 for h, h_bd, _ in seules)} fois")


def _cercle(x, y):
    """Centre et rayon du cercle ajusté aux points (moindres carrés de Kåsa)."""
    a = np.c_[x, y, np.ones_like(x)]
    (d, e, f), *_ = np.linalg.lstsq(a, -(x * x + y * y), rcond=None)
    cx, cy = -d / 2, -e / 2
    return cx, cy, math.sqrt(max(cx * cx + cy * cy - f, 0.0))


def _cercle_robuste(x, y):
    """Le cercle des points du mât, sans ceux qui s'en écartent (une pale) ;
    None s'il en reste trop peu."""
    cx, cy, r = _cercle(x, y)
    garde = np.abs(np.hypot(x - cx, y - cy) - r) < ECART_CERCLE_M
    if garde.sum() < POINTS_MIN:
        return None
    return _cercle(x[garde], y[garde])


def mesurer_lidar(chemin):
    from vue3d.constructions import _Grille, sommet_lidar
    from vue3d.couches import lire_couche
    from vue3d.mnh import fetch_mnh_grid
    from vue3d.nuage import CLASSE_SOL, COUCHE_DALLES, lire_points, vers_lambert93
    _, met = france(chemin)
    vus, couverts, mats = 0, 0, []
    for nom, (lat, lon) in PARCS_LIDAR.items():
        osm, _ = _parc(met, lat, lon)
        retenues = [e for e in osm if not dimensions(e["tags"])[2]][:MATS_PAR_PARC]
        for e in retenues:
            place = position(e)
            kx, ky = _metres(place["lat"])
            r = 30.0
            bbox = (place["lon"] - r / kx, place["lat"] - r / ky, place["lon"] + r / kx, place["lat"] + r / ky)
            grille = fetch_mnh_grid(*bbox, resolution_m=0.5, max_pixels=2048)
            h_mnh = None
            if grille.get("source") == "lidar_hd":
                couverts += 1
                h_mnh = sommet_lidar(place["lon"], place["lat"], _Grille(grille), (kx, ky))[0]
                vus += h_mnh is not None
            moyeu, rotor, _ = dimensions(e["tags"])
            x0, y0 = (float(v[0]) for v in vers_lambert93([place["lon"]], [place["lat"]]))
            # Le nuage peut être livré là où le MNH ne l'est pas encore.
            urls = [f["properties"]["url_npl"] for f in lire_couche(COUCHE_DALLES, *bbox)["features"]]
            if not urls:
                print(f"{nom} {e['type']}/{e['id']} : pas de nuage LiDAR HD")
                continue
            lus = [lire_points(u, x0 - 25, y0 - 25, x0 + 25, y0 + 25)[0] for u in urls]
            x, y, z, c = (np.concatenate(t) for t in zip(*lus))
            x, y = x - x0, y - y0
            d = np.hypot(x, y)
            sol = np.median(z[(c == CLASSE_SOL) & (d < 10)])
            hz = z - sol
            mat = (c == 64) & (d < RAYON_MAT_M)
            rayons = []
            for bas in np.arange(TRANCHE_M, moyeu - MARGE_NACELLE_M - TRANCHE_M + 1e-6, TRANCHE_M):
                t = mat & (hz >= bas) & (hz < bas + TRANCHE_M)
                cercle = _cercle_robuste(x[t], y[t]) if t.sum() >= POINTS_MIN else None
                if cercle and math.hypot(*cercle[:2]) < 4 and cercle[2] < 5:
                    rayons.append((bas + TRANCHE_M / 2, cercle[2]))
            if len(rayons) >= 2:
                mats.append((nom, e["id"], moyeu, rotor, rayons))
            print(f"{nom} {e['type']}/{e['id']} : moyeu {moyeu} m, rotor {rotor} m ; MNH {grille.get('source')}, "
                  f"à moins de 3 m : {h_mnh} ; points 64 au-dessus de 3 m : {int(((c == 64) & (hz > 3)).sum())}, "
                  f"sommet {hz[c == 64].max() if (c == 64).any() else 0:.1f} m ; rayon du mât par tranche : "
                  + ", ".join(f"{h:.0f} m → {r:.2f}" for h, r in rayons))
    print(f"\nMNH : {vus} mât(s) vu(s) sur {couverts} couverts par le LiDAR HD")
    # Le profil s'arrête au premier rayon qui grandit de plus de SAUT_PALE_M : une
    # pale passée près du mât, pas le mât.
    propres = []
    for nom, ident, moyeu, rotor, rayons in mats:
        profil = rayons[:1]
        for h, r in rayons[1:]:
            if r > profil[-1][1] + SAUT_PALE_M:
                break
            profil.append((h, r))
        if profil[0][0] <= 10 and len(profil) >= 2:
            propres.append((moyeu, profil))
    pied = np.array([[m, p[0][1]] for m, p in propres])
    b, a = np.polyfit(pied[:, 0], pied[:, 1], 1)
    residus = pied[:, 1] - (a + b * pied[:, 0])
    print(f"Rayon au pied (tranche de 5 à 10 m), {len(pied)} mâts de {pied[:, 0].min():.0f} à "
          f"{pied[:, 0].max():.0f} m de moyeu : {quartiles(pied[:, 1])} ; droite {a:.3f} + {b:.4f} × moyeu, "
          f"écart {np.abs(residus).mean():.2f} m en moyenne ; rayon / moyeu du plus petit : "
          f"{pied[pied[:, 0].argmin(), 1] / pied[:, 0].min():.4f}")
    hauts = [(m, p) for m, p in propres if p[-1][0] >= 0.6 * m]
    print(f"Profil propre jusqu'aux six dixièmes du moyeu au moins : {len(hauts)} mâts ; plus haute tranche "
          f"à {quartiles([p[-1][0] / m for m, p in hauts])} du moyeu ; rayon / pied : "
          f"{quartiles([p[-1][1] / p[0][1] for m, p in hauts])}")
    pentes = [(p[0][1] - p[-1][1]) / ((p[-1][0] - p[0][0]) / m) for m, p in hauts]
    print(f"Perte de rayon par moyeu parcouru, rapportée au pied : "
          f"{quartiles([d / p[0][1] for d, (m, p) in zip(pentes, hauts)])}")
    print("Moyeu : profil propre :", [(round(m), [f"{h:.0f}:{r:.2f}" for h, r in p]) for m, p in propres])


def mesurer_blocs(cache):
    racine = os.path.join(os.path.expanduser(cache), "v15")
    scenes = []
    for nom in os.listdir(racine):
        m = re.fullmatch(r"(-?[\d.]+)_(-?[\d.]+)(?:_z(\d+))?", nom)
        chemin = os.path.join(racine, nom, "scene.json.gz")
        if m and os.path.exists(chemin):
            scenes.append((os.path.getmtime(chemin), float(m[1]), float(m[2]), int(m[3]) if m[3] else None))
    scenes.sort()
    print(f"{len(scenes)} scènes, dont {sum(1 for s in scenes if s[3])} avec une zone")
    for par_degre in (100, 50, 20, 10):
        connus, requetes, ecrits, aires = set(), 0, 0, []
        for _, lat, lon, zone in scenes:
            w, s, e, n = emprise_anneau(lat, lon, zone=zone)
            blocs = {(i, j) for i in range(math.floor(w * par_degre), math.floor(e * par_degre) + 1)
                     for j in range(math.floor(s * par_degre), math.floor(n * par_degre) + 1)}
            manquants = blocs - connus
            if not manquants:
                continue
            requetes += 1
            ecrits += len(manquants)
            bi, bj = [b[0] for b in manquants], [b[1] for b in manquants]
            lat0 = (min(bj) + max(bj) + 1) / 2 / par_degre
            aires.append((max(bi) + 1 - min(bi)) / par_degre * _metres(lat0)[0] / 1000
                         * (max(bj) + 1 - min(bj)) / par_degre * 111.32)
            connus |= blocs
        print(f"bloc de {1 / par_degre:.2f}° : {requetes} requêtes, {ecrits} blocs écrits, rectangle "
              f"{statistics.median(aires):.1f} km² en médiane, {max(aires):.1f} au plus")


if __name__ == "__main__":
    mesures = {"osm": mesurer_osm, "bdtopo": mesurer_bdtopo, "lidar": mesurer_lidar, "blocs": mesurer_blocs}
    if len(sys.argv) != 3 or sys.argv[1] not in mesures:
        sys.exit(__doc__)
    mesures[sys.argv[1]](sys.argv[2])
