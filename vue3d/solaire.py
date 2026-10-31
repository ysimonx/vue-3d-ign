"""Le climat solaire du point : l'année type de PVGIS, pour l'ensoleillement des toits.

Une couche à part, comme les DPE (vue3d/dpe.py) : **jamais lue d'office**, la
page ne la demande qu'au clic sur son bouton. Elle ne lit rien de la scène :
c'est la page qui calcule l'ensoleillement de chaque toit, sur ce qu'elle
dessine (static/js/scene/couches/solaire.js).

**La source.** PVGIS, le service du Centre commun de recherche de la
Commission européenne, sans clé : l'année météorologique type (TMY) du point,
heure par heure. Chaque mois est un mois réel, choisi parmi ceux de
2005-2023 pour être le plus représentatif ; le rayonnement est celui du
satellite (SARAH-3). PVGIS y retire déjà le direct quand le soleil passe
derrière le relief lointain, qu'il calcule sur son modèle de terrain
(`usehorizon=1`) : la page n'a plus que l'ombre de ce qu'elle dessine.
Réutilisation autorisée, source citée (décision 2011/833/UE).

**Ce que la couche garde.** Le direct normal, le diffus horizontal et le
global horizontal de chacune des 8 760 heures, en W/m² entiers ; l'année
d'où vient chaque mois ; et le décalage de la mesure sur l'heure, que
SARAH date à HH:10 environ, et dont la page tient compte pour placer le
soleil. 1,2 Mo de réponse, 1,5 s à Gordes (mesuré le 31 octobre 2026) ;
30 Ko gardés.

**Entière ou rien.** Une réponse qui n'a pas ses 8 760 heures, dans
l'ordre, avec des valeurs lisibles, lève : rien n'est écrit.
"""

import datetime
import math
import time

import requests

# Format de la couche ; l'incrémenter ne refait qu'elle.
SOLAIRE_VERSION = 1

API_URL = "https://re.jrc.ec.europa.eu/api/v5_3/tmy"
ESSAIS = 3
ATTENTE_S = 3
TIMEOUT_S = 60
HEURES = 8760
# Les jours de chaque mois d'une année type : PVGIS n'y met jamais de 29 février.
JOURS_DES_MOIS = (31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)


def fetch_solaire(west, south, east, north):
    """L'année type de PVGIS au centre de l'emprise.

    Returns:
        {"lu_le": date ISO, "reponse": la réponse JSON de PVGIS}.

    Raises:
        requests.RequestException si PVGIS n'a pas répondu après ESSAIS
        tentatives, ou a refusé le point.
    """
    lat, lon = (south + north) / 2, (west + east) / 2
    params = {"lat": f"{lat:.6f}", "lon": f"{lon:.6f}", "outputformat": "json", "usehorizon": 1}
    dernier = None
    for essai in range(ESSAIS):
        try:
            reponse = requests.get(API_URL, params=params, headers={"User-Agent": "vue-3d-ign"},
                                   timeout=TIMEOUT_S)
            if not reponse.ok:
                try:
                    message = reponse.json().get("message")
                except ValueError:
                    message = None
                raise requests.RequestException(f"HTTP {reponse.status_code}"
                                                + (f" : {message}" if message else ""))
            return {"lu_le": datetime.date.today().isoformat(), "reponse": reponse.json()}
        except (requests.RequestException, ValueError) as exc:
            dernier = exc
            if essai + 1 < ESSAIS:
                time.sleep(ATTENTE_S)
    raise requests.RequestException(f"PVGIS injoignable : {dernier}")


def _heure_attendue(k):
    """(mois, jour, heure) de la k-ième heure d'une année type."""
    jour, heure = divmod(k, 24)
    for mois, n in enumerate(JOURS_DES_MOIS, start=1):
        if jour < n:
            return mois, jour + 1, heure
        jour -= n
    raise ValueError(f"heure {k} au-delà de l'année")


def _watts(ligne, cle, k):
    v = ligne.get(cle)
    if not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
        raise ValueError(f"{cle} illisible à l'heure {k} : {v!r}")
    return round(v)


def solaire_pour_emprise(west, south, east, north, brut):
    """La couche du climat solaire, tirée de la réponse de PVGIS.

    Raises:
        ValueError si la réponse n'est pas une année type complète : il
        manque une heure, elles ne sont pas dans l'ordre, ou une valeur est
        illisible.
    """
    r = brut["reponse"]
    lieu = r["inputs"]["location"]
    meteo = r["inputs"]["meteo_data"]
    lignes = r["outputs"]["tmy_hourly"]
    if len(lignes) != HEURES:
        raise ValueError(f"{len(lignes)} heures dans l'année type, {HEURES} attendues")
    annees = {m["month"]: m["year"] for m in r["outputs"]["months_selected"]}
    if sorted(annees) != list(range(1, 13)):
        raise ValueError(f"mois de l'année type incomplets : {sorted(annees)}")
    direct, diffus, glob = [], [], []
    for k, ligne in enumerate(lignes):
        horodatage = ligne.get("time(UTC)") or ""
        mois, jour, heure = _heure_attendue(k)
        if horodatage[4:11] != f"{mois:02d}{jour:02d}:{heure:02d}":
            raise ValueError(f"heure {k} datée {horodatage!r}, {mois:02d}{jour:02d}:{heure:02d} attendue")
        direct.append(_watts(ligne, "Gb(n)", k))
        diffus.append(_watts(ligne, "Gd(h)", k))
        glob.append(_watts(ligne, "G(h)", k))
    decalage = lieu.get("irradiance_time_offset")
    if not isinstance(decalage, (int, float)) or not 0 <= decalage < 1:
        raise ValueError(f"décalage des mesures illisible : {decalage!r}")
    return {
        "lu_le": brut["lu_le"],
        "lat": lieu["latitude"], "lon": lieu["longitude"], "altitude": lieu.get("elevation"),
        "source": {"rayonnement": meteo.get("radiation_db"), "debut": meteo.get("year_min"),
                   "fin": meteo.get("year_max"), "horizon": meteo.get("horizon_db")
                   if meteo.get("use_horizon") else None},
        "decalage_h": decalage,
        "annees": [annees[m] for m in range(1, 13)],
        "direct_normal": direct,
        "diffus_horizontal": diffus,
        "global_horizontal": glob,
    }
