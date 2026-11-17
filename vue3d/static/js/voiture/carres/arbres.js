// Les arbres des carrés.

import * as THREE from 'three';
import { HAUTEUR_MIN_TRONC, alea } from '../../commun/regles.js';
import { PARAMS } from '../socle/parametres.js';
import { depuisLambert93 } from '../socle/lambert93.js';
import { ancres, ancrer } from '../socle/monde.js';
import { scene } from '../socle/rendu.js';
import { NIVEAU_PROCHE, preparerAltitudes, altitudeL93 } from '../sol/altitudes.js';
import { CARRE_M, VEGETATION_VERSION } from './grille.js';
import { ajourer } from './batiments.js';

// Ceux de la scène (vue3d/houppiers.py), découpés sur le MNH du LiDAR HD
// carré par carré (/api/vegetation) : 1 à 5 s de lecture par carré au
// serveur, contre 0,2 s pour les bâtiments. D'où une bande plus étroite :
// les arbres à plus de 250 m de la route se perdent dans la photo.
export const VEG_AUTOUR_M = 300, VEG_COULOIR_M = 250, VEG_DEVANT_M = 2000, VEG_IMPASSE_M = 500;
export const VEG_PARALLELE = 2;
export let vegEnVol = 0;
export let arbresActifs = PARAMS.get('arbres') !== '0';
// Les ports de la page (PORTS de index.html) : palette, part de fût nu, et
// une forme simple. Le serveur classe chaque arbre (carres.port).
const PORTS_ARBRES = {
    feuillu:    { base: 0x5e8a3e, cime: 0x9cc06a, tronc: 0.42, forme: 'boule' },
    chene_vert: { base: 0x3f6b33, cime: 0x6f9a55, tronc: 0.38, forme: 'boule' },
    pin:        { base: 0x4f7a4a, cime: 0x8fb27a, tronc: 0.52, forme: 'boule' },
    conifere:   { base: 0x3e6a3c, cime: 0x6d9a63, tronc: 0.12, forme: 'cone' },
    peuplier:   { base: 0x76a24e, cime: 0xb2d37f, tronc: 0.38, forme: 'colonne' },
    arbuste:    { base: 0x6a8e44, cime: 0xa2c46e, tronc: 0, forme: 'boule' },
};
for (const p of Object.values(PORTS_ARBRES)) { p.base = new THREE.Color(p.base); p.cime = new THREE.Color(p.cime); }
// arbres=pleins, pour les films (outils/film-trajet.mjs), où le nombre de
// faces compte moins que l'allure : voir plus bas.
const PLEINS = PARAMS.get('arbres') === 'pleins';
// Peu de faces : jusqu'à 9 000 arbres par carré à Gordes (garrigue comprise).
// Pleins, un houppier bosselé (80 faces, chaque sommet écarté de ±20 % selon
// sa position, le dessous aplati), tourné au hasard : lisses, à 20 faces et
// tous orientés pareil, ils faisaient des baudruches au bout d'un bâton.
function houppierBossele() {
    const g = new THREE.IcosahedronGeometry(1, 1), p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        // Arrondi : un sommet partagé par plusieurs faces reçoit le même écart.
        const k = 0.8 + 0.4 * alea(Math.round(v.x * 1000) + 0.37 * Math.round(v.z * 1000), Math.round(v.y * 1000));
        v.multiplyScalar(k);
        if (v.y < 0) v.y *= 0.7;
        p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
}
const GEO_BOULE = PLEINS ? houppierBossele() : new THREE.IcosahedronGeometry(1, 0);   // 80 ou 20 faces
const AXE_Y = new THREE.Vector3(0, 1, 0);
const GEO_CONE = new THREE.ConeGeometry(1, 1, 7, 1, true).translate(0, 0.5, 0);  // 7 faces
const GEO_FUT = new THREE.CylinderGeometry(0.6, 1, 1, 5, 1, true).translate(0, 0.5, 0);
// Translucides, à la demande de Yannick : opaques, les houppiers cachaient
// la route et les façades derrière eux. Moins que dans la scène (30 %), où
// le bâti est le sujet : vus de la route, à 30 %, ils ne se lisaient plus.
// depthWrite reste, sinon les faces d'un même houppier se mêleraient.
// Pleins : translucides et tramés dans le cône de la caméra à la voiture, les
// arbres qui bordent la route n'étaient plus qu'un voile flou à l'écran d'un
// film (Rousset, caméra reculée à 95 m).
const OPACITE_FEUILLAGE = PLEINS ? 0.9 : 0.45, OPACITE_FUT = PLEINS ? 1 : 0.6;
// Effacés à moins de 15 m de la caméra, estompés jusqu'à 35 m. Pleins, à
// 6 et 14 m : la caméra d'un film, à 40 m de la voiture, tramait sinon les
// arbres du bas de l'image.
const ARBRES_PROCHES_M = PLEINS ? [6, 14] : [15, 35];
const MAT_FEUILLAGE = ajourer(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true,
    transparent: true, opacity: OPACITE_FEUILLAGE }), 'feuillage', ARBRES_PROCHES_M, !PLEINS);
const MAT_FUT = ajourer(new THREE.MeshLambertMaterial({ color: 0x6b5240, transparent: true, opacity: OPACITE_FUT }),
    'fut', ARBRES_PROCHES_M, !PLEINS);

export async function chargerVegetation(c) {
    const g = c.veg;
    g.etat = 'charge';
    vegEnVol++;
    try {
        const reponse = await fetch(`api/vegetation?i=${c.i}&j=${c.j}&v=${VEGETATION_VERSION}`);
        if (reponse.status === 422) { g.etat = 'hors'; return; }
        if (!reponse.ok) {
            g.etat = 'erreur';
            g.reessai = performance.now() + (Number(reponse.headers.get('retry-after')) || 20) * 1000;
            return;
        }
        g.donnees = await reponse.json();
        g.etat = 'pret';
        const coins = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) =>
            depuisLambert93((c.i + u) * CARRE_M, (c.j + v) * CARRE_M));
        const lons = coins.map(p => p[0]), lats = coins.map(p => p[1]);
        preparerAltitudes(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats), NIVEAU_PROCHE)
            .then(() => { g.altiPretes = true; }, () => { g.altiPretes = true; });
    } catch (e) {
        g.etat = 'erreur';
        g.reessai = performance.now() + 20000;
    } finally {
        vegEnVol--;
    }
}

/**
 * Les arbres d'un carré en trois maillages instanciés (houppiers ronds,
 * cônes, fûts) : trois appels de dessin. Un arbre pose sur le relief au
 * pied de son sommet ; son houppier part du haut du fût nu de son port.
 */
export function construireVegetation(c) {
    const d = c.veg.donnees;
    const cx = (c.i + 0.5) * CARRE_M, cy = (c.j + 0.5) * CARRE_M;
    const [ox, oy] = d.origine;
    const arbres = d.arbres, ports = d.ports.map(n => PORTS_ARBRES[n] || PORTS_ARBRES.feuillu);
    let nBoules = 0, nCones = 0, nFuts = 0;
    for (const a of arbres) {
        const p = ports[a[4]];
        if (p.forme === 'cone') nCones++; else nBoules++;
        if (a[2] >= HAUTEUR_MIN_TRONC * 10 && p.tronc >= 0.1) nFuts++;
    }
    const groupe = new THREE.Group();
    const boules = new THREE.InstancedMesh(GEO_BOULE, MAT_FEUILLAGE, Math.max(nBoules, 1));
    const cones = new THREE.InstancedMesh(GEO_CONE, MAT_FEUILLAGE, Math.max(nCones, 1));
    const futs = new THREE.InstancedMesh(GEO_FUT, MAT_FUT, Math.max(nFuts, 1));
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), ech = new THREE.Vector3();
    const tour = new THREE.Quaternion();
    const teinte = new THREE.Color();
    let ib = 0, ic = 0, it = 0;
    for (const a of arbres) {
        const x = ox + a[0] / 10, y = oy + a[1] / 10, h = a[2] / 10, r = Math.max(a[3] / 10, 0.5);
        const p = ports[a[4]];
        let sol = altitudeL93(x, y);
        if (!Number.isFinite(sol)) sol = 0;
        const lx = x - cx, lz = cy - y;
        const bas = h < HAUTEUR_MIN_TRONC ? 0 : h * p.tronc;
        const al = alea(x, y);
        teinte.copy(p.base).lerp(p.cime, 0.25 + 0.5 * al).multiplyScalar(0.92 + 0.12 * alea(y, x));
        if (p.forme === 'cone') {
            pos.set(lx, sol + bas - 0.3, lz); ech.set(r, h - bas + 0.3, r);
            cones.setMatrixAt(ic, m.compose(pos, q, ech));
            cones.setColorAt(ic++, teinte);
        } else {
            const largeur = p.forme === 'colonne' ? r * 0.65 : r;
            pos.set(lx, sol + (bas + h) / 2, lz); ech.set(largeur, Math.max((h - bas) / 2, 0.4), largeur);
            boules.setMatrixAt(ib, m.compose(pos, PLEINS ? tour.setFromAxisAngle(AXE_Y, 2 * Math.PI * alea(y, x + 0.5)) : q, ech));
            boules.setColorAt(ib++, teinte);
        }
        if (h >= HAUTEUR_MIN_TRONC && p.tronc >= 0.1) {
            const hT = h * p.tronc + Math.min(1, h * 0.1), rT = Math.min(Math.max(h / 20, 0.18), 0.6);
            pos.set(lx, sol - 0.5, lz); ech.set(rT, hT + 0.5, rT);
            futs.setMatrixAt(it++, m.compose(pos, q, ech));
        }
    }
    for (const [maillage, n] of [[boules, ib], [cones, ic], [futs, it]]) {
        maillage.count = n;
        if (!n) continue;
        maillage.instanceMatrix.needsUpdate = true;
        if (maillage.instanceColor) maillage.instanceColor.needsUpdate = true;
        maillage.computeBoundingSphere();
        groupe.add(maillage);
    }
    c.veg.mesh = groupe;
    c.veg.nb = arbres.length;
    ancrer(groupe, cx, cy);
    groupeArbres.add(groupe);
}

export function defaireVegetation(c) {
    const g = c.veg;
    if (!g.mesh) return;
    groupeArbres.remove(g.mesh);
    ancres.delete(g.mesh);
    for (const maillage of g.mesh.children) maillage.dispose();
    g.mesh = null;
}

const groupeArbres = new THREE.Group();
scene.add(groupeArbres);
const boutonArbres = document.getElementById('b-arbres');
function majBoutonArbres() { boutonArbres.classList.toggle('on', arbresActifs); }
boutonArbres.addEventListener('click', () => {
    arbresActifs = !arbresActifs;
    groupeArbres.visible = arbresActifs;
    majBoutonArbres();
});
majBoutonArbres();
