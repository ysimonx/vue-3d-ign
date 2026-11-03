// Les boutons des toits et des monuments, et l'orbite.

import { POSE_HERITEE, PARTAGE } from '../socle/point.js';
import { controls } from '../socle/rendu.js';
import {
    monumentsActifs, toitsEnPente, toitsMesures, basculerMonuments, basculerToitsEnPente,
    basculerToitsMesures,
} from '../batiments/etat.js';
import { features } from '../batiments/chargement.js';
import { majCredits } from './credits.js';
import { afficherCible } from '../batiments/cible.js';
import { construire } from '../batiments/construction.js';

const btnRoof = document.getElementById('t-roof');
btnRoof.addEventListener('click', () => {
    basculerToitsEnPente();
    btnRoof.classList.toggle('on', toitsEnPente);
    btnRoof.textContent = toitsEnPente ? 'Toits en pente' : 'Toits plats';
    construire(features, toitsEnPente);
});

const btnMesure = document.getElementById('t-mesure');
btnMesure.addEventListener('click', () => {
    basculerToitsMesures();
    btnMesure.classList.toggle('on', toitsMesures);
    construire(features, toitsEnPente);
    afficherCible();
});

const btnMonuments = document.getElementById('t-monuments');
btnMonuments.addEventListener('click', () => {
    basculerMonuments();
    btnMonuments.classList.toggle('on', monumentsActifs);
    construire(features, toitsEnPente);
    afficherCible();
    majCredits();
});

// L'orbite démarre avec la scène, pas avec la page : pendant la construction,
// elle tournait autour d'un sol vide, et un glissement de souris pendant
// l'attente l'arrêtait avant même que la scène n'apparaisse.
// Seul un choix fait au bouton pendant l'attente l'emporte.
export let orbite = false;
let orbiteChoisie = false;
export const btnOrbit = document.getElementById('t-orbit');
export const vitesse = document.getElementById('speed');
btnOrbit.addEventListener('click', () => {
    orbiteChoisie = true;
    orbite = !orbite;
    btnOrbit.classList.toggle('on', orbite);
});

export function arreterOrbite() {
    orbite = false;
    btnOrbit.classList.remove('on');
}

export function demarrerOrbite() {
    // Arrêtée avant un décalage, elle le reste ; une vue partagée reste où on
    // l'a cadrée, sauf si le lien la demande (interface/partage).
    if (orbiteChoisie || (POSE_HERITEE && !POSE_HERITEE.orbite) || PARTAGE.vue) return;
    orbite = true;
    btnOrbit.classList.add('on');
}
// OrbitControls fait tourner la caméra autour de sa cible : l'inertie
// (enableDamping) donne un mouvement fluide sans boucle manuelle sur le cap.
controls.addEventListener('start', () => { if (orbite) arreterOrbite(); });
