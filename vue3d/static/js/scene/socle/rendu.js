// La scène three.js : rendu, caméra et contrôles, lumières, ciel et sol.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ZONE, ECHELLE_ZONE } from './point.js';

export const host = document.getElementById('scene');
export const scene = new THREE.Scene();
// Sans horizon, la scène flotte dans un brouillard sombre réglé sur sa zone.
// Avec, un ciel et une brume exponentielle qui ne voile presque rien de la
// scène (1 % à 2,8 km) et efface le paysage au loin : 15 % à 10 km, 86 % à
// 35 km, 98 % à 50 km. appliquerCiel() choisit, avant la première image.
export const FOND_SCENE = new THREE.Color(0x0e1116);
export const brumeScene = new THREE.Fog(0x0e1116, 300 * ECHELLE_ZONE, 900 * ECHELLE_ZONE);
export const brumeHorizon = new THREE.FogExp2(0xbcd0e2, 4e-5);
scene.background = FOND_SCENE;
scene.fog = brumeScene;
// Une sphère qui suit la caméra, du bleu au zénith à la couleur de la brume
// à l'horizon : le paysage se fond dans le ciel au lieu d'y finir en bord net.
export const ciel = new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
        uniforms: { zenith: { value: new THREE.Color(0x4f86c6) }, horizon: { value: brumeHorizon.color } },
        vertexShader: 'varying vec3 vDir;\nvoid main() {\n  vDir = position;\n'
            + '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}',
        fragmentShader: 'uniform vec3 zenith;\nuniform vec3 horizon;\nvarying vec3 vDir;\nvoid main() {\n'
            + '  gl_FragColor = vec4(mix(horizon, zenith, smoothstep(0.0, 0.45, normalize(vDir).y)), 1.0);\n'
            + '  #include <colorspace_fragment>\n}',
        side: THREE.BackSide, depthWrite: false, fog: false }));
ciel.renderOrder = -1;
ciel.frustumCulled = false;
ciel.visible = false;
scene.add(ciel);

export const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 5000 * ECHELLE_ZONE);
camera.position.set(90, 70, 90);

export const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
host.appendChild(renderer.domElement);
// Le compteur d'images avancé AVANT chaque rendu. three.js r160 met à jour
// les géométries de la scène (projectObject) avec le numéro de l'image
// précédente, puis l'avance, puis dessine la carte d'ombre avec le nouveau :
// une géométrie mise à jour par la carte d'ombre d'une image passe pour à
// jour à l'image suivante. Un attribut posé entre les deux — les uv du
// terrain et de l'anneau quand le fond arrive — n'est donc pas envoyé au GPU
// si cette image-là ne redessine pas l'ombre (figerOmbres, pendant
// l'orbite) ; le lien du maillage à ses tampons est pourtant noté à jour
// (WebGLBindingStates saute un attribut sans tampon), et le terrain lit pour
// toujours des uv vides : un seul pixel de la photo, un sol uni sans photo.
// Une ouverture sur quatre environ en production (18 novembre 2026), sol de
// la scène ou anneau ; reproduit à coup sûr en enchaînant ces trois temps,
// et corrigé par ce compteur.
{
    const rendre = renderer.render.bind(renderer);
    renderer.render = (scene, camera) => {
        renderer.info.render.frame++;
        rendre(scene, camera);
    };
}
// Demandée tout de suite, GPU au repos : three.js la garde ensuite. Le
// premier appel (gl.getParameter) attend que le GPU ait fini tout ce qu'on
// lui a confié, et c'est l'orthophoto, arrivée juste après la scène, qui la
// demandait : 14 ms d'arrêt sur le GPU du Mac (M4), 0,45 à 7,7 s sous le
// rendu logiciel des essais (Gordes, Strasbourg en zone de 1 000 m).
renderer.capabilities.getMaxAnisotropy();

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;          // l'inertie fait tout le confort
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI / 2.05; // interdit de passer sous le sol
controls.minDistance = 15;
controls.maxDistance = 900 * ECHELLE_ZONE;

export const ambiance = new THREE.HemisphereLight(0xbcd4ff, 0x2b2b2b, 1.1);
scene.add(ambiance);

// Le soleil est placé par majSoleil() d'après l'heure : sa position initiale
// n'a donc pas d'importance. Le frustum d'ombre, lui, est fixe et doit couvrir
// l'emprise même quand le relief exagéré la fait monter de plus de 100 m.
export const DISTANCE_SOLEIL = 900 * ECHELLE_ZONE;
export const soleil = new THREE.DirectionalLight(0xfff2dd, 2.0);
soleil.castShadow = true;
// Doublée au-delà d'une fois et demie l'emprise de référence : le frustum
// grandit avec la zone, et l'ombre d'un arbre y deviendrait une tache.
const TAILLE_OMBRE = ECHELLE_ZONE > 1.5 ? 4096 : 2048;
soleil.shadow.mapSize.set(TAILLE_OMBRE, TAILLE_OMBRE);
// normalBias décolle l'ombre de la surface qui la reçoit : sans lui, le
// maillage du terrain se moire d'acné d'ombre dès que le soleil rase.
soleil.shadow.normalBias = 0.4;
const c = soleil.shadow.camera;
c.left = c.bottom = -400 * ECHELLE_ZONE; c.right = c.top = 400 * ECHELLE_ZONE;
c.near = 1; c.far = 2000 * ECHELLE_ZONE;
scene.add(soleil);
scene.add(soleil.target);

export const sol = new THREE.Mesh(
    new THREE.PlaneGeometry(2000 * ECHELLE_ZONE, 2000 * ECHELLE_ZONE),
    new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 1 })
);
sol.rotation.x = -Math.PI / 2;
sol.receiveShadow = true;
scene.add(sol);
// Repère visuel utile seulement quand aucun fond cartographique n'est posé.
export const grille = new THREE.GridHelper(Math.max(1000, ZONE), Math.max(100, ZONE / 10), 0x39414a, 0x2b3138);
grille.visible = false;
scene.add(grille);
