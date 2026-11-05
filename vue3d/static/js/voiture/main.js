// Point d'entrée de la vue en voiture : chaque module, dans l'ordre de la page,
// qui est celui de leurs effets ; puis le départ, simulé ou au GPS.

import { SIMU, DEPART } from './socle/parametres.js';
import { versLambert93 } from './socle/lambert93.js';
import { recaler } from './socle/monde.js';
import './socle/rendu.js';
import { voiture, camVue } from './socle/etat.js';
import { majLienQuitter } from './interface/ecran.js';
import './sol/tuiles.js';
import './sol/manquees.js';
import './sol/cache.js';
import './sol/altitudes.js';
import './carres/grille.js';
import './route/graphe.js';
import './route/tunnels.js';
import './sol/sol.js';
import './carres/routes.js';
import './carres/batiments.js';
import './carres/arbres.js';
import './route/limitations.js';
import './route/signalisation.js';
import './carres/selection.js';
import { HAUTEUR, majBoutonVue } from './interface/camera.js';
import './interface/maquette.js';
import './route/voiture.js';
import './interface/ruban.js';
import './interface/soleil.js';
import './route/simulation.js';
import './couches/bornes.js';
import './interface/signalements.js';
import { accueil } from './interface/affichage.js';
import { demarrerGps, garderEcran } from './interface/position.js';
import { boucle } from './interface/boucle.js';

if (DEPART && Number.isFinite(DEPART.lat)) {
    const [x, y] = versLambert93(DEPART.lon, DEPART.lat);
    voiture.attendu = { x, y };
    recaler(x, y);
    majLienQuitter();
}
if (SIMU) {
    if (!voiture.attendu) {
        accueil('<p>Point de départ illisible.</p>', [['Vue 3D', './', true]]);
    }
} else {
    if (!voiture.attendu) {
        // En attendant la position, la caméra regarde la France d'assez
        // haut ; aucun carré n'y est demandé.
        const [x, y] = versLambert93(2.35, 46.6);
        voiture.attendu = { x, y, provisoire: true };
        recaler(x, y);
        camVue.mode = '2d';
        camVue.hauteur = HAUTEUR[1];
        majBoutonVue();
    }
    demarrerGps();
}
garderEcran();
requestAnimationFrame(boucle);
