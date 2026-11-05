"""Avis des visiteurs sur le rendu d'une scène : 👍 ou 👎, comptés et
montrés à tous sur la page. Un 👎 garde aussi de quoi revoir le défaut : le
lien de la vue (caméra, soleil, couches : interface/partage.js de la page),
une capture de l'écran et, si le visiteur l'écrit, ce qui ne va pas. Ils se
lisent dans la page privée des visites, hors du dépôt.

Un journal, `<dossier>/avis.jsonl`, une ligne par événement, jamais réécrit :
un avis changé ou retiré s'y ajoute, et le dernier d'une adresse compte —
une adresse, un avis par scène. Les captures à côté,
`<dossier>/captures/<id>.jpg`. Une scène est nommée par son dossier du cache
(scene.nom_scene) : une nouvelle SCENE_VERSION, un autre rendu, repart sans
avis.

Le service est public : ce qu'un visiteur écrit sur le disque est borné, en
taille, en nombre de captures, en taille du journal et, avec un quota, par
heure et par adresse ; la route n'accepte d'avis que sur une scène construite.
"""

import json
import os
import re
import secrets
import threading
from datetime import datetime

from .signalements import SignalementInvalide, ecrire_entier, lire_capture

# Une capture de la vue, 1 280 px au plus grand côté en JPEG à 0,75, pèse
# 197 Ko à Gordes, 184 Ko à la tour Eiffel (vue de 1 920 × 1 080, le
# 5 novembre 2026) : 3 Mo laissent quinze fois la marge.
AVIS_OCTETS_MAX = 3_000_000
# Au-delà, l'avis compte toujours, sans capture : 500 × 200 Ko font 100 Mo.
# Les captures lues sont à effacer à la main.
CAPTURES_MAX = 500
# Une ligne pèse ~400 octets, ~1,4 Ko avec un mot entier : 20 Mo en
# gardent plus de quinze mille. Au-delà, plus aucun avis n'est reçu.
JOURNAL_OCTETS_MAX = 20_000_000
MOT_CARACTERES_MAX = 1000
# Par adresse et par heure, quand le service a un quota : de quoi changer
# d'avis et juger chaque lieu visité (Yannick, 17 scènes en une heure de
# tests), pas de quoi remplir le journal.
AVIS_PAR_HEURE = 60
# Le lien de la vue, gardé à partir de son `?` : la page des visites le
# rattache à son propre hôte, et n'écrit jamais une adresse venue d'un
# visiteur. Ce que lienDeLaVue() écrit : chiffres, lettres, `=&.,-`.
VUE_MOTIF = re.compile(r"\?[A-Za-z0-9=&.,:_%+-]{1,1000}")
AGENT_CARACTERES_MAX = 300


class AvisInvalide(ValueError):
    """Le corps n'est pas un avis : JSON illisible, avis hors de 1, -1 et 0,
    lien de vue mal formé, capture qui n'est pas un JPEG, mot sans 👎."""


class AvisComplets(Exception):
    """Le journal a atteint JOURNAL_OCTETS_MAX : plus rien n'est écrit."""


class Avis:
    """Les avis gardés dans `dossier`, et leurs comptes par scène."""

    def __init__(self, dossier, horloge=datetime.now):
        self.dossier = dossier
        self.journal = os.path.join(dossier, "avis.jsonl")
        self.captures = os.path.join(dossier, "captures")
        self.horloge = horloge
        self._verrou = threading.Lock()
        self._lu = 0                 # octets du journal déjà comptés
        self._votes = {}             # scène → {adresse: (avis, id)}

    def _relire(self):
        """Ajoute aux comptes les lignes écrites depuis la dernière lecture,
        par ce processus ou un autre du service. Sous self._verrou."""
        try:
            with open(self.journal, "rb") as f:
                if os.fstat(f.fileno()).st_size < self._lu:
                    # Journal vidé ou remplacé à la main : tout se relit.
                    self._lu, self._votes = 0, {}
                f.seek(self._lu)
                reste = f.read()
        except FileNotFoundError:
            self._lu, self._votes = 0, {}
            return
        # Une ligne pas encore finie attend la lecture suivante.
        fin = reste.rfind(b"\n") + 1
        for ligne in reste[:fin].splitlines():
            try:
                e = json.loads(ligne)
                if "avis" in e:
                    self._votes.setdefault(e["scene"], {})[e["adresse"]] = (e["avis"], e["id"])
            except (ValueError, KeyError, TypeError):
                continue              # ligne abîmée : elle ne compte pas
        self._lu += fin

    def _ajouter(self, evenement):
        """Une ligne au journal, d'une seule écriture en ajout : deux
        processus n'y mêlent pas leurs lignes. Sous self._verrou."""
        ligne = (json.dumps(evenement, ensure_ascii=False) + "\n").encode()
        os.makedirs(self.dossier, exist_ok=True)
        fd = os.open(self.journal, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
        try:
            if os.fstat(fd).st_size + len(ligne) > JOURNAL_OCTETS_MAX:
                raise AvisComplets(f"journal des avis plein ({JOURNAL_OCTETS_MAX // 1_000_000} Mo)")
            os.write(fd, ligne)
        finally:
            os.close(fd)

    def _comptes(self, scene, adresse):
        votes = self._votes.get(scene, {})
        return {"pour": sum(1 for a, _ in votes.values() if a > 0),
                "contre": sum(1 for a, _ in votes.values() if a < 0),
                "mien": votes.get(adresse, (0, None))[0]}

    def compter(self, scene, adresse=None):
        """{"pour": 👍, "contre": 👎, "mien": 1, -1 ou 0} de la scène, pour
        le visiteur à `adresse`."""
        with self._verrou:
            self._relire()
            return self._comptes(scene, adresse)

    def recevoir(self, scene, corps, adresse=None, agent=None):
        """Garde l'avis `corps` (octets JSON : {"avis": 1, -1 ou 0, "vue":
        "…?lat=…", "capture": "data:image/jpeg;base64,…"}, capture d'un 👎
        seulement), ou le mot qui accompagne le 👎 de cette adresse
        ({"sur": son id, "mot": "…"}) ; rend son identifiant,
        `AAAAMMJJ-HHMMSS-xxxxxx`, et les comptes de la scène.

        Raises:
            AvisInvalide: le corps n'est pas un avis.
            AvisComplets: le journal est plein.
        """
        try:
            donnees = json.loads(corps)
        except (UnicodeDecodeError, ValueError) as exc:
            raise AvisInvalide(f"JSON illisible : {exc}") from exc
        if not isinstance(donnees, dict):
            raise AvisInvalide("objet {\"avis\": …} attendu")
        recu = self.horloge()
        ident = f"{recu:%Y%m%d-%H%M%S}-{secrets.token_hex(3)}"
        evenement = {"id": ident, "recu": recu.isoformat(timespec="seconds"), "scene": scene,
                     "adresse": adresse}
        if "sur" in donnees:
            mot = donnees.get("mot")
            if not isinstance(mot, str) or not mot.strip() or len(mot) > MOT_CARACTERES_MAX:
                raise AvisInvalide(f"mot attendu, {MOT_CARACTERES_MAX} caractères au plus")
            with self._verrou:
                self._relire()
                if self._votes.get(scene, {}).get(adresse) != (-1, donnees["sur"]):
                    raise AvisInvalide("un mot accompagne le 👎 en cours de cette adresse sur cette scène")
                self._ajouter({**evenement, "sur": donnees["sur"], "mot": mot.strip()})
                return ident, self._comptes(scene, adresse)

        avis = donnees.get("avis")
        if isinstance(avis, bool) or avis not in (1, -1, 0):
            raise AvisInvalide("avis attendu : 1, -1 ou 0")
        vue = donnees.get("vue")
        if vue is not None:
            vue = str(vue)[str(vue).find("?"):] if "?" in str(vue) else ""
            if not VUE_MOTIF.fullmatch(vue):
                raise AvisInvalide("lien de la vue mal formé")
        try:
            capture = lire_capture(donnees.get("capture")) if avis < 0 else None
        except SignalementInvalide as exc:
            raise AvisInvalide(str(exc)) from exc
        chemin = os.path.join(self.captures, ident + ".jpg")
        with self._verrou:
            if capture is not None:
                garde = (len(os.listdir(self.captures)) if os.path.isdir(self.captures) else 0)
                if garde >= CAPTURES_MAX:
                    capture = None
                else:
                    os.makedirs(self.captures, exist_ok=True)
                    ecrire_entier(chemin, capture)
            try:
                self._ajouter({**evenement, "agent": (agent or "")[:AGENT_CARACTERES_MAX] or None,
                               "avis": avis, "vue": vue, "capture": capture is not None})
            except AvisComplets:
                if capture is not None:
                    os.remove(chemin)
                raise
            self._relire()
            return ident, self._comptes(scene, adresse)
