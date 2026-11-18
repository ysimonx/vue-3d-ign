"""Ce que les deux pages partagent.

    GET /api/tuile/<couche>/<z>/<x>/<y>  une tuile WMTS de l'IGN (ortho, plan) : du
                                   stock du serveur, sinon redirigée vers l'IGN
                                   et mise en réserve ; `?relire=1` après un
                                   refus, lue et gardée ici
    GET /api/sante                 contrôle de vie, pour Docker ; ce que le
                                   service sait détecter, pour la page
"""

import io

import requests
from flask import Blueprint, current_app, jsonify, redirect, request, send_file

from ..panneaux import REGISTRE_LICENCE
from ..tuiles import (
    COUCHES, TUILES_RESERVE_ZOOM_MAX, TuileAbsente, TuileIllisible, TuilesOccupees, url_ign, valide,
)
from ..vehicules import MODE_PAR_DEFAUT
from .reponses import erreur


def blueprint(cache, stock, quota_tuiles, quota_reserve=None):
    """Les routes communes. `cache` : le Cache des scènes, pour ses lecteurs
    de détections et de panneaux ; `stock` : le Stock des tuiles
    (vue3d/tuiles.py) ; `quota_tuiles` : les tuiles relues par heure et par
    visiteur, None sans limite ; `quota_reserve` : de même, les tuiles mises
    en réserve."""
    bp = Blueprint("service", __name__)

    @bp.get("/api/tuile/<couche>/<int:z>/<int:x>/<int:y>")
    def tuile(couche, z, x, y):
        """Une tuile WMTS de l'IGN (vue3d/tuiles.py) : du stock, sinon une
        redirection vers l'IGN, et la tuile mise en réserve ; avec `relire`,
        après un refus au navigateur, lue ici et gardée."""
        if not valide(couche, z, x, y):
            return erreur(404, "Tuile hors de ce que la page demande : couche, zoom ou position.")
        stock.purger_si_du()
        chemin = stock.present(couche, z, x, y)
        if chemin is None:
            if stock.absente(couche, z, x, y):
                reponse, code = erreur(404, "L'IGN n'a pas d'image pour cette tuile.")
                reponse.headers["Cache-Control"] = "no-store"
                return reponse, code
            if "relire" not in request.args:
                # Lue ici en tâche de fond, pour le visiteur suivant. Le quota
                # ne compte que les zooms mis en réserve : pas ceux de la
                # vue en voiture.
                if z <= TUILES_RESERVE_ZOOM_MAX and (
                        not quota_reserve or not quota_reserve.attente(request.remote_addr, (couche, z, x, y))):
                    stock.reserver(couche, z, x, y)
                # Pas gardée par le navigateur : la tuile peut entrer au
                # stock, et la page doit alors la recevoir d'ici.
                reponse = redirect(url_ign(couche, z, x, y), 302)
                reponse.headers["Cache-Control"] = "no-store"
                return reponse
            if quota_tuiles and quota_tuiles.attente(request.remote_addr, (couche, z, x, y)):
                current_app.logger.warning("Quota de %d tuiles relues par heure atteint pour %s",
                                           quota_tuiles.par_heure, request.remote_addr)
                reponse, code = erreur(429, "Trop de tuiles relues pour ce visiteur.")
                reponse.headers["Retry-After"] = "600"
                return reponse, code
            try:
                chemin = stock.relire(couche, z, x, y)
            except TuileAbsente:
                reponse, code = erreur(404, "L'IGN n'a pas d'image pour cette tuile.")
                reponse.headers["Cache-Control"] = "no-store"
                return reponse, code
            except TuilesOccupees:
                reponse, code = erreur(503, "Le serveur relit déjà d'autres tuiles.")
                reponse.headers["Retry-After"] = "2"
                return reponse, code
            except (TuileIllisible, requests.RequestException) as exc:
                current_app.logger.warning("Tuile %s %d/%d/%d illisible à l'IGN : %s",
                                           couche, z, x, y, exc)
                return erreur(503, "Tuile illisible à l'IGN pour l'instant.")
        # Des octets si le stock n'a pas pu la garder (disque absent).
        source = io.BytesIO(chemin) if isinstance(chemin, bytes) else chemin
        reponse = send_file(source, mimetype=COUCHES[couche][1], conditional=True)
        # Le délai que l'IGN donne lui-même à ses tuiles.
        reponse.headers["Cache-Control"] = "public, max-age=1814400"
        return reponse

    @bp.get("/api/sante")
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

    return bp
