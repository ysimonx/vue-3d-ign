// Les routes, les ponts, les viaducs et passerelles, et les têtes de tunnel des carrés.

import * as THREE from 'three';
import { scene, courber } from '../socle/rendu.js';
import { altitudeL93 } from '../sol/altitudes.js';
import { CARRE_M } from './grille.js';
import { noeuds, capDepuis, releverTablier, APPROCHE_M, touchePont } from '../route/graphe.js';
import { estEntree, altitudeAuNoeud } from '../route/tunnels.js';
import { fond } from '../sol/sol.js';

// Les tronçons du carré, découpés à son bord : un viaduc à cheval sur trois
// carrés est dessiné par chacun, et ne disparaît pas sous la voiture quand
// le premier est défait. Au sol, des rubans à la largeur de chaussée de la
// BD TOPO, comme dans la scène (largeurs, teintes : construireRoutes de
// index.html), effacés sur le plan, qui dessine déjà les routes et leurs
// noms. Un pont (position au-dessus du sol) est un tablier à l'altitude de
// ses tronçons — celle du tablier : de 598 à 676 m sur le viaduc de Millau,
// sa pente de 3 % —, avec ses parapets, et des piles là où le vide dépasse
// PILE_VIDE_M. Le relief du RGE ALTI, sol nu, passe dessous. Les viaducs
// ferroviaires, le métro aérien et les passerelles qui enjambent la route
// (`ponts` du carré) ont le même tablier, sur leur ballast ou leur dalle, à
// l'altitude BD TOPO, qui est aussi la leur. Un tunnel n'a ici que ses têtes,
// un mur de béton percé d'une voûte noire à chaque entrée, à l'altitude de
// la route (route/tunnels) ; on le voit sous terre quand la route prévue y
// passe (interface/ruban).
const ROUTE_LEVE_M = 0.12, ROUTE_PAS_M = 5, PONT_PAS_M = 6;
const PONT_EPAISSEUR_M = 1.4, PARAPET_M = 0.9, PILE_ECART_M = 45, PILE_VIDE_M = 3, PILE_EPAISSEUR_M = 1.6;
// Une tête de tunnel à vue d'œil : une voûte large de la chaussée et de
// 1,25 m de part et d'autre, droite sur 3,5 m puis cintrée (2,5 m de flèche
// au plus), dans un mur qui la déborde de 2 m et descend 2 m sous la route.
const TETE_DEBORD_M = 1.25, TETE_PIEDROIT_M = 3.5, TETE_FLECHE_M = 2.5, TETE_MUR_M = 2, TETE_ENFOUIE_M = 2;
const COULEUR_NOIR_TUNNEL = new THREE.Color(0x141618);
export const LARGEUR_PAR_NATURE = {
    'Type autoroutier': 7, 'Route à 1 chaussée': 3, 'Route à 2 chaussées': 5.5, 'Rond-point': 4, 'Bretelle': 4,
    'Route empierrée': 3, 'Chemin': 2.5,
};
const NATURES_TERRE = new Set(['Route empierrée', 'Chemin']);
// À 60 % : opaques, les rubans effaçaient l'asphalte et les marquages de la
// photo (A7, avenue George V) ; la route reste lisible, la photo passe.
const OPACITE_ROUTE = 0.6;
const MAT_ROUTE = courber(new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true,
    opacity: OPACITE_ROUTE, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -4 }));
const MAT_PONT = courber(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
// D'un seul côté, vers le dehors : vue du tunnel, la tête bouchait la sortie
// de Fourvière de son noir, et son dos sortait de la colline.
const MAT_TETE = courber(new THREE.MeshLambertMaterial({ vertexColors: true }));
const COULEUR_ROUTE = new THREE.Color(0x5f636a), COULEUR_CHEMIN = new THREE.Color(0x9c8a6e);
const COULEUR_BETON = new THREE.Color(0xc9c5bb);
// Les viaducs ferroviaires (4 m par voie, comme la scène) sur leur ballast ;
// les passerelles, à leur largeur BD TOPO ou à celle de leur nature, avec un
// garde-corps d'homme et sans piles : légères, elles franchissent d'un bond
// (la passerelle Simone-de-Beauvoir, 190 m au-dessus de la Seine), et la
// règle des ponts lui en plantait quatre dans le fleuve.
const COULEUR_BALLAST = new THREE.Color(0x857c73), COULEUR_PASSERELLE = new THREE.Color(0xb3ada3);
const LARGEUR_PASSERELLE = { 'Sentier': 2.5, 'Escalier': 2, 'Piste cyclable': 3 };
const GARDE_CORPS_M = 1.1;
export const groupeRoutes = new THREE.Group();
scene.add(groupeRoutes);
export const montrerRoutesAuSol = () => { MAT_ROUTE.visible = fond === 'ortho'; };

/** Les morceaux d'une polyligne (x, y, z absolus) dans le carré [x0, x1] × [y0, y1] (Liang-Barsky). */
function decouper(xs, ys, zs, x0, y0, x1, y1) {
    const morceaux = [];
    let cour = null;
    for (let k = 0; k + 1 < xs.length; k++) {
        const dx = xs[k + 1] - xs[k], dy = ys[k + 1] - ys[k];
        const p = [-dx, dx, -dy, dy], q = [xs[k] - x0, x1 - xs[k], ys[k] - y0, y1 - ys[k]];
        let t0 = 0, t1 = 1, dedans = true;
        for (let i = 0; i < 4 && dedans; i++) {
            if (p[i] === 0) dedans = q[i] >= 0;
            else if (p[i] < 0) t0 = Math.max(t0, q[i] / p[i]);
            else t1 = Math.min(t1, q[i] / p[i]);
        }
        if (!dedans || t0 >= t1) { cour = null; continue; }
        const point = t => [xs[k] + dx * t, ys[k] + dy * t, zs[k] + (zs[k + 1] - zs[k]) * t];
        if (!cour || t0 > 0) { cour = [point(t0)]; morceaux.push(cour); }
        cour.push(point(t1));
        if (t1 < 1) cour = null;
    }
    return morceaux;
}

/** Points tous les `pas` mètres le long d'un morceau, avec leur direction (ux, uy). */
function echantillonner(morceau, pas) {
    const pts = [];
    for (let k = 0; k + 1 < morceau.length; k++) {
        const [ax, ay, az] = morceau[k], [bx, by, bz] = morceau[k + 1];
        const l = Math.hypot(bx - ax, by - ay);
        if (l < 0.01) continue;
        const n = Math.max(1, Math.ceil(l / pas));
        for (let i = k && pts.length ? 1 : 0; i <= n; i++) {
            const t = i / n;
            pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t, z: az + (bz - az) * t });
        }
    }
    for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
        const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        pts[i].ux = (b.x - a.x) / l; pts[i].uy = (b.y - a.y) / l;
    }
    return pts;
}

export function construireRoutes(c, cx, cy) {
    const d = c.donnees;
    const [ox, oy] = d.origine;
    const x0 = c.i * CARRE_M, y0 = c.j * CARRE_M;
    const sol = { pos: [], nor: [], col: [] }, pont = { pos: [], nor: [], col: [] }, tetes = { pos: [], nor: [], col: [] };
    // Un triangle en coordonnées de la scène relatives au centre du carré,
    // tourné pour que sa normale suive `n`.
    const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), vn = new THREE.Vector3();
    const tri = (cible, A, B, C, n, coul) => {
        v1.set(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
        v2.set(C[0] - A[0], C[1] - A[1], C[2] - A[2]);
        vn.crossVectors(v1, v2);
        if (vn.lengthSq() < 1e-10) return;
        const P = vn.x * n[0] + vn.y * n[1] + vn.z * n[2] < 0 ? [A, C, B] : [A, B, C];
        for (const q of P) { cible.pos.push(q[0], q[1], q[2]); cible.nor.push(n[0], n[1], n[2]); cible.col.push(coul.r, coul.g, coul.b); }
    };
    const quad = (cible, A, B, C, D, n, coul) => { tri(cible, A, B, C, n, coul); tri(cible, A, C, D, n, coul); };
    const ici = (x, y, alt) => [x - cx, alt, cy - y];
    // Un polygone plan (t le long de (vx, vy), h au-dessus de `alt`), troué.
    const plaque = (contour, trous, px, py, vx, vy, alt, n, coul) => {
        const tous = contour.concat(...trous);
        for (const [i0, i1, i2] of THREE.ShapeUtils.triangulateShape(contour, trous)) {
            const [A, B, C] = [tous[i0], tous[i1], tous[i2]].map(q => ici(px + vx * q.x, py + vy * q.x, alt + q.y));
            tri(tetes, A, B, C, n, coul);
        }
    };
    const entrees = new Set();
    const tetesDeTunnel = r => {
        const nb = r.ligne.length / 3;
        for (const k of [0, nb - 1]) {
            const nd = noeuds.get(`${ox * 10 + r.ligne[3 * k]},${oy * 10 + r.ligne[3 * k + 1]}`);
            // Chaque entrée une fois, par le carré où elle se trouve.
            if (!nd || entrees.has(nd) || !estEntree(nd)) continue;
            if (nd.x < x0 || nd.x >= x0 + CARRE_M || nd.y < y0 || nd.y >= y0 + CARRE_M) continue;
            const a = nd.aretes.find(b => b.sol < 0), z = altitudeAuNoeud(nd);
            if (!a || !Number.isFinite(z)) continue;
            entrees.add(nd);
            const cap = capDepuis(a, nd) * Math.PI / 180, ux = Math.sin(cap), uy = Math.cos(cap);
            const largeur = (a.largeur > 0 ? a.largeur : LARGEUR_PAR_NATURE[a.nature] || 3) + 2 * TETE_DEBORD_M;
            const fleche = Math.min(largeur / 2, TETE_FLECHE_M), haut = TETE_PIEDROIT_M + fleche + TETE_MUR_M;
            const l = largeur / 2, L = l + TETE_MUR_M;
            const voute = [new THREE.Vector2(-l, 0), new THREE.Vector2(-l, TETE_PIEDROIT_M)];
            for (let q = 1; q < 12; q++) {
                const t = Math.PI * (1 - q / 12);
                voute.push(new THREE.Vector2(Math.cos(t) * l, TETE_PIEDROIT_M + Math.sin(t) * fleche));
            }
            voute.push(new THREE.Vector2(l, TETE_PIEDROIT_M), new THREE.Vector2(l, 0));
            const mur = [new THREE.Vector2(-L, -TETE_ENFOUIE_M), new THREE.Vector2(L, -TETE_ENFOUIE_M),
                         new THREE.Vector2(L, haut), new THREE.Vector2(-L, haut)];
            // Face au dehors ; le noir de la voûte un peu en retrait, dedans.
            const dehors = [-ux, 0, uy];
            plaque(mur, [voute], nd.x + ux * 0.3, nd.y + uy * 0.3, -uy, ux, z, dehors, COULEUR_BETON);
            plaque(voute, [], nd.x + ux * 1.5, nd.y + uy * 1.5, -uy, ux, z, dehors, COULEUR_NOIR_TUNNEL);
        }
    };
    // Un tablier : dessus, sous-face, rives, parapets, et des piles là où le vide dépasse PILE_VIDE_M.
    const tablier = (morceau, w, dessus, parapet, piles = true) => {
        const pts = echantillonner(morceau, PONT_PAS_M);
        let prec = null, parcouru = 0, pile = PILE_ECART_M / 2;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            let z = p.z;
            if (!Number.isFinite(z)) { const a = altitudeL93(p.x, p.y); z = (Number.isFinite(a) ? a : 0) + 5; }
            const gx = -p.uy * w / 2, gy = p.ux * w / 2;
            const haut = [ici(p.x + gx, p.y + gy, z + 0.05), ici(p.x - gx, p.y - gy, z + 0.05)];
            const bas = [ici(p.x + gx, p.y + gy, z - PONT_EPAISSEUR_M), ici(p.x - gx, p.y - gy, z - PONT_EPAISSEUR_M)];
            const garde = [ici(p.x + gx, p.y + gy, z + parapet), ici(p.x - gx, p.y - gy, z + parapet)];
            const lat = [-p.uy, 0, -p.ux];   // vers la gauche, en coordonnées de la scène
            if (prec) {
                quad(pont, prec.haut[1], haut[1], haut[0], prec.haut[0], [0, 1, 0], dessus);
                quad(pont, prec.bas[0], bas[0], bas[1], prec.bas[1], [0, -1, 0], COULEUR_BETON);
                quad(pont, prec.haut[0], haut[0], bas[0], prec.bas[0], lat, COULEUR_BETON);
                quad(pont, prec.haut[1], haut[1], bas[1], prec.bas[1], [-lat[0], 0, -lat[2]], COULEUR_BETON);
                quad(pont, prec.haut[0], haut[0], garde[0], prec.garde[0], lat, COULEUR_BETON);
                quad(pont, prec.haut[1], haut[1], garde[1], prec.garde[1], [-lat[0], 0, -lat[2]], COULEUR_BETON);
                parcouru += Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y);
            }
            prec = { haut, bas, garde };
            if (!piles || parcouru < pile) continue;
            pile += PILE_ECART_M;
            const a = altitudeL93(p.x, p.y);
            if (!Number.isFinite(a) || z - PONT_EPAISSEUR_M - a < PILE_VIDE_M) continue;
            // Une pile, un voile de la moitié du tablier, dans l'axe.
            const e = PILE_EPAISSEUR_M / 2, l = Math.max(w * 0.25, e);
            const coin = (u, v, alt) => ici(p.x + p.ux * u - p.uy * v, p.y + p.uy * u + p.ux * v, alt);
            const pied = a - 1, tete = z - PONT_EPAISSEUR_M;
            const c4 = [[e, l], [e, -l], [-e, -l], [-e, l]];
            for (let k = 0; k < 4; k++) {
                const [u0, w0] = c4[k], [u1, w1] = c4[(k + 1) % 4];
                const nu = (u0 + u1) / 2, nv = (w0 + w1) / 2, nl = Math.hypot(nu, nv) || 1;
                const nx = (p.ux * nu - p.uy * nv) / nl, ny = (p.uy * nu + p.ux * nv) / nl;
                quad(pont, coin(u0, w0, pied), coin(u1, w1, pied), coin(u1, w1, tete), coin(u0, w0, tete),
                     [nx, 0, -ny], COULEUR_BETON);
            }
        }
    };
    /**
     * Les morceaux d'une ligne du carré (décimètres depuis son origine) dans
     * son emprise. Un tablier, relevé ; une route au sol ne garde son altitude
     * qu'à l'approche d'un pont (route/graphe, APPROCHE_M), −∞ ailleurs.
     */
    const morceaux = (ligne, tablier = false) => {
        const n = ligne.length / 3, xs = [], ys = [], zs = [], cum = [];
        for (let k = 0; k < n; k++) {
            xs.push(ox + ligne[3 * k] / 10); ys.push(oy + ligne[3 * k + 1] / 10);
            zs.push(ligne[3 * k + 2] == null ? NaN : ligne[3 * k + 2] / 10);
            cum.push(k ? cum[k - 1] + Math.hypot(xs[k] - xs[k - 1], ys[k] - ys[k - 1]) : 0);
        }
        if (tablier) releverTablier(zs, cum);
        else {
            const cle = k => `${ox * 10 + ligne[3 * k]},${oy * 10 + ligne[3 * k + 1]}`;
            const debut = touchePont(noeuds.get(cle(0))), fin = touchePont(noeuds.get(cle(n - 1)));
            const L = cum[n - 1];
            // Un sommet au bout de l'approche : entre deux sommets éloignés,
            // elle ne vaudrait qu'au bout du tablier.
            const inserer = d => {
                let k = 1;
                while (k < cum.length && cum[k] < d) k++;
                if (k >= cum.length || cum[k] - d < 0.01 || d - cum[k - 1] < 0.01) return;
                const t = (d - cum[k - 1]) / (cum[k] - cum[k - 1]);
                xs.splice(k, 0, xs[k - 1] + (xs[k] - xs[k - 1]) * t);
                ys.splice(k, 0, ys[k - 1] + (ys[k] - ys[k - 1]) * t);
                zs.splice(k, 0, zs[k - 1] + (zs[k] - zs[k - 1]) * t);
                cum.splice(k, 0, d);
            };
            if (debut) inserer(APPROCHE_M);
            if (fin) inserer(L - APPROCHE_M);
            for (let k = 0; k < cum.length; k++) {
                const pres = (debut && cum[k] <= APPROCHE_M + 0.01) || (fin && L - cum[k] <= APPROCHE_M + 0.01);
                if (!pres || !Number.isFinite(zs[k])) zs[k] = -1e4;
            }
        }
        return decouper(xs, ys, zs, x0, y0, x0 + CARRE_M, y0 + CARRE_M);
    };
    for (const r of d.routes) {
        if (r.sol < 0) { if (!r.fictif) tetesDeTunnel(r); continue; }
        if (r.fictif || r.nature === 'Bac ou liaison maritime') continue;
        const largeur = r.largeur > 0 ? r.largeur : LARGEUR_PAR_NATURE[r.nature] || 3;
        for (const morceau of morceaux(r.ligne, r.sol > 0)) {
            if (r.sol === 0) {
                const coul = NATURES_TERRE.has(r.nature) ? COULEUR_CHEMIN : COULEUR_ROUTE;
                const pts = echantillonner(morceau, ROUTE_PAS_M);
                let prec = null;
                for (const p of pts) {
                    const a = altitudeL93(p.x, p.y);
                    const alt = Math.max(Number.isFinite(a) ? a : 0, p.z) + ROUTE_LEVE_M;
                    const gx = -p.uy * largeur / 2, gy = p.ux * largeur / 2;
                    const g = ici(p.x + gx, p.y + gy, alt), dr = ici(p.x - gx, p.y - gy, alt);
                    if (prec) quad(sol, prec[1], dr, g, prec[0], [0, 1, 0], coul);
                    prec = [g, dr];
                }
                continue;
            }
            tablier(morceau, largeur + 1, COULEUR_ROUTE, PARAPET_M);
        }
    }
    // Ce qui passe au-dessus de la route : viaducs ferroviaires, métro
    // aérien, passerelles.
    for (const r of d.ponts || []) {
        const w = r.largeur > 0 ? r.largeur : LARGEUR_PASSERELLE[r.nature] || 2.5;
        for (const morceau of morceaux(r.ligne, true)) {
            tablier(morceau, w, r.ferre ? COULEUR_BALLAST : COULEUR_PASSERELLE, r.ferre ? PARAPET_M : GARDE_CORPS_M, r.ferre);
        }
    }
    const groupe = new THREE.Group();
    for (const [donnees, materiau] of [[sol, MAT_ROUTE], [pont, MAT_PONT], [tetes, MAT_TETE]]) {
        if (!donnees.pos.length) continue;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(donnees.pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(donnees.nor, 3));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(donnees.col, 3));
        geo.computeBoundingSphere();
        const m = new THREE.Mesh(geo, materiau);
        // Avant les arbres translucides, qui se mêlent ainsi par-dessus.
        if (materiau === MAT_ROUTE) m.renderOrder = -1;
        groupe.add(m);
    }
    return groupe;
}
