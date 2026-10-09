"""Serveur (vue3d/app.py) : paramètres, codes d'erreur, en-têtes."""
import gzip
import json
import math
import types

import numpy as np
import pytest

from vue3d import app as module_app
from vue3d.scene import SceneIncomplete


@pytest.fixture
def client(tmp_path):
    scene = {"version": 1, "bbox": [0, 0, 1, 1], "houppiers": []}

    def construire(lat, lon, avancer=None, zone=None):
        if lat == 45.0:
            raise SceneIncomplete("orthophoto illisible : Read timed out")
        return gzip.compress(json.dumps({**scene, "zone": zone}).encode()), b"\xff\xd8jpeg"

    def lire_monuments(west, south, east, north):
        # Au sud de 46° : Overpass en panne.
        if south < 46:
            raise ConnectionError("Overpass injoignable : 504")
        return {"elements": []}

    def lire_ouvrages(west, south, east, north):
        # Au sud de 46° : l'IGN en panne sur ces couches.
        if south < 46:
            raise ConnectionError("HTTP 504 sur construction_lineaire")
        return {"lineaires": {"features": []}, "surfaciques": {"features": []},
                "voies": {"features": []}, "terrains": {"features": []}}

    def lire_nuage(west, south, east, north):
        # Au sud de 46° : une dalle LiDAR HD illisible ; ailleurs, hors couverture.
        if south < 46:
            raise ConnectionError("plage refusée")
        return None

    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lire_monuments, lire_ouvrages=lire_ouvrages,
                                 lire_nuage=lire_nuage)
    return appli.test_client()


@pytest.fixture
def client_vehicules(tmp_path):
    """Un service lancé avec un détecteur : la lecture rend une boîte au
    centre d'une orthophoto à 0,2 m, sauf au sud de 46° où elle échoue."""
    scene = {"version": 1, "bbox": [0, 0, 1, 1], "batiments": {"features": []}, "eau": None}

    def construire(lat, lon, avancer=None):
        return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"

    def orthophoto(west, south, east, north):
        """Une image noire à 0,2 m, comme ortho.fetch_ortho_rgb."""
        if south < 46:
            raise ConnectionError("Read timed out")
        kx = 111320 * math.cos(math.radians((south + north) / 2))
        return np.zeros((int((north - south) * 111320 / 0.2), int((east - west) * kx / 0.2), 3),
                        dtype=np.uint8)

    def lire_piscines(west, south, east, north, rgb=None):
        if rgb is None:
            rgb = orthophoto(west, south, east, north)
        return {"largeur": rgb.shape[1], "hauteur": rgb.shape[0],
                "piscines": [[300, 400, 50, 25, 0.0, 0.3, 0x5AC8D2, "rtmdet"]]}

    def lire_vehicules(detecteur):
        def lire(west, south, east, north, rgb=None):
            if rgb is None:
                rgb = orthophoto(west, south, east, north)
            largeur, hauteur = rgb.shape[1], rgb.shape[0]
            return {"largeur": largeur, "hauteur": hauteur,
                    "boites": [[largeur / 2, hauteur / 2, 22, 10, 0.0, 0.6, 0, 0xC81E28, detecteur]]}
        return lire

    lecteur = types.SimpleNamespace(mode="rtmdet", detecteurs=("rtmdet",), orthophoto=orthophoto,
                                    piscines=lire_piscines, vehicules=lire_vehicules)
    # Les ouvrages aussi sont doublés : sans cela, /api/scene lançait le vrai
    # fetch_ouvrages, et la suite appelait la Géoplateforme (six connexions
    # par passage, relevées le 2 octobre 2026).
    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lambda *b: {"elements": []},
                                 lire_ouvrages=lambda *b: {}, lire_vehicules=lecteur)
    return appli.test_client()


def test_la_page_est_servie(client):
    r = client.get("/")
    assert r.status_code == 200 and b"Vue 3D IGN" in r.data


def test_la_page_demande_sa_scene_avant_three_js(client):
    """Un script ordinaire, avant la carte d'import et le module : il part
    pendant que three.js arrive du CDN."""
    page = client.get("/").get_data(as_text=True)
    assert page.index("window.DEMANDE_SCENE") < page.index('type="importmap"') < page.index('type="module"')


def test_la_scene_est_servie_gzippee(client):
    r = client.get("/api/scene?lat=48.8049&lon=2.1204")
    assert r.status_code == 200
    assert r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data))["version"] == 1


def test_l_orthophoto_est_servie(client):
    r = client.get("/api/ortho?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.mimetype == "image/jpeg"


def test_sans_parametres_400(client):
    assert client.get("/api/scene").status_code == 400
    assert client.get("/api/scene?lat=abc&lon=2").status_code == 400


def test_la_zone_est_transmise_a_la_scene_et_a_ses_couches(client):
    r = client.get("/api/scene?lat=48.8049&lon=2.1204&zone=690")
    assert json.loads(gzip.decompress(r.data))["zone"] == 700
    r = client.get("/api/scene?lat=48.8049&lon=2.1204")
    assert json.loads(gzip.decompress(r.data))["zone"] is None
    assert client.get("/api/ouvrages?lat=48.8049&lon=2.1204&zone=700").status_code == 200
    assert client.get("/api/avancement?lat=48.8049&lon=2.1204&zone=700").get_json() == {"etat": "prete"}
    assert client.get("/api/avancement?lat=48.8049&lon=2.1204&zone=500").get_json() == {"etat": "attente"}


def test_une_zone_illisible_400(client):
    assert client.get("/api/scene?lat=48.8&lon=2.1&zone=grand").status_code == 400


def test_hors_emprise_422(client):
    r = client.get("/api/scene?lat=40&lon=2")
    assert r.status_code == 422 and "France" in r.get_json()["erreur"]


def test_une_panne_ign_rend_503_et_ne_cache_rien(client):
    r = client.get("/api/scene?lat=45.0&lon=2")
    assert r.status_code == 503
    assert "réessayez" in r.get_json()["erreur"]


def test_l_avancement_dit_si_la_scene_est_prete(client):
    assert client.get("/api/avancement?lat=48.8049&lon=2.1204").get_json() == {"etat": "attente"}
    client.get("/api/scene?lat=48.8049&lon=2.1204")
    r = client.get("/api/avancement?lat=48.8049&lon=2.1204")
    assert r.get_json() == {"etat": "prete"}
    # Il change d'une seconde à l'autre : jamais mis en cache.
    assert r.headers["Cache-Control"] == "no-store"
    assert client.get("/api/avancement").status_code == 400
    assert client.get("/api/avancement?lat=40&lon=2").status_code == 422


def test_la_couche_osm_est_servie_a_part(client):
    """Aucune partie sur l'emprise : la couche vaut null, et se met en cache."""
    r = client.get("/api/monuments?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data)) is None


def test_une_panne_osm_rend_503_sans_toucher_la_scene(client):
    """La scène reste servie ; seule la couche OSM attend un nouvel essai."""
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client.get("/api/monuments?lat=45.5&lon=2")
    assert r.status_code == 503 and "OpenStreetMap" in r.get_json()["erreur"]


def test_la_couche_des_ouvrages_est_servie_a_part(client):
    """Aucun ouvrage sur l'emprise : la couche vaut null, et se met en cache."""
    r = client.get("/api/ouvrages?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data)) is None


def test_une_panne_des_ouvrages_rend_503_sans_toucher_la_scene(client):
    """La scène reste servie ; seule la couche attend un nouvel essai."""
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client.get("/api/ouvrages?lat=45.5&lon=2")
    assert r.status_code == 503 and "IGN" in r.get_json()["erreur"]
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_la_couche_du_nuage_est_servie_a_part(client):
    """Hors couverture LiDAR HD : la couche vaut null, et se met en cache."""
    r = client.get("/api/nuage?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert json.loads(gzip.decompress(r.data)) is None


def test_une_panne_du_nuage_rend_503_sans_toucher_la_scene(client):
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client.get("/api/nuage?lat=45.5&lon=2")
    assert r.status_code == 503 and "IGN" in r.get_json()["erreur"]
    assert client.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_sans_detecteur_les_couches_de_l_orthophoto_le_disent(client):
    """Ni erreur ni fichier : la page lit le mode et ne montre pas la couche."""
    assert client.get("/api/sante").get_json()["vehicules"] == {"mode": "aucun", "detecteurs": []}
    r = client.get("/api/vehicules?lat=48.8049&lon=2.1204")
    assert r.status_code == 200
    assert r.get_json() == {"mode": "aucun", "detecteur": None, "vehicules": []}
    # Le service peut être relancé avec un détecteur : jamais gardée.
    assert r.headers["Cache-Control"] == "no-store"
    r = client.get("/api/piscines?lat=48.8049&lon=2.1204")
    assert r.get_json() == {"mode": "aucun", "piscines": []} and r.headers["Cache-Control"] == "no-store"


def test_les_couches_de_l_orthophoto_sont_servies_a_part_detecteur_par_detecteur(client_vehicules):
    """La page apprend les détecteurs par /api/sante, demande les piscines,
    puis les véhicules de chaque détecteur : chaque couche a sa route."""
    sante = client_vehicules.get("/api/sante")
    assert sante.get_json()["vehicules"] == {"mode": "rtmdet", "detecteurs": ["rtmdet"]}
    assert sante.headers["Cache-Control"] == "no-store"
    r = client_vehicules.get("/api/piscines?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    couche = json.loads(gzip.decompress(r.data))
    assert couche["mode"] == "rtmdet" and [p[2:] for p in couche["piscines"]] == [[10.0, 5.0, 90.0, 0x5AC8D2]]
    r = client_vehicules.get("/api/vehicules?lat=48.8049&lon=2.1204&detecteur=rtmdet")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    couche = json.loads(gzip.decompress(r.data))
    assert couche["detecteur"] == "rtmdet" and "piscines" not in couche
    (lon, lat, longueur, largeur, cap, couleur), = couche["vehicules"]
    assert (round(lat, 4), round(lon, 4)) == (48.8049, 2.1204) and couleur == 0xC81E28
    # Sans détecteur, ou avec un détecteur que ce service n'a pas : 400, avec la liste.
    r = client_vehicules.get("/api/vehicules?lat=48.8049&lon=2.1204")
    assert r.status_code == 400 and "rtmdet" in r.get_json()["erreur"]
    r = client_vehicules.get("/api/vehicules?lat=48.8049&lon=2.1204&detecteur=yolo")
    assert r.status_code == 400 and "yolo" in r.get_json()["erreur"] and "rtmdet" in r.get_json()["erreur"]
    assert client_vehicules.get("/api/vehicules?detecteur=rtmdet").status_code == 400
    assert client_vehicules.get("/api/vehicules?lat=40&lon=2&detecteur=rtmdet").status_code == 422
    assert client_vehicules.get("/api/piscines?lat=40&lon=2").status_code == 422


def test_la_couche_des_vehicules_est_revalidee_a_chaque_demande(client_vehicules):
    """Le navigateur ne la garde pas : à la même adresse, elle change avec le
    détecteur, la version, et quand la scène est reconstruite. Le fichier,
    son nom et l'instant de son écriture, sert de validateur."""
    from vue3d.scene import nom_piscines, nom_vehicules
    url = "/api/vehicules?lat=48.8049&lon=2.1204&detecteur=rtmdet"
    r = client_vehicules.get(url)
    assert r.headers["Cache-Control"] == "no-cache"
    assert r.headers["ETag"].startswith(f'"{nom_vehicules("rtmdet")}-')
    # Même fichier : 304, sans corps.
    r2 = client_vehicules.get(url, headers={"If-None-Match": r.headers["ETag"]})
    assert r2.status_code == 304 and r2.data == b"" and r2.headers["ETag"] == r.headers["ETag"]
    # Le validateur d'un autre détecteur, ou d'une autre version : la couche entière.
    r3 = client_vehicules.get(url, headers={"If-None-Match": f'"{nom_vehicules("yolo")}"'})
    assert r3.status_code == 200 and json.loads(gzip.decompress(r3.data))["detecteur"] == "rtmdet"
    # Les piscines, de même.
    r4 = client_vehicules.get("/api/piscines?lat=48.8049&lon=2.1204")
    assert r4.headers["Cache-Control"] == "no-cache"
    assert r4.headers["ETag"].startswith(f'"{nom_piscines("rtmdet")}-')


def test_une_panne_des_vehicules_rend_503_sans_toucher_la_scene(client_vehicules):
    assert client_vehicules.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client_vehicules.get("/api/vehicules?lat=45.5&lon=2&detecteur=rtmdet")
    assert r.status_code == 503 and "véhicules" in r.get_json()["erreur"]
    r = client_vehicules.get("/api/piscines?lat=45.5&lon=2")
    assert r.status_code == 503 and "piscines" in r.get_json()["erreur"]
    assert client_vehicules.get("/api/scene?lat=45.5&lon=2").status_code == 200


def test_sante(client):
    assert client.get("/api/sante").get_json() == {
        "ok": True, "vehicules": {"mode": "aucun", "detecteurs": []},
        "panneaux": {"actif": False, "source": None}}


def test_sans_registre_la_couche_des_panneaux_le_dit(client):
    r = client.get("/api/panneaux?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.get_json() == {"actif": False, "panneaux": []}
    assert r.headers["Cache-Control"] == "no-store"


@pytest.fixture
def client_panneaux(tmp_path):
    """Un service lancé avec un registre : une installation carrée de 10 m au
    point demandé, sauf au sud de 46° où la base est illisible."""
    scene = {"version": 1, "bbox": [0, 0, 1, 1]}

    def construire(lat, lon, avancer=None):
        return gzip.compress(json.dumps(scene).encode()), b"\xff\xd8jpeg"

    def lire_panneaux(west, south, east, north):
        if south < 46:
            raise OSError("disk I/O error")
        lon, lat = (west + east) / 2, (south + north) / 2
        d = 5 / 111320
        return [{"contour": [[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d],
                             [lon - d, lat - d]], "surface": 100, "kwp": 12, "annee": 2023}]

    appli = module_app.creer_app(str(tmp_path), construire=construire,
                                 lire_monuments=lambda *b: {"elements": []},
                                 lire_ouvrages=lambda *b: {}, lire_panneaux=lire_panneaux)
    return appli.test_client()


def test_la_couche_des_panneaux_est_servie_a_part(client_panneaux):
    from vue3d.scene import NOM_PANNEAUX
    assert client_panneaux.get("/api/sante").get_json()["panneaux"] == {
        "actif": True, "source": "OpenPVMapper (G. Kasmi), CC-BY 4.0"}
    r = client_panneaux.get("/api/panneaux?lat=48.8049&lon=2.1204")
    assert r.status_code == 200 and r.headers["Content-Encoding"] == "gzip"
    assert r.headers["Cache-Control"] == "no-cache" and r.headers["ETag"].startswith(f'"{NOM_PANNEAUX}-')
    (p,) = json.loads(gzip.decompress(r.data))["panneaux"]
    assert p["surface"] == 100 and p["kwp"] == 12 and p["annee"] == 2023 and len(p["contour"]) == 4
    assert client_panneaux.get("/api/panneaux").status_code == 400
    assert client_panneaux.get("/api/panneaux?lat=40&lon=2").status_code == 422
    # La base illisible : 503, rien en cache, la scène reste servie.
    assert client_panneaux.get("/api/scene?lat=45.5&lon=2").status_code == 200
    r = client_panneaux.get("/api/panneaux?lat=45.5&lon=2")
    assert r.status_code == 503 and "panneaux" in r.get_json()["erreur"]


def test_la_scene_et_l_orthophoto_sont_revalidees(client):
    """Une scène peut être reconstruite sous la même adresse : le navigateur
    revalide, et reçoit un 304 sans corps tant qu'elle n'a pas été réécrite."""
    for route in ("/api/scene", "/api/ortho"):
        url = f"{route}?lat=48.8049&lon=2.1204"
        r = client.get(url)
        assert r.status_code == 200 and r.headers["Cache-Control"] == "no-cache"
        r2 = client.get(url, headers={"If-None-Match": r.headers["ETag"]})
        assert r2.status_code == 304 and r2.data == b""


def test_le_bouton_reconstruit_la_scene(client, tmp_path):
    """POST /api/reconstruire met la scène de côté : la demande suivante la
    reconstruit, avec un autre validateur. Trop tôt après, refusé (429)."""
    import os
    import time
    url = "/api/scene?lat=48.8049&lon=2.1204"
    avant = client.get(url).headers["ETag"]
    r = client.post("/api/reconstruire?lat=48.8049&lon=2.1204")
    assert r.status_code == 429 and "Reconstruction refusée" in r.get_json()["erreur"]
    (chemin,) = [os.path.join(d, f) for d, _, fs in os.walk(tmp_path) for f in fs
                 if f == "scene.json.gz"]
    t = time.time() - 3600
    os.utime(chemin, (t, t))
    r = client.post("/api/reconstruire?lat=48.8049&lon=2.1204")
    assert r.status_code == 202 and r.headers["Cache-Control"] == "no-store"
    assert client.get("/api/avancement?lat=48.8049&lon=2.1204").get_json() == {"etat": "attente"}
    r = client.get(url, headers={"If-None-Match": avant})
    assert r.status_code == 200 and r.headers["ETag"] != avant
    assert client.post("/api/reconstruire?lat=48.8049&lon=2.1204").status_code == 429
    assert client.post("/api/reconstruire?lat=abc&lon=2").status_code == 400
    assert client.get("/api/reconstruire?lat=48.8049&lon=2.1204").status_code == 405
