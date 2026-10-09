"""Ventes DVF (vue3d/dvf.py) : fichiers par commune, jointure par parcelle,
prix au m², Alsace-Moselle. Sans réseau."""
import io
import csv

import pytest
import requests

from vue3d import dvf
from vue3d.dvf import dvf_pour_emprise

BBOX = (2.0, 45.0, 2.01, 45.01)
CHAMPS = ["id_mutation", "date_mutation", "nature_mutation", "valeur_fonciere", "id_parcelle",
          "lot1_numero", "type_local", "surface_reelle_bati", "nombre_pieces_principales",
          "code_nature_culture", "code_nature_culture_speciale", "surface_terrain"]


def _ligne(mutation, parcelle, type_local="", surface="", pieces="", culture="", terrain="",
           nature="Vente", valeur="300000", date="2024-05-02", lot=""):
    return dict(zip(CHAMPS, [mutation, date, nature, valeur, parcelle, lot, type_local, surface,
                             pieces, culture, "", terrain]))


def _csv(lignes):
    sortie = io.StringIO()
    ecrivain = csv.DictWriter(sortie, CHAMPS)
    ecrivain.writeheader()
    ecrivain.writerows(lignes)
    return sortie.getvalue()


def _parcelle(idu, x0=2.001, y0=45.001, cote=0.001):
    return {"properties": {"idu": idu, "contenance": 500},
            "geometry": {"type": "Polygon", "coordinates": [[[x0, y0], [x0 + cote, y0], [x0 + cote, y0 + cote],
                                                             [x0, y0 + cote], [x0, y0]]]}}


def test_une_maison_vendue_avec_son_jardin_a_son_prix_au_m2():
    """Le local revient pour chaque culture de sa parcelle, la surface de
    terrain pour chaque local : chacun ne compte qu'une fois."""
    lignes = [_ligne("m1", "84050000AB0001", "Maison", "100", "4", "S", "300"),
              _ligne("m1", "84050000AB0001", "Maison", "100", "4", "J", "500"),
              _ligne("m1", "84050000AB0001", "Dépendance", "", "", "S", "300")]
    (vente,) = dvf._mutations(lignes).values()
    assert vente["type"] == "Maison" and vente["prix_m2"] == 3000 and vente["terrain"] == 800
    assert [loc["type"] for loc in vente["locaux"]] == ["Maison", "Dépendance"]


@pytest.mark.parametrize("lignes", [
    # Deux appartements d'un coup : le prix n'est pas celui d'un logement.
    [_ligne("m", "P", "Appartement", "40", lot="1"), _ligne("m", "P", "Appartement", "60", lot="2")],
    # Une maison et un commerce.
    [_ligne("m", "P", "Maison", "100"), _ligne("m", "P", "Local industriel. commercial ou assimilé", "50")],
    # Un échange, pas une vente.
    [_ligne("m", "P", "Maison", "100", nature="Echange")],
    # Surface bâtie inconnue.
    [_ligne("m", "P", "Maison", "")],
])
def test_le_prix_n_est_ramene_au_m2_que_pour_la_vente_d_un_seul_logement(lignes):
    (vente,) = dvf._mutations(lignes).values()
    assert vente["prix_m2"] is None


def _sources(monkeypatch, parcelles, fichiers, annees=(2024, 2025)):
    """Doublures du cadastre (WFS) et des fichiers DVF ; rend les URL lues."""
    lues = []
    monkeypatch.setattr(dvf, "lire_couche", lambda *a, **k: {"features": parcelles})
    index = "".join(f'<a href="/geo-dvf/latest/csv/{a}/">{a}/</a>' for a in annees)

    class Reponse:
        def __init__(self, texte, status=200):
            self.text, self.status_code, self.ok, self.encoding = texte, status, status < 400, None

    def get(url, **_):
        lues.append(url)
        if url == dvf.DVF_URL:
            return Reponse(index)
        cle = url.removeprefix(dvf.DVF_URL)
        return Reponse(fichiers[cle]) if cle in fichiers else Reponse("", 404)

    monkeypatch.setattr(requests, "get", get)
    return lues


def test_une_vente_est_lue_entiere_des_qu_une_de_ses_parcelles_est_dans_l_emprise(monkeypatch):
    dedans, dehors = "84050000AB0001", "84050000AB0999"
    fichiers = {"2024/communes/84/84050.csv": _csv([
        _ligne("m1", dedans, "Maison", "100", culture="S", terrain="300"),
        _ligne("m1", dehors, "Dépendance", culture="S", terrain="200"),
        _ligne("ailleurs", dehors, "Maison", "80")])}
    lues = _sources(monkeypatch, [_parcelle(dedans)], fichiers)
    brut = dvf.fetch_dvf(*BBOX)
    assert {r["id_mutation"] for r in brut["lignes"]} == {"m1"} and len(brut["lignes"]) == 2
    assert brut["millesimes"] == [2024, 2025] and brut["absent"] == []
    # 2025 n'a pas de fichier pour cette commune : pas de vente, pas une panne.
    assert f"{dvf.DVF_URL}2025/communes/84/84050.csv" in lues
    couche = dvf_pour_emprise(*BBOX, brut)
    (parcelle,) = couche["parcelles"]
    assert parcelle["idu"] == dedans and parcelle["ventes"] == ["m1"]
    assert couche["ventes"]["m1"]["terrain"] == 500 and couche["ventes"]["m1"]["prix_m2"] == 3000
    assert couche["resume"] == {"Maison": {"ventes": 1, "q1": 3000, "mediane": 3000, "q3": 3000}}


def test_paris_lyon_marseille_se_lisent_par_arrondissement(monkeypatch):
    """Le cadastre donne la commune (75056) ; l'identifiant de parcelle,
    l'arrondissement, dont DVF tient un fichier."""
    lues = _sources(monkeypatch, [_parcelle("75103000AG0001")], {}, annees=(2025,))
    dvf.fetch_dvf(*BBOX)
    assert lues[-1] == f"{dvf.DVF_URL}2025/communes/75/75103.csv"


def test_en_alsace_moselle_la_couche_dit_qu_il_n_y_a_pas_de_dvf(monkeypatch):
    lues = _sources(monkeypatch, [_parcelle("67482000AB0001")], {})
    brut = dvf.fetch_dvf(*BBOX)
    assert brut["absent"] == ["Bas-Rhin"] and brut["lignes"] == [] and lues == []
    couche = dvf_pour_emprise(*BBOX, brut)
    assert couche["absent"] == ["Bas-Rhin"] and couche["parcelles"] == [] and couche["resume"] == {}


def test_un_fichier_illisible_fait_echouer_toute_la_lecture(monkeypatch):
    monkeypatch.setattr(dvf.time, "sleep", lambda s: None)
    _sources(monkeypatch, [_parcelle("84050000AB0001")], {})

    def en_panne(url, **_):
        raise requests.ConnectionError("Read timed out")

    monkeypatch.setattr(requests, "get", en_panne)
    with pytest.raises(requests.RequestException, match="injoignables"):
        dvf.fetch_dvf(*BBOX)


def test_une_parcelle_au_bord_est_decoupee_sur_l_emprise():
    parcelle = _parcelle("84050000AB0001", x0=2.0095, cote=0.001)       # déborde à l'est
    brut = {"parcelles": {"features": [parcelle, _parcelle("84050000AB0002")]},
            "lignes": [_ligne("m1", "84050000AB0001", "Maison", "100")], "millesimes": [2024]}
    (p,) = dvf_pour_emprise(*BBOX, brut)["parcelles"]
    assert max(x for x, _ in p["geometrie"]["coordinates"][0]) == pytest.approx(2.01)
