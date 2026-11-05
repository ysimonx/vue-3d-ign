// Les stops, cédez-le-passage et feux des carrés : au bord de la route, et le
// prochain sur la route prévue.

import * as THREE from 'three';
import { scene, courber } from '../socle/rendu.js';
import { ancres, ancrer } from '../socle/monde.js';
import { altitudeL93 } from '../sol/altitudes.js';
import { CARRE_M, SIGNALISATION_VERSION, carres } from '../carres/grille.js';
import { LARGEUR_PAR_NATURE } from '../carres/routes.js';
import { aretes, pointArete } from './graphe.js';

// Par tronçon BD TOPO, dans le sens où il s'applique (/api/signalisation,
// vue3d/signalisation.py) : ce qu'OpenStreetMap en a saisi, rien d'autre.
// Gardés par identifiant de tronçon, d'où que vienne le carré.
export const signaux = new Map();             // cleabs → [{ type, sens, s, c }]
// Une place : les limitations en ont deux, et le serveur n'en a que deux
// pour Overpass ; seul le premier carré d'un bloc de 2 km l'attend.
export const SIG_PARALLELE = 1;
export let sigEnVol = 0;
const indexes = new Set();                     // les carrés dont les panneaux sont dans `signaux`

export async function chargerSignalisation(c) {
    const g = c.sig;
    g.etat = 'charge';
    sigEnVol++;
    try {
        const reponse = await fetch(`api/signalisation?i=${c.i}&j=${c.j}&v=${SIGNALISATION_VERSION}`);
        if (reponse.status === 422) { g.etat = 'hors'; return; }
        if (!reponse.ok) {
            g.etat = 'erreur';
            g.reessai = performance.now() + (Number(reponse.headers.get('retry-after')) || 30) * 1000;
            return;
        }
        g.liste = (await reponse.json()).signaux.map(([type, id, sens, s]) => ({ type, id, sens, s, c }));
        for (const e of g.liste) {
            if (!signaux.has(e.id)) signaux.set(e.id, []);
            signaux.get(e.id).push(e);
        }
        indexes.add(c);
        g.etat = 'pret';
    } catch (e) {
        g.etat = 'erreur';
        g.reessai = performance.now() + 30000;
    } finally {
        sigEnVol--;
    }
}

function oublier(c) {
    for (const e of c.sig.liste || []) {
        const reste = (signaux.get(e.id) || []).filter(f => f.c !== c);
        if (reste.length) signaux.set(e.id, reste); else signaux.delete(e.id);
    }
    indexes.delete(c);
    defaire(c);
}

// --- Au bord de la route -------------------------------------------------------------------
// Un panneau à droite de la chaussée, face à qui arrive, dessiné près de
// trois fois plus grand que nature : à sa taille (90 cm), un stop à 60 m de
// la caméra, qui suit la voiture à 45 m, tenait en 14 pixels sur un écran de
// 900. Un feu est un boîtier à trois lampes ; on ne sait pas sa couleur.
// Tous les panneaux d'un carré tiennent en un maillage, sur un atlas : la
// face de chaque type, puis son dos gris, puis le gris du poteau.
const PANNEAU_M = { stop: [2.4, 2.4], cedez: [2.7, 2.4], feu: [1.1, 2.5] };   // largeur, hauteur
const POTEAU_M = 3.2, POTEAU_EPAIS_M = 0.16, BORD_M = 1.2;
const TYPES = ['stop', 'cedez', 'feu'], CELLULE = 128;
const atlas = document.createElement('canvas');
atlas.width = 4 * CELLULE; atlas.height = 2 * CELLULE;
{
    const g = atlas.getContext('2d');
    const forme = (k, dos) => {
        const x = k * CELLULE, y = dos ? CELLULE : 0, m = CELLULE / 2;
        g.save();
        g.translate(x + m, y + m);
        g.beginPath();
        if (TYPES[k] === 'stop') {
            for (let i = 0; i < 8; i++) {
                const a = (i + 0.5) * Math.PI / 4;
                g.lineTo(60 * Math.cos(a), 60 * Math.sin(a));
            }
        } else if (TYPES[k] === 'cedez') {
            // Pointe en bas ; la cellule est un peu plus large que haute,
            // comme le panneau (2,7 × 2,4 m), pour un triangle équilatéral.
            g.moveTo(-62, -54); g.lineTo(62, -54); g.lineTo(0, 54);
        } else {
            g.roundRect(-26, -60, 52, 120, 10);
        }
        g.closePath();
        if (dos) {
            g.fillStyle = '#8a8f96';
            g.fill();
        } else if (TYPES[k] === 'stop') {
            g.fillStyle = '#c8102e'; g.fill();
            g.lineWidth = 6; g.strokeStyle = '#ffffff'; g.stroke();
            g.fillStyle = '#ffffff';
            g.font = 'bold 34px system-ui, sans-serif';
            g.textAlign = 'center'; g.textBaseline = 'middle';
            g.fillText('STOP', 0, 2);
        } else if (TYPES[k] === 'cedez') {
            g.fillStyle = '#ffffff'; g.fill();
            g.lineWidth = 14; g.lineJoin = 'round'; g.strokeStyle = '#c8102e'; g.stroke();
        } else {
            g.fillStyle = '#1b1d20'; g.fill();
            for (const [dy, teinte] of [[-36, '#ff3b30'], [0, '#ffb000'], [36, '#2fd158']]) {
                g.beginPath(); g.arc(0, dy, 14, 0, 2 * Math.PI); g.fillStyle = teinte; g.fill();
            }
        }
        g.restore();
    };
    for (let k = 0; k < TYPES.length; k++) { forme(k, false); forme(k, true); }
    g.fillStyle = '#8a8f96';
    g.fillRect(3 * CELLULE, 0, CELLULE, CELLULE);
}
const texture = new THREE.CanvasTexture(atlas);
texture.colorSpace = THREE.SRGBColorSpace;
texture.anisotropy = 4;
// Sans lumière : un panneau se lit de jour comme sous les phares.
const MAT_PANNEAUX = courber(new THREE.MeshBasicMaterial({ map: texture, alphaTest: 0.5 }));
const groupeSignaux = new THREE.Group();
scene.add(groupeSignaux);
// Les coordonnées de texture d'une cellule : [u0, v0, u1, v1], le haut du canevas en v = 1.
const cellule = (col, ligne) => [col / 4, 1 - (ligne + 1) / 2, (col + 1) / 4, 1 - ligne / 2];
const GRIS = cellule(3, 0);

function construire(c) {
    const cx = (c.i + 0.5) * CARRE_M, cy = (c.j + 0.5) * CARRE_M;
    const pos = [], uv = [];
    // Un quadrilatère A, B, C, D, dans le sens direct vu de sa face.
    const quad = (A, B, C, D, [u0, v0, u1, v1]) => {
        for (const [P, u, v] of [[A, u0, v0], [B, u1, v0], [C, u1, v1], [A, u0, v0], [C, u1, v1], [D, u0, v1]]) {
            pos.push(P[0], P[1], P[2]); uv.push(u, v);
        }
    };
    let n = 0;
    for (const e of c.sig.liste) {
        const a = aretes.get(e.id);
        if (!a || a.sol < 0) continue;              // tronçon d'un carré pas lu, ou sous terre
        const p = pointArete(a, e.s, e.sens);
        const ux = Math.sin(p.cap * Math.PI / 180), uy = Math.cos(p.cap * Math.PI / 180);
        const rx = uy, ry = -ux;                    // à droite de qui roule
        const largeur = a.largeur > 0 ? a.largeur : LARGEUR_PAR_NATURE[a.nature] || 3;
        const x = p.x + rx * (largeur / 2 + BORD_M), y = p.y + ry * (largeur / 2 + BORD_M);
        const sol = altitudeL93(p.x, p.y);
        const alt = a.sol > 0 && Number.isFinite(p.z) ? p.z
            : Math.max(Number.isFinite(sol) ? sol : 0, Number.isFinite(p.z) ? p.z : -Infinity);
        // En coordonnées de la scène, relatives au centre du carré : X à
        // l'est, Y en haut, Z au sud.
        const ici = (dx, dy, h) => [x + dx - cx, alt + h, cy - (y + dy)];
        const [l, h] = PANNEAU_M[e.type], k = TYPES.indexOf(e.type);
        const bas = POTEAU_M, haut = POTEAU_M + h;
        // La face, vue de qui arrive (sa droite est r) ; le dos, vu de derrière.
        quad(ici(-rx * l / 2, -ry * l / 2, bas), ici(rx * l / 2, ry * l / 2, bas),
             ici(rx * l / 2, ry * l / 2, haut), ici(-rx * l / 2, -ry * l / 2, haut), cellule(k, 0));
        quad(ici(rx * l / 2, ry * l / 2, bas), ici(-rx * l / 2, -ry * l / 2, bas),
             ici(-rx * l / 2, -ry * l / 2, haut), ici(rx * l / 2, ry * l / 2, haut), cellule(k, 1));
        // Le poteau, quatre faces vers le dehors, derrière le panneau.
        const t = POTEAU_EPAIS_M / 2, ox = ux * (t + 0.02), oy = uy * (t + 0.02);
        const coins = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => [ox + (rx * i + ux * j) * t, oy + (ry * i + uy * j) * t]);
        for (let q = 0; q < 4; q++) {
            const [ax, ay] = coins[q], [bx, by] = coins[(q + 1) % 4];
            quad(ici(bx, by, 0), ici(ax, ay, 0), ici(ax, ay, bas + h / 2), ici(bx, by, bas + h / 2), GRIS);
        }
        n++;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    c.sig.mesh = new THREE.Mesh(geo, MAT_PANNEAUX);
    c.sig.mesh.frustumCulled = n > 0;
    geo.computeBoundingSphere();
    ancrer(c.sig.mesh, cx, cy);
    groupeSignaux.add(c.sig.mesh);
}

function defaire(c) {
    const m = c.sig.mesh;
    if (!m) return;
    groupeSignaux.remove(m);
    ancres.delete(m);
    m.geometry.dispose();
    c.sig.mesh = null;
}

/**
 * Les panneaux d'un carré se dessinent avec ses bâtiments, quand le relief
 * et ses routes sont là, et s'en vont avec eux ; ceux d'un carré oublié
 * quittent l'index.
 */
export function majSignalisation() {
    for (const c of indexes) {
        if (carres.get(c.cle) !== c) { oublier(c); continue; }
        if (!c.mesh) { defaire(c); continue; }
        if (!c.sig.mesh) construire(c);
        c.sig.mesh.visible = c.mesh.visible;
    }
}

// --- Le prochain sur la route prévue -------------------------------------------------------
// Annoncé 8 s avant d'y être, et 150 m au moins ; jusqu'à ce que la voiture
// l'ait passé de DEPASSE_M, ce que le GPS ne voit pas toujours à l'arrêt.
const ANNONCE_S = 8, ANNONCE_MIN_M = 150, DEPASSE_M = 3;
/** Le prochain panneau sur la route prévue, dans son sens : { type, d (m) } ; null s'il n'y en a pas d'annoncé. */
export function prochainSignal(v) {
    const ch = v.chemin;
    if (!ch || !v.vue || v.horsRoute) return null;
    const portee = Math.max(ANNONCE_MIN_M, v.v * ANNONCE_S);
    let meilleur = null;
    for (const p of ch.parcours) {
        if (p.debut - v.dChemin > portee) break;
        for (const e of signaux.get(p.a.id) || []) {
            if (e.sens !== p.sens) continue;
            const d = p.debut + (p.sens > 0 ? e.s : p.a.L - e.s) - v.dChemin;
            if (d < -DEPASSE_M || d > portee) continue;
            if (!meilleur || d < meilleur.d) meilleur = { type: e.type, d: Math.max(d, 0) };
        }
    }
    return meilleur;
}
