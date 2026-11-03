// Le cadrage de la caméra à l'ouverture : la pose héritée, une vue partagée,
// l'accueil, ou toute l'emprise à l'écran.

import * as THREE from 'three';
import { POINT_DEFAUT, ACCUEIL, CENTER, POSE_HERITEE, PARTAGE } from '../socle/point.js';
import { toLocal, toLonLat, emprise } from '../socle/projection.js';
import { ySol } from '../terrain/etat.js';
import { camera, controls } from '../socle/rendu.js';

export function cadrer() {
    // Arrivée par une flèche de décalage : la caméra garde sa place par
    // rapport au point, et sa hauteur au-dessus du sol sous la cible.
    if (POSE_HERITEE) {
        const [x, h, z] = POSE_HERITEE.cible;
        controls.target.set(x, ySol(...toLonLat(x, -z)) + h, z);
        camera.position.copy(controls.target).add(new THREE.Vector3(...POSE_HERITEE.ecart));
        controls.update();
        return;
    }
    // Une vue partagée, ou l'accueil — la tour entière : une cible à une
    // hauteur au-dessus du sol, vue d'un azimut (0 = du nord), d'une élévation
    // et d'une distance, comme poserCadre de outils/demo-video.mjs.
    const v = PARTAGE.vue || (ACCUEIL ? POINT_DEFAUT.vue : null);
    if (v) {
        const r = Math.PI / 180, cosE = Math.cos(v.elevation * r);
        const [x, y] = toLocal(v.lon, v.lat);
        controls.target.set(x, ySol(v.lon, v.lat) + v.hauteur, -y);
        camera.position.set(x + v.distance * Math.sin(v.azimut * r) * cosE,
                            controls.target.y + v.distance * Math.sin(v.elevation * r),
                            -y - v.distance * Math.cos(v.azimut * r) * cosE);
        controls.update();
        return;
    }
    const centre = new THREE.Vector3(0, ySol(CENTER[0], CENTER[1]), 0);
    controls.target.copy(centre);
    // Vue du sud-est, 30° au-dessus de l'horizon ; la distance suit la zone.
    const direction = new THREE.Vector3(110, 90, 110).normalize();
    const distance = distanceOuverture(centre, direction);
    camera.position.copy(centre).addScaledVector(direction, distance);
    controls.update();
}

// À l'ouverture, la caméra recule jusqu'à voir le milieu des quatre côtés de
// l'emprise, à 90 % du bord de l'écran. Elle se tenait à 180 m, réglés pour
// l'emprise de 356 m : en zone de 1 000 m, on ne voyait que le centre. Ainsi,
// à Gordes sur une vue de 1 100 × 850 px : 321 m en zone de 350 m, 906 m à
// 1 000 m, 1 856 m à 2 000 m, l'emprise entière à l'écran sauf le coin le
// plus proche ; 2 078 m à 1 000 m sur un téléphone en portrait (390 px de large).
const MARGE_OUVERTURE = 0.9;

/**
 * Distance de la caméra au centre, le long de `direction`, pour que les
 * milieux des côtés de l'emprise, posés sur le relief, tiennent dans l'écran
 * (NDC à ±MARGE_OUVERTURE). Par dichotomie, sur une copie de la caméra : son
 * aspect est celui de la vue.
 */
function distanceOuverture(centre, direction) {
    const [o, s, e, n] = emprise();
    const [x0, y0] = toLocal(o, s), [x1, y1] = toLocal(e, n);
    const milieux = [[(x0 + x1) / 2, y0], [x1, (y0 + y1) / 2], [(x0 + x1) / 2, y1], [x0, (y0 + y1) / 2]]
        .map(([x, y]) => new THREE.Vector3(x, ySol(...toLonLat(x, y)), -y));
    const essai = camera.clone(), p = new THREE.Vector3();
    const voit = d => {
        essai.position.copy(centre).addScaledVector(direction, d);
        essai.lookAt(centre);
        essai.updateMatrixWorld();
        return milieux.every(m => {
            p.copy(m).project(essai);
            return p.z < 1 && Math.abs(p.x) <= MARGE_OUVERTURE && Math.abs(p.y) <= MARGE_OUVERTURE;
        });
    };
    let pres = controls.minDistance, loin = controls.maxDistance;
    if (!voit(loin)) return loin;
    while (loin - pres > 1) {
        const d = (pres + loin) / 2;
        if (voit(d)) loin = d; else pres = d;
    }
    return loin;
}
