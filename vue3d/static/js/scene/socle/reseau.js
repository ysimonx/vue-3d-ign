// Les adresses du service pour ce point, et le chargement d'une image.

import { REQUETE } from './point.js';

// La scène du point et ses couches à part (vue3d/app.py), chacune demandée par
// sa couche ; certaines d'avance, dès la scène reçue (demanderSuite).
export const URL_VUE3D = `api/scene?${REQUETE}`;
export const URL_VUE3D_ORTHO = `api/ortho?${REQUETE}`;
export const URL_MONUMENTS = `api/monuments?${REQUETE}`;
export const URL_EOLIENNES = `api/eoliennes?${REQUETE}`;
export const URL_OUVRAGES = `api/ouvrages?${REQUETE}`;
export const URL_NUAGE = `api/nuage?${REQUETE}`;
export const URL_PISCINES = `api/piscines?${REQUETE}`;
export const urlVehicules = detecteur => `api/vehicules?${REQUETE}&detecteur=${detecteur}`;
export const URL_NAVIRES = `api/navires?${REQUETE}`;
export const URL_PANNEAUX = `api/panneaux?${REQUETE}`;
export const URL_DPE = `api/dpe?${REQUETE}`;
export const URL_DVF = `api/dvf?${REQUETE}`;
export const URL_BORNES = `api/bornes?${REQUETE}`;
export const URL_SOLAIRE = `api/solaire?${REQUETE}`;

/**
 * `anonyme` gouverne crossOrigin : nécessaire pour les tuiles d'un autre
 * domaine, dont on lit le canvas, mais à éviter pour nos propres URL, qui
 * portent le cookie de session.
 */
export function chargerImage(url, anonyme = true) {
    return new Promise((ok, ko) => {
        const img = new Image();
        if (anonyme) img.crossOrigin = 'anonymous';
        img.onload = () => ok(img);
        img.onerror = ko;
        img.src = url;
    });
}
