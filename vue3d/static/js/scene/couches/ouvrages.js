// Murs, ponts, voies ferrées et terrains de sport : une couche à part.

import * as THREE from 'three';
import { URL_OUVRAGES } from '../socle/reseau.js';
import { requete } from '../socle/chargement.js';
import { toLocal, toLonLat } from '../socle/projection.js';
import {
    terrain, altitudeRef, relief, exagVert, reliefRegle, BORNES, ENFONCEMENT,
} from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { reconstruireVegetation } from '../vegetation/etat.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import {
    ESSAIS_MONUMENTS, ATTENTE_MONUMENTS_S, RETARD_ETAT_MONUMENTS_MS, etatCouche,
} from '../interface/etat-couche.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import {
    EAU_MAILLE, subdiviser, trianglesPolygone, trianglesRuban, maillageDrape, placerDrapes,
} from './eau.js';
import { MAT_ROUTE } from './routes.js';
import { enMetres } from './constructions.js';
import { echapper } from '../socle/chargement.js';

// Une couche à part (/api/ouvrages, vue3d/ouvrages.py), demandée une fois la
// scène affichée, comme les monuments OSM : rien de ce qu'elle décrit n'entre
// dans un calcul de la scène.
//
// Voies au sol et terrains sont drapés sur le relief, comme les routes. Murs,
// ponts et voies sur ouvrage sont des volumes : la BD TOPO donne l'ALTITUDE du
// haut de l'ouvrage à chaque sommet, le pied ou le dessous se comptent depuis
// le relief de la scène. Un pont n'est que son tablier : ni piles ni arches ne
// sont décrites, et l'aqueduc du Pont du Gard est un ruban à 48 m du Gardon.
// Un sommet tous les 2 m le long d'un ouvrage : la maille du terrain, que le
// pied d'un mur doit suivre.
const OUVRAGE_PAS = 2;
// Conventions : la BD TOPO ne donne l'épaisseur ni d'un mur, ni d'un tablier,
// ni d'un ballast.
const MUR_EPAISSEUR = 1;
const TABLIER_EPAISSEUR = 1;
const BALLAST_EPAISSEUR = 0.3;
// Sous les routes (ROUTE_DECALAGE) pour les terrains, entre routes et eau pour
// les voies : un passage à niveau montre la voie, un terrain ne couvre rien.
// Les terrains s'étagent d'un centimètre par nature, la plus étendue dessous :
// une piste d'athlétisme entoure son terrain de football, et deux aplats à la
// même hauteur scintilleraient l'un dans l'autre.
const TERRAIN_SPORT_DECALAGE = 0.04;
const TERRAIN_SPORT_ETAGE = 0.01;
const VOIE_DECALAGE = 0.12;
// Un tablier ne passe jamais sous le relief : à ses culées, l'altitude BD TOPO
// et le RGE ALTI diffèrent d'un mètre ou deux, dans un sens ou dans l'autre.
const TABLIER_PLANCHER = 0.15;
const MAT_MUR = new THREE.MeshStandardMaterial({ color: 0xa79d8e, roughness: 0.95, flatShading: true });
const MAT_TABLIER = new THREE.MeshStandardMaterial({ color: 0x8b8f95, roughness: 0.9, flatShading: true });
const MAT_BALLAST_VOLUME = new THREE.MeshStandardMaterial({ color: 0x6a5f58, roughness: 1, flatShading: true });
const MAT_BALLAST = MAT_ROUTE.clone();
MAT_BALLAST.color.set(0x6a5f58);
// L'orthophoto montre déjà le terrain : l'aplat s'y superpose, translucide, et
// le dit encore sur le Plan IGN.
const COULEURS_TERRAIN = {
    'Grand terrain de sport': 0x4f8f4a, 'Petit terrain multi-sports': 0x5d8f77,
    'Terrain de tennis': 0xb5673f, 'Piste de sport': 0xa8503c, 'Bassin de natation': 0x3f8fbf,
};
const MATS_TERRAIN = new Map();
function materiauTerrain(nature) {
    if (!MATS_TERRAIN.has(nature)) {
        const m = MAT_ROUTE.clone();
        m.color.set(COULEURS_TERRAIN[nature] || 0x6f9f6a);
        m.opacity = 0.5;
        MATS_TERRAIN.set(nature, m);
    }
    return MATS_TERRAIN.get(nature);
}
export let OUVRAGES = null;
export const groupeOuvrages = new THREE.Group();
scene.add(groupeOuvrages);
const ouvragesPoses = [];        // volumes : { mesh, alts, hauts }
const ouvragesSurvol = [];
ajouterCiblesSurvol(() => groupeOuvrages.visible ? ouvragesSurvol : []);
poserSurLeRelief({ construire: construireOuvrages,
                   placer: () => { if (ouvragesPoses.length) placerOuvrages(); } });
let ouvragesConstruits = false;
// Murs et ponts dessinés : les masses du MNH qu'ils expliquent sont retirées.
export let ouvragesEnVolume = false;

/**
 * Stations d'une ligne [lon, lat, z], tous les `pas` mètres : position en
 * mètres locaux, altitude interpolée, normale unitaire à gauche du sens de
 * parcours.
 */
function stationsLeLong(ligne, pas) {
    const brut = ligne.map(([lo, la, z]) => [...toLocal(lo, la), z]);
    const pts = [brut[0]];
    for (let i = 1; i < brut.length; i++) {
        const [ax, ay, az] = brut[i - 1], [bx, by, bz] = brut[i];
        const d = Math.hypot(bx - ax, by - ay);
        if (d === 0) continue;                  // sommet doublé : pas de normale
        const n = Math.ceil(d / pas);
        for (let k = 1; k <= n; k++) pts.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n, az + (bz - az) * k / n]);
    }
    return pts.map((p, i) => {
        const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        return { x: p[0], y: p[1], z: p[2], nx: -dy / l, ny: dx / l };
    });
}

/**
 * Volume fermé le long de stations : une section rectangulaire de `largeur`,
 * entre deux niveaux. `haut` et `bas` donnent, pour une station, le niveau de
 * ses sommets : { z, dz } — altitude absolue (null : le sol) et décalage.
 * Triangles orientés vers l'extérieur, en mètres locaux.
 */
function prismeLeLong(stations, largeur, haut, bas) {
    const coin = (s, cote, niveau) => ({ x: s.x + cote * s.nx * largeur / 2,
                                         y: s.y + cote * s.ny * largeur / 2, ...niveau(s) });
    const tris = [];
    const quad = (a, b, c, d) => tris.push([a, b, c], [a, c, d]);
    for (let i = 0; i < stations.length - 1; i++) {
        const s = stations[i], t = stations[i + 1];
        const gb0 = coin(s, 1, bas), gh0 = coin(s, 1, haut), db0 = coin(s, -1, bas), dh0 = coin(s, -1, haut);
        const gb1 = coin(t, 1, bas), gh1 = coin(t, 1, haut), db1 = coin(t, -1, bas), dh1 = coin(t, -1, haut);
        quad(gh0, dh0, dh1, gh1);                                  // dessus
        quad(gb0, gb1, db1, db0);                                  // dessous
        quad(gb0, gh0, gh1, gb1);                                  // flanc gauche
        quad(db0, db1, dh1, dh0);                                  // flanc droit
        if (i === 0) quad(gb0, db0, dh0, gh0);                     // about de départ
        if (i === stations.length - 2) quad(gb1, gh1, dh1, db1);   // about d'arrivée
    }
    return tris;
}

/**
 * Dalle fermée sur un contour [lon, lat, z] et ses trous : dessus à l'altitude
 * des sommets, dessous `epaisseur` plus bas, chants entre les deux.
 */
function dalle(contour, trous, epaisseur) {
    const local = a => a.map(([lo, la, z]) => { const [x, y] = toLocal(lo, la); return { x, y, z }; });
    const plans = a => a.map(p => new THREE.Vector2(p.x, p.y));
    const anneaux = [local(contour), ...trous.map(local)];
    const traces = anneaux.map(plans);
    // triangulateShape retire les sommets de fermeture en place : les index
    // renvoyés portent sur les tableaux ainsi raccourcis.
    const faces = THREE.ShapeUtils.triangulateShape(traces[0], traces.slice(1));
    const ouverts = anneaux.map((a, i) => a.slice(0, traces[i].length));
    const pts = ouverts.flat();
    const dessus = p => ({ ...p, dz: 0 }), dessous = p => ({ ...p, dz: -epaisseur });
    const tris = [];
    for (const [a, b, c] of faces) {
        const [p, q, r] = [pts[a], pts[b], pts[c]];
        const aire = (q.x - p.x) * (r.y - p.y) - (r.x - p.x) * (q.y - p.y);
        const [u, v, w] = aire >= 0 ? [p, q, r] : [p, r, q];        // trigonométrique vu du ciel
        tris.push([dessus(u), dessus(v), dessus(w)], [dessous(u), dessous(w), dessous(v)]);
    }
    ouverts.forEach((a, n) => {
        // Matière à gauche du parcours : le contour en sens trigonométrique,
        // un trou dans le sens des aiguilles.
        let aire = 0;
        for (let i = 0; i < a.length; i++) { const p = a[i], q = a[(i + 1) % a.length]; aire += p.x * q.y - q.x * p.y; }
        const tour = (aire >= 0) === (n === 0) ? a : a.slice().reverse();
        for (let i = 0; i < tour.length; i++) {
            const p = tour[i], q = tour[(i + 1) % tour.length];
            tris.push([dessous(p), dessous(q), dessus(q)], [dessous(p), dessus(q), dessus(p)]);
        }
    });
    return tris;
}

/** Altitude du terrain sous un point local, ramené dans l'emprise (maillageDrape). */
function altSolBorne(x, y) {
    if (!terrain) return null;
    const [lo, la] = toLonLat(x, y);
    return terrain.alt(Math.min(Math.max(lo, BORNES.o), BORNES.e),
                       Math.min(Math.max(la, BORNES.s), BORNES.n));
}

/**
 * Un volume posé sur le relief, à partir de triangles de sommets
 * { x, y, z, dz }. Sa hauteur au-dessus du sol est fixée ici, une fois : z − sol
 * (au moins `plancher`), ou 0 si z est null, plus dz. placerOuvrages() n'a plus
 * qu'à suivre l'exagération du relief.
 */
function maillagePose(tris, materiau, plancher) {
    const n = tris.length * 3;
    const positions = new Float32Array(n * 3);
    const alts = new Float64Array(n), hauts = new Float32Array(n);
    let k = 0;
    for (const t of tris) {
        for (const s of t) {
            positions[k * 3] = s.x; positions[k * 3 + 2] = -s.y;
            const a = altSolBorne(s.x, s.y);
            alts[k] = a == null ? NaN : a;
            hauts[k] = (s.z == null || a == null ? 0 : Math.max(s.z - a, plancher)) + s.dz;
            k++;
        }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geo, materiau);
    mesh.castShadow = true; mesh.receiveShadow = true;
    groupeOuvrages.add(mesh);
    ouvragesPoses.push({ mesh, alts, hauts });
    return mesh;
}

/** Même règle que le terrain : le sol suit l'exagération, les hauteurs restent vraies. */
function placerOuvrages() {
    for (const { mesh, alts, hauts } of ouvragesPoses) {
        const pos = mesh.geometry.attributes.position;
        for (let k = 0; k < pos.count; k++) {
            const a = alts[k];
            pos.setY(k, (relief && terrain && !Number.isNaN(a) ? (a - altitudeRef) * exagVert : 0) + hauts[k]);
        }
        pos.needsUpdate = true;
        mesh.geometry.computeVertexNormals();
        mesh.geometry.computeBoundingSphere();
    }
}

function construireOuvrages() {
    if (!OUVRAGES || !reliefRegle || ouvragesConstruits) return;
    ouvragesConstruits = true;
    const polygones = g => g.type === 'Polygon' ? [g.coordinates]
                         : g.type === 'MultiPolygon' ? g.coordinates : [];
    // Un maillage par matériau plutôt que par objet, comme les routes.
    const ballast = [];
    for (const v of OUVRAGES.voies) if (v.au_sol) ballast.push(...trianglesRuban(v.ligne, v.largeur_m));
    if (ballast.length) maillageDrape(ballast, MAT_BALLAST, groupeOuvrages, VOIE_DECALAGE);
    const parNature = new Map();
    for (const t of OUVRAGES.terrains) {
        if (!parNature.has(t.nature)) parNature.set(t.nature, []);
        for (const p of polygones(t.geometrie)) parNature.get(t.nature).push(...subdiviser(trianglesPolygone(p), EAU_MAILLE));
    }
    const aire = tris => tris.reduce((somme, [a, b, c]) =>
        somme + Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2, 0);
    [...parNature].filter(([, tris]) => tris.length)
        .sort((u, v) => aire(v[1]) - aire(u[1]))
        .forEach(([nature, tris], rang) => maillageDrape(
            tris, materiauTerrain(nature), groupeOuvrages,
            TERRAIN_SPORT_DECALAGE + TERRAIN_SPORT_ETAGE * rang));
    placerDrapes();

    // Les volumes se comptent depuis le relief : sans lui, ni mur ni pont.
    if (terrain) {
        const auSol = () => ({ z: null, dz: -ENFONCEMENT });
        const sommet = dz => s => ({ z: s.z, dz });
        for (const m of OUVRAGES.murs) {
            const stations = stationsLeLong(m.ligne, OUVRAGE_PAS);
            if (stations.length < 2) continue;
            const mesh = maillagePose(prismeLeLong(stations, MUR_EPAISSEUR, sommet(0), auSol), MAT_MUR, 0);
            mesh.userData = { infobulle: `<b>${echapper(m.nom || m.detail || m.nature)}</b>`
                + `<br>haut de ${enMetres(m.h)} <i>(altitude BD TOPO de son sommet, moins le relief)</i>` };
            ouvragesSurvol.push(mesh);
        }
        for (const p of OUVRAGES.ponts) {
            let tris;
            if (p.ligne) {
                const stations = stationsLeLong(p.ligne, OUVRAGE_PAS);
                if (stations.length < 2) continue;
                tris = prismeLeLong(stations, p.largeur_m, sommet(0), sommet(-TABLIER_EPAISSEUR));
            } else {
                tris = dalle(p.contour, p.trous || [], TABLIER_EPAISSEUR);
            }
            const mesh = maillagePose(tris, MAT_TABLIER, TABLIER_PLANCHER);
            mesh.userData = { infobulle: `<b>${echapper(p.nom || p.detail || p.nature)}</b>`
                + ((p.nom || p.detail) ? `<br>${echapper(p.nature)}` : '')
                + `<br>tablier jusqu'à ${enMetres(p.h)} du sol <i>(altitude BD TOPO, moins le relief)</i>`
                + (p.ligne ? `<br>large de ${enMetres(p.largeur_m)} `
                             + (p.largeur_mesuree ? '<i>(chaussée BD TOPO)</i>' : '<i>(convention)</i>') : '')
                + '<br><i>piles et arches ne sont pas décrites</i>' };
            ouvragesSurvol.push(mesh);
        }
        // Voies sur ouvrage : un ballast posé à leur altitude, sur le tablier.
        const ballastHaut = [];
        for (const v of OUVRAGES.voies) {
            if (v.au_sol) continue;
            const stations = stationsLeLong(v.ligne, OUVRAGE_PAS);
            if (stations.length >= 2) ballastHaut.push(...prismeLeLong(stations, v.largeur_m, sommet(BALLAST_EPAISSEUR), sommet(0)));
        }
        if (ballastHaut.length) maillagePose(ballastHaut, MAT_BALLAST_VOLUME, TABLIER_PLANCHER);
        ouvragesEnVolume = ouvragesSurvol.length > 0;
        placerOuvrages();
    }
    document.getElementById('t-ouvrages').hidden = !groupeOuvrages.children.length;
    majCiblesSurvol();
    // Les masses qu'un mur ou un tablier explique quittent la végétation.
    if (ouvragesEnVolume) reconstruireVegetation();
}

export async function chargerOuvrages(essai = 1) {
    // Au premier essai seulement : ensuite l'indicateur est déjà affiché.
    const retard = setTimeout(
        () => etatCouche('etat-ouvrages', 'Ouvrages BD TOPO : chargement…', true),
        essai === 1 ? RETARD_ETAT_MONUMENTS_MS : 0);
    try {
        const r = await requete(URL_OUVRAGES);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const o = await r.json();
        clearTimeout(retard);
        etatCouche('etat-ouvrages', null);
        if (!o) return;                       // aucun ouvrage sur l'emprise
        OUVRAGES = o;
        construireOuvrages();
    } catch (e) {
        clearTimeout(retard);
        if (essai >= ESSAIS_MONUMENTS) {
            etatCouche('etat-ouvrages', 'Ouvrages BD TOPO indisponibles : recharger la page pour réessayer.');
            return;
        }
        // La roue reste : un nouvel essai est prévu, le chargement n'est pas fini.
        etatCouche('etat-ouvrages', `Ouvrages BD TOPO indisponibles : nouvel essai dans ${ATTENTE_MONUMENTS_S} s.`, true);
        setTimeout(() => chargerOuvrages(essai + 1), ATTENTE_MONUMENTS_S * 1000);
    }
}

document.getElementById('t-ouvrages').addEventListener('click', e => {
    groupeOuvrages.visible = !groupeOuvrages.visible;
    e.currentTarget.classList.toggle('on', groupeOuvrages.visible);
    majCiblesSurvol();
    if (ouvragesEnVolume) reconstruireVegetation();
});
