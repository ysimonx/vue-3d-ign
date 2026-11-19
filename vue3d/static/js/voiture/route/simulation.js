// La conduite simulée, et son itinéraire jusqu'à `vers`.

import { PARAMS, VITESSE_SIMU_KMH, SIMU_LIMITE, HASARD_SIMU } from '../socle/parametres.js';
import { depuisLambert93, convergence } from '../socle/lambert93.js';
import { voiture, VERS, PAR, ITINERAIRE_BANDE_M, itineraire, poserItineraire } from '../socle/etat.js';
import { CARRE_M, carreDe } from '../carres/grille.js';
import {
    pointArete, capDepuis, ecartCap, permise, carrePret, suiteProbable, caler,
} from './graphe.js';
import { limiteDe } from './limitations.js';
import { recevoirPosition } from './voiture.js';

// Une voiture virtuelle roule sur le graphe à vitesse constante, tourne au
// hasard aux carrefours (la suite la plus probable deux fois sur trois),
// fait demi-tour au bout d'une impasse, et attend au bord de ce qui n'est
// pas encore lu. Elle donne un relevé par seconde, bruité comme un GPS : la
// page ne sait rien d'autre d'elle.

// --- Itinéraire de la simulation ---------------------------------------------------
// Vers `vers=lat,lon` (socle/etat), par le plus court chemin du graphe.
// `attente=1` : la voiture simulée attend au départ que la page l'en libère
// (window.__voiture.partir()) ; un film commence ainsi sur un sol chargé.
let simuPartie = PARAMS.get('attente') !== '1';
export function partirSimu() { simuPartie = true; }
// Coût d'un mètre selon l'importance BD TOPO (1 à 6) : les grands axes d'abord.
const POIDS_IMPORTANCE = [1, 1, 1, 1.1, 1.25, 1.5, 2];

function tasPousser(tas, e) {
    tas.push(e);
    for (let i = tas.length - 1; i > 0;) {
        const p = (i - 1) >> 1;
        if (tas[p][0] <= tas[i][0]) break;
        [tas[p], tas[i]] = [tas[i], tas[p]]; i = p;
    }
}
function tasPrendre(tas) {
    const haut = tas[0], dernier = tas.pop();
    if (tas.length) {
        tas[0] = dernier;
        for (let i = 0; ;) {
            const g = 2 * i + 1, d = g + 1;
            let m = i;
            if (g < tas.length && tas[g][0] < tas[m][0]) m = g;
            if (d < tas.length && tas[d][0] < tas[m][0]) m = d;
            if (m === i) break;
            [tas[m], tas[i]] = [tas[i], tas[m]]; i = m;
        }
    }
    return haut;
}

/** Le départ, les points de passage (`par`), l'arrivée. */
const jalons = () => [voiture.attendu, ...PAR, VERS];

/** Les carrés de la bande de chaque étape, d'un jalon au suivant, sont-ils tous lus ? */
function carresItinerairePrets() {
    const j = jalons();
    for (let i = 0; i < j.length - 1; i++) {
        const d = j[i], f = j[i + 1], l = Math.hypot(f.x - d.x, f.y - d.y) || 1;
        for (let t = 0; t <= l; t += CARRE_M / 2) {
            const x = d.x + (f.x - d.x) * t / l, y = d.y + (f.y - d.y) * t / l;
            for (const [ex, ey] of [[0, 0], [ITINERAIRE_BANDE_M, 0], [-ITINERAIRE_BANDE_M, 0], [0, ITINERAIRE_BANDE_M], [0, -ITINERAIRE_BANDE_M]]) {
                const c = carreDe(x + ex, y + ey);
                if (!c || !(c.etat === 'pret' || c.etat === 'hors')) return false;
            }
        }
    }
    return true;
}

/** L'itinéraire, d'un jalon au suivant, mis bout à bout ; null s'il manque un morceau. */
function calculerItineraire() {
    const cales = jalons().map(p => caler(p.x, p.y, 40, null));
    if (cales.some(c => !c)) return null;
    const etapes = [];
    for (let i = 0; i < cales.length - 1; i++) {
        const morceau = plusCourt(cales[i], cales[i + 1]);
        if (!morceau) return null;
        // Un point de passage au milieu d'une arête : elle finit un morceau
        // et commence le suivant. Prise à rebours (le fond d'une impasse),
        // elle reste deux fois : la voiture va au bout, puis revient.
        const der = etapes[etapes.length - 1];
        if (der && der.a === morceau[0].a && der.sens === morceau[0].sens) morceau.shift();
        etapes.push(...morceau);
    }
    let longueur = 0;
    for (const e of etapes) longueur += e.a.L;
    const arrivee = cales[cales.length - 1];
    return { etapes, depart: cales[0], fin: { a: arrivee.a, s: arrivee.s }, k: 0, longueur };
}

/** Le plus court chemin de `depart` à `arrivee` (calés), Dijkstra sur les nœuds du graphe : ses étapes, ou null. */
function plusCourt(depart, arrivee) {
    const poids = b => (POIDS_IMPORTANCE[b.importance] || 2) * (simu.evitees.has(b) ? 5 : 1);
    const dist = new Map(), prec = new Map(), tas = [];
    const pousser = (n, c, p) => {
        if (c >= (dist.get(n) ?? Infinity)) return;
        dist.set(n, c); prec.set(n, p); tasPousser(tas, [c, n]);
    };
    const a0 = depart.a, a2 = arrivee.a;
    if (a0.sens !== '-') pousser(a0.n1, (a0.L - depart.s) * poids(a0), { a: a0, sens: 1, de: null });
    if (a0.sens !== '+') pousser(a0.n0, depart.s * poids(a0), { a: a0, sens: -1, de: null });
    let meilleur = null;
    while (tas.length) {
        const [c, n] = tasPrendre(tas);
        if (c > (dist.get(n) ?? Infinity)) continue;
        if (meilleur && c >= meilleur.c) break;
        if (n === a2.n0 && a2.sens !== '-') {
            const t = c + arrivee.s * poids(a2);
            if (!meilleur || t < meilleur.c) meilleur = { c: t, n, sens: 1 };
        }
        if (n === a2.n1 && a2.sens !== '+') {
            const t = c + (a2.L - arrivee.s) * poids(a2);
            if (!meilleur || t < meilleur.c) meilleur = { c: t, n, sens: -1 };
        }
        for (const b of n.aretes) {
            if (b.n0 === b.n1 || !permise(b, n)) continue;
            pousser(b.n0 === n ? b.n1 : b.n0, c + b.L * poids(b), { a: b, sens: b.n0 === n ? 1 : -1, de: n });
        }
    }
    if (!meilleur) return null;
    const etapes = [{ a: a2, sens: meilleur.sens }];
    for (let n = meilleur.n; n;) {
        const p = prec.get(n);
        etapes.unshift({ a: p.a, sens: p.sens });
        n = p.de;
    }
    return etapes;
}

export const simu = { a: null, s: 0, sens: 1, dernier: -Infinity, etat: { capEntree: null }, v: 0, k: 0, arrive: false,
                      // Ce que la voiture simulée ne prend pas : chemins, voies réservées.
                      evitees: { has: b => b.nature === 'Chemin' || b.nature === 'Route empierrée'
                                           || !!(b.acces && b.acces.startsWith('Restreint')) } };
function gauss() { return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random()); }
// Avec un itinéraire, la voiture simulée ralentit avant un virage (à 90°,
// au tiers de sa vitesse) et s'arrête à l'arrivée ; sa vitesse suit en une
// seconde.
const VIRAGE_APPROCHE_M = 35, ARRIVEE_APPROCHE_M = 45;
/** La vitesse de croisière de la voiture simulée, en m/s : la limitation du tronçon, avec `vitesse=limite`. */
function vitesseMaxSimu() {
    if (!SIMU_LIMITE) return VITESSE_SIMU_KMH / 3.6;
    const l = limiteDe(simu.a, simu.sens);
    if (l) simu.limite = l.v;
    return (simu.limite || VITESSE_SIMU_KMH) / 3.6;
}
function vitesseVoulueSimu() {
    const vmax = vitesseMaxSimu();
    if (!itineraire || simu.arrive) return simu.arrive ? 0 : vmax;
    const a = simu.a, fin = simu.sens > 0 ? a.L - simu.s : simu.s;
    if (simu.k === itineraire.etapes.length - 1) {
        const reste = Math.abs(itineraire.fin.s - simu.s);
        return vmax * Math.min(Math.max(reste / ARRIVEE_APPROCHE_M, 0.15), 1);
    }
    const suite = itineraire.etapes[simu.k + 1];
    if (!suite || fin > VIRAGE_APPROCHE_M) return vmax;
    const n = simu.sens > 0 ? a.n1 : a.n0;
    const virage = Math.abs(ecartCap(capDepuis(suite.a, n), pointArete(a, simu.sens > 0 ? a.L : 0, simu.sens).cap));
    return vmax * Math.min(Math.max(1 - virage / 120, 0.33), 1);
}

export function majSimu(dt, maintenant) {
    if (VERS && !itineraire) {
        // En attendant l'itinéraire, la voiture attend au départ.
        if (maintenant - (simu.essaiItineraire || 0) > 1000 && carresItinerairePrets()) {
            simu.essaiItineraire = maintenant;
            poserItineraire(calculerItineraire());
            if (itineraire) {
                const e = itineraire.etapes[0];
                simu.a = e.a; simu.sens = e.sens; simu.s = itineraire.depart.s; simu.k = 0;
                voiture.recalculer = true;
            }
        }
        if (!itineraire) {
            if (maintenant - simu.dernier < 1000) return;
            simu.dernier = maintenant;
            const [lon, lat] = depuisLambert93(voiture.attendu.x, voiture.attendu.y);
            recevoirPosition({ coords: { latitude: lat, longitude: lon, accuracy: 5, speed: 0, heading: null } });
            return;
        }
    }
    if (!simu.a) {
        const d = voiture.attendu;
        const m = caler(d.x, d.y, 40, null);
        if (!m) return;
        simu.a = m.a; simu.s = m.s;
        simu.sens = m.a.sens === '-' ? -1 : 1;
    }
    simu.v += ((simuPartie ? vitesseVoulueSimu() : 0) - simu.v) * (1 - Math.exp(-dt / 1.0));
    let reste = simu.v * dt;
    let arrete = simu.arrive;
    for (let garde = 0; reste > 0 && garde < 20 && !simu.arrive; garde++) {
        const a = simu.a;
        if (itineraire && simu.k === itineraire.etapes.length - 1) {
            const jusqua = Math.abs(itineraire.fin.s - simu.s);
            if (reste >= jusqua) { simu.s = itineraire.fin.s; simu.arrive = true; arrete = true; break; }
        }
        const fin = simu.sens > 0 ? a.L - simu.s : simu.s;
        if (reste < fin) { simu.s += simu.sens * reste; reste = 0; break; }
        reste -= fin;
        simu.s = simu.sens > 0 ? a.L : 0;
        const n = simu.sens > 0 ? a.n1 : a.n0;
        if (!carrePret(n.x, n.y)) { arrete = true; break; }
        const choix = itineraire ? itineraire.etapes[++simu.k]
            : suiteProbable(a, simu.sens, n, simu.etat, simu.evitees, HASARD_SIMU);
        if (!choix) {
            if (itineraire) { simu.arrive = true; arrete = true; break; }
            simu.sens = -simu.sens; simu.etat.capEntree = null; continue;
        }
        simu.a = choix.a; simu.sens = choix.sens; simu.s = choix.sens > 0 ? 0 : choix.a.L;
    }
    if (maintenant - simu.dernier < 1000) return;
    simu.dernier = maintenant;
    // Sous terre, le GPS ne capte pas : la page file sur sa lancée.
    if (simu.a.sol < 0) return;
    const p = pointArete(simu.a, simu.s, simu.sens);
    const [lon, lat] = depuisLambert93(p.x + 2.5 * gauss(), p.y + 2.5 * gauss());
    recevoirPosition({ coords: { latitude: lat, longitude: lon, accuracy: 5,
        speed: arrete ? 0 : simu.v, heading: arrete ? null : (p.cap + convergence(lon) + 360) % 360 } });
}
