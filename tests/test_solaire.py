"""Climat solaire (vue3d/solaire.py) : l'année type de PVGIS, sans réseau."""
import gzip
import json

import pytest
import requests

from vue3d import app as module_app
from vue3d import solaire

BBOX = (5.19, 43.90, 5.21, 43.92)


def _annee(**changer):
    """Une réponse de PVGIS de forme réelle : 8 760 heures, du soleil à midi."""
    lignes = []
    for k in range(solaire.HEURES):
        mois, jour, heure = solaire._heure_attendue(k)
        midi = heure == 12
        lignes.append({"time(UTC)": f"2010{mois:02d}{jour:02d}:{heure:02d}00", "T2m": 12.0,
                       "G(h)": 500.4 if midi else 0.0, "Gb(n)": 700.6 if midi else 0.0,
                       "Gd(h)": 99.5 if midi else 0.0})
    for k, ligne in changer.items():
        lignes[int(k[1:])].update(ligne)
    return {"inputs": {"location": {"latitude": 43.91, "longitude": 5.2, "elevation": 350.0,
                                    "irradiance_time_offset": 0.1749},
                       "meteo_data": {"radiation_db": "PVGIS-SARAH3", "meteo_db": "ERA5", "year_min": 2005,
                                      "year_max": 2023, "use_horizon": True, "horizon_db": "DEM-calculated"}},
            "outputs": {"months_selected": [{"month": m, "year": 2004 + m} for m in range(1, 13)],
                        "tmy_hourly": lignes}}


def test_l_annee_type_garde_ses_trois_rayonnements_heure_par_heure():
    c = solaire.solaire_pour_emprise(*BBOX, {"lu_le": "2026-10-31", "reponse": _annee()})
    assert c["lu_le"] == "2026-10-31" and c["decalage_h"] == 0.1749
    assert c["annees"] == list(range(2005, 2017))
    assert c["source"] == {"rayonnement": "PVGIS-SARAH3", "debut": 2005, "fin": 2023,
                           "horizon": "DEM-calculated"}
    assert len(c["direct_normal"]) == len(c["diffus_horizontal"]) == len(c["global_horizontal"]) == 8760
    # En W/m² entiers : la 13e heure du 1er janvier est midi.
    assert c["direct_normal"][12] == 701 and c["diffus_horizontal"][12] == 100
    assert c["global_horizontal"][12] == 500 and c["global_horizontal"][11] == 0
    # 31 décembre, 23 h : la dernière heure.
    assert solaire._heure_attendue(8759) == (12, 31, 23)


@pytest.mark.parametrize("defaut", [
    lambda r: r["outputs"]["tmy_hourly"].pop(),                           # une heure de moins
    lambda r: r["outputs"]["tmy_hourly"].insert(0, r["outputs"]["tmy_hourly"].pop()),   # désordre
    lambda r: r["outputs"]["tmy_hourly"][4000].update({"Gb(n)": -3.0}),   # valeur négative
    lambda r: r["outputs"]["tmy_hourly"][4000].update({"Gd(h)": None}),   # valeur absente
    lambda r: r["outputs"]["months_selected"].pop(),                      # un mois sans année
    lambda r: r["inputs"]["location"].pop("irradiance_time_offset"),      # décalage absent
])
def test_une_annee_incomplete_ne_fait_pas_de_couche(defaut):
    r = _annee()
    defaut(r)
    with pytest.raises(ValueError):
        solaire.solaire_pour_emprise(*BBOX, {"lu_le": "2026-10-31", "reponse": r})


class _Reponse:
    def __init__(self, json, status=200):
        self._json, self.status_code, self.ok = json, status, status < 400

    def json(self):
        return self._json


def test_la_lecture_vise_le_centre_et_reessaie(monkeypatch):
    appels = []

    def get(url, params=None, **kw):
        appels.append(params)
        if len(appels) == 1:
            raise requests.ConnectionError("coupure")
        return _Reponse({"outputs": {}})

    monkeypatch.setattr(solaire.requests, "get", get)
    monkeypatch.setattr(solaire, "ATTENTE_S", 0)
    brut = solaire.fetch_solaire(*BBOX)
    assert brut["reponse"] == {"outputs": {}} and len(appels) == 2
    assert (appels[0]["lat"], appels[0]["lon"], appels[0]["usehorizon"]) == ("43.910000", "5.200000", 1)


def test_un_refus_de_pvgis_dit_pourquoi(monkeypatch):
    monkeypatch.setattr(solaire.requests, "get", lambda url, **kw: _Reponse(
        {"message": "Location over the sea. Please, select another location", "status": 400}, 400))
    monkeypatch.setattr(solaire, "ATTENTE_S", 0)
    with pytest.raises(requests.RequestException, match="over the sea"):
        solaire.fetch_solaire(*BBOX)


def test_le_climat_n_est_lu_qu_a_la_demande_et_jamais_a_moitie(tmp_path):
    """Lu au clic seulement, gardé ensuite ; une année incomplète ou une
    panne de PVGIS ne laissent rien en cache."""
    lectures = []
    scene = {"version": 1, "bbox": [0, 0, 1, 1], "batiments": {"features": []}}
    reponses = [requests.ConnectionError("PVGIS injoignable"),
                {"lu_le": "2026-10-31", "reponse": dict(_annee(), outputs={"months_selected": [],
                                                                            "tmy_hourly": []})},
                {"lu_le": "2026-10-31", "reponse": _annee()}]

    def lire_solaire(west, south, east, north):
        lectures.append((west, south, east, north))
        r = reponses.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    client = module_app.creer_app(
        str(tmp_path), construire=lambda lat, lon, avancer=None: (
            gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"),
        lire_monuments=lambda *b: {"elements": []}, lire_eoliennes=lambda *b: {"elements": []},
        lire_ouvrages=lambda *b: {},
        lire_nuage=lambda *b: None, lire_solaire=lire_solaire).test_client()
    assert client.get("/api/scene?lat=43.9116&lon=5.2003").status_code == 200
    assert lectures == []
    r = client.get("/api/solaire?lat=43.9116&lon=5.2003")
    assert r.status_code == 503 and "PVGIS" in r.get_json()["erreur"]
    r = client.get("/api/solaire?lat=43.9116&lon=5.2003")
    assert r.status_code == 503 and "année type" in r.get_json()["erreur"]
    for _ in range(2):
        r = client.get("/api/solaire?lat=43.9116&lon=5.2003")
        assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
        couche = json.loads(gzip.decompress(r.data))
        assert couche["lu_le"] == "2026-10-31" and len(couche["direct_normal"]) == 8760
    assert len(lectures) == 3
