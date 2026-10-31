// Le survol de la vue : mesures et infobulle, épinglée au clic.

import * as THREE from 'three';
import { toLonLat } from '../socle/projection.js';
import { camera, renderer } from '../socle/rendu.js';
import { ciblesSurvol } from './survol.js';
import { enMetres } from '../couches/constructions.js';
import { GABARITS_VEHICULE, GABARITS_NAVIRE } from '../couches/detections.js';
import { ligneDpe } from '../couches/foncier.js';
import { infobulleBorne } from '../couches/bornes.js';
import { ligneSolaire } from '../couches/solaire.js';
import { portDe, formeDe } from '../vegetation/formes.js';
import { elementSousFace } from '../vegetation/couche.js';
import {
    lienStreetView, lienRecentrer, lienRecentrerSur, lienYAller, centreAnneau,
} from './fiche.js';
import { ouvrirTiroir } from './tiroir.js';

export const raycaster = new THREE.Raycaster();
export const souris = new THREE.Vector2();
const tip = document.getElementById('tip');
export const rose = document.getElementById('rose');
/** Pose l'infobulle près du pointeur, sans qu'elle sorte de la vue, qui la
 *  couperait (overflow:hidden) : au bord d'un téléphone, elle sortait. */
function placerTip(e, r) {
    tip.style.display = 'block';
    const x = e.clientX - r.left + 14, y = e.clientY - r.top + 14;
    tip.style.left = Math.max(4, Math.min(x, r.width - tip.offsetWidth - 4)) + 'px';
    tip.style.top = Math.max(4, Math.min(y, r.height - tip.offsetHeight - 4)) + 'px';
}
tip.addEventListener('click', e => {
    if (!e.target.closest('.voir-fiche')) return;
    detacherTip();
    ouvrirTiroir(document.getElementById('fiche-batiment').closest('.section'));
});

/**
 * Un arbre, un véhicule, un bateau, une piscine ou une station de recharge
 * sous le pointeur : son infobulle, son centre (lon, lat) et de quoi nommer le
 * recentrage ; null pour tout le reste. Le survol l'affiche, le clic l'épingle avec un lien qui
 * recharge la scène centrée dessus — au doigt, sans survol, c'est le clic qui
 * la montre.
 */
export function objetSous(touche) {
    if (!touche) return null;
    const ud = touche.object.userData;
    if (ud.vegetation && touche.faceIndex != null) {
        const info = elementSousFace(touche.object, touche.faceIndex);
        if (!info) return null;
        const dist = Math.hypot(info.x, info.y);
        const azimut = (Math.atan2(info.x, info.y) * 180 / Math.PI + 360) % 360;
        const essence = info.essence && !/^N[CR]$/.test(info.essence) ? info.essence : null;
        const html =
            `<b>${info.classe === 'vegetation' ? (info.nature || 'Végétation (orthophoto)') : 'Sursol non bâti'}</b>` +
            (essence ? `<br>essence BD Forêt : ${essence} · port ${portDe(info).nom}` : `<br>port ${portDe(info).nom}`) +
            `<br>hauteur ${info.h.toFixed(1)} m · rayon ${info.r.toFixed(1)} m · ${formeDe(info)}` +
            (info.allongement >= 1.5 ? ` · allongé ×${info.allongement.toFixed(1)}` : '') +
            `<br>${dist.toFixed(0)} m du point · azimut ${azimut.toFixed(0)}°` +
            `<br>élévation ${(Math.atan2(info.h, Math.max(dist, 1)) * 180 / Math.PI).toFixed(0)}°` +
            (info.classe === 'sursol' ? '<br><i>hors zone de végétation BD TOPO, pas vert à l\'orthophoto</i>' : '');
        // Le houppier est posé en coordonnées de la scène, comme les bâtiments.
        return { html, centre: toLonLat(info.x, info.y),
                 quoi: info.classe === 'vegetation' ? 'sur cet arbre' : 'ici' };
    }
    if (ud.vehicules && touche.instanceId != null) {
        const v = ud.vehicules[touche.instanceId];
        return { html: `<b>${GABARITS_VEHICULE[v.gabarit].nom}</b>`
            + `<br>boîte de ${enMetres(v.longueur)} sur ${enMetres(v.largeur)}, lue sur l'orthophoto`
            + '<br><i>là où il était le jour de la prise de vue</i>'
            + '<br><i>hauteur et forme de convention, avant et arrière non distingués</i>',
                 centre: [v.lon, v.lat], quoi: 'sur ce véhicule' };
    }
    if (ud.navires && touche.instanceId != null) {
        const n = ud.navires[touche.instanceId];
        return { html: `<b>${GABARITS_NAVIRE[n.gabarit].nom}</b>`
            + `<br>boîte de ${enMetres(n.longueur)} sur ${enMetres(n.largeur)}, lue sur l'orthophoto`
            + '<br><i>là où il était le jour de la prise de vue</i>'
            + '<br><i>hauteur et forme de convention, proue et poupe non distinguées</i>',
                 centre: [n.lon, n.lat], quoi: 'sur ce bateau' };
    }
    if (ud.piscines && touche.instanceId != null) {
        const p = ud.piscines[touche.instanceId];
        return { html: '<b>Piscine</b>'
            + `<br>boîte de ${enMetres(p.longueur)} sur ${enMetres(p.largeur)}, lue sur l'orthophoto`
            + '<br><i>dessinée en rectangle, quelle que soit sa forme ; couleur de l\'eau ce jour-là</i>',
                 centre: [p.lon, p.lat], quoi: 'sur cette piscine' };
    }
    const b = ud.borne || (ud.bornes && touche.instanceId != null ? ud.bornes[touche.instanceId] : null);
    if (b) {
        return { html: infobulleBorne(b), centre: [b.lon, b.lat], quoi: 'sur cette station', yAller: true };
    }
    return null;
}

renderer.domElement.addEventListener('pointermove', e => {
    if (tipEpingle) return;
    const r = renderer.domElement.getBoundingClientRect();
    souris.x = ((e.clientX - r.left) / r.width) * 2 - 1;
    souris.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(souris, camera);
    // Végétation : calque optionnel, et la seule infobulle qui porte une mesure
    // (hauteur, distance, élévation). Traitée avant la logique des pastilles,
    // qui masque l'infobulle dès que le plus proche n'est ni pastille ni photo.
    const touche = raycaster.intersectObjects(ciblesSurvol, false)[0];
    const objet = objetSous(touche);
    if (objet) {
        tip.innerHTML = objet.html + '<br><i>clic pour pouvoir y recentrer la scène</i>';
        placerTip(e, r);
        return;
    }

    if (touche && touche.object.userData.pylone) {
        const u = touche.object.userData;
        tip.innerHTML = `<b>Ligne ${u.tension || 'haute tension'}</b>`
            + (u.gestionnaire ? `<br>${u.gestionnaire}` : '')
            + `<br>pylône ${u.h.toFixed(1)} m `
            + (u.mesuree ? '<i>(BD TOPO)</i>' : '<i>(hauteur typique de la tension)</i>');
        placerTip(e, r);
        return;
    }

    if (touche && touche.object.userData.infobulle) {
        tip.innerHTML = touche.object.userData.infobulle;
        placerTip(e, r);
        return;
    }

    const hit = raycaster.intersectObjects(ciblesSurvol, false)[0];
    const ud = hit ? hit.object.userData : null;
    if (!ud || !ud.anneau) { tip.style.display = 'none'; return; }
    tip.innerHTML = resumeBatiment(ud) + ligneDpe(ud) + ligneSolaire(hit) + '<br><i>clic pour la fiche</i>';
    placerTip(e, r);
});

/** Les deux lignes de l'infobulle d'un bâtiment ou d'une partie OSM. */
function resumeBatiment(ud) {
    if (ud.nuage) {
        const n = ud.nuage;
        return `<b>${ud.p.usage_1 || ud.p.nature || 'Bâtiment'}</b><br>en points du nuage LiDAR HD `
            + (n.chevauche ? '<i>(étage d\'un ouvrage ajouré)</i>'
                           : `<i>(sol vu sous la structure, ${Math.round(100 * n.sous_structure)} % de l'emprise)</i>`);
    }
    if (ud.monument) {
        const m = ud.monument;
        return `<b>${m.nom || ud.p.usage_1 || ud.p.nature || 'Monument'}</b>`
            + `<br>partie OSM · ${m.h.toFixed(1).replace('.', ',')} m`
            + (m.estime ? ' <i>(hauteur estimée : OSM ne la donne pas)</i>' : '')
            + (m.toit ? ` · toit ${m.toit.forme === 'pyramide' ? 'en pyramide' : 'à deux pans'}` : '');
    }
    const { p, denivele, hMur } = ud;
    return `<b>${p.usage_1 || p.nature || 'Bâtiment'}</b>` +
        (ud.inconnue
            ? `<br><b>hauteur inconnue</b> : sous les arbres` +
              (ud.inconnue.part_verte != null
                  ? ` (${Math.round(ud.inconnue.part_verte * 100)} % de l'emprise verte à l'orthophoto)` : '') +
              `<br>dessiné à ${hMur.toFixed(0)} m` +
              (p.nombre_d_etages > 0 ? ` (${p.nombre_d_etages} étage(s) BD TOPO)` : ' (un étage, par défaut)')
            : `<br>murs ${hMur.toFixed(1)} m` +
              (denivele > 0.5 ? ` · toit ${denivele.toFixed(1)} m` : ' · toit plat') +
              (ud.lidar ? (ud.surface ? (ud.lidar.pans ? ` <i>(LiDAR, ${ud.lidar.pans.n_pans} pan(s) mesuré(s))</i>`
                                                       : ' <i>(LiDAR, surface mesurée)</i>')
                          : ud.lidar.corps ? ` <i>(LiDAR, ${ud.lidar.corps.length} corps de toit)</i>`
                          : ud.lidar.axe_deg != null ? ' <i>(LiDAR, faîtage mesuré)</i>' : ' <i>(LiDAR)</i>')
                        + (ud.lidar.mode_bas ? ` <i>· toit lu sous un arbre qui couvre ${Math.round(ud.lidar.part_haute * 100)} % de l'emprise</i>` : '')
                        + (ud.lidar.deux_niveaux && !ud.surface ? ` <i>· niveau bas : ${Math.round(ud.lidar.part_haute * 100)} % de l'emprise monte plus haut</i>` : '')
                        : ' <i>(BD TOPO)</i>'));
}

// L'infobulle épinglée par un clic : elle reste où elle est, ses liens se
// cliquent, jusqu'au prochain clic sur la scène. Sans cela, elle fuit sous la
// souris qui va vers le lien.
let tipEpingle = false;
export function epinglerTip(ud, e, r) {
    // En tiroir, le panneau est caché : un bouton l'ouvre sur la fiche.
    const fiche = document.documentElement.classList.contains('tiroir')
        ? '<button type="button" class="voir-fiche">Voir la fiche</button>'
        : '<i>fiche dans le panneau</i>';
    tip.innerHTML = resumeBatiment(ud) + ligneDpe(ud) + '<br>' + fiche
        + '<br>' + lienRecentrer(ud.anneau).trim() + '<br>' + lienStreetView(ud.anneau)
        + (ud.anneau && ud.anneau.length >= 3 ? '<br>' + lienYAller(centreAnneau(ud.anneau)).trim() : '');
    placerTip(e, r);
    tip.classList.add('epingle');
    tipEpingle = true;
}
/** De même pour un arbre, un véhicule, un bateau ou une piscine (objetSous). */
export function epinglerObjet(objet, e, r) {
    tip.innerHTML = objet.html + '<br>' + lienRecentrerSur(objet.centre, objet.quoi).trim()
        + (objet.yAller ? '<br>' + lienYAller(objet.centre).trim() : '');
    placerTip(e, r);
    tip.classList.add('epingle');
    tipEpingle = true;
}
export function detacherTip() {
    if (!tipEpingle) return;
    tipEpingle = false;
    tip.classList.remove('epingle');
    tip.style.display = 'none';
}
