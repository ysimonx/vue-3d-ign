// La végétation : chargement, maillages par tuile, forme simple en mouvement,
// bouton.

import * as THREE from 'three';
import { ARTEFACT, ERREUR_SCENE, chargementArtefact } from '../socle/chargement.js';
import { toLocal } from '../socle/projection.js';
import { ySol, ENFONCEMENT } from '../terrain/etat.js';
import { scene, camera } from '../socle/rendu.js';
import { sphereEnglobante } from '../geometrie/normales.js';
import { CIBLE } from '../batiments/etat.js';
import {
    groupeVegetation, vegPrete, vegElements, poserVegetation, poserReconstructionVegetation,
    marquerVegetationReglee,
} from './etat.js';
import { majCiblesSurvol } from '../interface/survol.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { OUVRAGES, groupeOuvrages, ouvragesEnVolume } from '../couches/ouvrages.js';
import { NUAGE, pointsNuage } from '../couches/nuage.js';
import { TEX_ECORCE } from './textures.js';
import {
    aUnTronc, gabaritTronc, nouveauTampon, facesHouppier, sommetsHouppier, ajouterHouppier,
    facesHouppierSimple, sommetsHouppierSimple, ajouterHouppierSimple,
} from './formes.js';

// La BD TOPO dit OÙ est la végétation mais jamais sa hauteur : `zone_de_vegetation`
// n'expose que la nature et la géométrie. La hauteur vient du MNH LiDAR HD, une
// grille de hauteurs au-dessus du sol. Le MNH ne distingue pas un arbre d'un mur :
// on retire donc les emprises bâties, déjà chargées ici, et on garde le reste.
//

// Les matériaux de la végétation, et la géométrie des troncs, partagée.
// Très transparent : le sujet de la vue est le bâti, le feuillage n'est là que
// pour situer l'ombrage et les masques. À 0,72 un bois dense masquait les
// façades qu'on cherche à lire derrière, à 0,45 il les assombrissait encore.
// depthWrite reste actif, sinon les faces d'un même houppier se dessineraient
// dans un ordre arbitraire.
const OPACITE_VEGETATION = 0.30;
// Matériau blanc piloté par les couleurs de sommet : le dégradé, sombre à la
// base et clair au sommet, est cuit dans la géométrie. Un vert uniforme lit
// comme du caoutchouc.
export const MAT_FEUILLAGE = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, transparent: true, opacity: OPACITE_VEGETATION,
    roughness: 0.95, flatShading: true });
// Masses indéterminées : gris-vert désaturé, pour signaler un obstacle sans
// attirer l'œil avant les arbres.
export const MAT_MASSE = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, transparent: true, opacity: OPACITE_VEGETATION,
    roughness: 1, flatShading: true });
// Le tronc s'efface en montant : presque opaque au pied, il ancre l'arbre au
// sol, et se perd dans le feuillage. Opaque d'un bout à l'autre, il se lisait
// comme un poteau à travers un houppier transparent à 30 % — 2 009 arbres sur
// 2 160 en ont un à Gordes, 2,5 m de fût nu en médiane. Comparé sur la même
// vue de Gordes à un tronc à 60 % d'opacité, deux fois plus fin et plus clair,
// ou absent : à 60 % ou affiné, il restait un poteau ; sans lui, le houppier
// flottait. L'opacité suit la hauteur du cylindre, de TRONC_OPACITE_PIED à
// TRONC_OPACITE_HAUT, dans une couleur de sommet à quatre composantes ;
// l'ombre portée reste celle d'un tronc plein.
const TRONC_OPACITE_PIED = 0.75;
const TRONC_OPACITE_HAUT = 0.05;
// depthWrite coupé et dessiné avant le feuillage (renderOrder, construireVegetation) :
// sa partie presque invisible ne masque pas le houppier qui l'entoure.
export const MAT_TRONC = new THREE.MeshStandardMaterial({
    color: 0x6b5240, map: TEX_ECORCE, roughness: 1,
    vertexColors: true, transparent: true, depthWrite: false });
// Sans couvercles : celui du haut est dans le feuillage, presque invisible
// (TRONC_OPACITE_HAUT), celui du bas sous le sol (ENFONCEMENT). Ils faisaient
// la moitié des 0,44 million de triangles des troncs à Porquerolles en zone
// de 1 000 m — 2,7 ms d'une image de 15 ms sous Metal, sans Retina.
export const GEO_TRONC = (() => {
    const g = new THREE.CylinderGeometry(0.34, 0.78, 1, 7, 1, true);
    const pos = g.attributes.position, c = new Float32Array(4 * pos.count);
    for (let i = 0; i < pos.count; i++) {
        const t = pos.getY(i) + 0.5;                    // 0 au pied, 1 en haut
        c.set([1, 1, 1, TRONC_OPACITE_PIED + (TRONC_OPACITE_HAUT - TRONC_OPACITE_PIED) * t], 4 * i);
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 4));
    return g;
})();

/**
 * Hauteur de la toiture du bâtiment visé, en mètres.
 *
 * Sert de référence au masque solaire : c'est là que seraient posés des
 * capteurs. C'est le bâtiment visé (trouverCible). Faute de bâtiment à moins
 * de RAYON_VISE, on retombe sur 0 — le masque redevient alors un angle mesuré
 * depuis le sol, ce que la note du panneau signale.
 */
function hauteurReference() {
    const h = CIBLE ? features_hauteur({ props: CIBLE.p }) : null;
    return h != null && h > 0 ? h : 0;
}

/** Hauteur BD TOPO de l'anneau : faîtage si connu, hauteur globale sinon. */
function features_hauteur(anneau) {
    const p = anneau.props || {};
    if (p.altitude_maximale_toit != null && p.altitude_minimale_sol != null) {
        return p.altitude_maximale_toit - p.altitude_minimale_sol;
    }
    return p.hauteur != null ? p.hauteur : null;
}

poserReconstructionVegetation(construireVegetation);
// Numéro de la dernière pose de chaque maillage fusionné (placerVegetation) :
// la forme simple d'un maillage est reposée quand il l'a été.
let posesVegetation = 0;
poserSurLeRelief({ placer: () => placerVegetation(), apresBatiments: true });

// Côté des tuiles de la végétation, en mètres. Chaque tuile a ses maillages,
// qui passent en forme simple pendant le mouvement quand elle est loin de la
// caméra (montrerVegetation), et que three.js écarte quand elle sort du champ.
// Durée d'une image en mouvement (DISTANCE_DETAIL), sous Metal, 1 728 × 1 080
// en Retina, Porquerolles en zone de 1 000 m, vue par défaut / rapprochée :
//
//   tuiles de  80 m  (154 maillages)   19,0 / 20,5 ms
//   tuiles de 125 m  ( 77 maillages)   19,6 / 18,5 ms
//   tuiles de 250 m  ( 32 maillages)   20,9 / 20,7 ms
//
// À l'arrêt, tout détaillé, les appels de dessin en plus ne se mesurent pas :
// 22,4 à 23,1 ms, contre 22,8 en un seul maillage.
const TUILE_VEGETATION = 125;

/** Houppiers et masses dessinés : la vue et l'export IFC. */
export function vegetationDessinee() {
    // Un rempart ou un tablier est, pour le MNH, du sursol non végétal : les
    // masses qu'un ouvrage affiché explique lui laissent la place
    // (vue3d/ouvrages.py), comme un bâtiment à ses parties OSM.
    // Les points d'un ouvrage ajouré aussi : le MNH voyait la tour Eiffel au-
    // dessus de ses arches, en masses de sursol, et en houppiers là où
    // l'orthophoto montre la pelouse dessous.
    const expliquees = new Set([
        ...(ouvragesEnVolume && groupeOuvrages.visible ? OUVRAGES.masses_expliquees : []),
        ...(pointsNuage ? NUAGE.masses_expliquees : [])]);
    const houppiersExpliques = new Set(pointsNuage ? NUAGE.houppiers_expliques : []);
    return expliquees.size || houppiersExpliques.size
        ? vegElements.filter(e => (e.masse == null || !expliquees.has(e.masse))
                                  && (e.houppier == null || !houppiersExpliques.has(e.houppier)))
        : vegElements;
}

/**
 * (Re)construit les maillages de végétation : par tuile, un maillage fusionné
 * pour les houppiers, un pour les masses ; un maillage instancié pour tous
 * les troncs.
 *
 * Même règle que pour les bâtiments : seule la BASE suit l'exagération du
 * relief, la hauteur mesurée reste la vraie. Exagérer un arbre de 14 m le
 * transformerait en séquoia dès ×3 et fausserait le masque affiché à côté.
 */
function construireVegetation() {
    // Maillages de la construction précédente, repris s'ils portent les mêmes
    // éléments : les ouvrages ne retirent que des masses, et leur arrivée
    // refaisait les 3,9 millions de faces des houppiers de Gordes en zone de
    // 1 000 m — 1,1 à 1,6 s d'arrêt de l'image une fois la scène affichée,
    // encore 0,3 s avec le tampon en tableaux typés.
    const avant = new Map(groupeVegetation.children.map(m => [m.userData.cle, m]));
    const repris = new Set();
    groupeVegetation.clear();
    const reprendre = (cle, elements) => {
        const m = avant.get(cle);
        if (!m) return null;
        const e = m.userData.elements;
        if (e.length !== elements.length || e.some((el, i) => el !== elements[i])) return null;
        avant.delete(cle);
        repris.add(m);
        return m;
    };
    const dessines = vegetationDessinee();
    // Les éléments de chaque tuile, dans leur ordre : un élément ne change
    // jamais de tuile, ceux d'une tuile sont donc une sous-suite de ses
    // éléments d'avant (vegetationExtraite).
    const tuiles = new Map();
    for (const el of dessines) {
        const genre = el.classe === 'vegetation' ? 'houppier' : 'masse';
        const cle = `${genre} ${Math.floor(el.x / TUILE_VEGETATION)} ${Math.floor(el.y / TUILE_VEGETATION)}`;
        let tuile = tuiles.get(cle);
        if (!tuile) tuiles.set(cle, tuile = { genre, elements: [] });
        tuile.elements.push(el);
    }
    for (const [cle, { genre, elements }] of tuiles) {
        const garde = reprendre(cle, elements);
        if (garde) { groupeVegetation.add(garde); continue; }
        // Des éléments en moins : leurs faces sont recopiées de l'ancien
        // maillage. Sinon, tout est reconstruit.
        let geometrie = avant.has(cle) && vegetationExtraite(avant.get(cle), elements);
        if (!geometrie) {
            const tampon = nouveauTampon(elements.reduce((n, el) => n + facesHouppier(el), 0),
                                         elements.reduce((n, el) => n + sommetsHouppier(el), 0));
            elements.forEach((el, n) => {
                tampon.element(n);
                ajouterHouppier(tampon, el, 0);   // base à 0 : posée par placerVegetation()
            });
            geometrie = tampon.geometrie();
        }
        const mesh = new THREE.Mesh(geometrie, genre === 'houppier' ? MAT_FEUILLAGE : MAT_MASSE);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData = { vegetation: true, genre, cle, elements };
        groupeVegetation.add(mesh);
    }
    // Troncs : un maillage instancié, posé par placerVegetation (gabaritTronc).
    const arbres = vegElements.filter(aUnTronc);
    if (arbres.length) {
        const garde = reprendre('tronc', arbres);
        const mesh = garde || new THREE.InstancedMesh(GEO_TRONC, MAT_TRONC, arbres.length);
        if (!garde) {
            mesh.castShadow = true;
            // Avant le feuillage, transparent lui aussi : il se voit à travers.
            mesh.renderOrder = -1;
            mesh.userData = { genre: 'tronc', cle: 'tronc', elements: arbres };
        }
        groupeVegetation.add(mesh);
    }
    // Les maillages remplacés rendent leur mémoire au GPU ; la géométrie des
    // troncs est partagée.
    for (const m of avant.values()) if (m.geometry !== GEO_TRONC) m.geometry.dispose();
    // Les maillages repris sont déjà posés : tout changement du sol les a
    // reposés (appliquerExageration). Les reposer refaisait 11,6 millions de
    // sommets et leur envoi au GPU à Gordes en zone de 1 000 m.
    placerVegetation(groupeVegetation.children.filter(m => !repris.has(m)));
    majCiblesSurvol();
    // Les formes simples, prêtes avant le premier geste (montrerVegetation).
    // Safari n'a pas requestIdleCallback.
    (window.requestIdleCallback || (f => setTimeout(f, 200)))(() => {
        const details = groupeVegetation.children.filter(m => m.userData.vegetation);
        if (!simplesAJour(details)) majVegetationSimple(details);
    });
}

/**
 * Géométrie de la végétation pour une partie des éléments d'un maillage déjà
 * construit, dans leur ordre : leurs sommets et leurs faces y sont recopiés.
 * ajouterHouppier() ne dépend que de l'élément, jamais de son rang ; aucun
 * sommet n'est partagé entre deux éléments, donc la normale d'un sommet ne
 * dépend que des faces du sien ; et placerVegetation() ne touche que les Y,
 * que baseY rend à la base 0 : la copie est la géométrie qu'aurait rendue le
 * tampon. Null si `elements` n'est pas une sous-suite des éléments du
 * maillage. Les masses qu'expliquent les ouvrages coûtaient 0,11 s à
 * reconstruire à Strasbourg en zone de 1 000 m (8 872 masses, 19
 * expliquées), 0,03 s à recopier.
 */
function vegetationExtraite(mesh, elements) {
    const avant = mesh.userData.elements, geo = mesh.geometry;
    const { facesDebut: debutsF, sommetsDebut: debutsS, baseY: B } = geo.userData;
    const totalF = geo.index.count / 3, totalS = geo.attributes.position.count;
    const finF = k => k + 1 < avant.length ? debutsF[k + 1] : totalF;
    const finS = k => k + 1 < avant.length ? debutsS[k + 1] : totalS;
    const rangs = new Int32Array(elements.length);
    let k = 0, nbFaces = 0, nbSommets = 0;
    for (let n = 0; n < elements.length; n++, k++) {
        while (k < avant.length && avant[k] !== elements[n]) k++;
        if (k === avant.length) return null;
        rangs[n] = k;
        nbFaces += finF(k) - debutsF[k];
        nbSommets += finS(k) - debutsS[k];
    }
    const P = geo.attributes.position.array, C = geo.attributes.color.array, N = geo.attributes.normal.array;
    const I = geo.index.array;
    const pos = new Float32Array(3 * nbSommets), col = new Float32Array(3 * nbSommets), nor = new Float32Array(3 * nbSommets);
    const baseY = new Float32Array(nbSommets), quel = new Int32Array(nbSommets), index = new Uint32Array(3 * nbFaces);
    const facesDebut = new Int32Array(elements.length), sommetsDebut = new Int32Array(elements.length);
    let f = 0, s = 0;
    for (let n = 0; n < elements.length; n++) {
        const r = rangs[n];
        const d = debutsF[r], e = finF(r), ds = debutsS[r], es = finS(r);
        facesDebut[n] = f;
        sommetsDebut[n] = s;
        pos.set(P.subarray(3 * ds, 3 * es), 3 * s);
        col.set(C.subarray(3 * ds, 3 * es), 3 * s);
        nor.set(N.subarray(3 * ds, 3 * es), 3 * s);
        baseY.set(B.subarray(ds, es), s);
        quel.fill(n, s, s + es - ds);
        for (let i = 3 * d, j = 3 * f; i < 3 * e; i++, j++) index[j] = I[i] - ds + s;
        f += e - d;
        s += es - ds;
    }
    for (let i = 0; i < baseY.length; i++) pos[3 * i + 1] = baseY[i];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    Object.assign(g.userData, { baseY, elements: quel, facesDebut, sommetsDebut });
    return g;
}

/**
 * Repose la végétation sur le terrain (exagération, relief arrivé après).
 *
 * Les Y sont décalés en place, d'après l'élément de chaque sommet : pas de
 * reconstruction. ENFONCEMENT : même marge que les murs, le maillage étant
 * trianglé là où l'échantillonnage est bilinéaire.
 */
function placerVegetation(maillages = groupeVegetation.children) {
    if (!vegPrete) return;
    const dummy = new THREE.Object3D();
    for (const mesh of maillages) {
        const elements = mesh.userData.elements || [];
        const sols = Float32Array.from(elements, el => ySol(el.lon, el.lat) - ENFONCEMENT);
        if (mesh.userData.genre === 'tronc') {
            elements.forEach((el, n) => {
                const { hT, rT } = gabaritTronc(el);
                dummy.rotation.set(0, 0, 0);
                dummy.position.set(el.x, sols[n] + hT / 2, -el.y);
                dummy.scale.set(rT, hT, rT);
                dummy.updateMatrix();
                mesh.setMatrixAt(n, dummy.matrix);
            });
            mesh.instanceMatrix.needsUpdate = true;
            mesh.computeBoundingSphere();
            continue;
        }
        const geo = mesh.geometry;
        const pos = geo.attributes.position.array;
        const baseY = geo.userData.baseY, quel = geo.userData.elements;
        // La boîte englobante est relevée au passage : un parcours de moins des
        // 11,6 millions de sommets des houppiers de Gordes en zone de 1 000 m.
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (let i = 0; i < quel.length; i++) {
            const k = 3 * i;
            pos[k + 1] = baseY[i] + sols[quel[i]];
            x0 = Math.min(x0, pos[k]); y0 = Math.min(y0, pos[k + 1]); z0 = Math.min(z0, pos[k + 2]);
            x1 = Math.max(x1, pos[k]); y1 = Math.max(y1, pos[k + 1]); z1 = Math.max(z1, pos[k + 2]);
        }
        geo.attributes.position.needsUpdate = true;
        sphereEnglobante(geo, [x0, y0, z0, x1, y1, z1]);
        mesh.userData.pose = ++posesVegetation;
    }
}

// --- Végétation simple, pendant le mouvement -----------------------------------
// Houppiers et masses de 36 faces au lieu de 180 (ajouterHouppierSimple),
// montrés à la place des détaillés pendant le mouvement : au loin
// (DISTANCE_DETAIL), et partout quand la vue rame (surveillerMouvement).
// Avant les tuiles, ils n'y venaient que partout, et seulement quand la vue
// ramait. Durée médiane d'une image pendant l'orbite à Gordes
// en zone de 1 000 m (4,4 millions de faces de végétation), sur un Mac M1 :
//
//   houppiers détaillés, ombre redessinée à chaque image   66,7 ms
//   détaillés, ombre figée (figerOmbres)                   33,3 ms
//   simples, ombre figée                                   16,7 ms
//   sans végétation                                        16,7 ms
//
// Construits dans un temps mort après les détaillés (construireVegetation),
// sinon au premier besoin — 80 ms à Porquerolles en zone de 1 000 m, un
// à-coup au premier geste —, et reconstruits s'ils changent ; les troncs
// restent.
//
// En mouvement, une tuile à plus de DISTANCE_DETAIL mètres de la caméra passe
// en forme simple ; à l'arrêt, tout redevient détaillé. Durée d'une image,
// sous Metal, 1 728 × 1 080 en Retina, Porquerolles en zone de 1 000 m,
// tuiles de 125 m, vue par défaut / rapprochée :
//
//   à l'arrêt, tout détaillé       22,9 / 25,4 ms
//   en mouvement, D = 100 m        18,5 / 19,2
//                 D = 200 m        19,3 / 20,2
//                 D = 300 m        20,5 / 21,8
//                 D = 400 m        21,9 / 22,5
//   tout simple                    17,1 / 19,3
//
// Ces durées attendent le GPU à chaque image ; la page, elle, enchaîne les
// images. Orbite en marche, même lieu, même fenêtre, vue par défaut /
// rapprochée : 56-59 / 50-53 images par seconde en un seul maillage, 60 / 60
// en tuiles.
//
// 200 m garde l'essentiel du gain de 100 m. Un houppier de 2,5 m de rayon y
// couvre encore une trentaine de pixels de rayon sur 2 160 de haut : en
// mouvement, ses six côtés au lieu de dix ne se remarquent pas. Même tout
// simple, la végétation coûte encore 7 ms à cette taille d'image : ce sont
// ses pixels, transparents, que la forme simple couvre autant que la
// détaillée.
const DISTANCE_DETAIL = 200;
export const groupeVegSimple = new THREE.Group();
groupeVegSimple.visible = false;
scene.add(groupeVegSimple);

/** Maillages simples à jour des détaillés `details` : reconstruits ou reposés. */
function majVegetationSimple(details) {
    const avant = new Map(groupeVegSimple.children.map(m => [m.userData.source, m]));
    groupeVegSimple.clear();
    for (const d of details) {
        let m = avant.get(d);
        avant.delete(d);
        if (!m) {
            const elements = d.userData.elements;
            const tampon = nouveauTampon(elements.length * facesHouppierSimple(),
                                         elements.length * sommetsHouppierSimple());
            elements.forEach((el, n) => { tampon.element(n); ajouterHouppierSimple(tampon, el, 0); });
            m = new THREE.Mesh(tampon.geometrie(), d.material);
            m.castShadow = true;
            m.receiveShadow = true;
            m.userData = { genre: d.userData.genre, elements, source: d, poseSource: null };
        }
        if (m.userData.poseSource !== d.userData.pose) {
            placerVegetation([m]);
            m.userData.poseSource = d.userData.pose;
        }
        groupeVegSimple.add(m);
    }
    for (const m of avant.values()) m.geometry.dispose();
}

/** Vrai si les formes simples suivent les maillages détaillés `details`, un à un, posées comme eux. */
function simplesAJour(details) {
    const simples = groupeVegSimple.children;
    return details.length === simples.length && details.every((d, i) =>
        simples[i].userData.source === d && simples[i].userData.poseSource === d.userData.pose);
}

/**
 * Forme de la végétation pour l'image à venir. À l'arrêt, détaillée
 * partout. En mouvement, simple dans les tuiles à plus de DISTANCE_DETAIL de
 * la caméra, et partout si `toutSimple` (la vue rame encore,
 * surveillerMouvement). Rend vrai si les formes simples ont été construites
 * ou reposées pour cette image, qui ne compte donc pas dans la cadence.
 */
export function montrerVegetation(enMouvement, toutSimple) {
    const details = groupeVegetation.children.filter(m => m.userData.vegetation);
    const enMouvementVisible = enMouvement && groupeVegetation.visible;
    let construites = false;
    if (enMouvementVisible && !simplesAJour(details)) {
        majVegetationSimple(details);
        construites = true;
    }
    const simples = groupeVegSimple.children;
    groupeVegSimple.visible = enMouvementVisible;
    details.forEach((d, i) => {
        const s = d.geometry.boundingSphere;
        const loin = enMouvementVisible
            && (toutSimple || camera.position.distanceTo(s.center) - s.radius > DISTANCE_DETAIL);
        d.visible = !loin;
        if (enMouvementVisible) simples[i].visible = loin;
    });
    return construites;
}

/** Élément (houppier ou masse) sous une face d'un maillage fusionné. */
export function elementSousFace(mesh, faceIndex) {
    const debuts = mesh.geometry.userData.facesDebut;
    let lo = 0, hi = debuts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (debuts[mid] <= faceIndex) lo = mid; else hi = mid - 1;
    }
    return mesh.userData.elements[lo];
}

export let vegChargee = false;

async function chargerVegetation() {
    const note = document.getElementById('v-note');
    note.textContent = 'Segmentation des houppiers sur le MNH LiDAR HD à 0,5 m…';

    await chargementArtefact;
    if (!ARTEFACT) {
        note.textContent = 'Scène indisponible : ' + (ERREUR_SCENE || 'erreur inconnue');
        return false;
    }
    const res = Object.assign({}, ARTEFACT.vegetation,
                              { houppiers: ARTEFACT.houppiers, masses: ARTEFACT.masses });
    if (!res || res.error) {
        note.textContent = (res && res.error) || 'Aucune donnée MNH sur cette emprise.';
        return false;
    }
    if (!res.couvert) {
        // Hors emprise LiDAR, la dalle revient entièrement à zéro : il faut le
        // dire, sinon « rien à l'écran » se lit comme « aucune végétation ».
        note.textContent = "Emprise hors couverture LiDAR HD de l'IGN : "
            + "aucune hauteur de sursol disponible ici. Le programme est en cours "
            + "de déploiement, la couverture s'étend campagne après campagne.";
        return false;
    }

    // lon/lat conservés : c'est par eux qu'on interroge l'altitude du terrain.
    // `masse` : rang dans les masses de la scène, par lequel la couche des
    // ouvrages désigne celles qu'elle explique ; `houppier`, de même pour le
    // nuage, dont un ouvrage ajouré explique aussi des houppiers.
    const nHouppiers = (res.houppiers || []).length;
    poserVegetation([...(res.houppiers || []), ...(res.masses || [])].map((el, i) => {
        const [x, y] = toLocal(el.lon, el.lat);
        return { ...el, x, y, masse: i >= nHouppiers ? i - nHouppiers : null,
                 houppier: i < nHouppiers ? i : null };
    }));
    construireVegetation();

    const arbres = vegElements.filter(e => e.classe === 'vegetation');
    const masses = vegElements.filter(e => e.classe !== 'vegetation');

    // Masque solaire : angle d'élévation maximal vu du point, secteur sud
    // (azimut 135° à 225°). Le point est à l'origine locale de la projection.
    //
    // La référence est la TOITURE, pas le sol : un capteur est posé sur le toit,
    // et mesurer depuis le sol fait dominer le classement par le premier objet
    // venu à quelques mètres — véranda, garage absent de la BD TOPO, débord de
    // toit. Mesuré sur un site réel, le sol donnait « 44° à 5 m », c'est-à-dire
    // la maison elle-même. Seul ce qui dépasse la toiture ombre réellement.
    // L'angle est pris au sommet de chaque houppier : un indicateur, pas un
    // calcul de course solaire.
    const hRef = hauteurReference();
    let masque = 0, obstacle = null;
    for (const c of vegElements) {
        const dist = Math.hypot(c.x, c.y);
        if (dist < 3) continue;
        const azimut = (Math.atan2(c.x, c.y) * 180 / Math.PI + 360) % 360;
        if (azimut < 135 || azimut > 225) continue;
        const depasse = c.h - hRef;
        if (depasse <= 0) continue;                  // sous la toiture : n'ombre pas
        const angle = Math.atan2(depasse, Math.max(dist - c.r, 1)) * 180 / Math.PI;
        if (angle > masque) { masque = angle; obstacle = { ...c, dist, angle }; }
    }

    document.getElementById('v-max').textContent = res.hauteur_max ? res.hauteur_max.toFixed(1) + ' m' : '—';
    document.getElementById('v-masque').textContent = masque ? masque.toFixed(0) + '°' : 'dégagé';
    document.getElementById('v-obstacle').textContent = obstacle
        ? `${obstacle.nature || (obstacle.classe === 'vegetation' ? 'végétation' : 'sursol')} `
          + `${obstacle.h.toFixed(1)} m à ${obstacle.dist.toFixed(0)} m`
        : '—';

    const essences = {};
    for (const a of arbres) if (a.essence && !/^N[CR]$/.test(a.essence)) essences[a.essence] = (essences[a.essence] || 0) + 1;
    const listeEssences = Object.entries(essences).sort((u, v) => v[1] - u[1])
        .map(([e, n]) => `${e} (${n})`).join(', ');
    const nbOrtho = arbres.filter(a => !a.nature).length;

    note.innerHTML =
        (res.veg_disponible === false
            ? `<b style="color:#e0a45c">Zones de végétation indisponibles</b> : le service `
              + `IGN n'a pas répondu, seule l'orthophoto a servi à reconnaître la végétation. `
              + `Recharger la page pour réessayer.<br>`
            : '')
        + `<span style="color:#7fb069">■</span> ${arbres.length} houppier(s)`
        + (nbOrtho ? ` — dont ${nbOrtho} reconnu(s) à la couleur de l'orthophoto, `
                     + `hors zones BD TOPO` : '')
        + ` · <span style="color:#8a8c7c">■</span> ${masses.length} masse(s) de nature `
        + `inconnue (mur, véhicule, sol nu…).<br>`
        + (listeEssences ? `Essences BD Forêt v2 : ${listeEssences}.<br>`
                         : (res.foret_disponible === false ? `BD Forêt v2 indisponible : palette d'après la BD TOPO seule.<br>`
                                                            : `Aucune essence BD Forêt v2 sur l'emprise (hors massif forestier).<br>`))
        + (res.ortho === false ? `Orthophoto absente au moment du classement : seule la BD TOPO `
                                + `a servi.<br>` : '')
        + (res.source === 'mns_mnt'
            ? `<b style="color:#e0a45c">Hors couverture LiDAR HD</b> : hauteurs estimées par `
              + `photogrammétrie (MNS − MNT), qui lisse les cimes — à lire comme un `
              + `ordre de grandeur.<br>` : '')
        + `La forme de chaque houppier est son profil mesuré sur la grille à ${res.resolution_m} m `
        + `(seuil ${res.seuil_m} m) ; l'essence ne choisit que la couleur et le fût. `
        + `Le « masque au sud » est l'élévation du plus haut obstacle entre 135° et 225°, `
        + (hRef ? `mesurée depuis la toiture du bâtiment visé (${hRef.toFixed(1)} m). `
                : `mesurée depuis le sol — aucun bâtiment BD TOPO exploitable au point visé. `)
        + `C'est un indicateur d'ombrage, pas un calcul de course solaire.`;
    return true;
}

export const btnVeg = document.getElementById('t-veg');
let vegDisponible = false;

/**
 * Charge la couche et l'affiche. Appelée d'office au chargement de la page,
 * une fois les bâtiments connus, et en secours si l'utilisateur rallume le
 * calque après un échec.
 *
 * Le bouton n'apparaît allumé qu'en cas de succès : hors couverture LiDAR, il
 * reste éteint et le panneau dit pourquoi, plutôt que d'annoncer un calque
 * actif qui ne montre rien.
 */
export async function activerVegetation() {
    document.getElementById('sec-veg').hidden = false;
    btnVeg.disabled = true;
    vegDisponible = await chargerVegetation();
    btnVeg.disabled = false;
    vegChargee = true;
    marquerVegetationReglee();
    if (!vegDisponible) return;
    groupeVegetation.visible = true;
    btnVeg.classList.add('on');
    majCiblesSurvol();
}

btnVeg.addEventListener('click', async () => {
    if (!vegChargee) { await activerVegetation(); return; }
    // Hors couverture LiDAR ou service indisponible : le panneau dit pourquoi,
    // et le bouton reste éteint plutôt que d'allumer une couche vide.
    if (!vegDisponible) return;
    groupeVegetation.visible = !groupeVegetation.visible;
    btnVeg.classList.toggle('on', groupeVegetation.visible);
    majCiblesSurvol();
});
