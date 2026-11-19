// Le graphe des routes BD TOPO, et la voiture calée dessus.

import { RAD } from '../socle/parametres.js';
import { voiture, itineraire } from '../socle/etat.js';
import { carreDe } from '../carres/grille.js';

// Les tronçons de tous les carrés lus, réunis par leurs extrémités (au
// décimètre près, la précision des carrés : celles d'un même nœud sont
// identiques), et indexés par cellules de 50 m pour caler la voiture.
export const noeuds = new Map(), aretes = new Map(), grille = new Map();
const CELLULE_M = 50;
// Compté à chaque carré ajouté ou retiré : ce qui se calcule sur le graphe
// (l'altitude sous terre, route/tunnels) se périme avec lui.
export let generationGraphe = 0;

function noeud(cle, x, y) {
    let n = noeuds.get(cle);
    if (!n) { n = { cle, x, y, aretes: [] }; noeuds.set(cle, n); }
    return n;
}
function cellules(a, k, faire) {
    const x0 = a.pts[2 * k], y0 = a.pts[2 * k + 1], x1 = a.pts[2 * k + 2], y1 = a.pts[2 * k + 3];
    for (let i = Math.floor(Math.min(x0, x1) / CELLULE_M); i <= Math.floor(Math.max(x0, x1) / CELLULE_M); i++) {
        for (let j = Math.floor(Math.min(y0, y1) / CELLULE_M); j <= Math.floor(Math.max(y0, y1) / CELLULE_M); j++) {
            faire(`${i},${j}`);
        }
    }
}

// Un tablier ne s'affaisse pas sous la droite qui joint ses deux bouts ; la
// BD TOPO en pose parfois l'intérieur sur la route qu'il franchit. Route de
// Simiane, au-dessus de la D6 : 231,9 et 231,0 m aux bouts, 227,9 au droit de
// l'autoroute, à 1,5 m de sa chaussée — « un tablier sacrément effondré sur
// la route », signalé depuis la Tesla le 24 octobre 2026. Sur les 415
// tronçons de pont du cache de prod, 22 creusent de plus d'un mètre sous
// cette droite, 10 de plus de 3 m ; le viaduc de Millau, de 0,4 à 0,8 m.
/** Relève en place les altitudes `z` d'un tablier (abscisses `cum`) au-dessus de la droite de ses bouts ; un sommet sans altitude la prend. */
export function releverTablier(z, cum) {
    const n = z.length, L = cum[n - 1];
    if (n < 3 || !(L > 0) || !Number.isFinite(z[0]) || !Number.isFinite(z[n - 1])) return z;
    for (let k = 1; k < n - 1; k++) {
        const corde = z[0] + (z[n - 1] - z[0]) * cum[k] / L;
        if (!(z[k] >= corde)) z[k] = corde;
    }
    return z;
}

// À un bout de pont, le RGE ALTI lisse la culée vers le vide qu'elle borde :
// la route au sol qui y arrive plongeait avant de remonter sur le tablier,
// de 5,3 m au bout du pont de la route de Simiane. Sur 450 sommets de routes
// au sol qui touchent un pont (cache de prod, le 24 octobre 2026), l'altitude
// BD TOPO passe le relief de 0,9 m en médiane, et de plus de 3 m pour 18 %
// d'entre eux, quand ailleurs elle s'y tient à ±2 m (5e et 95e centiles de
// 1 500 sommets pris au hasard, médiane −0,03 m). Sur APPROCHE_M depuis un
// bout de pont, une route au sol est posée au plus haut des deux.
export const APPROCHE_M = 30;
export const touchePont = n => !!n && n.aretes.some(b => b.sol > 0);
/** L'altitude BD TOPO de la route au sol `a` à l'abscisse `s`, à moins de APPROCHE_M d'un bout de pont ; NaN ailleurs. */
export function altitudeApproche(a, s) {
    if (a.sol !== 0) return NaN;
    if (!(s <= APPROCHE_M && touchePont(a.n0)) && !(a.L - s <= APPROCHE_M && touchePont(a.n1))) return NaN;
    return pointArete(a, s).z;
}

export function integrerRoutes(c) {
    generationGraphe++;
    const [ox, oy] = c.donnees.origine;
    for (const r of c.donnees.routes) {
        const deja = aretes.get(r.id);
        if (deja) { deja.carres.add(c.cle); continue; }
        const n = r.ligne.length / 3;
        if (n < 2) continue;
        const pts = new Float64Array(2 * n), z = new Float64Array(n), cum = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            pts[2 * k] = (ox * 10 + r.ligne[3 * k]) / 10;
            pts[2 * k + 1] = (oy * 10 + r.ligne[3 * k + 1]) / 10;
            z[k] = r.ligne[3 * k + 2] == null ? NaN : r.ligne[3 * k + 2] / 10;
            if (k) cum[k] = cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]);
        }
        if (r.sol > 0) releverTablier(z, cum);
        const cleDe = k => `${ox * 10 + r.ligne[3 * k]},${oy * 10 + r.ligne[3 * k + 1]}`;
        const a = { ...r, pts, z, cum, L: cum[n - 1], carres: new Set([c.cle]) };
        delete a.ligne;
        a.n0 = noeud(cleDe(0), pts[0], pts[1]);
        a.n1 = noeud(cleDe(n - 1), pts[2 * n - 2], pts[2 * n - 1]);
        if (a.L < 0.05) continue;
        a.n0.aretes.push(a);
        if (a.n1 !== a.n0) a.n1.aretes.push(a);
        aretes.set(r.id, a);
        for (let k = 0; k < n - 1; k++) cellules(a, k, cle => {
            let l = grille.get(cle);
            if (!l) grille.set(cle, l = []);
            l.push({ a, k });
        });
    }
}

export function retirerRoutes(c) {
    generationGraphe++;
    for (const r of c.donnees.routes) {
        const a = aretes.get(r.id);
        if (!a) continue;
        a.carres.delete(c.cle);
        if (a.carres.size) continue;
        aretes.delete(r.id);
        for (const nd of [a.n0, a.n1]) {
            nd.aretes = nd.aretes.filter(b => b !== a);
            if (!nd.aretes.length) noeuds.delete(nd.cle);
        }
        for (let k = 0; k < a.pts.length / 2 - 1; k++) cellules(a, k, cle => {
            const l = grille.get(cle);
            if (!l) return;
            const reste = l.filter(e => e.a !== a);
            if (reste.length) grille.set(cle, reste); else grille.delete(cle);
        });
    }
    c.donnees = null;
}

/** Point de l'arête `a` à l'abscisse `s`, et son cap (degrés, du nord du quadrillage) dans le sens `sens`. */
export function pointArete(a, s, sens = 1) {
    s = Math.min(Math.max(s, 0), a.L);
    let k = 0;
    while (k < a.cum.length - 2 && a.cum[k + 1] < s) k++;
    const l = a.cum[k + 1] - a.cum[k] || 1, u = (s - a.cum[k]) / l;
    const x0 = a.pts[2 * k], y0 = a.pts[2 * k + 1], x1 = a.pts[2 * k + 2], y1 = a.pts[2 * k + 3];
    const cap = Math.atan2((x1 - x0) * sens, (y1 - y0) * sens) / RAD;
    const z = a.z[k] + (a.z[k + 1] - a.z[k]) * u;
    return { x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u, cap, z, k };
}

/** Cap de l'arête au départ du nœud `n`, mesuré sur ses `l` premiers mètres. */
export function capDepuis(a, n, l = 15) {
    const sens = a.n0 === n ? 1 : -1;
    const p0 = pointArete(a, sens > 0 ? 0 : a.L), p1 = pointArete(a, sens > 0 ? Math.min(l, a.L) : a.L - Math.min(l, a.L));
    return Math.atan2(p1.x - p0.x, p1.y - p0.y) / RAD;
}
export const ecartCap = (a, b) => ((a - b + 540) % 360) - 180;
const memeVoie = (a, b) => (a.numero && a.numero === b.numero) || (a.nom && a.nom === b.nom);
export const permise = (b, n) => !(b.sens === '+' && b.n0 !== n) && !(b.sens === '-' && b.n1 !== n);

/**
 * Les suites possibles au nœud `n` pour qui arrive par `a` au cap `capArrivee`,
 * de la plus probable à la moins : tout droit, sur la même voie, de même
 * importance, en voiture. Les sens interdits sont écartés, le demi-tour aussi.
 */
function suites(a, n, capArrivee) {
    const options = [];
    for (const b of n.aretes) {
        if (b === a || b.n0 === b.n1 || !permise(b, n)) continue;
        const virage = Math.abs(ecartCap(capDepuis(b, n), capArrivee));
        if (virage > 160) continue;
        let score = virage + 12 * Math.abs(b.importance - a.importance);
        if (memeVoie(a, b)) score -= 30;
        if (b.nature === 'Chemin' || b.nature === 'Route empierrée') score += 40;
        if (b.nature === 'Bretelle' && a.nature !== 'Bretelle') score += 25;
        if (b.acces && b.acces.startsWith('Restreint') && !a.acces) score += 60;
        // Un cul-de-sac au bout du tronçon : à Rousset, la route prévue y
        // finissait au bout de 250 à 800 m quand la rue continuait ailleurs,
        // et plus rien ne se chargeait au-delà.
        const bout = b.n0 === n ? b.n1 : b.n0;
        if (bout.aretes.length === 1 && carrePret(bout.x, bout.y)) score += CUL_DE_SAC;
        options.push({ a: b, sens: b.n0 === n ? 1 : -1, score });
    }
    return options.sort((u, v) => u.score - v.score);
}

export const carrePret = (x, y) => carreDe(x, y)?.etat === 'pret';
const CUL_DE_SAC = 80;

// Sur un rond-point, la suite « la plus droite » est l'anneau lui-même : la
// route prévue en faisait le tour et s'arrêtait sur un tronçon déjà vu (au
// rond-point des Champs-Élysées). On en sort par la branche la plus proche
// du cap d'entrée, à SORTIE_ROND_POINT près, sinon on continue de tourner.
const SORTIE_ROND_POINT = 60, TOURS_ROND_POINT_MAX = 12;

/**
 * La suite de `a` au nœud `n` : la plus probable (suites), hors des tronçons
 * déjà `vues`, avec la règle des ronds-points. `etat` garde le cap d'entrée
 * sur l'anneau ; `hasard`, entre 0 et 1, fait prendre une autre branche
 * hors des ronds-points (la simulation). Null s'il n'y en a pas.
 */
export function suiteProbable(a, sens, n, etat, vues = null, hasard = 0) {
    const capArrivee = pointArete(a, sens > 0 ? a.L : 0, sens).cap;
    const options = suites(a, n, capArrivee).filter(o => !vues || !vues.has(o.a));
    if (!options.length) return null;
    let choix = options[0];
    if (a.nature === 'Rond-point' && etat.capEntree != null) {
        etat.tours = (etat.tours || 0) + 1;
        const sorties = options.filter(o => o.a.nature !== 'Rond-point')
            .map(o => ({ o, ecart: Math.abs(ecartCap(capDepuis(o.a, n), etat.capEntree)) }))
            .sort((u, v) => u.ecart - v.ecart);
        const anneau = options.find(o => o.a.nature === 'Rond-point');
        choix = sorties.length && (sorties[0].ecart < SORTIE_ROND_POINT || !anneau || etat.tours > TOURS_ROND_POINT_MAX)
            ? sorties[0].o : anneau || options[0];
    } else if (hasard && options.length > 1 && Math.random() < hasard) {
        choix = options[1 + Math.floor(Math.random() * (options.length - 1))];
    }
    if (choix.a.nature === 'Rond-point' && a.nature !== 'Rond-point') { etat.capEntree = capArrivee; etat.tours = 0; }
    else if (choix.a.nature !== 'Rond-point') etat.capEntree = null;
    return choix;
}

// Passé sa longueur, la route prévue va jusqu'à la sortie du tunnel où elle
// se trouve : sans GPS sous terre, la voiture y file jusqu'au jour
// (route/voiture), et le tunnel de l'A86 fait 10 km, celui du Fréjus 13.
const TRAVERSEE_TUNNEL_MAX_M = 15000;

/**
 * La route prévue depuis `depart` ({a, s, sens}), sur `longueur` mètres :
 * à chaque carrefour, la suite la plus probable. Elle s'arrête à une
 * impasse, ou au bord de ce qui est lu (`fin` = 'inconnu', `bout` : le
 * carré à demander).
 */
export function cheminDepuis(depart, longueur) {
    const xs = [], ys = [], cum = [], parcours = [];
    let { a, s, sens } = depart;
    // Sur l'itinéraire de la simulation : ses étapes, jusqu'à l'arrivée.
    let k = itineraire ? itineraire.etapes.findIndex((e, i) => i >= itineraire.k && e.a === a && e.sens === sens) : -1;
    if (k >= 0) itineraire.k = k;
    const p0 = pointArete(a, s, sens);
    xs.push(p0.x); ys.push(p0.y); cum.push(0);
    let total = 0, fin = 'complet', bout = null;
    const vues = new Set(), etat = { capEntree: depart.capEntree ?? null };
    const ajouter = (x, y) => {
        const l = Math.hypot(x - xs[xs.length - 1], y - ys[ys.length - 1]);
        if (l < 0.01) return;
        total += l;
        xs.push(x); ys.push(y); cum.push(total);
    };
    for (;;) {
        parcours.push({ a, sens, debut: total - (sens > 0 ? s : a.L - s) });
        vues.add(a);
        if (k >= 0 && k === itineraire.etapes.length - 1) {
            const sf = itineraire.fin.s;
            if (sens > 0) { for (let q = 1; q < a.cum.length; q++) if (a.cum[q] > s && a.cum[q] < sf) ajouter(a.pts[2 * q], a.pts[2 * q + 1]); }
            else { for (let q = a.cum.length - 2; q >= 0; q--) if (a.cum[q] < s && a.cum[q] > sf) ajouter(a.pts[2 * q], a.pts[2 * q + 1]); }
            const pf = pointArete(a, sf, sens);
            ajouter(pf.x, pf.y);
            fin = 'arrivee';
            bout = [pf.x, pf.y];
            break;
        }
        if (sens > 0) { for (let k = 1; k < a.cum.length; k++) if (a.cum[k] > s) ajouter(a.pts[2 * k], a.pts[2 * k + 1]); }
        else { for (let k = a.cum.length - 2; k >= 0; k--) if (a.cum[k] < s) ajouter(a.pts[2 * k], a.pts[2 * k + 1]); }
        if (total >= longueur && (a.sol >= 0 || total >= longueur + TRAVERSEE_TUNNEL_MAX_M)) break;
        const n = sens > 0 ? a.n1 : a.n0;
        const suite = k >= 0 ? itineraire.etapes[++k] : suiteProbable(a, sens, n, etat, vues);
        if (!suite) {
            fin = carrePret(n.x, n.y) ? 'impasse' : 'inconnu';
            bout = [n.x, n.y];
            break;
        }
        ({ a, sens } = suite);
        s = sens > 0 ? 0 : a.L;
    }
    if (!bout) bout = [xs[xs.length - 1], ys[ys.length - 1]];
    return { xs, ys, cum, longueur: total, fin, bout, parcours };
}

/** Point du chemin à la distance `d` de son début, avec son cap ; null hors du chemin. */
export function pointDuChemin(ch, d) {
    if (!ch || !ch.xs.length) return null;
    // Un chemin d'un seul point : la voiture calée pile sur l'arrivée. Le
    // préchargement et le panneau y cherchaient un point, et la page
    // s'arrêtait là (le film de la Bastille à la Nation, à l'arrivée).
    if (ch.xs.length < 2) return { x: ch.xs[0], y: ch.ys[0], cap: voiture.cap };
    d = Math.min(Math.max(d, 0), ch.longueur);
    let lo = 0, hi = ch.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ch.cum[m] <= d) lo = m; else hi = m; }
    const l = ch.cum[hi] - ch.cum[lo] || 1, u = (d - ch.cum[lo]) / l;
    const x = ch.xs[lo] + (ch.xs[hi] - ch.xs[lo]) * u, y = ch.ys[lo] + (ch.ys[hi] - ch.ys[lo]) * u;
    // Le cap sur 6 m de part et d'autre : une polyligne fine tourne par à-coups.
    const k0 = Math.max(d - 6, 0), k1 = Math.min(d + 6, ch.longueur);
    const pa = k0 === d ? { x, y } : pointBrut(ch, k0), pb = k1 === d ? { x, y } : pointBrut(ch, k1);
    const cap = Math.hypot(pb.x - pa.x, pb.y - pa.y) > 0.01
        ? Math.atan2(pb.x - pa.x, pb.y - pa.y) / RAD
        : Math.atan2(ch.xs[hi] - ch.xs[lo], ch.ys[hi] - ch.ys[lo]) / RAD;
    return { x, y, cap };
}
function pointBrut(ch, d) {
    let lo = 0, hi = ch.cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ch.cum[m] <= d) lo = m; else hi = m; }
    const l = ch.cum[hi] - ch.cum[lo] || 1, u = (d - ch.cum[lo]) / l;
    return { x: ch.xs[lo] + (ch.xs[hi] - ch.xs[lo]) * u, y: ch.ys[lo] + (ch.ys[hi] - ch.ys[lo]) * u };
}
/** L'arête du chemin à la distance `d`, et l'abscisse sur elle. */
export function areteDuChemin(ch, d) {
    let e = ch.parcours[0];
    for (const p of ch.parcours) { if (p.debut <= d) e = p; else break; }
    const s = e.sens > 0 ? d - e.debut : e.a.L - (d - e.debut);
    return { a: e.a, s: Math.min(Math.max(s, 0), e.a.L), sens: e.sens };
}

/**
 * Cale un relevé sur la route : le tronçon le plus proche dans le rayon de
 * sa précision, dont le sens s'accorde au cap quand on roule, et qui
 * prolonge de préférence la route prévue. Null hors de toute route.
 */
export function caler(x, y, precision, cap) {
    // Large : en ville, le GPS s'égare de 20 à 30 m quand il en annonce 8 ;
    // le cap et la route prévue départagent les voisines.
    const rayon = Math.min(Math.max(precision * 2.5, 25), 60);
    const vus = new Set();
    const surChemin = new Set(voiture.chemin ? voiture.chemin.parcours.map(p => p.a) : []);
    let meilleur = null;
    for (let i = Math.floor((x - rayon) / CELLULE_M); i <= Math.floor((x + rayon) / CELLULE_M); i++) {
        for (let j = Math.floor((y - rayon) / CELLULE_M); j <= Math.floor((y + rayon) / CELLULE_M); j++) {
            for (const { a, k } of grille.get(`${i},${j}`) || []) {
                const cleSeg = a.id + ':' + k;
                if (vus.has(cleSeg)) continue;
                vus.add(cleSeg);
                const x0 = a.pts[2 * k], y0 = a.pts[2 * k + 1], x1 = a.pts[2 * k + 2], y1 = a.pts[2 * k + 3];
                const lx = x1 - x0, ly = y1 - y0, l2 = lx * lx + ly * ly || 1;
                const u = Math.min(Math.max(((x - x0) * lx + (y - y0) * ly) / l2, 0), 1);
                const px = x0 + lx * u, py = y0 + ly * u;
                const d = Math.hypot(x - px, y - py);
                if (d > rayon) continue;
                const capSeg = Math.atan2(lx, ly) / RAD;
                let sens = 1, penalite = 0;
                if (cap != null) {
                    const ecartDirect = Math.abs(ecartCap(cap, capSeg)), ecartInverse = Math.abs(ecartCap(cap, capSeg + 180));
                    const directOk = a.sens !== '-', inverseOk = a.sens !== '+';
                    if (directOk && (!inverseOk || ecartDirect <= ecartInverse)) { sens = 1; penalite = ecartDirect; }
                    else { sens = -1; penalite = ecartInverse; }
                    penalite = 25 * (1 - Math.cos(penalite * RAD));
                } else if (voiture.ancre && voiture.ancre.a === a) {
                    sens = voiture.ancre.sens;
                }
                if (a.sol < 0) penalite += 6;            // un tunnel ne se prend pas par erreur
                const score = d + penalite - (surChemin.has(a) ? 8 : 0);
                if (!meilleur || score < meilleur.score) {
                    meilleur = { score, a, sens, s: a.cum[k] + Math.sqrt(l2) * u, x: px, y: py };
                }
            }
        }
    }
    // Sur l'itinéraire, son sens : à l'arrêt, sans cap, la voiture se
    // calait dans l'autre, et la route prévue repartait au hasard.
    // Une arête prise deux fois, à l'aller et au retour (le fond d'une
    // impasse, sur un trajet par `par`) : son passage à venir, dans le sens
    // du cap s'il y en a un ; le premier calait le retour à contresens.
    if (meilleur && itineraire) {
        const aVenir = (e, i) => i >= itineraire.k && e.a === meilleur.a;
        const e = (cap != null && itineraire.etapes.find((e, i) => aVenir(e, i) && e.sens === meilleur.sens))
            || itineraire.etapes.find(aVenir) || itineraire.etapes.find(e => e.a === meilleur.a);
        if (e) meilleur.sens = e.sens;
    }
    return meilleur;
}
