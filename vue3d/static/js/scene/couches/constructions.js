// Réservoirs, cheminées, tours et mâts de la BD TOPO.

import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { HAUTEUR_PAR_ETAGE } from '../../commun/regles.js';
import { ARTEFACT } from '../socle/chargement.js';
import { toLocal } from '../socle/projection.js';
import { terrain, relief, ySol, ENFONCEMENT, baseBatiment } from '../terrain/etat.js';
import { scene } from '../socle/rendu.js';
import { MAT_INCONNU } from '../batiments/etat.js';
import { ANGLE_PLI_TOIT, anneauVersShape } from '../batiments/toits.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import { poserSurLeRelief } from '../terrain/relief.js';
import { MAT_PYLONE } from './lignes.js';
import { echapper } from '../socle/chargement.js';

// Citernes, châteaux d'eau, torchères, cheminées, antennes et mâts de la BD
// TOPO (vue3d/constructions.py), dans la scène parce que le serveur les retire
// du sursol avant de segmenter les houppiers. Un réservoir est son emprise,
// montée à sa hauteur. Une construction ponctuelle n'est qu'un point et une
// hauteur : son rayon est celui de sa tache dans le MNH quand le LiDAR la voit
// (2,8 m en médiane sur 52 d'entre elles), sinon une convention par nature.
export const MAT_RESERVOIR = new THREE.MeshStandardMaterial({ color: 0xd4d8db, roughness: 0.5, metalness: 0.3 });
export const MAT_CHEMINEE = new THREE.MeshStandardMaterial({ color: 0xb3a79b, roughness: 0.9 });
const groupeConstructions = new THREE.Group();
scene.add(groupeConstructions);
const constructionsPosees = [];     // { objet, contour } ou { objet, lon, lat }
const constructionsSurvol = [];
ajouterCiblesSurvol(() => groupeConstructions.visible ? constructionsSurvol : []);
poserSurLeRelief({ construire: construireConstructions,
                   placer: () => { if (constructionsPosees.length) placerConstructions(); } });
const SOURCES_HAUTEUR = { bdtopo: 'BD TOPO', lidar_hd: 'mesurée au LiDAR',
                          mns_mnt: 'estimée par photogrammétrie' };
export const enMetres = v => v.toFixed(1).replace('.', ',') + ' m';

export const MAT_TOUR = new THREE.MeshStandardMaterial({ color: 0xc9c4bb, roughness: 0.95,
                                                        side: THREE.DoubleSide });

/** Bâtiments que remplace une tour de refroidissement (vue3d/constructions.py). */
export function toursRemplacees() {
    const tours = (ARTEFACT && ARTEFACT.constructions && ARTEFACT.constructions.tours) || [];
    return new Set(tours.map(t => t.cleabs));
}

/**
 * Coque d'une tour de refroidissement, pied à y = 0 : une hyperbole de
 * révolution, ouverte en haut et en bas. La BD TOPO ne donne que le rayon du
 * pied et la hauteur ; le col est pris aux quatre cinquièmes de la hauteur, à
 * 0,58 fois le rayon du pied, la courbe passant par le pied. La bouche sort
 * alors à 0,62 fois le pied : à Gardanne, 34 m pour 55, quand l'orthophoto
 * montre une bouche d'environ 35 m de rayon.
 */
function coqueTour(t) {
    const zCol = 0.8 * t.h, rCol = 0.58 * t.r;
    const b = zCol / Math.sqrt((t.r / rCol) ** 2 - 1);
    const profil = [];
    for (let i = 0; i <= 24; i++) {
        const z = t.h * i / 24;
        profil.push(new THREE.Vector2(rCol * Math.sqrt(1 + ((z - zCol) / b) ** 2), z));
    }
    return new THREE.LatheGeometry(profil, 64);
}

/** Volume d'une construction ponctuelle, pied à y = 0, et son matériau. */
function volumeConstruction(p) {
    const borne = (v, min, max) => Math.min(Math.max(v, min), max);
    let geo, materiau = MAT_PYLONE;
    if (p.nature === 'Cheminée') {
        // Fût légèrement conique. Sans mesure, un quatorzième de la hauteur :
        // le rapport médian de neuf cheminées de 30 à 57 m que le LiDAR voit
        // (1,1 à 3,9 m de rayon).
        const r = p.r ?? borne(p.h / 14, 0.8, 4);
        geo = new THREE.CylinderGeometry(r * 0.7, r, p.h, 16);
        materiau = MAT_CHEMINEE;
    } else if (p.r != null) {
        // Vue par le LiDAR : un volume plein, du rayon de sa tache.
        geo = new THREE.CylinderGeometry(p.r, p.r, p.h, 12);
    } else if (p.nature === 'Torchère') {
        // Que le LiDAR ne voit pas : un tube nu, d'un mètre par convention.
        geo = new THREE.CylinderGeometry(0.5, 0.5, p.h, 8);
    } else {
        // Antenne, mât d'éclairage : un treillis que le MNH ne retient pas,
        // dessiné dans les proportions du fût d'un pylône (construireLignes).
        const r = borne(p.h / 20, 0.3, 1.8);
        geo = new THREE.CylinderGeometry(r * 0.2, r, p.h, 4);
    }
    geo.translate(0, p.h / 2, 0);
    return [geo, materiau];
}

function construireConstructions() {
    const c = ARTEFACT && ARTEFACT.constructions;
    if (!c || constructionsPosees.length) return;
    const source = s => SOURCES_HAUTEUR[s] || s;
    for (const r of c.reservoirs || []) {
        if (!r.contour || r.contour.length < 4) continue;
        // Hauteur inconnue — ni déclarée, ni vue du LiDAR : un étage, pâle,
        // comme un bâtiment sous les arbres.
        const h = r.h ?? HAUTEUR_PAR_ETAGE;
        const geo = new THREE.ExtrudeGeometry(anneauVersShape(r.contour, r.trous || []),
                                              { depth: h, bevelEnabled: false });
        geo.rotateX(-Math.PI / 2);
        // Robe lissée (24 côtés, 15° entre deux), arête du toit vive.
        const mesh = new THREE.Mesh(toCreasedNormals(geo, ANGLE_PLI_TOIT),
                                    r.h == null ? MAT_INCONNU : MAT_RESERVOIR);
        mesh.castShadow = true; mesh.receiveShadow = true;
        mesh.userData = { infobulle: `<b>${echapper(r.nom || r.nature || 'Réservoir')}</b>`
            + (r.nom && r.nature ? `<br>${echapper(r.nature)}` : '')
            + (r.h == null
                ? `<br><b>hauteur inconnue</b> : ni la BD TOPO ni le LiDAR ne la donnent`
                  + `<br>dessiné à ${h.toFixed(0)} m`
                : `<br>${enMetres(r.h)} <i>(${source(r.source)})</i>`)
            + (r.coupe ? '<br><i>coupé au bord de la scène</i>' : '') };
        groupeConstructions.add(mesh);
        constructionsPosees.push({ objet: mesh, contour: r.contour });
        constructionsSurvol.push(mesh);
    }
    for (const p of c.ponctuelles || []) {
        const [geo, materiau] = volumeConstruction(p);
        const mesh = new THREE.Mesh(geo, materiau);
        mesh.castShadow = true;
        const [x, y] = toLocal(p.lon, p.lat);
        mesh.position.set(x, 0, -y);
        mesh.userData = { infobulle: `<b>${echapper(p.nom || p.detail || p.nature)}</b>`
            + ((p.nom || p.detail) ? `<br>${echapper(p.nature)}` : '')
            + `<br>${enMetres(p.h)} <i>(${source(p.source)})</i>`
            + (p.r != null ? `<br>emprise de ${enMetres(2 * p.r)} mesurée au LiDAR`
                           : `<br><i>le LiDAR ne la voit pas : largeur de convention</i>`) };
        groupeConstructions.add(mesh);
        constructionsPosees.push({ objet: mesh, lon: p.lon, lat: p.lat });
        constructionsSurvol.push(mesh);
    }
    for (const t of c.tours || []) {
        const mesh = new THREE.Mesh(coqueTour(t), MAT_TOUR);
        mesh.castShadow = true; mesh.receiveShadow = true;
        const [x, y] = toLocal(t.lon, t.lat);
        mesh.position.set(x, 0, -y);
        mesh.userData = { infobulle: '<b>Tour de refroidissement</b>'
            + `<br>${enMetres(t.h)} <i>(BD TOPO)</i>, pied de ${enMetres(2 * t.r)}`
            + '<br><i>le LiDAR ne voit pas sa coque : galbe de convention</i>' };
        groupeConstructions.add(mesh);
        constructionsPosees.push({ objet: mesh, lon: t.lon, lat: t.lat });
        constructionsSurvol.push(mesh);
    }
    document.getElementById('t-constructions').hidden = !constructionsPosees.length;
    placerConstructions();
    majCiblesSurvol();
}

/** Pieds sur le sol exagéré, hauteurs réelles : la règle des bâtiments. */
function placerConstructions() {
    for (const c of constructionsPosees) {
        c.objet.position.y = c.contour ? baseBatiment(c.contour)
            : (relief && terrain ? ySol(c.lon, c.lat) - ENFONCEMENT : 0);
    }
}

document.getElementById('t-constructions').addEventListener('click', e => {
    groupeConstructions.visible = !groupeConstructions.visible;
    e.currentTarget.classList.toggle('on', groupeConstructions.visible);
    majCiblesSurvol();
});
