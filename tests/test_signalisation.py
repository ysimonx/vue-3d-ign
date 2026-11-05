"""Stops, cédez-le-passage et feux de la voiture (vue3d/signalisation.py) et leur route /api/signalisation."""
import gzip
import json
import os

import pytest
import requests

from vue3d import app as module_app
from vue3d import carres, signalisation
from vue3d.signalisation import BlocsSignaux, signaux_du_bloc, signaux_du_carre

# Le carré de Gordes, comme tests/test_carres.py.
I, J = 1752, 12632
X0, Y0 = I * carres.CARRE_M, J * carres.CARRE_M


def _noeud(ident, dx, dy, **tags):
    lon, lat = carres.wgs84(X0 + dx, Y0 + dy)
    n = {"type": "node", "id": ident, "lon": lon, "lat": lat}
    if tags:
        n["tags"] = tags
    return n


def _voie(highway, *noeuds):
    return {"type": "way", "tags": {"highway": highway}, "nodes": [n["id"] for n in noeuds],
            "geometry": [{"lon": n["lon"], "lat": n["lat"]} for n in noeuds]}


def test_les_panneaux_d_un_bloc_et_leur_sens():
    """Sur une voie dessinée vers l'est (cap 90°) : `forward` vaut pour qui
    roule vers l'est, `backward` vers l'ouest ; sans sens, un stop est à
    déduire et un feu arrête les deux. Un feu au nœud de trois branches est
    un feu de carrefour ; un passage piéton dessiné n'en fait pas un."""
    a, b, c = _noeud(1, 0, 100), _noeud(2, 400, 100), _noeud(3, 200, 300)
    stop = _noeud(10, 100, 100, highway="stop", direction="forward")
    cedez = _noeud(11, 150, 100, highway="give_way", direction="backward")
    nu = _noeud(12, 250, 100, highway="stop")
    pieton = _noeud(13, 300, 100, highway="traffic_signals")
    carrefour = _noeud(14, 200, 100, highway="traffic_signals")
    sens = _noeud(15, 350, 100, highway="traffic_signals", **{"traffic_signals:direction": "forward"})
    isole = _noeud(16, 50, 150, highway="give_way")
    trottoir = _noeud(17, 300, 90)
    brut = {"elements": [stop, cedez, nu, pieton, carrefour, sens, isole,
                         _voie("residential", a, stop, cedez, carrefour, nu, pieton, sens, b),
                         _voie("tertiary", carrefour, c),
                         _voie("footway", pieton, trottoir)]}
    signaux = {round(s[1] - X0): s for s in signaux_du_bloc(brut)}
    assert signaux[100][0] == "stop" and signaux[100][4] == pytest.approx([90], abs=0.5)
    assert signaux[150][0] == "cedez" and signaux[150][4] == pytest.approx([270], abs=0.5)
    assert signaux[250][4] is None and signaux[250][5] == 0
    assert signaux[300][0] == "feu" and signaux[300][4] == pytest.approx([90, 270], abs=0.5)
    assert signaux[300][5] == 0
    assert signaux[200][5] == 1
    assert signaux[350][4] == pytest.approx([90], abs=0.5)
    # Hors de toute voie : ni axe ni sens.
    assert signaux[50][3] is None and signaux[50][4] is None
    assert signaux[100][1:3] == pytest.approx([X0 + 100, Y0 + 100], abs=0.1)


def _troncon(cleabs, points, **props):
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [list(p) + [440] for p in points]},
            "properties": {"cleabs": cleabs, "etat_de_l_objet": "En service", "nature": "Route à 1 chaussée",
                           "acces_vehicule_leger": "Libre", "sens_de_circulation": "Double sens", **props}}


def _signal(type_, dx, dy, axe=None, caps=None, carrefour=0):
    return [type_, X0 + dx, Y0 + dy, axe, caps, carrefour]


# Un carrefour en T au point (300, 100) : une route est-ouest coupée en deux
# tronçons, et une branche vers le nord.
OUEST = _troncon("OUEST", [(X0 + 100, Y0 + 100), (X0 + 300, Y0 + 100)])
EST = _troncon("EST", [(X0 + 300, Y0 + 100), (X0 + 450, Y0 + 100)])
NORD = _troncon("NORD", [(X0 + 300, Y0 + 100), (X0 + 300, Y0 + 300)])
CARREFOUR = {"features": [OUEST, EST, NORD]}


def test_un_panneau_prend_le_sens_que_donne_osm():
    """Un stop qui vaut vers l'est, à 3 m du tronçon OUEST dessiné vers
    l'est : son sens ; sur un tronçon dessiné vers l'ouest, l'autre."""
    sortie = signaux_du_carre(CARREFOUR, [_signal("stop", 280, 103, axe=90, caps=[90])], I, J)
    assert sortie == [["stop", "OUEST", 1, 180.0]]
    inverse = {"features": [_troncon("OUEST", [(X0 + 300, Y0 + 100), (X0 + 100, Y0 + 100)]), EST, NORD]}
    assert signaux_du_carre(inverse, [_signal("stop", 280, 103, axe=90, caps=[90])], I, J) == [
        ["stop", "OUEST", -1, 20.0]]


def test_sans_sens_un_panneau_vaut_vers_le_carrefour():
    """Le bout du tronçon OUEST au T est un carrefour, l'autre non : un
    cédez-le-passage sans sens y arrête qui roule vers le T, même plus près
    de l'autre bout. Sur un tronçon sans carrefour, vers le bout le plus proche."""
    assert signaux_du_carre(CARREFOUR, [_signal("cedez", 130, 100, axe=90)], I, J) == [["cedez", "OUEST", 1, 30.0]]
    seul = {"features": [OUEST]}
    assert signaux_du_carre(seul, [_signal("cedez", 130, 100, axe=90)], I, J) == [["cedez", "OUEST", -1, 30.0]]


def test_un_feu_de_carrefour_vaut_pour_chaque_troncon_qui_y_arrive():
    """Posé à 6 m du nœud du T : un feu sur chaque branche, à RECUL_M du
    nœud, dans le sens qui y arrive ; pas sur une branche à sens unique qui
    en part. Le feu d'approche du tronçon OUEST, à 10 m du premier, est le même."""
    recul = signalisation.RECUL_M
    unique = {"features": [OUEST, EST, _troncon("NORD", NORD["geometry"]["coordinates"], sens_de_circulation="Sens direct")]}
    sortie = signaux_du_carre(unique, [_signal("feu", 304, 104, axe=90, carrefour=1),
                                       _signal("feu", 290 - recul, 101, axe=90, caps=[90])], I, J)
    assert sorted(sortie) == [["feu", "EST", -1, recul], ["feu", "OUEST", 1, 200 - recul]]


def test_un_panneau_trop_loin_ou_hors_du_carre_n_est_pas_rattache():
    sortie = signaux_du_carre(CARREFOUR, [
        _signal("stop", 200, 120, axe=90, caps=[90]),          # à 20 m de la route
        _signal("stop", 200, 104, axe=0, caps=[0]),            # sa voie croise le tronçon
        _signal("stop", 600, 100, axe=90, caps=[90]),          # dans le carré voisin
        _signal("stop", 300, 100, axe=90, caps=[90], carrefour=1),   # au nœud même du T
    ], I, J)
    assert sortie == []


def test_un_bloc_lu_une_fois_ou_pas_du_tout(tmp_path):
    lectures = []

    def lire(bi, bj):
        lectures.append((bi, bj))
        return {"elements": []}

    blocs = BlocsSignaux(str(tmp_path), lire=lire)
    assert blocs.obtenir(3, 4) == [] and blocs.obtenir(3, 4) == []
    assert lectures == [(3, 4)]
    assert os.path.exists(os.path.join(blocs.dossier, "3", "4.json.gz"))
    assert BlocsSignaux(str(tmp_path), lire=lambda *a: pytest.fail("relu")).obtenir(3, 4) == []

    def en_panne(bi, bj):
        raise requests.RequestException("Overpass injoignable : 504")

    with pytest.raises(requests.RequestException):
        BlocsSignaux(str(tmp_path), lire=en_panne).obtenir(5, 6)
    assert not os.path.exists(os.path.join(blocs.dossier, "5"))


def test_un_carre_de_signalisation_se_lit_ou_echoue_entier(monkeypatch):
    emprises = []

    def lire_couche(couche, *emprise, **k):
        emprises.append(emprise)
        return CARREFOUR

    monkeypatch.setattr(signalisation, "lire_couche", lire_couche)
    demandes = []

    class Blocs:
        def obtenir(self, bi, bj):
            demandes.append((bi, bj))
            return [_signal("stop", 280, 103, axe=90, caps=[90])]

    d = signalisation.fetch_signalisation(I, J, Blocs())
    assert d["version"] == signalisation.SIGNALISATION_VERSION and d["carre"] == [I, J]
    assert d["signaux"] == [["stop", "OUEST", 1, 180.0]]
    # Le bloc de 2 km du carré ; les tronçons du carré et de sa marge.
    assert demandes == [(X0 // signalisation.BLOC_M, Y0 // signalisation.BLOC_M)]
    m = signalisation.MARGE_M
    assert emprises == [(X0 - m, Y0 - m, X0 + carres.CARRE_M + m, Y0 + carres.CARRE_M + m)]

    class EnPanne:
        def obtenir(self, bi, bj):
            raise requests.RequestException("Overpass injoignable")

    with pytest.raises(carres.CarreIndisponible):
        signalisation.fetch_signalisation(I, J, EnPanne())
    with pytest.raises(carres.CarreHorsEmprise):
        signalisation.fetch_signalisation(-5, J, Blocs())


def test_la_signalisation_a_sa_route_et_son_dossier(tmp_path):
    def lire(i, j):
        if i == I + 1:
            raise carres.CarreIndisponible("Overpass injoignable")
        return {"carre": [i, j], "signaux": [["stop", "A", 1, 12.5]]}

    client = module_app.creer_app(str(tmp_path), lire_carre=lambda i, j: {"carre": [i, j]},
                                  lire_signalisation=lire, quota_carres=1).test_client()
    r = client.get(f"/api/signalisation?i={I}&j={J}")
    assert r.status_code == 200 and r.headers["Cache-Control"] == "public, max-age=604800"
    assert json.loads(gzip.decompress(r.data))["signaux"] == [["stop", "A", 1, 12.5]]
    assert os.path.exists(os.path.join(str(tmp_path), "carres",
                                       f"signalisation-v{signalisation.SIGNALISATION_VERSION}",
                                       str(I), f"{J}.json.gz"))
    # La signalisation du carré a compté dans le quota des carrés neufs.
    assert client.get(f"/api/carre?i={I}&j={J}").status_code == 429
    client = module_app.creer_app(str(tmp_path), lire_carre=lambda i, j: {},
                                  lire_signalisation=lire).test_client()
    r = client.get(f"/api/signalisation?i={I + 1}&j={J}")
    assert r.status_code == 503 and r.headers["Retry-After"] == "10"


def test_la_page_demande_la_version_de_la_signalisation():
    """Le navigateur garde un carré une semaine : son adresse porte la version."""
    statique = os.path.join(os.path.dirname(signalisation.__file__), "static")
    grille = open(os.path.join(statique, "js", "voiture", "carres", "grille.js"), encoding="utf-8").read()
    assert f"SIGNALISATION_VERSION = {signalisation.SIGNALISATION_VERSION};" in grille
