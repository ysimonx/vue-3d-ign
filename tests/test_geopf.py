"""Reprise sur incident des services de la Géoplateforme (vue3d/geopf.py)."""
import functools

import pytest
import requests

from vue3d import geopf


@pytest.fixture(autouse=True)
def places_neuves(monkeypatch):
    """Des places à soi, que les autres tests ne tiennent pas."""
    monkeypatch.setattr(geopf, "_places", geopf._Places(geopf.GEOPF_SIMULTANEES))


class _Reponse:
    def __init__(self, code):
        self.status_code = code
        self.ok = code < 400


def test_une_reponse_normale_passe_du_premier_coup(monkeypatch):
    appels = []
    monkeypatch.setattr(geopf.requests, "get", lambda url, timeout: appels.append(url) or _Reponse(200))
    assert geopf.get_avec_reprise("http://x").status_code == 200
    assert len(appels) == 1


def test_un_delai_d_attente_est_retente(monkeypatch):
    appels = []

    def get(url, timeout):
        appels.append(url)
        if len(appels) < 3:
            raise requests.Timeout("Read timed out")
        return _Reponse(200)

    monkeypatch.setattr(geopf.requests, "get", get)
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    assert geopf.get_avec_reprise("http://x").ok
    assert len(appels) == 3


def test_un_echec_persistant_finit_par_remonter(monkeypatch):
    monkeypatch.setattr(geopf.requests, "get",
                        lambda url, timeout: (_ for _ in ()).throw(requests.Timeout("nope")))
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    with pytest.raises(requests.RequestException):
        geopf.get_avec_reprise("http://x")


def test_un_refus_sporadique_est_retente(monkeypatch):
    """Contre-intuitif mais mesuré : une requête de relief rejetée en 400
    pendant un rattrapage, rejouée telle quelle, a répondu 200 six fois de
    suite. Ces refus-là sont passagers comme les délais d'attente."""
    appels = []

    def get(url, timeout):
        appels.append(url)
        return _Reponse(400 if len(appels) == 1 else 200)

    monkeypatch.setattr(geopf.requests, "get", get)
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    assert geopf.get_avec_reprise("http://x").ok
    assert len(appels) == 2


def test_un_refus_persistant_finit_par_remonter(monkeypatch):
    appels = []
    monkeypatch.setattr(geopf.requests, "get",
                        lambda url, timeout: appels.append(url) or _Reponse(400))
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    with pytest.raises(requests.RequestException, match="400"):
        geopf.get_avec_reprise("http://x")
    assert len(appels) == geopf.GEOPF_ESSAIS


class _PageDeMesures(_Reponse):
    """Ce que le WFS a servi en 200 à une requête sur 6 à 40 le 18 novembre
    2026 : les compteurs Prometheus de son serveur Java."""
    def __init__(self):
        super().__init__(200)
        self.headers = {"Content-Type": "text/plain; version=0.0.4; charset=utf-8"}
        self.text = "# HELP jvm_threads_current Current thread count of a JVM\n"


def test_une_page_de_mesures_servie_en_200_est_retentee(monkeypatch):
    appels = []

    def get(url, timeout):
        appels.append(url)
        if len(appels) == 1:
            return _PageDeMesures()
        reponse = _Reponse(200)
        reponse.headers = {"Content-Type": "application/json;charset=UTF-8"}
        return reponse

    monkeypatch.setattr(geopf.requests, "get", get)
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    reponse = geopf.get_avec_reprise("http://x")
    assert reponse.headers["Content-Type"].startswith("application/json")
    assert len(appels) == 2


def test_une_page_de_mesures_persistante_finit_par_remonter(monkeypatch):
    appels = []
    monkeypatch.setattr(geopf.requests, "get",
                        lambda url, timeout: appels.append(url) or _PageDeMesures())
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    with pytest.raises(requests.RequestException, match="page de mesures"):
        geopf.get_avec_reprise("http://x")
    assert len(appels) == geopf.GEOPF_ESSAIS


def test_un_texte_brut_ordinaire_n_est_pas_une_page_de_mesures():
    """Seul le format de Prometheus est rejoué : un autre texte brut est
    rendu à l'appelant, qui en juge."""
    reponse = _Reponse(200)
    reponse.headers = {"Content-Type": "text/plain; charset=utf-8"}
    assert not geopf._page_de_mesures(reponse)


def test_en_parallele_rend_les_resultats_dans_l_ordre():
    """Lancées ensemble (la barrière ne s'ouvre qu'à trois), rendues dans
    l'ordre où on les a données, pas dans celui où elles finissent."""
    import threading
    import time
    barriere = threading.Barrier(3, timeout=5)

    def lecture(valeur, delai):
        barriere.wait()
        time.sleep(delai)
        return valeur

    assert geopf.en_parallele(lambda: lecture("a", 0.2), lambda: lecture("b", 0),
                              lambda: lecture("c", 0.1)) == ["a", "b", "c"]
    assert geopf.en_parallele(lambda: "seule") == ["seule"]


def test_en_parallele_n_attend_pas_les_autres_pour_echouer():
    import threading
    import time
    libere = threading.Event()

    def lente():
        libere.wait(10)
        return "trop tard"

    def en_panne():
        raise requests.Timeout("Read timed out")

    debut = time.monotonic()
    try:
        with pytest.raises(requests.Timeout):
            geopf.en_parallele(lente, en_panne)
        assert time.monotonic() - debut < 5
    finally:
        libere.set()


def test_les_requetes_simultanees_sont_bornees(monkeypatch):
    """Tout le processus partage GEOPF_SIMULTANEES places : trois fois plus
    de lectures WFS lancées ensemble n'en ont jamais davantage en cours."""
    import concurrent.futures
    import threading
    import time

    from vue3d import couches
    en_cours, pic, verrou = [0], [0], threading.Lock()

    class _Reponse:
        text = '{"features": []}'

        def raise_for_status(self):
            pass

    def get(url, timeout=None):
        if "TYPENAMES=X&" not in url:
            return _Reponse()           # celle d'un autre test, encore en cours
        with verrou:
            en_cours[0] += 1
            pic[0] = max(pic[0], en_cours[0])
        time.sleep(0.05)
        with verrou:
            en_cours[0] -= 1
        return _Reponse()

    monkeypatch.setattr(couches, "get_avec_reprise", get)
    lecture = functools.partial(geopf.en_parallele, *(lambda: couches._requete("X", 0, 0, 1, 1)
                                                      for _ in range(3 * geopf.GEOPF_SIMULTANEES)))
    with concurrent.futures.ThreadPoolExecutor(1) as bassin:
        geopf.Groupe().soumettre(bassin, lecture).result(timeout=10)
    assert pic[0] == geopf.GEOPF_SIMULTANEES


def test_en_parallele_abandonne_les_lectures_qui_attendent_leur_place(monkeypatch):
    """Une lecture échoue pendant que les deux autres attendent la seule
    place : elles ne partent jamais. Le quart d'une couche en échec, le MNS
    du repli : la lecture entière échouera, les autres ne servent plus."""
    import threading

    demandes = threading.Semaphore(0)

    class Places(geopf._Places):
        def prendre(self, groupe):
            demandes.release()
            return super().prendre(groupe)

    monkeypatch.setattr(geopf, "_places", Places(1))
    parties = []

    def en_panne():
        with geopf.place():
            # Les deux autres attendent la place, puis l'échec.
            for _ in range(3):
                assert demandes.acquire(timeout=5)
            raise requests.Timeout("Read timed out")

    def attend():
        with geopf.place():
            parties.append("partie")

    with pytest.raises(requests.Timeout):
        geopf.en_parallele(en_panne, attend, attend)
    for fil in threading.enumerate():
        if fil.name.startswith("geopf"):
            fil.join(5)
    assert parties == []


def test_en_parallele_rapporte_l_echec_et_non_l_abandon(monkeypatch):
    """La lecture abandonnée à cause d'une voisine en échec vient avant
    elle dans l'ordre : c'est l'échec de la voisine qui remonte, pas
    « lecture abandonnée »."""
    import concurrent.futures
    import threading

    abandonne = threading.Event()
    abandonner = geopf.Groupe.abandonner

    def abandonner_et_signaler(self, cause=None):
        abandonner(self, cause)
        abandonne.set()

    def attend():
        abandonne.wait(5)
        with geopf.place():
            return "partie"

    def en_panne():
        raise requests.Timeout("Read timed out")

    attendre = concurrent.futures.wait
    monkeypatch.setattr(geopf.Groupe, "abandonner", abandonner_et_signaler)
    # Les deux finies quand en_parallele regarde : l'ordre des fils n'y est
    # pour rien.
    monkeypatch.setattr(concurrent.futures, "wait",
                        lambda futurs, return_when=None: attendre(futurs, timeout=5))
    with pytest.raises(requests.Timeout):
        geopf.en_parallele(attend, en_panne)


def test_un_groupe_imbrique_n_abandonne_pas_celui_qui_le_contient():
    scene = geopf.Groupe()
    quarts = geopf.Groupe(scene)
    quarts.abandonner()
    assert quarts.abandonne() and not scene.abandonne()
    scene_2 = geopf.Groupe()
    terrain = geopf.Groupe(scene_2)
    scene_2.abandonner()
    assert terrain.abandonne()
    with pytest.raises(geopf.LectureAbandonnee):
        terrain.verifier()


def test_une_lecture_abandonnee_ne_reessaie_pas(monkeypatch):
    """Son groupe abandonné pendant un essai (une autre lecture a échoué),
    la lecture ne réessaie pas : pendant une panne, chaque essai peut tenir
    sa place 30 s."""
    import concurrent.futures
    groupe = geopf.Groupe()
    appels = []

    def get(url, timeout):
        appels.append(url)
        groupe.abandonner()
        raise requests.Timeout("Read timed out")

    monkeypatch.setattr(geopf.requests, "get", get)
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    with concurrent.futures.ThreadPoolExecutor(1) as bassin:
        futur = groupe.soumettre(bassin, geopf.get_avec_reprise, "http://x")
        with pytest.raises(geopf.LectureAbandonnee):
            futur.result(timeout=5)
    assert appels == ["http://x"]


def test_hors_groupe_rien_ne_change(monkeypatch):
    """Sans groupe (les ouvrages, l'orthophoto des détections), la reprise
    est celle d'avant : tous les essais."""
    appels = []
    monkeypatch.setattr(geopf.requests, "get",
                        lambda url, timeout: appels.append(url) or _Reponse(502))
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    with pytest.raises(requests.RequestException, match="502"):
        geopf.get_avec_reprise("http://x")
    assert len(appels) == geopf.GEOPF_ESSAIS


def test_une_panne_serveur_est_retentee(monkeypatch):
    appels = []
    monkeypatch.setattr(geopf.requests, "get",
                        lambda url, timeout: appels.append(url) or _Reponse(503))
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    with pytest.raises(requests.RequestException, match="503"):
        geopf.get_avec_reprise("http://x")
    assert len(appels) == geopf.GEOPF_ESSAIS


def test_un_refus_persistant_porte_sa_reponse(monkeypatch):
    """Une tuile WMTS hors couverture répond 404 : l'appelant le lit sur la
    réponse jointe à l'exception (vue3d/tuiles.py)."""
    monkeypatch.setattr(geopf.requests, "get", lambda url, timeout: _Reponse(404))
    monkeypatch.setattr(geopf.time, "sleep", lambda s: None)
    with pytest.raises(requests.RequestException) as exc:
        geopf.get_avec_reprise("http://x")
    assert exc.value.response.status_code == 404
