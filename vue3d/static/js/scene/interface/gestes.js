// Molette, pincement et clic sur la vue.

import { camera, renderer, controls } from '../socle/rendu.js';
import { ciblesSurvol } from './survol.js';
import { venteParBatiment, dvfActif, afficherVentesParcelle } from '../couches/foncier.js';
import { afficherFicheBatiment } from './fiche.js';
import { ouvrirTiroir } from './tiroir.js';
import {
    raycaster, souris, objetSous, epinglerTip, epinglerObjet, detacherTip,
} from './interactions.js';
import { orbite, arreterOrbite } from './boutons.js';
import { DRONE_RECUL, droneActif, drone } from './drone.js';

// `handleMouseWheel` de three r160 ignore l'amplitude de l'événement : chaque
// `wheel` applique un facteur fixe, quelle que soit la valeur de deltaY. Une
// molette crantée émet un événement par cran, c'est donc imperceptible. Un
// pavé tactile, lui, émet des dizaines d'événements de quelques pixels pour un
// seul geste, inertie comprise : les facteurs se composent et la caméra plonge.
//
// On dolly donc nous-mêmes, proportionnellement à la distance réellement
// parcourue. L'exponentielle rend le zoom géométrique, donc d'allure constante
// quelle que soit la distance courante.
//
// Le zoom d'OrbitControls reste actif pour le pincement à deux doigts : le
// couper (enableZoom = false) coupait aussi le tactile, et sur iPhone comme
// sur l'écran d'une Tesla deux doigts ne faisaient plus que déplacer la vue.
// La molette est donc interceptée en capture, sur la fenêtre, avant
// d'atteindre la toile où OrbitControls l'écoute : son facteur fixe ne
// s'ajoute pas au nôtre.
const SENSIBILITE_ZOOM = 0.0015;
window.addEventListener('wheel', e => {
    if (e.target !== renderer.domElement) return;
    e.preventDefault();
    e.stopPropagation();
    if (orbite) arreterOrbite();
    // deltaMode : 0 = pixels, 1 = lignes, 2 = pages. Firefox et les molettes
    // renvoient souvent des lignes, d'où la normalisation.
    const unite = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
    // En drone, la molette règle le recul de la caméra derrière lui.
    if (droneActif) {
        drone.recul = Math.min(Math.max(drone.recul * Math.exp(e.deltaY * unite * SENSIBILITE_ZOOM),
                                        DRONE_RECUL.min), DRONE_RECUL.max);
        return;
    }
    const versCamera = camera.position.clone().sub(controls.target);
    const distance = Math.min(Math.max(
        versCamera.length() * Math.exp(e.deltaY * unite * SENSIBILITE_ZOOM),
        controls.minDistance), controls.maxDistance);
    camera.position.copy(controls.target).add(versCamera.setLength(distance));
    controls.update();
}, { capture: true, passive: false });

// Le pincement, en vol : OrbitControls le gérait, mais il est coupé en drone
// (entrerDrone), et deux doigts n'y faisaient plus rien (signalé au
// téléphone). Ils règlent donc le recul, comme la molette ;
// hors vol, OrbitControls garde le sien. Le canevas a touch-action: none
// (posé par OrbitControls) : chaque doigt arrive en événement de pointeur.
const doigts = new Map();
let gesteAPlusieursDoigts = false;
const ecartDoigts = () => {
    const [a, b] = [...doigts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
};
renderer.domElement.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'touch') return;
    doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (doigts.size >= 2) gesteAPlusieursDoigts = true;
});
renderer.domElement.addEventListener('pointermove', e => {
    if (e.pointerType !== 'touch' || !doigts.has(e.pointerId)) return;
    const avant = doigts.size === 2 ? ecartDoigts() : 0;
    doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!droneActif || avant < 10) return;
    const apres = ecartDoigts();
    if (apres < 10) return;
    // Écarter les doigts rapproche, les resserrer éloigne.
    drone.recul = Math.min(Math.max(drone.recul * avant / apres, DRONE_RECUL.min), DRONE_RECUL.max);
});
renderer.domElement.addEventListener('pointerup', e => { doigts.delete(e.pointerId); });
renderer.domElement.addEventListener('pointercancel', e => {
    doigts.delete(e.pointerId);
    if (!doigts.size) gesteAPlusieursDoigts = false;
});

// Un clic doit être distingué de la fin d'une orbite : OrbitControls consomme le
// glissement, mais le navigateur émet quand même un pointerup au relâchement.
let departPointeur = null;
renderer.domElement.addEventListener('pointerdown', e => {
    departPointeur = { x: e.clientX, y: e.clientY };
    detacherTip();
});
renderer.domElement.addEventListener('pointerup', e => {
    // Un geste à plusieurs doigts n'est jamais un clic : le doigt levé, peu
    // déplacé, ouvrait sinon une fiche. Oublié au dernier doigt levé.
    if (gesteAPlusieursDoigts) {
        departPointeur = null;
        if (!doigts.size) gesteAPlusieursDoigts = false;
        return;
    }
    if (!departPointeur) return;
    const parcouru = Math.hypot(e.clientX - departPointeur.x,
                                e.clientY - departPointeur.y);
    departPointeur = null;
    if (parcouru > 5) return;   // c'était une orbite, pas une désignation
    const r = renderer.domElement.getBoundingClientRect();
    souris.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    souris.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(souris, camera);
    const hit = raycaster.intersectObjects(ciblesSurvol, false)[0];
    if (!hit) return;
    // Un arbre, un véhicule, un bateau, une piscine : pas de fiche, mais son
    // infobulle épinglée, avec de quoi recentrer la scène dessus.
    const objet = objetSous(hit);
    if (objet) { epinglerObjet(objet, e, r); return; }
    const ud = hit.object.userData;
    // Une parcelle vendue, ou un bâtiment posé dessus : ses ventes dans le panneau.
    if (ud.parcelle) {
        afficherVentesParcelle(ud.parcelle);
        // En tiroir, le panneau est caché : il s'ouvre sur les ventes.
        if (document.documentElement.classList.contains('tiroir')) ouvrirTiroir(document.getElementById('sec-dvf'));
        return;
    }
    const vendu = dvfActif && ud.p && venteParBatiment.get(ud.p.cleabs);
    if (vendu) afficherVentesParcelle(vendu.parcelle);
    // La végétation se survole mais ne s'ouvre pas : elle n'a pas de fiche.
    if (ud.vegetation || !ud.anneau) return;
    afficherFicheBatiment(ud);
    epinglerTip(ud, e, r, hit);
});
