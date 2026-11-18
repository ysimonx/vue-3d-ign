"""Accès aux services de la Géoplateforme IGN, avec reprise sur incident.

Le service tombe régulièrement en délai d'attente, et d'autant plus qu'on lui
demande de gros rasters : la construction d'une scène lui réclame une
grille de 2 048 pixels de côté, une orthophoto de même taille et une mosaïque.
Constaté en traitant plusieurs centaines de sites d'affilée : des « Read timed
out » isolés, dont un qui avait privé une scène de son orthophoto — donc d'une
végétation correctement classée — et l'avait figée ainsi dans le cache.

Ses refus sont sporadiques eux aussi, ce qui est contre-intuitif : une requête
de relief rejetée en 400 pendant un traitement par lots a été rejouée telle quelle six
fois de suite, six fois en 200. D'où la reprise sur TOUT échec, refus compris,
et non sur les seules erreurs de transport. Ces lectures sont des GET
idempotents sur des URL dont la forme est vérifiée par ailleurs : réessayer ne
coûte qu'un aller-retour, publier une scène amputée coûte bien plus.

Chaque requête prend une place (`place()`) : GEOPF_SIMULTANEES pour tout le
processus. Les lectures lancées ensemble forment un `Groupe` : dès que
l'une échoue, les autres ne partent plus et ne réessaient plus.
"""

import concurrent.futures
import contextlib
import contextvars
import threading
import time

import requests

# Deux essais de plus, espacés : au-delà on s'acharne sur un service qui a
# manifestement un problème, et l'appelant réessaiera plus tard.
GEOPF_ESSAIS = 3
GEOPF_ATTENTE_S = 3

# Requêtes simultanées vers la Géoplateforme, pour tout le processus : les
# lectures d'une scène, celles d'une autre construite en même temps, les
# ouvrages et l'orthophoto des véhicules lus en tâche de fond se partagent ces
# places. Mesuré le 1er octobre 2026 sur les 16 requêtes d'une zone de
# 1 000 m à Gordes, les plus longues lancées d'abord, médianes de 4 tours :
# 10,7 s une à une, 2,7 s à 4 à la fois, 2,9 s à 8, 3,4 s à 16. Une scène
# ne gagne rien au-delà de 4 : il reste la plus longue requête, l'orthophoto
# que le serveur met 1,5 à 3,5 s à rendre. Deux scènes à la fois (32
# requêtes, 5 tours) : 4,6 s à 8, 3,6 s à 16, 4,1 s à 32. 8 laisse de la
# marge aux couches lues en tâche de fond sans charger un service public.
#
# Les refus sporadiques (400 « LayerNotDefined » d'un serveur qui ne connaît
# pas la couche, 502) ne touchent que le WMS, et pas davantage en parallèle :
# 15 % des requêtes WMS une à une (39 sur 264), 12 % à 4 à 32 à la fois (75
# sur 612), sans reprise. get_avec_reprise les absorbe ; en parallèle, leurs
# attentes se recouvrent au lieu de s'additionner.
#
# Les lectures de fond (ouvrages, orthophoto à 0,2 m des détections, ses six
# tuiles en zone de 1 000 m) partent juste avant celles de la scène et
# partagent ces places sans priorité : elles ne la ralentissent pas de façon
# mesurable. Le 2 octobre 2026 à Gordes, zone de 1 000 m, réseau réel,
# essais alternés, médianes [quartiles] : lectures de la scène 2,91 s
# [2,82 ; 3,01] avec l'orthophoto lue à côté, 2,96 s seule (14 et 6
# essais). Une borne de 4 places pour le fond, essayée : scène 3,00 s [2,84 ;
# 3,56], orthophoto +0,7 s, ouvrages lus à côté d'elle +1,7 s ; écartée. Une
# première série, sur une machine plus chargée, montrait l'effet inverse
# (3,20 s sans borne, 2,92 s avec) : l'écart est dans le bruit.
GEOPF_SIMULTANEES = 8


class LectureAbandonnee(requests.RequestException):
    """Une lecture qui ne part pas, ou ne réessaie pas : son groupe a été
    abandonné (`Groupe.abandonner`), personne n'attend plus son résultat."""


# Le groupe de la lecture en cours dans ce fil, posé par `Groupe.soumettre` :
# `place()` et `get_avec_reprise` le consultent sans qu'on ait à le passer à
# travers fetch_*, lire_couche et leurs lectures imbriquées.
_groupe = contextvars.ContextVar("geopf_groupe", default=None)


class Groupe:
    """Des lectures lancées ensemble, dont l'appelant attend tous les
    résultats : celles d'une scène, les quarts d'une couche WFS, le MNS et le
    MNT du repli, le terrain lu d'avance.

    Abandonné, un groupe ne lance plus rien : ses lectures qui attendent une
    place la quittent, celles en cours ne réessaient plus, toutes en levant
    LectureAbandonnee. Une lecture en échec abandonne d'elle-même son
    groupe, depuis son fil, dès que l'échec sort d'elle : avant que son
    futur ne se termine, donc avant que l'appelant ne le sache. Un groupe
    imbriqué est abandonné avec celui qui le contient, pas l'inverse : un
    quart en échec n'arrête que les autres quarts, le MNS du repli en échec
    que le MNT, et l'appelant décide comme avant (la couche échoue, la
    grille LiDAR est gardée).

    `cause` garde le premier échec : les lectures abandonnées à cause de lui
    peuvent finir avant lui, et c'est lui qu'il faut rapporter, pas « lecture
    abandonnée ».

    Un groupe n'est abandonné que quand plus rien de ce qu'il lit ne sera
    utilisé — la scène échoue, `en_parallele` lève, le terrain lu d'avance
    n'est pas de la bonne source — : l'abandon ne change aucun résultat
    rendu, il épargne des requêtes.
    """

    def __init__(self, parent=None):
        self.parent = parent
        self.cause = None
        self._verrou = threading.Lock()
        self._abandonne = threading.Event()

    def abandonner(self, cause=None):
        """`cause` : l'échec qui l'abandonne ; seul le premier est gardé,
        avant que quiconque puisse voir le groupe abandonné."""
        with self._verrou:
            if self.cause is None:
                self.cause = cause
        self._abandonne.set()
        _places.reveiller()

    def abandonne(self):
        return self._abandonne.is_set() or (self.parent is not None and self.parent.abandonne())

    def verifier(self):
        """Lève LectureAbandonnee si le groupe, ou l'un de ceux qui le
        contiennent, est abandonné."""
        if self.abandonne():
            raise LectureAbandonnee("lecture abandonnée : une autre lecture de son groupe a échoué")

    def soumettre(self, bassin, lecture, *args):
        """`bassin.submit(lecture, *args)`, la lecture rattachée au groupe,
        et avec elle celles qu'elle lance par `en_parallele`."""
        contexte = contextvars.copy_context()
        contexte.run(_groupe.set, self)
        return bassin.submit(contexte.run, self._lancer, lecture, *args)

    def _lancer(self, lecture, *args):
        try:
            return lecture(*args)
        except BaseException as exc:
            self.abandonner(exc)
            raise


class _Places:
    """Les GEOPF_SIMULTANEES places du processus. Une condition plutôt
    qu'un sémaphore : une lecture abandonnée quitte la file aussitôt, au
    lieu d'attendre une place pour la rendre."""

    def __init__(self, toutes):
        self._condition = threading.Condition()
        self._libres = toutes

    def prendre(self, groupe):
        with self._condition:
            while True:
                if groupe is not None:
                    groupe.verifier()
                if self._libres:
                    break
                self._condition.wait()
            self._libres -= 1

    def rendre(self):
        with self._condition:
            self._libres += 1
            self._condition.notify_all()

    def reveiller(self):
        """Les lectures en attente revérifient leur groupe."""
        with self._condition:
            self._condition.notify_all()


_places = _Places(GEOPF_SIMULTANEES)


@contextlib.contextmanager
def place():
    """Une des GEOPF_SIMULTANEES places, le temps d'une requête et de ses
    reprises. À prendre autour de `get_avec_reprise` seulement, jamais autour
    d'une attente sur d'autres lectures : un fil qui garde sa place en
    attendant celles qu'il a lancées peut bloquer tout le processus.

    Raises:
        LectureAbandonnee si le groupe de la lecture est abandonné avant
        qu'elle ait sa place.
    """
    # Une requête en échec n'abandonne pas le groupe ici : la lecture peut
    # s'en remettre. C'est la lecture entière qui, en échouant, l'abandonne
    # (Groupe._lancer). Entre la place rendue et cet abandon — la fin de la
    # lecture en échec, contrôles de sa réponse compris (image, BIL, JSON) —,
    # une lecture en attente peut encore prendre la place et partir.
    places = _places                            # rendue là où elle a été prise
    places.prendre(_groupe.get())
    try:
        yield
    finally:
        places.rendre()


def en_parallele(*lectures):
    """Résultats de lectures (fonctions sans argument) lancées ensemble, dans
    l'ordre où elles sont données.

    Un fil par lecture : elles attendent le réseau, pas un cœur, et c'est
    `place()` qui borne les requêtes. Des fils neufs plutôt qu'un bassin
    partagé : une lecture peut en lancer d'autres (les quarts d'une couche
    WFS), qui n'ont pas à attendre qu'un fil du même bassin se libère. Elles
    forment un groupe, dans celui de l'appelant s'il en a un.

    Raises:
        l'exception de la première lecture en échec, dès qu'elle échoue :
        les autres sont abandonnées — celles qui attendent une place ne
        partent plus, celles déjà parties finissent sans que personne ne
        les attende ni ne les réessaie.
    """
    if len(lectures) <= 1:
        return [lecture() for lecture in lectures]
    groupe = Groupe(_groupe.get())
    bassin = concurrent.futures.ThreadPoolExecutor(max_workers=len(lectures),
                                                   thread_name_prefix="geopf")
    try:
        futurs = [groupe.soumettre(bassin, lecture) for lecture in lectures]
        faits, _ = concurrent.futures.wait(futurs, return_when=concurrent.futures.FIRST_EXCEPTION)
        for futur in futurs:
            if futur in faits and futur.exception() is not None:
                exc = futur.exception()
                if isinstance(exc, LectureAbandonnee) and groupe.cause is not None:
                    # Abandonnée parce qu'une voisine a échoué, et finie
                    # avant elle : c'est l'échec de la voisine qui compte.
                    exc = groupe.cause
                raise exc
        return [futur.result() for futur in futurs]
    except BaseException as exc:
        groupe.abandonner(exc)
        raise
    finally:
        bassin.shutdown(wait=False, cancel_futures=True)


def _page_de_mesures(reponse):
    """La réponse est la page des compteurs d'un serveur Java (exportateur
    JMX de Prometheus : fils, mémoire, requêtes de Tomcat), pas celle qu'on a
    demandée.

    Le WFS de la Géoplateforme la sert en 200, au lieu de la réponse, à une
    requête sur 6 à 40 le 18 novembre 2026 (10 sur 121, mesuré à Haguenau sur
    trois couches BD TOPO ; 0 sur 20 au WMS) : 116 couches illisibles dans le
    journal ce jour-là, de 1 à 6 les jours d'avant, et des scènes refusées à
    la chaîne. Rejouée à l'identique, la même requête rend son GeoJSON.
    Reconnue à son type, celui du format texte de Prometheus.
    """
    # Les doublures des tests n'ont pas toutes d'en-têtes.
    type_ = getattr(reponse, "headers", {}).get("Content-Type", "")
    return type_.startswith("text/plain") and "version=0.0.4" in type_


def get_avec_reprise(url, timeout=30, essais=GEOPF_ESSAIS, attente=GEOPF_ATTENTE_S,
                     headers=None):
    """GET sur la Géoplateforme, en réessayant les incidents de transport.

    Une lecture dont le groupe est abandonné ne réessaie pas : pendant une
    panne, chaque essai peut tenir sa place 30 s. `headers` : en-têtes de la
    requête, la plage d'octets d'une dalle LiDAR (vue3d/nuage.py).

    Raises:
        requests.RequestException si tous les essais échouent ;
        LectureAbandonnee si le groupe est abandonné entre deux essais.
    """
    groupe = _groupe.get()
    dernier = None
    for essai in range(essais):
        if essai:
            if groupe is not None:
                groupe.verifier()
            time.sleep(attente)
            if groupe is not None:
                groupe.verifier()
        try:
            reponse = (requests.get(url, timeout=timeout, headers=headers) if headers
                       else requests.get(url, timeout=timeout))
        except requests.RequestException as exc:
            dernier = exc
        else:
            if reponse.ok and _page_de_mesures(reponse):
                # Un incident de transport comme un autre : rejouée telle
                # quelle, la requête répond normalement (voir _page_de_mesures).
                dernier = requests.RequestException(
                    f"page de mesures du serveur au lieu de la réponse sur {url[:80]}",
                    response=reponse)
                continue
            if reponse.ok:
                return reponse
            # La réponse jointe : une tuile WMTS hors couverture répond 404,
            # un fait que l'appelant distingue d'un incident (vue3d/tuiles.py).
            dernier = requests.RequestException(
                f"HTTP {reponse.status_code} sur {url[:80]}", response=reponse)
    raise dernier
