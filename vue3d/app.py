"""Serveur de la vue 3D.

    GET /                          la page ; `?lat=…&lon=…` pour viser un point
                                   et `&zone=…` pour le côté de la zone, en mètres
    GET /api/scene?lat=…&lon=…     la scène, JSON gzippé (construite au besoin)
    GET /api/ortho?lat=…&lon=…     l'orthophoto de la scène, en JPEG
    GET /api/monuments?lat=…&lon=…   la couche des monuments OSM, JSON gzippé
    GET /api/ouvrages?lat=…&lon=…    la couche des ouvrages BD TOPO, JSON gzippé
    GET /api/nuage?lat=…&lon=…       le bâti du nuage LiDAR HD, JSON gzippé
    GET /api/piscines?lat=…&lon=…    les piscines de l'orthophoto, si le service a un détecteur
    GET /api/vehicules?lat=…&lon=…&detecteur=…   les véhicules vus d'un détecteur du service
    GET /api/panneaux?lat=…&lon=…    les panneaux solaires du registre, si le service en a un
    GET /api/dpe?lat=…&lon=…         les DPE de l'ADEME, à la demande de la page seulement
    GET /api/dvf?lat=…&lon=…         les ventes DVF des parcelles, de même
    GET /api/avancement?lat=…&lon=…  l'étape de la construction en cours
    GET /api/sante                 contrôle de vie, pour Docker

Chaque route d'API accepte `zone=` (150 à 1 000 m, arrondie à 50 m) : sans
elle, l'emprise par défaut d'environ 356 m.

La première demande d'un point construit sa scène : une vingtaine à une
trentaine de secondes, que la page annonce. Les suivantes la lisent sur disque.
"""

import logging
import os

from flask import Flask, jsonify, request, send_from_directory

from .dpe import fetch_dpe
from .dvf import fetch_dvf
from .monuments import fetch_monuments
from .nuage import fetch_nuage
from .ouvrages import fetch_ouvrages
from .panneaux import REGISTRE_LICENCE
from .panneaux import lecteur as lecteur_panneaux
from .scene import (NOM_DPE, NOM_DVF, NOM_MONUMENTS, NOM_NUAGE, NOM_ORTHO, NOM_OUVRAGES,
                    NOM_PANNEAUX, NOM_SCENE, Cache, DpeIndisponibles, DvfIndisponible,
                    HorsEmprise, MonumentsIndisponibles, NuageIndisponible,
                    OuvragesIndisponibles,
                    PanneauxIndisponibles, ReconstructionRefusee, SceneIncomplete,
                    VehiculesDesactives, VehiculesIndisponibles, zone_normalisee)
from .scene import construire as construire_scene
from .toits import autoriser_bassin
from .vehicules import MODE_PAR_DEFAUT
from .vehicules import lecteur as lecteur_vehicules

# Noms de couche pour dossier_scene : les fichiers, eux, dépendent du mode et
# du détecteur.
COUCHE_VEHICULES = "vehicules"
COUCHE_PISCINES = "piscines"

logging.basicConfig(level=os.environ.get("VUE3D_LOG", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s : %(message)s")

ICI = os.path.dirname(os.path.abspath(__file__))


def creer_app(dossier_cache=None, construire=construire_scene, lire_monuments=fetch_monuments,
              lire_ouvrages=fetch_ouvrages, lire_vehicules=None, lire_panneaux=None,
              lire_nuage=fetch_nuage, lire_dpe=fetch_dpe, lire_dvf=fetch_dvf):
    """`construire`, `lire_monuments`, `lire_ouvrages`, `lire_vehicules`,
    `lire_panneaux`, `lire_nuage`, `lire_dpe` et `lire_dvf` sont injectables
    pour les tests, qui n'appellent ni l'IGN, ni Overpass, ni l'ADEME, ni
    data.gouv, et ne chargent aucun réseau ni registre. `lire_vehicules` :
    de `vehicules.lecteur()` ; None, le service n'a ni véhicules ni piscines.
    `lire_panneaux` : de `panneaux.lecteur()` ; None, pas de panneaux."""
    app = Flask(__name__, static_folder=os.path.join(ICI, "static"), static_url_path="/static")
    # Absolu : send_from_directory résout un chemin relatif depuis le dossier
    # de l'application, pas depuis le répertoire courant — avec
    # VUE3D_CACHE=./cache, l'orthophoto répondait 404.
    cache = Cache(os.path.abspath(dossier_cache or os.environ.get("VUE3D_CACHE", "/tmp/vue3d-cache")),
                  lire_monuments=lire_monuments, lire_ouvrages=lire_ouvrages,
                  lire_vehicules=lire_vehicules, lire_panneaux=lire_panneaux,
                  lire_nuage=lire_nuage, lire_dpe=lire_dpe, lire_dvf=lire_dvf)

    def point():
        """(lat, lon, zone) de la requête ; None si l'un d'eux est illisible."""
        try:
            return (float(request.args["lat"]), float(request.args["lon"]),
                    zone_normalisee(request.args.get("zone")))
        except (KeyError, ValueError):
            return None

    MESSAGE_POINT = ("Paramètres lat et lon attendus, en degrés décimaux ; zone, "
                     "facultative, en mètres.")

    def erreur(code, message):
        return jsonify({"erreur": message}), code

    def dossier_scene(couche=None, prelire=False, detecteur=None):
        p = point()
        if p is None:
            return None, erreur(400, MESSAGE_POINT)
        *p, zone = p
        try:
            if couche == NOM_MONUMENTS:
                return cache.obtenir_monuments(*p, construire=construire, zone=zone), None
            if couche == NOM_OUVRAGES:
                return cache.obtenir_ouvrages(*p, construire=construire, zone=zone), None
            if couche == NOM_NUAGE:
                return cache.obtenir_nuage(*p, construire=construire, zone=zone), None
            if couche == NOM_DPE:
                return cache.obtenir_dpe(*p, construire=construire, zone=zone), None
            if couche == NOM_DVF:
                return cache.obtenir_dvf(*p, construire=construire, zone=zone), None
            if couche == COUCHE_PISCINES:
                return cache.obtenir_piscines(*p, construire=construire, zone=zone), None
            if couche == NOM_PANNEAUX:
                return cache.obtenir_panneaux(*p, construire=construire, zone=zone), None
            if couche == COUCHE_VEHICULES:
                return cache.obtenir_vehicules(*p, detecteur, construire=construire,
                                              zone=zone), None
            if prelire:
                # Les couches à part d'abord, en tâche de fond : leurs sources
                # répondent pendant que la scène se construit, et elles sont
                # souvent prêtes quand la page les demande.
                cache.prelire_monuments(*p, zone=zone)
                cache.prelire_ouvrages(*p, zone=zone)
                cache.prelire_vehicules(*p, zone=zone)
                cache.prelire_panneaux(*p, zone=zone)
            return cache.obtenir(*p, construire=construire, zone=zone), None
        except HorsEmprise as exc:
            return None, erreur(422, str(exc))
        except SceneIncomplete as exc:
            # Rien n'a été mis en cache : la prochaine demande réessaiera.
            app.logger.warning("Scène incomplète pour %s : %s", p, exc)
            return None, erreur(503, "Un service de l'IGN n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except MonumentsIndisponibles as exc:
            app.logger.warning("Monuments OSM indisponibles pour %s : %s", p, exc)
            return None, erreur(503, "OpenStreetMap n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except OuvragesIndisponibles as exc:
            app.logger.warning("Ouvrages indisponibles pour %s : %s", p, exc)
            return None, erreur(503, "Un service de l'IGN n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except NuageIndisponible as exc:
            app.logger.warning("Nuage LiDAR HD indisponible pour %s : %s", p, exc)
            return None, erreur(503, "Un service de l'IGN n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except VehiculesIndisponibles as exc:
            app.logger.warning("Détection indisponible pour %s : %s", p, exc)
            return None, erreur(503, "La détection sur l'orthophoto n'a pas abouti ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except DpeIndisponibles as exc:
            app.logger.warning("DPE indisponibles pour %s : %s", p, exc)
            return None, erreur(503, "L'API des DPE de l'ADEME n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except DvfIndisponible as exc:
            app.logger.warning("DVF indisponible pour %s : %s", p, exc)
            return None, erreur(503, "Le cadastre ou les fichiers DVF n'ont pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except PanneauxIndisponibles as exc:
            app.logger.warning("Panneaux indisponibles pour %s : %s", p, exc)
            return None, erreur(503, f"Le registre des panneaux solaires n'a pas pu être lu ({exc}). "
                                "Rien n'a été mis en cache : réessayez dans quelques instants.")
        except VehiculesDesactives as exc:
            return None, erreur(400, f"{exc} : détecteurs de ce service : "
                                f"{', '.join(cache.lire_vehicules.detecteurs) or 'aucun'}.")

    # Tout ce qui sort du dossier d'une scène est revalidé à chaque demande :
    # une scène et ses couches peuvent être reconstruites sous la même adresse
    # (Cache.reconstruire), et une couche change avec le détecteur du service
    # et avec sa version. Gardée un jour par le navigateur, la scène
    # reconstruite n'apparaissait pas, et la couche des véhicules montrait
    # encore les véhicules sans les piscines après une reconstruction de
    # l'image. Le validateur est le fichier lui-même, son nom et l'instant de
    # son écriture : un 304 sans corps tant qu'il n'a pas été réécrit.
    def validateur(chemin):
        etat = os.stat(chemin)
        return f"{os.path.basename(chemin)}-{etat.st_mtime_ns}-{etat.st_size}"

    def servir_gzip(dossier, nom):
        chemin = os.path.join(dossier, nom)
        etag = validateur(chemin)
        if request.if_none_match.contains(etag):
            reponse = app.response_class(status=304)
        else:
            with open(chemin, "rb") as f:
                charge = f.read()
            # Déjà gzippé : annoncé tel quel, le navigateur le décompresse.
            reponse = app.response_class(charge, mimetype="application/json")
            reponse.headers["Content-Encoding"] = "gzip"
        reponse.set_etag(etag)
        reponse.headers["Cache-Control"] = "no-cache"
        return reponse

    @app.get("/")
    def page():
        return send_from_directory(app.static_folder, "index.html")

    @app.get("/api/scene")
    def scene():
        dossier, err = dossier_scene(prelire=True)
        if err:
            return err
        return servir_gzip(dossier, NOM_SCENE)

    @app.get("/api/monuments")
    def monuments():
        """La couche OSM, demandée par la page une fois la scène affichée :
        `null` quand l'emprise n'a aucune partie, le cas de presque partout."""
        dossier, err = dossier_scene(couche=NOM_MONUMENTS)
        if err:
            return err
        return servir_gzip(dossier, NOM_MONUMENTS)

    @app.get("/api/ouvrages")
    def ouvrages():
        """Murs, ponts, voies ferrées et terrains de sport, demandés par la
        page une fois la scène affichée : `null` quand l'emprise n'en a aucun."""
        dossier, err = dossier_scene(couche=NOM_OUVRAGES)
        if err:
            return err
        return servir_gzip(dossier, NOM_OUVRAGES)

    @app.get("/api/nuage")
    def nuage():
        """Le bâti du nuage LiDAR HD, demandé par la page une fois la scène
        affichée : `null` hors couverture LiDAR HD ou sans relief."""
        dossier, err = dossier_scene(couche=NOM_NUAGE)
        if err:
            return err
        return servir_gzip(dossier, NOM_NUAGE)

    def sans_detecteur(**vide):
        """Réponse des couches de l'orthophoto quand le service n'a pas de
        détecteur : le mode, que la page lit, et rien à dessiner. Ce n'est
        pas une erreur. Jamais gardée : le service peut être relancé avec un
        détecteur."""
        reponse = jsonify({"mode": MODE_PAR_DEFAUT, **vide})
        reponse.headers["Cache-Control"] = "no-store"
        return reponse

    @app.get("/api/piscines")
    def piscines():
        """Les piscines de l'orthophoto, demandées par la page une fois la
        scène affichée : une demi-seconde de détection, la première couche
        prête."""
        if not cache.lire_vehicules:
            return sans_detecteur(piscines=[])
        trouve, err = dossier_scene(couche=COUCHE_PISCINES)
        if err:
            return err
        return servir_gzip(*trouve)

    @app.get("/api/vehicules")
    def vehicules():
        """Les véhicules vus d'un détecteur (`detecteur=`), demandés par la
        page dans l'ordre que /api/sante lui donne, du rapide au lent : elle
        les réunit à mesure. Sans le paramètre, ou avec un détecteur que le
        service n'a pas : 400."""
        if not cache.lire_vehicules:
            return sans_detecteur(detecteur=None, vehicules=[])
        detecteur = request.args.get("detecteur")
        if not detecteur:
            return erreur(400, "Paramètre detecteur attendu : "
                          f"{', '.join(cache.lire_vehicules.detecteurs)}.")
        trouve, err = dossier_scene(couche=COUCHE_VEHICULES, detecteur=detecteur)
        if err:
            return err
        return servir_gzip(*trouve)

    @app.get("/api/panneaux")
    def panneaux():
        """Les panneaux solaires du registre OpenPVMapper, demandés par la
        page une fois la scène affichée. Sans registre, la réponse le dit
        (`actif: false`) : ce n'est pas une erreur."""
        if not cache.lire_panneaux:
            reponse = jsonify({"actif": False, "panneaux": []})
            reponse.headers["Cache-Control"] = "no-store"
            return reponse
        dossier, err = dossier_scene(couche=NOM_PANNEAUX)
        if err:
            return err
        return servir_gzip(dossier, NOM_PANNEAUX)

    @app.get("/api/dpe")
    def dpe():
        """Les DPE de l'ADEME autour du point, rattachés aux bâtiments :
        demandés par la page au clic sur leur bouton, jamais d'office."""
        dossier, err = dossier_scene(couche=NOM_DPE)
        if err:
            return err
        return servir_gzip(dossier, NOM_DPE)

    @app.get("/api/dvf")
    def dvf():
        """Les ventes DVF des parcelles autour du point : au clic, comme les
        DPE. Sans DVF ici (Alsace-Moselle), la couche le dit (`absent`)."""
        dossier, err = dossier_scene(couche=NOM_DVF)
        if err:
            return err
        return servir_gzip(dossier, NOM_DVF)

    @app.get("/api/ortho")
    def ortho():
        dossier, err = dossier_scene()
        if err:
            return err
        # Revalidée comme la scène (servir_gzip) : send_from_directory donne
        # déjà son validateur, tiré de l'instant d'écriture du fichier.
        reponse = send_from_directory(dossier, NOM_ORTHO, mimetype="image/jpeg")
        reponse.headers["Cache-Control"] = "no-cache"
        return reponse

    @app.post("/api/reconstruire")
    def reconstruire():
        """Le bouton « Reconstruire la scène » de la page : la scène et ses
        couches sont mises de côté, et la page, rechargée, les reconstruit
        d'après les données de l'IGN du moment (Cache.reconstruire)."""
        p = point()
        if p is None:
            return erreur(400, MESSAGE_POINT)
        *p, zone = p
        try:
            cache.reconstruire(*p, zone=zone)
        except HorsEmprise as exc:
            return erreur(422, str(exc))
        except ReconstructionRefusee as exc:
            return erreur(exc.code, f"Reconstruction refusée : {exc}.")
        reponse = jsonify({"etat": "a_reconstruire"})
        reponse.headers["Cache-Control"] = "no-store"
        return reponse, 202

    @app.get("/api/avancement")
    def avancement():
        """Pour la page qui attend sa scène : jamais mis en cache, il change
        d'une seconde à l'autre."""
        p = point()
        if p is None:
            return erreur(400, MESSAGE_POINT)
        try:
            reponse = jsonify(cache.avancement(*p))
        except HorsEmprise as exc:
            return erreur(422, str(exc))
        reponse.headers["Cache-Control"] = "no-store"
        return reponse

    @app.get("/api/sante")
    def sante():
        """Contrôle de vie, et ce que le service sait détecter sur
        l'orthophoto : la page y lit les détecteurs à demander, dans
        l'ordre."""
        lecteur = cache.lire_vehicules
        reponse = jsonify({"ok": True, "vehicules": {
            "mode": lecteur.mode if lecteur else MODE_PAR_DEFAUT,
            "detecteurs": list(lecteur.detecteurs) if lecteur else []},
            "panneaux": {"actif": bool(cache.lire_panneaux),
                         "source": REGISTRE_LICENCE if cache.lire_panneaux else None}})
        reponse.headers["Cache-Control"] = "no-store"
        return reponse

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
