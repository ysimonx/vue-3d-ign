"""La vue en voiture et ce qu'elle lit le long de la route, sans scène.

    GET /voiture                   la page, qui suit la position ; `?lat=…&lon=…`
                                   pour son départ, `&simu=1` pour une conduite
                                   simulée
    GET /api/carre?i=…&j=…         un carré de 500 m de la grille Lambert-93 :
                                   bâtiments et routes BD TOPO
    GET /api/vegetation?i=…&j=…    les arbres du même carré, découpés sur le MNH
    GET /api/vitesses?i=…&j=…      les limitations de vitesse de ses tronçons :
                                   OpenStreetMap, sinon la règle générale
    GET /api/signalisation?i=…&j=… ses stops, cédez-le-passage et feux,
                                   d'OpenStreetMap, rattachés à ses tronçons
    GET /api/bornes-bloc?i=…&j=…   les bornes de recharge d'un bloc de 4 km,
                                   relues chaque semaine
    POST /api/signalement          le bouton ⚠ : sa capture et l'état du sol,
                                   gardés pour l'analyse
"""

import os
import secrets

import requests
from flask import Blueprint, current_app, jsonify, request, send_from_directory

from ..bornes import BlocHorsEmprise, verifier_bloc
from ..carres import CarreHorsEmprise, CarreIndisponible
from ..signalements import SIGNALEMENT_OCTETS_MAX, SignalementInvalide, SignalementsComplets
from .reponses import erreur, servir_gzip


def blueprint(carres, vegetations, vitesses, signalisation, quota_carres, blocs_bornes, quota_blocs,
              signalements, quota_signalements):
    """Les routes de la voiture. `carres`, `vegetations`, `vitesses`,
    `signalisation` : les stocks de ses carrés (vue3d/carres.py), comptés
    ensemble par `quota_carres` ; `blocs_bornes` et `quota_blocs` : les blocs de bornes
    (vue3d/bornes.py) ; `signalements` et `quota_signalements` : le bouton ⚠
    (vue3d/signalements.py). Un quota None ne limite rien."""
    bp = Blueprint("voiture", __name__)

    @bp.get("/voiture")
    def page():
        reponse = send_from_directory(current_app.static_folder, "voiture.html")
        reponse.headers["Cache-Control"] = "no-cache"
        return reponse

    @bp.get("/api/carre")
    def carre():
        """Un carré de la grille de la voiture (vue3d/carres.py), lu au
        besoin : bâtiments et routes BD TOPO."""
        return servir_carre(carres, "carre")

    @bp.get("/api/vegetation")
    def vegetation():
        """Les arbres d'un carré de la voiture, découpés comme ceux de la
        scène : une couche à part, plus lente que les bâtiments."""
        return servir_carre(vegetations, "vegetation")

    @bp.get("/api/vitesses")
    def limitations():
        """Les limitations de vitesse des tronçons d'un carré de la voiture :
        une couche à part, lue à Overpass par bloc de 2 km."""
        return servir_carre(vitesses, "vitesses")

    @bp.get("/api/signalisation")
    def panneaux():
        """Les stops, cédez-le-passage et feux des tronçons d'un carré de la
        voiture : une couche à part, lue à Overpass par bloc de 2 km."""
        return servir_carre(signalisation, "signalisation")

    def servir_carre(stock, couche):
        try:
            i, j = int(request.args["i"]), int(request.args["j"])
        except (KeyError, ValueError):
            return erreur(400, "Paramètres i et j attendus : le carré, en pas de 500 m Lambert-93.")
        try:
            if quota_carres and not stock.present(i, j):
                # Bâtiments et arbres d'un même carré comptent chacun.
                attente = quota_carres.attente(request.remote_addr, (couche, i, j))
                if attente:
                    current_app.logger.warning("Quota de %d carrés neufs par heure atteint pour %s",
                                               quota_carres.par_heure, request.remote_addr)
                    reponse, code = erreur(429, "Trop de carrés neufs pour ce visiteur.")
                    reponse.headers["Retry-After"] = str(attente)
                    return reponse, code
            chemin = stock.obtenir(i, j)
        except CarreHorsEmprise as exc:
            return erreur(422, str(exc))
        except CarreIndisponible as exc:
            current_app.logger.warning("Carré %d, %d (%s) indisponible : %s", i, j, couche, exc)
            reponse, code = erreur(503, f"Un service de l'IGN n'a pas répondu ({exc}).")
            reponse.headers["Retry-After"] = "10"
            return reponse, code
        reponse = servir_gzip(os.path.dirname(chemin), os.path.basename(chemin))
        # Jamais réécrit sous la même adresse (le dossier porte la version) :
        # gardé une semaine, sans revalidation, ce qui épargne une requête par
        # carré à chaque passage.
        reponse.headers["Cache-Control"] = "public, max-age=604800"
        return reponse

    @bp.get("/api/bornes-bloc")
    def bornes_bloc():
        """Les bornes de recharge d'un bloc de 4 km de la grille Lambert-93,
        pour la vue en voiture, qui n'a pas de scène (vue3d/bornes.py)."""
        try:
            bi, bj = int(request.args["i"]), int(request.args["j"])
        except (KeyError, ValueError):
            return erreur(400, "Paramètres i et j attendus : le bloc, en pas de 4 km Lambert-93.")
        try:
            verifier_bloc(bi, bj)
            if quota_blocs and not blocs_bornes.a_jour(bi, bj):
                attente = quota_blocs.attente(request.remote_addr, (bi, bj))
                if attente:
                    current_app.logger.warning("Quota de %d blocs de bornes par heure atteint pour %s",
                                               quota_blocs.par_heure, request.remote_addr)
                    reponse, code = erreur(429, "Trop de blocs de bornes neufs pour ce visiteur.")
                    reponse.headers["Retry-After"] = str(attente)
                    return reponse, code
            chemin = blocs_bornes.obtenir(bi, bj)
        except BlocHorsEmprise as exc:
            return erreur(422, str(exc))
        except requests.RequestException as exc:
            current_app.logger.warning("Bornes du bloc %d, %d illisibles : %s", bi, bj, exc)
            reponse, code = erreur(503, f"La base des bornes de recharge n'a pas répondu ({exc}).")
            reponse.headers["Retry-After"] = "30"
            return reponse, code
        reponse = servir_gzip(os.path.dirname(chemin), os.path.basename(chemin))
        # Relu chaque semaine sous la même adresse : un jour au navigateur.
        reponse.headers["Cache-Control"] = "public, max-age=86400"
        return reponse

    @bp.post("/api/signalement")
    def signalement():
        """Le bouton ⚠ de la vue en voiture : une capture de l'écran et
        l'état du sol, gardés sur disque pour l'analyse
        (vue3d/signalements.py)."""
        # Lu borné : un corps sans Content-Length serait lu jusqu'au bout.
        corps = request.stream.read(SIGNALEMENT_OCTETS_MAX + 1)
        if len(corps) > SIGNALEMENT_OCTETS_MAX:
            return erreur(413, f"Signalement de plus de {SIGNALEMENT_OCTETS_MAX // 1_000_000} Mo.")
        if quota_signalements and quota_signalements.attente(request.remote_addr, secrets.token_hex(8)):
            current_app.logger.warning("Quota de %d signalements par heure atteint pour %s",
                                       quota_signalements.par_heure, request.remote_addr)
            reponse, code = erreur(429, "Trop de signalements envoyés en une heure.")
            reponse.headers["Retry-After"] = "600"
            return reponse, code
        try:
            ident = signalements.enregistrer(corps, request.remote_addr,
                                             request.headers.get("User-Agent"))
        except SignalementInvalide as exc:
            return erreur(400, f"Signalement illisible : {exc}.")
        except SignalementsComplets:
            current_app.logger.warning("Signalements : %s pleins, rien d'écrit", signalements.dossier)
            return erreur(507, "Le serveur garde déjà assez de signalements à lire.")
        current_app.logger.info("Signalement %s reçu de %s", ident, request.remote_addr)
        reponse = jsonify({"id": ident})
        reponse.headers["Cache-Control"] = "no-store"
        return reponse, 201

    return bp
