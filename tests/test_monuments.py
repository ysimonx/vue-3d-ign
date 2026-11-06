"""Monuments OSM (vue3d/monuments.py) : parsing et remplacement, sans réseau."""
import gzip
import json
import os
import threading

import pytest
import requests
from shapely.geometry import box

from vue3d import app as module_app
from vue3d import monuments as module_monuments
from vue3d.monuments import (HAUTEUR_PAR_DEFAUT_M, METRES_PAR_NIVEAU,
                             TOIT_PART_COTE, BlocsMonuments, _lignes,
                             monuments_pour_emprise, touche)

# Un degré de longitude vaut ~73,5 km à 48,64° : les carrés ci-dessous font
# quelques dizaines de mètres, comme les parties réelles.
EMPRISE = (-1.5129, 48.6344, -1.5097, 48.6376)


def _way(tags, pts):
    return {"type": "way", "id": 1,
            "tags": tags, "geometry": [{"lon": x, "lat": y} for x, y in pts]}


def _carre(x0, y0, cote_deg):
    return [(x0, y0), (x0 + cote_deg, y0), (x0 + cote_deg, y0 + cote_deg),
            (x0, y0 + cote_deg), (x0, y0)]


def _bat(cleabs, pts, **props):
    return {"type": "Feature",
            "properties": {"cleabs": cleabs, **props},
            "geometry": {"type": "Polygon", "coordinates": [[list(p) for p in pts]]}}


def test_une_partie_complete_est_lue_telle_quelle():
    brut = {"elements": [_way(
        {"building:part": "yes", "height": "20.5", "min_height": "3",
         "roof:shape": "gabled", "roof:height": "4", "name": "La Merveille"},
        _carre(-1.5115, 48.636, 0.0002))]}
    m = monuments_pour_emprise(*EMPRISE, brut, None)
    (p,) = m["parties"]
    assert (p["h"], p["h0"], p["nom"], p["estime"]) == (20.5, 3.0, "La Merveille", False)
    assert p["toit"] == {"forme": "deux_pans", "h": 4.0, "orientation": None}
    assert p["contour"][0] == p["contour"][-1]


def test_sans_hauteur_le_repli_est_la_hauteur_bd_topo_du_batiment_contenant():
    contour = _carre(-1.5115, 48.636, 0.0002)
    brut = {"elements": [_way({"building:part": "yes", "building:levels": "2"}, contour)]}
    bats = {"features": [_bat("BAT1", _carre(-1.5116, 48.6359, 0.0004), hauteur=15.8)]}
    (p,) = monuments_pour_emprise(*EMPRISE, brut, bats)["parties"]
    # La mesure BD TOPO prime sur la convention niveaux × 3.
    assert (p["h"], p["bat"], p["estime"]) == (15.8, "BAT1", True)


def test_sans_hauteur_ni_batiment_les_niveaux_puis_le_defaut_prennent_le_relais():
    a, b = _carre(-1.5115, 48.636, 0.0002), _carre(-1.5110, 48.636, 0.0002)
    brut = {"elements": [_way({"building:part": "yes", "building:levels": "3"}, a),
                         _way({"building:part": "yes"}, b)]}
    p1, p2 = monuments_pour_emprise(*EMPRISE, brut, None)["parties"]
    assert p1["h"] == 3 * METRES_PAR_NIVEAU
    assert p2["h"] == HAUTEUR_PAR_DEFAUT_M


def test_un_toit_en_pente_sans_roof_height_prend_la_part_mesuree_du_petit_cote():
    # Carré de 0,0002° de côté : ~14,7 m en longitude à cette latitude.
    brut = {"elements": [_way({"building:part": "yes", "height": "30",
                               "roof:shape": "pyramidal"},
                              _carre(-1.5115, 48.636, 0.0002))]}
    (p,) = monuments_pour_emprise(*EMPRISE, brut, None)["parties"]
    assert p["toit"]["forme"] == "pyramide"
    cote_attendu = 0.0002 * 73500 * TOIT_PART_COTE   # petit côté ~14,7 m
    assert abs(p["toit"]["h"] - cote_attendu) < 0.5


def test_une_forme_inconnue_reste_un_sommet_plat():
    brut = {"elements": [_way({"building:part": "yes", "height": "10",
                               "roof:shape": "dome"},
                              _carre(-1.5115, 48.636, 0.0002))]}
    (p,) = monuments_pour_emprise(*EMPRISE, brut, None)["parties"]
    assert p["toit"] is None


def test_les_outer_d_une_relation_sont_des_parties():
    brut = {"elements": [{
        "type": "relation", "id": 2, "tags": {"building:part": "yes", "height": "8"},
        "members": [
            {"type": "way", "role": "outer",
             "geometry": [{"lon": x, "lat": y} for x, y in _carre(-1.5115, 48.636, 0.0002)]},
            {"type": "way", "role": "inner",
             "geometry": [{"lon": x, "lat": y} for x, y in _carre(-1.51145, 48.63605, 0.00005)]},
        ]}]}
    m = monuments_pour_emprise(*EMPRISE, brut, None)
    assert len(m["parties"]) == 1 and m["parties"][0]["h"] == 8.0


def test_un_way_ouvert_ou_vide_est_ignore_et_sans_partie_la_couche_est_nulle():
    ouvert = _way({"building:part": "yes", "height": "5"},
                  [(-1.5115, 48.636), (-1.5113, 48.636), (-1.5113, 48.6362)])
    assert monuments_pour_emprise(*EMPRISE, {"elements": [ouvert]}, None) is None
    assert monuments_pour_emprise(*EMPRISE, {"elements": []}, None) is None


def test_une_enveloppe_qui_avalerait_des_parties_plus_basses_repart_au_repli():
    """L'église abbatiale du Mont : 78,5 m — la flèche — sur tout le vaisseau,
    qui recouvre des parties mesurées plus basses. Sa hauteur est une
    enveloppe : elle repart sur la hauteur BD TOPO. La partie haute et étroite
    qu'elle contient (la flèche), elle, garde sa mesure."""
    vaisseau = _carre(-1.5115, 48.636, 0.0004)
    clocheton = _carre(-1.5114, 48.6361, 0.0001)     # dedans, plus bas
    fleche = _carre(-1.51135, 48.63615, 0.00003)     # dedans, plus haut
    brut = {"elements": [
        _way({"building:part": "yes", "height": "78.5"}, vaisseau),
        _way({"building:part": "yes", "height": "26"}, clocheton),
        _way({"building:part": "yes", "height": "79"}, fleche),
    ]}
    bats = {"features": [_bat("EGLISE", _carre(-1.51155, 48.63595, 0.0005), hauteur=20.3)]}
    parts = monuments_pour_emprise(*EMPRISE, brut, bats)["parties"]
    assert [(p["h"], p["estime"]) for p in parts] == [
        (20.3, True), (26.0, False), (79.0, False)]


def test_le_batiment_couvert_est_remplace_le_voisin_non():
    """La règle mesurée au Mont : couvert aux 2/3 par l'union dilatée de 5 m.

    Le bâtiment sous la partie est remplacé même si leurs contours diffèrent
    d'un ou deux mètres ; la maison à 30 m n'est pas touchée.
    """
    partie = _carre(-1.5115, 48.636, 0.0002)
    sous = _carre(-1.51152, 48.63598, 0.0002)       # décalé de ~2 m
    loin = _carre(-1.5110, 48.636, 0.0002)          # à ~35 m
    brut = {"elements": [_way({"building:part": "yes", "height": "12"}, partie)]}
    bats = {"features": [_bat("SOUS", sous, hauteur=10), _bat("LOIN", loin, hauteur=10)]}
    m = monuments_pour_emprise(*EMPRISE, brut, bats)
    assert m["remplaces"] == ["SOUS"]


def test_une_partie_qui_sort_de_la_scene_garde_son_batiment_coupe():
    """Le bord de la scène coupe le bâtiment BD TOPO, pas la partie OSM : le
    centre de la partie tombe hors du morceau gardé, qui reste son bâtiment —
    pour la hauteur de repli comme pour le remplacement. Un bâtiment entier
    qui ne fait que la chevaucher, lui, ne l'adopte pas."""
    partie = [(-1.5099, 48.636), (-1.5093, 48.636), (-1.5093, 48.6362),
              (-1.5099, 48.6362), (-1.5099, 48.636)]          # centre hors de l'emprise
    morceau = [(-1.5099, 48.636), (-1.50972, 48.636), (-1.50972, 48.6362),
               (-1.5099, 48.6362), (-1.5099, 48.636)]
    brut = {"elements": [_way({"building:part": "yes"}, partie)]}
    coupe = {"features": [_bat("COUPE", morceau, hauteur=12.0,
                               coupe={"part": 0.3, "largeur_m": 20.0})]}
    (p,) = monuments_pour_emprise(*EMPRISE, brut, coupe)["parties"]
    assert (p["h"], p["bat"], p["estime"]) == (12.0, "COUPE", True)
    entier = {"features": [_bat("ENTIER", morceau, hauteur=12.0)]}
    (p,) = monuments_pour_emprise(*EMPRISE, brut, entier)["parties"]
    assert (p["h"], p["bat"]) == (HAUTEUR_PAR_DEFAUT_M, None)


# --- Extrait embarqué des lieux d'exemple ---------------------------------

def _lieux_du_readme():
    import re
    from pathlib import Path
    from vue3d.scene import point_normalise
    texte = (Path(__file__).resolve().parent.parent / "README.md").read_text(encoding="utf-8")
    return {point_normalise(float(a), float(b))
            for a, b in re.findall(r"/\?lat=(-?[\d.]+)&lon=(-?[\d.]+)", texte)}


def test_chaque_lieu_d_exemple_du_readme_est_dans_l_extrait():
    """Un exemple ajouté au README sans relancer l'outil se voit ici."""
    from vue3d.monuments import _extrait, cle_emprise
    from vue3d.scene import emprise
    lieux = _lieux_du_readme()
    assert len(lieux) >= 10
    manquants = sorted(l for l in lieux if cle_emprise(*emprise(*l)) not in _extrait()["emprises"])
    assert not manquants, f"relancer outils/extraire_monuments_exemples.py : {manquants}"


def test_un_lieu_d_exemple_n_attend_pas_overpass(monkeypatch):
    """Le Mont-Saint-Michel a ses parties sans une seule requête."""
    from vue3d import monuments
    from vue3d.scene import emprise, point_normalise

    def interdit(*a, **k):
        raise AssertionError("Overpass interrogé pour un lieu d'exemple")

    monkeypatch.setattr(monuments.requests, "post", interdit)
    bbox = emprise(*point_normalise(48.6360, -1.5114))
    m = monuments.monuments_pour_emprise(*bbox, monuments.fetch_monuments(*bbox), {"features": []})
    assert m and m["parties"]


def test_ailleurs_overpass_reste_interroge(monkeypatch):
    from vue3d import monuments
    appels = []

    class Reponse:
        ok, status_code = True, 200

        def json(self):
            return {"elements": []}

    monkeypatch.setattr(monuments.requests, "post", lambda *a, **k: appels.append(a) or Reponse())
    assert monuments.fetch_monuments(2.0, 47.0, 2.0032, 47.0032) == {"elements": []}
    assert len(appels) == 1


# --- Les blocs ---------------------------------------------------------------

def _partie(identifiant, lon, lat, d=0.0002, type_="way"):
    """Une partie carrée telle qu'Overpass la rend, avec ce que les blocs ne
    gardent pas (`bounds`, `nodes`)."""
    geometrie = [{"lon": x, "lat": y} for x, y in _carre(lon - d, lat - d, 2 * d)]
    element = {"type": type_, "id": identifiant, "tags": {"building:part": "yes", "height": "12"},
               "bounds": {"minlat": lat - d, "minlon": lon - d, "maxlat": lat + d, "maxlon": lon + d}}
    if type_ == "way":
        return {**element, "nodes": [1, 2, 3, 4, 1], "geometry": geometrie}
    return {**element, "members": [{"type": "way", "ref": 9, "role": "outer", "geometry": geometrie}]}


class Overpass:
    """Un faux Overpass, qui rend ce qui a un nœud dans le rectangle et se
    souvient de ce qu'on lui a demandé."""

    def __init__(self, *elements):
        self.elements = elements
        self.lus = []

    def __call__(self, west, south, east, north):
        self.lus.append((west, south, east, north))
        return {"elements": [e for e in self.elements if any(
            west <= p["lon"] <= east and south <= p["lat"] <= north
            for ligne in _lignes(e) for p in ligne)]}


def _ids(reponse):
    return [(e["type"], e["id"]) for e in reponse["elements"]]


def test_un_bloc_lu_sert_aux_points_voisins_sans_deborder_de_leur_emprise(tmp_path):
    """Monuments_pour_emprise dessine tout ce qu'il reçoit : chaque point ne
    reçoit que ce qui touche son emprise, sans relire Overpass."""
    overpass = Overpass(_partie(1, 2.0015, 47.0015), _partie(2, 2.0055, 47.0055), _partie(3, 2.0040, 47.0030))
    blocs = BlocsMonuments(str(tmp_path), lire=overpass)
    assert _ids(blocs(2.001, 47.001, 2.004, 47.004)) == [("way", 1), ("way", 3)]
    assert _ids(blocs(2.0039, 47.003, 2.006, 47.006)) == [("way", 2), ("way", 3)]
    assert overpass.lus == [(2.0, 47.0, 2.01, 47.01)]


def test_une_requete_couvre_les_blocs_manquants_et_eux_seuls(tmp_path):
    overpass = Overpass(_partie(1, 2.0095, 47.0015), _partie(2, 2.0105, 47.0015), _partie(3, 2.0205, 47.0015))
    blocs = BlocsMonuments(str(tmp_path), lire=overpass)
    assert _ids(blocs(2.009, 47.001, 2.011, 47.002)) == [("way", 1), ("way", 2)]
    assert overpass.lus == [(2.0, 47.0, 2.02, 47.01)]
    assert _ids(blocs(2.0091, 47.001, 2.021, 47.002)) == [("way", 1), ("way", 2), ("way", 3)]
    assert overpass.lus[1:] == [(2.02, 47.0, 2.03, 47.01)]


def test_la_reponse_a_l_ordre_d_overpass_et_chaque_element_une_fois(tmp_path):
    """Les ways puis les relations, par identifiant, même à cheval sur deux
    blocs : l'ordre décide des parties que les enveloppes avalent."""
    elements = [_partie(5, 2.0100, 47.0015), _partie(3, 2.0095, 47.0015),
                _partie(1, 2.0105, 47.0015, type_="relation")]
    blocs = BlocsMonuments(str(tmp_path), lire=Overpass(*elements))
    assert _ids(blocs(2.009, 47.001, 2.011, 47.002)) == [("way", 3), ("way", 5), ("relation", 1)]


def test_la_couche_lue_par_blocs_est_celle_lue_d_overpass(tmp_path):
    elements = [_partie(k, 2.001 + k / 2000, 47.003, d=0.0001) for k in range(1, 8)]
    emprise = (2.0012, 47.002, 2.0028, 47.004)
    overpass = Overpass(*elements)
    direct = overpass(*emprise)
    assert len(direct["elements"]) == 3
    blocs = BlocsMonuments(str(tmp_path), lire=overpass)(*emprise)
    assert monuments_pour_emprise(*emprise, blocs, {"features": []}) \
        == monuments_pour_emprise(*emprise, direct, {"features": []})


def testtouche_comme_le_filtre_d_overpass():
    """Un segment qui traverse le rectangle suffit, sans nœud dedans ; une
    partie qui l'englobe n'y est pas : ni nœud, ni segment."""
    rectangle = box(2.0, 47.0, 2.001, 47.001)
    traverse = _way({}, [(1.99, 47.0005), (2.01, 47.0005), (2.01, 47.0006), (1.99, 47.0006), (1.99, 47.0005)])
    englobe = _way({}, _carre(1.9, 46.9, 0.3))
    assert touche(traverse, rectangle)
    assert not touche(englobe, rectangle)


def test_un_bloc_sans_partie_est_un_fait_garde(tmp_path):
    overpass = Overpass()
    blocs = BlocsMonuments(str(tmp_path), lire=overpass)
    assert blocs(2.001, 47.001, 2.002, 47.002) == {"elements": []}
    assert blocs(2.003, 47.003, 2.004, 47.004) == {"elements": []}
    assert len(overpass.lus) == 1


def test_un_echec_n_ecrit_rien_et_la_lecture_suivante_reessaie(tmp_path):
    overpass = Overpass(_partie(1, 2.0015, 47.0015))
    en_panne = [True]

    def lire(*rectangle):
        if en_panne[0]:
            raise requests.RequestException("Overpass injoignable")
        return overpass(*rectangle)

    blocs = BlocsMonuments(str(tmp_path), lire=lire)
    with pytest.raises(requests.RequestException):
        blocs(2.001, 47.001, 2.002, 47.002)
    assert not os.path.exists(blocs.dossier)
    en_panne[0] = False
    assert _ids(blocs(2.001, 47.001, 2.002, 47.002)) == [("way", 1)]


def test_une_reponse_tronquee_par_overpass_n_est_pas_gardee(tmp_path, monkeypatch):
    """Un 200 avec une remarque : ses éléments manqueraient pour toujours."""
    class Reponse:
        ok, status_code = True, 200

        def json(self):
            return {"remark": "runtime error: Query timed out in \"query\"", "elements": []}

    monkeypatch.setattr(module_monuments.requests, "post", lambda *a, **k: Reponse())
    monkeypatch.setattr(module_monuments, "OVERPASS_ATTENTE_S", 0)
    blocs = BlocsMonuments(str(tmp_path))
    with pytest.raises(requests.RequestException, match="runtime error"):
        blocs(2.001, 47.001, 2.002, 47.002)
    assert not os.path.exists(blocs.dossier)


def test_un_lieu_d_exemple_ne_lit_ni_overpass_ni_les_blocs(tmp_path):
    from vue3d.scene import emprise, point_normalise

    def interdit(*rectangle):
        raise AssertionError("Overpass interrogé pour un lieu d'exemple")

    blocs = BlocsMonuments(str(tmp_path), lire=interdit)
    assert blocs(*emprise(*point_normalise(48.6360, -1.5114)))["elements"]
    assert not os.path.exists(blocs.dossier)


def test_deux_lectures_qui_se_recouvrent_n_en_font_qu_une(tmp_path):
    overpass = Overpass(_partie(1, 2.0095, 47.0015))
    entree, reponse = threading.Event(), threading.Event()

    def lire(*rectangle):
        entree.set()
        assert reponse.wait(10)
        return overpass(*rectangle)

    blocs = BlocsMonuments(str(tmp_path), lire=lire)
    rendus = []
    premier = threading.Thread(target=lambda: rendus.append(blocs(2.001, 47.001, 2.011, 47.002)))
    second = threading.Thread(target=lambda: rendus.append(blocs(2.002, 47.001, 2.012, 47.002)))
    premier.start()
    assert entree.wait(10)
    second.start()
    reponse.set()
    premier.join(10)
    second.join(10)
    assert len(overpass.lus) == 1 and [_ids(r) for r in rendus] == [[("way", 1)]] * 2


def test_oublier_fait_relire_les_blocs_de_l_emprise(tmp_path):
    overpass = Overpass()
    blocs = BlocsMonuments(str(tmp_path), lire=overpass)
    blocs(2.001, 47.001, 2.002, 47.002)
    blocs.oublier(2.001, 47.001, 2.002, 47.002)
    blocs.oublier(2.001, 47.001, 2.002, 47.002)         # déjà parti : pas une erreur
    blocs(2.001, 47.001, 2.002, 47.002)
    assert len(overpass.lus) == 2


def test_le_service_lit_les_monuments_par_blocs(tmp_path, monkeypatch):
    """Sans lecteur injecté, deux points voisins ne font qu'une requête."""
    appels = []

    class Reponse:
        ok, status_code = True, 200

        def json(self):
            return {"elements": []}

    def construire(lat, lon, avancer=None, zone=None):
        scene = {"batiments": {"type": "FeatureCollection", "features": []}}
        return gzip.compress(json.dumps(scene).encode()), b"jpeg"

    monkeypatch.setattr(module_monuments.requests, "post", lambda *a, **k: appels.append(a) or Reponse())
    client = module_app.creer_app(str(tmp_path), construire=construire).test_client()
    for lat in (47.0035, 47.0036):
        assert client.get(f"/api/monuments?lat={lat}&lon=2.005&zone=500").status_code == 200
    assert len(appels) == 1
