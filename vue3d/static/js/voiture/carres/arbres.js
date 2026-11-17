// Les arbres des carrés.

import * as THREE from 'three';
import { HAUTEUR_MIN_TRONC, alea } from '../../commun/regles.js';
import { PARAMS } from '../socle/parametres.js';
import { depuisLambert93 } from '../socle/lambert93.js';
import { ancres, ancrer } from '../socle/monde.js';
import { scene } from '../socle/rendu.js';
import { NIVEAU_PROCHE, preparerAltitudes, altitudeL93 } from '../sol/altitudes.js';
import { voiture } from '../socle/etat.js';
import { CARRE_M, VEGETATION_VERSION, carres } from './grille.js';
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
// Une boule lisse à 20 faces, la même pour tous, faisait à l'écran une
// baudruche au bout d'un bâton ; pleine (90 %), un bloc « bien plus moche que
// dans la Tesla ». De près, le houppier est fait de cinq touffes bosselées
// qui se chevauchent, toujours translucides, et la ramure (le fût prolongé,
// cinq branches) se voit au travers ; l'arbre est tourné au hasard. Les
// films (arbres=film, outils/film-trajet.mjs) les veulent toutes ainsi.
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
// Le détail selon la distance : près de la voiture, les touffes (100 faces)
// et la ramure (60) ; plus loin, la boule de 20 faces et le cône de 7, où
// l'on ne voit plus la différence. Toutes en touffes, voiture arrêtée à
// Gordes (jusqu'à 9 000 arbres par carré, garrigue comprise), la vue
// dessinait 7,96 M triangles au lieu de 1,33 M.
const GEO_TOUFFES = reunir(TOUFFES.map(([x, y, z, r], i) => touffe(x, y, z, r, 17 * i)));
const GEO_RAMURE = ramure();
const GEO_BOULE = new THREE.IcosahedronGeometry(1, 0);
const AXE_Y = new THREE.Vector3(0, 1, 0);
const GEO_CONE = new THREE.ConeGeometry(1, 1, 7, 1, true).translate(0, 0.5, 0);
const GEO_FUT = new THREE.CylinderGeometry(0.6, 1, 1, 5, 1, true).translate(0, 0.5, 0);
// Un carré passe au détail quand la voiture s'en approche à moins du seuil,
// et le quitte à 100 m au-delà : l'écart évite qu'il bascule sans cesse
// quand la voiture longe le seuil. À Gordes (jusqu'à 9 000 arbres par carré),
// voiture arrêtée : 2,23 M triangles pour le seul carré de la voiture,
// 3,38 M à 150 m, 4,22 M à 300 m, 6,33 M tout détaillé, 1,33 M sans détail.
// Le seuil suit les images par seconde, comme la résolution (interface/
// boucle.js) : un cran plus bas quand une image prend plus de 33 ms en
// moyenne sur trois secondes, avant que la résolution ne baisse (40 ms) ;
// un cran plus haut après dix secondes sous 20 ms. Entre les deux, il tient :
// sinon il monterait et descendrait sans fin. -1 : aucun carré détaillé.
const CRANS_DETAIL_M = [-1, 60, 150, 300];
let cranDetail = 2;
const detailMesure = { somme: 0, n: 0, debut: 0, aise: 0 };
// Translucides, à la demande de Yannick : opaques, les houppiers cachaient
// la route et les façades derrière eux. Moins que dans la scène (30 %), où
// le bâti est le sujet : vus de la route, à 30 %, ils ne se lisaient plus.
// depthWrite reste, sinon les faces d'un même houppier se mêleraient. Le fût
// et la ramure à 85 % : à 60 %, la ramure ne se lisait pas au travers.
const OPACITE_FEUILLAGE = 0.45, OPACITE_FUT = 0.85;
// Effacés à moins de 15 m de la caméra, estompés jusqu'à 35 m. Film : à 6
// et 14 m, et sans le tramage du cône de la caméra à la voiture : la caméra
// d'un film, à 30–40 m de la voiture, tramait sinon les arbres qui bordent
// la route en un voile flou (Rousset).
const ARBRES_PROCHES_M = FILM ? [6, 14] : [15, 35];
const MAT_FEUILLAGE = ajourer(new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true,
    transparent: true, opacity: OPACITE_FEUILLAGE }), 'feuillage', ARBRES_PROCHES_M, !FILM);
const MAT_FUT = ajourer(new THREE.MeshLambertMaterial({ color: 0x6b5240, transparent: true, opacity: OPACITE_FUT }),
    'fut', ARBRES_PROCHES_M, !FILM);
const MAT_RAMURE = ajourer(new THREE.MeshLambertMaterial({ color: 0x5b4535, flatShading: true,
    transparent: true, opacity: OPACITE_FUT }), 'ramure', ARBRES_PROCHES_M, !FILM);

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
 * Les arbres d'un carré en maillages instanciés : de loin, boules et cônes ;
 * de près, touffes et ramure ; le fût, toujours. Un arbre pose sur le relief
 * au pied de son sommet ; son houppier part du haut du fût nu de son port.
 * De près, les conifères sont en touffes, en colonne comme des cyprès : en
 * cônes translucides, ceux qui frôlaient la caméra faisaient des triangles
 * verts géants devant la montagne (D17 à Puyloubier, D56 vers Rousset).
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
    const instances = (geo, mat, n) => new THREE.InstancedMesh(geo, mat, Math.max(n, 1));
    const boules = FILM ? null : instances(GEO_BOULE, MAT_FEUILLAGE, nBoules);
    const cones = FILM ? null : instances(GEO_CONE, MAT_FEUILLAGE, nCones);
    const touffes = instances(GEO_TOUFFES, MAT_FEUILLAGE, nBoules + nCones);
    const ramures = instances(GEO_RAMURE, MAT_RAMURE, nFuts);
    const futs = instances(GEO_FUT, MAT_FUT, nFuts);
    // La ramure avant le feuillage : il écrit sa profondeur, et la cacherait.
    ramures.renderOrder = -1;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), ech = new THREE.Vector3();
    const tour = new THREE.Quaternion();
    const teinte = new THREE.Color();
    let ib = 0, ic = 0, id = 0, ir = 0, it = 0;
    for (const a of arbres) {
        const x = ox + a[0] / 10, y = oy + a[1] / 10, h = a[2] / 10, r = Math.max(a[3] / 10, 0.5);
        const p = ports[a[4]];
        let sol = altitudeL93(x, y);
        if (!Number.isFinite(sol)) sol = 0;
        const lx = x - cx, lz = cy - y;
        const bas = h < HAUTEUR_MIN_TRONC ? 0 : h * p.tronc;
        const tronc = h >= HAUTEUR_MIN_TRONC && p.tronc >= 0.1;
        const al = alea(x, y);
        teinte.copy(p.base).lerp(p.cime, 0.25 + 0.5 * al).multiplyScalar(0.92 + 0.12 * alea(y, x));
        if (p.forme === 'cone') {
            if (cones) {
                pos.set(lx, sol + bas - 0.3, lz); ech.set(r, h - bas + 0.3, r);
                cones.setMatrixAt(ic, m.compose(pos, q, ech));
                cones.setColorAt(ic++, teinte);
            }
        } else if (boules) {
            const largeur = p.forme === 'colonne' ? r * 0.65 : r;
            pos.set(lx, sol + (bas + h) / 2, lz); ech.set(largeur, Math.max((h - bas) / 2, 0.4), largeur);
            boules.setMatrixAt(ib, m.compose(pos, q, ech));
            boules.setColorAt(ib++, teinte);
        }
        const largeur = p.forme === 'boule' ? r : r * 0.65;
        pos.set(lx, sol + (bas + h) / 2, lz); ech.set(largeur, Math.max((h - bas) / 2, 0.4), largeur);
        m.compose(pos, tour.setFromAxisAngle(AXE_Y, 2 * Math.PI * alea(y, x + 0.5)), ech);
        touffes.setMatrixAt(id, m);
        touffes.setColorAt(id++, teinte);
        if (tronc) {
            ramures.setMatrixAt(ir++, m);
            const hT = h * p.tronc + Math.min(1, h * 0.1), rT = Math.min(Math.max(h / 20, 0.18), 0.6);
            pos.set(lx, sol - 0.5, lz); ech.set(rT, hT + 0.5, rT);
            futs.setMatrixAt(it++, m.compose(pos, q, ech));
        }
    }
    const groupe = new THREE.Group();
    const maillages = [[boules, ib], [cones, ic], [touffes, id], [ramures, ir], [futs, it]].filter(([mm]) => mm);
    for (const [maillage, n] of maillages) {
        maillage.count = n;
        if (!n) continue;
        maillage.instanceMatrix.needsUpdate = true;
        if (maillage.instanceColor) maillage.instanceColor.needsUpdate = true;
        maillage.computeBoundingSphere();
        groupe.add(maillage);
    }
    const g = c.veg;
    g.mesh = groupe;
    g.maillages = maillages.map(([mm]) => mm);
    g.loin = [boules, cones].filter(Boolean);
    g.pres = [touffes, ramures];
    g.detail = undefined;
    montrerDetail(c, FILM || distanceCarre(c) < CRANS_DETAIL_M[cranDetail]);
    g.nb = arbres.length;
    ancrer(groupe, cx, cy);
    groupeArbres.add(groupe);
}

function montrerDetail(c, oui) {
    const g = c.veg;
    if (g.detail === oui) return;
    g.detail = oui;
    for (const mm of g.pres) mm.visible = oui;
    for (const mm of g.loin) mm.visible = !oui;
}

/** De la voiture au carré (0 dedans), en mètres. */
function distanceCarre(c) {
    const v = voiture, x = v.vue ? v.x : v.attendu?.x, y = v.vue ? v.y : v.attendu?.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
    const dx = Math.max(c.i * CARRE_M - x, 0, x - (c.i + 1) * CARRE_M);
    const dy = Math.max(c.j * CARRE_M - y, 0, y - (c.j + 1) * CARRE_M);
    return Math.hypot(dx, dy);
}

/** Le cran du détail, d'après la durée moyenne d'une image sur trois secondes. */
function adapterDetail(dt, maintenant) {
    const m = detailMesure;
    if (!m.debut) m.debut = maintenant;
    m.somme += dt; m.n++;
    if (maintenant - m.debut < 3000) return;
    const moyenne = m.somme / m.n * 1000;
    if (moyenne > 33) {
        cranDetail = Math.max(cranDetail - 1, 0);
        m.aise = 0;
    } else if (moyenne < 20) {
        m.aise += maintenant - m.debut;
        if (m.aise >= 10000) { cranDetail = Math.min(cranDetail + 1, CRANS_DETAIL_M.length - 1); m.aise = 0; }
    } else {
        m.aise = 0;
    }
    m.somme = 0; m.n = 0; m.debut = maintenant;
}

/** Pour les essais : le seuil du détail en mètres (-1 : aucun). */
export const seuilDetailArbres = () => CRANS_DETAIL_M[cranDetail];

/** À chaque image : le détail aux carrés proches de la voiture, la boule aux autres. */
export function majDetailArbres(dt, maintenant) {
    if (FILM) return;
    adapterDetail(dt, maintenant);
    const seuil = CRANS_DETAIL_M[cranDetail];
    for (const c of carres.values()) {
        if (!c.veg.mesh) continue;
        const d = distanceCarre(c);
        if (d < seuil) montrerDetail(c, true);
        else if (d > seuil + 100) montrerDetail(c, false);
    }
}

export function defaireVegetation(c) {
    const g = c.veg;
    if (!g.mesh) return;
    groupeArbres.remove(g.mesh);
    ancres.delete(g.mesh);
    for (const maillage of g.maillages) maillage.dispose();
    g.mesh = null;
    g.maillages = g.loin = g.pres = null;
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
