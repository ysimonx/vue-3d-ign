// L'état partagé : la voiture, la caméra, la route prévue jusqu'à l'arrivée.

import * as THREE from 'three';
import { PARAMS, SIMU } from './parametres.js';
import { versLambert93 } from './lambert93.js';

// Le sol, les carrés, le graphe et l'affichage les lisent, et viennent avant
// les modules qui les tiennent à jour (route/voiture, interface/camera,
// route/simulation) : l'état est donc ici, et ces modules l'écrivent.
export const voiture = {
    fix: null, ancre: null, chemin: null, dChemin: 0, recalculer: false,
    vue: false, x: 0, y: 0, alt: 0, cap: 0, v: 0, precision: 0, horsRoute: true,
    attendu: null,                    // le départ, avant le premier relevé
};

// Plus bas qu'à l'origine (70 m de recul sous 30°, 38 m au-dessus de la
// voiture à l'arrêt, 59 m à 130 km/h), à la demande de Yannick, « trop
// haut » : 45 m sous 18°, soit 17 m à l'arrêt et 22 m à 130 km/h.
export const RECUL_DEFAUT = 45, PENTE_DEFAUT = 18, HAUTEUR_DEFAUT = 200;
export const camVue = { mode: PARAMS.get('vue') === '2d' ? '2d' : '3d', recul: RECUL_DEFAUT, hauteur: HAUTEUR_DEFAUT,
                        lacet: 0, tangage: 0, dernierGeste: -Infinity, cap: 0, cible: new THREE.Vector3() };

// `vers=lat,lon` (et `versnom`, pour l'affichage) : la voiture simulée va
// quelque part, par le plus court chemin du graphe BD TOPO, sens interdits
// respectés, grands axes préférés ; la route prévue devient cet itinéraire,
// jusqu'à l'arrivée. Pour les films et les essais : la page n'a pas de saisie
// de destination. Les carrés d'une bande de ITINERAIRE_BANDE_M autour de la
// droite qui joint départ et arrivée sont lus d'abord.
export const VERS = (() => {
    const m = /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(PARAMS.get('vers') || '');
    if (!SIMU || !m) return null;
    const [x, y] = versLambert93(Number(m[2]), Number(m[1]));
    return { x, y, nom: PARAMS.get('versnom') || null };
})();
// `par=lat,lon;lat,lon` : les points où passer avant `vers`, dans l'ordre —
// un trajet tracé sur une carte, une boucle qui revient près de son départ.
// Chaque étape a son plus court chemin et sa bande de carrés : une boucle de
// 4,7 km (novembre 2026) passait à 600 m de la droite qui joignait ses deux
// premiers points, hors de la bande, et la page en faisait un détour de 5 km.
export const PAR = (() => {
    if (!VERS) return [];
    return (PARAMS.get('par') || '').split(';')
        .map(t => /^\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*$/.exec(t)).filter(Boolean)
        .map(m => { const [x, y] = versLambert93(Number(m[2]), Number(m[1])); return { x, y }; });
})();
export const ITINERAIRE_BANDE_M = 400, ITINERAIRE_CHEMIN_MAX_M = 20000;
export let itineraire = null;                   // { etapes: [{ a, sens }], fin: { a, s }, k, longueur }
export function poserItineraire(it) { itineraire = it; }
