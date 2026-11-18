// L'anneau de relief autour de l'emprise.

import * as THREE from 'three';
import { FONDS } from '../../commun/tuiles.js';
import { ZOOM_EN_MOINS } from '../socle/point.js';
import { ARTEFACT } from '../socle/chargement.js';
import { toLocal, toLonLat } from '../socle/projection.js';
import {
    terrain, altitudeRef, relief, exagVert, anneauRelief, horizonActif, poserAnneauRelief,
} from './etat.js';
import { scene } from '../socle/rendu.js';
import { normalesIndexees, sphereEnglobante } from '../geometrie/normales.js';
import { quandLeFondChange, composerTuiles, fondActif } from './fond.js';
import { MAT_TERRAIN, poserSurLeRelief, decoderRelief } from './relief.js';

// Autour de l'emprise, un relief grossier (maille de 16 m, sur 2 km de côté)
// drapé d'un fond en basse résolution : la scène ne flotte plus dans le vide,
// et les coteaux voisins portent leur ombre quand le soleil rase.
//
// Le maillage est une grille aux lignes irrégulières : celles de l'anneau au
// large, celles du terrain fin à travers l'emprise, que l'on retire. Le bord
// du trou porte donc exactement les sommets du terrain fin, à la même
// altitude : pas de fente au raccord, quelle que soit l'exagération.
//
// Zoom 15 : 3,4 m par pixel à 46° de latitude, trois à quatre tuiles de côté
// pour 2 km, donc seize requêtes au plus. Au zoom 16, ce serait trente-six
// tuiles pour un décor que le brouillard efface à partir de 300 m. Avec
// l'horizon, plus de brouillard proche, et le drone le survole à 20 m : au
// zoom 15, il y était plus flou que l'horizon autour (0,9 m par pixel au
// zoom 17) ; le zoom 16 le rapproche.
const ANNEAU_ZOOM = 15;
const ANNEAU_ZOOM_HORIZON = 16;
let generationAnneau = 0;
quandLeFondChange(() => poserFondAnneau());
// Construit avec le terrain, qu'il prolonge ; à plat, faute de terrain, pas d'anneau.
poserSurLeRelief({
    construire: () => { if (terrain) construireAnneau(); },
    placer: () => { if (anneauRelief) deplacerAnneau(); },
});

function construireAnneau() {
    const r = ARTEFACT && ARTEFACT.anneau;
    const alt = decoderRelief(r, false);
    if (!alt || !terrain) return;
    const b = r.bbox;
    const [ox, ny] = toLocal(b[0], b[3]);
    const [ex, sy] = toLocal(b[2], b[1]);
    const bornes = { minX: ox, maxX: ex, minZ: -ny, maxZ: -sy };

    // Lignes de l'anneau hors de l'emprise, et toutes celles du terrain fin.
    // Une ligne grossière à moins d'une demi-maille du bord ferait une facette
    // en lame : on la laisse tomber.
    const axe = (min, max, n, fines) => {
        const pas = (max - min) / (n - 1);
        const a = fines.slice();
        for (let k = 0; k < n; k++) {
            const v = min + k * pas;
            if (v < fines[0] - pas / 2 || v > fines[fines.length - 1] + pas / 2) a.push(v);
        }
        return a.sort((p, q) => p - q);
    };
    const { xs: finsX, zs: finsZ } = terrain.lignes;
    const xs = axe(bornes.minX, bornes.maxX, r.width, finsX);
    const zs = axe(bornes.minZ, bornes.maxZ, r.height, finsZ);
    const nx = xs.length, nz = zs.length;
    const EPS = 1e-6;
    const dedansX = x => x >= finsX[0] - EPS && x <= finsX[finsX.length - 1] + EPS;
    const dedansZ = z => z >= finsZ[0] - EPS && z <= finsZ[finsZ.length - 1] + EPS;

    const positions = new Float32Array(nx * nz * 3);
    const hauteurs = new Float64Array(nx * nz);
    for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            const [lon, lat] = toLonLat(xs[i], -zs[j]);
            // Sur le bord du trou (et dedans, où rien n'est tracé), l'altitude
            // du terrain fin : c'est ce qui ferme le raccord.
            const a = (dedansX(xs[i]) && dedansZ(zs[j])) ? terrain.alt(lon, lat) : alt(lon, lat);
            hauteurs[k] = a ?? NaN;
            positions[k * 3] = xs[i];
            positions[k * 3 + 2] = zs[j];
        }
    }

    const indices = [];
    let min = Infinity;
    for (let j = 0; j < nz - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
            if (dedansX(xs[i]) && dedansX(xs[i + 1]) && dedansZ(zs[j]) && dedansZ(zs[j + 1])) continue;
            const a = j * nx + i, c = a + nx;          // c : un rang plus au sud
            const coins = [a, a + 1, c, c + 1];
            if (coins.some(q => Number.isNaN(hauteurs[q]))) continue;   // mer, étranger
            for (const q of coins) min = Math.min(min, hauteurs[q]);
            // Même ordre que PlaneGeometry : faces vers le ciel.
            indices.push(a, c, a + 1, c, c + 1, a + 1);
        }
    }
    if (!indices.length) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(indices);
    const mesh = new THREE.Mesh(geo, MAT_TERRAIN);
    mesh.receiveShadow = true;
    mesh.castShadow = true;
    mesh.visible = relief;
    scene.add(mesh);
    // `alt` sert aussi aux pylônes posés au-delà de l'emprise.
    poserAnneauRelief({ mesh, hauteurs, min, bornes, alt });
    deplacerAnneau();
    poserFondAnneau();
}

/** Même règle que le terrain fin : seule l'altitude suit l'exagération. */
function deplacerAnneau() {
    const { mesh, hauteurs } = anneauRelief;
    const pos = mesh.geometry.attributes.position;
    for (let k = 0; k < pos.count; k++) {
        // Un sommet sans altitude n'appartient à aucune facette : 0 suffit.
        pos.array[3 * k + 1] = Number.isNaN(hauteurs[k]) ? 0 : (hauteurs[k] - altitudeRef) * exagVert;
    }
    pos.needsUpdate = true;
    normalesIndexees(mesh.geometry);
    sphereEnglobante(mesh.geometry);
}

// Un fond composé n'est posé qu'une fois toutes ses tuiles arrivées : en zone
// de 1 000 m, 225 au zoom 16 pour l'anneau. Il restait sombre, entre la scène
// et l'horizon déjà photographié, de 1,3 à 3,9 s sous Chrome et de 4,0 à
// 7,9 s sous Firefox à Notre-Dame (Mac, depuis le réseau du serveur), plus
// loin du serveur plus longtemps. Il reçoit donc d'abord une esquisse,
// ANNEAU_ESQUISSE zooms plus bas : neuf tuiles, 768 pixels de côté. Lue avant
// le zoom plein, et non en même temps : mêlée à ses 225 tuiles, elle arrivait
// 1,3 à 1,7 s après l'anneau ; seule, 0 à 0,4 s après (serveur local).
const ANNEAU_ESQUISSE = 3;

/** Drape le fond actif sur l'anneau, par projection zénithale : l'esquisse, puis le zoom plein. */
export async function poserFondAnneau() {
    if (!anneauRelief) return;
    const generation = ++generationAnneau;
    const { mesh, bornes } = anneauRelief;
    if (!fondActif) { mesh.material = MAT_TERRAIN; return; }
    const lonLat = [toLonLat(bornes.minX, -bornes.minZ), toLonLat(bornes.maxX, -bornes.maxZ)];
    const emprise = { o: lonLat[0][0], n: lonLat[0][1], e: lonLat[1][0], s: lonLat[1][1] };
    const zoom = (horizonActif ? ANNEAU_ZOOM_HORIZON : ANNEAU_ZOOM) - ZOOM_EN_MOINS;
    // Le serveur ne sert pas sous le zoom 9 (tuiles.TUILES_ZOOM).
    if (zoom - ANNEAU_ESQUISSE >= 9) {
        habillerAnneau(await composerTuiles(FONDS[fondActif], zoom - ANNEAU_ESQUISSE, emprise), generation);
        if (generation !== generationAnneau) return;
    }
    habillerAnneau(await composerTuiles(FONDS[fondActif], zoom, emprise), generation);
}

/** Pose un fond composé (composerTuiles) sur l'anneau, sauf si un autre fond a été choisi depuis. */
function habillerAnneau({ texture, bornes: tb }, generation) {
    // Un autre fond a été choisi pendant le chargement : il gagne.
    if (generation !== generationAnneau) { texture.dispose(); return; }
    const { mesh } = anneauRelief;
    const pos = mesh.geometry.attributes.position;
    // Réécrits en place à chaque fond : un attribut remplacé laisserait son
    // tampon au GPU.
    let attribut = mesh.geometry.attributes.uv;
    if (!attribut) mesh.geometry.setAttribute('uv', attribut = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    const uv = attribut.array;
    for (let k = 0; k < pos.count; k++) {
        uv[k * 2] = (pos.getX(k) - tb.minX) / (tb.maxX - tb.minX);
        uv[k * 2 + 1] = 1 - (pos.getZ(k) - tb.minZ) / (tb.maxZ - tb.minZ);
    }
    attribut.needsUpdate = true;
    const ancien = mesh.material;
    mesh.material = new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 });
    if (ancien !== MAT_TERRAIN) { ancien.map?.dispose(); ancien.dispose(); }
}
