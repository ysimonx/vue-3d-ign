"""La page de la scène et ce qu'elle lit autour d'un point.

    GET /                          la page ; `?lat=…&lon=…` pour viser un point
                                   et `&zone=…` pour le côté de la zone, en mètres
    GET /api/scene?lat=…&lon=…     la scène, JSON gzippé (construite au besoin)
    GET /api/ortho?lat=…&lon=…     l'orthophoto de la scène, en JPEG
    GET /api/monuments?lat=…&lon=…   la couche des monuments OSM, JSON gzippé
    GET /api/eoliennes?lat=…&lon=…   les éoliennes OSM de l'anneau, JSON gzippé
    GET /api/ouvrages?lat=…&lon=…    la couche des ouvrages BD TOPO, JSON gzippé
    GET /api/nuage?lat=…&lon=…       le bâti du nuage LiDAR HD, JSON gzippé
                                   `&proche=1` : d'abord le carré autour du point
    GET /api/piscines?lat=…&lon=…    les piscines de l'orthophoto, si le service a un détecteur
    GET /api/navires?lat=…&lon=…     les navires de l'orthophoto, sur l'eau, de même
    GET /api/vehicules?lat=…&lon=…&detecteur=…   les véhicules vus d'un détecteur du service
    GET /api/panneaux?lat=…&lon=…    les panneaux solaires du registre, si le service en a un
    GET /api/dpe?lat=…&lon=…         les DPE de l'ADEME, à la demande de la page seulement
    GET /api/dvf?lat=…&lon=…         les ventes DVF des parcelles, de même
    GET /api/bornes?lat=…&lon=…      les bornes de recharge (IRVE, data.gouv.fr), de même
    GET /api/solaire?lat=…&lon=…     l'année type du rayonnement (PVGIS), de même
    GET /api/avancement?lat=…&lon=…  l'étape de la construction en cours
    POST /api/reconstruire?lat=…&lon=…   la scène et ses couches mises de côté,
                                   reconstruites à la demande suivante
    GET /api/avis?lat=…&lon=…        les 👍 et 👎 sur le rendu de la scène, et
                                   celui du visiteur
    POST /api/avis?lat=…&lon=…       l'avis du visiteur, ou le mot de son 👎

Chaque route d'API accepte `zone=` (150 à 2 000 m, arrondie à 50 m) : sans
elle, l'emprise par défaut d'environ 356 m.
"""

import math
import secrets

from flask import Blueprint, current_app, jsonify, request, send_from_directory

from ..avis import AVIS_OCTETS_MAX, AvisComplets, AvisInvalide
from ..scene import (NOM_BORNES, NOM_DPE, NOM_DVF, NOM_EOLIENNES, NOM_MONUMENTS, NOM_NUAGE, NOM_NUAGE_PROCHE,
                     NOM_ORTHO, NOM_OUVRAGES, NOM_PANNEAUX, NOM_SCENE, NOM_SOLAIRE, BornesIndisponibles,
                     DpeIndisponibles, DvfIndisponible, EoliennesIndisponibles, HorsEmprise,
                     MonumentsIndisponibles,
                     NuageIndisponible, OuvragesIndisponibles, PanneauxIndisponibles,
                     ReconstructionRefusee, SceneIncomplete, SolaireIndisponible, VehiculesDesactives,
                     VehiculesIndisponibles, nom_scene, point_normalise, zone_normalisee)
from ..vehicules import MODE_PAR_DEFAUT
from .reponses import erreur, servir_gzip

# Noms de couche pour dossier_scene : les fichiers, eux, dépendent du mode et
# du détecteur.
COUCHE_VEHICULES = "vehicules"
COUCHE_PISCINES = "piscines"
COUCHE_NAVIRES = "navires"

MESSAGE_POINT = ("Paramètres lat et lon attendus, en degrés décimaux ; zone, "
                 "facultative, en mètres.")


def point():
    """(lat, lon, zone) de la requête ; None si l'un d'eux est illisible."""
    try:
        return (float(request.args["lat"]), float(request.args["lon"]),
                zone_normalisee(request.args.get("zone")))
    except (KeyError, ValueError):
        return None


def blueprint(cache, construire, quota, avis, quota_avis):
    """Les routes de la scène. `cache` : le Cache des scènes (vue3d/scene.py) ;
    `construire` : la construction d'une scène, injectable ; `quota` : le
    Quota des scènes neuves, ou None sans limite ; `avis` et `quota_avis` :
    les avis sur le rendu (vue3d/avis.py) et leur Quota, ou None."""
    bp = Blueprint("scene", __name__)

    def refus_quota(lat, lon, zone, reconstruction=False):
        """La réponse 429 si la scène du point est à construire et que le
        visiteur a épuisé son quota ; None sinon, la scène comptée. Une
        reconstruction est vérifiée avant de mettre la scène de côté, et
        comptée par l'appelant une fois acceptée : refusée ensuite, la scène
        resterait de côté.

        Raises:
            HorsEmprise: le point n'est pas servi.
        """
        if quota is None:
            return None
        lat, lon = point_normalise(lat, lon)
        if not reconstruction and cache.present(lat, lon, zone):
            return None
        attente = quota.attente(request.remote_addr, (lat, lon, zone),
                                compter=not reconstruction)
        if not attente:
            return None
        current_app.logger.warning("Quota de %d scènes neuves par heure atteint pour %s",
                                   quota.par_heure, request.remote_addr)
        reponse, code = erreur(429, f"Ce serveur construit au plus {quota.par_heure} scènes "
                               "nouvelles par heure pour un même visiteur : chacune interroge "
                               "longuement les services de l'IGN. Les lieux déjà construits "
                               "restent ouverts ; un nouveau pourra l'être dans "
                               f"{math.ceil(attente / 60)} min.")
        reponse.headers["Retry-After"] = str(attente)
        return reponse, code

    def dossier_scene(couche=None, prelire=False, detecteur=None):
        p = point()
        if p is None:
            return None, erreur(400, MESSAGE_POINT)
        *p, zone = p
        log = current_app.logger
        try:
            # Toute route qui lit un dossier de scène la construit au besoin,
            # couches comprises : le quota se vérifie donc ici, pour toutes.
            refus = refus_quota(*p, zone)
            if refus:
                return None, refus
            if couche == NOM_MONUMENTS:
                return cache.obtenir_monuments(*p, construire=construire, zone=zone), None
            if couche == NOM_EOLIENNES:
                return cache.obtenir_eoliennes(*p, construire=construire, zone=zone), None
            if couche == NOM_OUVRAGES:
                return cache.obtenir_ouvrages(*p, construire=construire, zone=zone), None
            if couche == NOM_NUAGE:
                return cache.obtenir_nuage(*p, construire=construire, zone=zone), None
            if couche == NOM_NUAGE_PROCHE:
                return cache.obtenir_nuage_proche(*p, construire=construire, zone=zone), None
            if couche == NOM_DPE:
                return cache.obtenir_dpe(*p, construire=construire, zone=zone), None
            if couche == NOM_DVF:
                return cache.obtenir_dvf(*p, construire=construire, zone=zone), None
            if couche == NOM_BORNES:
                return cache.obtenir_bornes(*p, construire=construire, zone=zone), None
            if couche == NOM_SOLAIRE:
                return cache.obtenir_solaire(*p, construire=construire, zone=zone), None
            if couche == COUCHE_PISCINES:
                return cache.obtenir_piscines(*p, construire=construire, zone=zone), None
            if couche == COUCHE_NAVIRES:
                return cache.obtenir_navires(*p, construire=construire, zone=zone), None
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
                cache.prelire_eoliennes(*p, zone=zone)
                cache.prelire_ouvrages(*p, zone=zone)
                cache.prelire_vehicules(*p, zone=zone)
                cache.prelire_panneaux(*p, zone=zone)
            return cache.obtenir(*p, construire=construire, zone=zone), None
        except HorsEmprise as exc:
            return None, erreur(422, str(exc))
        except SceneIncomplete as exc:
            # Rien n'a été mis en cache : la prochaine demande réessaiera.
            log.warning("Scène incomplète pour %s : %s", p, exc)
            return None, erreur(503, "Un service de l'IGN n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except MonumentsIndisponibles as exc:
            log.warning("Monuments OSM indisponibles pour %s : %s", p, exc)
            return None, erreur(503, "OpenStreetMap n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except EoliennesIndisponibles as exc:
            log.warning("Éoliennes OSM indisponibles pour %s : %s", p, exc)
            return None, erreur(503, "OpenStreetMap n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except OuvragesIndisponibles as exc:
            log.warning("Ouvrages indisponibles pour %s : %s", p, exc)
            return None, erreur(503, "Un service de l'IGN n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except NuageIndisponible as exc:
            log.warning("Nuage LiDAR HD indisponible pour %s : %s", p, exc)
            return None, erreur(503, "Un service de l'IGN n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except VehiculesIndisponibles as exc:
            log.warning("Détection indisponible pour %s : %s", p, exc)
            return None, erreur(503, "La détection sur l'orthophoto n'a pas abouti ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except DpeIndisponibles as exc:
            log.warning("DPE indisponibles pour %s : %s", p, exc)
            return None, erreur(503, "L'API des DPE de l'ADEME n'a pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except DvfIndisponible as exc:
            log.warning("DVF indisponible pour %s : %s", p, exc)
            return None, erreur(503, "Le cadastre ou les fichiers DVF n'ont pas répondu ("
                                f"{exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except BornesIndisponibles as exc:
            log.warning("Bornes de recharge indisponibles pour %s : %s", p, exc)
            return None, erreur(503, "La base des bornes de recharge de data.gouv.fr n'a pas "
                                f"répondu ({exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except SolaireIndisponible as exc:
            log.warning("Climat solaire indisponible pour %s : %s", p, exc)
            return None, erreur(503, "PVGIS, le service solaire de la Commission européenne, n'a "
                                f"pas répondu ({exc}). Rien n'a été mis en cache : réessayez "
                                "dans quelques instants.")
        except PanneauxIndisponibles as exc:
            log.warning("Panneaux indisponibles pour %s : %s", p, exc)
            return None, erreur(503, f"Le registre des panneaux solaires n'a pas pu être lu ({exc}). "
                                "Rien n'a été mis en cache : réessayez dans quelques instants.")
        except VehiculesDesactives as exc:
            return None, erreur(400, f"{exc} : détecteurs de ce service : "
                                f"{', '.join(cache.lire_vehicules.detecteurs) or 'aucun'}.")

    def couche(nom):
        """La couche `nom` du dossier de la scène du point, ou l'erreur."""
        dossier, err = dossier_scene(couche=nom)
        if err:
            return err
        return servir_gzip(dossier, nom)

    @bp.get("/")
    def page():
        return send_from_directory(current_app.static_folder, "index.html")

    @bp.get("/api/scene")
    def scene():
        dossier, err = dossier_scene(prelire=True)
        if err:
            return err
        return servir_gzip(dossier, NOM_SCENE)

    @bp.get("/api/monuments")
    def monuments():
        """La couche OSM, demandée par la page une fois la scène affichée :
        `null` quand l'emprise n'a aucune partie, le cas de presque partout."""
        return couche(NOM_MONUMENTS)

    @bp.get("/api/eoliennes")
    def eoliennes():
        """Les éoliennes OSM de l'anneau, demandées par la page une fois la
        scène affichée : `null` quand il n'y en a aucune, le cas de presque
        partout."""
        return couche(NOM_EOLIENNES)

    @bp.get("/api/ouvrages")
    def ouvrages():
        """Murs, ponts, voies ferrées et terrains de sport, demandés par la
        page une fois la scène affichée : `null` quand l'emprise n'en a aucun."""
        return couche(NOM_OUVRAGES)

    @bp.get("/api/nuage")
    def nuage():
        """Le bâti du nuage LiDAR HD, demandé par la page une fois la scène
        affichée : `null` hors couverture LiDAR HD ou sans relief."""
        if request.args.get("proche"):
            trouve, err = dossier_scene(couche=NOM_NUAGE_PROCHE)
            if err:
                return err
            return servir_gzip(*trouve)
        return couche(NOM_NUAGE)

    def sans_detecteur(**vide):
        """Réponse des couches de l'orthophoto quand le service n'a pas de
        détecteur : le mode, que la page lit, et rien à dessiner. Ce n'est
        pas une erreur. Jamais gardée : le service peut être relancé avec un
        détecteur."""
        reponse = jsonify({"mode": MODE_PAR_DEFAUT, **vide})
        reponse.headers["Cache-Control"] = "no-store"
        return reponse

    @bp.get("/api/piscines")
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

    @bp.get("/api/navires")
    def navires():
        """Les navires de l'orthophoto, demandés par la page après les
        piscines : une demi-seconde de détection. La liste est vide loin de
        l'eau."""
        if not cache.lire_vehicules:
            return sans_detecteur(navires=[])
        trouve, err = dossier_scene(couche=COUCHE_NAVIRES)
        if err:
            return err
        return servir_gzip(*trouve)

    @bp.get("/api/vehicules")
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

    @bp.get("/api/panneaux")
    def panneaux():
        """Les panneaux solaires du registre OpenPVMapper, demandés par la
        page une fois la scène affichée. Sans registre, la réponse le dit
        (`actif: false`) : ce n'est pas une erreur."""
        if not cache.lire_panneaux:
            reponse = jsonify({"actif": False, "panneaux": []})
            reponse.headers["Cache-Control"] = "no-store"
            return reponse
        return couche(NOM_PANNEAUX)

    @bp.get("/api/dpe")
    def dpe():
        """Les DPE de l'ADEME autour du point, rattachés aux bâtiments :
        demandés par la page au clic sur leur bouton, jamais d'office."""
        return couche(NOM_DPE)

    @bp.get("/api/dvf")
    def dvf():
        """Les ventes DVF des parcelles autour du point : au clic, comme les
        DPE. Sans DVF ici (Alsace-Moselle), la couche le dit (`absent`)."""
        return couche(NOM_DVF)

    @bp.get("/api/bornes")
    def bornes():
        """Les bornes de recharge autour du point, réunies par station : au
        clic, comme les DPE."""
        return couche(NOM_BORNES)

    @bp.get("/api/solaire")
    def solaire():
        """L'année type du rayonnement solaire au point (PVGIS), dont la page
        calcule l'ensoleillement des toits : au clic, comme les DPE."""
        return couche(NOM_SOLAIRE)

    @bp.get("/api/ortho")
    def ortho():
        dossier, err = dossier_scene()
        if err:
            return err
        # Revalidée comme la scène (servir_gzip) : send_from_directory donne
        # déjà son validateur, tiré de l'instant d'écriture du fichier.
        reponse = send_from_directory(dossier, NOM_ORTHO, mimetype="image/jpeg")
        reponse.headers["Cache-Control"] = "no-cache"
        return reponse

    @bp.post("/api/reconstruire")
    def reconstruire():
        """Le bouton « Reconstruire la scène » de la page : la scène et ses
        couches sont mises de côté, et la page, rechargée, les reconstruit
        d'après les données de l'IGN du moment (Cache.reconstruire)."""
        p = point()
        if p is None:
            return erreur(400, MESSAGE_POINT)
        *p, zone = p
        try:
            refus = refus_quota(*p, zone, reconstruction=True)
            if refus:
                return refus
            cache.reconstruire(*p, zone=zone)
            if quota:
                quota.attente(request.remote_addr, (*point_normalise(*p), zone))
        except HorsEmprise as exc:
            return erreur(422, str(exc))
        except ReconstructionRefusee as exc:
            return erreur(exc.code, f"Reconstruction refusée : {exc}.")
        reponse = jsonify({"etat": "a_reconstruire"})
        reponse.headers["Cache-Control"] = "no-store"
        return reponse, 202

    @bp.get("/api/avancement")
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

    def scene_jugee():
        """Le nom de la scène du point de la requête (scene.nom_scene) et
        None ; sinon None et la réponse d'erreur."""
        p = point()
        if p is None:
            return None, erreur(400, MESSAGE_POINT)
        *p, zone = p
        try:
            return nom_scene(*point_normalise(*p), zone), None
        except HorsEmprise as exc:
            return None, erreur(422, str(exc))

    @bp.get("/api/avis")
    def avis_scene():
        """Les 👍 et 👎 de la scène, que la page montre à tous, et l'avis du
        visiteur : jamais mis en cache, ils changent à chaque vote."""
        nom, refus = scene_jugee()
        if refus:
            return refus
        reponse = jsonify(avis.compter(nom, request.remote_addr))
        reponse.headers["Cache-Control"] = "no-store"
        return reponse

    @bp.post("/api/avis")
    def donner_avis():
        """L'avis du visiteur sur le rendu de la scène, ou le mot de son 👎
        (vue3d/avis.py) ; une scène qui n'est pas construite n'en reçoit pas."""
        # Lu borné : un corps sans Content-Length serait lu jusqu'au bout.
        corps = request.stream.read(AVIS_OCTETS_MAX + 1)
        if len(corps) > AVIS_OCTETS_MAX:
            return erreur(413, f"Avis de plus de {AVIS_OCTETS_MAX // 1_000_000} Mo.")
        nom, refus = scene_jugee()
        if refus:
            return refus
        lat, lon, zone = point()
        if not cache.present(*point_normalise(lat, lon), zone):
            return erreur(404, "Aucune scène construite ici : il n'y a pas de rendu à juger.")
        if quota_avis and quota_avis.attente(request.remote_addr, secrets.token_hex(8)):
            current_app.logger.warning("Quota de %d avis par heure atteint pour %s",
                                       quota_avis.par_heure, request.remote_addr)
            reponse, code = erreur(429, "Trop d'avis envoyés en une heure.")
            reponse.headers["Retry-After"] = "600"
            return reponse, code
        try:
            ident, comptes = avis.recevoir(nom, corps, request.remote_addr,
                                           request.headers.get("User-Agent"))
        except AvisInvalide as exc:
            return erreur(400, f"Avis illisible : {exc}.")
        except AvisComplets:
            current_app.logger.warning("Avis : %s plein, rien d'écrit", avis.journal)
            return erreur(507, "Le serveur garde déjà assez d'avis à lire.")
        current_app.logger.info("Avis %s reçu de %s sur %s", ident, request.remote_addr, nom)
        reponse = jsonify({"id": ident, **comptes})
        reponse.headers["Cache-Control"] = "no-store"
        return reponse, 201

    return bp
