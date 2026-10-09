"""Relevés des détections sur l'orthophoto : ce que les réseaux ont vu,
rangé par morceau de terrain plutôt que par point.

La couche des véhicules (ou des piscines) d'un point s'écrit à côté de sa
scène (scene.Cache) ; la détection qui la nourrit coûte, elle, de quelques
secondes à une minute sur CoreML, cinq dans le conteneur (vehicules.MOTEURS).
Or deux points voisins voient en grande partie le même terrain : une flèche
de la page décale le point d'un quart de zone, et les trois quarts de la
nouvelle emprise ont déjà été détectés. Chaque détection est donc gardée à
part, comme un **relevé** : un rectangle de terrain, son cœur, et ce que le
réseau y a vu, en coordonnées. La couche d'un point réunit les relevés qui
couvrent son emprise ; seul ce qu'aucun ne couvre est détecté.

**Une grille commune.** Les cœurs sont des rectangles de cellules de
CELLULE degré, le pas de la clé du cache : l'emprise par défaut en est faite
exactement, et le point décalé d'une flèche, arrondi au même pas, aussi. La
bande qui manque après un décalage tombe juste sur la grille, sans liseré.

**Le cœur et la marge.** Un relevé détecte sur son cœur élargi d'une
marge de chaque côté (MARGE_VEHICULES_PX, MARGE_PISCINES_PX), et ne garde que les boîtes dont le centre tombe dans le cœur
(à TOLERANCE_M près) : un véhicule ou un bassin à cheval sur la limite de
deux relevés est vu entier par chacun.

**Doublons.** Deux relevés voisins peuvent voir le même objet près de leur
limite commune : de deux boîtes de relevés différents qui se doublent, la
première dans l'ordre des détecteurs puis du score est gardée, avec les
règles de vehicules.sans_doublons (et, pour les piscines, celle d'un
détecteur à l'autre : le centre de l'une dans l'autre).

**Un relevé est écrit entier, ou pas du tout** : une orthophoto illisible
ou une détection en échec lève, et rien n'est écrit pour lui ; la couche du
point, qui ne se réunit que sur une emprise entièrement couverte, ne l'est
pas non plus.
"""

import gzip
import json
import math
import os
import tempfile
import threading

import numpy as np
from shapely.geometry import Point, Polygon

from .vehicules import (DOUBLON_CENTRES_M, DOUBLON_IOU, RESOLUTION_M, _coins,
                        en_geographie)

# Format des relevés : la détection elle-même (réseaux, réglages, marge). Le
# changer refait les détections ; changer la couche qui les réunit
# (vehicules.VEHICULES_VERSION) ne refait que la couche.
RELEVES_VERSION = 1

# Pas de la grille des cœurs, en cellules par degré : celui de la clé du
# cache (scene.SCENE_ARRONDI, quatre décimales, une dizaine de mètres).
PAR_DEGRE = 10_000

# Marge de l'image autour du cœur, en pixels de l'orthophoto. Il en faut
# assez pour qu'un objet à cheval sur la limite tienne entier dans l'image,
# et les réseaux voient moins bien près du bord d'une image : une piscine de
# 6 m à 90 px du bord est manquée à Gordes, vue à 155 px. Mesuré le
# 2026-10-09 sur 24 décalages d'une flèche (six centres de villes, quatre
# sens, emprise par défaut, CoreML), couche réunie de deux relevés contre la
# même détectée d'un seul tenant, objets de la référence manqués à ±15 m de
# la limite, et dans une bande témoin à 60 m de là (le bruit du cadrage) :
#
#   marge (px)                     64           128
#   rtmdet   limite / témoin    8 % / 19 %   7 % / 18 %
#   yolo     limite / témoin    4 % / 19 %   9 % / 19 %
#   piscines limite / témoin    2 sur 8 / 0 sur 12   1 sur 8 / 0 sur 12
#   détection médiane              4,2 s        5,3 s
#
# Pour les véhicules, la limite n'est pas plus mal vue qu'ailleurs dès 64 px
# (12,8 m, deux fois la moitié d'un autocar) ; la première ouverture d'un
# lieu en coûte 8 à 22 % de plus qu'avant les relevés, contre 17 à 37 % à
# 128 px. Les piscines prennent 128 px (25,6 m, plus que la plus longue vue,
# 17 m) : leur détection ne pèse presque rien (une demi-seconde), et l'image
# lue pour elles sert aux véhicules, recadrée (`recadrer`).
MARGE_VEHICULES_PX = 64
MARGE_PISCINES_PX = 128

# Une boîte est gardée par son relevé si son centre tombe dans le cœur, ou
# à moins de TOLERANCE_M au-dehors : d'un relevé à l'autre, le centre d'un
# même objet bouge un peu, et sans elle un véhicule posé sur la limite que
# chacun place de l'autre côté serait perdu des deux. Mesuré le 2026-10-09
# sur 1 194 objets vus de deux cadrages (Gordes et Carcassonne, zone par
# défaut et de 1 000 m) : écart médian de 5 à 12 cm, 95 % sous 0,36 m pour
# les véhicules et sous 1,07 m pour les piscines.
TOLERANCE_M = 1.5


def rectangle(west, south, east, north):
    """Le plus petit rectangle de cellules (ouest, sud, est, nord), en
    entiers, qui contient l'emprise. Une limite à moins d'un millionième de
    cellule d'une ligne de la grille est sur elle : l'emprise par défaut,
    calculée en flottants, retombe sur ses cellules."""
    def bas(x):
        v = x * PAR_DEGRE
        return round(v) if abs(v - round(v)) < 1e-6 else math.floor(v)

    def haut(x):
        v = x * PAR_DEGRE
        return round(v) if abs(v - round(v)) < 1e-6 else math.ceil(v)
    return bas(west), bas(south), haut(east), haut(north)


def en_degres(rect):
    return tuple(v / PAR_DEGRE for v in rect)


def _marges(south, north, metres):
    """(en longitude, en latitude) : `metres` en degrés, à la latitude de l'emprise."""
    dlat = metres / 111320
    return dlat / math.cos(math.radians((south + north) / 2)), dlat


def emprise_image(rect, marge_px):
    """Emprise de l'orthophoto d'un relevé : son cœur et la marge."""
    west, south, east, north = en_degres(rect)
    dlon, dlat = _marges(south, north, marge_px * RESOLUTION_M)
    return west - dlon, south - dlat, east + dlon, north + dlat


def recadrer(bbox, rgb, k):
    """(emprise, image) de l'image `rgb` de l'emprise `bbox`, privée de `k`
    pixels de chaque côté : l'emprise suit les pixels gardés."""
    if not k:
        return bbox, rgb
    west, south, east, north = bbox
    h, w = rgb.shape[:2]
    dlon, dlat = (east - west) / w, (north - south) / h
    return (west + k * dlon, south + k * dlat, east - k * dlon, north - k * dlat), rgb[k:h - k, k:w - k]


def _se_touchent(a, b):
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _aire_m2(rect, marge_m=0.0):
    west, south, east, north = en_degres(rect)
    kx = 111320 * math.cos(math.radians((south + north) / 2))
    return ((east - west) * kx + 2 * marge_m) * ((north - south) * 111320 + 2 * marge_m)


def manquants(besoin, couverts):
    """Rectangles de cellules de `besoin` qu'aucun rectangle de `couverts`
    ne couvre : les suites de cellules libres de chaque rangée, réunies
    d'une rangée à la suivante tant qu'elles sont les mêmes. Une bande
    après un décalage en fait un ; un décalage en biais, deux."""
    o, s, e, n = besoin
    libre = np.ones((n - s, e - o), dtype=bool)
    for r in couverts:
        if _se_touchent(r, besoin):
            libre[max(r[1], s) - s:min(r[3], n) - s, max(r[0], o) - o:min(r[2], e) - o] = False
    rects, ouverts = [], {}
    for i in range(n - s + 1):
        suites = set()
        if i < n - s:
            bords = np.flatnonzero(np.diff(np.concatenate(([0], libre[i].view(np.int8), [0]))))
            suites = set(zip(bords[::2].tolist(), bords[1::2].tolist()))
        for suite in [x for x in ouverts if x not in suites]:
            rects.append((o + suite[0], s + ouverts.pop(suite), o + suite[1], s + i))
        for suite in suites - ouverts.keys():
            ouverts[suite] = i
    return sorted(rects, key=lambda r: (r[1], r[0]))


def a_detecter(besoin, couverts, marge_px=MARGE_VEHICULES_PX):
    """Les rectangles à détecter pour couvrir `besoin` : ceux qui manquent,
    ou leur enveloppe si elle coûte moins — chaque relevé paie sa marge, et
    une mosaïque de petits trous coûterait plus que l'enveloppe entière."""
    trous = manquants(besoin, couverts)
    if len(trous) < 2:
        return trous
    enveloppe = (min(r[0] for r in trous), min(r[1] for r in trous),
                 max(r[2] for r in trous), max(r[3] for r in trous))
    marge_m = marge_px * RESOLUTION_M
    if _aire_m2(enveloppe, marge_m) <= sum(_aire_m2(r, marge_m) for r in trous):
        return [enveloppe]
    return trous


def garder_le_coeur(rect, boites):
    """Les boîtes (en coordonnées) dont le centre tombe dans le cœur du
    relevé, à TOLERANCE_M près."""
    west, south, east, north = en_degres(rect)
    dlon, dlat = _marges(south, north, TOLERANCE_M)
    return [b for b in boites
            if west - dlon <= b[0] <= east + dlon and south - dlat <= b[1] <= north + dlat]


def _polygone(x, y, b):
    """Boîte en mètres : cap compté du nord vers l'est, angle de _coins depuis l'est."""
    return Polygon(_coins(x, y, b[2], b[3], math.radians(90.0 - b[4])))


def _doublon(x, y, b, xo, yo, bo, centre_dans_l_autre):
    """Les règles de vehicules.sans_doublons, en mètres ; pour les piscines,
    aussi celle d'un détecteur à l'autre (detecter_piscines)."""
    d2 = (x - xo) ** 2 + (y - yo) ** 2
    if d2 < DOUBLON_CENTRES_M ** 2:
        return True
    if d2 >= ((b[2] + bo[2]) / 2) ** 2:             # trop loin pour se toucher
        return False
    p, q = _polygone(x, y, b), _polygone(xo, yo, bo)
    if centre_dans_l_autre and (q.contains(Point(x, y)) or p.contains(Point(xo, yo))):
        return True
    inter = p.intersection(q).area
    return inter > DOUBLON_IOU * (p.area + q.area - inter)


def reunir(releves, detecteurs, centre_dans_l_autre=False):
    """Boîtes de plusieurs relevés, sans doublon de l'un à l'autre.

    Args:
        releves: [boîtes de chaque relevé], en coordonnées ; la dernière
            valeur de chaque boîte est son détecteur, la sixième son score.
        detecteurs: leur ordre de priorité (vehicules.MODES).

    Deux boîtes d'un même relevé ne sont jamais comparées : chaque relevé a
    déjà retiré les siennes. Rendues dans l'ordre des relevés.
    """
    toutes = [(i, k, b) for i, boites in enumerate(releves) for k, b in enumerate(boites)]
    if len(releves) < 2:
        return [b for _, _, b in toutes]
    lat = sum(b[1] for _, _, b in toutes) / max(len(toutes), 1)
    kx, ky = 111320 * math.cos(math.radians(lat)), 111320
    # Des seaux du côté de la plus longue boîte : deux boîtes plus éloignées
    # ne se touchent pas.
    pas = max((b[2] for _, _, b in toutes), default=1.0) or 1.0
    rang = {d: r for r, d in enumerate(detecteurs)}
    seaux, gardees = {}, []
    for i, k, b in sorted(toutes, key=lambda t: (rang.get(t[2][-1], len(rang)), -t[2][5], t[0], t[1])):
        x, y = b[0] * kx, b[1] * ky
        cx, cy = math.floor(x / pas), math.floor(y / pas)
        if any(j != i and _doublon(x, y, b, xo, yo, bo, centre_dans_l_autre)
               for dx in (-1, 0, 1) for dy in (-1, 0, 1)
               for j, xo, yo, bo in seaux.get((cx + dx, cy + dy), ())):
            continue
        seaux.setdefault((cx, cy), []).append((i, x, y, b))
        gardees.append((i, k, b))
    return [b for _, _, b in sorted(gardees, key=lambda t: t[:2])]


class Releves:
    """Les relevés sur disque, un dossier par genre (`vehicules-<détecteur>`
    ou `piscines-<mode>`, et la version), un fichier par relevé, nommé par
    son cœur : `ouest_sud_est_nord.json.gz`, en cellules."""

    def __init__(self, dossier):
        self.dossier = dossier
        # Lister et lire d'un côté, effacer de l'autre (Cache.reconstruire) :
        # une lecture ne trouve jamais un relevé à moitié effacé.
        self._verrou = threading.Lock()

    def _chemin(self, genre, rect=None):
        dossier = os.path.join(self.dossier, f"{genre}-r{RELEVES_VERSION}")
        return dossier if rect is None else os.path.join(dossier, "_".join(map(str, rect)) + ".json.gz")

    def _rectangles(self, genre):
        try:
            noms = os.listdir(self._chemin(genre))
        except FileNotFoundError:
            return []
        rects = []
        for nom in noms:
            try:
                rect = tuple(int(v) for v in nom.removesuffix(".json.gz").split("_"))
            except ValueError:
                continue                        # fichier temporaire d'une écriture en cours
            if nom.endswith(".json.gz") and len(rect) == 4:
                rects.append(rect)
        return sorted(rects)

    def a_detecter(self, genre, besoin, marge_px, en_attente=()):
        """Rectangles à détecter pour que `besoin` soit couvert, ceux de
        `en_attente` (déjà lancés) tenus pour faits."""
        with self._verrou:
            couverts = self._rectangles(genre)
        return a_detecter(besoin, couverts + list(en_attente), marge_px)

    def lire(self, genre, besoin):
        """(boîtes de chaque relevé qui touche `besoin`, rectangles qui
        manquent encore)."""
        with self._verrou:
            rects = self._rectangles(genre)
            # Une cellule autour : la tolérance d'un relevé voisin déborde un
            # peu sur l'emprise.
            autour = (besoin[0] - 1, besoin[1] - 1, besoin[2] + 1, besoin[3] + 1)
            touches = [r for r in rects if _se_touchent(r, autour)]
            boites = []
            for r in touches:
                with gzip.open(self._chemin(genre, r), "rt", encoding="utf-8") as f:
                    boites.append(json.load(f)["boites"])
        return boites, manquants(besoin, touches)

    def ecrire(self, genre, rect, boites):
        """Écrit d'un bloc : un fichier temporaire, renommé une fois complet."""
        os.makedirs(self._chemin(genre), exist_ok=True)
        octets = gzip.compress(json.dumps({"version": RELEVES_VERSION, "coeur": rect, "boites": boites},
                                          separators=(",", ":")).encode(), 6)
        fd, tmp = tempfile.mkstemp(dir=self._chemin(genre))
        with os.fdopen(fd, "wb") as f:
            f.write(octets)
        os.replace(tmp, self._chemin(genre, rect))

    def oublier(self, besoin):
        """Efface les relevés qui touchent `besoin`, de tous les genres (un
        service relancé dans un autre mode les reprendrait) : la demande
        suivante les refait d'après l'orthophoto du moment, et les points
        voisins qu'ils couvraient aussi, à leur prochaine couche."""
        suffixe = f"-r{RELEVES_VERSION}"
        with self._verrou:
            try:
                genres = [d.removesuffix(suffixe) for d in os.listdir(self.dossier) if d.endswith(suffixe)]
            except FileNotFoundError:
                return
            for genre in genres:
                for r in self._rectangles(genre):
                    if _se_touchent(r, besoin):
                        os.remove(self._chemin(genre, r))

    def relever(self, genre, bbox, detecter, cle, detecteurs, marge_px, centre_dans_l_autre=False,
                images=None):
        """Les boîtes dont le centre tombe dans l'emprise `bbox`, réunies des
        relevés qui la couvrent ; ceux qui manquent sont détectés d'abord.

        Args:
            detecter: (emprise de l'image, rgb=None) -> brut en pixels
                (vehicules.Lecteur.piscines, .vehicules(d)).
            cle: celle des boîtes dans le brut, "boites" ou "piscines".
            marge_px: celle de l'image de chaque relevé.
            images: {rectangle: (marge, orthophoto de son emprise_image)},
                déjà lues ; recadrées à `marge_px`.

        Raises:
            ce que lève `detecter` : rien n'est alors écrit pour ce relevé.
        """
        besoin = rectangle(*bbox)
        # Trois tours au plus : un relevé effacé pendant le calcul
        # (Cache.reconstruire, sur un point voisin) se refait au tour suivant.
        for _ in range(3):
            boites, trous = self.lire(genre, besoin)
            if not trous:
                # Celles de l'emprise seulement : les relevés voisins
                # débordent, et la couche compterait au bord ce qui est hors
                # d'elle.
                west, south, east, north = bbox
                return [b for b in reunir(boites, detecteurs, centre_dans_l_autre)
                        if west <= b[0] <= east and south <= b[1] <= north]
            for rect in self.a_detecter(genre, besoin, marge_px):
                image, rgb = emprise_image(rect, marge_px), None
                if images and rect in images and images[rect][0] >= marge_px:
                    marge_lue, lue = images[rect]
                    image, rgb = recadrer(emprise_image(rect, marge_lue), lue, marge_lue - marge_px)
                brut = detecter(*image, rgb=rgb)
                self.ecrire(genre, rect, garder_le_coeur(rect, en_geographie(*image, brut, cle)))
        raise RuntimeError("relevés effacés à mesure qu'ils étaient détectés")
