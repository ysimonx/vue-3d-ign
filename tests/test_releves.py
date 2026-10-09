"""Relevés des détections (vue3d/releves.py) : grille, ce qui manque,
doublons d'un relevé à l'autre, et ce qu'un décalage fait détecter."""
import math

import pytest

from vue3d import releves
from vue3d.releves import (MARGE_PISCINES_PX, MARGE_VEHICULES_PX, PAR_DEGRE, TOLERANCE_M, Releves,
                           a_detecter, emprise_image, garder_le_coeur, manquants, recadrer, rectangle,
                           reunir)
from vue3d.vehicules import RESOLUTION_M

MARGE = MARGE_VEHICULES_PX
from vue3d.scene import SCENE_ARRONDI, emprise, point_normalise


def test_la_grille_est_celle_de_la_cle_du_cache():
    assert PAR_DEGRE == 10 ** SCENE_ARRONDI


def test_l_emprise_par_defaut_tombe_juste_sur_la_grille():
    """Calculée en flottants, elle retombe sur ses cellules : 32 de côté."""
    assert rectangle(*emprise(43.9116, 5.2003)) == (51987, 439100, 52019, 439132)
    assert rectangle(*emprise(43.2075, 2.368)) == (23664, 432059, 23696, 432091)
    # Une zone hors du pas : la cellule entamée est prise.
    o, s, e, n = rectangle(*emprise(43.9116, 5.2003, zone=500))
    assert (e - o, n - s) == (46, 46)


def test_l_image_d_un_releve_deborde_de_la_marge_de_chaque_cote():
    rect = rectangle(*emprise(45.0, 2.0))
    west, south, east, north = emprise_image(rect, MARGE)
    kx = 111320 * math.cos(math.radians(45.0))
    assert (rect[0] / PAR_DEGRE - west) * kx == pytest.approx(MARGE * RESOLUTION_M, rel=1e-3)
    assert (north - rect[3] / PAR_DEGRE) * 111320 == pytest.approx(MARGE * RESOLUTION_M)


def test_l_image_des_piscines_recadree_sert_aux_vehicules():
    """Lue une fois, à la marge des piscines : recadrée, son emprise est celle
    d'un relevé des véhicules, au pixel près, et un point garde sa place."""
    import numpy as np
    rect = rectangle(*emprise(45.0, 2.0))
    large = emprise_image(rect, MARGE_PISCINES_PX)
    kx = 111320 * math.cos(math.radians(45.0))
    w, h = int((large[2] - large[0]) * kx / 0.2), int((large[3] - large[1]) * 111320 / 0.2)
    rgb = np.arange(h * w * 3, dtype=np.uint32).reshape(h, w, 3)
    k = MARGE_PISCINES_PX - MARGE_VEHICULES_PX
    bbox, petit = recadrer(large, rgb, k)
    assert petit.shape == (h - 2 * k, w - 2 * k, 3) and (petit[0, 0] == rgb[k, k]).all()
    assert bbox == pytest.approx(emprise_image(rect, MARGE_VEHICULES_PX), abs=0.2 / 111320)
    assert recadrer(large, rgb, 0) == (large, rgb)


def test_apres_un_decalage_seule_la_bande_nouvelle_manque():
    """Une flèche de la page : un quart de zone, au pas de la grille."""
    avant = rectangle(*emprise(43.9116, 5.2003))
    nord = rectangle(*emprise(*point_normalise(43.9116 + 0.0008, 5.2003)))
    assert manquants(nord, [avant]) == [(51987, 439132, 52019, 439140)]
    est = rectangle(*emprise(43.9116, 5.2011))
    assert manquants(est, [avant]) == [(52019, 439100, 52027, 439132)]
    assert manquants(avant, [avant]) == []
    assert manquants(avant, []) == [avant]


def test_en_biais_deux_rectangles_et_l_enveloppe_quand_elle_coute_moins():
    avant = (0, 0, 32, 32)
    biais = (8, 8, 40, 40)
    assert manquants(biais, [avant]) == [(32, 8, 40, 32), (8, 32, 40, 40)]
    assert a_detecter(biais, [avant]) == manquants(biais, [avant])
    # Un damier de trous d'une cellule : chacun paierait sa marge.
    damier = [(i, j, i + 1, j + 1) for i in range(4) for j in range(4) if (i + j) % 2]
    assert len(manquants((0, 0, 4, 4), damier)) == 8
    assert a_detecter((0, 0, 4, 4), damier) == [(0, 0, 4, 4)]


def _boite(lon, lat, score=0.5, detecteur="rtmdet", longueur=4.4, largeur=2.0, cap=90.0):
    return [lon, lat, longueur, largeur, cap, score, 0, 0x808080, detecteur]


def test_le_coeur_garde_ses_boites_a_la_tolerance_pres():
    rect = (20000, 450000, 20010, 450010)                     # ~79 m sur 111 m à 45° N
    west, south, east, north = (v / PAR_DEGRE for v in rect)
    pas_lat = 1 / 111320
    dedans, au_bord, dehors = (_boite(2.0005, 45.0005), _boite(2.0005, north + 1.0 * pas_lat),
                               _boite(2.0005, north + 2 * TOLERANCE_M * pas_lat))
    assert garder_le_coeur(rect, [dedans, au_bord, dehors]) == [dedans, au_bord]


def test_un_vehicule_vu_de_deux_releves_n_est_garde_qu_une_fois():
    """Sur la limite commune, chacun voit la voiture : la plus sûre reste.
    Deux voitures d'un même relevé, même serrées, ne sont jamais fondues."""
    ky = 111320
    meme_a, meme_b = _boite(2.0, 45.0, 0.4), _boite(2.0, 45.0 + 0.3 / ky, 0.7)
    voisine = _boite(2.0, 45.0 + 2.6 / ky, 0.6)               # garée à côté
    serree = _boite(2.0, 45.0 - 2.2 / ky, 0.3)                # même relevé que meme_a
    assert reunir([[meme_a, serree], [meme_b, voisine]], ("rtmdet",)) == [serree, meme_b, voisine]
    # Un seul relevé : rien n'est touché.
    assert reunir([[meme_a, serree]], ("rtmdet",)) == [meme_a, serree]


def test_une_piscine_vue_de_deux_releves_suit_l_ordre_des_detecteurs():
    """Pour les piscines, la règle d'un détecteur à l'autre : le centre de
    l'une dans l'autre ; rtmdet passe devant yolo, quel que soit le score."""
    kx, ky = 111320 * math.cos(math.radians(45.0)), 111320
    rtmdet = [2.0, 45.0, 10.0, 5.0, 90.0, 0.2, 0x5AC8D2, "rtmdet"]
    yolo = [2.0 + 2.7 / kx, 45.0 + 0.5 / ky, 9.0, 4.4, 84.0, 0.8, 0x5AC8D2, "yolo"]
    autre = [2.0, 45.0 + 24 / ky, 10.0, 5.0, 90.0, 0.5, 0x5AC8D2, "yolo"]
    garde = reunir([[yolo, autre], [rtmdet]], ("rtmdet", "yolo"), centre_dans_l_autre=True)
    assert garde == [autre, rtmdet]


# Une voiture tous les 20 m, sur une grille fixée au terrain.
PAS_LAT = 20 / 111320
PAS_LON = 20 / (111320 * math.cos(math.radians(43.9)))


def _grille(west, south, east, north):
    return [(j * PAS_LON, i * PAS_LAT)
            for i in range(math.ceil(south / PAS_LAT), math.floor(north / PAS_LAT) + 1)
            for j in range(math.ceil(west / PAS_LON), math.floor(east / PAS_LON) + 1)]


class _Detection:
    """Doublure d'une lecture du Lecteur : les voitures de la grille que
    l'image montre, en pixels de 0,2 m ; note chaque image demandée."""

    def __init__(self):
        self.images = []

    def __call__(self, west, south, east, north, rgb=None):
        self.images.append((west, south, east, north))
        kx = 111320 * math.cos(math.radians((south + north) / 2))
        largeur, hauteur = int((east - west) * kx / 0.2), int((north - south) * 111320 / 0.2)
        boites = [[(lon - west) / (east - west) * largeur, (north - lat) / (north - south) * hauteur,
                   22, 10, 0.0, 0.5, 0, 0x808080, "rtmdet"] for lon, lat in _grille(west, south, east, north)]
        return {"largeur": largeur, "hauteur": hauteur, "boites": boites}


def test_un_point_decale_ne_detecte_que_la_bande_nouvelle(tmp_path):
    depot, detecter = Releves(str(tmp_path)), _Detection()
    avant = emprise(43.9116, 5.2003)
    premiere = depot.relever("vehicules-rtmdet", avant, detecter, "boites", ("rtmdet",), MARGE)
    assert detecter.images == [emprise_image(rectangle(*avant), MARGE)]
    # Le même point : rien à détecter, la même réponse.
    assert depot.relever("vehicules-rtmdet", avant, detecter, "boites", ("rtmdet",), MARGE) == premiere
    assert len(detecter.images) == 1
    # Une flèche vers le nord : la seule bande nouvelle, et chaque voiture
    # de l'emprise une fois, celles de la limite des deux relevés comprises.
    nord = emprise(*point_normalise(43.9116 + 0.0008, 5.2003))
    boites = depot.relever("vehicules-rtmdet", nord, detecter, "boites", ("rtmdet",), MARGE)
    assert detecter.images[1:] == [emprise_image((51987, 439132, 52019, 439140), MARGE)]
    west, south, east, north = nord
    vues = sorted((round(b[0] / PAS_LON), round(b[1] / PAS_LAT)) for b in boites
                  if west <= b[0] <= east and south <= b[1] <= north)
    attendues = sorted((round(lon / PAS_LON), round(lat / PAS_LAT))
                       for lon, lat in _grille(west, south, east, north))
    assert vues == attendues and len(attendues) > 200


def test_une_detection_en_echec_n_ecrit_rien(tmp_path):
    depot = Releves(str(tmp_path))

    def en_panne(*bbox, rgb=None):
        raise ConnectionError("Read timed out")

    with pytest.raises(ConnectionError):
        depot.relever("piscines-rtmdet", emprise(45.0, 2.0), en_panne, "piscines", ("rtmdet",),
                      MARGE_PISCINES_PX)
    assert depot.a_detecter("piscines-rtmdet", rectangle(*emprise(45.0, 2.0)), MARGE_PISCINES_PX) == [
        rectangle(*emprise(45.0, 2.0))]


def test_les_releves_prevus_par_un_autre_lot_comptent_comme_faits(tmp_path):
    depot = Releves(str(tmp_path))
    avant = rectangle(*emprise(43.9116, 5.2003))
    nord = rectangle(*emprise(*point_normalise(43.9116 + 0.0008, 5.2003)))
    assert depot.a_detecter("vehicules-yolo", nord, MARGE, en_attente=[avant]) == [
        (51987, 439132, 52019, 439140)]


def test_oublier_efface_les_releves_qui_touchent_l_emprise_de_tous_les_genres(tmp_path):
    depot = Releves(str(tmp_path))
    for genre in ("vehicules-rtmdet", "piscines-tous"):
        depot.ecrire(genre, (0, 0, 10, 10), [])
        depot.ecrire(genre, (10, 0, 20, 10), [])
        depot.ecrire(genre, (40, 0, 50, 10), [])
    depot.oublier((5, 5, 12, 8))
    for genre in ("vehicules-rtmdet", "piscines-tous"):
        assert depot._rectangles(genre) == [(40, 0, 50, 10)]


def test_un_fichier_temporaire_n_est_pas_un_releve(tmp_path):
    depot = Releves(str(tmp_path))
    depot.ecrire("vehicules-rtmdet", (-58000, 432000, -57990, 432010), [])
    open(f"{depot._chemin('vehicules-rtmdet')}/tmpab12_cd", "w").close()
    assert depot._rectangles("vehicules-rtmdet") == [(-58000, 432000, -57990, 432010)]
    assert releves.RELEVES_VERSION >= 1
