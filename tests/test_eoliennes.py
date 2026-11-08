"""La couche des éoliennes (vue3d/eoliennes.py), sans réseau : sur un extrait
réel d'Overpass (tests/donnees/eoliennes-fruges.json, une partie du parc de
Fruges, ODbL), et sur des tags écrits ici, recopiés d'éoliennes réelles, pour
les erreurs que l'extrait n'a pas."""

import gzip
import json
import os
import sqlite3
import time
from pathlib import Path

import pytest
import requests

from vue3d import app as module_app
from vue3d import eoliennes as module_eoliennes
from vue3d import monuments as module_monuments
from vue3d.eoliennes import (RAPPORT_MOYEU, BlocsEoliennes, _positif, dimensions, eoliennes_pour_emprise,
                             position, puissance_kw)
from vue3d.osm_local import BaseOsm, Ecrivain, lecteur
from vue3d.scene import NOM_EOLIENNES, emprise_anneau, nom_scene, point_normalise

EXTRAIT = json.loads((Path(__file__).parent / "donnees" / "eoliennes-fruges.json").read_text(encoding="utf-8"))
# Un point au milieu de l'extrait : son anneau en couvre une partie.
LAT, LON = 50.5285, 2.085
ANNEAU = emprise_anneau(*point_normalise(LAT, LON))


class Overpass:
    """Un faux Overpass, qui rend les éoliennes de l'extrait placées dans le
    rectangle et se souvient de ce qu'on lui a demandé."""

    def __init__(self, elements=EXTRAIT["elements"]):
        self.elements = elements
        self.lus = []

    def __call__(self, west, south, east, north):
        self.lus.append((west, south, east, north))
        return {"elements": [e for e in self.elements
                             if west <= position(e)["lon"] <= east and south <= position(e)["lat"] <= north]}


def _ids(reponse):
    return [(e["type"], e["id"]) for e in reponse["elements"]]


# --- Les tags -----------------------------------------------------------------

def test_une_dimension_se_lit_avec_son_unite_ou_une_virgule():
    assert _positif("150") == 150 and _positif("150 m") == 150 and _positif("54,3") == 54.3
    assert _positif("0") is None and _positif("-3") is None and _positif("haute") is None
    assert _positif(None) is None


def test_la_puissance_se_lit_en_kilowatts():
    assert puissance_kw("2.5 MW") == 2500 and puissance_kw("2,5 MW") == 2500
    assert puissance_kw("2. MW") == 2000 and puissance_kw("800 kW") == 800
    assert puissance_kw("3.3 MW;3 MW") == 3300 and puissance_kw("3 W") == pytest.approx(0.003)
    assert puissance_kw("yes") is None and puissance_kw("small_installation") is None
    assert puissance_kw(None) is None


def test_trois_dimensions_qui_se_tiennent_sont_gardees_telles_quelles():
    assert dimensions({"height": "150", "height:hub": "91.5", "rotor:diameter": "117"}) == (91.5, 117, [])


def test_moyeu_et_bout_de_pale_inverses():
    """Des E-70 de Fruges : height=84, height:hub=119."""
    tags = {"height": "84", "height:hub": "119", "rotor:diameter": "70", "generator:output:electricity": "2 MW"}
    assert dimensions(tags) == (84, 70, [])


def test_une_altitude_a_la_place_du_moyeu():
    """Une V163 de l'Yonne : le moyeu à 428,2 m, le bout de pale à 200 m."""
    tags = {"height": "200", "height:hub": "428.2", "rotor:diameter": "163",
            "generator:output:electricity": "4.5 MW"}
    assert dimensions(tags) == (118.5, 163, [])


def test_le_rayon_du_rotor_a_la_place_du_diametre():
    """Une E-82 au rotor:diameter de 41 m."""
    tags = {"height": "139", "height:hub": "100", "rotor:diameter": "41", "generator:output:electricity": "2 MW"}
    assert dimensions(tags) == (100, 78, [])


def test_height_mis_pour_le_moyeu_faute_de_height_hub():
    """Une MM82 : height=80, et un rotor de 82 m. Une vraie hauteur totale
    reste le bout de pale."""
    assert dimensions({"height": "80", "rotor:diameter": "82", "generator:output:electricity": "2 MW"}) \
        == (80, 82, [])
    assert dimensions({"height": "150", "rotor:diameter": "117", "generator:output:electricity": "3 MW"}) \
        == (91.5, 117, [])


def test_une_hauteur_seule_est_le_moyeu_ou_le_bout_de_pale_le_plus_proche_de_sa_classe():
    assert dimensions({"height": "84", "generator:output:electricity": "2 MW"}) == (84, 90, ["d_rotor"])
    moyeu, rotor, estime = dimensions({"height": "150", "generator:output:electricity": "3 MW"})
    assert (moyeu, rotor) == (pytest.approx(RAPPORT_MOYEU * 150), pytest.approx(2 * (1 - RAPPORT_MOYEU) * 150))
    assert estime == ["h_moyeu", "d_rotor"]
    # Sans puissance, pas de classe : le bout de pale.
    assert dimensions({"height": "84"})[2] == ["h_moyeu", "d_rotor"]


def test_sans_dimension_la_classe_de_puissance_puis_les_medianes():
    assert dimensions({"generator:output:electricity": "3.6 MW"}) == (94.5, 117, ["h_moyeu", "d_rotor"])
    assert dimensions({}) == (91, 92.5, ["h_moyeu", "d_rotor"])
    assert dimensions({"height:hub": "100", "generator:output:electricity": "2.2 MW"}) == (100, 90, ["d_rotor"])


def test_une_dimension_estimee_ne_fait_pas_toucher_le_sol_aux_pales():
    """Un moyeu de 30 m seul, quand la classe donne 90 m de rotor ; un rotor de
    150 m seul, quand elle donne 85 m de moyeu."""
    assert dimensions({"height:hub": "30", "generator:output:electricity": "2 MW"}) == (30, 60, ["d_rotor"])
    assert dimensions({"rotor:diameter": "180", "generator:output:electricity": "2 MW"}) == (90, 180, ["h_moyeu"])


def test_le_petit_eolien_garde_son_mat_haut():
    """Une Skystream de 2,4 kW : 3,7 m de rotor sur 10,4 m de mât."""
    tags = {"height": "12.2", "height:hub": "10.4", "rotor:diameter": "3.7", "generator:output:electricity": "2.4 kW"}
    assert dimensions(tags) == (10.4, 3.7, [])
    # Sans puissance, son rotor le dit petit.
    assert dimensions({"height": "12", "rotor:diameter": "3.6", "generator:output:electricity": "yes"}) \
        == (10.2, 3.6, [])
    assert dimensions({"generator:output:electricity": "1.5 kW"}) == (10.4, 3.2, ["h_moyeu", "d_rotor"])


def test_des_dimensions_qui_se_contredisent_ne_disent_rien():
    """Une V100 des Ardennes : le bout de pale et le moyeu en altitudes, le
    rayon pour le diamètre. Aucune paire n'est vraisemblable."""
    tags = {"height": "457", "height:hub": "407", "rotor:diameter": "50", "generator:output:electricity": "2 MW"}
    assert dimensions(tags) == (85, 90, ["h_moyeu", "d_rotor"])


# --- La couche ------------------------------------------------------------------

def test_la_couche_d_un_parc_reel():
    eoliennes = eoliennes_pour_emprise(*EXTRAIT["rectangle"], EXTRAIT)["eoliennes"]
    assert len(eoliennes) == 33
    par_objet = {e["osm"]: e for e in eoliennes}
    inversee = par_objet["node/1524410794"]
    assert (inversee["h_moyeu"], inversee["d_rotor"], inversee["h_total"], inversee["estime"]) == (84, 70, 119, [])
    assert inversee["puissance_kw"] == 2000 and inversee["source"] == "osm" and inversee["mer"] is False
    # Un way, le pied dessiné : son centre ; height=84 seul, le moyeu de sa classe.
    seule = par_objet["way/74968712"]
    centre = next(e["center"] for e in EXTRAIT["elements"] if e["id"] == 74968712)
    assert (seule["lon"], seule["lat"]) == (centre["lon"], centre["lat"])
    assert (seule["h_moyeu"], seule["d_rotor"], seule["estime"]) == (84, 90, ["d_rotor"])
    sans = par_objet["way/74971921"]
    assert (sans["h_moyeu"], sans["d_rotor"], sans["h_total"], sans["estime"]) == (85, 90, 130, ["h_moyeu", "d_rotor"])
    assert sum(not e["estime"] for e in eoliennes) == 9
    assert set(eoliennes[0]) == {"lon", "lat", "h_moyeu", "d_rotor", "h_total", "nom", "ref", "operateur",
                                 "modele", "puissance_kw", "estime", "mer", "osm", "source"}


def test_le_fabricant_precede_le_modele_s_il_n_y_est_pas_deja():
    def modele(**tags):
        brut = {"elements": [{"type": "node", "id": 1, "lon": 2.0, "lat": 47.0, "tags": tags}]}
        return eoliennes_pour_emprise(1.9, 46.9, 2.1, 47.1, brut)["eoliennes"][0]["modele"]
    assert modele(manufacturer="Vestas", model="V110-2.2MW") == "Vestas V110-2.2MW"
    assert modele(manufacturer="Nordex", model="Nordex N117") == "Nordex N117"
    assert modele(model="E-70 E4") == "E-70 E4" and modele() is None


def test_seules_les_eoliennes_placees_dans_l_emprise_et_sinon_rien():
    """Overpass rend aussi les ways qui touchent l'emprise sans que leur
    centre y soit : ils n'y sont pas."""
    assert eoliennes_pour_emprise(2.0, 50.0, 2.01, 50.01, EXTRAIT) is None
    ouest = eoliennes_pour_emprise(2.06, 50.505, 2.085, 50.552, EXTRAIT)["eoliennes"]
    assert ouest and all(e["lon"] <= 2.085 for e in ouest)
    assert eoliennes_pour_emprise(2.0, 50.0, 2.01, 50.01, {"elements": []}) is None


# --- Les blocs -------------------------------------------------------------------

def test_la_couche_lue_par_blocs_est_celle_lue_d_overpass(tmp_path):
    overpass = Overpass()
    direct = overpass(*ANNEAU)
    lue = BlocsEoliennes(str(tmp_path), lire=overpass)(*ANNEAU)
    assert eoliennes_pour_emprise(*ANNEAU, lue) == eoliennes_pour_emprise(*ANNEAU, direct)
    # L'ordre d'Overpass : les nœuds puis les ways, par identifiant.
    assert _ids(lue) == sorted(_ids(lue), key=lambda c: (c[0] != "node", c[1]))


def test_un_bloc_est_ecrit_entier_et_sert_aux_points_voisins(tmp_path):
    overpass = Overpass()
    blocs = BlocsEoliennes(str(tmp_path), lire=overpass)
    blocs(*ANNEAU)
    assert overpass.lus == [(2.05, 50.5, 2.1, 50.55)]          # un bloc de 0,05°
    (chemin,) = [os.path.join(d, f) for d, _, fs in os.walk(blocs.dossier) for f in fs]
    with gzip.open(chemin, "rt", encoding="utf-8") as f:
        bloc = json.load(f)
    assert bloc["version"] == module_eoliennes.BLOCS_VERSION
    assert _ids(bloc) == _ids(Overpass()(2.05, 50.5, 2.1, 50.55))
    voisin = emprise_anneau(LAT - 0.002, LON - 0.002)
    assert blocs(*voisin)["elements"] and len(overpass.lus) == 1


def test_un_echec_d_overpass_n_ecrit_rien_et_la_lecture_suivante_reessaie(tmp_path):
    overpass = Overpass()
    en_panne = [True]

    def lire(*rectangle):
        if en_panne[0]:
            raise requests.RequestException("Overpass injoignable")
        return overpass(*rectangle)

    blocs = BlocsEoliennes(str(tmp_path), lire=lire)
    with pytest.raises(requests.RequestException):
        blocs(*ANNEAU)
    assert not os.path.exists(blocs.dossier)
    en_panne[0] = False
    assert blocs(*ANNEAU)["elements"]


def test_une_reponse_tronquee_par_overpass_n_est_pas_gardee(tmp_path, monkeypatch):
    requetes = []

    class Reponse:
        ok, status_code = True, 200

        def json(self):
            return {"remark": "runtime error: Query timed out in \"query\"", "elements": []}

    monkeypatch.setattr(module_monuments.requests, "post", lambda *a, **k: requetes.append(k) or Reponse())
    monkeypatch.setattr(module_monuments, "OVERPASS_ATTENTE_S", 0)
    blocs = BlocsEoliennes(str(tmp_path))
    with pytest.raises(requests.RequestException, match="runtime error"):
        blocs(*ANNEAU)
    assert not os.path.exists(blocs.dossier)
    requete = requetes[0]["data"]["data"]
    assert 'node["power"="generator"]["generator:source"="wind"]' in requete
    assert 'way["power"="generator"]["generator:source"="wind"]' in requete and "out tags center" in requete


def test_oublier_fait_relire_les_blocs(tmp_path):
    overpass = Overpass()
    blocs = BlocsEoliennes(str(tmp_path), lire=overpass)
    blocs(*ANNEAU)
    blocs.oublier(*ANNEAU)
    blocs.oublier(*ANNEAU)                  # déjà parti : pas une erreur
    blocs(*ANNEAU)
    assert len(overpass.lus) == 2


# --- La base OpenStreetMap locale ---------------------------------------------------

def _base(chemin, elements):
    ecrivain = Ecrivain(str(chemin))
    for e in elements:
        # Comme outils/preparer_osm.py : un way n'est que son centre.
        ecrivain.ajouter("eoliennes", e if e["type"] == "node" else
                         {"type": "way", "id": e["id"], "geometry": [e["center"]], "tags": e["tags"]})
    ecrivain.fermer("2026-11-08")
    return BaseOsm(str(chemin))


def test_la_base_locale_rend_ce_que_rendent_les_blocs(tmp_path):
    base = _base(tmp_path / "osm.sqlite", EXTRAIT["elements"])
    assert base.a_les_eoliennes
    blocs = BlocsEoliennes(str(tmp_path / "cache"), lire=Overpass())
    for rectangle in (ANNEAU, EXTRAIT["rectangle"], (2.0, 50.0, 2.01, 50.01)):
        assert base.eoliennes(*rectangle) == blocs(*rectangle)


def test_une_base_d_avant_les_eoliennes_les_laisse_a_overpass(tmp_path, monkeypatch):
    chemin = tmp_path / "osm.sqlite"
    _base(chemin, [])
    with sqlite3.connect(chemin) as base:
        base.executescript("DROP TABLE eoliennes; DROP TABLE eoliennes_emprises;")
    osm = lecteur(str(chemin))
    assert not osm.a_les_eoliennes
    lus = []
    monkeypatch.setattr(module_eoliennes, "interroger_overpass", lambda requete: lus.append(requete) or
                        {"elements": []})
    client = module_app.creer_app(str(tmp_path / "cache"), construire=_construire, osm=osm).test_client()
    r = client.get(f"/api/eoliennes?lat={LAT}&lon={LON}")
    assert r.status_code == 200 and json.loads(gzip.decompress(r.data)) is None and len(lus) == 1


# --- Le service -----------------------------------------------------------------------

def _construire(lat, lon, avancer=None, zone=None):
    scene = {"version": 1, "bbox": [0, 0, 1, 1], "batiments": {"features": []}}
    return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"


def _client(tmp_path, lire_eoliennes):
    return module_app.creer_app(str(tmp_path), construire=_construire, lire_monuments=lambda *b: {"elements": []},
                                lire_ouvrages=lambda *b: {}, lire_eoliennes=lire_eoliennes).test_client()


def test_la_route_sert_les_eoliennes_de_l_anneau_lues_avec_la_scene(tmp_path):
    overpass = Overpass()
    client = _client(tmp_path, overpass)
    assert client.get(f"/api/scene?lat={LAT}&lon={LON}").status_code == 200
    r = client.get(f"/api/eoliennes?lat={LAT}&lon={LON}")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data)) == eoliennes_pour_emprise(*ANNEAU, EXTRAIT)
    # Lues une fois, en tâche de fond, à la demande de la scène, sur l'anneau.
    assert overpass.lus == [ANNEAU]
    ailleurs = client.get("/api/eoliennes?lat=47.0&lon=2.0")
    assert ailleurs.status_code == 200 and json.loads(gzip.decompress(ailleurs.data)) is None


def test_overpass_en_panne_rend_503_sans_rien_ecrire(tmp_path):
    en_panne = [True]
    overpass = Overpass()

    def lire(*rectangle):
        if en_panne[0]:
            raise requests.RequestException("Overpass injoignable : 504")
        return overpass(*rectangle)

    client = _client(tmp_path, lire)
    r = client.get(f"/api/eoliennes?lat={LAT}&lon={LON}")
    assert r.status_code == 503
    assert "OpenStreetMap" in r.get_json()["erreur"] and "Rien n'a été mis en cache" in r.get_json()["erreur"]
    dossier = tmp_path / nom_scene(*point_normalise(LAT, LON))
    assert (dossier / "scene.json.gz").exists() and not (dossier / NOM_EOLIENNES).exists()
    en_panne[0] = False
    assert client.get(f"/api/eoliennes?lat={LAT}&lon={LON}").status_code == 200
    assert (dossier / NOM_EOLIENNES).exists()


def test_reconstruire_la_scene_relit_ses_eoliennes(tmp_path):
    overpass = Overpass()
    client = _client(tmp_path, BlocsEoliennes(str(tmp_path), lire=overpass))
    assert client.get(f"/api/eoliennes?lat={LAT}&lon={LON}").status_code == 200
    scene = tmp_path / nom_scene(*point_normalise(LAT, LON)) / "scene.json.gz"
    t = time.time() - 3600
    os.utime(scene, (t, t))
    assert client.post(f"/api/reconstruire?lat={LAT}&lon={LON}").status_code == 202
    assert client.get(f"/api/eoliennes?lat={LAT}&lon={LON}").status_code == 200
    assert len(overpass.lus) == 2
