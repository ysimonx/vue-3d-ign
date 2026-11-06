"""Limitations de vitesse de la voiture (vue3d/vitesses.py) et leur route /api/vitesses."""
import gzip
import json
import os

import pytest
import requests

from vue3d import app as module_app
from vue3d import carres, monuments, vitesses
from vue3d.vitesses import BlocsOsm, Rapprocheur, regle_generale, valeur_maxspeed, vitesses_du_carre

# Le carré de Gordes, comme tests/test_carres.py.
I, J = 1752, 12632
X0, Y0 = I * carres.CARRE_M, J * carres.CARRE_M


@pytest.mark.parametrize("texte, attendu", [
    ("50", 50), (" 30 ", 30), ("FR:urban", 50), ("fr:rural", 80), ("FR:motorway", 130),
    ("FR:zone30", 30), ("FR:zone:30", 30), ("30 mph", 48), ("90 km/h", 90),
    ("none", None), ("signals", None), ("walk", None), ("30;50", None), ("0", None), ("300", None), (None, None),
])
def test_les_valeurs_de_maxspeed(texte, attendu):
    assert valeur_maxspeed(texte) == attendu


@pytest.mark.parametrize("nature, urbain, attendu", [
    ("Route à 1 chaussée", True, 50), ("Route à 1 chaussée", False, 80),
    ("Route à 2 chaussées", False, 110), ("Route à 2 chaussées", True, 50),
    ("Type autoroutier", False, 130), ("Type autoroutier", True, 110),
    ("Bretelle", False, None), ("Rond-point", True, None), ("Route empierrée", False, None),
])
def test_la_regle_generale(nature, urbain, attendu):
    assert regle_generale(nature, urbain) == attendu


def _voie(avant, arriere, *points):
    return [[avant, arriere], [c for p in points for c in p]]


# Un tronçon de 200 m vers l'est.
TRONCON = [(X0 + 100, Y0 + 100), (X0 + 300, Y0 + 100)]


def test_une_voie_osm_le_long_du_troncon_donne_ses_limites_sens_par_sens():
    """La voie OSM à 4 m, dans le même sens : sa limite avant est celle du
    sens du tronçon. Une voie qui le croise, ou passe à 20 m, ne compte pas."""
    r = Rapprocheur([
        _voie(70, 50, (X0 + 90, Y0 + 104), (X0 + 310, Y0 + 104)),
        _voie(30, 30, (X0 + 200, Y0 + 20), (X0 + 200, Y0 + 180)),
        _voie(110, 110, (X0 + 90, Y0 + 120), (X0 + 310, Y0 + 120)),
    ])
    assert r.limites(TRONCON) == (70, 50)
    assert r.limites(TRONCON[::-1]) == (50, 70)
    # Une voie OSM dessinée dans l'autre sens : avant et arrière s'échangent.
    r = Rapprocheur([_voie(70, 50, (X0 + 310, Y0 + 104), (X0 + 90, Y0 + 104))])
    assert r.limites(TRONCON) == (50, 70)


def test_une_voie_qui_ne_longe_qu_un_bout_du_troncon_ne_compte_pas():
    """Moins de la moitié des points : la limite d'une voie qui le rejoint
    au carrefour n'est pas la sienne."""
    r = Rapprocheur([_voie(30, 30, (X0 + 230, Y0 + 102), (X0 + 320, Y0 + 102))])
    assert r.limites(TRONCON) == (None, None)
    assert Rapprocheur([]).limites(TRONCON) == (None, None)


def _troncon(cleabs, points, **props):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [list(p) + [440] for p in points]},
            "properties": {"cleabs": cleabs, "etat_de_l_objet": "En service", "nature": "Route à 1 chaussée",
                           "acces_vehicule_leger": "Libre", "urbain": False, **props}}


def test_chaque_troncon_a_sa_limite_osm_sinon_la_regle():
    demandes = []

    def voies(bi, bj):
        demandes.append((bi, bj))
        return [_voie(70, 70, (X0 + 90, Y0 + 103), (X0 + 310, Y0 + 103))]

    geojson = {"features": [
        _troncon("OSM", TRONCON),
        _troncon("VILLE", [(X0 + 100, Y0 + 300), (X0 + 300, Y0 + 300)], urbain=True),
        _troncon("BRETELLE", [(X0 + 100, Y0 + 400), (X0 + 300, Y0 + 400)], nature="Bretelle"),
        _troncon("FICTIF", [(X0 + 100, Y0 + 450), (X0 + 300, Y0 + 450)], fictif=True),
        _troncon("SENTIER", [(X0 + 100, Y0 + 460), (X0 + 300, Y0 + 460)], nature="Sentier"),
    ]}
    assert vitesses_du_carre(geojson, voies) == [
        ["OSM", 70, 70, 1, 1], ["VILLE", 50, 50, 0, 0], ["BRETELLE", None, None, 0, 0]]
    # Un seul bloc de 2 km : celui des tronçons.
    assert demandes == [(X0 // vitesses.BLOC_M, Y0 // vitesses.BLOC_M)]


def test_les_voies_d_un_bloc_en_lambert_93():
    def noeud(dx, dy):
        lon, lat = carres.wgs84(X0 + dx, Y0 + dy)
        return {"lon": lon, "lat": lat}

    brut = {"elements": [
        {"type": "way", "tags": {"highway": "residential", "maxspeed": "FR:urban"},
         "geometry": [noeud(10, 20), noeud(60, 20)]},
        {"type": "way", "tags": {"highway": "primary", "maxspeed": "80", "maxspeed:backward": "70"},
         "geometry": [noeud(0, 0), noeud(0, 90)]},
        {"type": "way", "tags": {"highway": "service", "maxspeed": "none"}, "geometry": [noeud(0, 0), noeud(5, 5)]},
    ]}
    voies = vitesses.voies_du_bloc(brut)
    assert [v[0] for v in voies] == [[50, 50], [80, 70]]
    assert voies[0][1] == pytest.approx([X0 + 10, Y0 + 20, X0 + 60, Y0 + 20], abs=0.1)


def test_un_bloc_lu_une_fois_ou_pas_du_tout(tmp_path):
    lectures = []

    def lire(bi, bj):
        lectures.append((bi, bj))
        return {"elements": []}

    blocs = BlocsOsm(str(tmp_path), lire=lire)
    assert blocs.obtenir(3, 4) == [] and blocs.obtenir(3, 4) == []
    assert lectures == [(3, 4)]
    chemin = os.path.join(blocs.dossier, "3", "4.json.gz")
    assert os.path.exists(chemin)
    # Relu du disque par un autre service, sans Overpass.
    assert BlocsOsm(str(tmp_path), lire=lambda *a: pytest.fail("relu")).obtenir(3, 4) == []

    def en_panne(bi, bj):
        raise requests.RequestException("Overpass injoignable : 504")

    with pytest.raises(requests.RequestException):
        BlocsOsm(str(tmp_path), lire=en_panne).obtenir(5, 6)
    assert not os.path.exists(os.path.join(blocs.dossier, "5"))


def test_un_carre_de_vitesses_se_lit_ou_echoue_entier(monkeypatch):
    monkeypatch.setattr(vitesses, "lire_couche", lambda *a, **k: {"features": [_troncon("A", TRONCON)]})

    class Blocs:
        def obtenir(self, bi, bj):
            return []

    d = vitesses.fetch_vitesses(I, J, Blocs())
    assert d["version"] == vitesses.VITESSES_VERSION and d["carre"] == [I, J]
    assert d["vitesses"] == [["A", 80, 80, 0, 0]]

    class EnPanne:
        def obtenir(self, bi, bj):
            raise requests.RequestException("Overpass injoignable")

    with pytest.raises(carres.CarreIndisponible):
        vitesses.fetch_vitesses(I, J, EnPanne())
    with pytest.raises(carres.CarreHorsEmprise):
        vitesses.fetch_vitesses(-5, J, Blocs())


def test_overpass_sature_les_carres_de_trop_n_attendent_pas(tmp_path):
    """Limites et signalisation partagent les places des monuments : sans
    place, un carré neuf est refusé aussitôt, un carré écrit reste servi."""
    lus = []

    def lire(i, j):
        lus.append((i, j))
        return {"carre": [i, j], "vitesses": [], "signaux": []}

    client = module_app.creer_app(str(tmp_path), lire_carre=lambda i, j: {"carre": [i, j]},
                                  lire_vitesses=lire, lire_signalisation=lire).test_client()
    assert client.get(f"/api/vitesses?i={I}&j={J}").status_code == 200
    places = [monuments.attente_overpass(RuntimeError) for _ in range(monuments.OVERPASS_ATTENTES)]
    for place in places:
        place.__enter__()
    try:
        for route in ("vitesses", "signalisation"):
            r = client.get(f"/api/{route}?i={I + 1}&j={J}")
            assert r.status_code == 503 and r.headers["Retry-After"] == "10"
        assert client.get(f"/api/vitesses?i={I}&j={J}").status_code == 200
        assert lus == [(I, J)]
    finally:
        for place in places:
            place.__exit__(None, None, None)
    assert client.get(f"/api/vitesses?i={I + 1}&j={J}").status_code == 200


def test_les_vitesses_ont_leur_route_et_leur_dossier(tmp_path):
    def lire(i, j):
        if i == I + 1:
            raise carres.CarreIndisponible("Overpass injoignable")
        return {"carre": [i, j], "vitesses": [["A", 50, 50, 1, 1]]}

    client = module_app.creer_app(str(tmp_path), lire_carre=lambda i, j: {"carre": [i, j]},
                                  lire_vitesses=lire, quota_carres=1).test_client()
    r = client.get(f"/api/vitesses?i={I}&j={J}")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "public, max-age=604800"
    assert json.loads(gzip.decompress(r.data))["vitesses"] == [["A", 50, 50, 1, 1]]
    assert os.path.exists(os.path.join(str(tmp_path), "carres", f"vitesses-v{vitesses.VITESSES_VERSION}",
                                       str(I), f"{J}.json.gz"))
    # Les vitesses du carré ont compté dans le quota des carrés neufs.
    assert client.get(f"/api/carre?i={I}&j={J}").status_code == 429
    client = module_app.creer_app(str(tmp_path), lire_carre=lambda i, j: {}, lire_vitesses=lire).test_client()
    r = client.get(f"/api/vitesses?i={I + 1}&j={J}")
    assert r.status_code == 503 and r.headers["Retry-After"] == "10"


def test_la_page_demande_la_version_des_vitesses():
    """Le navigateur garde un carré une semaine : son adresse porte la version."""
    statique = os.path.join(os.path.dirname(vitesses.__file__), "static")
    grille = open(os.path.join(statique, "js", "voiture", "carres", "grille.js"), encoding="utf-8").read()
    assert f"const VITESSES_VERSION = {vitesses.VITESSES_VERSION};" in grille
    assert "OpenStreetMap (ODbL)" in open(os.path.join(statique, "voiture.html"), encoding="utf-8").read()
