// Les carrés voulus le long de la route, et leur chargement.

import { RAD } from '../socle/parametres.js';
import { voiture, VERS, ITINERAIRE_BANDE_M, itineraire } from '../socle/etat.js';
import { CARRE_M, carres, carre } from './grille.js';
import { retirerRoutes, pointDuChemin } from '../route/graphe.js';
import {
    AUTOUR_M, IMPASSE_RAYON_M, COULOIR_M, PAS_COULOIR_M, CARRES_VOULUS_MAX, CARRES_PARALLELE,
    CARRE_DEFAIT_S, CARRE_OUBLI_S, CARRE_OUBLI_M, carresEnVol, chargerCarre, construireCarre,
    defaireCarre,
} from './batiments.js';
import {
    VEG_AUTOUR_M, VEG_COULOIR_M, VEG_DEVANT_M, VEG_IMPASSE_M, VEG_PARALLELE, vegEnVol,
    arbresActifs, chargerVegetation, construireVegetation, defaireVegetation,
} from './arbres.js';
import { VIT_PARALLELE, vitEnVol, chargerVitesses } from '../route/limitations.js';
import { SIG_PARALLELE, sigEnVol, chargerSignalisation } from '../route/signalisation.js';

let derniereSelectionCarres = -Infinity;

/**
 * Les carrés voulus et leur priorité, la distance à parcourir pour y être :
 * ceux à moins de `autour` de la voiture, et à moins de `couloir` de la
 * route prévue, sur `devant` mètres.
 */
function carresVoulus(autour = AUTOUR_M, couloir = COULOIR_M, devant = Infinity, impasse = IMPASSE_RAYON_M) {
    const voulus = new Map();
    const ajouter = (x, y, rayon, prio) => {
        const i0 = Math.floor((x - rayon) / CARRE_M), i1 = Math.floor((x + rayon) / CARRE_M);
        const j0 = Math.floor((y - rayon) / CARRE_M), j1 = Math.floor((y + rayon) / CARRE_M);
        for (let i = i0; i <= i1; i++) {
            for (let j = j0; j <= j1; j++) {
                const ex = Math.max(i * CARRE_M - x, 0, x - (i + 1) * CARRE_M);
                const ey = Math.max(j * CARRE_M - y, 0, y - (j + 1) * CARRE_M);
                const d = Math.hypot(ex, ey);
                if (d > rayon) continue;
                const cle = `${i},${j}`, p = prio + d;
                if (!(voulus.get(cle)?.p <= p)) voulus.set(cle, { i, j, p });
            }
        }
    };
    const v = voiture;
    const x = v.vue ? v.x : v.attendu.x, y = v.vue ? v.y : v.attendu.y;
    ajouter(x, y, autour, 0);
    // En attendant l'itinéraire : la bande entre départ et arrivée.
    if (VERS && !itineraire && devant === Infinity) {
        const l = Math.hypot(VERS.x - x, VERS.y - y);
        for (let t = 0; t <= l; t += CARRE_M / 2) ajouter(x + (VERS.x - x) * t / l, y + (VERS.y - y) * t / l, ITINERAIRE_BANDE_M, t);
    }
    const ch = v.chemin;
    if (ch) {
        const d0 = v.dChemin, fin = Math.min(ch.longueur, d0 + devant);
        for (let d = d0 + PAS_COULOIR_M; d < fin; d += PAS_COULOIR_M) {
            const p = pointDuChemin(ch, d);
            ajouter(p.x, p.y, couloir, d - d0);
        }
        // Au bout d'une route encore inconnue : le carré suivant, d'abord.
        if (ch.fin === 'inconnu' && devant === Infinity) ajouter(ch.bout[0], ch.bout[1], 1, ch.longueur - d0 - 200);
        // Une impasse devant : on ne sait plus par où la voiture repartira,
        // tout autour d'elle, plus loin.
        if (ch.fin === 'impasse') ajouter(x, y, impasse, 0);
    } else if (v.vue && v.v > 2) {
        for (let d = PAS_COULOIR_M; d <= Math.min(1500, devant); d += PAS_COULOIR_M) {
            ajouter(x + d * Math.sin(v.cap * RAD), y + d * Math.cos(v.cap * RAD), couloir, d);
        }
    }
    return [...voulus.values()].sort((a, b) => a.p - b.p).slice(0, CARRES_VOULUS_MAX);
}

export let budgetConstruction = 0;
export const durees = [];                     // [ms, bâtiments] des dernières constructions, pour les essais
export const dureesArbres = [];               // [ms, arbres], de même
export function majCarres(maintenant) {
    if (maintenant - derniereSelectionCarres >= 300 && (voiture.vue || (voiture.attendu && !voiture.attendu.provisoire))) {
        derniereSelectionCarres = maintenant;
        const voulus = carresVoulus();
        const cles = new Set();
        for (const { i, j, p } of voulus) {
            const c = carre(i, j);
            c.voulu = maintenant;
            c.priorite = p;
            cles.add(c.cle);
        }
        for (const { i, j } of voulus) {
            if (carresEnVol >= CARRES_PARALLELE) break;
            const c = carre(i, j);
            if (c.etat === 'neuf' || (c.etat === 'erreur' && maintenant >= c.reessai)) chargerCarre(c);
        }
        // Les arbres, après les bâtiments et plus près de la route.
        const vegCles = new Set();
        if (arbresActifs) {
            const vegVoulus = carresVoulus(VEG_AUTOUR_M, VEG_COULOIR_M, VEG_DEVANT_M, VEG_IMPASSE_M);
            for (const { i, j, p } of vegVoulus) {
                const c = carre(i, j);
                c.veg.voulu = maintenant;
                c.veg.priorite = p;
                vegCles.add(c.cle);
            }
            for (const { i, j } of vegVoulus) {
                if (vegEnVol >= VEG_PARALLELE) break;
                const c = carre(i, j);
                if (c.veg.etat === 'neuf' || (c.veg.etat === 'erreur' && maintenant >= c.veg.reessai)) chargerVegetation(c);
            }
        }
        // Les limitations de vitesse, le long de la même route que les
        // bâtiments et aussi loin : Overpass met de 30 s à plusieurs minutes
        // à rendre un bloc neuf de 2 km (vue3d/vitesses.py).
        for (const { i, j } of voulus) {
            if (vitEnVol >= VIT_PARALLELE) break;
            const c = carre(i, j);
            if (c.vit.etat === 'neuf' || (c.vit.etat === 'erreur' && maintenant >= c.vit.reessai)) chargerVitesses(c);
        }
        // Les stops, cédez-le-passage et feux, de même (vue3d/signalisation.py).
        for (const { i, j } of voulus) {
            if (sigEnVol >= SIG_PARALLELE) break;
            const c = carre(i, j);
            if (c.sig.etat === 'neuf' || (c.sig.etat === 'erreur' && maintenant >= c.sig.reessai)) chargerSignalisation(c);
        }
        const px = voiture.vue ? voiture.x : voiture.attendu.x, py = voiture.vue ? voiture.y : voiture.attendu.y;
        for (const c of [...carres.values()]) {
            const voulu = cles.has(c.cle);
            if (c.mesh) c.mesh.visible = voulu;
            if (c.routes) c.routes.visible = voulu;
            if (c.veg.mesh) c.veg.mesh.visible = vegCles.has(c.cle);
            if (!vegCles.has(c.cle) && c.veg.mesh && maintenant - c.veg.voulu > CARRE_DEFAIT_S * 1000) defaireVegetation(c);
            if (!voulu && c.mesh && maintenant - c.voulu > CARRE_DEFAIT_S * 1000) defaireCarre(c);
            if (!voulu && c.etat !== 'charge' && c.veg.etat !== 'charge' && maintenant - c.voulu > CARRE_OUBLI_S * 1000
                && maintenant - c.veg.voulu > CARRE_OUBLI_S * 1000
                && Math.hypot((c.i + 0.5) * CARRE_M - px, (c.j + 0.5) * CARRE_M - py) > CARRE_OUBLI_M) {
                defaireCarre(c);
                defaireVegetation(c);
                if (c.donnees) retirerRoutes(c);
                carres.delete(c.cle);
            }
        }
    }
    // Un carré construit par image au plus, dans l'ordre de la route : la
    // voiture ne saccade pas quand une rafale arrive. Bâtiments seuls :
    // médiane de 3,8 ms à Paris et de 4,8 ms à Lyon, 14,7 ms au pire (398
    // bâtiments, Chrome sur Mac M4) ; routes et ponts compris, 5,6 ms à
    // Paris, 10,7 ms au pire. Une machine trois fois plus lente reste sous
    // les 50 ms.
    budgetConstruction = 0;
    let meilleur = null;
    for (const c of carres.values()) {
        if (c.etat === 'pret' && !c.mesh && c.altiPretes && c.voulu >= derniereSelectionCarres - 1
            && (!meilleur || c.priorite < meilleur.priorite)) meilleur = c;
    }
    // Et les arbres d'un carré par image, de même.
    let arbres = null;
    for (const c of carres.values()) {
        const g = c.veg;
        if (g.etat === 'pret' && !g.mesh && g.altiPretes && g.voulu >= derniereSelectionCarres - 1
            && (!arbres || g.priorite < arbres.veg.priorite)) arbres = c;
    }
    if (arbres && arbresActifs) {
        const t0 = performance.now();
        construireVegetation(arbres);
        dureesArbres.push([performance.now() - t0, arbres.veg.donnees.arbres.length]);
        if (dureesArbres.length > 200) dureesArbres.shift();
    }
    if (meilleur) {
        const t0 = performance.now();
        construireCarre(meilleur);
        budgetConstruction = performance.now() - t0;
        durees.push([budgetConstruction, meilleur.nbBatiments]);
        if (durees.length > 200) durees.shift();
    }
}
