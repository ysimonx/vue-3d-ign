"""Mesure de la couche des véhicules et des piscines sur des lieux réels.

Exécute le vrai chemin de la couche — detecter et detecter_piscines, puis
vehicules_pour_emprise — sur l'orthophoto de la Géoplateforme. Pour chaque
lieu et chaque détecteur : le temps de calcul, le nombre de véhicules selon
le seuil et le recouvrement toléré entre deux boîtes, ce que les filtres
écartent, le gabarit des boîtes, et l'accord entre les deux détecteurs ; puis
les piscines, selon le seuil et la tuile, et une planche de vignettes où les
regarder une à une. C'est la mesure à relancer avant de
toucher une constante de vue3d/vehicules.py, ou pour éprouver un nouveau lieu.

Il n'y a pas de vérité terrain annotée : les comptes se jugent sur l'image
annotée (--images), à l'œil.

Usage :
    . .venv/bin/activate && pip install -r requirements-vehicules.txt
    python outils/mesure_vehicules.py modeles/ [--images dossier] [--balayage] [lat lon ...]

`modeles/` contient les réseaux exportés par outils/exporter_vehicules.py.
Sans coordonnées : le village de Gordes et la ville basse de Carcassonne.
--balayage ajoute celui des tailles de tuile et de leur recouvrement :
plusieurs minutes par lieu.
"""

import io
import statistics
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from vue3d import vehicules
from vue3d.couches import COUCHE_BATIMENTS, lire_couche
from vue3d.eau import COUCHE_COURS_EAU, COUCHE_SURFACES_EAU, eau_pour_emprise
from vue3d.ortho import fetch_ortho_jpeg
from vue3d.scene import emprise

LIEUX = {"Gordes": (43.9116, 5.2003), "Carcassonne": (43.2075, 2.3680)}
SEUILS = {"rtmdet": (0.1, 0.15, 0.2, 0.3), "yolo": (0.15, 0.25, 0.35, 0.5)}
TUILES = {"rtmdet": (1024, 768, 640, 512, 400, 320), "yolo": (320, 256, 200, 160, 128)}
RECOUVREMENTS = {"rtmdet": (65, 128, 256, 384), "yolo": (32, 80)}
SEUILS_PISCINES = (0.1, 0.2, 0.3, 0.4, 0.5)
TUILES_PISCINES = (1024, 768, 640, 512, 320)
IOUS = (0.1, 0.3, 0.5)


def avec(nom, **valeurs):
    """Les détecteurs, celui-là modifié."""
    return {**vehicules.DETECTEURS, nom: {**vehicules.DETECTEURS[nom], **valeurs}}


def mesurer(nom_lieu, lat, lon, sessions, images, balayage):
    from PIL import Image, ImageDraw
    bbox = emprise(lat, lon)
    contenu, _, _ = fetch_ortho_jpeg(*bbox, resolution_m=vehicules.RESOLUTION_M)
    image = Image.open(io.BytesIO(contenu)).convert("RGB")
    rgb = np.asarray(image)
    batiments = lire_couche(COUCHE_BATIMENTS, *bbox)
    eau = eau_pour_emprise(*bbox, lire_couche(COUCHE_SURFACES_EAU, *bbox),
                           lire_couche(COUCHE_COURS_EAU, *bbox))
    print(f"\n## {nom_lieu} ({lat}, {lon}) — orthophoto {rgb.shape[1]} × {rgb.shape[0]} px")

    def couche(boites, mode, piscines=None):
        """Les objets gardés par le vrai chemin de la couche ; `mode` n'est
        qu'un libellé ici (les détecteurs sont réunis en amont par detecter)."""
        brut = {"largeur": rgb.shape[1], "hauteur": rgb.shape[0], "boites": boites,
                "piscines": piscines or []}
        # En coordonnées, comme un relevé (vue3d/releves.py) : l'image
        # entière en est un seul, sans marge.
        cle = "boites" if piscines is None else "piscines"
        brut = {cle: vehicules.en_geographie(*bbox, brut, cle)}
        if piscines is not None:
            return vehicules.piscines_pour_emprise(*bbox, brut, mode, batiments, eau)["piscines"]
        return vehicules.vehicules_pour_emprise(*bbox, brut, mode, batiments, eau)["vehicules"]

    par_detecteur = {}
    for nom, session in sessions.items():
        seul = {nom: session}
        t0 = time.time()
        boites = vehicules.detecter(rgb, seul)
        duree = time.time() - t0
        gardes = couche(boites, nom)
        par_detecteur[nom] = boites
        print(f"- {nom} : {len(boites)} boîte(s) en {duree:.1f} s, {len(gardes)} véhicule(s) gardé(s)")
        if gardes:
            lo = sorted(v[2] for v in gardes)
            la = sorted(v[3] for v in gardes)
            dec = lambda t, q: t[min(int(q * len(t)), len(t) - 1)]      # noqa: E731
            print(f"  gabarit : longueur {lo[0]} / {statistics.median(lo)} / {dec(lo, 0.95)} / {lo[-1]} m "
                  f"(min, médiane, 95 %, max), largeur {la[0]} / {statistics.median(la)} / "
                  f"{dec(la, 0.95)} / {la[-1]} m ; "
                  f"{sum(b[6] for b in boites)} boîte(s) de classe « gros véhicule »")
        brutes = vehicules.detecter(rgb, seul, avec(nom, seuil=min(SEUILS[nom])))
        print("  selon le seuil : " + ", ".join(
            f"{s} → {len(couche([b for b in brutes if b[5] >= s], nom))}" for s in SEUILS[nom]))
        iou_d, centres_d = vehicules.DOUBLON_IOU, vehicules.DOUBLON_CENTRES_M
        comptes = []
        for iou in IOUS:
            vehicules.DOUBLON_IOU = iou
            comptes.append(f"{iou} → {len(vehicules.detecter(rgb, seul))}")
        vehicules.DOUBLON_IOU = iou_d
        print("  boîtes selon le recouvrement toléré : " + ", ".join(comptes))
        if balayage:
            for libelle, cle, valeurs in (("la tuile", "tuile_px", TUILES[nom]),
                                          ("le recouvrement", "recouvrement_px", RECOUVREMENTS[nom])):
                lignes = []
                for v in valeurs:
                    t0 = time.time()
                    n = len(couche(vehicules.detecter(rgb, seul, avec(nom, **{cle: v})), nom))
                    lignes.append(f"{v} px → {n} ({time.time() - t0:.0f} s)")
                print(f"  selon {libelle} : " + ", ".join(lignes))
        if images:
            annotee = image.copy()
            dessin = ImageDraw.Draw(annotee)
            for b in boites:
                dessin.polygon(vehicules._coins(*b[:5]), outline=(255, 0, 255))
            chemin = Path(images) / f"{nom_lieu.lower()}-{nom}.jpg"
            annotee.save(chemin, quality=88)
            print(f"  image : {chemin}")

    if len(par_detecteur) == 2:
        (na, a), (nb, b) = par_detecteur.items()
        rayon2 = (vehicules.DOUBLON_ENTRE_DETECTEURS_M / vehicules.RESOLUTION_M) ** 2
        proche = lambda v, autres: any(                                   # noqa: E731
            (v[0] - o[0]) ** 2 + (v[1] - o[1]) ** 2 < rayon2 for o in autres)
        communs = sum(proche(v, b) for v in a)
        t0 = time.time()
        union = vehicules.detecter(rgb, sessions)
        print(f"- accord : {communs} commun(s), {len(a) - communs} vu(s) de {na} seul, "
              f"{len(b) - sum(proche(v, a) for v in b)} de {nb} seul ; "
              f"union {len(union)} boîte(s), {len(couche(union, 'tous'))} gardée(s), "
              f"en {time.time() - t0:.1f} s")
    mesurer_piscines(nom_lieu, image, rgb, sessions, couche, images, balayage)


def mesurer_piscines(nom_lieu, image, rgb, sessions, couche, images, balayage):
    """Piscines : par détecteur, selon le seuil et la tuile ; planche de
    vignettes des boîtes du réglage courant, score en légende."""
    from PIL import Image, ImageDraw
    regles = lambda nom, **v: {nom: {**vehicules.PISCINES[nom], **v}}       # noqa: E731
    for nom, session in sessions.items():
        seul = {nom: session}
        t0 = time.time()
        boites = vehicules.detecter_piscines(rgb, seul)
        duree = time.time() - t0
        gardees = couche([], nom, boites)
        print(f"- piscines, {nom} : {len(boites)} boîte(s) en {duree:.1f} s, {len(gardees)} gardée(s)"
              + (f" ; longueur {min(p[2] for p in gardees)} à {max(p[2] for p in gardees)} m, "
                 f"largeur {min(p[3] for p in gardees)} à {max(p[3] for p in gardees)} m" if gardees else ""))
        brutes = vehicules.detecter_piscines(rgb, seul, regles(nom, seuil=min(SEUILS_PISCINES)))
        print("  selon le seuil : " + ", ".join(
            f"{s} → {sum(b[5] >= s for b in brutes)}" for s in SEUILS_PISCINES))
        if balayage:
            print("  selon la tuile : " + ", ".join(
                f"{t} px → {len(vehicules.detecter_piscines(rgb, seul, regles(nom, tuile_px=t, recouvrement_px=min(128, t // 3))))}"
                for t in TUILES_PISCINES))
        if images and boites:
            cote, demi = 240, 60
            planche = Image.new("RGB", (min(len(boites), 8) * (cote + 4), ((len(boites) + 7) // 8) * (cote + 4)), "white")
            for i, b in enumerate(sorted(boites, key=lambda b: -b[5])):
                x0, y0 = int(b[0]) - demi, int(b[1]) - demi
                vignette = image.crop((x0, y0, x0 + 2 * demi, y0 + 2 * demi)).resize((cote, cote), Image.LANCZOS)
                dessin = ImageDraw.Draw(vignette)
                k = cote / (2 * demi)
                dessin.polygon([((x - x0) * k, (y - y0) * k) for x, y in vehicules._coins(*b[:5])],
                               outline=(255, 0, 255))
                dessin.text((3, 2), f"{b[5]:.2f}", fill=(255, 255, 255))
                planche.paste(vignette, ((i % 8) * (cote + 4), (i // 8) * (cote + 4)))
            chemin = Path(images) / f"{nom_lieu.lower()}-piscines-{nom}.jpg"
            planche.save(chemin, quality=88)
            print(f"  planche : {chemin}")
    if len(sessions) == 2:
        union = vehicules.detecter_piscines(rgb, sessions)
        print(f"- piscines, les deux : {len(union)} boîte(s), {len(couche([], 'tous', union))} gardée(s), "
              + ", ".join(f"{sum(b[7] == n for b in union)} de {n}" for n in sessions))


if __name__ == "__main__":
    args = sys.argv[1:]
    images = None
    if "--images" in args:
        i = args.index("--images")
        images = args[i + 1]
        Path(images).mkdir(parents=True, exist_ok=True)
        del args[i:i + 2]
    balayage = "--balayage" in args
    args = [a for a in args if a != "--balayage"]
    if not args:
        sys.exit(__doc__)
    sessions = vehicules.charger("tous", args[0])
    coords = [float(a) for a in args[1:]]
    lieux = ({f"{la}, {lo}": (la, lo) for la, lo in zip(coords[::2], coords[1::2])}
             if coords else LIEUX)
    for nom_lieu, (lat, lon) in lieux.items():
        mesurer(nom_lieu, lat, lon, sessions, images, balayage)
