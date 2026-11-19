"""Ce que l'audit de sécurité du 19 novembre 2026 a trouvé, et qui ne doit pas
revenir : chaque test rejoue l'attaque."""
import json

import pytest

from vue3d.routes.reponses import CHEMIN_SERVEUR
from vue3d.scene import zone_normalisee
from vue3d.signalements import SIGNALEMENT_PROFONDEUR_MAX, Signalements, SignalementInvalide, profondeur


def test_un_etat_trop_profond_est_refuse(tmp_path):
    """3 Mo de tableaux imbriqués à la profondeur 990 se réécrivaient
    indentés en 1,5 Go."""
    s = Signalements(str(tmp_path))
    d = SIGNALEMENT_PROFONDEUR_MAX
    profond = '{"etat":{"a":' + "[" * d + "0" + "]" * d + "}}"
    with pytest.raises(SignalementInvalide, match="niveaux"):
        s.enregistrer(profond.encode())
    with pytest.raises(SignalementInvalide):
        s.enregistrer(('{"etat":{"a":' + "[" * 5000 + "]" * 5000 + "}}").encode())   # RecursionError


def test_un_signalement_est_ecrit_sans_grossir(tmp_path):
    s = Signalements(str(tmp_path))
    d = SIGNALEMENT_PROFONDEUR_MAX - 2
    corps = ('{"etat":{"a":' + "[" * d + ",".join(["0"] * 20000) + "]" * d + "}}").encode()
    ident = s.enregistrer(corps)
    taille = (tmp_path / f"{ident}.json").stat().st_size
    assert taille < len(corps) + 1000
    assert json.loads((tmp_path / f"{ident}.json").read_text())["etat"] == json.loads(corps)["etat"]


def test_la_profondeur_compte_les_niveaux():
    assert profondeur(3) == 0 and profondeur({}) == 1 and profondeur({"a": [1, {"b": []}]}) == 4


@pytest.mark.parametrize("zone", ["inf", "-inf", "1e400", "nan"])
def test_une_zone_infinie_n_est_pas_une_zone(zone):
    """round(inf) levait OverflowError : une erreur 500 à chaque demande."""
    with pytest.raises(ValueError):
        zone_normalisee(zone)


def test_les_chemins_du_serveur_ne_sortent_pas():
    message = ("nuage illisible : [Errno 28] No space left on device: '/Users/quelqu-un/Services/cache/v15/x' "
               "; HTTP 503 sur https://data.geopf.fr/wfs/ows?SERVICE=WFS ; modèle /modeles/yolo.onnx absent")
    propre = CHEMIN_SERVEUR.sub("…", message)
    assert "/Users" not in propre and "/modeles" not in propre
    assert "https://data.geopf.fr/wfs/ows?SERVICE=WFS" in propre


@pytest.fixture
def client(tmp_path):
    from vue3d import app as module_app
    return module_app.creer_app(str(tmp_path)).test_client()


AILLEURS = {"Sec-Fetch-Site": "cross-site", "Origin": "https://site-tiers.example"}


@pytest.mark.parametrize("url", ["/api/avis?lat=48.85&lon=2.29", "/api/signalement",
                                 "/api/reconstruire?lat=48.85&lon=2.29"])
def test_un_post_venu_d_un_autre_site_est_refuse(client, url):
    """Un site tiers faisait voter ses visiteurs, ou répartissait sur leurs
    adresses ce que le quota borne par adresse."""
    r = client.post(url, data='{"avis":-1,"etat":{}}', content_type="application/json", headers=AILLEURS)
    assert r.status_code == 403


@pytest.mark.parametrize("url", ["/api/avis?lat=48.85&lon=2.29", "/api/signalement"])
def test_un_corps_qui_n_est_pas_du_json_declare_est_refuse(client, url):
    """text/plain : la requête « simple » qu'un formulaire d'un autre site
    envoie sans requête préalable, même d'un navigateur sans Sec-Fetch-Site."""
    assert client.post(url, data='{"avis":-1,"etat":{}}', content_type="text/plain").status_code == 415


def test_la_page_du_service_poste_toujours(client):
    r = client.post("/api/signalement", data='{"etat":{"vitesse":50}}', content_type="application/json",
                    headers={"Sec-Fetch-Site": "same-origin"})
    assert r.status_code == 201


@pytest.mark.parametrize("url", ["/api/scene?lat=48.85&lon=2.29&zone=inf", "/api/avancement?lat=48.85&lon=2.29&zone=1e400"])
def test_une_zone_infinie_est_une_erreur_du_visiteur(client, url):
    assert client.get(url).status_code in (400, 422)


def test_pas_de_redirection_batie_sur_l_hote(client):
    r = client.get("/api//sante", headers={"Host": "evil.example"})
    assert r.status_code == 404 and "evil.example" not in r.headers.get("Location", "")
