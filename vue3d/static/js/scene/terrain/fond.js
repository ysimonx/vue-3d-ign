// Le fond cartographique, orthophoto ou Plan IGN, sur le terrain et les toits.

import * as THREE from 'three';
import { FONDS } from '../../commun/tuiles.js';
import { ZOOM_EN_MOINS } from '../socle/point.js';
import { URL_VUE3D_ORTHO, chargerImage } from '../socle/reseau.js';
import { ARTEFACT, requete, chargementArtefact } from '../socle/chargement.js';
import { toLocal } from '../socle/projection.js';
import { terrain, relief, BORNES } from './etat.js';
import { scene, renderer, grille } from '../socle/rendu.js';
import {
    MAT_TOIT_VOISIN, MAT_TOIT_SURFACE, DECALAGE_DESSUS, MAT_DESSUS, meshesToits,
} from '../batiments/etat.js';
import { citerSource, majCredits } from '../interface/credits.js';

// Les tuiles sont assemblées dans un canvas unique, qui sert à la fois de sol
// et de texture pour les toits. Elles passent par le serveur (vue3d/tuiles.py) :
// il sert celles qu'il a en stock et redirige les autres vers data.geopf.fr,
// qui renvoie `access-control-allow-origin: *`, ce qu'exige WebGL pour une
// texture cross-origin (vérifié, orthophoto et Plan IGN, redirection
// comprise). Il faut en revanche crossOrigin='anonymous' sur les images, sinon
// le canvas serait marqué « souillé » et la texture refusée malgré cet en-tête.
//
// Les deux fonds viennent de l'IGN, sous la même licence que le reste de la
// scène. Le plan OpenStreetMap qu'on proposait avant dépendait de serveurs
// dont les conditions d'usage découragent un rechargement à chaque visite.
const TUILE_ZOOM = 18;

// Relectures demandées au serveur à la fois, pour toute la page : autant
// qu'il en mène pour tous ses visiteurs (TUILES_RELECTURES_SIMULTANEES).
const RELECTURES_SIMULTANEES = 2;
let relecturesEnCours = 0;
const relecturesEnAttente = [];
// Essais d'une relecture que le serveur dit occupé (503), espacés de son
// Retry-After.
const RELECTURE_ESSAIS = 3;

/**
 * Une tuile que l'IGN a refusée au navigateur, lue par le serveur, qui la
 * garde (vue3d/tuiles.py) : l'IGN en refuse par épisodes une qui existe. Lue
 * en fetch, pour distinguer l'absence (404 : pas d'image à ce zoom ici) d'un
 * serveur occupé (503), puis rendue en image depuis ses octets.
 */
export async function relireTuile(url) {
    if (relecturesEnCours >= RELECTURES_SIMULTANEES) {
        await new Promise(r => relecturesEnAttente.push(r));
    }
    relecturesEnCours++;
    try {
        for (let essai = 0; essai < RELECTURE_ESSAIS; essai++) {
            const reponse = await fetch(`${url}?relire=1`);
            if (reponse.ok) {
                const lien = URL.createObjectURL(await reponse.blob());
                try { return await chargerImage(lien); }
                finally { URL.revokeObjectURL(lien); }
            }
            if (reponse.status !== 503) break;
            const attente = Number(reponse.headers.get('retry-after')) || 2;
            await new Promise(r => setTimeout(r, attente * 1000));
        }
        throw new Error(`tuile non relue : ${url}`);
    } finally {
        relecturesEnCours--;
        relecturesEnAttente.shift()?.();
    }
}

const groupeFond = new THREE.Group();
scene.add(groupeFond);

// TILEMATRIXSET=PM de l'IGN suit le découpage XYZ standard (Web Mercator) :
// les deux fonds, et les tuiles de relief de repli, partagent ces conversions.
export const versTuile = (lon, lat, z) => {
    const n = 2 ** z;
    const rad = lat * Math.PI / 180;
    return [
        Math.floor((lon + 180) / 360 * n),
        Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * n),
    ];
};
export const versLonLat = (x, y, z) => {
    const n = 2 ** z;
    return [
        x / n * 360 - 180,
        Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI,
    ];
};

// Texture composite et emprise correspondante, en coordonnées locales.
export let fondTexture = null;
export let fondBornes = null;

// Ce qui s'habille du fond, inscrit par son module : le terrain à chaque fond
// posé ; l'anneau et l'horizon, qui lisent leurs propres tuiles, à chaque
// changement au bouton ; les couleurs des DPE et des ventes, qui l'emportent
// sur la photo des toits, après elle.
const surFondPose = [], surFondChange = [], apresPhotoToits = [];
export function quandLeFondEstPose(fn) { surFondPose.push(fn); }
export function quandLeFondChange(fn) { surFondChange.push(fn); }
export function apresLaPhotoDesToits(fn) { apresPhotoToits.push(fn); }
const fondPose = () => { for (const fn of surFondPose) fn(); };

/**
 * Drape la mosaïque publiée sur la scène. Renvoie false si elle manque, pour
 * que l'appelant reprenne le chemin des tuiles.
 *
 * Son emprise est exactement celle de l'artefact, donc celle du maillage du
 * terrain : les UV s'y appliquent sans marge. Le composite de tuiles, lui,
 * débordait jusqu'à une tuile entière puisqu'il s'alignait sur leur découpage.
 */
async function poserMosaique() {
    const img = await requete(URL_VUE3D_ORTHO, false, chargerImage).catch(() => null);
    if (!img) return false;
    const b = ARTEFACT.bbox;
    const [ax, ay] = toLocal(b[0], b[3]);   // ouest, nord
    const [bx, by] = toLocal(b[2], b[1]);   // est, sud
    fondBornes = { minX: Math.min(ax, bx), maxX: Math.max(ax, bx),
                   minZ: Math.min(-ay, -by), maxZ: Math.max(-ay, -by) };
    fondTexture = new THREE.Texture(img);
    fondTexture.colorSpace = THREE.SRGBColorSpace;
    fondTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    fondTexture.needsUpdate = true;
    poserPlanDeFond();
    appliquerTextureToits();
    fondPose();
    return true;
}

/**
 * Pose le plan du fond sous la scène, sauf si le relief le porte déjà.
 *
 * Avec le relief, l'ortho est drapée sur le maillage du terrain : un plan plat
 * par-dessus z-fighterait avec lui.
 */
function poserPlanDeFond() {
    if (relief && terrain) return;
    const plan = new THREE.Mesh(
        new THREE.PlaneGeometry(fondBornes.maxX - fondBornes.minX,
                                fondBornes.maxZ - fondBornes.minZ),
        new THREE.MeshStandardMaterial({ map: fondTexture, roughness: 1, metalness: 0 }));
    plan.rotation.x = -Math.PI / 2;   // le +Y du plan devient le nord
    plan.position.set((fondBornes.minX + fondBornes.maxX) / 2, 0.05,
                      (fondBornes.minZ + fondBornes.maxZ) / 2);
    plan.receiveShadow = true;
    groupeFond.add(plan);
}

/**
 * Assemble les tuiles WMTS qui couvrent une emprise en une seule texture.
 *
 * Une tuile absente reste transparente. L'emprise rendue est celle du
 * composite, alignée sur le découpage des tuiles, en coordonnées locales.
 */
// Tuiles d'un fond composé (sol, anneau) chargées à la fois : autant que
// l'horizon (HORIZON_PARALLELE), voir composerTuiles.
const COMPOSITION_PARALLELE = 12;
// Une tuile qui n'est pas arrivée en TUILE_DELAI_MS est relue par le serveur,
// comme une tuile refusée : une seule tuile pendue retenait tout le fond
// composé. 675 tuiles au zoom 16 lues à l'IGN, douze à la fois comme ici,
// autour de Notre-Dame, de Fourvière et du Vieux-Port le 18 novembre 2026 :
// médiane 0,2 s, 99 % sous 2 s, 2,3 s au plus, et une à 66 s. Dans la page,
// l'anneau de Notre-Dame a attendu ainsi 66 s au lieu de 4 : ses requêtes au
// serveur étaient finies en 5 s, l'IGN tenait la dernière image.
const TUILE_DELAI_MS = 8000;

export async function composerTuiles(url, zoom, b) {
    const [x0, y0] = versTuile(b.o, b.n, zoom);
    const [x1, y1] = versTuile(b.e, b.s, zoom);
    const canvas = document.createElement('canvas');
    canvas.width = (x1 - x0 + 1) * 256;
    canvas.height = (y1 - y0 + 1) * 256;
    const ctx = canvas.getContext('2d');

    // Un refus se fait relire par le serveur : la Géoplateforme en oppose de
    // loin en loin à une tuile qui existe (un 404 au zoom 16 à Gordes, 200
    // cinq fois de suite ensuite), et le trou restait dans la texture.
    // Une tuile pendue de même (TUILE_DELAI_MS).
    const charger = u => chargerImage(u, true, TUILE_DELAI_MS).catch(() => relireTuile(u));
    const restantes = [];
    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) restantes.push([x, y]);
    }
    // COMPOSITION_PARALLELE à la fois, et non toutes ensemble : l'anneau
    // d'une zone de 1 000 m en compte plus de cent au zoom 16, qui passent
    // désormais par le serveur. D'un seul coup, en HTTP/2 derrière Caddy, elles
    // ouvraient autant de connexions vers gunicorn, au-delà de sa file
    // d'attente (128 sous macOS) : 100 réponses 502 en une milliseconde le 15
    // octobre 2026 en production.
    async function suivantes() {
        for (let t; (t = restantes.shift());) {
            const [x, y] = t;
            try {
                const img = await charger(url(zoom, x, y));
                ctx.drawImage(img, (x - x0) * 256, (y - y0) * 256, 256, 256);
            } catch (e) { /* tuile absente : reste transparente */ }
        }
    }
    await Promise.all(Array.from({ length: COMPOSITION_PARALLELE }, suivantes));

    // Coin nord-ouest de la première tuile au coin sud-est de la dernière.
    const [lonO, latN] = versLonLat(x0, y0, zoom);
    const [lonE, latS] = versLonLat(x1 + 1, y1 + 1, zoom);
    const [ax, ay] = toLocal(lonO, latN);
    const [bx, by] = toLocal(lonE, latS);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return { texture, bornes: { minX: Math.min(ax, bx), maxX: Math.max(ax, bx),
                                minZ: Math.min(-ay, -by), maxZ: Math.max(-ay, -by) } };
}

export async function poserFond(nom) {
    groupeFond.clear();
    fondTexture = null;
    fondBornes = null;
    if (!nom) { appliquerTextureToits(); fondPose(); return; }

    // Orthophoto : une seule image publiée avec l'artefact, quand il existe.
    // Les seize tuiles WMTS restent le chemin de secours — et le seul pour le
    // Plan IGN, qui n'est pas publié.
    if (nom === 'ortho' && URL_VUE3D_ORTHO) {
        await chargementArtefact;
        if (ARTEFACT && await poserMosaique()) return;
    }

    // Seule l'orthophoto a un sens pour lire la couleur du sol : un plan est
    // vert là où le cartographe l'a décidé, pas là où il y a des feuilles.
    ({ texture: fondTexture, bornes: fondBornes } = await composerTuiles(
        FONDS[nom], TUILE_ZOOM - ZOOM_EN_MOINS,
        BORNES));

    poserPlanDeFond();

    appliquerTextureToits();
    fondPose();
}

/**
 * Plaque la photo aérienne sur les toits.
 *
 * L'orthophoto est une vue nadir : elle montre déjà le toit vu du dessus, et
 * une projection planaire depuis le zénith en est donc l'inverse exact. Les UV
 * se déduisent directement de la position monde (x, z) ramenée dans l'emprise
 * du composite — aucun dépliage à calculer.
 *
 * Volontairement limité aux toits : sur une façade verticale, la même
 * projection étirerait le pixel nadir en traînée.
 */
export function appliquerTextureToits() {
    for (const toit of meshesToits) {
        if (!fondTexture || !fondBornes) {
            toit.material = toit.userData.dessus ? MAT_DESSUS
                : toit.userData.lisse ? MAT_TOIT_SURFACE : MAT_TOIT_VOISIN;
            continue;
        }
        const geo = toit.geometry;
        const pos = geo.attributes.position;
        const uv = new Float32Array(pos.count * 2);
        for (let i = 0; i < pos.count; i++) {
            uv[i * 2] = (pos.getX(i) - fondBornes.minX) / (fondBornes.maxX - fondBornes.minX);
            // flipY par défaut : v = 1 correspond au haut de l'image, donc au nord.
            uv[i * 2 + 1] = 1 - (pos.getZ(i) - fondBornes.minZ) / (fondBornes.maxZ - fondBornes.minZ);
        }
        geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
        toit.material = new THREE.MeshStandardMaterial({
            map: fondTexture, roughness: 0.9, metalness: 0,
            ...(toit.userData.dessus ? DECALAGE_DESSUS : {}) });
    }
    // Les bâtiments qui ont des DPE gardent leur couleur, toits compris.
    for (const fn of apresPhotoToits) fn();
}

export let fondActif = 'ortho';
citerSource('fond', () => fondActif);
poserFond(fondActif);

function basculerFond(nom) {
    fondActif = (fondActif === nom) ? null : nom;
    poserFond(fondActif);
    for (const fn of surFondChange) fn();
    majCredits();
    document.getElementById('t-fond').classList.toggle('on', fondActif === 'ortho');
    document.getElementById('t-plan').classList.toggle('on', fondActif === 'plan');
    grille.visible = !fondActif;   // le quadrillage n'a de sens que sans fond
}
document.getElementById('t-fond').addEventListener('click', () => basculerFond('ortho'));
document.getElementById('t-plan').addEventListener('click', () => basculerFond('plan'));
