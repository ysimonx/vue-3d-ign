"""Carrés de la vue en voiture (vue3d/carres.py) et leur route /api/carre."""
import gzip
import json
import os

import pytest
import requests

from vue3d import app as module_app
from vue3d import carres
from vue3d.couches import SRS_LAMBERT93

# Le carré de Gordes : x de 876 000 à 876 500, y de 6 316 000 à 6 316 500.
I, J = 1752, 12632
X0, Y0 = I * carres.CARRE_M, J * carres.CARRE_M


def _batiment(cleabs, sommets, **props):
    return {"type": "Feature", "geometry": {"type": "MultiPolygon", "coordinates": [[sommets]]},
            "properties": {"cleabs": cleabs, "etat_de_l_objet": "En service", "usage_1": "Résidentiel",
                           "altitude_minimale_sol": 438.6, "altitude_minimale_toit": 445.5,
                           "altitude_maximale_toit": 448.7, "hauteur": 6.9, "nombre_d_etages": 2, **props}}


def _route(cleabs, sommets, **props):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": sommets},
            "properties": {"cleabs": cleabs, "etat_de_l_objet": "En service", "nature": "Route à 1 chaussée",
                           "nom_voie_ban_gauche": "Route de Murs", "cpx_numero": "D15", "importance": "4",
                           "position_par_rapport_au_sol": "0", "sens_de_circulation": "Double sens",
                           "nombre_de_voies": 2, "largeur_de_chaussee": 5.5,
                           "acces_vehicule_leger": "Libre", **props}}


def _carre(x, y):
    """L'emprise d'un bâtiment carré de 10 m, son premier sommet en (x, y)."""
    return [[x, y, 440], [x + 10, y, 440], [x + 10, y + 10, 440], [x, y + 10, 440], [x, y, 440]]


def test_un_batiment_appartient_au_carre_de_son_premier_sommet():
    """Le WFS rend tout ce qui touche l'emprise : un bâtiment à cheval sur
    deux carrés n'est gardé que par celui de son premier sommet."""
    geojson = {"features": [
        _batiment("DEDANS", _carre(X0 + 100.04, Y0 + 200)),
        _batiment("A_CHEVAL_DEBUT_ICI", _carre(X0 + 495, Y0 + 10)),
        _batiment("A_CHEVAL_DEBUT_VOISIN", _carre(X0 - 5, Y0 + 10)),
        _batiment("EN_PROJET", _carre(X0 + 50, Y0 + 50), etat_de_l_objet="En projet"),
    ]}
    sortie = carres.batiments_du_carre(geojson, I, J)
    assert [b["id"] for b in sortie] == ["DEDANS", "A_CHEVAL_DEBUT_ICI"]
    b = sortie[0]
    # Décimètres depuis le coin sud-ouest, sommet de fermeture compris.
    assert b["polygones"] == [[[1000, 2000, 1100, 2000, 1100, 2100, 1000, 2100, 1000, 2000]]]
    assert (b["usage"], b["sol"], b["gouttiere"], b["faitage"], b["hauteur"], b["etages"]) == \
        ("Résidentiel", 438.6, 445.5, 448.7, 6.9, 2)


def test_les_altitudes_absentes_restent_nulles():
    geojson = {"features": [_batiment("SANS", _carre(X0 + 1, Y0 + 1), altitude_minimale_sol=None,
                                      hauteur=None, nombre_d_etages=None)]}
    b = carres.batiments_du_carre(geojson, I, J)[0]
    assert b["sol"] is None and b["hauteur"] is None and b["etages"] is None


def test_les_routes_gardees_sont_entieres_et_carrossables():
    """Une route qui sort du carré est gardée entière : la page raccorde son
    graphe d'un carré à l'autre. Sentiers, escaliers, pistes cyclables et
    galeries (accès « Physiquement impossible ») n'en sont pas."""
    ligne = [[X0 - 100, Y0 + 10, 430.25], [X0 + 250, Y0 + 260, 441.0]]
    geojson = {"features": [
        _route("D15", ligne),
        _route("SENTIER", ligne, nature="Sentier"),
        _route("GALERIE", ligne, acces_vehicule_leger="Physiquement impossible"),
        _route("PRIVEE", ligne, acces_vehicule_leger="Restreint aux ayants droit",
               sens_de_circulation="Sens inverse", position_par_rapport_au_sol="-1"),
        _route("POINT", ligne[:1]),
    ]}
    sortie = carres.routes_du_carre(geojson, I, J)
    assert [r["id"] for r in sortie] == ["D15", "PRIVEE"]
    d15, privee = sortie
    assert d15["ligne"] == [-1000, 100, 4302, 2500, 2600, 4410]
    assert (d15["nom"], d15["numero"], d15["importance"], d15["sens"], d15["sol"], d15["acces"]) == \
        ("Route de Murs", "D15", 4, "2", 0, None)
    assert (privee["sens"], privee["sol"], privee["acces"]) == ("-", -1, "Restreint aux ayants droit")


def test_le_nom_collaboratif_supplee_la_ban():
    geojson = {"features": [_route("R", [[X0, Y0, 1], [X0 + 5, Y0, 1]], nom_voie_ban_gauche=None,
                                   nom_collaboratif_gauche="R DE LA CHAUSSEE D'ANTIN")]}
    assert carres.routes_du_carre(geojson, I, J)[0]["nom"] == "R DE LA CHAUSSEE D'ANTIN"


def _voie(cleabs, sommets, **props):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": sommets},
            "properties": {"cleabs": cleabs, "etat_de_l_objet": "En service", "nature": "Métro",
                           "position_par_rapport_au_sol": "1", "nombre_de_voies": 2, "largeur": "Normale",
                           **props}}


def test_les_ponts_sont_ce_que_la_voiture_voit_passer_au_dessus():
    """Voies ferrées et passerelles au-dessus du sol, entières ; au sol ou
    dessous, elles ne sont pas dessinées, et une route carrossable sur un
    pont est déjà dans `routes`."""
    ligne = [[X0 - 50, Y0 + 10, 39.25], [X0 + 250, Y0 + 260, 41.0]]
    voies = {"features": [
        _voie("VIADUC", ligne),
        _voie("AU_SOL", ligne, position_par_rapport_au_sol="0"),
        _voie("TUNNEL", ligne, position_par_rapport_au_sol="-1"),
        _voie("EN_PROJET", ligne, etat_de_l_objet="En projet"),
        _voie("ETROITE", ligne, nombre_de_voies=1, largeur="Etroite", nature="Voie ferrée principale"),
    ]}
    routes = {"features": [
        _route("PASSERELLE", ligne, nature="Sentier", position_par_rapport_au_sol="1", largeur_de_chaussee=None),
        _route("SENTIER", ligne, nature="Sentier"),
        _route("PONT_ROUTIER", ligne, position_par_rapport_au_sol="1"),
    ]}
    ponts = carres.ponts_du_carre(voies, routes, I, J)
    assert [(p["id"], p["ferre"], p["largeur"]) for p in ponts] == \
        [("VIADUC", True, 8.0), ("ETROITE", True, 3.0), ("PASSERELLE", False, None)]
    assert ponts[0]["ligne"] == [-500, 100, 392, 2500, 2600, 410]
    assert (ponts[0]["nature"], ponts[0]["sol"]) == ("Métro", 1)


def test_un_carre_se_lit_en_lambert_93(monkeypatch):
    lus = []

    def lire_couche(couche, ouest, sud, est, nord, srs=None):
        lus.append((couche, ouest, sud, est, nord, srs))
        return {"features": []}

    monkeypatch.setattr(carres, "lire_couche", lire_couche)
    carre = carres.fetch_carre(I, J)
    assert sorted(lus) == sorted([(c, X0, Y0, X0 + 500, Y0 + 500, SRS_LAMBERT93)
                                  for c in (carres.COUCHE_BATIMENTS, carres.COUCHE_ROUTES,
                                            carres.COUCHE_VOIES_FERREES)])
    assert (carre["carre"], carre["origine"], carre["taille"]) == ([I, J], [X0, Y0], 500)


def test_une_couche_en_echec_rend_le_carre_indisponible(monkeypatch):
    def lire_couche(couche, *emprise, srs=None):
        if couche == carres.COUCHE_ROUTES:
            raise requests.ConnectionError("HTTP 504")
        return {"features": []}

    monkeypatch.setattr(carres, "lire_couche", lire_couche)
    with pytest.raises(carres.CarreIndisponible):
        carres.fetch_carre(I, J)


def test_hors_de_france_le_carre_n_est_pas_servi():
    for i, j in [(-1, J), (I, 100), (3000, J), (I, 15000)]:
        with pytest.raises(carres.CarreHorsEmprise):
            carres.verifier_carre(i, j)
    carres.verifier_carre(I, J)


def test_un_carre_lu_une_fois_ou_pas_du_tout(tmp_path):
    lectures = []

    def lire(i, j):
        lectures.append((i, j))
        if i == I + 1:
            raise carres.CarreIndisponible("WFS en panne")
        return {"carre": [i, j], "batiments": [], "routes": []}

    stock = carres.Carres(str(tmp_path), lire=lire)
    chemin = stock.obtenir(I, J)
    assert stock.obtenir(I, J) == chemin and lectures == [(I, J)]
    with gzip.open(chemin) as f:
        assert json.load(f)["carre"] == [I, J]
    assert chemin == os.path.join(str(tmp_path), "carres", f"v{carres.CARRES_VERSION}", str(I), f"{J}.json.gz")
    with pytest.raises(carres.CarreIndisponible):
        stock.obtenir(I + 1, J)
    # Rien d'écrit, pas même un fichier temporaire.
    assert not stock.present(I + 1, J)
    assert not os.path.exists(os.path.join(stock.dossier, str(I + 1)))


@pytest.fixture
def service(tmp_path):
    def fabrique(lire_carre, **options):
        appli = module_app.creer_app(str(tmp_path), lire_carre=lire_carre, **options)
        return appli.test_client()
    return fabrique


def test_la_route_sert_le_carre_gzippe_et_garde_une_semaine(service):
    client = service(lambda i, j: {"carre": [i, j], "batiments": [], "routes": []})
    r = client.get(f"/api/carre?i={I}&j={J}")
    assert r.status_code == 200
    assert r.headers["Content-Encoding"] == "gzip"
    assert r.headers["Cache-Control"] == "public, max-age=604800"
    assert json.loads(gzip.decompress(r.data))["carre"] == [I, J]


def test_la_route_dit_ses_erreurs(service):
    def lire(i, j):
        raise carres.CarreIndisponible("HTTP 504 sur troncon_de_route")

    client = service(lire)
    assert client.get("/api/carre?i=1").status_code == 400
    assert client.get("/api/carre?i=a&j=2").status_code == 400
    assert client.get("/api/carre?i=-5&j=2").status_code == 422
    r = client.get(f"/api/carre?i={I}&j={J}")
    assert r.status_code == 503 and r.headers["Retry-After"] == "10"


def test_le_quota_des_carres_ne_compte_que_les_neufs(service):
    client = service(lambda i, j: {"carre": [i, j], "batiments": [], "routes": []}, quota_carres=2)
    assert client.get(f"/api/carre?i={I}&j={J}").status_code == 200
    assert client.get(f"/api/carre?i={I + 1}&j={J}").status_code == 200
    # Déjà lus : toujours servis.
    assert client.get(f"/api/carre?i={I}&j={J}").status_code == 200
    r = client.get(f"/api/carre?i={I + 2}&j={J}")
    assert r.status_code == 429 and int(r.headers["Retry-After"]) > 0


def test_le_quota_des_carres_suit_celui_des_scenes(service):
    client = service(lambda i, j: {"carre": [i, j]}, quota=1)
    for k in range(5):
        assert client.get(f"/api/carre?i={I + k}&j={J}").status_code == 200


def test_la_page_de_la_voiture_est_servie(service):
    r = service(lambda i, j: {}).get("/voiture")
    assert r.status_code == 200
    assert r.headers["Cache-Control"] == "no-cache"
    assert b'src="static/js/voiture/main.js"' in r.data
    assert service(lambda i, j: {}).get("/static/js/voiture/main.js").status_code == 200


def test_lambert_93_au_centieme_du_wfs():
    """Un sommet de Gordes rendu par le WFS en EPSG:4326 et en EPSG:2154."""
    x, y = carres.lambert93(5.19564453, 43.92299055)
    assert abs(x - 876319.49986801) < 0.01 and abs(y - 6316227.80474568) < 0.01
    lon, lat = carres.wgs84(x, y)
    assert abs(lon - 5.19564453) < 1e-9 and abs(lat - 43.92299055) < 1e-9


@pytest.mark.parametrize("essence, nature, profil, attendu", [
    ("Pin d'Alep", None, None, "pin"),
    ("Sapin, épicéa", None, None, "conifere"),
    ("Chênes sempervirents", None, None, "chene_vert"),
    ("Peuplier", None, None, "peuplier"),
    ("Chênes décidus", None, None, "feuillu"),
    ("Conifères", None, None, "conifere"),
    (None, "Haie", None, "arbuste"),
    ("Mixte", "Forêt fermée mixte", [1, 0.95, 0.9, 0.88, 0.8, 0.7], "pin"),
    ("Mixte", None, [1, 0.7, 0.5, 0.4, 0.3, 0.2], "conifere"),
    (None, None, [1, 0.9, 0.8, 0.7, 0.6, 0.5], "feuillu"),
    (None, None, None, "feuillu"),
])
def test_le_port_suit_les_regles_de_la_page(essence, nature, profil, attendu):
    """Les règles de portDe et portMesure (static/js/scene/vegetation/formes.js),
    dans le même ordre."""
    assert carres.port({"essence": essence, "nature": nature, "profil": profil}) == attendu


def test_un_arbre_appartient_au_carre_de_son_sommet():
    def houppier(dx, dy, **props):
        lon, lat = carres.wgs84(X0 + dx, Y0 + dy)
        return {"lon": lon, "lat": lat, "h": 12.34, "r": 3.21, "profil": [1, 0.9, 0.8, 0.7, 0.6, 0.5], **props}

    arbres = carres.arbres_du_carre([houppier(100, 200), houppier(-3, 10), houppier(10, 504),
                                     houppier(250, 250, essence="Douglas")], I, J)
    assert arbres == [[1000, 2000, 123, 32, carres.PORTS.index("feuillu")],
                      [2500, 2500, 123, 32, carres.PORTS.index("conifere")]]


def test_les_arbres_se_lisent_comme_ceux_de_la_scene(monkeypatch):
    lus = {}

    def mnh(w, s, e, n, resolution_m=None, max_pixels=None):
        lus["mnh"] = (w, s, e, n, resolution_m)
        return {"couvert": True, "source": "lidar_hd"}

    monkeypatch.setattr(carres, "fetch_mnh_grid", mnh)
    monkeypatch.setattr(carres, "fetch_exg_grid", lambda *a: "exg")
    monkeypatch.setattr(carres, "lire_couche", lambda couche, *emprise: {"features": [], "couche": couche})
    # Lues aussi : les routes, pour les ponts.

    def houppiers(w, s, e, n, bati, zones, forets, grille, exg):
        assert (bati["couche"], zones["couche"], forets["couche"], exg) == \
            (carres.COUCHE_BATIMENTS, carres.COUCHE_VEGETATION, carres.COUCHE_FORET, "exg")
        lon, lat = carres.wgs84(X0 + 1, Y0 + 1)
        return {"source": "lidar_hd", "couvert": True,
                "houppiers": [{"lon": lon, "lat": lat, "h": 8, "r": 2, "profil": None}]}

    monkeypatch.setattr(carres, "houppiers_pour_emprise", houppiers)
    v = carres.fetch_vegetation(I, J)
    w, s, e, n, resolution = lus["mnh"]
    # L'emprise lue couvre le carré et sa marge, à 0,5 m.
    for x, y in [(X0 - 15, Y0 - 15), (X0 + 515, Y0 + 515)]:
        lon, lat = carres.wgs84(x, y)
        assert w <= lon <= e and s <= lat <= n
    assert resolution == 0.5
    assert (v["source"], v["couvert"], v["ports"], v["arbres"]) == \
        ("lidar_hd", True, list(carres.PORTS), [[10, 10, 80, 20, 0]])


def test_une_lecture_des_arbres_en_echec_n_ecrit_rien(monkeypatch, tmp_path):
    def mnh(*a, **k):
        raise requests.HTTPError("HTTP 400 sur wms-r")

    monkeypatch.setattr(carres, "fetch_mnh_grid", mnh)
    monkeypatch.setattr(carres, "fetch_exg_grid", lambda *a: None)
    monkeypatch.setattr(carres, "lire_couche", lambda *a, **k: {"features": []})
    stock = carres.Carres(str(tmp_path), lire=carres.fetch_vegetation, couche="vegetation-",
                          version=carres.VEGETATION_VERSION)
    with pytest.raises(carres.CarreIndisponible):
        stock.obtenir(I, J)
    assert not stock.present(I, J)


def test_les_arbres_ont_leur_route_et_leur_dossier(service, tmp_path):
    client = service(lambda i, j: {"carre": [i, j], "batiments": []},
                     lire_vegetation=lambda i, j: {"carre": [i, j], "arbres": [[1, 2, 3, 4, 0]]},
                     quota_carres=1)
    r = client.get(f"/api/vegetation?i={I}&j={J}")
    assert r.status_code == 200 and json.loads(gzip.decompress(r.data))["arbres"] == [[1, 2, 3, 4, 0]]
    assert os.path.exists(os.path.join(str(tmp_path), "carres", f"vegetation-v{carres.VEGETATION_VERSION}",
                                       str(I), f"{J}.json.gz"))
    # Les arbres du carré ont compté : ses bâtiments, neufs, attendent.
    assert client.get(f"/api/carre?i={I}&j={J}").status_code == 429
    assert client.get(f"/api/vegetation?i={I}&j={J}").status_code == 200


def test_les_bords_de_toit_ne_sont_pas_des_arbres():
    """Un houppier fin collé à un bâtiment est un débord de toit ; un arbre
    fin loin du bâti (un cyprès) et un arbre large contre un mur restent."""
    def lonlat(dx, dy):
        return carres.wgs84(X0 + dx, Y0 + dy)

    mur = [list(lonlat(100, 100)), list(lonlat(120, 100)), list(lonlat(120, 120)),
           list(lonlat(100, 120)), list(lonlat(100, 100))]
    batiments = {"features": [{"geometry": {"type": "Polygon", "coordinates": [mur]}}]}

    def houppier(dx, dy, h, r):
        lon, lat = lonlat(dx, dy)
        return {"lon": lon, "lat": lat, "h": h, "r": r, "profil": None}

    houppiers = [houppier(121, 110, 16, 1.2),     # aiguille à 1 m du mur
                 houppier(300, 300, 16, 1.2),     # aiguille isolée : un cyprès
                 houppier(121.5, 110, 12, 3.0),   # arbre large contre le mur
                 houppier(110, 110, 18, 1.0)]     # aiguille au-dessus du toit
    assert carres.debords_de_toit(houppiers, batiments) == {0, 3}
    gardes = carres.arbres_du_carre(houppiers, I, J, batiments)
    assert [(a[0], a[1]) for a in gardes] == [(3000, 3000), (1215, 1100)]
    assert len(carres.arbres_du_carre(houppiers, I, J)) == 4


def test_un_tronc_sur_la_chaussee_est_pousse_au_bord():
    """Le sommet d'un arbre du bord qui surplombe la route tombe sur la
    chaussée : l'arbre va à 1 m au-delà du ruban, du côté le plus proche, sur
    une route à sa largeur BD TOPO ou à celle de sa nature ; les tunnels, les
    tronçons fictifs et les sentiers n'ont pas de ruban."""
    def lonlat(dx, dy):
        return list(carres.wgs84(X0 + dx, Y0 + dy))

    def troncon(dy, **props):
        return _route("T", [lonlat(0, dy) + [440], lonlat(300, dy) + [440]], **props)

    routes = {"features": [troncon(100),                                   # 5,5 m : bord à 2,75 m
                           troncon(200, largeur_de_chaussee=None),          # 1 chaussée : 3 m
                           troncon(300, position_par_rapport_au_sol="-1"),  # tunnel
                           troncon(350, fictif=True),
                           troncon(400, nature="Sentier")]}

    def houppier(dx, dy):
        lon, lat = lonlat(dx, dy)
        return {"lon": lon, "lat": lat, "h": 14, "r": 3, "profil": None}

    houppiers = [houppier(50, 101), houppier(80, 99.5), houppier(120, 104), houppier(150, 200.4),
                 houppier(50, 300), houppier(50, 350), houppier(50, 400), houppier(50, 150)]
    assert sorted(carres.hors_des_chaussees(houppiers, routes)) == [0, 1, 3]
    arbres = carres.arbres_du_carre(houppiers, I, J, routes=routes)
    # En décimètres, à 1 dm près : les mètres de la poussée sont ceux d'une
    # projection locale, à 0,2 % de ceux du Lambert-93 (3,742 m pour 3,75).
    attendus = [(500, 1037.5), (800, 962.5), (1200, 1040),   # 2,75 + 1 m de l'axe ; 4 m : déjà dehors
                (1500, 2025),                                # 1,5 + 1 m
                (500, 3000), (500, 3500), (500, 4000), (500, 1500)]
    assert len(arbres) == len(attendus)
    for a, (x, y) in zip(arbres, attendus):
        assert abs(a[0] - x) <= 1 and abs(a[1] - y) <= 1, (a, x, y)


def test_un_troncon_fictif_le_dit():
    ligne = [[X0, Y0, 1], [X0 + 5, Y0, 1]]
    fictif, reel = carres.routes_du_carre({"features": [_route("F", ligne, fictif=True), _route("R", ligne)]}, I, J)
    assert fictif["fictif"] is True and "fictif" not in reel


def test_la_page_demande_la_version_du_serveur():
    """Le navigateur garde un carré une semaine : son adresse porte la version."""
    grille = os.path.join(os.path.dirname(carres.__file__), "static", "js", "voiture", "carres", "grille.js")
    page = open(grille, encoding="utf-8").read()
    assert f"const CARRES_VERSION = {carres.CARRES_VERSION}, VEGETATION_VERSION = {carres.VEGETATION_VERSION};" in page


def test_un_houppier_sur_un_pont_est_le_pont():
    """Le tablier dépasse du sol comme un arbre : ce qui tombe sur un tronçon
    au-dessus du sol, à sa demi-largeur et 3 m près, en est un morceau."""
    def lonlat(dx, dy):
        return list(carres.wgs84(X0 + dx, Y0 + dy))

    def troncon(sol, dy):
        return {"geometry": {"type": "LineString", "coordinates": [lonlat(0, dy), lonlat(200, dy)]},
                "properties": {"position_par_rapport_au_sol": sol, "largeur_de_chaussee": 8}}

    routes = {"features": [troncon("1", 100), troncon("0", 300)]}

    def houppier(dx, dy):
        lon, lat = lonlat(dx, dy)
        return {"lon": lon, "lat": lat, "h": 6, "r": 2, "profil": None}

    houppiers = [houppier(50, 106), houppier(50, 108), houppier(50, 300), houppier(50, 200)]
    # 4 m de demi-largeur et 3 m de marge : 6 m du tablier oui, 8 m non ; la
    # route au sol ne compte pas.
    assert carres.sur_un_pont(houppiers, routes) == {0}
    assert len(carres.arbres_du_carre(houppiers, I, J, routes=routes)) == 3
