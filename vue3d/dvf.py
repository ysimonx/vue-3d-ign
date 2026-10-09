"""Ventes immobilières (Demandes de valeurs foncières, DVF) des parcelles
de l'emprise.

Une couche à part, comme les DPE (vue3d/dpe.py), et comme eux **jamais lue
d'office** : la page ne la demande qu'au clic sur son bouton.

**Les sources.** Les parcelles viennent du Parcellaire Express de l'IGN, par
le même WFS que les bâtiments (vue3d/couches.py). Les ventes viennent des
fichiers « DVF géolocalisées » d'Etalab sur data.gouv.fr (DGFiP, Licence
Ouverte 2.0) : un fichier par commune et par année, les cinq dernières
années publiées. L'identifiant d'une parcelle est le même des deux côtés
(`idu` et `id_parcelle`), et ses cinq premiers caractères sont le code de la
commune — ou de l'arrondissement, à Paris, Lyon et Marseille — dont le
fichier porte les ventes : la jointure est exacte.

**Pas de DVF en Alsace-Moselle** : la publicité foncière y relève du livre
foncier, et la DGFiP n'en publie rien. C'est un fait, pas une panne : la
couche le dit (`absent`). De même, une commune sans vente une année n'a pas
de fichier cette année-là (404).

**Ce que la page affiche.** Les ventes de chaque parcelle, et un prix au m²
là où il a un sens : une vente d'un seul logement, maison ou appartement
(ses dépendances à part), dont la surface bâtie est connue. Le prix d'une
vente de plusieurs logements, ou d'un terrain, n'est pas ramené au m².

**Conditions de réutilisation de DVF** (article R112 A-3 du livre des
procédures fiscales) : ne pas permettre la réidentification des personnes,
ne pas laisser les moteurs de recherche indexer ces données. La couche
n'est lue qu'à la demande et n'est publiée nulle part.

**Daté**, comme les DPE : `lu_le`, et « Reconstruire la scène » la relit.
"""

import concurrent.futures
import csv
import datetime
import io
import logging
import re
import statistics
import time

import requests
import shapely
from shapely.geometry import box, mapping, shape

from .couches import lire_couche

journal = logging.getLogger(__name__)

# Format de la couche ; l'incrémenter ne refait qu'elle.
DVF_VERSION = 1

COUCHE_PARCELLES = "CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle"
DVF_URL = "https://files.data.gouv.fr/geo-dvf/latest/csv/"
# Départements sans DVF : le livre foncier d'Alsace-Moselle.
SANS_DVF = {"57": "Moselle", "67": "Bas-Rhin", "68": "Haut-Rhin"}
DVF_ESSAIS = 3
DVF_ATTENTE_S = 3
DVF_TIMEOUT_S = 60
# Fichiers lus en même temps : cinq années par commune. Un fichier d'un
# arrondissement de Paris pèse 325 Ko et se lit en 0,4 s.
DVF_FILS = 4

# Ventes dont le prix se ramène au m² : un seul logement de ces types.
NATURES_VENTE = {"Vente", "Vente en l'état futur d'achèvement"}
LOGEMENTS = ("Maison", "Appartement")


def _get(url):
    """Réponse d'un fichier, réessayée ; None s'il n'existe pas (404)."""
    dernier = None
    for essai in range(DVF_ESSAIS):
        try:
            reponse = requests.get(url, headers={"User-Agent": "vue-3d-ign"}, timeout=DVF_TIMEOUT_S)
            if reponse.status_code == 404:
                return None
            if not reponse.ok:
                raise requests.RequestException(f"HTTP {reponse.status_code} sur {url}")
            reponse.encoding = "utf-8"
            return reponse.text
        except requests.RequestException as exc:
            dernier = exc
            if essai < DVF_ESSAIS - 1:
                time.sleep(DVF_ATTENTE_S)
    raise requests.RequestException(f"fichiers DVF injoignables : {dernier}")


def millesimes():
    """Les années publiées, lues dans l'index des fichiers.

    Raises:
        requests.RequestException si l'index est illisible ou vide.
    """
    texte = _get(DVF_URL)
    annees = sorted({int(a) for a in re.findall(r'href="[^"]*/(\d{4})/"', texte or "")})
    if not annees:
        raise requests.RequestException("index des fichiers DVF sans année")
    return annees


def fetch_dvf(west, south, east, north):
    """Les parcelles de l'emprise et les lignes DVF de leurs ventes.

    Returns:
        {"parcelles": GeoJSON, "lignes": [ligne CSV], "millesimes": [année],
        "absent": [département sans DVF], "lu_le": date ISO}. Une vente
        dont une parcelle est dans l'emprise y est entière, toutes ses
        lignes du fichier de la commune comprises.

    Raises:
        requests.RequestException si une source n'a pas répondu.
    """
    lu_le = datetime.date.today().isoformat()
    parcelles = lire_couche(COUCHE_PARCELLES, west, south, east, north)
    idus = {f["properties"].get("idu") for f in parcelles.get("features", [])} - {None}
    communes = sorted({idu[:5] for idu in idus})
    absent = sorted({SANS_DVF[c[:2]] for c in communes if c[:2] in SANS_DVF})
    communes = [c for c in communes if c[:2] not in SANS_DVF]
    annees = millesimes() if communes else []
    fichiers = [(a, c) for a in annees for c in communes]

    def lire(fichier):
        annee, commune = fichier
        return _get(f"{DVF_URL}{annee}/communes/{commune[:2]}/{commune}.csv")

    lignes = []
    with concurrent.futures.ThreadPoolExecutor(DVF_FILS, thread_name_prefix="dvf") as bassin:
        for texte in bassin.map(lire, fichiers):
            if not texte:
                continue
            toutes = list(csv.DictReader(io.StringIO(texte)))
            ventes = {r["id_mutation"] for r in toutes if r.get("id_parcelle") in idus}
            lignes += [r for r in toutes if r["id_mutation"] in ventes]
    return {"parcelles": parcelles, "lignes": lignes, "millesimes": annees, "absent": absent,
            "lu_le": lu_le}


def _nombre(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _mutations(lignes):
    """Lignes DVF -> ventes, par identifiant. Une ligne par parcelle, local
    et nature de culture : un même local revient pour chaque culture de sa
    parcelle, une même surface de terrain pour chaque local."""
    ventes = {}
    for r in lignes:
        v = ventes.setdefault(r["id_mutation"], {
            "date": r.get("date_mutation"), "nature": r.get("nature_mutation"),
            "valeur": _nombre(r.get("valeur_fonciere")), "parcelles": set(), "_locaux": {},
            "_terrains": {}})
        v["parcelles"].add(r.get("id_parcelle"))
        if r.get("type_local"):
            cle = (r.get("id_parcelle"), r.get("lot1_numero"), r.get("type_local"),
                   r.get("surface_reelle_bati"), r.get("nombre_pieces_principales"))
            v["_locaux"][cle] = {"type": r["type_local"], "surface": _nombre(r.get("surface_reelle_bati")),
                                 "pieces": _nombre(r.get("nombre_pieces_principales"))}
        if r.get("surface_terrain"):
            cle = (r.get("id_parcelle"), r.get("code_nature_culture"), r.get("code_nature_culture_speciale"))
            v["_terrains"][cle] = _nombre(r.get("surface_terrain")) or 0.0
    sortie = {}
    for ident, v in ventes.items():
        locaux = list(v.pop("_locaux").values())
        terrain = sum(v.pop("_terrains").values())
        logements = [loc for loc in locaux if loc["type"] in LOGEMENTS]
        autres = [loc for loc in locaux if loc["type"] not in LOGEMENTS and loc["type"] != "Dépendance"]
        prix_m2 = None
        if (v["nature"] in NATURES_VENTE and len(logements) == 1 and not autres
                and (logements[0]["surface"] or 0) > 0 and (v["valeur"] or 0) > 0):
            prix_m2 = round(v["valeur"] / logements[0]["surface"])
        sortie[ident] = {**v, "parcelles": sorted(v["parcelles"]), "locaux": locaux,
                         "terrain": round(terrain) or None,
                         "type": logements[0]["type"] if len(logements) == 1 else None,
                         "prix_m2": prix_m2}
    return sortie


def _resume(ventes):
    """Par type de logement : nombre de ventes au prix ramené au m², et
    leurs quartiles."""
    resume = {}
    for t in LOGEMENTS:
        prix = sorted(v["prix_m2"] for v in ventes.values() if v["type"] == t and v["prix_m2"])
        if not prix:
            continue
        q = statistics.quantiles(prix, n=4) if len(prix) >= 2 else [prix[0]] * 3
        resume[t] = {"ventes": len(prix), "q1": round(q[0]), "mediane": round(statistics.median(prix)),
                     "q3": round(q[2])}
    return resume


def dvf_pour_emprise(west, south, east, north, brut):
    """La couche des ventes de l'emprise.

    Returns:
        dict(version, lu_le, millesimes, absent, parcelles, ventes, resume) ;
        `parcelles` : [{idu, contenance, geometrie, ventes}], seulement
        celles qui ont une vente, découpées sur l'emprise ; `ventes` :
        {identifiant: {date, nature, valeur, parcelles, locaux, terrain,
        type, prix_m2}}, les plus récentes d'abord dans chaque parcelle.
    """
    brut = brut or {}
    ventes = _mutations(brut.get("lignes", []))
    par_parcelle = {}
    for ident, v in ventes.items():
        for idu in v["parcelles"]:
            par_parcelle.setdefault(idu, []).append(ident)
    cadre = box(west, south, east, north)
    parcelles = []
    for f in (brut.get("parcelles") or {}).get("features", []):
        p = f.get("properties") or {}
        idu = p.get("idu")
        if idu not in par_parcelle or not f.get("geometry"):
            continue
        geom = shape(f["geometry"]).intersection(cadre)
        if geom.is_empty:
            continue
        geom = shapely.set_precision(geom, 1e-7)
        parcelles.append({"idu": idu, "contenance": p.get("contenance"), "geometrie": mapping(geom),
                          "ventes": sorted(par_parcelle[idu], key=lambda i: ventes[i]["date"] or "",
                                           reverse=True)})
    # Les ventes dont aucune parcelle n'est dessinée ne servent à rien ici.
    dessinees = {i for p in parcelles for i in p["ventes"]}
    ventes = {i: v for i, v in ventes.items() if i in dessinees}
    journal.info("DVF : %d vente(s) sur %d parcelle(s), années %s%s", len(ventes), len(parcelles),
                 ", ".join(map(str, brut.get("millesimes", []))),
                 f" ; sans DVF : {', '.join(brut['absent'])}" if brut.get("absent") else "")
    return {"version": DVF_VERSION, "lu_le": brut.get("lu_le"), "millesimes": brut.get("millesimes", []),
            "absent": brut.get("absent", []), "parcelles": parcelles, "ventes": ventes,
            "resume": _resume(ventes)}
