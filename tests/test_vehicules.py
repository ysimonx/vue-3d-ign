"""Couche des véhicules et des piscines (vue3d/vehicules.py) : tuiles,
doublons, filtres.

Aucun réseau de neurones n'est chargé : les sessions d'inférence sont des
doublures qui rendent des boîtes écrites à la main, dans la disposition de
chaque export.
"""
import math
import sys
import types

import numpy as np
import pytest

from vue3d import vehicules
from vue3d.vehicules import (COTE, Lecteur, VehiculesMalConfigures, detecter, detecter_piscines,
                             en_geographie, mode_demande, piscines_pour_emprise, sans_doublons,
                             vehicules_pour_emprise)


# --- Configuration ------------------------------------------------------------

def test_sans_variable_la_couche_est_desactivee(monkeypatch):
    monkeypatch.delenv("VUE3D_VEHICULES", raising=False)
    assert mode_demande() == "aucun"
    assert vehicules.lecteur() is None
    monkeypatch.setenv("VUE3D_VEHICULES", "")
    assert mode_demande() == "aucun"


def test_le_mode_est_lu_sans_egard_a_la_casse(monkeypatch):
    monkeypatch.setenv("VUE3D_VEHICULES", " RTMDet ")
    assert mode_demande() == "rtmdet"
    assert mode_demande("tous") == "tous"


def test_un_mode_inconnu_arrete_le_demarrage():
    with pytest.raises(VehiculesMalConfigures, match="aucun, rtmdet, yolo, tous"):
        mode_demande("oui")


def test_un_mode_sans_son_reseau_arrete_le_demarrage(tmp_path):
    """Que le moteur manque ou que ce soit le fichier, l'erreur dit quoi faire."""
    assert vehicules.charger("aucun", str(tmp_path)) == {}
    with pytest.raises(VehiculesMalConfigures, match="VUE3D_VEHICULES=rtmdet"):
        vehicules.charger("rtmdet", str(tmp_path))
    with pytest.raises(VehiculesMalConfigures):
        vehicules.lecteur("tous", str(tmp_path))


def test_le_moteur_est_coreml_la_ou_il_existe_le_processeur_ailleurs(monkeypatch):
    monkeypatch.delenv("VUE3D_MOTEUR", raising=False)
    mac = ["CoreMLExecutionProvider", "CPUExecutionProvider"]
    conteneur = ["AzureExecutionProvider", "CPUExecutionProvider"]
    assert vehicules.moteur_demande(mac) == "coreml"
    assert vehicules.moteur_demande(conteneur) == "processeur"
    assert vehicules.moteur_demande(mac, " Auto ") == "coreml"
    monkeypatch.setenv("VUE3D_MOTEUR", "processeur")
    assert vehicules.moteur_demande(mac) == "processeur"


def test_un_moteur_inconnu_ou_absent_arrete_le_demarrage():
    with pytest.raises(VehiculesMalConfigures, match="auto, processeur, coreml"):
        vehicules.moteur_demande(["CPUExecutionProvider"], "gpu")
    with pytest.raises(VehiculesMalConfigures, match="VUE3D_MOTEUR=coreml"):
        vehicules.moteur_demande(["CPUExecutionProvider"], "coreml")


def _faux_onnxruntime(monkeypatch, tmp_path, pris):
    """Un onnxruntime de doublure, qui a CoreML ; `pris` : les moteurs que
    ses sessions disent avoir gardés. Rend la liste des moteurs demandés."""
    demandes = []

    class Options:
        enable_cpu_mem_arena = True
        intra_op_num_threads = 0

    class Session:
        def __init__(self, chemin, options=None, providers=None):
            demandes.append(providers)
            self.options = options

        def get_providers(self):
            return pris

    monkeypatch.setitem(sys.modules, "onnxruntime", types.SimpleNamespace(
        InferenceSession=Session, SessionOptions=Options,
        get_available_providers=lambda: ["CoreMLExecutionProvider", "CPUExecutionProvider"]))
    (tmp_path / vehicules.DETECTEURS["yolo"]["fichier"]).write_bytes(b"")
    return demandes


def test_les_reseaux_sont_charges_sur_le_moteur_demande(monkeypatch, tmp_path):
    monkeypatch.delenv("VUE3D_MOTEUR", raising=False)
    demandes = _faux_onnxruntime(monkeypatch, tmp_path,
                                 ["CoreMLExecutionProvider", "CPUExecutionProvider"])
    assert list(vehicules.charger("yolo", str(tmp_path))) == ["yolo"]
    assert demandes[-1] == vehicules.MOTEURS["coreml"]
    vehicules.charger("yolo", str(tmp_path), "processeur")
    assert demandes[-1] == ["CPUExecutionProvider"]


def test_au_processeur_les_sessions_rendent_leur_memoire(monkeypatch, tmp_path):
    """Sans arène au processeur : après quatre tuiles simultanées, la mémoire
    retourne au système. Le nombre de fils d'onnxruntime n'est pas touché :
    sous Linux, les sorties en dépendent."""
    monkeypatch.delenv("VUE3D_MOTEUR", raising=False)
    _faux_onnxruntime(monkeypatch, tmp_path, ["CoreMLExecutionProvider", "CPUExecutionProvider"])
    processeur = vehicules.charger("yolo", str(tmp_path), "processeur")["yolo"].options
    assert processeur.enable_cpu_mem_arena is False and processeur.intra_op_num_threads == 0
    coreml = vehicules.charger("yolo", str(tmp_path), "coreml")["yolo"].options
    assert coreml.enable_cpu_mem_arena is True and coreml.intra_op_num_threads == 0


def test_un_repli_muet_sur_le_processeur_arrete_le_demarrage(monkeypatch, tmp_path):
    """onnxruntime remplace sans lever un moteur qui ne s'initialise pas."""
    monkeypatch.delenv("VUE3D_MOTEUR", raising=False)
    _faux_onnxruntime(monkeypatch, tmp_path, ["CPUExecutionProvider"])
    with pytest.raises(VehiculesMalConfigures, match="VUE3D_MOTEUR=processeur"):
        vehicules.charger("yolo", str(tmp_path))
    assert list(vehicules.charger("yolo", str(tmp_path), "processeur")) == ["yolo"]


def test_le_mode_tous_demande_le_detecteur_rapide_d_abord():
    assert vehicules.MODES["tous"] == ("rtmdet", "yolo")
    assert set(vehicules.MODES) == {"aucun", "rtmdet", "yolo", "tous"}


# --- Tuiles ---------------------------------------------------------------------

def test_la_derniere_tuile_est_ramenee_dans_l_image():
    assert vehicules._origines(1283, 512, 128) == [0, 384, 768, 771]
    assert vehicules._origines(1024, 512, 128) == [0, 384, 512]
    # Plus petite que la tuile : une seule, complétée.
    assert vehicules._origines(300, 512, 128) == [0]
    # Toute l'image est couverte, et deux voisines se recouvrent d'au moins 128.
    xs = vehicules._origines(1781, 512, 128)
    assert xs[0] == 0 and xs[-1] + 512 == 1781
    assert all(b - a <= 512 - 128 for a, b in zip(xs, xs[1:]))


def test_les_deux_dispositions_de_sortie_sont_lues():
    ligne = [10, 20, 30, 40, 0.5] + [0.0] * 15
    ligne[5 + 4] = 0.9
    boites, scores = vehicules._boites_rtmdet(np.array([[ligne]], dtype=np.float32))
    assert boites[0].tolist() == pytest.approx([10, 20, 30, 40, 0.5]) and scores[0].argmax() == 4
    # Ultralytics : (1, 20, N), les scores avant l'angle.
    colonne = [10, 20, 30, 40] + [0.0] * 15 + [0.5]
    colonne[4 + 10] = 0.9
    boites, scores = vehicules._boites_yolo(np.array([colonne], dtype=np.float32).T[None])
    assert boites[0].tolist() == pytest.approx([10, 20, 30, 40, 0.5]) and scores[0].argmax() == 10


# --- Doublons -------------------------------------------------------------------

def test_deux_annonces_du_meme_vehicule_n_en_font_qu_un():
    sure, moins_sure = (100, 100, 22, 10, 0.3, 0.8, 0), (101.5, 100.5, 23, 10, 0.32, 0.4, 0)
    assert sans_doublons([moins_sure, sure], 0.3, 5) == [sure]


def test_deux_voitures_garees_cote_a_cote_restent_deux():
    """2,5 m d'entraxe (12,5 px), boîtes de 2,1 m de large : elles se frôlent."""
    a, b = (100, 100, 22, 10.5, math.pi / 2, 0.8, 0), (112.5, 100, 22, 10.5, math.pi / 2, 0.7, 0)
    assert len(sans_doublons([a, b], 0.3, 5)) == 2


def test_une_boite_tronquee_au_meme_endroit_est_un_doublon():
    """Même véhicule, une boîte entière et une demi-boîte décalée de 1,6 m."""
    entiere, demie = (100, 100, 22, 10, 0, 0.8, 0), (108, 100, 12, 10, 0, 0.5, 0)
    assert sans_doublons([entiere, demie], 0.3, 5) == [entiere]


# --- Détection, avec une doublure de réseau ---------------------------------------

class FauxReseau:
    """Session d'inférence qui rend, tuile après tuile, les boîtes données :
    [(cx, cy, l, h, angle, classe, score)], en pixels de la tuile agrandie,
    dans la disposition de l'export de RTMDet-R ou de celui d'Ultralytics."""

    def __init__(self, par_tuile, ultralytics=False):
        self.par_tuile = list(par_tuile)
        self.ultralytics = ultralytics
        self.entrees = []

    def get_inputs(self):
        return [types.SimpleNamespace(name="image")]

    def run(self, _, entree):
        x = entree["image"]
        self.entrees.append(x)
        boites = self.par_tuile[len(self.entrees) - 1] if len(self.entrees) <= len(self.par_tuile) else []
        sortie = np.zeros((1, max(len(boites), 1), 20), dtype=np.float32)
        for i, (cx, cy, l, h, angle, classe, score) in enumerate(boites):
            sortie[0, i, :5] = cx, cy, l, h, angle
            sortie[0, i, 5 + classe] = score
        if self.ultralytics:          # (1, 20, N) : les scores avant l'angle
            sortie = np.concatenate([sortie[:, :, :4], sortie[:, :, 5:], sortie[:, :, 4:5]],
                                    axis=2).transpose(0, 2, 1)
        return [sortie]


# Une seule tuile de 512 px sur une image de 512 px : agrandie 2 fois.
UNE_TUILE = {"rtmdet": {**vehicules.DETECTEURS["rtmdet"], "tuile_px": 512, "recouvrement_px": 128},
             "yolo": {**vehicules.DETECTEURS["rtmdet"], "tuile_px": 512, "recouvrement_px": 128}}
PETIT, GROS, BATEAU = 4, 5, 6


def test_une_boite_revient_a_l_echelle_de_l_image_grand_axe_d_abord():
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    rgb[90:110, 190:210] = (200, 30, 40)
    # Boîte annoncée « debout » : 20 de large, 44 de haut, à l'angle 0.
    reseau = FauxReseau([[(400, 200, 20, 44, 0.0, PETIT, 0.6)]])
    (cx, cy, lo, la, angle, score, gros, couleur, nom), = detecter(rgb, {"rtmdet": reseau}, UNE_TUILE)
    assert (cx, cy, lo, la) == pytest.approx((200, 100, 22, 10))
    assert angle == pytest.approx(math.pi / 2)            # le grand axe, tourné d'un quart
    assert score == pytest.approx(0.6) and gros == 0 and nom == "rtmdet"
    assert couleur == (200 << 16) | (30 << 8) | 40        # lue au cœur de la boîte
    # Le réseau a reçu une tuile RGB de COTE pixels, valeurs de 0 à 1.
    x = reseau.entrees[0]
    assert x.shape == (1, 3, COTE, COTE) and x.dtype == np.float32 and 0 <= x.min() and x.max() <= 1


def test_ce_que_le_reseau_prend_d_abord_pour_autre_chose_n_est_pas_un_vehicule():
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    reseau = FauxReseau([[(400, 200, 44, 20, 0.0, BATEAU, 0.9),          # un « ship »
                          (600, 200, 44, 20, 0.0, PETIT, 0.05),          # sous le seuil
                          (800, 200, 44, 20, 0.0, GROS, 0.5)]])
    (boite,) = detecter(rgb, {"rtmdet": reseau}, UNE_TUILE)
    assert boite[0] == pytest.approx(400) and boite[6] == 1


def test_une_boite_trop_longue_pour_son_detecteur_est_ecartee():
    """rtmdet : 7 m au plus, 35 px d'image, 70 px de tuile agrandie."""
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    reseau = FauxReseau([[(300, 300, 120, 30, 0.0, GROS, 0.9), (600, 600, 60, 22, 0.0, GROS, 0.9)]])
    (boite,) = detecter(rgb, {"rtmdet": reseau}, UNE_TUILE)
    assert boite[2] == pytest.approx(30)


def test_une_boite_coupee_par_le_bord_d_une_tuile_est_laissee_a_la_voisine():
    """Deux tuiles l'une sous l'autre (origines 0 et 384) : la voiture à
    cheval sur le bas de la première n'est gardée que par la seconde."""
    rgb = np.zeros((896, 512, 3), dtype=np.uint8)
    coupee = (400, 1010, 20, 28, 0.0, PETIT, 0.9)          # touche le bas de la tuile 1
    entiere = (400, 250, 20, 44, 0.0, PETIT, 0.6)          # la même, entière, dans la tuile 2
    au_bord_de_l_image = (400, 22, 20, 44, 0.0, PETIT, 0.7)   # le haut de l'image n'est pas une coupe
    boites = detecter(rgb, {"rtmdet": FauxReseau([[coupee, au_bord_de_l_image], [entiere]])}, UNE_TUILE)
    assert sorted((round(b[0]), round(b[1])) for b in boites) == [(200, 11), (200, 509)]


def test_en_mode_tous_le_second_detecteur_n_ajoute_que_ce_que_le_premier_n_a_pas_vu():
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    yolo = FauxReseau([[(400, 200, 44, 20, 0.0, PETIT, 0.5)]])
    rtmdet = FauxReseau([[(404, 203, 46, 21, 0.05, PETIT, 0.9),          # la même, à 1 m
                          (700, 700, 44, 20, 0.0, PETIT, 0.3)]])         # une autre
    boites = detecter(rgb, {"yolo": yolo, "rtmdet": rtmdet}, UNE_TUILE)
    assert [(round(b[0]), b[8]) for b in boites] == [(200, "yolo"), (350, "rtmdet")]


# --- Piscines -------------------------------------------------------------------

PISCINE_RTMDET, PISCINE_YOLO = 13, 14
# Une tuile de 512 px à l'échelle native : une image de 512 px y tient entière.
NATIF = {"rtmdet": {"tuile_px": 512, "recouvrement_px": 128, "seuil": 0.1, "classe": PISCINE_RTMDET},
         "yolo": {"tuile_px": 512, "recouvrement_px": 128, "seuil": 0.2, "classe": PISCINE_YOLO}}


def test_les_piscines_ont_leur_classe_et_leur_seuil_dans_chaque_reseau():
    assert vehicules.PISCINES["rtmdet"]["classe"] == 13 and vehicules.PISCINES["yolo"]["classe"] == 14
    # Un seuil bas pour rtmdet, qui annonce juste même peu sûr de lui.
    assert vehicules.PISCINES["rtmdet"]["seuil"] < vehicules.PISCINES["yolo"]["seuil"]


def test_une_piscine_est_lue_avec_la_couleur_de_son_eau():
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    rgb[80:120, 170:230] = (90, 200, 210)
    reseau = FauxReseau([[(400, 200, 100, 50, 0.0, PISCINE_RTMDET, 0.15),      # 10 m sur 5 m
                          (800, 800, 44, 20, 0.0, PETIT, 0.9),                 # une voiture : pas ici
                          (600, 600, 100, 50, 0.0, PISCINE_RTMDET, 0.05)]])    # sous le seuil
    (cx, cy, lo, la, angle, score, couleur, nom), = detecter_piscines(rgb, {"rtmdet": reseau}, NATIF)
    assert (cx, cy, lo, la) == pytest.approx((200, 100, 50, 25)) and nom == "rtmdet"
    assert couleur == (90 << 16) | (200 << 8) | 210


def test_une_piscine_vue_des_deux_detecteurs_n_est_gardee_qu_une_fois():
    """Les boîtes d'un même bassin diffèrent d'un réseau à l'autre : c'est le
    centre de l'une dans la boîte de l'autre qui fait le doublon."""
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    rtmdet = FauxReseau([[(400, 200, 100, 50, 0.0, PISCINE_RTMDET, 0.6)]])
    yolo = FauxReseau([[(412, 206, 90, 44, 0.1, PISCINE_YOLO, 0.8),            # la même, à 2,7 m
                        (400, 320, 100, 50, 0.0, PISCINE_YOLO, 0.5)]],         # le bassin voisin
                      ultralytics=True)
    boites = detecter_piscines(rgb, {"rtmdet": rtmdet, "yolo": yolo}, NATIF)
    assert [(round(b[1]), b[7]) for b in boites] == [(100, "rtmdet"), (160, "yolo")]


def test_les_piscines_passent_les_memes_filtres_que_les_vehicules():
    brut = {"largeur": 1000, "hauteur": 1000, "piscines": [
        [500, 500, 50, 25, 0.0, 0.4, 0x5AC8D2, "rtmdet"],       # 10 m sur 5 m, au centre
        [550, 300, 50, 25, 0.0, 0.4, 0x5AC8D2, "rtmdet"],       # sur un bâtiment : une véranda
        [300, 700, 50, 25, 0.0, 0.4, 0x5AC8D2, "rtmdet"],       # sur une eau de la BD TOPO
        [700, 700, 10, 8, 0.0, 0.4, 0x5AC8D2, "rtmdet"],        # 2 m : une bâche
        [700, 300, 400, 200, 0.0, 0.4, 0x5AC8D2, "rtmdet"]]}    # 80 m : pas une piscine
    batiments = {"features": [{"type": "Feature", "properties": {}, "geometry": _carre(5, 35, 15, 45)}]}
    eau = {"surfaces": [{"geometrie": _carre(-50, -50, -30, -30)}], "cours": []}
    brut = {"piscines": en_geographie(*BBOX, brut, "piscines")}
    couche = piscines_pour_emprise(*BBOX, brut, "rtmdet", batiments, eau)
    assert couche["mode"] == "rtmdet" and "vehicules" not in couche
    (lon, lat, longueur, largeur, cap, couleur), = couche["piscines"]
    assert (lon, lat) == pytest.approx((LON, LAT), abs=1e-6)
    assert (longueur, largeur, cap, couleur) == (10.0, 5.0, 90.0, 0x5AC8D2)


# --- De la boîte au véhicule ------------------------------------------------------

# Emprise carrée de 200 m à 45° N, image de 1 000 px : 0,2 m par pixel.
LAT, LON = 45.0, 2.0
KX, KY = 111320 * math.cos(math.radians(LAT)), 111320
BBOX = (LON - 100 / KX, LAT - 100 / KY, LON + 100 / KX, LAT + 100 / KY)


def _brut(*boites):
    """Boîtes en pixels d'une image de 1 000 px de l'emprise, passées en
    coordonnées comme le fait un relevé."""
    return {"boites": en_geographie(*BBOX, {"largeur": 1000, "hauteur": 1000, "boites": [
        [*b, 0.5, 0, 0x808080, "rtmdet"] for b in boites]}, "boites")}


def _carre(x0, y0, x1, y1):
    """Polygone GeoJSON d'un rectangle donné en mètres depuis le centre."""
    p = lambda x, y: [LON + x / KX, LAT + y / KY]          # noqa: E731
    return {"type": "Polygon", "coordinates": [[p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y1), p(x0, y0)]]}


def test_position_gabarit_et_cap_d_un_vehicule():
    # Au centre, 4,4 m sur 2 m, grand axe le long des x de l'image : vers l'est.
    couche = vehicules_pour_emprise(*BBOX, _brut((500, 500, 22, 10, 0.0)), "rtmdet")
    assert couche["version"] == vehicules.VEHICULES_VERSION and couche["detecteur"] == "rtmdet"
    (lon, lat, longueur, largeur, cap, couleur), = couche["vehicules"]
    assert (lon, lat) == pytest.approx((LON, LAT), abs=1e-6)
    assert (longueur, largeur, cap, couleur) == (4.4, 2.0, 90.0, 0x808080)


@pytest.mark.parametrize("angle,cap", [(math.pi / 2, 0.0), (math.pi / 4, 135.0),
                                       (-math.pi / 4, 45.0), (math.pi, 90.0)])
def test_le_cap_se_compte_du_nord_vers_l_est_et_l_image_descend_vers_le_sud(angle, cap):
    """+45° dans l'image : vers la droite et le bas, donc le sud-est."""
    couche = vehicules_pour_emprise(*BBOX, _brut((500, 500, 22, 10, angle)), "rtmdet")
    assert couche["vehicules"][0][4] == pytest.approx(cap, abs=0.05)


def test_la_position_suit_l_image_nord_en_haut():
    # 100 px à droite et 200 px au-dessus du centre : 20 m à l'est, 40 m au nord.
    couche = vehicules_pour_emprise(*BBOX, _brut((600, 300, 22, 10, 0.0)), "rtmdet")
    lon, lat = couche["vehicules"][0][:2]
    assert ((lon - LON) * KX, (lat - LAT) * KY) == pytest.approx((20, 40), abs=0.01)


def test_hors_gabarit_la_boite_n_est_pas_un_vehicule():
    trop_court, trop_etroit, trop_large = (300, 300, 10, 8, 0), (400, 400, 22, 4, 0), (600, 600, 40, 20, 0)
    couche = vehicules_pour_emprise(*BBOX, _brut(trop_court, trop_etroit, trop_large), "rtmdet")
    assert couche["vehicules"] == []


def test_un_vehicule_sur_un_toit_ou_sur_l_eau_n_en_est_pas_un():
    sur_le_toit, dans_l_eau, sur_la_route = (550, 500, 22, 10, 0), (300, 500, 22, 10, 0), (500, 800, 22, 10, 0)
    batiments = {"features": [{"type": "Feature", "properties": {}, "geometry": _carre(5, -5, 15, 5)}]}
    eau = {"surfaces": [{"geometrie": _carre(-50, -10, -30, 10)}], "cours": []}
    couche = vehicules_pour_emprise(*BBOX, _brut(sur_le_toit, dans_l_eau, sur_la_route), "rtmdet",
                                    batiments, eau)
    assert len(couche["vehicules"]) == 1
    assert (couche["vehicules"][0][1] - LAT) * KY == pytest.approx(-60, abs=0.01)


def test_au_ras_du_cadre_la_boite_est_ecartee():
    """La scène ne connaît pas les bâtiments de sa bordure."""
    couche = vehicules_pour_emprise(*BBOX, _brut((3, 500, 22, 10, 0), (500, 997, 22, 10, 0)), "rtmdet")
    assert couche["vehicules"] == []


def test_sans_vehicule_la_couche_dit_quand_meme_son_mode():
    assert vehicules_pour_emprise(*BBOX, _brut(), "yolo") == {
        "version": vehicules.VEHICULES_VERSION, "detecteur": "yolo", "vehicules": []}
    assert vehicules_pour_emprise(*BBOX, None, "yolo")["vehicules"] == []
    assert piscines_pour_emprise(*BBOX, None, "yolo") == {
        "version": vehicules.PISCINES_VERSION, "mode": "yolo", "piscines": []}


def test_le_lecteur_a_une_lecture_par_fichier(monkeypatch):
    """Les piscines, vues de tous les détecteurs ; les véhicules, détecteur
    par détecteur — le rapide n'attend pas le lent."""
    rgb = np.zeros((512, 512, 3), dtype=np.uint8)
    monkeypatch.setattr(Lecteur, "_orthophoto", staticmethod(lambda *bbox: rgb))
    # Les vrais réglages : yolo découpe l'image en tuiles de 160 px, rtmdet
    # en une seule ; chaque doublure annonce une voiture dans sa première.
    sessions = {"rtmdet": FauxReseau([[(400, 200, 44, 20, 0.0, PETIT, 0.9)]]),
                "yolo": FauxReseau([[(300, 300, 44, 20, 0.0, 10, 0.9)]], ultralytics=True)}
    lecteur = Lecteur("tous", sessions)
    assert lecteur.detecteurs == ("rtmdet", "yolo")
    brut = lecteur.vehicules("yolo")(0, 0, 1, 1)
    assert [b[8] for b in brut["boites"]] == ["yolo"] and (brut["largeur"], brut["hauteur"]) == (512, 512)
    assert [b[8] for b in lecteur.vehicules("rtmdet")(0, 0, 1, 1)["boites"]] == ["rtmdet"]
    assert lecteur.piscines(0, 0, 1, 1)["piscines"] == []


def test_le_lecteur_prend_l_orthophoto_deja_lue(monkeypatch):
    """L'orthophoto partagée (scene.Cache.prelire_vehicules) est passée en
    `rgb` : la lecture ne la relit pas."""
    lues = []
    monkeypatch.setattr(Lecteur, "_orthophoto", staticmethod(lambda *bbox: lues.append(bbox)))
    rgb = np.zeros((300, 400, 3), dtype=np.uint8)
    lecteur = Lecteur("rtmdet", {"rtmdet": FauxReseau([])})
    assert lecteur.vehicules("rtmdet")(0, 0, 1, 1, rgb=rgb)["largeur"] == 400
    assert lecteur.piscines(0, 0, 1, 1, rgb=rgb)["hauteur"] == 300
    assert lues == []


# --- Tuiles présentées en même temps ------------------------------------------------

class ReseauParContenu:
    """Doublure qui lit la tuile qu'on lui présente : une voiture en son
    centre, au score de sa luminosité moyenne, quel que soit l'ordre des
    appels. Compte les appels simultanés ; `attendre` : le premier appel
    attend qu'un second commence (une seconde au plus), pour que les fils
    se recouvrent à coup sûr."""

    def __init__(self, en_panne_a=None, attendre=False):
        import threading
        self.verrou = threading.Lock()
        self.en_cours = self.simultanes = self.appels = 0
        self.en_panne_a = en_panne_a
        self.ensemble = threading.Event() if attendre else None

    def get_inputs(self):
        return [types.SimpleNamespace(name="image")]

    def run(self, _, entree):
        with self.verrou:
            self.appels += 1
            self.en_cours += 1
            self.simultanes = max(self.simultanes, self.en_cours)
            panne = self.appels == self.en_panne_a
            if self.ensemble and self.en_cours > 1:
                self.ensemble.set()
        try:
            if self.ensemble:
                self.ensemble.wait(1)
            if panne:
                raise RuntimeError("inférence en échec")
            sortie = np.zeros((1, 1, 20), dtype=np.float32)
            sortie[0, 0, :5] = COTE / 2, COTE / 2, 44, 20, 0.0
            sortie[0, 0, 5 + PETIT] = float(entree["image"].mean())
            return [sortie]
        finally:
            with self.verrou:
                self.en_cours -= 1


def _image_bruitee():
    """896 × 1 024 px : six tuiles de rtmdet (512 px, 128 de recouvrement),
    chacune de luminosité différente."""
    return np.random.default_rng(7).integers(0, 256, size=(896, 1024, 3), dtype=np.uint8)


@pytest.mark.parametrize("fils", [2, 4])
def test_les_tuiles_presentees_ensemble_donnent_les_memes_boites(fils):
    """Préparées et passées au réseau dans plusieurs fils, les tuiles sont
    lues dans leur ordre : mêmes boîtes, au même rang, qu'une à une."""
    rgb = _image_bruitee()
    une_a_une = detecter(rgb, {"rtmdet": ReseauParContenu()})
    reseau = ReseauParContenu(attendre=True)
    ensemble = detecter(rgb, {"rtmdet": reseau}, fils=fils)
    assert ensemble == une_a_une and len(une_a_une) == 6
    assert reseau.appels == 6 and 1 < reseau.simultanes <= fils
    piscines = {"rtmdet": {"tuile_px": 512, "recouvrement_px": 128, "seuil": 0.1, "classe": PETIT}}
    assert (detecter_piscines(rgb, {"rtmdet": ReseauParContenu()}, piscines, fils=fils)
            == detecter_piscines(rgb, {"rtmdet": ReseauParContenu()}, piscines))


def test_une_tuile_en_echec_fait_echouer_la_detection():
    """Une tuile manquée laisserait un trou dans la couche : l'erreur remonte,
    rien n'est écrit."""
    with pytest.raises(RuntimeError, match="inférence"):
        detecter(_image_bruitee(), {"rtmdet": ReseauParContenu(en_panne_a=3)}, fils=2)


def test_les_tuiles_presentees_ensemble_dependent_du_moteur():
    """CoreML sert une tuile à la fois sur le GPU : deux fils, pour préparer
    la suivante pendant ce temps ; le processeur en prend plus. Une session
    qui ne dit pas son moteur (doublure) en reste à une."""
    def session(*fournisseurs):
        return types.SimpleNamespace(get_providers=lambda: list(fournisseurs))
    coreml = session("CoreMLExecutionProvider", "CPUExecutionProvider")
    processeur = session("CPUExecutionProvider")
    assert vehicules.fils_inference({"yolo": coreml}, 10) == vehicules.FILS_INFERENCE["coreml"]
    assert vehicules.fils_inference({"yolo": processeur}, 10) == vehicules.FILS_INFERENCE["processeur"]
    assert vehicules.fils_inference({"yolo": FauxReseau([])}, 10) == 1
    assert Lecteur("yolo", {"yolo": FauxReseau([])}).fils == 1


@pytest.mark.parametrize("coeurs,attendus", [(16, 4), (10, 4), (6, 3), (4, 2), (2, 1), (1, 1)])
def test_au_processeur_jamais_plus_de_la_moitie_des_coeurs(monkeypatch, coeurs, attendus):
    """Chaque appel prend déjà tous les cœurs et 100 à 300 Mo : sur un
    petit hôte, pas plus d'appels simultanés que la moitié de ses cœurs.
    CoreML, qui ne sert qu'une tuile à la fois, n'en dépend pas."""
    def session(*fournisseurs):
        return types.SimpleNamespace(get_providers=lambda: list(fournisseurs))
    processeur = session("CPUExecutionProvider")
    coreml = session("CoreMLExecutionProvider", "CPUExecutionProvider")
    monkeypatch.setattr(vehicules, "_coeurs_disponibles", lambda: coeurs)
    assert vehicules.fils_inference({"yolo": processeur}) == attendus
    assert Lecteur("yolo", {"yolo": processeur}).fils == attendus
    assert vehicules.fils_inference({"yolo": coreml}) == vehicules.FILS_INFERENCE["coreml"]
    # Le nombre de cœurs inconnu : deux supposés, un seul appel à la fois.
    monkeypatch.setattr(vehicules, "_coeurs_disponibles", lambda: None)
    assert vehicules.fils_inference({"yolo": processeur}) == 1


def test_les_coeurs_disponibles_sont_ceux_du_processus(monkeypatch):
    """Sous Linux, un cpuset (docker --cpuset-cpus) borne les cœurs que
    le processus peut prendre, ce que os.cpu_count ignore."""
    monkeypatch.setattr(vehicules.os, "sched_getaffinity", lambda pid: {0, 1, 2}, raising=False)
    monkeypatch.setattr(vehicules.os, "cpu_count", lambda: 10)
    assert vehicules._coeurs_disponibles() == 3
    monkeypatch.delattr(vehicules.os, "sched_getaffinity")
    assert vehicules._coeurs_disponibles() == 10
