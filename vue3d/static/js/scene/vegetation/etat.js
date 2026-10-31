// L'état de la végétation, lu avant qu'elle soit construite.

import * as THREE from 'three';
import { scene } from '../socle/rendu.js';

// Ses maillages et ses éléments, lus par le survol, les exports, et par les
// couches qui expliquent une partie du sursol : les ouvrages et le nuage la
// font refaire (reconstruireVegetation), ses maillages étant construits plus
// loin (vegetation/couche).
export const groupeVegetation = new THREE.Group();
groupeVegetation.visible = false;
scene.add(groupeVegetation);
export let vegPrete = false;
export let vegElements = [];   // houppiers et masses reçus du serveur, en local
/** Les éléments reçus du serveur : la végétation est prête à être construite. */
export function poserVegetation(elements) { vegElements = elements; vegPrete = true; }
let reconstruction = () => {};
export function poserReconstructionVegetation(fn) { reconstruction = fn; }
/** La végétation refaite, si elle est déjà là. */
export function reconstruireVegetation() { if (vegPrete) reconstruction(); }
// La végétation a été construite, ou a fini d'échouer (hors LiDAR HD) :
// l'ensoleillement des toits l'attend pour compter l'ombre des arbres.
export let vegReglee = false;
export function marquerVegetationReglee() { vegReglee = true; }
