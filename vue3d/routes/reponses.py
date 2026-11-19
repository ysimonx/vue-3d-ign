"""Les réponses que partagent les routes : erreur en JSON, fichier gzippé
revalidé à chaque demande."""

import os
import re

from flask import current_app, jsonify, request

# Un chemin du serveur dans le message d'une exception (« [Errno 28] No space
# left on device: '/Users/…/cache/…' », un réseau de CoreML introuvable) :
# remplacé par « … » avant de partir chez le visiteur ; le journal le garde
# entier. Les adresses des services (https://data.geopf.fr/…) ne sont pas
# des chemins : précédées de « : » ou d'un nom d'hôte, elles restent.
CHEMIN_SERVEUR = re.compile(r"(?<![\w:/.-])/(?:Users|private|Volumes|opt|tmp|var|home|app|modeles|cache|donnees)"
                            r"(?:/[^\s'\",;)]*)?")


def erreur(code, message):
    return jsonify({"erreur": CHEMIN_SERVEUR.sub("…", str(message))}), code


def refus_intersite(json_attendu=False):
    """La réponse d'erreur d'un POST qu'une page d'un autre site a fait
    envoyer au navigateur de son visiteur ; None pour la page du service.

    Sans cela, un site tiers faisait voter ses visiteurs (un avis par
    adresse IP), et répartissait sur leurs adresses les envois que le quota
    borne par adresse (audit du 19 novembre 2026). Sec-Fetch-Site, que les
    navigateurs posent eux-mêmes, dit d'où vient la requête ; un JSON
    déclaré (`json_attendu`) oblige de plus un autre site à une requête
    préalable CORS, que le service ne permet pas.
    """
    site = request.headers.get("Sec-Fetch-Site")
    if site and site not in ("same-origin", "none"):
        return erreur(403, "Requête venue d'une autre page que celles du service : refusée.")
    if json_attendu and request.mimetype != "application/json":
        return erreur(415, "Corps JSON attendu (Content-Type: application/json).")
    return None


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
        reponse = current_app.response_class(status=304)
    else:
        with open(chemin, "rb") as f:
            charge = f.read()
        # Déjà gzippé : annoncé tel quel, le navigateur le décompresse.
        reponse = current_app.response_class(charge, mimetype="application/json")
        reponse.headers["Content-Encoding"] = "gzip"
    reponse.set_etag(etag)
    reponse.headers["Cache-Control"] = "no-cache"
    return reponse
