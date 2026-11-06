"""La base OpenStreetMap locale (vue3d/osm_local.py), sans réseau ni fichier PBF :
ses réponses doivent être celles d'Overpass, pour des lecteurs qui ne savent pas
d'où elles viennent."""
import gzip
import json
import sqlite3

import pytest

from vue3d import app as module_app
from vue3d import monuments
from vue3d.monuments import monuments_pour_emprise
from vue3d.osm_local import BaseOsm, Ecrivain, OsmMalConfigure, lecteur
from vue3d.signalisation import signaux_du_bloc
from vue3d.vitesses import voies_du_bloc


def _base(tmp_path, **couches):
    sortie = str(tmp_path / "osm.sqlite")
    ecrivain = Ecrivain(sortie)
    for couche, elements in couches.items():
        for e in elements:
            ecrivain.ajouter(couche, e)
    ecrivain.fermer("2026-11-04")
    return BaseOsm(sortie)


def _way(identifiant, points, tags=None, **plus):
    return {"type": "way", "id": identifiant, "tags": tags or {},
            "geometry": [{"lat": lat, "lon": lon} for lon, lat in points], **plus}


def _carre(lon, lat, d=0.0002):
    """Un carré à sept décimales, comme toute coordonnée d'OpenStreetMap."""
    coins = [(lon - d, lat - d), (lon + d, lat - d), (lon + d, lat + d), (lon - d, lat + d), (lon - d, lat - d)]
    return [(round(x, 7), round(y, 7)) for x, y in coins]


def _relation(identifiant, lon, lat):
    return {"type": "relation", "id": identifiant, "tags": {"building:part": "yes", "name": "Tour d'Été"},
            "members": [{"role": "outer", "geometry": _way(0, _carre(lon, lat))["geometry"]},
                        {"role": "inner", "geometry": _way(0, _carre(lon, lat, 0.0001))["geometry"]}]}


def test_les_reponses_gardent_les_nombres_et_les_tags_d_overpass(tmp_path):
    """Au bit près : 1e-7 degré, l'unité d'OpenStreetMap, redonne ses flottants."""
    way = _way(5, [(7.7510456, 48.5818123), (7.7512001, 48.5818999), (7.7510456, 48.5819777),
                   (7.7510456, 48.5818123)], {"building:part": "yes", "height": "142", "name": "Flèche"})
    relation = _relation(9, 7.7515, 48.5819)
    base = _base(tmp_path, monuments=[relation, way])
    assert base.monuments(7.75, 48.58, 7.76, 48.59)["elements"] == [way, relation]


def test_les_monuments_sont_ceux_du_filtre_d_overpass(tmp_path):
    """Un segment qui traverse suffit ; une partie qui englobe, non ; une emprise
    qui recouvre le rectangle sans que la ligne le touche, non plus."""
    traverse = _way(1, [(1.99, 47.0005), (2.01, 47.0005), (2.01, 47.0006), (1.99, 47.0006), (1.99, 47.0005)])
    englobe = _way(2, [(1.9, 46.9), (2.1, 46.9), (2.1, 47.1), (1.9, 47.1), (1.9, 46.9)])
    equerre = _way(3, [(1.99, 46.99), (2.0005, 46.99), (2.0005, 46.995), (1.99, 46.995), (1.99, 46.99)])
    ailleurs = _way(4, _carre(3.0, 48.0))
    dedans = _way(5, _carre(2.0005, 47.0005, 0.0001))
    base = _base(tmp_path, monuments=[dedans, traverse, englobe, equerre, ailleurs, _relation(1, 2.0005, 47.0005)])
    trouves = base.monuments(2.0, 47.0, 2.001, 47.001)["elements"]
    assert [(e["type"], e["id"]) for e in trouves] == [("way", 1), ("way", 5), ("relation", 1)]


def test_la_couche_des_monuments_est_celle_d_overpass(tmp_path):
    direct = {"elements": [_way(k, _carre(2.001 + k / 2000, 47.003, 0.0001),
                                {"building:part": "yes", "height": str(10 + k)}) for k in range(1, 4)]}
    base = _base(tmp_path, monuments=direct["elements"])
    emprise = (2.001, 47.002, 2.004, 47.004)
    assert monuments_pour_emprise(*emprise, base.monuments(*emprise), {"features": []}) \
        == monuments_pour_emprise(*emprise, direct, {"features": []})


def test_les_voies_rendent_les_limites_d_overpass(tmp_path):
    voies = [_way(2, [(2.0, 47.0), (2.001, 47.001)], {"maxspeed": "50"}),
             _way(1, [(2.002, 47.0), (2.003, 47.0)], {"maxspeed:forward": "30", "maxspeed:backward": "50"}),
             _way(3, [(3.0, 47.0), (3.001, 47.0)], {"maxspeed": "90"})]
    base = _base(tmp_path, voies=voies)
    trouvees = base.voies(1.99, 46.99, 2.01, 47.01)
    assert [e["id"] for e in trouvees["elements"]] == [1, 2]
    assert voies_du_bloc(trouvees) == voies_du_bloc({"elements": [voies[1], voies[0]]})


def test_les_panneaux_viennent_avec_leurs_voies_entieres(tmp_path):
    """Une voie sort du rectangle, mais son cap se lit sur toute sa géométrie."""
    stop = {"type": "node", "id": 10, "lat": 47.0005, "lon": 2.0005, "tags": {"highway": "stop", "direction": "forward"}}
    loin = {"type": "node", "id": 11, "lat": 47.5, "lon": 2.5, "tags": {"highway": "give_way"}}
    porteuse = _way(1, [(1.99, 47.0005), (2.0005, 47.0005), (2.01, 47.0005)], {"highway": "residential"},
                    nodes=[7, 10, 8])
    voisine = _way(2, [(1.99, 47.0006), (2.01, 47.0006)], {"highway": "residential"}, nodes=[11, 12])
    base = _base(tmp_path, signaux=[loin, stop], porteuses=[voisine, porteuse])
    trouves = base.signaux(2.0, 47.0, 2.001, 47.001)
    assert trouves["elements"] == [stop, porteuse]
    assert signaux_du_bloc(trouves) == signaux_du_bloc({"elements": [stop, porteuse]})


def test_une_base_inachevee_ne_remplace_pas_la_precedente(tmp_path):
    base = _base(tmp_path, voies=[_way(1, [(2.0, 47.0), (2.001, 47.001)], {"maxspeed": "50"})])
    interrompue = Ecrivain(base.chemin)
    interrompue.ajouter("voies", _way(2, [(2.0, 47.0), (2.001, 47.001)], {"maxspeed": "70"}))
    interrompue.base.close()
    assert [e["id"] for e in base.voies(1.9, 46.9, 2.1, 47.1)["elements"]] == [1]


def test_le_lecteur_dit_au_demarrage_ce_qui_ne_va_pas(tmp_path, monkeypatch):
    monkeypatch.delenv("VUE3D_OSM", raising=False)
    assert lecteur() is None
    with pytest.raises(OsmMalConfigure, match="base introuvable"):
        lecteur(str(tmp_path / "absente.sqlite"))
    base = _base(tmp_path, voies=[_way(1, [(2.0, 47.0), (2.001, 47.001)], {"maxspeed": "50"})])
    monkeypatch.setenv("VUE3D_OSM", base.chemin)
    assert lecteur().chemin == base.chemin
    connexion = sqlite3.connect(base.chemin)
    connexion.execute("UPDATE meta SET valeur = '0' WHERE cle = 'version'")
    connexion.commit()
    connexion.close()
    with pytest.raises(OsmMalConfigure, match="format 0"):
        lecteur()


def _scene(lat, lon, avancer=None, zone=None):
    scene = {"batiments": {"type": "FeatureCollection", "features": []}}
    return gzip.compress(json.dumps(scene).encode()), b"jpeg"


def test_avec_une_base_le_service_n_interroge_plus_overpass(tmp_path, monkeypatch):
    def interdit(*a, **k):
        raise AssertionError("Overpass interrogé malgré la base locale")

    monkeypatch.setattr(monuments.requests, "post", interdit)
    base = _base(tmp_path, monuments=[_way(1, _carre(2.005, 47.0035), {"building:part": "yes", "height": "20"})])
    client = module_app.creer_app(str(tmp_path / "cache"), construire=_scene, osm=base).test_client()
    r = client.get("/api/monuments?lat=47.0035&lon=2.005&zone=500")
    assert r.status_code == 200 and json.loads(gzip.decompress(r.data))["parties"][0]["h"] == 20


def test_avec_une_base_les_carres_n_attendent_pas_les_places_d_overpass(tmp_path, monkeypatch):
    """Les limites lues viennent de la base, même les places d'Overpass prises."""
    from tests.test_vitesses import I, J
    from vue3d.vitesses import BLOC_M, rectangle_bloc
    bi, bj = 330, 3400
    w, s, e, n = rectangle_bloc(bi, bj)
    voie = _way(1, [(w + 0.001, s + 0.001), (w + 0.002, s + 0.002)], {"maxspeed": "50"})
    base = _base(tmp_path, voies=[voie])
    lues = []
    monkeypatch.setattr(module_app, "fetch_vitesses",
                        lambda i, j, blocs: lues.append(blocs.obtenir(bi, bj)) or {"vitesses": []})
    client = module_app.creer_app(str(tmp_path / "cache"), lire_carre=lambda i, j: {"carre": [i, j]},
                                  osm=base).test_client()
    places = [monuments.attente_overpass(RuntimeError) for _ in range(monuments.OVERPASS_ATTENTES)]
    for place in places:
        place.__enter__()
    try:
        assert client.get(f"/api/vitesses?i={I}&j={J}").status_code == 200
    finally:
        for place in places:
            place.__exit__(None, None, None)
    assert len(lues) == 1 and len(lues[0]) == 1 and lues[0][0][0] == [50, 50] and BLOC_M == 2000
