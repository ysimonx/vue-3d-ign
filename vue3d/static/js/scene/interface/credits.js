// Les crédits des données, selon ce que la vue affiche.

import { MONUMENTS, monumentsActifs } from '../batiments/etat.js';

// La Licence Ouverte impose de citer la source ; le repli de relief mondial
// impose de citer ses producteurs. Le texte suit les sources réellement
// affichées : l'orthophoto y figure toujours, car c'est elle qui classe la
// végétation, même quand le fond affiché est le plan.
//
// Chaque couche dit ce qu'elle affiche (citerSource) : les crédits le relisent
// à chaque mise à jour, rien avant qu'elle se soit déclarée.
const sourcesCitees = new Map();
/** `lire()` rend ce que la couche `nom` affiche, tel que les crédits le citent. */
export function citerSource(nom, lire) {
    sourcesCitees.set(nom, lire);
}
const cite = nom => sourcesCitees.has(nom) ? sourcesCitees.get(nom)() : undefined;
export function majCredits() {
    const sourceRelief = cite('relief'), horizon = cite('horizon') || {};
    const ign = ['BD TOPO', 'BD Forêt', 'LiDAR HD', 'Orthophotos'];
    if ((sourceRelief && /RGE ALTI/.test(sourceRelief)) || horizon.montre) ign.push('RGE ALTI');
    if (cite('fond') === 'plan') ign.push('Plan IGN v2');
    let html = `Données © <a href="https://geoservices.ign.fr/" target="_blank" rel="noopener">IGN</a>`
        + ` – Géoplateforme (${ign.join(', ')}), `
        + `<a href="https://www.etalab.gouv.fr/licence-ouverte-open-licence/" target="_blank" rel="noopener">Licence Ouverte 2.0</a>`;
    if ((sourceRelief && /AWS/.test(sourceRelief)) || (horizon.terrarium && horizon.montre)) {
        html += ' · Relief : <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md"'
            + ' target="_blank" rel="noopener">Mapzen Terrain Tiles</a>, EU-DEM © Copernicus';
    }
    // ODbL : la seule couche du projet hors données IGN (vue3d/monuments.py).
    if (monumentsActifs && MONUMENTS) {
        html += ' · Monuments 3D © <a href="https://www.openstreetmap.org/copyright"'
            + ' target="_blank" rel="noopener">contributeurs OpenStreetMap</a>, ODbL';
    }
    if (cite('panneaux')) {
        html += ' · Panneaux solaires © <a href="https://doi.org/10.5281/zenodo.19188878"'
            + ' target="_blank" rel="noopener">OpenPVMapper</a> (G. Kasmi), CC-BY 4.0';
    }
    if (cite('dpe')) {
        html += ' · DPE © <a href="https://data.ademe.fr/datasets/dpe03existant"'
            + ' target="_blank" rel="noopener">ADEME</a>';
    }
    if (cite('dvf')) {
        html += ' · Ventes © DGFiP, <a href="https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/"'
            + ' target="_blank" rel="noopener">DVF géolocalisées</a> (Etalab) ; parcelles © IGN';
    }
    if (cite('bornes')) {
        html += ' · Bornes de recharge : <a href="https://www.data.gouv.fr/fr/datasets/5448d3e0c751df01f85d0572/"'
            + ' target="_blank" rel="noopener">base nationale des IRVE</a> (data.gouv.fr)';
    }
    if (cite('solaire')) {
        html += ' · Ensoleillement : <a href="https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_fr"'
            + ' target="_blank" rel="noopener">PVGIS</a> © Union européenne';
    }
    document.getElementById('credits').innerHTML = html;
}
majCredits();
