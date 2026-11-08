// Les éoliennes d'OpenStreetMap : mât, nacelle et rotor qui tourne.

import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { URL_EOLIENNES } from '../socle/reseau.js';
import { requete } from '../socle/chargement.js';
import { toLocal } from '../socle/projection.js';
import { terrain, altitudeRef, relief, exagVert, anneauRelief, reliefRegle } from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import { citerSource, majCredits } from '../interface/credits.js';
import {
    ESSAIS_MONUMENTS, ATTENTE_MONUMENTS_S, RETARD_ETAT_MONUMENTS_MS, etatCouche,
} from '../interface/etat-couche.js';
import { poserSurLeRelief } from '../terrain/relief.js';

// Une couche à part (/api/eoliennes, vue3d/eoliennes.py), sur l'emprise de
// l'anneau comme les lignes à haute tension : une éolienne de 150 m se voit de
// plusieurs kilomètres. Chacune porte la hauteur de son moyeu et le diamètre de
// son rotor, tirés de ses tags OpenStreetMap ou, à défaut, de sa classe de
// puissance (`estime`).
//
// Le mât est le seul volume mesuré : le nuage LiDAR HD le classe en sursol
// pérenne, et un cercle ajusté tranche par tranche à 27 mâts de 60 à 137 m de
// moyeu donne son rayon au pied (outils/mesure_eoliennes.py lidar) : 1,5 m à
// 60 m, 1,9 à 2,2 m à 84 m, 2,5 m à 137 m, soit 1,208 + 0,0091 × moyeu à
// 0,16 m près. Le plus petit, à 60 m, fait 0,0254 fois son moyeu : en deçà, le
// rayon suit le moyeu dans cette proportion — le plus petit des deux, qui se
// croisent à 74 m. Aux sept dixièmes du moyeu, il ne reste que 0,75 du rayon
// au pied (21 mâts dont le profil monte jusque-là) : la même pente prolongée
// jusqu'au moyeu laisse 0,65.
const RAYON_PIED_PART_MOYEU = 0.0254;
const RAYON_PIED_M = 1.208, RAYON_PIED_PAR_M = 0.0091;
const RAYON_TETE_PART = 0.65;
// Le pied s'enfonce sous le sol : un mât de 2,5 m de rayon sur une pente de
// 100 % en sort de 2,5 m d'un côté.
const PIED_ENTERRE_M = 3;
// Nacelle, moyeu et pales ne sont pas mesurés : des proportions de convention,
// rapportées au diamètre du rotor, celles d'une machine de 2 à 3 MW (une
// nacelle d'une dizaine de mètres pour un rotor de 90 m).
const NACELLE = { long: 0.12, large: 0.04, haut: 0.045, avant: 0.65 };   // avant : part devant le mât
const MOYEU = { rayon: 0.025, long: 0.07, avant: 0.6 };                 // avant : part devant le plan du rotor
// Corde et épaisseur des pales, en part du rayon du rotor, de l'emplanture au
// bout : [part de la pale, corde, épaisseur].
const PROFIL_PALE = [[0, 0.05, 0.05], [0.08, 0.075, 0.03], [0.2, 0.08, 0.02], [0.45, 0.06, 0.012],
                     [0.75, 0.035, 0.008], [1, 0.015, 0.004]];
const COTES_MAT = 24, COTES_MOYEU = 16, COTES_PALE = 6;
// Sans mesure du vent sur place, le rotor regarde l'ouest, d'où vient le vent
// dominant sur l'essentiel du pays — pas dans la vallée du Rhône ni en
// Languedoc, où le mistral et la tramontane soufflent du nord et du
// nord-ouest. Azimut d'où vient le vent, en degrés depuis le nord.
const VENT_DOMINANT_DEG = 270;
// Au régime nominal, le bout des pales d'une grande éolienne file à 60 à
// 80 m/s, quelle que soit sa taille (vitesse spécifique de 7 à 8 par vent de 8
// à 10 m/s) : un rotor de 90 m fait 14 tours par minute. Une convention. Le
// curseur « vitesse » la règle : à sa valeur par défaut (6), le régime
// nominal ; à son minimum (1), le rotor s'arrête — le curseur ne descend pas
// à 0, le drone en a besoin.
const BOUT_DE_PALE_M_S = 70;
const VITESSE_NOMINALE = 6, VITESSE_ARRET = 1;
export const MAT_EOLIENNE = new THREE.MeshStandardMaterial({ color: 0xe4e6e3, roughness: 0.45, metalness: 0.2 });
// Arête vive au-delà : les flancs du mât et des pales lissés, leurs bouts nets.
const ANGLE_PLI = 40 * Math.PI / 180;

const groupeEoliennes = new THREE.Group();
scene.add(groupeEoliennes);
let EOLIENNES = null;            // { eoliennes }
const posees = [];               // { groupe, lon, lat, mer }
const rotors = [];               // { objet, omega }
const ciblesEoliennes = [];
const geometries = new Map();    // « moyeu|rotor » -> { fixe, rotor, avance }
ajouterCiblesSurvol(() => groupeEoliennes.visible ? ciblesEoliennes : []);
citerSource('eoliennes', () => posees.length > 0 && groupeEoliennes.visible);
poserSurLeRelief({ construire: construireEoliennes, placer: () => { if (posees.length) placerEoliennes(); } });

/** Rayon du mât au pied, d'après la hauteur du moyeu (mesure en tête). */
function rayonPiedMat(hMoyeu) {
    return Math.min(RAYON_PIED_PART_MOYEU * hMoyeu, RAYON_PIED_M + RAYON_PIED_PAR_M * hMoyeu);
}

/**
 * Volume fermé qui passe par des anneaux successifs le long de +y : chaque
 * anneau, une liste de points [x, y, z] dans le sens trigonométrique vu de +y,
 * tous du même nombre de points. Les deux bouts sont fermés autour de leur
 * centre. Triangles tournés vers l'extérieur.
 */
function loft(anneaux) {
    const tris = [];
    const centre = a => [0, 1, 2].map(k => a.reduce((s, p) => s + p[k], 0) / a.length);
    const n = anneaux[0].length;
    for (let k = 0; k + 1 < anneaux.length; k++) {
        const A = anneaux[k], B = anneaux[k + 1];
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            tris.push([A[i], A[j], B[j]], [A[i], B[j], B[i]]);
        }
    }
    const bas = anneaux[0], haut = anneaux[anneaux.length - 1], cb = centre(bas), ch = centre(haut);
    for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        tris.push([cb, bas[j], bas[i]], [ch, haut[i], haut[j]]);
    }
    return tris;
}

/** Anneau à `y` : ellipse de demi-axes `a` (en x) et `b` (en z), en `n` points. */
function anneauEllipse(a, b, y, n, phase = 0) {
    const pts = [];
    for (let i = 0; i < n; i++) {
        const t = phase + 2 * Math.PI * i / n;
        pts.push([a * Math.cos(t), y, -b * Math.sin(t)]);
    }
    return pts;
}

/** Les triangles tournés pour que +y devienne +x (un quart de tour autour de z). */
function versAxeX(tris) {
    return tris.map(t => t.map(([x, y, z]) => [y, -x, z]));
}

/** Les triangles déplacés de [dx, dy, dz]. */
function deplaces(tris, [dx, dy, dz]) {
    return tris.map(t => t.map(([x, y, z]) => [x + dx, y + dy, z + dz]));
}

/**
 * Les volumes d'une éolienne, en mètres, pied du mât à l'origine, y vers le
 * haut, x dans l'axe du rotor, vers le vent : { fixe: [{ partie, tris }],
 * rotor: [...], avance } — le mât et la nacelle, puis le moyeu et les trois
 * pales dans le repère du rotor (centre du moyeu à l'origine, axe x), que la
 * page fait tourner, placé à `avance` devant le mât, à la hauteur du moyeu.
 */
function blocsEolienne(hMoyeu, dRotor) {
    const R = dRotor / 2;
    const n = { L: NACELLE.long * dRotor, l: NACELLE.large * dRotor, h: NACELLE.haut * dRotor };
    const rPied = rayonPiedMat(hMoyeu), rTete = RAYON_TETE_PART * rPied;
    const sommetMat = hMoyeu - n.h / 2;
    // Le mât, droit de -PIED_ENTERRE_M à sa tête : son rayon suit la pente
    // mesurée, prolongée sous le sol.
    const pente = (rPied - rTete) / hMoyeu;
    const mat = loft([anneauEllipse(rPied + pente * PIED_ENTERRE_M, rPied + pente * PIED_ENTERRE_M,
                                    -PIED_ENTERRE_M, COTES_MAT),
                      anneauEllipse(rTete + pente * (n.h / 2), rTete + pente * (n.h / 2), sommetMat, COTES_MAT)]);
    // La nacelle : une boîte le long de x, en loft carré autour de +y tourné.
    const carre = (y) => anneauEllipse(Math.SQRT2 * n.h / 2, Math.SQRT2 * n.l / 2, y, 4, Math.PI / 4);
    const nacelle = deplaces(versAxeX(loft([carre(0), carre(n.L)])),
                             [-(1 - NACELLE.avant) * n.L, hMoyeu, 0]);
    // Le moyeu, un cône le long de x, son nez vers le vent.
    const m = { r: MOYEU.rayon * dRotor, L: MOYEU.long * dRotor };
    const moyeu = deplaces(versAxeX(loft([anneauEllipse(m.r, m.r, 0, COTES_MOYEU),
                                          anneauEllipse(0.7 * m.r, 0.7 * m.r, 0.6 * m.L, COTES_MOYEU),
                                          anneauEllipse(0.2 * m.r, 0.2 * m.r, m.L, COTES_MOYEU)])),
                           [-(1 - MOYEU.avant) * m.L, 0, 0]);
    // Une pale le long de +y, sa corde dans le plan du rotor (z), de
    // l'intérieur du moyeu à R ; les deux autres tournées d'un tiers de tour.
    const racine = 0.6 * m.r;
    const pale = loft(PROFIL_PALE.map(([t, corde, epaisseur]) =>
        anneauEllipse(epaisseur * R / 2, corde * R / 2, racine + t * (R - racine), COTES_PALE)));
    const tournee = (tris, a) => tris.map(t => t.map(([x, y, z]) =>
        [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)]));
    return {
        fixe: [{ partie: 'mât', tris: mat }, { partie: 'nacelle', tris: nacelle }],
        rotor: [{ partie: 'moyeu', tris: moyeu },
                ...[0, 1, 2].map(k => ({ partie: 'pale', tris: tournee(pale, 2 * Math.PI * k / 3) }))],
        avance: NACELLE.avant * n.L + (1 - MOYEU.avant) * m.L,
    };
}

/** Une géométrie lissée des blocs, arêtes vives au-delà d'ANGLE_PLI. */
function geometrieDe(blocs) {
    const pos = [];
    for (const b of blocs) for (const t of b.tris) for (const p of t) pos.push(...p);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return toCreasedNormals(geo, ANGLE_PLI);
}

function geometriesEolienne(hMoyeu, dRotor) {
    const cle = `${hMoyeu}|${dRotor}`;
    if (!geometries.has(cle)) {
        const b = blocsEolienne(hMoyeu, dRotor);
        geometries.set(cle, { fixe: geometrieDe(b.fixe), rotor: geometrieDe(b.rotor), avance: b.avance });
    }
    return geometries.get(cle);
}

// « 84 m », « 52,9 m » ; « 2,3 MW », « 3,45 MW », « 800 kW ».
const metres = v => `${String(Math.round(v * 10) / 10).replace('.', ',')} m`;
const puissance = kw => kw >= 1000 ? `${String(Math.round(kw / 10) / 100).replace('.', ',')} MW`
                                    : `${String(Math.round(kw * 10) / 10).replace('.', ',')} kW`;

function infobulle(e) {
    const estimee = cle => e.estime.includes(cle) ? ' <i>(estimé)</i>' : '';
    const titre = e.nom || (e.ref ? `Éolienne ${e.ref}` : 'Éolienne');
    return `<b>${titre}</b>` + (e.nom && e.ref && e.ref !== e.nom ? ` (${e.ref})` : '')
        + (e.modele || e.puissance_kw != null
            ? `<br>${[e.modele, e.puissance_kw != null ? puissance(e.puissance_kw) : null].filter(Boolean).join(' · ')}`
            : '')
        + (e.operateur ? `<br>exploitée par ${e.operateur}` : '')
        + `<br>moyeu à ${metres(e.h_moyeu)}${estimee('h_moyeu')}, rotor de ${metres(e.d_rotor)}${estimee('d_rotor')}`
        + `<br>${metres(e.h_total)} en bout de pale`
        + (e.estime.length ? '<br><i>estimé : d\'après la puissance ou la hauteur, faute de mesure dans OSM</i>' : '')
        + `<br><i>OpenStreetMap, ${e.osm}</i>`;
}

/** Sol sous un point : terrain de la scène, sinon anneau, sinon null. */
function altSolEtendu(lon, lat) {
    const a = terrain ? terrain.alt(lon, lat) : null;
    if (a != null) return a;
    const b = anneauRelief ? anneauRelief.alt(lon, lat) : null;
    return b != null && !Number.isNaN(b) ? b : null;
}

function construireEoliennes() {
    if (!EOLIENNES || !reliefRegle || posees.length) return;
    // L'azimut d'où vient le vent devient le cap de l'axe x des blocs : à
    // l'est (+X) pour 90°, au nord (-Z) pour 0°.
    const cap = Math.PI / 2 - VENT_DOMINANT_DEG * Math.PI / 180;
    for (const e of EOLIENNES.eoliennes) {
        const g = geometriesEolienne(e.h_moyeu, e.d_rotor);
        const groupe = new THREE.Group();
        const fixe = new THREE.Mesh(g.fixe, MAT_EOLIENNE);
        const pivot = new THREE.Group();
        const rotor = new THREE.Mesh(g.rotor, MAT_EOLIENNE);
        fixe.castShadow = rotor.castShadow = true;
        fixe.receiveShadow = true;
        // Le rotor tourne sans cesse : son ombre suit la carte figée pendant
        // que la caméra bouge (interface/boucle.js), comme le reste.
        rotor.userData.tourne = true;
        fixe.userData.infobulle = rotor.userData.infobulle = infobulle(e);
        pivot.position.set(g.avance, e.h_moyeu, 0);
        // Chaque rotor part d'un autre angle : le parc ne tourne pas d'un bloc.
        pivot.rotation.x = (posees.length * 2.4) % (2 * Math.PI / 3);
        pivot.add(rotor);
        groupe.add(fixe, pivot);
        const [x, y] = toLocal(e.lon, e.lat);
        groupe.position.set(x, 0, -y);
        groupe.rotation.y = cap;
        groupeEoliennes.add(groupe);
        posees.push({ groupe, lon: e.lon, lat: e.lat, mer: e.mer });
        rotors.push({ objet: pivot, omega: BOUT_DE_PALE_M_S / (e.d_rotor / 2) });
        ciblesEoliennes.push(fixe, rotor);
    }
    placerEoliennes();
    const bouton = document.getElementById('t-eoliennes');
    bouton.hidden = !posees.length;
    bouton.title = `${posees.length} éolienne(s) d'OpenStreetMap jusqu'à l'anneau`;
    majCiblesSurvol();
    majCredits();
}

/** Pieds sur le sol exagéré, hauteurs réelles, comme les pylônes. En mer, le
 * niveau de la mer ; hors de tout relief, celui du centre de la scène. */
function placerEoliennes() {
    for (const p of posees) {
        const alt = altSolEtendu(p.lon, p.lat) ?? (p.mer ? 0 : altitudeRef);
        p.groupe.position.y = relief && terrain ? (alt - altitudeRef) * exagVert : 0;
    }
}

/** Fait tourner les rotors de `dt` secondes, au régime que règle le curseur. */
export function tournerEoliennes(dt, vitesse) {
    if (!rotors.length || !groupeEoliennes.visible) return;
    const regime = Math.max(0, vitesse - VITESSE_ARRET) / (VITESSE_NOMINALE - VITESSE_ARRET);
    // Dans le sens des aiguilles d'une montre vu de face, depuis le vent : en
    // arrière autour de l'axe x, qui pointe vers lui.
    for (const r of rotors) r.objet.rotation.x -= r.omega * regime * dt;
}

const etatEoliennes = (texte, enCours = false) => etatCouche('etat-eoliennes', texte, enCours);

export async function chargerEoliennes(essai = 1) {
    // Au premier essai seulement : ensuite l'indicateur est déjà affiché.
    const retard = setTimeout(() => etatEoliennes('Éoliennes OpenStreetMap : chargement…', true),
                              essai === 1 ? RETARD_ETAT_MONUMENTS_MS : 0);
    try {
        const r = await requete(URL_EOLIENNES);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const couche = await r.json();
        clearTimeout(retard);
        etatEoliennes(null);
        if (!couche || !couche.eoliennes || !couche.eoliennes.length) return;   // presque partout
        EOLIENNES = couche;
        construireEoliennes();
    } catch (e) {
        clearTimeout(retard);
        if (essai >= ESSAIS_MONUMENTS) {
            etatEoliennes('Éoliennes OpenStreetMap indisponibles : recharger la page pour réessayer.');
            return;
        }
        etatEoliennes(`Éoliennes OpenStreetMap indisponibles : nouvel essai dans ${ATTENTE_MONUMENTS_S} s.`, true);
        setTimeout(() => chargerEoliennes(essai + 1), ATTENTE_MONUMENTS_S * 1000);
    }
}

document.getElementById('t-eoliennes').addEventListener('click', e => {
    groupeEoliennes.visible = !groupeEoliennes.visible;
    e.currentTarget.classList.toggle('on', groupeEoliennes.visible);
    majCiblesSurvol();
    majCredits();
});
