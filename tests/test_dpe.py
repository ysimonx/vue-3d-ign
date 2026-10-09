"""DPE de l'ADEME (vue3d/dpe.py) : lecture paginée, rattachement aux
bâtiments, résumé d'un immeuble et détail d'une maison. Sans réseau."""
import math

import pytest
import requests

from vue3d import dpe
from vue3d.dpe import ADRESSE_RAYON_M, dpe_pour_emprise

LAT, LON = 45.0, 2.0
KX = 111320 * math.cos(math.radians(LAT))
BBOX = (LON - 100 / KX, LAT - 100 / 111320, LON + 100 / KX, LAT + 100 / 111320)


def _carre(x0, y0, x1, y1):
    """Polygone GeoJSON d'un rectangle donné en mètres depuis le centre."""
    p = lambda x, y: [LON + x / KX, LAT + y / 111320]          # noqa: E731
    return {"type": "Polygon", "coordinates": [[p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)]]}


BATIMENTS = {"features": [
    {"properties": {"cleabs": "BATIMENT_IMMEUBLE", "identifiants_rnb": "RNB_A/RNB_B"},
     "geometry": _carre(0, 0, 20, 20)},
    {"properties": {"cleabs": "BATIMENT_MAISON", "identifiants_rnb": None},
     "geometry": _carre(40, 0, 50, 10)}]}


def _ligne(numero, x, y, etiquette="D", type_="appartement", rnb=None, remplace=None,
           date="2024-01-01", conso=200, jeu="dpe03existant"):
    return {"numero_dpe": numero, "numero_dpe_remplace": remplace, "date_etablissement_dpe": date,
            "date_fin_validite_dpe": "2034-01-01", "etiquette_dpe": etiquette, "etiquette_ges": "C",
            "type_batiment": type_, "surface_habitable_logement": 50, "conso_5_usages_par_m2_ep": conso,
            "emission_ges_5_usages_par_m2": 20, "annee_construction": 1950, "adresse_ban": "1 Rue X",
            "id_rnb": rnb, "_geopoint": f"{LAT + y / 111320},{LON + x / KX}", "jeu": jeu}


def test_le_rnb_rattache_au_bon_batiment_meme_loin_de_son_adresse():
    """L'identifiant RNB l'emporte sur le point d'adresse, et un bâtiment de
    la BD TOPO peut en porter plusieurs."""
    index = dpe._index_batiments(BATIMENTS, LAT)
    assert dpe.rattacher(_ligne("1", 45, 5, rnb="RNB_B"), index) == ("BATIMENT_IMMEUBLE", "rnb")


def test_sans_rnb_le_point_d_adresse_designe_le_batiment_a_moins_du_rayon():
    index = dpe._index_batiments(BATIMENTS, LAT)
    assert dpe.rattacher(_ligne("1", 10, 10), index) == ("BATIMENT_IMMEUBLE", "adresse")
    assert dpe.rattacher(_ligne("2", 10, -ADRESSE_RAYON_M + 1), index) == ("BATIMENT_IMMEUBLE", "adresse")
    assert dpe.rattacher(_ligne("3", 10, -ADRESSE_RAYON_M - 1), index) == (None, None)
    # Un RNB inconnu de la scène : c'est l'adresse qui parle.
    assert dpe.rattacher(_ligne("4", 45, 5, rnb="RNB_AILLEURS"), index) == ("BATIMENT_MAISON", "adresse")


def test_un_immeuble_n_a_que_son_resume():
    """Choix de l'utilisateur : la liste des appartements d'un immeuble
    n'apprend rien de plus que la répartition de leurs étiquettes."""
    lignes = [_ligne(str(i), 10, 10, etiquette=e, rnb="RNB_A", conso=c)
              for i, (e, c) in enumerate([("C", 120), ("D", 200), ("D", 210), ("E", 300), ("G", 500)])]
    couche = dpe_pour_emprise(*BBOX, {"lignes": lignes, "lu_le": "2026-10-09"}, BATIMENTS)
    assert couche["lu_le"] == "2026-10-09" and couche["nombre"] == 5
    (immeuble,) = couche["batiments"]
    assert "dpe" not in immeuble and immeuble["par_rnb"] == 5
    assert immeuble["resume"] == {"n": 5, "energie": {"C": 1, "D": 2, "E": 1, "G": 1}, "climat": {"C": 5},
                                  "mediane": "D", "conso_mediane": 210, "du": "2024-01-01",
                                  "au": "2024-01-01", "types": {"appartement": 5}}


def test_une_maison_garde_le_detail_de_ses_dpe_les_plus_recents_d_abord():
    lignes = [_ligne("ancien", 45, 5, etiquette="F", type_="maison", date="2022-03-01"),
              _ligne("recent", 45, 5, etiquette="C", type_="maison", date="2025-06-01")]
    (maison,) = dpe_pour_emprise(*BBOX, {"lignes": lignes}, BATIMENTS)["batiments"]
    assert [d["numero"] for d in maison["dpe"]] == ["recent", "ancien"]
    assert maison["par_adresse"] == 2 and maison["dpe"][0]["energie"] == "C"
    assert "lon" not in maison["dpe"][0] and "lien" not in maison["dpe"][0]


def test_un_dpe_remplace_ou_illisible_n_est_pas_garde():
    lignes = [_ligne("v1", 10, 10), _ligne("v2", 10, 10, remplace="v1"),
              _ligne("sans_etiquette", 10, 10, etiquette=None), _ligne("v2", 10, 10),
              {**_ligne("sans_point", 10, 10), "_geopoint": None}]
    couche = dpe_pour_emprise(*BBOX, {"lignes": lignes}, BATIMENTS)
    assert couche["nombre"] == 1 and couche["batiments"][0]["dpe"][0]["numero"] == "v2"


def test_les_dpe_sans_batiment_se_groupent_par_point_d_adresse():
    lignes = [_ligne("1", -60, -60), _ligne("2", -60, -60, etiquette="F"), _ligne("3", 80, 80)]
    couche = dpe_pour_emprise(*BBOX, {"lignes": lignes}, BATIMENTS)
    assert couche["batiments"] == []
    assert sorted(a["resume"]["n"] for a in couche["adresses"]) == [1, 2]
    assert all(a["adresse"] == "1 Rue X" for a in couche["adresses"])


class _Reponse:
    def __init__(self, json, status=200):
        self._json, self.status_code, self.ok = json, status, status < 400

    def json(self):
        return self._json


def test_la_lecture_suit_les_pages_et_les_deux_jeux(monkeypatch):
    pages = {
        "dpe03existant": [{"total": 3, "results": [{"numero_dpe": "a"}, {"numero_dpe": "b"}],
                           "next": "SUITE"}, {"total": 3, "results": [{"numero_dpe": "c"}]}],
        "dpe02neuf": [{"total": 1, "results": [{"numero_dpe": "n"}]}]}
    demandes = []

    def get(url, **_):
        demandes.append(url)
        jeu = "dpe03existant" if url == "SUITE" or "dpe03existant" in url else "dpe02neuf"
        return _Reponse(pages[jeu].pop(0))

    monkeypatch.setattr(requests, "get", get)
    brut = dpe.fetch_dpe(*BBOX)
    assert [(ligne["numero_dpe"], ligne["jeu"]) for ligne in brut["lignes"]] == [
        ("a", "dpe03existant"), ("b", "dpe03existant"), ("c", "dpe03existant"), ("n", "dpe02neuf")]
    assert f"bbox={BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]}" in demandes[0] and len(brut["lu_le"]) == 10


def test_une_lecture_incomplete_ou_en_echec_leve(monkeypatch):
    """Complète ou absente : rien n'est rendu à moitié."""
    monkeypatch.setattr(dpe.time, "sleep", lambda s: None)
    monkeypatch.setattr(requests, "get", lambda url, **_: _Reponse({"total": 5, "results": [{}]}))
    with pytest.raises(requests.RequestException, match="1 DPE lus sur 5"):
        dpe.fetch_dpe(*BBOX)
    essais = []
    monkeypatch.setattr(requests, "get", lambda url, **_: essais.append(url) or _Reponse({}, 502))
    with pytest.raises(requests.RequestException, match="ADEME injoignable"):
        dpe.fetch_dpe(*BBOX)
    assert len(essais) == dpe.ADEME_ESSAIS
