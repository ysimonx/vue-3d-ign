"""Avis sur le rendu d'une scène (vue3d/avis.py, GET et POST /api/avis)."""
import base64
import json
import os

import pytest

from vue3d import app as module_app
from vue3d import avis as module_avis
from vue3d.avis import Avis, AvisComplets, AvisInvalide
from vue3d.scene import NOM_ORTHO, NOM_SCENE, SCENE_VERSION, nom_scene

JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64
CAPTURE = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()
# Gordes, centre du village.
GORDES = f"v{SCENE_VERSION}/43.9116_5.2003_z1000"
VUE = ("http://localhost:8080/?lat=43.9116&lon=5.2003&vue=43.911600,5.200300,12.0,620.0,150.0,18.0"
       "&heure=13.25&couches=solaire,-vegetation")


def corps(**d):
    return json.dumps(d).encode()


def test_une_adresse_un_avis_par_scene(tmp_path):
    """Le dernier avis d'une adresse compte : changé, il remplace l'ancien ;
    0 le retire. Un autre service qui relit le journal trouve les mêmes comptes."""
    avis = Avis(str(tmp_path))
    assert avis.compter(GORDES, "A") == {"pour": 0, "contre": 0, "mien": 0}
    avis.recevoir(GORDES, corps(avis=1), "A")
    avis.recevoir(GORDES, corps(avis=1), "B")
    _, comptes = avis.recevoir(GORDES, corps(avis=-1), "C")
    assert comptes == {"pour": 2, "contre": 1, "mien": -1}
    _, comptes = avis.recevoir(GORDES, corps(avis=-1), "A")
    assert comptes == {"pour": 1, "contre": 2, "mien": -1}
    avis.recevoir(GORDES, corps(avis=0), "B")
    assert avis.compter(GORDES, "B") == {"pour": 0, "contre": 2, "mien": 0}
    # Une autre scène, un autre compte.
    assert avis.compter(GORDES.replace("_z1000", ""), "A") == {"pour": 0, "contre": 0, "mien": 0}
    assert Avis(str(tmp_path)).compter(GORDES, "A") == {"pour": 0, "contre": 2, "mien": -1}
    assert len((tmp_path / "avis.jsonl").read_text().splitlines()) == 5


def test_un_autre_processus_et_un_journal_vide(tmp_path):
    """Deux processus du service partagent le journal : chacun relit ce que
    l'autre a écrit. Vidé à la main, il remet les comptes à zéro."""
    un, autre = Avis(str(tmp_path)), Avis(str(tmp_path))
    un.recevoir(GORDES, corps(avis=1), "A")
    autre.recevoir(GORDES, corps(avis=1), "B")
    assert un.compter(GORDES, "A") == {"pour": 2, "contre": 0, "mien": 1}
    # Une ligne en cours d'écriture ne compte qu'une fois finie.
    with open(tmp_path / "avis.jsonl", "a") as f:
        f.write('{"id": "x", "scene": "' + GORDES + '", "adresse": "C", "avis": -1')
    assert un.compter(GORDES)["contre"] == 0
    with open(tmp_path / "avis.jsonl", "a") as f:
        f.write('}\n')
    assert un.compter(GORDES)["contre"] == 1
    (tmp_path / "avis.jsonl").write_text("")
    assert un.compter(GORDES, "A") == {"pour": 0, "contre": 0, "mien": 0}


def test_un_pouce_baisse_garde_la_vue_et_la_capture(tmp_path):
    """Le lien de la vue est gardé à partir de son `?` ; la capture d'un 👎
    seulement."""
    avis = Avis(str(tmp_path))
    ident, _ = avis.recevoir(GORDES, corps(avis=-1, vue=VUE, capture=CAPTURE), "A", "Safari")
    assert (tmp_path / "captures" / f"{ident}.jpg").read_bytes() == JPEG
    ligne = json.loads((tmp_path / "avis.jsonl").read_text())
    assert ligne["vue"] == VUE[VUE.index("?"):] and ligne["capture"] is True
    assert ligne["scene"] == GORDES and ligne["adresse"] == "A" and ligne["agent"] == "Safari"
    pour, _ = avis.recevoir(GORDES, corps(avis=1, vue=VUE, capture=CAPTURE), "B")
    assert os.listdir(tmp_path / "captures") == [f"{ident}.jpg"]
    assert json.loads((tmp_path / "avis.jsonl").read_text().splitlines()[1])["capture"] is False


def test_le_mot_accompagne_le_pouce_baisse_en_cours(tmp_path):
    avis = Avis(str(tmp_path))
    ident, _ = avis.recevoir(GORDES, corps(avis=-1), "A")
    _, comptes = avis.recevoir(GORDES, corps(sur=ident, mot="  Le toit de l'église est plat. "), "A")
    assert comptes == {"pour": 0, "contre": 1, "mien": -1}
    assert json.loads((tmp_path / "avis.jsonl").read_text().splitlines()[1])["mot"] == "Le toit de l'église est plat."
    for adresse, d in [("B", {"sur": ident, "mot": "pas le sien"}),
                       ("A", {"sur": "autre", "mot": "un autre avis"}),
                       ("A", {"sur": ident, "mot": " "}),
                       ("A", {"sur": ident, "mot": "x" * (module_avis.MOT_CARACTERES_MAX + 1)})]:
        with pytest.raises(AvisInvalide):
            avis.recevoir(GORDES, corps(**d), adresse)
    # Changé d'avis : le mot n'a plus de 👎 à accompagner.
    avis.recevoir(GORDES, corps(avis=1), "A")
    with pytest.raises(AvisInvalide):
        avis.recevoir(GORDES, corps(sur=ident, mot="trop tard"), "A")


@pytest.mark.parametrize("donnees", [
    b"pas du json",
    json.dumps([1, -1]).encode(),
    corps(avis=2),
    corps(avis=True),
    corps(avis="1"),
    corps(avis=1, vue="javascript:alert(1)"),
    corps(avis=1, vue="https://ailleurs.example/?a=<script>"),
    corps(avis=-1, capture="data:image/png;base64,AAAA"),
])
def test_un_corps_qui_n_est_pas_un_avis(tmp_path, donnees):
    with pytest.raises(AvisInvalide):
        Avis(str(tmp_path)).recevoir(GORDES, donnees, "A")
    assert not (tmp_path / "avis.jsonl").exists() and not (tmp_path / "captures").exists()


def test_journal_plein_et_captures_bornees(tmp_path, monkeypatch):
    """Au-delà des captures gardées, l'avis compte sans capture ; journal
    plein, plus rien n'est écrit, capture comprise."""
    monkeypatch.setattr(module_avis, "CAPTURES_MAX", 1)
    avis = Avis(str(tmp_path))
    avis.recevoir(GORDES, corps(avis=-1, capture=CAPTURE), "A")
    _, comptes = avis.recevoir(GORDES, corps(avis=-1, capture=CAPTURE), "B")
    assert comptes["contre"] == 2 and len(os.listdir(tmp_path / "captures")) == 1
    monkeypatch.setattr(module_avis, "CAPTURES_MAX", 10)
    monkeypatch.setattr(module_avis, "JOURNAL_OCTETS_MAX", (tmp_path / "avis.jsonl").stat().st_size + 10)
    with pytest.raises(AvisComplets):
        avis.recevoir(GORDES, corps(avis=-1, capture=CAPTURE), "C")
    assert len(os.listdir(tmp_path / "captures")) == 1
    assert avis.compter(GORDES)["contre"] == 2


VISITEUR_A = {"REMOTE_ADDR": "203.0.113.5"}
VISITEUR_B = {"REMOTE_ADDR": "203.0.113.6"}
URL = "/api/avis?lat=43.9116&lon=5.2003&zone=1000"


def construite(tmp_path):
    """La scène de Gordes en cache, comme le Cache la voit présente."""
    dossier = tmp_path / nom_scene(43.9116, 5.2003, 1000)
    dossier.mkdir(parents=True)
    (dossier / NOM_SCENE).write_bytes(b"")
    (dossier / NOM_ORTHO).write_bytes(b"")


def test_la_route_des_avis(tmp_path):
    client = module_app.creer_app(str(tmp_path)).test_client()
    # Pas encore construite : comptée vide, pas jugée.
    r = client.get(URL, environ_base=VISITEUR_A)
    assert r.status_code == 200 and r.headers["Cache-Control"] == "no-store"
    assert r.get_json() == {"pour": 0, "contre": 0, "mien": 0}
    assert client.post(URL, data=corps(avis=1), environ_base=VISITEUR_A).status_code == 404
    construite(tmp_path)
    r = client.post(URL, data=corps(avis=-1, vue=VUE, capture=CAPTURE), environ_base=VISITEUR_A)
    assert r.status_code == 201 and r.headers["Cache-Control"] == "no-store"
    assert {k: v for k, v in r.get_json().items() if k != "id"} == {"pour": 0, "contre": 1, "mien": -1}
    assert client.post(URL, data=corps(sur=r.get_json()["id"], mot="Arbres sur la route."),
                       environ_base=VISITEUR_A).status_code == 201
    client.post(URL, data=corps(avis=1), environ_base=VISITEUR_B)
    assert client.get(URL, environ_base=VISITEUR_B).get_json() == {"pour": 1, "contre": 1, "mien": 1}
    # La même scène, le point écrit autrement.
    assert client.get("/api/avis?lat=43.91161&lon=5.20029&zone=1010").get_json()["pour"] == 1
    ligne = json.loads((tmp_path / "avis" / "avis.jsonl").read_text().splitlines()[0])
    assert ligne["scene"] == GORDES and ligne["adresse"] == "203.0.113.5"
    assert client.get("/api/avis?lat=43.9").status_code == 400
    assert client.get("/api/avis?lat=60&lon=5").status_code == 422
    assert client.post(URL, data=corps(avis=3), environ_base=VISITEUR_A).status_code == 400
    trop = b"x" * (module_avis.AVIS_OCTETS_MAX + 1)
    assert client.post(URL, data=trop, environ_base=VISITEUR_A).status_code == 413


def test_le_quota_des_avis(tmp_path, monkeypatch):
    monkeypatch.setattr(module_app, "AVIS_PAR_HEURE", 2)
    client = module_app.creer_app(str(tmp_path), quota=20).test_client()
    construite(tmp_path)
    for avis in (1, -1):
        assert client.post(URL, data=corps(avis=avis), environ_base=VISITEUR_A).status_code == 201
    r = client.post(URL, data=corps(avis=0), environ_base=VISITEUR_A)
    assert r.status_code == 429 and r.headers["Retry-After"] == "600"
    assert client.post(URL, data=corps(avis=1), environ_base=VISITEUR_B).status_code == 201
