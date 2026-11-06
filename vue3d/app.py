"""Serveur de la vue 3D : l'application Flask et l'état du service.

Les routes sont rangées par page, chacune dans son blueprint :

    vue3d/routes/scene.py     /, /api/scene et les couches d'un point (ortho,
                              monuments, ouvrages, nuage, détections, panneaux,
                              DPE, DVF, bornes), /api/avancement, /api/reconstruire,
                              /api/avis
    vue3d/routes/voiture.py   /voiture, ses carrés (/api/carre, /api/vegetation,
                              /api/vitesses, /api/signalisation), /api/bornes-bloc,
                              /api/signalement
    vue3d/routes/service.py   ce que les deux pages partagent : /api/tuile,
                              /api/sante

La première demande d'un point construit sa scène : une vingtaine à une
trentaine de secondes, que la page annonce. Les suivantes la lisent sur disque.
Avec `VUE3D_QUOTA`, une même adresse IP n'en fait construire qu'autant par
heure (429 au-delà), et pas plus de CARRES_PAR_HEURE carrés neufs ; derrière
un proxy, `VUE3D_PROXY` dit combien croire de `X-Forwarded-For`.
"""

import functools
import logging
import math
import os
import threading
import time

from flask import Flask
from werkzeug.middleware.proxy_fix import ProxyFix

from .bornes import BLOCS_PAR_HEURE, BlocsBornes, fetch_bornes
from .carres import (CARRES_PAR_HEURE, VEGETATION_VERSION, CarreIndisponible, Carres, fetch_carre,
                     fetch_vegetation)
from .dpe import fetch_dpe
from .dvf import fetch_dvf
from .monuments import attente_overpass, fetch_monuments
from .nuage import fetch_nuage
from .ouvrages import fetch_ouvrages
from .panneaux import lecteur as lecteur_panneaux
from .routes import scene as routes_scene
from .routes import service as routes_service
from .routes import voiture as routes_voiture
from .scene import Cache
from .scene import construire as construire_scene
from .avis import AVIS_PAR_HEURE, Avis
from .signalements import SIGNALEMENTS_PAR_HEURE, Signalements
from .signalisation import SIGNALISATION_VERSION, BlocsSignaux, fetch_signalisation
from .solaire import fetch_solaire
from .toits import autoriser_bassin
from .tuiles import TUILES_RELECTURES_PAR_HEURE, Stock, fetch_tuile
from .vehicules import fetch_mer
from .vehicules import lecteur as lecteur_vehicules
from .vitesses import VITESSES_VERSION, BlocsOsm, fetch_vitesses

logging.basicConfig(level=os.environ.get("VUE3D_LOG", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s : %(message)s")

ICI = os.path.dirname(os.path.abspath(__file__))


def entier_env(nom):
    """La variable `nom`, entier positif ou nul ; 0 si elle est absente."""
    valeur = os.environ.get(nom, "").strip()
    try:
        n = int(valeur or 0)
    except ValueError:
        n = -1
    if n < 0:
        raise ValueError(f"{nom}={valeur!r} : attendu un entier positif ou nul.")
    return n


class Quota:
    """Scènes neuves construites pour une même adresse IP, sur une heure
    glissante. Une scène neuve coûte une trentaine de requêtes à la
    Géoplateforme (Cache.RECONSTRUIRE_APRES_S), qui limite l'adresse du
    serveur, pas celle du visiteur : sans quota, un seul visiteur qui
    enchaîne les lieux ferait attendre tous les autres. Une scène en cache ne
    coûte rien et n'est jamais comptée. Tenu en mémoire : un redémarrage du
    service le remet à zéro.

    Il compte des scènes, pas des requêtes : une page qui ouvre un lieu neuf
    demande en même temps la scène, l'orthophoto et les couches du même
    point, toutes avant que la scène n'existe."""

    FENETRE_S = 3600

    def __init__(self, par_heure, horloge=time.monotonic):
        self.par_heure = par_heure
        self.horloge = horloge
        self._scenes = {}           # adresse -> {clé de scène: instant où elle a été comptée}
        self._verrou = threading.Lock()
        self._balayage = horloge()

    def attente(self, adresse, cle, compter=True):
        """0 si la scène `cle` peut être construite pour `adresse` — elle est
        alors comptée, sauf `compter=False` ; sinon, les secondes avant
        qu'une place se libère."""
        maintenant = self.horloge()
        limite = maintenant - self.FENETRE_S
        with self._verrou:
            if self._balayage <= limite:
                # Une adresse muette depuis une heure ne garde rien en mémoire.
                for a in [a for a, s in self._scenes.items()
                          if not s or max(s.values()) <= limite]:
                    del self._scenes[a]
                self._balayage = maintenant
            scenes = self._scenes.setdefault(adresse, {})
            for c in [c for c, t in scenes.items() if t <= limite]:
                del scenes[c]
            if cle in scenes:
                return 0
            if len(scenes) >= self.par_heure:
                return math.ceil(min(scenes.values()) - limite)
            if compter:
                scenes[cle] = maintenant
            return 0


def creer_app(dossier_cache=None, construire=construire_scene, lire_monuments=fetch_monuments,
              lire_ouvrages=fetch_ouvrages, lire_vehicules=None, lire_panneaux=None,
              lire_nuage=fetch_nuage, lire_dpe=fetch_dpe, lire_dvf=fetch_dvf, lire_mer=fetch_mer,
              lire_tuile=fetch_tuile, quota=None, proxy=None, relectures=None,
              lire_bornes=fetch_bornes, lire_carre=fetch_carre, quota_carres=None,
              lire_vegetation=fetch_vegetation, lire_vitesses=None, lire_signalisation=None,
              lire_solaire=fetch_solaire):
    """`construire`, `lire_monuments`, `lire_ouvrages`, `lire_vehicules`,
    `lire_panneaux`, `lire_nuage`, `lire_dpe`, `lire_dvf`, `lire_mer`,
    `lire_bornes` et `lire_solaire` sont injectables
    pour les tests, qui n'appellent ni l'IGN, ni Overpass, ni l'ADEME, ni
    data.gouv, ni PVGIS, et ne chargent aucun réseau ni registre. `lire_vehicules` :
    de `vehicules.lecteur()` ; None, le service n'a ni véhicules, ni piscines,
    ni navires.
    `lire_panneaux` : de `panneaux.lecteur()` ; None, pas de panneaux.
    `lire_tuile` : (couche, z, x, y) -> octets d'une tuile WMTS de l'IGN.
    `quota` : scènes neuves par heure et par adresse IP, 0 sans limite ;
    `proxy` : proxys devant le service, dont on croit `X-Forwarded-For`.
    None : de VUE3D_QUOTA et VUE3D_PROXY, 0 en leur absence.
    `relectures` : tuiles relues par heure et par adresse IP, 0 sans limite ;
    None : TUILES_RELECTURES_PAR_HEURE si le service a un quota de scènes.
    `lire_carre`, `lire_vegetation`, `lire_vitesses`, `lire_signalisation` :
    (i, j) -> dict d'un carré de la voiture, bâtiments et routes, arbres
    (vue3d/carres.py), limitations de vitesse (vue3d/vitesses.py) ou stops,
    cédez-le-passage et feux (vue3d/signalisation.py) ; None pour ces deux
    derniers : lus à Overpass, par bloc gardé dans le cache ;
    `quota_carres` : carrés neufs par heure et par adresse IP, 0 sans limite ;
    None : CARRES_PAR_HEURE si le service a un quota de scènes."""
    app = Flask(__name__, static_folder=os.path.join(ICI, "static"), static_url_path="/static")
    proxy = entier_env("VUE3D_PROXY") if proxy is None else proxy
    if proxy:
        # Sans cela, derrière Caddy, tous les visiteurs auraient l'adresse
        # 127.0.0.1, et un seul quota. Jamais sans proxy : un visiteur
        # changerait d'adresse à chaque requête en écrivant l'en-tête.
        app.wsgi_app = ProxyFix(app.wsgi_app, x_for=proxy)
    quota = entier_env("VUE3D_QUOTA") if quota is None else quota
    quota = Quota(quota) if quota else None
    if quota:
        app.logger.info("Quota : %d scènes neuves par heure et par adresse IP, %s",
                        quota.par_heure, f"lue dans X-Forwarded-For ({proxy} proxy)"
                        if proxy else "celle de la connexion (aucun proxy déclaré)")
    # Absolu : send_from_directory résout un chemin relatif depuis le dossier
    # de l'application, pas depuis le répertoire courant — avec
    # VUE3D_CACHE=./cache, l'orthophoto répondait 404.
    cache = Cache(os.path.abspath(dossier_cache or os.environ.get("VUE3D_CACHE", "/tmp/vue3d-cache")),
                  lire_monuments=lire_monuments, lire_ouvrages=lire_ouvrages,
                  lire_vehicules=lire_vehicules, lire_panneaux=lire_panneaux,
                  lire_nuage=lire_nuage, lire_dpe=lire_dpe, lire_dvf=lire_dvf,
                  lire_mer=lire_mer, lire_bornes=lire_bornes, lire_solaire=lire_solaire)
    # Hors du dossier des versions de scène : une tuile ne dépend pas de
    # SCENE_VERSION.
    stock = Stock(os.path.join(cache.dossier, "tuiles"), lire=lire_tuile)
    if relectures is None:
        relectures = TUILES_RELECTURES_PAR_HEURE if quota else 0
    quota_tuiles = Quota(relectures) if relectures else None
    carres = Carres(cache.dossier, lire=lire_carre)
    vegetations = Carres(cache.dossier, lire=lire_vegetation, couche="vegetation-",
                         version=VEGETATION_VERSION)
    attente = functools.partial(attente_overpass, CarreIndisponible)
    if lire_vitesses is None:
        blocs = BlocsOsm(cache.dossier)

        def lire_vitesses(i, j):
            return fetch_vitesses(i, j, blocs)
    vitesses = Carres(cache.dossier, lire=lire_vitesses, couche="vitesses-", version=VITESSES_VERSION,
                      attente=attente)
    if lire_signalisation is None:
        blocs_signaux = BlocsSignaux(cache.dossier)

        def lire_signalisation(i, j):
            return fetch_signalisation(i, j, blocs_signaux)
    signalisation = Carres(cache.dossier, lire=lire_signalisation, couche="signalisation-",
                           version=SIGNALISATION_VERSION, attente=attente)
    if quota_carres is None:
        quota_carres = CARRES_PAR_HEURE if quota else 0
    quota_carres = Quota(quota_carres) if quota_carres else None
    blocs_bornes = BlocsBornes(cache.dossier, lire=lire_bornes)
    quota_blocs = Quota(BLOCS_PAR_HEURE) if quota else None
    signalements = Signalements(os.path.join(cache.dossier, "signalements"))
    quota_signalements = Quota(SIGNALEMENTS_PAR_HEURE) if quota else None
    avis = Avis(os.path.join(cache.dossier, "avis"))
    quota_avis = Quota(AVIS_PAR_HEURE) if quota else None

    app.register_blueprint(routes_scene.blueprint(cache, construire, quota, avis, quota_avis))
    app.register_blueprint(routes_voiture.blueprint(
        carres, vegetations, vitesses, signalisation, quota_carres, blocs_bornes, quota_blocs,
        signalements, quota_signalements))
    app.register_blueprint(routes_service.blueprint(cache, stock, quota_tuiles))
    return app


# Les toitures se calculent sur un bassin de processus (vue3d/toits.py), que
# le service autorise : gunicorn et flask gardent leur script principal, que
# chaque processus du bassin réexécute. Il naît dès maintenant, dans un fil à
# part, et non à la première scène, qui le trouve prêt. Sauf dans le
# processus qui surveille les fichiers sous `flask run --debug` : le
# rechargeur de werkzeug y importe aussi ce module, sans jamais y servir de
# scène, et un second bassin y naissait (22 processus au lieu de 11,
# constaté le 2 octobre 2026). Le processus qui sert porte WERKZEUG_RUN_MAIN.
autoriser_bassin(chauffer=not (os.environ.get("FLASK_DEBUG") == "1"
                               and "WERKZEUG_RUN_MAIN" not in os.environ))

# Le détecteur de VUE3D_VEHICULES et le registre de VUE3D_PANNEAUX sont
# chargés ici, une fois : demandés sans leur réseau ou leur base, ils
# arrêtent le démarrage, avec la commande qui les produit. Sur deux lignes :
# une trace d'erreur sur la ligne commune laissait croire que les panneaux
# étaient en cause quand c'était le réseau des véhicules qui manquait.
lire_vehicules = lecteur_vehicules()
lire_panneaux = lecteur_panneaux()
app = creer_app(lire_vehicules=lire_vehicules, lire_panneaux=lire_panneaux)
