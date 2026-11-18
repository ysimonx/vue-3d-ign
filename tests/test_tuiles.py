"""Tuiles WMTS gardées par le serveur (vue3d/tuiles.py), sans réseau."""
import math
import os
import threading

import pytest
import requests

from vue3d import app as module_app
from vue3d import geopf, tuiles
from vue3d.tuiles import Stock, TuileAbsente, TuileIllisible, TuilesOccupees

JPEG = b"\xff\xd8\xff\xe0 une tuile"


def _tuile(lat, lon, z):
    n = 2 ** z
    return (z, int((lon + 180) / 360 * n),
            int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n))


GORDES = _tuile(43.9116, 5.2003, 16)


class _Horloges:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


def _stock(tmp_path, lire=lambda couche, z, x, y: JPEG):
    horloge = _Horloges()
    return Stock(str(tmp_path / "tuiles"), lire=lire, chrono=horloge), horloge


def test_l_url_de_l_ign_est_celle_de_la_page():
    """FONDS de la page (static/js/commun/tuiles.js) lisait exactement cette URL
    avant de passer par le serveur."""
    assert tuiles.url_ign("ortho", 16, 33729, 23899) == (
        "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
        "&LAYER=ORTHOIMAGERY.ORTHOPHOTOS&STYLE=normal&FORMAT=image/jpeg"
        "&TILEMATRIXSET=PM&TILEMATRIX=16&TILEROW=23899&TILECOL=33729")
    assert "LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2" in tuiles.url_ign("plan", 16, 1, 2)
    assert "FORMAT=image/png" in tuiles.url_ign("plan", 16, 1, 2)


def test_seules_les_tuiles_que_la_page_demande_sont_valides():
    z, x, y = GORDES
    assert tuiles.valide("ortho", z, x, y) and tuiles.valide("plan", z, x, y)
    assert not tuiles.valide("cadastre", z, x, y)
    assert not tuiles.valide("ortho", 8, *_tuile(43.9, 5.2, 8)[1:])     # sous l'horizon
    assert not tuiles.valide("ortho", 19, *_tuile(43.9, 5.2, 19)[1:])   # au-delà du fond
    assert not tuiles.valide("ortho", z, 2 ** z, y)                       # hors de la grille
    assert not tuiles.valide("ortho", 12, *_tuile(52.5, 13.4, 12)[1:])  # Berlin
    # L'horizon de Bonifacio descend à 60 km au sud de l'emprise servie.
    assert tuiles.valide("ortho", 12, *_tuile(40.85, 9.15, 12)[1:])


def test_une_tuile_relue_est_gardee_puis_servie(tmp_path):
    lues = []
    stock, _ = _stock(tmp_path, lambda *t: lues.append(t) or JPEG)
    assert stock.present("ortho", *GORDES) is None
    chemin = stock.relire("ortho", *GORDES)
    assert open(chemin, "rb").read() == JPEG and lues == [("ortho", *GORDES)]
    assert stock.present("ortho", *GORDES) == chemin
    assert chemin.endswith(f"/ortho/{GORDES[0]}/{GORDES[1]}/{GORDES[2]}.jpg")
    # Rien d'autre dans le dossier : le fichier temporaire est renommé.
    assert os.listdir(os.path.dirname(chemin)) == [os.path.basename(chemin)]


def test_une_tuile_perimee_n_est_plus_servie(tmp_path):
    stock, _ = _stock(tmp_path)
    chemin = stock.relire("ortho", *GORDES)
    vieux = os.path.getmtime(chemin) - tuiles.TUILES_AGE_MAX_S - 1
    os.utime(chemin, (vieux, vieux))
    assert stock.present("ortho", *GORDES) is None
    assert not os.path.exists(chemin)


def test_une_tuile_absente_est_retenue_un_temps(tmp_path):
    lues = []

    def lire(*t):
        lues.append(t)
        raise TuileAbsente("mer")

    stock, horloge = _stock(tmp_path, lire)
    with pytest.raises(TuileAbsente):
        stock.relire("ortho", *GORDES)
    assert stock.absente("ortho", *GORDES) and not stock.absente("plan", *GORDES)
    horloge.t += tuiles.TUILES_ABSENTE_S
    assert not stock.absente("ortho", *GORDES)
    assert stock.present("ortho", *GORDES) is None and len(lues) == 1


def test_une_lecture_en_echec_n_ecrit_rien(tmp_path):
    def lire(*t):
        raise requests.RequestException("HTTP 502")

    stock, _ = _stock(tmp_path, lire)
    with pytest.raises(requests.RequestException):
        stock.relire("ortho", *GORDES)
    assert stock.present("ortho", *GORDES) is None and not stock.absente("ortho", *GORDES)
    assert not os.path.exists(tmp_path / "tuiles" / "ortho")


def test_au_dela_des_relectures_simultanees_le_serveur_refuse_sans_attendre(tmp_path):
    stock, _ = _stock(tmp_path)
    for _ in range(tuiles.TUILES_RELECTURES_SIMULTANEES):
        stock._relectures.acquire()
    with pytest.raises(TuilesOccupees):
        stock.relire("ortho", *GORDES)
    stock._relectures.release()
    assert stock.relire("ortho", *GORDES)


def test_la_purge_efface_les_tuiles_perimees_et_leurs_dossiers(tmp_path):
    stock, _ = _stock(tmp_path)
    vieille = stock.relire("ortho", *GORDES)
    recente = stock.relire("plan", *GORDES)
    t = os.path.getmtime(vieille) - tuiles.TUILES_AGE_MAX_S - 1
    os.utime(vieille, (t, t))
    assert stock.purger() == 1
    assert not os.path.exists(vieille) and os.path.exists(recente)
    assert not os.path.exists(tmp_path / "tuiles" / "ortho")
    assert os.path.isdir(tmp_path / "tuiles")


def test_la_purge_part_une_fois_par_jour(tmp_path):
    stock, horloge = _stock(tmp_path)
    fil = stock.purger_si_du()
    assert fil is not None
    fil.join()
    assert stock.purger_si_du() is None
    horloge.t += tuiles.TUILES_PURGE_S
    stock.purger_si_du().join()


class _Reponse:
    def __init__(self, code, contenu=b"", type_="image/jpeg"):
        self.status_code = code
        self.ok = code < 400
        self.content = contenu
        self.headers = {"content-type": type_}


@pytest.fixture
def places_neuves(monkeypatch):
    monkeypatch.setattr(geopf, "_places", geopf._Places(geopf.GEOPF_SIMULTANEES))
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)


def test_fetch_tuile_rend_l_image_et_reconnait_l_absence(monkeypatch, places_neuves):
    """Un 404 jusqu'au bout est une absence ; un 400 puis un 200, un refus
    passager rattrapé ; une page d'erreur rendue en 200, une tuile illisible."""
    reponses = []
    monkeypatch.setattr(geopf.requests, "get", lambda url, timeout: reponses.pop(0))
    reponses[:] = [_Reponse(400), _Reponse(200, JPEG)]
    assert tuiles.fetch_tuile("ortho", *GORDES) == JPEG
    reponses[:] = [_Reponse(404)] * tuiles.TUILES_ESSAIS
    with pytest.raises(TuileAbsente):
        tuiles.fetch_tuile("ortho", *GORDES)
    reponses[:] = [_Reponse(502)] * tuiles.TUILES_ESSAIS
    with pytest.raises(requests.RequestException):
        tuiles.fetch_tuile("ortho", *GORDES)
    reponses[:] = [_Reponse(200, b"<ExceptionReport/>", "application/xml")]
    with pytest.raises(TuileIllisible):
        tuiles.fetch_tuile("ortho", *GORDES)
    reponses[:] = [_Reponse(200, JPEG, "image/png")]
    with pytest.raises(TuileIllisible):
        tuiles.fetch_tuile("plan", *GORDES)


# --- La route /api/tuile -------------------------------------------------------

def _client(tmp_path, lire, **options):
    appli = module_app.creer_app(str(tmp_path), lire_tuile=lire, **options)
    return appli.test_client()


def _url(couche="ortho", tuile=GORDES):
    z, x, y = tuile
    return f"/api/tuile/{couche}/{z}/{x}/{y}"


def test_hors_stock_la_tuile_est_redirigee_vers_l_ign_et_mise_en_reserve(tmp_path):
    lues = []
    client = _client(tmp_path, lambda *t: lues.append(t) or JPEG)
    r = client.get(_url())
    assert r.status_code == 302 and r.headers["Location"] == tuiles.url_ign("ortho", *GORDES)
    assert r.headers["Cache-Control"] == "no-store"
    # Lue en tâche de fond, puis servie du stock au visiteur suivant.
    assert client.application.extensions["vue3d_tuiles"].attendre_reserve()
    assert lues == [("ortho", *GORDES)]
    r = client.get(_url())
    assert r.status_code == 200 and r.data == JPEG and len(lues) == 1


def test_les_zooms_de_la_voiture_ne_sont_pas_mis_en_reserve(tmp_path):
    lues = []
    client = _client(tmp_path, lambda *t: lues.append(t) or JPEG)
    assert client.get(_url(tuile=_tuile(43.9116, 5.2003, 17))).status_code == 302
    assert client.application.extensions["vue3d_tuiles"].attendre_reserve() and lues == []


def test_les_reserves_d_un_visiteur_sont_bornees(tmp_path):
    lues = []
    client = _client(tmp_path, lambda *t: lues.append(t) or JPEG, reserves=2)
    z, x, y = GORDES
    # Les tuiles de la voiture, jamais mises en réserve, ne comptent pas.
    for k in range(3):
        assert client.get(_url(tuile=(17, 2 * x + k, 2 * y))).status_code == 302
    for k in range(3):
        assert client.get(_url(tuile=(z, x + k, y))).status_code == 302
    assert client.application.extensions["vue3d_tuiles"].attendre_reserve()
    assert sorted(lues) == [("ortho", z, x, y), ("ortho", z, x + 1, y)]


def test_une_tuile_refusee_est_relue_gardee_puis_servie_du_stock(tmp_path):
    lues = []
    client = _client(tmp_path, lambda *t: lues.append(t) or JPEG)
    r = client.get(_url() + "?relire=1")
    assert r.status_code == 200 and r.data == JPEG and r.mimetype == "image/jpeg"
    assert "max-age=1814400" in r.headers["Cache-Control"]
    # Ensuite servie du stock, sans relecture ni redirection.
    r = client.get(_url())
    assert r.status_code == 200 and r.data == JPEG and len(lues) == 1
    r = client.get(_url() + "?relire=1")
    assert r.status_code == 200 and len(lues) == 1


def test_une_tuile_absente_rend_404_sans_redemander_l_ign(tmp_path):
    lues = []

    def lire(*t):
        lues.append(t)
        raise TuileAbsente("mer")

    client = _client(tmp_path, lire)
    assert client.get(_url() + "?relire=1").status_code == 404
    r = client.get(_url())
    assert r.status_code == 404 and r.headers["Cache-Control"] == "no-store"
    assert client.get(_url() + "?relire=1").status_code == 404 and len(lues) == 1


def test_une_panne_de_l_ign_rend_503_et_ne_garde_rien(tmp_path):
    def lire(*t):
        raise requests.RequestException("HTTP 502")

    client = _client(tmp_path, lire)
    assert client.get(_url() + "?relire=1").status_code == 503
    assert client.get(_url()).status_code == 302


def test_une_tuile_que_la_page_ne_demande_pas_rend_404_sans_lire(tmp_path):
    lues = []
    client = _client(tmp_path, lambda *t: lues.append(t) or JPEG)
    for url in ("/api/tuile/cadastre/16/1/2", _url(tuile=(19, *_tuile(43.9, 5.2, 19)[1:])),
                _url(tuile=(12, *_tuile(52.5, 13.4, 12)[1:]))):
        assert client.get(url + "?relire=1").status_code == 404
    assert lues == []


def test_les_relectures_d_un_visiteur_sont_bornees(tmp_path):
    client = _client(tmp_path, lambda *t: JPEG, relectures=2)
    z, x, y = GORDES
    assert client.get(_url(tuile=(z, x, y)) + "?relire=1").status_code == 200
    assert client.get(_url(tuile=(z, x + 1, y)) + "?relire=1").status_code == 200
    r = client.get(_url(tuile=(z, x + 2, y)) + "?relire=1")
    assert r.status_code == 429 and r.headers["Retry-After"]
    # Les tuiles déjà gardées restent servies, comme les autres redirigées.
    assert client.get(_url(tuile=(z, x, y))).status_code == 200
    assert client.get(_url(tuile=(z, x + 2, y))).status_code == 302


def test_sans_quota_de_scenes_les_relectures_ne_sont_pas_bornees(tmp_path):
    client = _client(tmp_path, lambda *t: JPEG, quota=0)
    z, x, y = GORDES
    for k in range(5):
        assert client.get(_url(tuile=(z, x + k, y)) + "?relire=1").status_code == 200


# --- La réserve et le stock sur un disque externe -----------------------------

def test_la_reserve_lit_chaque_tuile_une_fois(tmp_path):
    lues = []
    stock, _ = _stock(tmp_path, lambda *t: lues.append(t) or JPEG)
    z, x, y = GORDES
    for k in range(20):
        stock.reserver("ortho", z, x + k % 5, y)
    assert stock.attendre_reserve()
    assert sorted(lues) == [("ortho", z, x + k, y) for k in range(5)]
    assert all(stock.present("ortho", z, x + k, y) for k in range(5))
    # Gardées : plus jamais relues.
    assert stock.reserver("ortho", z, x, y) and stock.attendre_reserve() and len(lues) == 5


def test_une_panne_de_l_ign_vide_la_reserve(tmp_path):
    lues, pret = [], threading.Event()

    def lire(*t):
        lues.append(t)
        pret.wait(5)                    # tout est en file avant le premier échec
        raise requests.RequestException("HTTP 502")

    stock, _ = _stock(tmp_path, lire)
    z, x, y = GORDES
    assert all(stock.reserver("ortho", z, x + k, y) for k in range(10))
    pret.set()
    assert stock.attendre_reserve()
    # Au plus une lecture par fil (un fil qui n'a pas encore pris sa tuile
    # trouve la file vidée), puis plus rien.
    assert 1 <= len(lues) <= tuiles.TUILES_RESERVE_FILS
    assert not any(stock.present("ortho", z, x + k, y) for k in range(10))


def test_sans_son_dossier_le_stock_ne_garde_rien_et_ne_le_cree_pas(tmp_path):
    dossier = tmp_path / "disque" / "vue3d-tuiles"
    lues = []
    stock = Stock(str(dossier), lire=lambda *t: lues.append(t) or JPEG, creer=False)
    assert not stock.disponible()
    # Relue : servie de mémoire.
    assert stock.relire("ortho", *GORDES) == JPEG
    # Pas de réserve.
    assert not stock.reserver("ortho", *GORDES) and len(lues) == 1
    assert not (tmp_path / "disque").exists()
    # Le disque revient : le stock reprend.
    dossier.mkdir(parents=True)
    assert stock.disponible() and stock.relire("ortho", *GORDES) == str(dossier / "ortho" / "16" / str(GORDES[1]) / f"{GORDES[2]}.jpg")


def test_la_route_sert_une_tuile_relue_sans_stock(tmp_path):
    client = _client(tmp_path, lambda *t: JPEG, dossier_tuiles=str(tmp_path / "absent"))
    r = client.get(_url() + "?relire=1")
    assert r.status_code == 200 and r.data == JPEG and r.mimetype == "image/jpeg"
    assert client.get(_url()).status_code == 302
    assert client.application.extensions["vue3d_tuiles"].attendre_reserve()
    assert not (tmp_path / "absent").exists()


def test_vue3d_tuiles_place_le_stock_hors_du_cache(tmp_path, monkeypatch):
    disque = tmp_path / "disque"
    disque.mkdir()
    monkeypatch.setenv("VUE3D_TUILES", str(disque))
    client = _client(tmp_path / "cache", lambda *t: JPEG)
    assert client.get(_url() + "?relire=1").status_code == 200
    z, x, y = GORDES
    assert (disque / "ortho" / str(z) / str(x) / f"{y}.jpg").read_bytes() == JPEG
