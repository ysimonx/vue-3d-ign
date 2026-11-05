// La boucle de rendu, et l'état que lisent les essais.

import { SIMU } from '../socle/parametres.js';
import { renderer, ratio, reduireRatio, camera } from '../socle/rendu.js';
import { voiture, camVue, itineraire } from '../socle/etat.js';
import { tuilesSol } from '../sol/tuiles.js';
import { manquees } from '../sol/manquees.js';
import { statsCache } from '../sol/cache.js';
import { carres } from '../carres/grille.js';
import { aretes } from '../route/graphe.js';
import { statsPrecharge, majPrecharge, majSol, majManquees } from '../sol/sol.js';
import { limites } from '../route/limitations.js';
import { signaux, majSignalisation } from '../route/signalisation.js';
import { budgetConstruction, durees, dureesArbres, majCarres } from '../carres/selection.js';
import { majCamera } from './camera.js';
import { rendre } from './maquette.js';
import { majVoiture } from '../route/voiture.js';
import { majRuban } from './ruban.js';
import { majCiel } from './soleil.js';
import { partirSimu, simu, majSimu } from '../route/simulation.js';
import { blocsBornes, majBornes, desencombrerBornes } from '../couches/bornes.js';
import {
    sommeils, compterImage, etatDiagnostic, signaler, majSignalements,
} from './signalements.js';
import { majHud } from './affichage.js';

function dimensionner() {
    renderer.setSize(window.innerWidth, window.innerHeight);
    camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1);
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', dimensionner);
dimensionner();

// Une machine lente (l'ancien ordinateur de bord d'une Tesla) : la
// résolution baisse d'un quart tant que l'image dépasse 40 ms en moyenne.
const mesure = { somme: 0, n: 0, debut: performance.now() };
function adapterResolution(dt, maintenant) {
    mesure.somme += dt; mesure.n++;
    if (maintenant - mesure.debut < 3000) return;
    const moyenne = mesure.somme / mesure.n * 1000;
    if (moyenne > 40 && ratio > 1) {
        reduireRatio();
        dimensionner();
    }
    mesure.somme = 0; mesure.n = 0; mesure.debut = maintenant;
}

let precedent = performance.now();
export function boucle(maintenant) {
    requestAnimationFrame(boucle);
    if (maintenant - precedent > 30000) {
        sommeils.push({ fin: new Date().toISOString(), duree_s: Math.round((maintenant - precedent) / 1000) });
        if (sommeils.length > 10) sommeils.shift();
    }
    const dt = Math.min((maintenant - precedent) / 1000, 0.1);
    compterImage(maintenant, precedent);
    precedent = maintenant;
    if (SIMU && voiture.attendu) majSimu(dt, maintenant);
    majVoiture(dt, maintenant);
    majCamera(dt, maintenant);
    majCarres(maintenant);
    majSignalisation();
    majSol(maintenant);
    majPrecharge(maintenant);
    majManquees(maintenant);
    majRuban(maintenant);
    majCiel(maintenant);
    majBornes(maintenant);
    desencombrerBornes(maintenant);
    majSignalements(maintenant);
    majHud(maintenant);
    rendre();
    adapterResolution(dt, maintenant);
}

// Pour les essais (outils/essai-voiture.mjs) : l'état, en lecture.
window.__voiture = { voiture, carres, tuilesSol, aretes, camVue, camera, renderer, durees, dureesArbres, statsCache, simu,
                     get itineraire() { return itineraire; }, partir: partirSimu, limites, signaux,
                     manquees, statsPrecharge, diagnostic: etatDiagnostic, signaler, blocsBornes,
                     get budget() { return budgetConstruction; } };
