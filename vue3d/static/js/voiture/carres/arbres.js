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
// arbres=film, pour les films (outils/film-trajet.mjs), où le nombre de
// faces compte moins que l'allure : une boule lisse à 20 faces, la même pour
// tous, faisait à l'écran une baudruche au bout d'un bâton ; pleine (90 %),
// un bloc « bien plus moche que dans la Tesla ». Le houppier y devient cinq
// touffes bosselées qui se chevauchent, toujours translucides, et la ramure
// (le fût prolongé, cinq branches) se voit au travers ; l'arbre est tourné
// au hasard.
const FILM = PARAMS.get('arbres') === 'film';
/** Une touffe : un icosaèdre dont chaque sommet s'écarte de ±20 % selon sa position. */
function touffe(cx, cy, cz, r, graine) {
    const g = new THREE.IcosahedronGeometry(1, 0), p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        // Arrondi : un sommet partagé par plusieurs faces reçoit le même écart.
        const k = 0.8 + 0.4 * alea(Math.round(v.x * 1000) + graine, Math.round(v.y * 1000) + 0.37 * Math.round(v.z * 1000));
        p.setXYZ(i, cx + v.x * r * k, cy + v.y * r * k, cz + v.z * r * k);
    }
    return g;
}
/** Des géométries non indexées, réunies en une. */
function reunir(geos) {
    const n = geos.reduce((s, g) => s + g.attributes.position.array.length, 0), tout = new Float32Array(n);
    let k = 0;
    for (const g of geos) { tout.set(g.attributes.position.array, k); k += g.attributes.position.array.length; g.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tout, 3));
    g.computeVertexNormals();
    return g;
}
// Dans le repère du houppier, la sphère unité que chaque arbre étire à sa
// largeur et à sa hauteur : une touffe au sommet, quatre autour, plus bas.
const TOUFFES = [[0, 0.3, 0, 0.62], [0.45, -0.2, 0.12, 0.55], [-0.38, -0.15, 0.32, 0.55],
                 [-0.12, -0.22, -0.46, 0.55], [0.28, 0.05, -0.32, 0.5]];
/** Une branche : un cylindre effilé à cinq pans, de `a` (rayon ra) à `b` (rayon rb). */
function branche(a, b, ra, rb) {
    const d = new THREE.Vector3().subVectors(b, a), l = d.length();
    const g = new THREE.CylinderGeometry(rb, ra, l, 5, 1, true).toNonIndexed();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return g;
}
/** Le fût prolongé jusqu'au haut du houppier, et cinq branches qui montent vers son bord. */
function ramure() {
    const geos = [branche(new THREE.Vector3(0, -0.9, 0), new THREE.Vector3(0, 0.55, 0), 0.07, 0.025)];
    for (let i = 0; i < 5; i++) {
        const t = 2 * Math.PI * (i / 5 + 0.1 * alea(i, 3)), y = -0.6 + 0.12 * i;
        geos.push(branche(new THREE.Vector3(0, y, 0), new THREE.Vector3(0.7 * Math.cos(t), y + 0.45, 0.7 * Math.sin(t)),
            0.045, 0.015));
    }
    return reunir(geos);
}
// Peu de faces : jusqu'à 9 000 arbres par carré à Gordes (garrigue comprise).
const GEO_BOULE = FILM ? reunir(TOUFFES.map(([x, y, z, r], i) => touffe(x, y, z, r, 17 * i)))
    : new THREE.IcosahedronGeometry(1, 0);                                       // 100 ou 20 faces
const GEO_RAMURE = FILM ? ramure() : null;                                       // 60 faces
const AXE_Y = new THREE.Vector3(0, 1, 0);
const GEO_CONE = new THREE.ConeGeometry(1, 1, 7, 1, true).translate(0, 0.5, 0);  // 7 faces
const GEO_FUT = new THREE.CylinderGeometry(0.6, 1, 1, 5, 1, true).translate(0, 0.5, 0);
// Translucides, à la demande de Yannick : opaques, les houppiers cachaient
// la route et les façades derrière eux. Moins que dans la scène (30 %), où
// le bâti est le sujet : vus de la route, à 30 %, ils ne se lisaient plus.
// depthWrite reste, sinon les faces d'un même houppier se mêleraient.
// Film : le fût et la ramure plus marqués, pour se lire au travers.
const OPACITE_FEUILLAGE = 0.45, OPACITE_FUT = FILM ? 0.85 : 0.6;
// Effacés à moins de 15 m de la caméra, estompés jusqu'à 35 m. Film : à 6
// et 14 m, et sans le tramage du cône de la caméra à la voiture : la caméra
// d'un film, à 30–40 m de la voiture, tramait sinon les arbres qui bordent
// la route en un voile flou (Rousset).
const ARBRES_PROCHES_M = FILM ? [6, 14] : [15, 35];
const MAT_FEUILLAGE = ajourer(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true,
    transparent: true, opacity: OPACITE_FEUILLAGE }), 'feuillage', ARBRES_PROCHES_M, !FILM);
const MAT_FUT = ajourer(new THREE.MeshLambertMaterial({ color: 0x6b5240, transparent: true, opacity: OPACITE_FUT }),
    'fut', ARBRES_PROCHES_M, !FILM);
const MAT_RAMURE = FILM ? ajourer(new THREE.MeshLambertMaterial({ color: 0x5b4535, flatShading: true,
    transparent: true, opacity: OPACITE_FUT }), 'ramure', ARBRES_PROCHES_M, false) : null;

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
    let nBoules = 0, nCones = 0, nFuts = 0, nRamures = 0;
    for (const a of arbres) {
        const p = ports[a[4]];
        if (p.forme === 'cone') nCones++; else nBoules++;
        if (a[2] >= HAUTEUR_MIN_TRONC * 10 && p.tronc >= 0.1) {
            nFuts++;
            if (p.forme !== 'cone') nRamures++;
        }
    }
    const groupe = new THREE.Group();
    const boules = new THREE.InstancedMesh(GEO_BOULE, MAT_FEUILLAGE, Math.max(nBoules, 1));
    const cones = new THREE.InstancedMesh(GEO_CONE, MAT_FEUILLAGE, Math.max(nCones, 1));
    const futs = new THREE.InstancedMesh(GEO_FUT, MAT_FUT, Math.max(nFuts, 1));
    // La ramure avant le feuillage : il écrit sa profondeur, et la cacherait.
    const ramures = FILM ? new THREE.InstancedMesh(GEO_RAMURE, MAT_RAMURE, Math.max(nRamures, 1)) : null;
    if (ramures) ramures.renderOrder = -1;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), ech = new THREE.Vector3();
    const tour = new THREE.Quaternion();
    const teinte = new THREE.Color();
    let ib = 0, ic = 0, it = 0, ir = 0;
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
            boules.setMatrixAt(ib, m.compose(pos, FILM ? tour.setFromAxisAngle(AXE_Y, 2 * Math.PI * alea(y, x + 0.5)) : q, ech));
            boules.setColorAt(ib++, teinte);
            if (ramures && h >= HAUTEUR_MIN_TRONC && p.tronc >= 0.1) ramures.setMatrixAt(ir++, m);
        }
        if (h >= HAUTEUR_MIN_TRONC && p.tronc >= 0.1) {
            const hT = h * p.tronc + Math.min(1, h * 0.1), rT = Math.min(Math.max(h / 20, 0.18), 0.6);
            pos.set(lx, sol - 0.5, lz); ech.set(rT, hT + 0.5, rT);
            futs.setMatrixAt(it++, m.compose(pos, q, ech));
        }
    }
    for (const [maillage, n] of [[boules, ib], [cones, ic], [futs, it], ...(ramures ? [[ramures, ir]] : [])]) {
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
