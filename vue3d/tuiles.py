"""Tuiles WMTS de la Géoplateforme refusées aux visiteurs, gardées sur le serveur.

La page lit l'orthophoto et le Plan IGN en tuiles WMTS de 256 pixels : le fond
de la scène quand l'orthophoto publiée manque, l'anneau, et surtout l'horizon,
jusqu'à 60 km. La Géoplateforme en refuse par épisodes (400, parfois 404) une
tuile qui existe : 253 refus en une visite le 15 octobre 2026 vers 17 h 15,
aucun ensuite, ni en rafale ni au pas — 576 tuiles lues 12 à la fois, 576 une
à une toutes les 100 ms, aux zooms 12, 13 et 17, depuis l'adresse du
serveur. Ce n'est donc pas le débit : la page n'y gagnerait rien à espacer ses
demandes. Elle réessayait une fois après 1,5 s ; au second refus, un trou ou
une tuile floue restait.

D'où ce stock. La page demande chaque tuile au serveur (`/api/tuile/…`) :
présente sur disque, il la sert ; sinon, il redirige vers l'IGN, et le
navigateur la lit là-bas comme avant — seules les tuiles en stock passent par
le serveur, et par la connexion qui le relie. Refusée au navigateur, la page la
redemande avec `?relire=1` : le serveur la lit lui-même, avec les reprises de
`geopf.get_avec_reprise`, la garde et la rend. Une tuile qu'il redirige, il la
met aussi en réserve : lue par lui en tâche de fond et gardée, pour le
visiteur suivant (TUILES_RESERVE_ZOOM_MAX). Le stock ne contient donc que des
tuiles lues par le serveur à l'IGN — jamais une image venue d'un navigateur,
qu'on ne saurait vérifier : l'IGN ne donne ni ETag ni date de modification.

Une tuile gardée se périme (TUILES_AGE_MAX_S) : l'IGN renouvelle
l'orthophoto, et sans ETag on ne peut pas lui demander si la sienne a changé.
"""

import logging
import math
import os
import tempfile
import threading
import time

import requests

from .geopf import get_avec_reprise, place
from .scene import EMPRISE_SERVIE

journal = logging.getLogger(__name__)

# Couches servies : (nom WMTS, type, extension, signature du fichier). Les
# mêmes que FONDS dans les pages (static/js/commun/tuiles.js).
COUCHES = {
    "ortho": ("ORTHOIMAGERY.ORTHOPHOTOS", "image/jpeg", "jpg", b"\xff\xd8"),
    "plan": ("GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2", "image/png", "png", b"\x89PNG"),
}
URL_WMTS = ("https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0"
            "&LAYER={couche}&STYLE=normal&FORMAT={type}"
            "&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}")
# Zooms que la page demande : HORIZON_ZOOM_MIN (9, terrain/horizon.js) à
# TUILE_ZOOM (18, terrain/fond.js). Au-delà, une demande ne vient pas de la page.
TUILES_ZOOM = (9, 18)
# Marge autour de l'emprise servie (scene.EMPRISE_SERVIE), en degrés :
# l'horizon s'étend à HORIZON_RAYON = 60 km du point, 0,54° en latitude et
# 0,8° en longitude à 48°.
TUILES_MARGE_DEG = 1.0
# Durée de vie d'une tuile gardée. L'IGN dit aux navigateurs de garder une
# tuile 21 jours (Cache-Control: max-age=1814400) et renouvelle l'orthophoto
# d'un département tous les trois ans environ : 90 jours, choisis le 15
# octobre 2026, rattrapent une nouvelle prise de vue en moins d'un trimestre.
TUILES_AGE_MAX_S = 90 * 86400
# Intervalle entre deux purges du stock.
TUILES_PURGE_S = 86400
# Reprises d'une relecture : un visiteur l'attend. Trois essais comme
# geopf.GEOPF_ESSAIS, mais à 1,5 s d'écart et non 3 : le délai après lequel
# la page redemandait une tuile refusée, qui suffisait à Gordes (un 404 au
# zoom 16, puis 200 cinq fois de suite).
TUILES_ESSAIS = 3
TUILES_ATTENTE_S = 1.5
# Relectures à la fois, pour tout le processus. Chacune tient une des 8
# places de la Géoplateforme (geopf.GEOPF_SIMULTANEES) pendant ses reprises,
# 3 s au moins pour une tuile vraiment absente ; une scène ne gagne rien
# au-delà de 4 places (mesure du 1er octobre 2026, vue3d/geopf.py). Au-delà
# de 2, une relecture est refusée tout de suite (503) plutôt que d'attendre :
# elle bloquerait un des 8 fils de gunicorn.
TUILES_RELECTURES_SIMULTANEES = 2
# Une tuile vraiment absente — la mer au large dès le zoom 16, l'étranger dès
# le 13 — répond 404 à chaque reprise. Retenue ici, elle n'est plus
# redemandée à l'IGN pendant ce temps : la page la remplace par celle d'un
# ancêtre. Une absence à tort (trois refus en 3 s) floute la tuile au plus
# ce temps-là, d'où une journée et non la durée du stock.
TUILES_ABSENTE_S = 86400
# Relectures par heure et par adresse IP, quand le service a un quota de
# scènes (VUE3D_QUOTA) : 253 refus en une visite pendant l'épisode du 15
# octobre 2026 ; 1 000 en laissent passer quatre, et bornent ce qu'une seule
# adresse fait lire à l'IGN et écrire sur le disque (~15 Mo).
TUILES_RELECTURES_PAR_HEURE = 1000
# Mise en réserve : une tuile que le serveur redirige vers l'IGN, il la lit
# aussi lui-même, en tâche de fond, et la garde ; le visiteur suivant la reçoit
# d'ici. L'IGN en tient parfois une très longtemps : 675 tuiles au zoom 16
# lues le 18 novembre 2026, douze à la fois comme la page, ont mis 0,2 s en
# médiane et 2,3 s au plus, sauf une, 66 s ; l'anneau de Notre-Dame l'a
# attendue. Le lendemain d'une visite, ses tuiles viennent du stock.
#
# Jusqu'au zoom 16 : l'anneau (16) et l'horizon (9 à 15) d'une scène, que la
# page compose d'un bloc ou tuile à tuile. Pas les zooms 17 et 18, du sol de
# la scène quand son orthophoto publiée manque, et de la vue en voiture, qui
# en lit le long de chaque trajet et garde les siennes dans le navigateur.
TUILES_RESERVE_ZOOM_MAX = 16
# Lectures de réserve à la fois : avec les TUILES_RELECTURES_SIMULTANEES, les
# tuiles tiennent au plus 4 des 8 places de la Géoplateforme, et en laissent 4
# aux scènes, qui ne gagnent rien au-delà (vue3d/geopf.py).
TUILES_RESERVE_FILS = 2
# Tuiles en attente de lecture, au plus ; au-delà, une tuile redirigée n'est
# pas mise en réserve (elle le sera à sa prochaine demande). Une visite neuve
# en demande 440 jusqu'au zoom 16 sans bouger la caméra (Notre-Dame, zone de
# 1 000 m) : une dizaine de visites d'avance.
TUILES_RESERVE_FILE = 5000
# Tuiles mises en réserve par heure et par adresse IP, quand le service a un
# quota de scènes : vingt visites neuves, autant que de scènes neuves
# (VUE3D_QUOTA = 20 en production). Borne ce qu'une adresse fait lire à l'IGN
# et écrire sur le disque (~200 Mo par heure).
TUILES_RESERVEES_PAR_HEURE = 10000


class TuileAbsente(Exception):
    """L'IGN répond 404 à chaque reprise : pas d'image à ce zoom ici."""


class TuileIllisible(Exception):
    """La réponse de l'IGN n'est pas une image de la couche."""


class TuilesOccupees(Exception):
    """TUILES_RELECTURES_SIMULTANEES relectures sont déjà en cours."""


def valide(couche, z, x, y):
    """La tuile est-elle de celles que la page demande : couche servie, zoom
    de la page, dans la grille, et près de l'emprise servie ?"""
    if couche not in COUCHES or not TUILES_ZOOM[0] <= z <= TUILES_ZOOM[1]:
        return False
    n = 2 ** z
    if not (0 <= x < n and 0 <= y < n):
        return False
    ouest, est = x / n * 360 - 180, (x + 1) / n * 360 - 180
    nord = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    sud = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    (lat0, lat1), (lon0, lon1) = EMPRISE_SERVIE["lat"], EMPRISE_SERVIE["lon"]
    return (sud <= lat1 + TUILES_MARGE_DEG and nord >= lat0 - TUILES_MARGE_DEG
            and ouest <= lon1 + TUILES_MARGE_DEG and est >= lon0 - TUILES_MARGE_DEG)


def url_ign(couche, z, x, y):
    nom, type_, _, _ = COUCHES[couche]
    return URL_WMTS.format(couche=nom, type=type_, z=z, x=x, y=y)


def fetch_tuile(couche, z, x, y):
    """Octets de la tuile, lus à l'IGN avec reprises.

    Raises:
        TuileAbsente si l'IGN répond 404 jusqu'au bout ;
        TuileIllisible si la réponse n'est pas une image de la couche ;
        requests.RequestException pour tout autre échec.
    """
    _, type_, _, signature = COUCHES[couche]
    try:
        with place():
            reponse = get_avec_reprise(url_ign(couche, z, x, y), essais=TUILES_ESSAIS,
                                       attente=TUILES_ATTENTE_S)
    except requests.RequestException as exc:
        if getattr(exc, "response", None) is not None and exc.response.status_code == 404:
            raise TuileAbsente(f"{couche} {z}/{x}/{y}") from exc
        raise
    if (not reponse.headers.get("content-type", "").startswith(type_)
            or not reponse.content.startswith(signature)):
        raise TuileIllisible(f"{couche} {z}/{x}/{y} : {reponse.headers.get('content-type')}")
    return reponse.content


class Stock:
    """Les tuiles gardées, une par fichier : `dossier/couche/z/x/y.ext`.

    Args:
        lire: (couche, z, x, y) -> octets de la tuile ; `fetch_tuile`, ou une
            doublure pour les tests.
        horloge: secondes, pour l'âge des fichiers (leur instant d'écriture).
        chrono: secondes monotones, pour les absences et la purge.
        creer: crée `dossier` à la première tuile gardée. Faux pour un
            dossier sur un disque externe (VUE3D_TUILES) : disque absent, le
            créer l'écrirait sur le disque interne, sous /Volumes, et macOS
            monterait ensuite le disque sous un autre nom. Sans son dossier,
            le stock ne garde rien : une tuile relue est servie de mémoire.
    """

    def __init__(self, dossier, lire=fetch_tuile, horloge=time.time, chrono=time.monotonic, creer=True):
        self.dossier = dossier
        self.lire = lire
        self.horloge = horloge
        self.chrono = chrono
        self.creer = creer
        self._relectures = threading.BoundedSemaphore(TUILES_RELECTURES_SIMULTANEES)
        self._absentes = {}         # (couche, z, x, y) -> instant où elle a été dite absente
        self._verrou = threading.Lock()
        self._derniere_purge = None
        self._reserve = {}          # (couche, z, x, y) en attente de lecture, dans l'ordre
        self._en_lecture = set()    # celles qu'un fil de la réserve lit
        self._lecteurs = 0          # fils de la réserve en vie
        self._reserve_vide = threading.Condition(self._verrou)

    def chemin(self, couche, z, x, y):
        return os.path.join(self.dossier, couche, str(z), str(x), f"{y}.{COUCHES[couche][2]}")

    def present(self, couche, z, x, y):
        """Chemin de la tuile gardée, ou None. Une tuile périmée est effacée."""
        chemin = self.chemin(couche, z, x, y)
        try:
            age = self.horloge() - os.path.getmtime(chemin)
        except OSError:
            return None
        if age <= TUILES_AGE_MAX_S:
            return chemin
        self._effacer(chemin)
        return None

    def absente(self, couche, z, x, y):
        """L'IGN a-t-il dit cette tuile absente depuis moins de TUILES_ABSENTE_S ?"""
        with self._verrou:
            instant = self._absentes.get((couche, z, x, y))
            if instant is None:
                return False
            if self.chrono() - instant < TUILES_ABSENTE_S:
                return True
            del self._absentes[(couche, z, x, y)]
            return False

    def disponible(self):
        """Le stock peut-il garder une tuile : son dossier existe, ou il peut le créer ?"""
        return self.creer or os.path.isdir(self.dossier)

    def relire(self, couche, z, x, y):
        """Lit la tuile à l'IGN, la garde, et rend son chemin ; ses octets si
        le stock n'est pas disponible.

        Raises:
            TuilesOccupees si TUILES_RELECTURES_SIMULTANEES sont en cours ;
            TuileAbsente (retenue TUILES_ABSENTE_S), TuileIllisible, ou
            l'exception de la lecture ; rien n'est alors écrit.
        """
        if not self._relectures.acquire(blocking=False):
            raise TuilesOccupees()
        try:
            octets = self._lire(couche, z, x, y)
        finally:
            self._relectures.release()
        return self._garder(couche, z, x, y, octets) or octets

    def _lire(self, couche, z, x, y):
        try:
            return self.lire(couche, z, x, y)
        except TuileAbsente:
            with self._verrou:
                self._absentes[(couche, z, x, y)] = self.chrono()
            raise

    def _garder(self, couche, z, x, y, octets):
        """Écrit la tuile au stock et rend son chemin ; None s'il n'est pas disponible."""
        if not self.disponible():
            return None
        chemin = self.chemin(couche, z, x, y)
        os.makedirs(os.path.dirname(chemin), exist_ok=True)
        # D'un bloc : un fichier temporaire, renommé une fois complet. Une
        # tuile à moitié écrite serait servie telle quelle pendant 90 jours.
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(chemin))
        with os.fdopen(fd, "wb") as f:
            f.write(octets)
        os.replace(tmp, chemin)
        return chemin

    def reserver(self, couche, z, x, y):
        """Met en réserve une tuile redirigée vers l'IGN : TUILES_RESERVE_FILS
        fils la liront et la garderont. Rend vrai si elle a été mise en
        attente : zoom au plus TUILES_RESERVE_ZOOM_MAX, stock disponible,
        file pas pleine, pas déjà en attente."""
        if z > TUILES_RESERVE_ZOOM_MAX or not self.disponible():
            return False
        cle = (couche, z, x, y)
        with self._verrou:
            if (cle in self._reserve or cle in self._en_lecture
                    or len(self._reserve) >= TUILES_RESERVE_FILE):
                return False
            self._reserve[cle] = None
            if self._lecteurs < TUILES_RESERVE_FILS:
                self._lecteurs += 1
                threading.Thread(target=self._lire_reserve, name="reserve-tuiles", daemon=True).start()
        return True

    def _lire_reserve(self):
        """Fil de la réserve : lit les tuiles en attente une à une, et
        s'arrête quand il n'y en a plus. Une lecture en échec n'est pas
        reprise, et vide la file : l'IGN est en panne ou nous refuse, ce
        n'est pas le moment de lui en demander d'autres. Chaque tuile sera
        remise en réserve à sa prochaine demande."""
        while True:
            with self._verrou:
                if not self._reserve:
                    self._lecteurs -= 1
                    self._reserve_vide.notify_all()
                    return
                cle = next(iter(self._reserve))
                del self._reserve[cle]
                self._en_lecture.add(cle)
            try:
                if not (self.present(*cle) or self.absente(*cle)):
                    self._garder(*cle, self._lire(*cle))
            except TuileAbsente:
                pass
            except Exception as exc:          # une tuile manquée, pas le service
                with self._verrou:
                    abandonnees = len(self._reserve)
                    self._reserve.clear()
                journal.info("Tuile %s non mise en réserve (%s) : %d autre(s) abandonnée(s)",
                             "/".join(map(str, cle)), exc, abandonnees)
            finally:
                with self._verrou:
                    self._en_lecture.discard(cle)

    def attendre_reserve(self, delai_s=10):
        """Attend que la réserve soit lue (pour les essais) ; rend vrai si c'est le cas."""
        with self._reserve_vide:
            return self._reserve_vide.wait_for(lambda: not self._lecteurs, delai_s)

    def purger(self):
        """Efface les tuiles plus vieilles que TUILES_AGE_MAX_S et les
        dossiers vides qu'elles laissent ; rend le nombre de tuiles effacées."""
        limite = self.horloge() - TUILES_AGE_MAX_S
        effacees = 0
        for racine, dossiers, fichiers in os.walk(self.dossier, topdown=False):
            for nom in fichiers:
                chemin = os.path.join(racine, nom)
                try:
                    vieille = os.path.getmtime(chemin) < limite
                except OSError:
                    continue
                if vieille and self._effacer(chemin):
                    effacees += 1
            if racine != self.dossier:
                try:
                    os.rmdir(racine)            # seulement s'il est vide
                except OSError:
                    pass
        with self._verrou:
            limite = self.chrono() - TUILES_ABSENTE_S
            for cle in [c for c, t in self._absentes.items() if t <= limite]:
                del self._absentes[cle]
        if effacees:
            journal.info("Tuiles : %d tuile(s) de plus de %d jours effacée(s)",
                         effacees, TUILES_AGE_MAX_S // 86400)
        return effacees

    def purger_si_du(self):
        """Lance une purge en tâche de fond si la dernière date de plus de
        TUILES_PURGE_S — la première fois, dès la première tuile demandée.
        Rend le fil lancé, ou None."""
        with self._verrou:
            maintenant = self.chrono()
            if (self._derniere_purge is not None
                    and maintenant - self._derniere_purge < TUILES_PURGE_S):
                return None
            self._derniere_purge = maintenant
        fil = threading.Thread(target=self.purger, name="purge-tuiles", daemon=True)
        fil.start()
        return fil

    @staticmethod
    def _effacer(chemin):
        try:
            os.remove(chemin)
            return True
        except OSError:
            return False
