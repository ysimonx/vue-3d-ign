"""Signalements de la vue en voiture : le bouton ⚠ de la page envoie une
capture de l'écran et l'état du sol (tuiles autour de la voiture, leurs
photos et leurs altitudes, cache, GPU), que le serveur garde sur disque,
`<dossier>/<id>.json` et `<id>.jpg`, pour l'analyse.

Né d'une photo prise dans une Tesla le 23 octobre 2026 : le sol sans photo
près de la voiture, alors que le serveur n'avait relu aucune tuile pour
elle et que le bandeau n'en annonçait aucune en attente ; un essai au même
endroit sur un ordinateur montrait le sol entier. Ce que la page croit
montrer doit pouvoir se comparer à ce qui se voit.

Le service est public : ce qu'un visiteur écrit sur le disque est borné, en
taille, en nombre gardé et, avec un quota, par heure et par adresse.
"""

import base64
import binascii
import json
import os
import secrets
import threading
from datetime import datetime

# Une capture de 1 280 × 800 en JPEG à 0,75 pèse 89 Ko, un état du sol 26 Ko
# (à l'arrêt chemin de la Fabrique à Fuveau, le 23 octobre 2026) : 3 Mo
# laissent vingt fois la marge, sans laisser un visiteur remplir le disque.
SIGNALEMENT_OCTETS_MAX = 3_000_000
# Au-delà, refusés : 300 × 3 Mo font moins d'un gigaoctet. Les signalements
# lus sont à effacer à la main.
SIGNALEMENTS_MAX = 300
# Par adresse et par heure, quand le service a un quota : un conducteur qui
# insiste sur le bouton en envoie quelques-uns, pas trente.
SIGNALEMENTS_PAR_HEURE = 30


class SignalementInvalide(ValueError):
    """Le corps n'est pas un signalement : JSON illisible, état absent,
    capture qui n'est pas un JPEG."""


class SignalementsComplets(Exception):
    """SIGNALEMENTS_MAX sont déjà gardés : plus rien n'est écrit."""


def lire_capture(texte):
    """Les octets du JPEG d'une URL `data:image/jpeg;base64,…` ; None sans capture."""
    if texte is None:
        return None
    entete, _, donnees = str(texte).partition(",")
    if entete != "data:image/jpeg;base64":
        raise SignalementInvalide("capture attendue en data:image/jpeg;base64")
    try:
        octets = base64.b64decode(donnees, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise SignalementInvalide(f"capture illisible : {exc}") from exc
    if not octets.startswith(b"\xff\xd8"):
        raise SignalementInvalide("la capture n'est pas un JPEG")
    return octets


def ecrire_entier(chemin, octets):
    """Écrit d'un coup : un fichier à moitié écrit ne porte jamais son nom."""
    provisoire = f"{chemin}.{secrets.token_hex(4)}.tmp"
    with open(provisoire, "wb") as f:
        f.write(octets)
    os.replace(provisoire, chemin)


class Signalements:
    """Les signalements gardés dans `dossier`."""

    def __init__(self, dossier, horloge=datetime.now):
        self.dossier = dossier
        self.horloge = horloge
        self._verrou = threading.Lock()

    def nombre(self):
        if not os.path.isdir(self.dossier):
            return 0
        return sum(1 for n in os.listdir(self.dossier) if n.endswith(".json"))

    def enregistrer(self, corps, adresse=None, agent=None):
        """Garde le signalement `corps` (octets JSON : {"etat": {…}, "capture":
        "data:image/jpeg;base64,…" facultative}) ; rend son identifiant,
        `AAAAMMJJ-HHMMSS-xxxx`, que la page affiche.

        Raises:
            SignalementInvalide: le corps n'est pas un signalement.
            SignalementsComplets: SIGNALEMENTS_MAX sont déjà gardés.
        """
        try:
            donnees = json.loads(corps)
        except (UnicodeDecodeError, ValueError) as exc:
            raise SignalementInvalide(f"JSON illisible : {exc}") from exc
        if not isinstance(donnees, dict) or not isinstance(donnees.get("etat"), dict):
            raise SignalementInvalide("objet {\"etat\": {…}} attendu")
        capture = lire_capture(donnees.get("capture"))
        with self._verrou:
            if self.nombre() >= SIGNALEMENTS_MAX:
                raise SignalementsComplets(f"{SIGNALEMENTS_MAX} signalements déjà gardés")
            os.makedirs(self.dossier, exist_ok=True)
            recu = self.horloge()
            ident = f"{recu:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"
            base = os.path.join(self.dossier, ident)
            if capture is not None:
                ecrire_entier(base + ".jpg", capture)
            # Le JSON en dernier : il dit qu'un signalement est complet.
            ecrire_entier(base + ".json", json.dumps({
                "id": ident, "recu": recu.isoformat(timespec="seconds"), "adresse": adresse,
                "agent": agent, "capture": capture is not None, "etat": donnees["etat"],
            }, ensure_ascii=False, indent=1).encode())
        return ident
