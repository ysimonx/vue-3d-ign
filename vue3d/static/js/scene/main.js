// Point d'entrée de la page de la scène : chaque module, dans l'ordre de la page,
// qui est celui de leurs effets ; puis ce qui suit l'arrivée des bâtiments.

import './socle/point.js';
import './socle/reseau.js';
import './interface/recherche.js';
import './socle/chargement.js';
import './socle/projection.js';
import './terrain/etat.js';
import './socle/rendu.js';
import './geometrie/normales.js';
import { poserCible } from './batiments/etat.js';
import './geometrie/polygones.js';
import './geometrie/astronomie.js';
import './batiments/toits.js';
import './vegetation/etat.js';
import './interface/survol.js';
import './interface/etat-couche.js';
import { note, quandLesBatimentsArrivent } from './batiments/chargement.js';
import { cadrer } from './interface/cadrage.js';
import './interface/credits.js';
import './terrain/fond.js';
import './terrain/relief.js';
import './terrain/anneau.js';
import './terrain/horizon.js';
import './couches/eau.js';
import './couches/routes.js';
import './couches/lignes.js';
import './couches/constructions.js';
import { chargerOuvrages } from './couches/ouvrages.js';
import { chargerNuage } from './couches/nuage.js';
import './couches/ecarts-toits.js';
import { chargerDetections } from './couches/detections.js';
import { chargerPanneaux } from './couches/panneaux.js';
import './couches/foncier.js';
import './couches/bornes.js';
import './couches/solaire.js';
import './interface/position.js';
import './vegetation/textures.js';
import './vegetation/formes.js';
import { activerVegetation } from './vegetation/couche.js';
import { trouverCible, afficherCible } from './batiments/cible.js';
import { stats, construire } from './batiments/construction.js';
import { chargerMonuments } from './batiments/monuments.js';
import './interface/fiche.js';
import './export/ifc.js';
import './export/citygml.js';
import './export/modele.js';
import './export/boutons.js';
import './interface/tiroir.js';
import './interface/interactions.js';
import { demarrerOrbite } from './interface/boutons.js';
import './interface/decalage.js';
import './interface/drone.js';
import './interface/tuto.js';
import './interface/gestes.js';
import './terrain/commandes.js';
import './interface/soleil.js';
import './interface/partage.js';
import './interface/avis.js';
import './interface/boucle.js';

// Les bâtiments arrivés : ils sont construits, la caméra cadrée, puis viennent
// les couches qui ont besoin de leurs emprises.
quandLesBatimentsArrivent(features => {
    poserCible(trouverCible(features));
    construire(features, true);
    afficherCible();
    note.textContent = stats.total
        ? `${stats.avecToit} bâtiment(s) sur ${stats.total} ont des altitudes de toiture exploitables.`
        : "Aucun bâtiment BD TOPO sur cette emprise.";
    cadrer();
    demarrerOrbite();
    // La végétation ne peut être classée qu'une fois les emprises bâties
    // connues : c'est par elles qu'on écarte les toitures du sursol. D'où
    // ce chaînage plutôt qu'un chargement en parallèle.
    activerVegetation();
    chargerMonuments();
    chargerOuvrages();
    chargerNuage();
    chargerDetections();
    chargerPanneaux();
});
