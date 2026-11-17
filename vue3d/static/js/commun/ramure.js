// La ramure d'un arbre, partagée par la vue en voiture (voiture/carres/
// arbres.js) et la scène (scene/vegetation/couche.js) : le fût prolongé
// jusqu'au haut du houppier et cinq branches qui montent vers son bord. Elle
// se voit au travers du feuillage translucide ; sans elle, un houppier sur un
// fût nu faisait « des baudruches au bout d'un bâton » (films de la
// Sainte-Victoire, novembre 2026).

import * as THREE from 'three';
import { alea } from './regles.js';

/** Des géométries non indexées, réunies en une. */
export function reunir(geos) {
    const n = geos.reduce((s, g) => s + g.attributes.position.array.length, 0), tout = new Float32Array(n);
    let k = 0;
    for (const g of geos) { tout.set(g.attributes.position.array, k); k += g.attributes.position.array.length; g.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(tout, 3));
    g.computeVertexNormals();
    return g;
}

/** Une branche : un cylindre effilé à cinq pans, de `a` (rayon ra) à `b` (rayon rb). */
function branche(a, b, ra, rb) {
    const d = new THREE.Vector3().subVectors(b, a), l = d.length();
    const g = new THREE.CylinderGeometry(rb, ra, l, 5, 1, true).toNonIndexed();
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
    g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
    return g;
}

/**
 * La ramure dans le repère du houppier, la sphère unité que chaque arbre
 * étire à sa largeur et à sa hauteur : du bas (-0,9, sous le houppier, pour
 * rejoindre le fût) à 0,55, cinq branches à 0,7 de l'axe. 60 faces.
 */
export function geometrieRamure() {
    const geos = [branche(new THREE.Vector3(0, -0.9, 0), new THREE.Vector3(0, 0.55, 0), 0.07, 0.025)];
    for (let i = 0; i < 5; i++) {
        const t = 2 * Math.PI * (i / 5 + 0.1 * alea(i, 3)), y = -0.6 + 0.12 * i;
        geos.push(branche(new THREE.Vector3(0, y, 0), new THREE.Vector3(0.7 * Math.cos(t), y + 0.45, 0.7 * Math.sin(t)),
            0.045, 0.015));
    }
    return reunir(geos);
}
