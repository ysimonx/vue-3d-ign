"""Diagnostics de performance énergétique (DPE) de l'ADEME, rattachés aux
bâtiments de la scène.

Une couche à part, comme les monuments (vue3d/monuments.py), mais qui n'est
**jamais lue d'office** : la page ne la demande qu'au clic sur son bouton.

**La source.** Les jeux « DPE Logements existants (depuis juillet 2021) » et
« DPE Logements neufs (depuis juillet 2021) » de l'ADEME, sous Licence
Ouverte 2.0, servis par l'API data-fair de data.ademe.fr, sans clé, avec un
filtre par emprise. Les DPE d'avant juillet 2021 ne sont plus valables
depuis la fin de 2024 ; ces deux jeux suffisent. Un DPE remplacé par un
autre (`numero_dpe_remplace`) n'est pas gardé.

**Le rattachement.** Un DPE porte souvent l'identifiant de son bâtiment au
Référentiel national des bâtiments (`id_rnb`), que les bâtiments de la BD
TOPO portent aussi (`identifiants_rnb`) : le lien est alors exact. Sinon,
c'est son point d'adresse (BAN) qui désigne le bâtiment : celui qui le
contient, ou le plus proche à moins de ADRESSE_RAYON_M.

**Daté.** Les DPE se publient chaque jour : la couche porte la date de sa
lecture (`lu_le`), que la page affiche ; « Reconstruire la scène » la relit.
Comme les autres couches, elle est écrite entière ou pas du tout : une page
de l'API en échec lève, rien n'est écrit.
"""

import datetime
import logging
import math
import time

import requests
import shapely
from shapely.geometry import Point, shape
from shapely.strtree import STRtree

journal = logging.getLogger(__name__)

# Format de la couche ; l'incrémenter ne refait qu'elle.
DPE_VERSION = 1

ADEME_URL = "https://data.ademe.fr/data-fair/api/v1/datasets/{jeu}/lines"
# Existants d'abord : à la République, à Paris, 12 497 DPE en zone de
# 1 000 m pour 23 de logements neufs.
JEUX = ("dpe03existant", "dpe02neuf")
CHAMPS = ("numero_dpe", "numero_dpe_remplace", "date_etablissement_dpe", "date_fin_validite_dpe",
          "etiquette_dpe", "etiquette_ges", "type_batiment", "surface_habitable_logement",
          "conso_5_usages_par_m2_ep", "emission_ges_5_usages_par_m2", "annee_construction",
          "adresse_ban", "id_rnb", "_geopoint")
# La plus grande page que l'API accepte.
PAGE = 10_000
ADEME_ESSAIS = 3
ADEME_ATTENTE_S = 3
ADEME_TIMEOUT_S = 60

# Un tuple, pas une chaîne : "" et None n'y sont pas.
ETIQUETTES = tuple("ABCDEFG")
# Rattachement par l'adresse, quand le DPE n'a pas d'identifiant RNB connu de
# la scène : le bâtiment le plus proche de son point d'adresse, à moins de ce
# rayon. Mesuré le 2026-10-09 sur huit lieux publics (Gordes, Carcassonne,
# Paris République, Lyon Bellecour, Strasbourg cathédrale, Marseille
# Vieux-Port, Uzès, Arles ; 2 759 DPE), en jugeant la règle sur les 1 715
# DPE dont le RNB désigne un bâtiment de la scène :
#
#   point d'adresse            dedans    < 2 m    2-5 m    5-10 m   > 10 m
#   bâtiment juste             93,5 %    86 %     75 %     4 sur 6  0 sur 1
#   DPE sans RNB concernés       652      283       66        27       16
#
# Au-delà de 5 m, un sur trois se tromperait de bâtiment. À 5 m, 1 001 des
# 1 044 DPE sans RNB trouvent le leur ; la page dit qu'il est approché.
ADRESSE_RAYON_M = 5.0


def _lire(url):
    """Une page de l'API, réessayée : l'ADEME répond parfois en retard."""
    dernier = None
    for essai in range(ADEME_ESSAIS):
        try:
            reponse = requests.get(url, headers={"User-Agent": "vue-3d-ign"}, timeout=ADEME_TIMEOUT_S)
            if not reponse.ok:
                raise requests.RequestException(f"HTTP {reponse.status_code} sur {url[:120]}")
            return reponse.json()
        except (requests.RequestException, ValueError) as exc:
            dernier = exc
            if essai < ADEME_ESSAIS - 1:
                time.sleep(ADEME_ATTENTE_S)
    raise requests.RequestException(f"API de l'ADEME injoignable : {dernier}")


def fetch_dpe(west, south, east, north):
    """Les DPE des deux jeux dont le point d'adresse tombe dans l'emprise.

    Returns:
        {"lignes": [ligne brute de l'API, plus "jeu"], "lu_le": date ISO}.

    Raises:
        requests.RequestException si une page n'a pas pu être lue, ou si les
        pages lues ne comptent pas autant de DPE que l'API en annonce.
    """
    lu_le = datetime.date.today().isoformat()
    lignes = []
    for jeu in JEUX:
        url = (f"{ADEME_URL.format(jeu=jeu)}?size={PAGE}&bbox={west},{south},{east},{north}"
               f"&select={','.join(CHAMPS)}")
        total, lus = None, 0
        while url:
            page = _lire(url)
            if total is None:
                total = page.get("total")
            lignes += [{**ligne, "jeu": jeu} for ligne in page.get("results", [])]
            lus += len(page.get("results", []))
            url = page.get("next") if page.get("results") else None
        if total is not None and lus != total:
            raise requests.RequestException(f"{jeu} : {lus} DPE lus sur {total} annoncés")
    return {"lignes": lignes, "lu_le": lu_le}


def _point(ligne):
    """(lon, lat) du point d'adresse ; None s'il manque."""
    try:
        lat, lon = (float(v) for v in ligne["_geopoint"].split(","))
    except (KeyError, AttributeError, ValueError):
        return None
    return lon, lat


def _index_batiments(batiments, lat0):
    """(cleabs par identifiant RNB, arbre des emprises en mètres, leurs cleabs)."""
    kx = 111320 * math.cos(math.radians(lat0))
    par_rnb, emprises, noms = {}, [], []
    for f in (batiments or {}).get("features", []):
        p = f.get("properties") or {}
        cleabs = p.get("cleabs")
        if not cleabs or not f.get("geometry"):
            continue
        for rnb in str(p.get("identifiants_rnb") or "").split("/"):
            if rnb.strip():
                par_rnb[rnb.strip()] = cleabs
        try:
            geom = shapely.transform(shape(f["geometry"]), lambda c: c * [kx, 111320])
        except Exception:
            continue
        if not geom.is_empty:
            emprises.append(geom)
            noms.append(cleabs)
    return par_rnb, (STRtree(emprises) if emprises else None), emprises, noms, kx


def rattacher(ligne, index, rayon_m=ADRESSE_RAYON_M):
    """(cleabs, "rnb" | "adresse") du bâtiment du DPE, ou (None, None)."""
    par_rnb, arbre, emprises, noms, kx = index
    cleabs = par_rnb.get((ligne.get("id_rnb") or "").strip())
    if cleabs:
        return cleabs, "rnb"
    lonlat = _point(ligne)
    if lonlat is None or arbre is None:
        return None, None
    p = Point(lonlat[0] * kx, lonlat[1] * 111320)
    i = arbre.nearest(p)
    if i is not None and emprises[i].distance(p) <= rayon_m:
        return noms[i], "adresse"
    return None, None


def _nombre(v, chiffres=1):
    try:
        return round(float(v), chiffres)
    except (TypeError, ValueError):
        return None


def _resume(dpe):
    """Ce que la page dit d'un groupe de DPE : leur nombre, la répartition
    des étiquettes, l'étiquette et la consommation médianes, la période."""
    energies = sorted(d["energie"] for d in dpe)
    consos = sorted(d["conso"] for d in dpe if d["conso"] is not None)
    dates = sorted(d["date"] for d in dpe if d["date"])
    compter = lambda cle: {e: n for e in ETIQUETTES  # noqa: E731
                           if (n := sum(1 for d in dpe if d[cle] == e))}
    return {"n": len(dpe), "energie": compter("energie"), "climat": compter("climat"),
            "mediane": energies[(len(energies) - 1) // 2],
            "conso_mediane": consos[(len(consos) - 1) // 2] if consos else None,
            "du": dates[0] if dates else None, "au": dates[-1] if dates else None,
            "types": {t: sum(1 for d in dpe if d["type"] == t) for t in sorted({d["type"] for d in dpe})}}


def _groupe(dpe):
    """Un bâtiment ou une adresse : son résumé ; le détail de ses DPE si
    c'est une maison. D'un immeuble, la liste de ses appartements n'apprend
    rien de plus que la répartition des étiquettes (choix de l'utilisateur)."""
    groupe = {"resume": _resume(dpe), "par_rnb": sum(1 for d in dpe if d["lien"] == "rnb"),
              "par_adresse": sum(1 for d in dpe if d["lien"] == "adresse")}
    if len(dpe) <= DETAIL_MAX and all(d["type"] == "maison" for d in dpe) or len(dpe) == 1:
        groupe["dpe"] = [{k: d[k] for k in DETAIL} for d in dpe]
    return groupe


# Détail gardé d'un DPE de maison, et le plus de DPE détaillés pour un
# bâtiment : une maison diagnostiquée plusieurs fois.
DETAIL = ("numero", "date", "fin_validite", "energie", "climat", "type", "surface", "conso",
          "emission", "annee", "adresse", "neuf")
DETAIL_MAX = 5


def dpe_pour_emprise(west, south, east, north, brut, batiments):
    """La couche des DPE de l'emprise, réunis par bâtiment.

    Args:
        brut: de `fetch_dpe`.
        batiments: GeoJSON des bâtiments de la scène.

    Returns:
        dict(version, lu_le, nombre, batiments, adresses) ; `batiments` :
        [{batiment (cleabs), resume, par_rnb, par_adresse, dpe?}] ;
        `adresses` : les DPE sans bâtiment de la scène, réunis par point
        d'adresse, [{lon, lat, adresse, resume, ..., dpe?}]. `resume` :
        {n, energie {A: n, …}, climat, mediane, conso_mediane, du, au,
        types} ; `dpe`, le détail, seulement pour une maison.
    """
    brut = brut or {"lignes": []}
    lignes = brut.get("lignes", [])
    remplaces = {ligne.get("numero_dpe_remplace") for ligne in lignes} - {None, ""}
    index = _index_batiments(batiments, (south + north) / 2)
    par_batiment, par_adresse = {}, {}
    liens = {"rnb": 0, "adresse": 0, None: 0}
    vus = set()
    # Les plus récents d'abord : le détail d'une maison les liste ainsi.
    for ligne in sorted(lignes, key=lambda x: x.get("date_etablissement_dpe") or "", reverse=True):
        numero = ligne.get("numero_dpe")
        lonlat = _point(ligne)
        if (numero in remplaces or numero in vus or lonlat is None
                or ligne.get("etiquette_dpe") not in ETIQUETTES):
            continue
        vus.add(numero)
        batiment, lien = rattacher(ligne, index)
        liens[lien] += 1
        d = {"numero": numero, "date": ligne.get("date_etablissement_dpe"),
             "fin_validite": ligne.get("date_fin_validite_dpe"),
             "energie": ligne.get("etiquette_dpe"), "climat": ligne.get("etiquette_ges"),
             "type": ligne.get("type_batiment"), "surface": _nombre(ligne.get("surface_habitable_logement")),
             "conso": _nombre(ligne.get("conso_5_usages_par_m2_ep"), 0),
             "emission": _nombre(ligne.get("emission_ges_5_usages_par_m2"), 0),
             "annee": ligne.get("annee_construction"), "adresse": ligne.get("adresse_ban"),
             "neuf": ligne.get("jeu") == "dpe02neuf", "lien": lien,
             "lon": round(lonlat[0], 7), "lat": round(lonlat[1], 7)}
        if batiment:
            par_batiment.setdefault(batiment, []).append(d)
        else:
            par_adresse.setdefault((d["lon"], d["lat"]), []).append(d)
    journal.info("DPE : %d gardé(s) sur %d lu(s) ; rattachés par le RNB %d, par l'adresse %d, "
                 "sans bâtiment %d", len(vus), len(lignes), liens["rnb"], liens["adresse"], liens[None])
    return {"version": DPE_VERSION, "lu_le": brut.get("lu_le"), "nombre": len(vus),
            "batiments": [{"batiment": b, **_groupe(dpe)} for b, dpe in sorted(par_batiment.items())],
            "adresses": [{"lon": lon, "lat": lat, "adresse": dpe[0]["adresse"], **_groupe(dpe)}
                         for (lon, lat), dpe in sorted(par_adresse.items())]}
