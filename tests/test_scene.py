"""Cache des scènes (vue3d/scene.py) : clé, complétude, verrou."""
import math
import os
import threading
import time

import pytest

from vue3d import scene
from vue3d.releves import MARGE_PISCINES_PX, MARGE_VEHICULES_PX, emprise_image, rectangle
from vue3d.scene import Cache, HorsEmprise, SceneIncomplete, emprise, point_normalise


def test_le_point_est_arrondi_a_une_dizaine_de_metres():
    assert point_normalise(48.80491234, 2.12041234) == (48.8049, 2.1204)
    # Deux demandes voisines partagent donc la même scène.
    assert point_normalise(48.80494, 2.12036) == point_normalise(48.80486, 2.12044)


@pytest.mark.parametrize("lat,lon", [(40.0, 2.0), (48.8, 12.0), (0, 0), (-21.1, 55.5)])
def test_hors_de_france_metropolitaine_est_refuse(lat, lon):
    with pytest.raises(HorsEmprise):
        point_normalise(lat, lon)


def test_l_emprise_est_centree_sur_le_point():
    ouest, sud, est, nord = emprise(48.8, 2.1)
    assert (ouest + est) / 2 == pytest.approx(2.1) and (sud + nord) / 2 == pytest.approx(48.8)
    assert est - ouest == pytest.approx(2 * scene.SCENE_DELTA)


def test_l_anneau_est_carre_en_metres_et_contient_l_emprise():
    import math
    lat, lon = 48.8, 2.1
    ouest, sud, est, nord = scene.emprise_anneau(lat, lon)
    largeur_m = (est - ouest) * 111320 * math.cos(math.radians(lat))
    hauteur_m = (nord - sud) * 111320
    assert largeur_m == pytest.approx(hauteur_m) == pytest.approx(2 * scene.ANNEAU_DEMI_M)
    o, s, e, n = emprise(lat, lon)
    assert ouest < o and est > e and sud < s and nord > n


def test_une_scene_n_est_construite_qu_une_fois(tmp_path):
    appels = []

    def construire(lat, lon, avancer=None):
        appels.append((lat, lon))
        return b"scene", b"jpeg"

    cache = Cache(str(tmp_path))
    d1 = cache.obtenir(48.80491, 2.12041, construire=construire)
    d2 = cache.obtenir(48.80489, 2.12039, construire=construire)
    assert d1 == d2 and len(appels) == 1
    assert open(os.path.join(d1, scene.NOM_SCENE), "rb").read() == b"scene"
    assert open(os.path.join(d1, scene.NOM_ORTHO), "rb").read() == b"jpeg"


def test_le_suivi_suit_la_construction_puis_s_efface(tmp_path):
    """Pendant la construction, l'étape en cours ; après, « prête ». Une
    construction en échec ne reste pas « en cours » pour toujours."""
    cache = Cache(str(tmp_path))
    vus = []

    def construire(lat, lon, avancer):
        for libelle in ("bâtiments", "routes"):
            avancer(libelle)
            vus.append(cache.avancement(lat, lon))
        return b"s", b"j"

    assert cache.avancement(48.8049, 2.1204) == {"etat": "attente"}
    cache.obtenir(48.8049, 2.1204, construire=construire)
    assert [(v["etat"], v["etape"], v["total"], v["libelle"]) for v in vus] == [
        ("construction", 1, scene.ETAPES_SCENE, "bâtiments"),
        ("construction", 2, scene.ETAPES_SCENE, "routes")]
    assert cache.avancement(48.8049, 2.1204) == {"etat": "prete"}

    def en_panne(lat, lon, avancer):
        avancer("bâtiments")
        raise SceneIncomplete("bâtiments illisibles : Read timed out")

    with pytest.raises(SceneIncomplete):
        cache.obtenir(47.0, 2.0, construire=en_panne)
    assert cache.avancement(47.0, 2.0) == {"etat": "attente"}


_NB_LECTURES = 16


def _fausses_sources(monkeypatch, source="lidar_hd", **remplacees):
    """Les lectures de construire() remplacées par des fausses, le calcul par
    un assemblage presque vide. `remplacees` : nom de fonction du module
    scene -> fausse lecture, en plus des réponses par défaut. Rend {nom: appels}."""
    grille = {"couvert": True, "width": 2, "height": 2, "source": source,
              "bbox": [0, 0, 1, 1], "values": [0.0] * 4}
    appels = {}
    for nom, valeur in {
            "lire_couche": {"features": []}, "fetch_mnh_grid": grille,
            "fetch_exg_grid": None, "fetch_sol_grid": None, "fetch_relief": None,
            "fetch_relief_anneau": None, "lignes_pour_emprise": None,
            "fetch_ortho_jpeg": (b"jpeg", None, None),
            "toits_pour_emprise": {}, "houppiers_pour_emprise": {},
            "eau_pour_emprise": None}.items():
        def faux(*a, _nom=nom, _v=valeur, **k):
            appels.setdefault(_nom, []).append(a)
            if _nom in remplacees:
                return remplacees[_nom](*a, **k)
            return _v
        monkeypatch.setattr(scene, nom, faux)
    return appels


def test_construire_annonce_chacune_de_ses_etapes(monkeypatch):
    """ETAPES_SCENE suit construire() : chaque lecture et chaque calcul est
    annoncé, et le compte tombe juste — sinon la page afficherait « étape 18
    sur 17 »."""
    _fausses_sources(monkeypatch)
    etapes = []
    scene.construire(48.8049, 2.1204, avancer=etapes.append)
    assert len(etapes) == scene.ETAPES_SCENE == _NB_LECTURES + 2
    # Au départ, toutes les lectures attendues, les plus longues en tête.
    assert etapes[0] == "hauteurs du sursol, orthophoto et 14 autres"
    assert etapes[-2:] == ["toitures", "houppiers"] == list(scene.ETAPES_DE_CALCUL)


def test_les_lectures_partent_ensemble(monkeypatch):
    """Les seize lectures sont en cours en même temps : une à une, la
    barrière ne s'ouvrirait jamais."""
    barriere = threading.Barrier(_NB_LECTURES, timeout=5)

    def attendre(*a, _v=None, **k):
        barriere.wait()
        return _v

    grille = {"couvert": True, "width": 2, "height": 2, "source": "lidar_hd",
              "bbox": [0, 0, 1, 1], "values": [0.0] * 4}
    _fausses_sources(
        monkeypatch, lire_couche=lambda *a, **k: attendre(_v={"features": []}),
        fetch_mnh_grid=lambda *a, **k: attendre(_v=grille), fetch_exg_grid=attendre,
        fetch_sol_grid=attendre, fetch_relief=attendre, fetch_relief_anneau=attendre,
        fetch_ortho_jpeg=lambda *a, **k: attendre(_v=(b"jpeg", None, None)))
    scene.construire(48.8049, 2.1204)


def test_une_source_en_echec_pendant_que_les_autres_tournent(tmp_path, monkeypatch):
    """Une lecture échoue pendant que les autres attendent encore le
    réseau : la scène est incomplète tout de suite, sans attendre les
    autres, et rien n'est écrit."""
    import time
    libere = threading.Event()

    def couche(nom, *a, **k):
        if nom == scene.COUCHE_ROUTES:
            raise RuntimeError("Read timed out")
        libere.wait(10)
        return {"features": []}

    def lente(*a, **k):
        libere.wait(10)
        return None

    _fausses_sources(monkeypatch, lire_couche=couche, fetch_mnh_grid=lente,
                     fetch_exg_grid=lente, fetch_ortho_jpeg=lente)
    cache = Cache(str(tmp_path))
    debut = time.monotonic()
    try:
        with pytest.raises(SceneIncomplete, match="routes illisible"):
            cache.obtenir(48.8049, 2.1204, construire=scene.construire)
        assert time.monotonic() - debut < 5
    finally:
        libere.set()
    assert not cache.present(48.8049, 2.1204)
    assert not os.path.exists(cache._dossier_point(48.8049, 2.1204))
    assert cache.avancement(48.8049, 2.1204) == {"etat": "attente"}


def test_le_compteur_compte_les_lectures_finies():
    """Étape k : k − 1 lectures finies, quel que soit l'ordre où elles
    finissent ; le libellé dit celles qu'on attend encore. La dernière ne
    s'annonce pas : l'étape suivante (les toitures) le fait."""
    import queue
    noms = ["grille", "ortho", "routes", "eau"]
    feux = {nom: threading.Event() for nom in noms}
    annonces = queue.Queue()
    lu = {}
    fil = threading.Thread(target=lambda: lu.update(scene._lire_ensemble(
        [(nom, lambda nom=nom: feux[nom].wait(5) and nom.upper()) for nom in noms],
        annonces.put, terrain=None)))
    fil.start()
    try:
        assert annonces.get(timeout=5) == "grille, ortho et 2 autres"
        for finie, libelle in (("routes", "grille, ortho et 1 autre"),
                               ("grille", "ortho et eau"), ("eau", "ortho")):
            feux[finie].set()
            assert annonces.get(timeout=5) == libelle
    finally:
        for feu in feux.values():
            feu.set()
    fil.join(5)
    assert annonces.empty()
    assert lu == {nom: nom.upper() for nom in noms}


def test_le_terrain_est_relu_a_la_source_de_la_grille(monkeypatch):
    """Le terrain part avec la grille, à la source probable (LiDAR HD). Si
    la grille vient du repli MNS − MNT, il est relu au RGE ALTI, et l'échec
    du terrain LiDAR, devenu inutile, est oublié."""
    def sol(*a, **k):
        if a[-1] == "lidar_hd":
            raise RuntimeError("HTTP 400")
        return ["rge alti"]

    vus = {}
    appels = _fausses_sources(
        monkeypatch, source="mns_mnt", fetch_sol_grid=sol,
        toits_pour_emprise=lambda *a, **k: vus.setdefault("sol", a[-1]) and {})
    etapes = []
    scene.construire(48.8049, 2.1204, avancer=etapes.append)
    assert sorted(a[-1] for a in appels["fetch_sol_grid"]) == ["lidar_hd", "mns_mnt"]
    assert vus["sol"] == ["rge alti"]
    assert len(etapes) == scene.ETAPES_SCENE


def test_le_terrain_lu_avant_la_grille_attend_sa_source(monkeypatch):
    """Fini avant la grille, le terrain n'est retenu (ou son échec signalé)
    qu'une fois la source connue : la même que celle supposée, il est la
    bonne lecture, son échec rend la scène incomplète."""
    grille_lue = threading.Event()
    terrain_fini = threading.Event()

    def mnh(*a, **k):
        terrain_fini.wait(5)
        grille_lue.set()
        return {"couvert": True, "width": 2, "height": 2, "source": "lidar_hd",
                "bbox": [0, 0, 1, 1], "values": [0.0] * 4}

    def sol(*a, **k):
        try:
            raise RuntimeError("HTTP 400")
        finally:
            terrain_fini.set()

    appels = _fausses_sources(monkeypatch, fetch_mnh_grid=mnh, fetch_sol_grid=sol)
    with pytest.raises(SceneIncomplete, match="terrain sous les toits illisible"):
        scene.construire(48.8049, 2.1204)
    assert grille_lue.is_set() and len(appels["fetch_sol_grid"]) == 1


def test_une_grille_sans_couverture_arrete_tout(monkeypatch):
    _fausses_sources(monkeypatch, fetch_mnh_grid=lambda *a, **k: {
        "couvert": False, "source": None, "width": 2, "height": 2, "values": [0.0] * 4})
    with pytest.raises(SceneIncomplete, match="hauteurs du sursol indisponibles"):
        scene.construire(48.8049, 2.1204)


def test_orthophoto_et_terrain_a_la_taille_de_la_grille(monkeypatch):
    """Demandés avant d'avoir la grille, à la taille qu'elle aura : celle
    que fetch_mnh_grid calcule de l'emprise (vue3d/mnh.py)."""
    from vue3d import mnh
    appels = _fausses_sources(monkeypatch)
    scene.construire(48.8049, 2.1204, zone=1000)
    bbox = scene.emprise(48.8049, 2.1204, 1000)
    attendu = mnh.dimensions_grille(*bbox, scene.TOITS_RESOLUTION_M, scene.GRILLE_PIXELS_MAX)
    assert appels["fetch_exg_grid"] == [(*bbox, *attendu)]
    assert appels["fetch_sol_grid"] == [(*bbox, *attendu, "lidar_hd")]


def _scene_avec_un_batiment(lat, lon, avancer=None):
    """Scène minimale : un bâtiment BD TOPO de 20 m autour du point."""
    import gzip
    import json
    d = 0.0001
    batiment = {"type": "Feature", "properties": {"cleabs": "B1", "hauteur": 12},
                "geometry": {"type": "Polygon", "coordinates": [[
                    [lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d],
                    [lon - d, lat + d], [lon - d, lat - d]]]}}
    scene_ = {"batiments": {"type": "FeatureCollection", "features": [batiment]}}
    return gzip.compress(json.dumps(scene_).encode()), b"jpeg"


def _partie_osm(lat, lon, hauteur="30"):
    d = 0.0001
    anneau = [(lon - d, lat - d), (lon + d, lat - d), (lon + d, lat + d),
              (lon - d, lat + d), (lon - d, lat - d)]
    return {"elements": [{"type": "way", "tags": {"building:part": "yes", "height": hauteur},
                          "geometry": [{"lon": x, "lat": y} for x, y in anneau]}]}


def test_la_couche_osm_se_construit_a_part_et_se_met_en_cache(tmp_path):
    """Elle lit les bâtiments de la scène, et une seule fois Overpass."""
    import gzip
    import json
    appels = []

    def lire(*bbox):
        appels.append(bbox)
        return _partie_osm(48.8049, 2.1204)

    cache = Cache(str(tmp_path), lire_monuments=lire)
    d1 = cache.obtenir_monuments(48.8049, 2.1204, construire=_scene_avec_un_batiment)
    d2 = cache.obtenir_monuments(48.8049, 2.1204, construire=_scene_avec_un_batiment)
    assert d1 == d2 and len(appels) == 1
    couche = json.loads(gzip.decompress(open(os.path.join(d1, scene.NOM_MONUMENTS), "rb").read()))
    assert couche["remplaces"] == ["B1"] and couche["parties"][0]["h"] == 30


def test_une_panne_osm_ne_met_rien_en_cache_et_epargne_la_scene(tmp_path):
    """Overpass en panne : la scène est là, la couche non, et la demande
    suivante réessaie."""
    en_panne = [True]

    def lire(*bbox):
        if en_panne[0]:
            raise ConnectionError("Overpass injoignable : 504")
        return {"elements": []}

    cache = Cache(str(tmp_path), lire_monuments=lire)
    with pytest.raises(scene.MonumentsIndisponibles):
        cache.obtenir_monuments(48.8049, 2.1204, construire=_scene_avec_un_batiment)
    assert cache.present(48.8049, 2.1204)
    assert not os.path.exists(cache.chemin(48.8049, 2.1204, scene.NOM_MONUMENTS))
    en_panne[0] = False
    cache.obtenir_monuments(48.8049, 2.1204, construire=_scene_avec_un_batiment)
    assert os.path.exists(cache.chemin(48.8049, 2.1204, scene.NOM_MONUMENTS))


def test_overpass_repond_pendant_que_la_scene_se_construit(tmp_path):
    """La lecture anticipée tourne en même temps que la construction, et la
    couche OSM reprend sa réponse sans relire Overpass."""
    appels = []
    lu = threading.Event()

    def lire(*bbox):
        appels.append(bbox)
        lu.set()
        return {"elements": []}

    pendant = []

    def construire(lat, lon, avancer=None):
        pendant.append(lu.wait(timeout=5))
        return _scene_avec_un_batiment(lat, lon)

    cache = Cache(str(tmp_path), lire_monuments=lire)
    cache.prelire_monuments(48.8049, 2.1204)
    cache.obtenir_monuments(48.8049, 2.1204, construire=construire)
    assert pendant == [True] and len(appels) == 1


def _scene_avec_relief(lat, lon, avancer=None):
    """Scène minimale : un relief plat à 100 m, une masse de sursol au centre."""
    import gzip
    import json
    import numpy as np
    from vue3d import relief
    g = np.full((8, 8), 100.0)
    scene_ = {"relief": relief._quantifier(g, np.zeros(g.shape, dtype=bool), *emprise(lat, lon)),
              "masses": [{"lon": lon, "lat": lat, "h": 9.0}], "routes": {"features": []}}
    return gzip.compress(json.dumps(scene_).encode()), b"jpeg"


def _mur(lat, lon, z):
    d = 0.001
    mur = {"type": "Feature", "properties": {"nature": "Mur"},
           "geometry": {"type": "LineString", "coordinates": [[lon - d, lat, z], [lon + d, lat, z]]}}
    vide = {"features": []}
    return {"lineaires": {"features": [mur]}, "surfaciques": vide, "voies": vide, "terrains": vide}


def test_la_couche_des_ouvrages_lit_le_relief_et_les_masses_de_la_scene(tmp_path):
    """Un mur à 112 m sur un relief à 100 m : 12 m de haut, et la masse que
    le MNH avait posée dessus est expliquée. Une seule lecture de l'IGN."""
    import gzip
    import json
    appels = []

    def lire(*bbox):
        appels.append(bbox)
        return _mur(48.8049, 2.1204, 112.0)

    cache = Cache(str(tmp_path), lire_ouvrages=lire)
    d1 = cache.obtenir_ouvrages(48.8049, 2.1204, construire=_scene_avec_relief)
    d2 = cache.obtenir_ouvrages(48.8049, 2.1204, construire=_scene_avec_relief)
    assert d1 == d2 and len(appels) == 1
    couche = json.loads(gzip.decompress(open(os.path.join(d1, scene.NOM_OUVRAGES), "rb").read()))
    assert couche["murs"][0]["h"] == 12 and couche["masses_expliquees"] == [0]
    # La version de la couche est dans le nom du fichier, pas dans celui de la scène.
    assert f"v{scene.OUVRAGES_VERSION}" in scene.NOM_OUVRAGES


def test_une_panne_des_ouvrages_ne_met_rien_en_cache_et_epargne_la_scene(tmp_path):
    en_panne = [True]

    def lire(*bbox):
        if en_panne[0]:
            raise ConnectionError("HTTP 504 sur construction_lineaire")
        return _mur(48.8049, 2.1204, 112.0)

    cache = Cache(str(tmp_path), lire_ouvrages=lire)
    with pytest.raises(scene.OuvragesIndisponibles):
        cache.obtenir_ouvrages(48.8049, 2.1204, construire=_scene_avec_relief)
    assert cache.present(48.8049, 2.1204)
    assert not os.path.exists(cache.chemin(48.8049, 2.1204, scene.NOM_OUVRAGES))
    en_panne[0] = False
    cache.obtenir_ouvrages(48.8049, 2.1204, construire=_scene_avec_relief)
    assert os.path.exists(cache.chemin(48.8049, 2.1204, scene.NOM_OUVRAGES))


def test_les_ouvrages_sont_lus_pendant_que_la_scene_se_construit(tmp_path):
    """Lecture anticipée, comme pour Overpass, et sans attendre derrière lui :
    chaque source a ses fils."""
    lu = threading.Event()
    overpass_bloque = threading.Event()

    def lire_ouvrages(*bbox):
        lu.set()
        return _mur(48.8049, 2.1204, 112.0)

    def lire_monuments(*bbox):
        overpass_bloque.wait(5)
        return {"elements": []}

    pendant = []

    def construire(lat, lon, avancer=None):
        pendant.append(lu.wait(timeout=5))
        return _scene_avec_relief(lat, lon)

    cache = Cache(str(tmp_path), lire_monuments=lire_monuments, lire_ouvrages=lire_ouvrages)
    # Overpass tient ses deux fils : les ouvrages passent quand même.
    cache.prelire_monuments(48.8049, 2.1204)
    cache.prelire_monuments(48.9, 2.2)
    cache.prelire_ouvrages(48.8049, 2.1204)
    cache.obtenir_ouvrages(48.8049, 2.1204, construire=construire)
    overpass_bloque.set()
    assert pendant == [True]


def test_une_scene_incomplete_n_est_pas_mise_en_cache(tmp_path):
    """Le cache ne périme pas : une scène figée pendant une panne resterait
    fausse pour toujours. Rien n'est écrit, la demande suivante réessaie."""
    cache = Cache(str(tmp_path))

    def en_panne(lat, lon, avancer=None):
        raise SceneIncomplete("orthophoto illisible : Read timed out")

    with pytest.raises(SceneIncomplete):
        cache.obtenir(48.8049, 2.1204, construire=en_panne)
    assert not cache.present(48.8049, 2.1204)
    # La demande suivante, service revenu, réussit.
    cache.obtenir(48.8049, 2.1204, construire=lambda lat, lon, avancer=None: (b"s", b"j"))
    assert cache.present(48.8049, 2.1204)


def test_deux_demandes_simultanees_ne_construisent_pas_deux_fois(tmp_path):
    appels = []
    depart = threading.Event()

    def lente(lat, lon, avancer=None):
        appels.append(1)
        depart.wait(2)
        return b"s", b"j"

    cache = Cache(str(tmp_path))
    fils = [threading.Thread(target=cache.obtenir, args=(48.8049, 2.1204),
                             kwargs={"construire": lente}) for _ in range(4)]
    for f in fils:
        f.start()
    depart.set()
    for f in fils:
        f.join(5)
    assert len(appels) == 1


def test_assembler_n_embarque_pas_les_grilles():
    """La scène porte les résultats, pas les 2,4 Mo d'entrées de calcul."""
    import json
    import numpy as np
    from tests.test_houppiers import _emprise, _grille
    H = _grille(arbres=[(10, 10, 12, 4)])
    grille = _emprise(H)
    grille.update({"couvert": True, "source": "lidar_hd", "resolution_m": 0.5})
    art = scene.assembler(*grille["bbox"], {"features": []}, {"features": []}, None,
                          {"features": []}, grille, np.full(H.shape, 20, dtype=np.int8), None)
    # Les monuments OSM n'y sont pas : couche à part (Cache.obtenir_monuments).
    assert set(art) == {"version", "bbox", "batiments", "toits", "routes",
                        "constructions", "houppiers", "masses", "vegetation",
                        "relief", "anneau", "eau", "lignes"}
    assert len(art["houppiers"]) == 1
    charge = json.dumps(art)
    assert '"values"' not in charge and '"exg"' not in charge


def test_assembler_ne_plante_pas_d_arbre_dans_l_eau():
    """Entre deux quais, le MNH lit leur hauteur en pleine rivière, et l'eau
    est verte à l'orthophoto : à Notre-Dame, 438 houppiers dans la Seine."""
    import numpy as np
    from tests.test_houppiers import _emprise, _grille, _polygone_m
    H = _grille(arbres=[(20, 20, 8, 4)])
    grille = _emprise(H)
    grille.update({"couvert": True, "source": "lidar_hd", "resolution_m": 0.5})
    vert = np.full(H.shape, 20, dtype=np.int8)
    riviere = dict(_polygone_m(grille, 0, 5, 40, 35), properties={"persistance": "Permanent"})
    args = (*grille["bbox"], {"features": []}, {"features": []}, None, {"features": []},
            grille, vert, None)
    assert len(scene.assembler(*args)["houppiers"]) == 1
    art = scene.assembler(*args, eau=({"features": [riviere]}, {"features": []}))
    assert art["houppiers"] == [] and art["masses"] == []
    # L'eau, elle, est toujours dans la scène.
    assert len(art["eau"]["surfaces"]) == 1


def test_assembler_coupe_les_batiments_au_bord_de_la_scene():
    """Le WFS rend le bâtiment entier : la scène n'en garde que ce qui tient
    dans son emprise (vue3d/batiments.py), et le dit."""
    import numpy as np
    from shapely.geometry import shape
    from tests.test_houppiers import _emprise, _grille
    H = _grille()
    grille = _emprise(H)
    grille.update({"couvert": True, "source": "lidar_hd", "resolution_m": 0.5})
    ouest, sud, est, nord = grille["bbox"]
    milieu, quart = (sud + nord) / 2, (nord - sud) / 4
    deborde = {"type": "Feature", "properties": {"cleabs": "LONG"}, "geometry": {
        "type": "Polygon", "coordinates": [[
            [ouest - 1e-3, milieu - quart], [(ouest + est) / 2, milieu - quart],
            [(ouest + est) / 2, milieu + quart], [ouest - 1e-3, milieu + quart],
            [ouest - 1e-3, milieu - quart]]]}}
    art = scene.assembler(ouest, sud, est, nord, {"features": [deborde]}, {"features": []},
                          None, {"features": []}, grille, np.full(H.shape, 20, dtype=np.int8), None)
    (b,) = art["batiments"]["features"]
    assert shape(b["geometry"]).bounds[0] > ouest and 0 < b["properties"]["coupe"]["part"] < 1
    assert "LONG" in art["toits"]["toits"]


# --- Véhicules : la couche optionnelle --------------------------------------------

def _scene_nue(lat, lon, avancer=None):
    import gzip
    import json
    return gzip.compress(json.dumps({"batiments": {"features": []}, "eau": None}).encode()), b"jpeg"


def _lecteur_vehicules(mode, appels=None, en_panne=None, images=None):
    """Doublure de vehicules.Lecteur : `appels` note chaque lecture de
    l'orthophoto ('orthophoto') et chaque détection, par fichier ('piscines'
    ou le détecteur). `en_panne` : [n] — les n lectures de l'orthophoto à
    venir échouent, toutes si n est True. `images` : chaque orthophoto lue."""
    import types

    import numpy as np
    from vue3d.vehicules import MODES

    def orthophoto(*bbox):
        if appels is not None:
            appels.append("orthophoto")
        if en_panne and en_panne[0]:
            if en_panne[0] is not True:
                en_panne[0] -= 1
            raise ConnectionError("Read timed out")
        rgb = np.zeros((1781, 1173, 3), dtype=np.uint8)
        if images is not None:
            images.append(rgb)
        return rgb

    def lecture(quoi):
        def lire(*bbox, rgb=None):
            if rgb is None:
                rgb = orthophoto(*bbox)
            if appels is not None:
                appels.append(quoi)
            if quoi == "piscines":
                return {"largeur": rgb.shape[1], "hauteur": rgb.shape[0],
                        "piscines": [[300, 400, 50, 25, 0.0, 0.3, 0x5AC8D2, mode]]}
            return {"largeur": rgb.shape[1], "hauteur": rgb.shape[0],
                    "boites": [[586.5, 890.5, 22, 10, 0.0, 0.6, 0, 0x808080, quoi]]}
        return lire

    return types.SimpleNamespace(mode=mode, detecteurs=MODES[mode], orthophoto=orthophoto,
                                 piscines=lecture("piscines"), vehicules=lecture)


def test_sans_detecteur_les_couches_de_l_orthophoto_n_existent_pas(tmp_path):
    cache = Cache(str(tmp_path))
    cache.prelire_vehicules(48.8049, 2.1204)              # sans effet, sans erreur
    with pytest.raises(scene.VehiculesDesactives):
        cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    with pytest.raises(scene.VehiculesDesactives):
        cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)


def test_un_fichier_par_detecteur_et_un_pour_les_piscines(tmp_path):
    """Le nom du fichier porte le détecteur (ou le mode, pour les piscines)
    et la version : relancer le service avec un autre détecteur ne ressert
    jamais la couche du précédent, et chaque fichier n'est lu qu'une fois.
    Demandée sans la scène, la première couche lance toutes les détections
    du point, sur une seule orthophoto."""
    import gzip
    import json
    appels = []
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_vehicules("tous", appels))
    dossier, nom = cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    assert cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue) == (dossier, nom)
    assert nom == f"vehicules-rtmdet-v{scene.VEHICULES_VERSION}.json.gz"
    couche = json.loads(gzip.decompress(open(os.path.join(dossier, nom), "rb").read()))
    assert couche["detecteur"] == "rtmdet" and len(couche["vehicules"]) == 1
    _, nom_yolo = cache.obtenir_vehicules(48.8049, 2.1204, "yolo", construire=_scene_nue)
    assert nom_yolo == f"vehicules-yolo-v{scene.VEHICULES_VERSION}.json.gz"
    _, nom_piscines = cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    assert nom_piscines == f"piscines-tous-v{scene.PISCINES_VERSION}.json.gz"
    couche = json.loads(gzip.decompress(open(os.path.join(dossier, nom_piscines), "rb").read()))
    assert couche["mode"] == "tous" and len(couche["piscines"]) == 1
    assert appels == ["orthophoto", "piscines", "rtmdet", "yolo"]
    # Un détecteur que ce service n'a pas.
    with pytest.raises(scene.VehiculesDesactives):
        cache.obtenir_vehicules(48.8049, 2.1204, "inconnu", construire=_scene_nue)


def test_une_panne_de_detection_ne_met_rien_en_cache_et_epargne_la_scene(tmp_path):
    en_panne = [True]
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_vehicules("rtmdet", en_panne=en_panne))
    with pytest.raises(scene.VehiculesIndisponibles):
        cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    with pytest.raises(scene.VehiculesIndisponibles):
        cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    assert cache.present(48.8049, 2.1204)
    assert not os.path.exists(cache.chemin(48.8049, 2.1204, scene.nom_vehicules("rtmdet")))
    assert not os.path.exists(cache.chemin(48.8049, 2.1204, scene.nom_piscines("rtmdet")))
    en_panne[0] = False
    cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    assert os.path.exists(cache.chemin(48.8049, 2.1204, scene.nom_vehicules("rtmdet")))
    assert os.path.exists(cache.chemin(48.8049, 2.1204, scene.nom_piscines("rtmdet")))


def test_les_detections_sont_lancees_pendant_que_la_scene_se_construit(tmp_path):
    """La lecture anticipée sert la demande : une seule détection par
    fichier, les piscines d'abord, puis les détecteurs du rapide au lent,
    et une seule lecture de l'orthophoto pour toutes."""
    appels = []
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_vehicules("tous", appels))
    cache.prelire_vehicules(48.8049, 2.1204)
    cache.prelire_vehicules(48.8049, 2.1204)              # page rechargée : pas de second calcul
    cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    cache.obtenir_vehicules(48.8049, 2.1204, "yolo", construire=_scene_nue)
    cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    assert appels == ["orthophoto", "piscines", "rtmdet", "yolo"]


def test_une_couche_effacee_se_reunit_de_ses_releves_sans_rien_detecter(tmp_path):
    """Les détections sont gardées à part, par relevé (vue3d/releves.py) :
    une couche effacée se réunit des relevés, sans lire l'orthophoto ni
    détecter. Ce qui manque aux relevés se détecte, sur une lecture
    partagée par les seules couches qui en ont besoin."""
    import shutil
    appels = []
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_vehicules("tous", appels))
    cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    for detecteur in ("rtmdet", "yolo"):
        cache.obtenir_vehicules(48.8049, 2.1204, detecteur, construire=_scene_nue)
    avant = open(cache.chemin(48.8049, 2.1204, scene.nom_vehicules("yolo")), "rb").read()
    del appels[:]

    def effacer_les_couches():
        os.remove(cache.chemin(48.8049, 2.1204, scene.nom_vehicules("yolo")))
        os.remove(cache.chemin(48.8049, 2.1204, scene.nom_vehicules("rtmdet")))

    effacer_les_couches()
    cache.prelire_vehicules(48.8049, 2.1204)
    cache.obtenir_vehicules(48.8049, 2.1204, "yolo", construire=_scene_nue)
    cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    assert appels == []
    assert open(cache.chemin(48.8049, 2.1204, scene.nom_vehicules("yolo")), "rb").read() == avant
    effacer_les_couches()
    for detecteur in ("rtmdet", "yolo"):
        shutil.rmtree(cache.releves._chemin(f"vehicules-{detecteur}"))
    cache.prelire_vehicules(48.8049, 2.1204)
    cache.obtenir_vehicules(48.8049, 2.1204, "yolo", construire=_scene_nue)
    cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    assert appels == ["orthophoto", "rtmdet", "yolo"]


def _lecteur_qui_note(notes, retenir=None):
    """Doublure de vehicules.Lecteur en mode rtmdet, sans boîte : `notes`
    reçoit l'emprise de chaque orthophoto lue et de chaque détection
    ('piscines' ou le détecteur). `retenir` : Event que chaque détection
    attend."""
    import types

    import numpy as np

    def orthophoto(west, south, east, north):
        notes.append(("orthophoto", (west, south, east, north)))
        # À 0,2 m, comme ortho.fetch_ortho_rgb : l'image se recadre.
        kx = 111320 * math.cos(math.radians((south + north) / 2))
        return np.zeros((int((north - south) * 111320 / 0.2), int((east - west) * kx / 0.2), 3),
                        dtype=np.uint8)

    def lecture(quoi):
        def lire(*bbox, rgb=None):
            assert retenir is None or retenir.wait(10)
            notes.append((quoi, bbox))
            return {"largeur": 4, "hauteur": 4, "boites": [], "piscines": []}
        return lire

    return types.SimpleNamespace(mode="rtmdet", detecteurs=("rtmdet",), orthophoto=orthophoto,
                                 piscines=lecture("piscines"), vehicules=lecture)


# Gordes, puis une flèche vers le nord : un quart de zone, la bande nouvelle
# de 8 cellules sur les 32 de l'emprise. L'image est lue à la marge des
# piscines ; les véhicules la prennent recadrée à la leur.
DEPART, NORD = (43.9116, 5.2003), (43.9124, 5.2003)
ENTIER = emprise_image(rectangle(*emprise(*DEPART)), MARGE_PISCINES_PX)
BANDE = emprise_image((51987, 439132, 52019, 439140), MARGE_PISCINES_PX)


def _sans_marge(notes):
    """Les notes, chaque emprise ramenée à son cœur au mètre près : celle des
    véhicules, recadrée, ne tombe sur la grille qu'au pixel près."""
    marges = {"orthophoto": MARGE_PISCINES_PX, "piscines": MARGE_PISCINES_PX}
    return [(quoi, _retirer(bbox, marges.get(quoi, MARGE_VEHICULES_PX))) for quoi, bbox in notes]


def _retirer(bbox, marge_px):
    west, south, east, north = bbox
    dlat = marge_px * 0.2 / 111320
    dlon = dlat / math.cos(math.radians((south + north) / 2))
    return rectangle(*(round(v * 10000) / 10000 for v in (west + dlon, south + dlat, east - dlon, north - dlat)))


def test_un_point_decale_ne_detecte_que_la_bande_nouvelle(tmp_path):
    """Seule la bande que les relevés du point d'avant ne couvrent pas est
    lue et détectée ; revenu au point de départ, plus rien."""
    notes = []
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_qui_note(notes))
    for point in (DEPART, NORD, DEPART):
        cache.obtenir_piscines(*point, construire=_scene_nue)
        cache.obtenir_vehicules(*point, "rtmdet", construire=_scene_nue)
    os.remove(cache.chemin(*DEPART, scene.nom_vehicules("rtmdet")))
    cache.obtenir_vehicules(*DEPART, "rtmdet", construire=_scene_nue)
    assert [n[0] for n in notes] == ["orthophoto", "piscines", "rtmdet", "orthophoto", "piscines", "rtmdet"]
    assert notes[0][1] == ENTIER and notes[3][1] == BANDE
    entier, bande = rectangle(*emprise(*DEPART)), (51987, 439132, 52019, 439140)
    assert [c for _, c in _sans_marge(notes)] == [entier] * 3 + [bande] * 3


def test_un_decalage_pendant_la_detection_du_point_d_avant_ne_refait_pas_ce_qu_elle_voit(tmp_path):
    """Deux flèches coup sur coup : le second lot compte comme faits les
    relevés que le premier est en train de détecter."""
    notes, retenir = [], threading.Event()
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_qui_note(notes, retenir))
    cache.prelire_vehicules(*DEPART)
    cache.prelire_vehicules(*NORD)
    retenir.set()
    for tache in list(cache._lectures.values()):
        tache.result(10)
    # Les deux images se lisent ensemble, dans un ordre quelconque.
    assert sorted(b for q, b in notes if q == "orthophoto") == sorted([ENTIER, BANDE])
    entier, bande = rectangle(*emprise(*DEPART)), (51987, 439132, 52019, 439140)
    assert [n for n in _sans_marge(notes) if n[0] != "orthophoto"] == [
        ("piscines", entier), ("rtmdet", entier), ("piscines", bande), ("rtmdet", bande)]
    assert cache._releves_en_attente == {"piscines-rtmdet": [], "vehicules-rtmdet": []}


def test_reconstruire_refait_aussi_les_detections(tmp_path):
    """Le bouton de la page relit l'IGN du moment, orthophoto comprise : les
    relevés de l'emprise sont effacés avec la scène mise de côté."""
    notes = []
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_qui_note(notes))
    cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    _vieillir(cache, 48.8049, 2.1204)
    cache.reconstruire(48.8049, 2.1204)
    del notes[:]
    cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    assert [q for q, _ in notes] == ["orthophoto", "piscines", "rtmdet"]


def test_si_l_orthophoto_partagee_echoue_chaque_detection_retente_la_sienne(tmp_path):
    """Une lecture manquée ne fait pas tomber trois couches : chacune relit
    l'orthophoto, comme avant le partage. Ici, la lecture partagée et la
    première reprise (celle des piscines) échouent ; les deux suivantes
    passent."""
    appels = []
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_vehicules("tous", appels, en_panne=[2]))
    cache.prelire_vehicules(48.8049, 2.1204)
    for tache in list(cache._lectures.values()):
        tache.exception()
    assert appels == ["orthophoto", "orthophoto", "orthophoto", "rtmdet", "orthophoto", "yolo"]
    with pytest.raises(scene.VehiculesIndisponibles):
        cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    assert not os.path.exists(cache.chemin(48.8049, 2.1204, scene.nom_piscines("tous")))
    cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    cache.obtenir_vehicules(48.8049, 2.1204, "yolo", construire=_scene_nue)
    # La demande suivante d'une couche du point relance celle qui manque :
    # les piscines, sur une nouvelle lecture.
    cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    assert appels[6:] == ["orthophoto", "piscines"]


def test_une_detection_attendue_par_une_demande_n_est_pas_relancee(tmp_path):
    """yolo met cinq minutes dans le conteneur : pendant qu'une demande
    l'attend (sa tâche retirée de la file), une page rechargée ne la relance
    pas."""
    appels = []
    lecteur = _lecteur_vehicules("tous", appels)
    lire_vehicules, libre = lecteur.vehicules, threading.Event()

    def vehicules(quoi):
        lire = lire_vehicules(quoi)

        def lent(*bbox, rgb=None):
            if quoi == "yolo":
                assert libre.wait(10)
            return lire(*bbox, rgb=rgb)
        return lent

    lecteur.vehicules = vehicules
    cache = Cache(str(tmp_path), lire_vehicules=lecteur)
    cache.obtenir(48.8049, 2.1204, construire=_scene_nue)
    cache.prelire_vehicules(48.8049, 2.1204)
    attente = threading.Thread(target=cache.obtenir_vehicules,
                               args=(48.8049, 2.1204, "yolo"), kwargs={"construire": _scene_nue})
    attente.start()
    cle = (scene.nom_vehicules("yolo"), 48.8049, 2.1204, None)
    for _ in range(1000):                       # la demande a pris la tâche de yolo
        if cle not in cache._lectures:
            break
        threading.Event().wait(0.01)
    cache.prelire_vehicules(48.8049, 2.1204)      # page rechargée
    libre.set()
    attente.join(10)
    assert appels.count("yolo") == 1 and appels.count("orthophoto") == 1
    assert os.path.exists(cache.chemin(48.8049, 2.1204, scene.nom_vehicules("yolo")))


def test_l_orthophoto_partagee_est_liberee_avec_la_derniere_detection(tmp_path):
    """54 Mo pour une zone de 1 000 m : l'image ne survit pas aux détections,
    même si l'on ne vient jamais chercher leurs couches."""
    import gc
    import weakref
    images = []
    cache = Cache(str(tmp_path), lire_vehicules=_lecteur_vehicules("tous", images=images))
    cache.prelire_vehicules(48.8049, 2.1204)
    for tache in list(cache._lectures.values()):
        tache.result()
    (image,) = images
    reste = weakref.ref(image)
    del images[:], image
    gc.collect()
    assert reste() is None


def test_les_orthophotos_tenues_en_attendant_le_fil_des_detections_sont_bornees(tmp_path):
    """54 Mo par orthophoto en zone de 1 000 m : des scènes demandées à la
    suite n'en tiennent pas plus de IMAGES_TENUES pendant que leurs
    détections attendent le fil unique. Celle du point suivant est lue
    pendant la détection du précédent (le recouvrement est gardé), les
    autres attendent leur tour, dans l'ordre, sans jamais se bloquer."""
    import types

    import numpy as np
    lues, libres = [], {}

    def orthophoto(*bbox):
        lues.append(bbox)
        return np.zeros((400, 400, 3), dtype=np.uint8)

    def detection(west, south, east, north, rgb=None):
        # Par le centre de l'image : celle des véhicules est recadrée.
        centre = (round((south + north) / 2, 4), round((west + east) / 2, 4))
        assert rgb is not None and libres[centre].wait(10)
        return {"largeur": 4, "hauteur": 4, "boites": [], "piscines": []}

    lecteur = types.SimpleNamespace(mode="rtmdet", detecteurs=("rtmdet",), orthophoto=orthophoto,
                                    piscines=detection, vehicules=lambda detecteur: detection)
    cache = Cache(str(tmp_path), lire_vehicules=lecteur)
    assert Cache.IMAGES_TENUES == 2
    points = [point_normalise(48.8049 + i / 100, 2.1204) for i in range(4)]
    # Des points éloignés : un relevé chacun, son image autour de l'emprise.
    image = {p: emprise_image(rectangle(*emprise(*p)), MARGE_PISCINES_PX) for p in points}
    for lat, lon in points:
        libres[(lat, lon)] = threading.Event()
        cache.prelire_vehicules(lat, lon)

    def lues_apres(n):
        for _ in range(500):
            if len(lues) >= n:
                break
            threading.Event().wait(0.01)
        threading.Event().wait(0.1)                 # et pas une de plus
        return list(lues)

    # Le premier point se détecte, le deuxième a son image ; les autres attendent.
    assert lues_apres(2) == [image[p] for p in points[:2]]
    libres[points[0]].set()
    assert lues_apres(3) == [image[p] for p in points[:3]]
    for evenement in libres.values():
        evenement.set()
    for tache in list(cache._lectures.values()):
        tache.result(10)
    assert lues == [image[p] for p in points]


def _noter_le_fil(lecteur, fils):
    """Le lecteur dont chaque lecture note le nom du fil qui la fait."""
    piscines, vehicules = lecteur.piscines, lecteur.vehicules

    def noter(lire):
        def lire_et_noter(*bbox, **options):
            fils.append(threading.current_thread().name)
            return lire(*bbox, **options)
        return lire_et_noter
    lecteur.piscines = noter(piscines)
    lecteur.vehicules = lambda detecteur: noter(vehicules(detecteur))
    return lecteur


def test_une_detection_sans_tache_de_fond_passe_par_le_fil_des_detections(tmp_path):
    """Une couche demandée sans lecture anticipée (page rechargée après un
    échec, service relancé) n'est pas détectée dans le fil de la requête :
    les détections manquantes du point partent sur le fil des détections
    (_detections_si_absente), et jamais deux ne tournent ensemble."""
    fils = []
    cache = Cache(str(tmp_path), lire_vehicules=_noter_le_fil(_lecteur_vehicules("tous"), fils))
    cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    cache.obtenir_vehicules(48.8049, 2.1204, "yolo", construire=_scene_nue)
    # Piscines, rtmdet et yolo : la première demande lance toutes celles qui
    # manquent, sur une seule lecture de l'orthophoto.
    assert len(fils) == 3 and all(nom.startswith("detection") for nom in fils)
    assert os.path.exists(cache.chemin(48.8049, 2.1204, scene.nom_vehicules("yolo")))


class _Session:
    """Doublure d'une session onnxruntime de rtmdet : aucune boîte."""

    def __init__(self, journal=None):
        self.journal = journal if journal is not None else []

    def get_inputs(self):
        import types
        return [types.SimpleNamespace(name="images")]

    def run(self, sorties, entrees):
        import numpy as np
        self.journal.append("inférence")
        return [np.zeros((1, 0, 20), dtype=np.float32)]


def test_les_detections_cedent_le_processeur_a_la_construction_des_scenes(tmp_path):
    """Tant qu'une scène se construit, lectures comprises, une inférence au
    processeur attend ; elle passe dès la scène écrite."""
    from vue3d.vehicules import Lecteur
    journal = []
    cache = Cache(str(tmp_path), lire_vehicules=Lecteur("rtmdet", {"rtmdet": _Session(journal)}))
    session = cache.lire_vehicules.sessions["rtmdet"]
    lectures, fin = threading.Event(), threading.Event()

    def construire(lat, lon, avancer=None):
        avancer("bâtiments")
        lectures.set()
        fin.wait(5)
        journal.append("scène")
        return b"s", b"j"

    fil_scene = threading.Thread(target=cache.obtenir, args=(48.8049, 2.1204),
                                 kwargs={"construire": construire})
    fil_scene.start()
    lectures.wait(5)
    fil_detection = threading.Thread(target=session.run, args=(None, {}))
    fil_detection.start()
    fil_detection.join(0.3)
    assert fil_detection.is_alive() and journal == []
    fin.set()
    fil_scene.join(5)
    fil_detection.join(5)
    assert journal == ["scène", "inférence"]


def test_les_detections_attendent_chaque_etape_de_la_vraie_construction(tmp_path, monkeypatch):
    """Le vrai construire(), sources doublées : à chacune de ses lectures,
    puis aux toitures et aux houppiers d'assembler(), une inférence
    attendrait ; la scène écrite, plus rien ne la retient. La cession ne
    dépend d'aucun libellé d'étape : un libellé renommé dans assembler()
    ne la défait pas."""
    cache = Cache(str(tmp_path))
    monkeypatch.setattr(Cache, "CEDER_AU_PLUS_S", 0)
    passe = {}

    def noter(etape, valeur):
        def faux(*a, **k):
            # Vrai si une inférence passerait tout de suite.
            passe.setdefault(etape, []).append(cache.attendre_les_scenes())
            return valeur
        return faux

    grille = {"couvert": True, "width": 2, "height": 2, "source": "lidar_hd",
              "bbox": [0, 0, 1, 1], "values": [0.0] * 4}
    _fausses_sources(monkeypatch, lire_couche=noter("lectures", {"features": []}),
                     fetch_mnh_grid=noter("lectures", grille),
                     toits_pour_emprise=noter("toitures", {}),
                     houppiers_pour_emprise=noter("houppiers", {}))
    cache.obtenir(48.8049, 2.1204, construire=scene.construire)
    assert passe == {"lectures": [False] * 11, "toitures": [False], "houppiers": [False]}
    assert cache.attendre_les_scenes()


def test_une_detection_n_attend_pas_plus_de_ceder_au_plus_s(tmp_path, monkeypatch):
    """Un flot de scènes sans pause n'arrête pas tout à fait les
    détections : une inférence passe au bout de CEDER_AU_PLUS_S, même si une
    scène est encore en construction."""
    from vue3d.vehicules import Lecteur
    monkeypatch.setattr(Cache, "CEDER_AU_PLUS_S", 0.2)
    journal = []
    cache = Cache(str(tmp_path), lire_vehicules=Lecteur("rtmdet", {"rtmdet": _Session(journal)}))
    session = cache.lire_vehicules.sessions["rtmdet"]
    lectures, fin = threading.Event(), threading.Event()

    def construire(lat, lon, avancer=None):
        lectures.set()
        fin.wait(10)
        return b"s", b"j"

    fil_scene = threading.Thread(target=cache.obtenir, args=(48.8049, 2.1204),
                                 kwargs={"construire": construire})
    fil_scene.start()
    lectures.wait(5)
    fil_detection = threading.Thread(target=session.run, args=(None, {}))
    # Borné par le temps écoulé plutôt que par un join court : un fil
    # principal privé de la main 150 ms faisait échouer l'essai (3 fois sur
    # 50 sous charge). wait_for mesure son délai sur time.monotonic.
    debut = time.monotonic()
    fil_detection.start()
    fil_detection.join(5)
    assert not fil_detection.is_alive() and journal == ["inférence"] and fil_scene.is_alive()
    assert time.monotonic() - debut >= Cache.CEDER_AU_PLUS_S
    fin.set()
    fil_scene.join(5)


def _sans_attendre():
    pass


def test_une_session_qui_cede_se_copie_et_se_serialise():
    """Rien de ce que l'enveloppe n'a pas n'est cherché dans la session pour
    un nom spécial : copy et pickle trouvaient __deepcopy__ ou __setstate__
    par délégation, sur une instance encore sans session, jusqu'au
    RecursionError."""
    import copy
    import pickle
    cede = scene.SessionQuiCede(_Session(), _sans_attendre)
    for double in (copy.copy(cede), copy.deepcopy(cede), pickle.loads(pickle.dumps(cede))):
        assert double.get_inputs()[0].name == "images"
        assert double.run(None, {})[0].shape == (1, 0, 20)
    assert not hasattr(cede, "__wrapped__")
    # Sans session, une erreur d'attribut, pas une récursion.
    with pytest.raises(AttributeError):
        scene.SessionQuiCede.__new__(scene.SessionQuiCede).get_inputs


def test_seules_les_sessions_sur_le_processeur_cedent(tmp_path):
    """CoreML calcule sur le GPU : sa session n'attend pas la scène."""
    from vue3d.vehicules import Lecteur

    class Moteur(_Session):
        def __init__(self, moteurs):
            super().__init__()
            self.moteurs = moteurs

        def get_providers(self):
            return self.moteurs

    coreml = Moteur(["CoreMLExecutionProvider", "CPUExecutionProvider"])
    processeur = Moteur(["CPUExecutionProvider"])
    cache = Cache(str(tmp_path), lire_vehicules=Lecteur("tous", {"rtmdet": processeur, "yolo": coreml}))
    assert isinstance(cache.lire_vehicules.sessions["rtmdet"], scene.SessionQuiCede)
    assert cache.lire_vehicules.sessions["yolo"] is coreml


def test_une_scene_en_echec_ne_retient_pas_les_detections(tmp_path):
    from vue3d.vehicules import Lecteur
    cache = Cache(str(tmp_path), lire_vehicules=Lecteur("rtmdet", {"rtmdet": _Session()}))

    def en_panne(lat, lon, avancer=None):
        avancer("toitures")
        raise SceneIncomplete("hauteurs du sursol illisibles : Read timed out")

    with pytest.raises(SceneIncomplete):
        cache.obtenir(48.8049, 2.1204, construire=en_panne)
    fil = threading.Thread(target=cache.lire_vehicules.sessions["rtmdet"].run, args=(None, {}))
    fil.start()
    fil.join(2)
    assert not fil.is_alive()


def test_le_lecteur_des_vehicules_detecte_par_les_sessions_qui_cedent(tmp_path, monkeypatch):
    """Le vrai vehicules.Lecteur, orthophoto et réseau doublés : ses
    détections passent par les sessions du cache, qui attendent les scènes ;
    le lecteur reçu, lui, n'est pas touché."""
    import numpy as np
    from vue3d import vehicules
    monkeypatch.setattr(vehicules.Lecteur, "_orthophoto",
                        staticmethod(lambda *bbox: np.zeros((300, 200, 3), dtype=np.uint8)))
    originale = _Session()
    lecteur = vehicules.Lecteur("rtmdet", {"rtmdet": originale})
    cache = Cache(str(tmp_path), lire_vehicules=lecteur)
    attentes = []
    cede = cache.lire_vehicules.sessions["rtmdet"]
    cede._attendre = lambda: attentes.append(1)
    cache.prelire_vehicules(48.8049, 2.1204)
    dossier, nom = cache.obtenir_piscines(48.8049, 2.1204, construire=_scene_nue)
    cache.obtenir_vehicules(48.8049, 2.1204, "rtmdet", construire=_scene_nue)
    assert os.path.exists(os.path.join(dossier, nom))
    assert attentes and len(attentes) == len(originale.journal)
    assert lecteur.sessions["rtmdet"] is originale and cede.get_inputs()[0].name == "images"


# --- Panneaux solaires : le registre ------------------------------------------------

def _installation(west, south, east, north):
    lon, lat, d = (west + east) / 2, (south + north) / 2, 5 / 111320
    return [{"contour": [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d]],
             "surface": 100, "kwp": 12, "annee": 2023}]


def test_sans_registre_la_couche_des_panneaux_n_existe_pas(tmp_path):
    cache = Cache(str(tmp_path))
    cache.prelire_panneaux(48.8049, 2.1204)              # sans effet, sans erreur
    with pytest.raises(scene.PanneauxDesactives):
        cache.obtenir_panneaux(48.8049, 2.1204, construire=_scene_nue)


def test_la_couche_des_panneaux_est_lue_une_fois_et_versionnee(tmp_path):
    import gzip
    import json
    appels = []

    def lire(*bbox):
        appels.append(bbox)
        return _installation(*bbox)

    cache = Cache(str(tmp_path), lire_panneaux=lire)
    cache.prelire_panneaux(48.8049, 2.1204)
    d1 = cache.obtenir_panneaux(48.8049, 2.1204, construire=_scene_nue)
    d2 = cache.obtenir_panneaux(48.8049, 2.1204, construire=_scene_nue)
    assert d1 == d2 and len(appels) == 1
    assert scene.NOM_PANNEAUX == f"panneaux-v{scene.PANNEAUX_VERSION}.json.gz"
    couche = json.loads(gzip.decompress(open(os.path.join(d1, scene.NOM_PANNEAUX), "rb").read()))
    assert len(couche["panneaux"]) == 1 and couche["panneaux"][0]["kwp"] == 12


def test_une_base_illisible_ne_met_rien_en_cache(tmp_path):
    en_panne = [True]

    def lire(*bbox):
        if en_panne[0]:
            raise OSError("disk I/O error")
        return _installation(*bbox)

    cache = Cache(str(tmp_path), lire_panneaux=lire)
    with pytest.raises(scene.PanneauxIndisponibles):
        cache.obtenir_panneaux(48.8049, 2.1204, construire=_scene_nue)
    assert not os.path.exists(cache.chemin(48.8049, 2.1204, scene.NOM_PANNEAUX))
    en_panne[0] = False
    cache.obtenir_panneaux(48.8049, 2.1204, construire=_scene_nue)
    assert os.path.exists(cache.chemin(48.8049, 2.1204, scene.NOM_PANNEAUX))


@pytest.mark.parametrize("brute,attendue", [(None, None), ("", None), ("500", 500),
                                            (512, 500), (90, 150), (5000, 1000)])
def test_la_zone_est_arrondie_et_bornee(brute, attendue):
    assert scene.zone_normalisee(brute) == attendue


@pytest.mark.parametrize("brute", ["grand", "nan"])
def test_une_zone_illisible_est_refusee(brute):
    with pytest.raises(ValueError):
        scene.zone_normalisee(brute)


def test_la_zone_fixe_le_cote_nord_sud_et_agrandit_l_anneau():
    lat, lon = 48.8, 2.1
    o, s, e, n = emprise(lat, lon, 1000)
    assert (n - s) * 111320 == pytest.approx(1000)
    assert e - o == pytest.approx(n - s)
    ao, as_, ae, an = scene.emprise_anneau(lat, lon, zone=1000)
    assert (an - as_) * 111320 == pytest.approx(2 * scene.ANNEAU_DEMI_M * 1000 / scene.SCENE_COTE_M)
    # Une zone plus petite que la scène par défaut garde l'anneau d'un kilomètre.
    assert scene.emprise_anneau(lat, lon, zone=200) == scene.emprise_anneau(lat, lon)


def test_chaque_zone_a_sa_scene(tmp_path):
    """La scène par défaut garde son dossier d'avant les zones ; une zone en a
    un autre, construite avec elle."""
    appels = []

    def construire(lat, lon, avancer=None, zone=None):
        appels.append(zone)
        return b"scene", b"jpeg"

    cache = Cache(str(tmp_path))
    defaut = cache.obtenir(48.8049, 2.1204, construire=construire)
    large = cache.obtenir(48.8049, 2.1204, construire=construire, zone="700")
    assert cache.obtenir(48.8049, 2.1204, construire=construire, zone=690) == large
    assert appels == [None, 700]
    assert os.path.basename(defaut) == "48.8049_2.1204"
    assert os.path.basename(large) == "48.8049_2.1204_z700"
    assert cache.avancement(48.8049, 2.1204, "700") == {"etat": "prete"}
    assert cache.avancement(48.8049, 2.1204, "500") == {"etat": "attente"}


# --- Reconstruire une scène (bouton de la page) ---------------------------------

def _scene_numero(numero):
    """Une construction qui rend la scène numéro `numero`."""
    def construire(lat, lon, avancer=None):
        import gzip
        import json
        return gzip.compress(json.dumps({"numero": numero}).encode()), b"jpeg"
    return construire


def _numero(cache, lat, lon):
    import gzip
    import json
    with gzip.open(cache.chemin(lat, lon, scene.NOM_SCENE)) as f:
        return json.load(f)["numero"]


def _vieillir(cache, lat, lon, secondes=3600):
    """La scène écrite il y a `secondes`."""
    chemin = cache.chemin(lat, lon, scene.NOM_SCENE)
    t = time.time() - secondes
    os.utime(chemin, (t, t))


def test_reconstruire_met_la_scene_et_ses_couches_de_cote_puis_les_refait(tmp_path):
    cache = Cache(str(tmp_path))
    cache.obtenir(48.8049, 2.1204, construire=_scene_numero(1))
    couche = cache.chemin(48.8049, 2.1204, scene.NOM_OUVRAGES)
    open(couche, "wb").close()
    _vieillir(cache, 48.8049, 2.1204)
    cache.reconstruire(48.8049, 2.1204)
    assert not cache.present(48.8049, 2.1204) and not os.path.exists(couche)
    assert cache.avancement(48.8049, 2.1204) == {"etat": "attente"}
    cache.obtenir(48.8049, 2.1204, construire=_scene_numero(2))
    assert _numero(cache, 48.8049, 2.1204) == 2 and not os.path.exists(couche)
    # La scène mise de côté ne reste pas sur le disque.
    assert os.listdir(os.path.dirname(cache._dossier_point(48.8049, 2.1204))) == ["48.8049_2.1204"]


def test_une_reconstruction_qui_echoue_rend_la_scene_mise_de_cote(tmp_path):
    """L'IGN en panne pendant la reconstruction : la scène d'avant, complète,
    revient avec ses couches, plutôt que plus rien."""
    cache = Cache(str(tmp_path))
    cache.obtenir(48.8049, 2.1204, construire=_scene_numero(1))
    couche = cache.chemin(48.8049, 2.1204, scene.NOM_OUVRAGES)
    open(couche, "wb").close()
    _vieillir(cache, 48.8049, 2.1204)
    cache.reconstruire(48.8049, 2.1204)

    def en_panne(lat, lon, avancer=None):
        raise SceneIncomplete("hauteurs du sursol illisible : Read timed out")
    with pytest.raises(SceneIncomplete):
        cache.obtenir(48.8049, 2.1204, construire=en_panne)
    assert cache.present(48.8049, 2.1204) and _numero(cache, 48.8049, 2.1204) == 1
    assert os.path.exists(couche)
    assert os.listdir(os.path.dirname(cache._dossier_point(48.8049, 2.1204))) == ["48.8049_2.1204"]


def test_une_scene_trop_recente_n_est_pas_reconstruite(tmp_path):
    cache = Cache(str(tmp_path))
    cache.obtenir(48.8049, 2.1204, construire=_scene_numero(1))
    with pytest.raises(scene.ReconstructionRefusee, match="dans 10 min") as refus:
        cache.reconstruire(48.8049, 2.1204)
    assert refus.value.code == 429 and cache.present(48.8049, 2.1204)
    _vieillir(cache, 48.8049, 2.1204, Cache.RECONSTRUIRE_APRES_S + 1)
    cache.reconstruire(48.8049, 2.1204)
    assert not cache.present(48.8049, 2.1204)


def test_une_scene_dont_une_couche_se_calcule_n_est_pas_reconstruite(tmp_path):
    """Une couche lancée et pas finie écrirait, d'après l'ancienne scène, à
    côté de la nouvelle : refusé tant qu'elle tourne. Finie, sa réponse, lue
    avant la reconstruction, est oubliée."""
    import concurrent.futures
    cache = Cache(str(tmp_path))
    cache.obtenir(48.8049, 2.1204, construire=_scene_numero(1))
    _vieillir(cache, 48.8049, 2.1204)
    cle = (scene.NOM_OUVRAGES, 48.8049, 2.1204, None)
    en_cours = concurrent.futures.Future()
    cache._lectures[cle] = en_cours
    with pytest.raises(scene.ReconstructionRefusee, match="ouvrages") as refus:
        cache.reconstruire(48.8049, 2.1204)
    assert refus.value.code == 409 and cache.present(48.8049, 2.1204)
    # Une couche attendue par une demande, verrou pris : refusé de même.
    del cache._lectures[cle]
    with cache._verrou(cle):
        with pytest.raises(scene.ReconstructionRefusee):
            cache.reconstruire(48.8049, 2.1204)
    en_cours.set_result({"lineaires": {"features": []}})
    cache._lectures[cle] = en_cours
    cache.reconstruire(48.8049, 2.1204)
    assert cle not in cache._lectures and not cache.present(48.8049, 2.1204)


def test_une_scene_en_construction_n_est_pas_reconstruite(tmp_path):
    cache = Cache(str(tmp_path))
    with cache._verrou((48.8049, 2.1204, None)):
        with pytest.raises(scene.ReconstructionRefusee, match="se construire") as refus:
            cache.reconstruire(48.8049, 2.1204)
    assert refus.value.code == 409


def test_reconstruire_une_scene_absente_ne_fait_rien(tmp_path):
    cache = Cache(str(tmp_path))
    cache.reconstruire(48.8049, 2.1204)
    cache.obtenir(48.8049, 2.1204, construire=_scene_numero(1))
    assert _numero(cache, 48.8049, 2.1204) == 1
