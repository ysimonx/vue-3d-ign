// La boucle de rendu : taille de la vue, programmes compilés d'avance, ombre
// figée et végétation simplifiée en mouvement.

import * as THREE from 'three';
import { horizonActif } from '../terrain/etat.js';
import { host, scene, ciel, camera, renderer, controls, soleil } from '../socle/rendu.js';
import {
    MAT_CIBLE, MAT_CONTOUR_CIBLE, MAT_VOISIN, MAT_TOIT_VOISIN, MAT_TOIT_SURFACE, MAT_INCONNU,
    MAT_DESSUS,
} from '../batiments/etat.js';
import { MAT_TERRAIN } from '../terrain/relief.js';
import { majHorizon } from '../terrain/horizon.js';
import { MAT_EAU, MAT_EAU_INTERMITTENTE } from '../couches/eau.js';
import { MAT_ROUTE, MAT_CHEMIN } from '../couches/routes.js';
import { MAT_PYLONE, MAT_CABLE } from '../couches/lignes.js';
import { MAT_RESERVOIR, MAT_CHEMINEE, MAT_TOUR } from '../couches/constructions.js';
import { MAT_EOLIENNE, tournerEoliennes } from '../couches/eoliennes.js';
import {
    MAT_FEUILLAGE, MAT_MASSE, MAT_TRONC, GEO_TRONC, groupeVegSimple, montrerVegetation, btnVeg,
} from '../vegetation/couche.js';
import { rose } from './interactions.js';
import { orbite, vitesse } from './boutons.js';
import { placerFleches } from './decalage.js';
import { droneActif, majDrone } from './drone.js';

function dimensionner() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    // updateStyle laissé à sa valeur par défaut (true) : avec setPixelRatio(2)
    // sur un écran Retina, le tampon fait 2× la taille demandée. Sans mise à
    // jour du style CSS, le canvas s'affiche à la taille du tampon, déborde du
    // conteneur, et son centre optique part dans le coin bas-droit.
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', dimensionner);
// Le passage en tiroir (fenêtre rétrécie, plein écran) change la largeur du
// conteneur sans toujours redimensionner la fenêtre.
if (window.ResizeObserver) new ResizeObserver(dimensionner).observe(host);
dimensionner();

// --- Programmes GPU compilés pendant l'attente --------------------------------
// La première image de la scène attendait la compilation des programmes de
// ses matériaux : 36 ms sur le GPU du Mac (M4), le premier poste de cette
// image à Gordes (profil CPU de Chrome). Ils sont compilés ici, pendant que le
// serveur répond, sur un triangle par matériau, éclairé comme la scène ; la
// scène n'en reçoit rien, et three.js retrouve chaque programme par sa clé.
// Un confort, rien de plus : un échec, même levé avant la promesse, laisse la
// première image compiler ce qui lui manque, et la boucle de rendu démarre.
{
    const triangle = new THREE.BufferGeometry();
    try {
        triangle.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        triangle.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
        const essai = new THREE.Group();
        for (const m of [MAT_CIBLE, MAT_VOISIN, MAT_TOIT_VOISIN, MAT_TOIT_SURFACE, MAT_INCONNU, MAT_DESSUS,
                         MAT_TERRAIN, MAT_EAU, MAT_EAU_INTERMITTENTE, MAT_ROUTE, MAT_CHEMIN, MAT_PYLONE,
                         MAT_RESERVOIR, MAT_CHEMINEE, MAT_TOUR, MAT_EOLIENNE, MAT_FEUILLAGE, MAT_MASSE]) {
            essai.add(new THREE.Mesh(triangle, m));
        }
        // Sur sa géométrie : l'opacité de ses sommets est une variante du programme.
        essai.add(new THREE.InstancedMesh(GEO_TRONC, MAT_TRONC, 1));
        essai.add(new THREE.LineSegments(triangle, MAT_CABLE), new THREE.LineSegments(triangle, MAT_CONTOUR_CIBLE));
        renderer.compileAsync(essai, camera, scene).catch(() => {}).finally(() => triangle.dispose());
    } catch (e) {
        triangle.dispose();          // préchauffage manqué : la première image compilera
    }
}

// --- Mouvement : ombre figée, végétation simple, conseil ----------------------
// La caméra bouge — orbite, glisser, molette, inertie — tant qu'elle se
// déplace d'une image à l'autre de plus de CAMERA_SEUIL de sa distance à la
// cible, ou tourne de plus de CAMERA_SEUIL radian, et encore REPOS_MS après :
// la forme détaillée ne doit pas revenir entre deux gestes. Pas le « déplacée »
// d'OrbitControls, vrai tant que la caméra glisse d'un millimètre par image :
// l'inertie d'un glisser l'y laissait plus de 2,5 s, la vue arrêtée à l'œil.
// L'orbite la plus lente, 1° par seconde, tourne de 1,2e-4 rad par image à
// 144 Hz.
const CAMERA_SEUIL = 5e-5;
const REPOS_MS = 300;
let derniereMobilite = -Infinity;
const cameraAvant = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };

function cameraDeplacee() {
    const bouge = camera.position.distanceTo(cameraAvant.position)
                      > CAMERA_SEUIL * camera.position.distanceTo(controls.target)
                  || camera.quaternion.angleTo(cameraAvant.quaternion) > CAMERA_SEUIL;
    cameraAvant.position.copy(camera.position);
    cameraAvant.quaternion.copy(camera.quaternion);
    return bouge;
}

// Durée médiane d'une image pendant l'orbite, végétation affichée, mesurée
// sur un Mac M1, avant que l'ombre ne soit figée :
//
//                                          végétation   sans
//   Gordes, 356 m (2 160 arbres)              16,7 ms   16,7 ms
//   Notre-Dame, 1 000 m (3 684 arbres)        33,4 ms   16,7 ms
//   Gordes, 1 000 m (19 312 arbres)           50,0 ms   16,7 ms
//
// et sans carte graphique (SwiftShader), à Gordes : 650 ms, 283 sans. En
// mouvement, les tuiles lointaines sont toujours en forme simple
// (montrerVegetation). Au-delà de 40 ms (moins de 25 images par seconde) sur
// 2 s de mouvement, toute la végétation y passe ; et si la vue rame encore
// ainsi, la page propose de la masquer. Ombre figée, le M1 n'y vient plus :
// Gordes à 1 000 m tourne à 33,3 ms, Notre-Dame à 16,7 ; la forme simple
// partout sert les machines plus lentes. La médiane,
// et non la moyenne : une compilation ou une couche qui arrive font quelques
// images longues sans que la vue rame. Les secondes de mouvement se cumulent
// d'un geste à l'autre.
const IMAGE_LENTE_MS = 40;
const FENETRE_MOUVEMENT_MS = 2000;
const dureesMouvement = [];
let cumulMouvement = 0;
let vegSimplifiee = false;    // forme simple partout pendant le mouvement, décidée une fois
let conseilVegDonne = false;
let imagePrecedente = null;   // l'état dans lequel l'image précédente a été dessinée
const conseilVeg = document.getElementById('conseil-veg');
let minuterieConseil = 0;

function montrerConseil(texte, action) {
    clearTimeout(minuterieConseil);
    conseilVeg.querySelector('span').textContent = texte;
    conseilVeg.querySelector('.agir').hidden = !action;
    conseilVeg.hidden = false;
    if (!action) minuterieConseil = setTimeout(() => { conseilVeg.hidden = true; }, 6000);
}

/** Compte la durée de l'image précédente, si elle a été dessinée en mouvement. */
function surveillerMouvement(duree) {
    const p = imagePrecedente;
    // Seules comptent les images en mouvement, végétation affichée, dans la
    // forme qu'on juge ; pas celle qui a construit la forme simple.
    if (conseilVegDonne || !p || !p.mouvement || !p.veg || p.bascule || p.simple !== vegSimplifiee
        || document.hidden) return;
    dureesMouvement.push(duree);
    cumulMouvement += duree;
    if (cumulMouvement < FENETRE_MOUVEMENT_MS) return;
    const mediane = dureesMouvement.sort((a, b) => a - b)[dureesMouvement.length >> 1];
    dureesMouvement.length = 0;
    cumulMouvement = 0;
    if (mediane <= IMAGE_LENTE_MS) return;
    const ips = Math.round(1000 / mediane);
    const cadence = `${ips} image${ips > 1 ? 's' : ''}/s`;
    if (!vegSimplifiee) {
        vegSimplifiee = true;
        montrerConseil(`La vue ralentit (${cadence}) : arbres simplifiés pendant le mouvement.`, false);
    } else {
        conseilVegDonne = true;
        montrerConseil(`La vue rame encore (${cadence}) : masquer la végétation l'allège.`, true);
    }
}

// L'ombre portée ne dépend que du soleil et de ce qui porte une ombre, jamais
// de la caméra : pendant le mouvement, sa carte n'est redessinée que si l'un
// des deux a changé — elle coûtait la moitié de l'image à Gordes en zone de
// 1 000 m. La signature relève, avant chaque image, le soleil et chaque
// maillage visible qui porte une ombre : identité, géométrie et version de
// ses sommets, instances, position. 0,1 ms pour les 1 784 maillages de
// Notre-Dame en zone de 1 000 m. Les houppiers détaillés comptent même
// masqués par la forme simple, qui n'est pas comptée : la carte garde leur
// ombre. Une position changée n'arrive dans matrixWorld qu'au rendu suivant :
// la carte est alors redessinée une image plus tard, jamais oubliée. Les
// rotors des éoliennes (`tourne`) n'y comptent pas : ils tournent à chaque
// image, et la carte serait redessinée sans fin ; leur ombre suit quand la
// caméra s'arrête.
let signature = new Float64Array(1 << 14), signatureOmbre = new Float64Array(1 << 14);
let longueur = 0, longueurOmbre = -1;
function noter(v) {
    if (longueur === signature.length) {
        const t = new Float64Array(2 * signature.length);
        t.set(signature);
        signature = t;
    }
    signature[longueur++] = v;
}
function signer(o) {
    if (o === groupeVegSimple || (!o.visible && !o.userData.vegetation)) return;
    if (o.castShadow && o.geometry && !o.userData.tourne) {
        const m = o.matrixWorld.elements, pos = o.geometry.attributes.position;
        noter(o.id); noter(o.geometry.id); noter(pos ? pos.version : -1);
        noter(o.isInstancedMesh ? o.instanceMatrix.version + 1e6 * o.count : -1);
        noter(m[0]); noter(m[5]); noter(m[10]); noter(m[12]); noter(m[13]); noter(m[14]);
    }
    for (const c of o.children) signer(c);
}

/** Fige la carte d'ombre pendant le mouvement, tant que rien ne la change. */
function figerOmbres(enMouvement) {
    longueur = 0;
    noter(soleil.castShadow ? 1 : 0);
    for (const v of soleil.position.toArray().concat(soleil.target.position.toArray())) noter(v);
    signer(scene);
    const changee = longueur !== longueurOmbre
        || signature.subarray(0, longueur).some((v, k) => v !== signatureOmbre[k]);
    renderer.shadowMap.autoUpdate = !enMouvement;
    // Immobile, la carte est redessinée à chaque image, comme avant.
    if (!enMouvement || changee) {
        renderer.shadowMap.needsUpdate = true;
        if (signatureOmbre.length < longueur) signatureOmbre = new Float64Array(signature.length);
        signatureOmbre.set(signature.subarray(0, longueur));
        longueurOmbre = longueur;
    }
}

conseilVeg.querySelector('.agir').addEventListener('click', () => {
    // Avant le clic sur le bouton du panneau, qui sinon fermerait le conseil.
    conseilVeg.querySelector('.agir').hidden = true;
    conseilVeg.querySelector('span').textContent = 'Végétation masquée : le bouton « Végétation » du panneau la rallume.';
    if (btnVeg.classList.contains('on')) btnVeg.click();
    setTimeout(() => { conseilVeg.hidden = true; }, 6000);
});
conseilVeg.querySelector('.fermer').addEventListener('click', () => { conseilVeg.hidden = true; });
// Rallumée ou masquée depuis le panneau : le conseil n'a plus d'objet.
btnVeg.addEventListener('click', () => {
    if (!conseilVeg.querySelector('.agir').hidden) conseilVeg.hidden = true;
});

let precedent = performance.now();
function boucle(maintenant) {
    surveillerMouvement(maintenant - precedent);
    const dt = Math.min((maintenant - precedent) / 1000, 0.05);
    precedent = maintenant;
    if (orbite && !droneActif) {
        const a = (Number(vitesse.value) * Math.PI / 180) * dt;
        const cos = Math.cos(a), sin = Math.sin(a);
        const dx = camera.position.x - controls.target.x;
        const dz = camera.position.z - controls.target.z;
        camera.position.x = controls.target.x + dx * cos - dz * sin;
        camera.position.z = controls.target.z + dx * sin + dz * cos;
    }
    if (droneActif) majDrone(dt, maintenant);
    else controls.update();
    tournerEoliennes(dt, Number(vitesse.value));
    majHorizon(maintenant);
    if (horizonActif) {
        ciel.position.copy(camera.position);
        // Le plan proche suit le recul : à 0,1 m, la profondeur sur 24 bits
        // confond deux crêtes à moins de 540 m l'une de l'autre à 30 km ; à
        // 2 m, à moins de 27 m.
        // Le drone, à quelques mètres de la caméra, se contente de 0,5 m :
        // elle reste à 1,5 m au moins de ce qu'elle survole.
        const proche = droneActif ? 0.5
            : Math.min(Math.max(0.01 * camera.position.distanceTo(controls.target), 0.1), 2);
        if (Math.abs(proche - camera.near) > 0.05 * camera.near) {
            camera.near = proche;
            camera.updateProjectionMatrix();
        }
    }
    if (cameraDeplacee()) derniereMobilite = maintenant;
    const enMouvement = maintenant - derniereMobilite < REPOS_MS;
    const veg = btnVeg.classList.contains('on');
    const bascule = montrerVegetation(enMouvement, vegSimplifiee);
    figerOmbres(enMouvement);
    imagePrecedente = { mouvement: enMouvement, veg, simple: vegSimplifiee, bascule };

    // Boussole : le nord de la scène est -Z, l'est +X. L'azimut du regard se
    // mesure donc en atan2(dx, -dz), et la rose tourne à l'inverse pour que
    // son N désigne toujours le nord à l'écran.
    const dx = controls.target.x - camera.position.x;
    const dz = controls.target.z - camera.position.z;
    const azimut = Math.atan2(dx, -dz);
    rose.style.transform = `rotate(${(-azimut * 180 / Math.PI).toFixed(1)}deg)`;
    placerFleches();

    renderer.render(scene, camera);
    requestAnimationFrame(boucle);
}
requestAnimationFrame(boucle);
