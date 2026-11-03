// Partager la vue : un lien qui rouvre la scène comme on la voit — la caméra,
// le jour et l'heure du soleil, les couches allumées ou éteintes — et, à
// l'ouverture d'un tel lien, les couches remises dans cet état.

import { LAT0, LON0, PARAM_ZONE_LIEN, PARTAGE } from '../socle/point.js';
import { toLonLat } from '../socle/projection.js';
import { camera, controls } from '../socle/rendu.js';
import { ySol } from '../terrain/etat.js';
import { vegReglee } from '../vegetation/etat.js';
import { etatCouche } from './etat-couche.js';
import { DATE_SCENE, DATE_SIMULEE } from './soleil.js';

// Les boutons que le lien retient, et leur état à l'ouverture d'un lieu :
// le lien ne garde que ce qui en diffère. L'orbite ne repart pas d'elle-même
// sur une vue partagée (interface/boutons) : éteinte est son état ici.
const COUCHES = {
    pentes: ['t-roof', true], mesures: ['t-mesure', true], monuments: ['t-monuments', true],
    orbite: ['t-orbit', false], photo: ['t-fond', true], plan: ['t-plan', false], relief: ['t-relief', true],
    horizon: ['t-horizon', true], vegetation: ['t-veg', true], eau: ['t-eau', true], routes: ['t-routes', true],
    lignes: ['t-lignes', true], constructions: ['t-constructions', true], ouvrages: ['t-ouvrages', true],
    nuage: ['t-nuage', false], vehicules: ['t-vehicules', true], piscines: ['t-piscines', true],
    navires: ['t-navires', true], panneaux: ['t-panneaux', true], dpe: ['t-dpe', false], dvf: ['t-dvf', false],
    bornes: ['t-bornes', false], solaire: ['t-solaire', false],
};
const RAD = Math.PI / 180;

/** Le lien de la vue telle qu'elle est à l'écran. */
export function lienDeLaVue() {
    const cible = controls.target, ecart = camera.position.clone().sub(cible);
    const [lon, lat] = toLonLat(cible.x, -cible.z);
    const d = ecart.length();
    const vue = [lat.toFixed(6), lon.toFixed(6), (cible.y - ySol(lon, lat)).toFixed(1), d.toFixed(1),
                 ((Math.atan2(ecart.x, -ecart.z) / RAD + 360) % 360).toFixed(1),
                 (Math.asin(Math.min(1, Math.max(-1, ecart.y / d))) / RAD).toFixed(1)];
    let lien = `${location.origin}${location.pathname}?lat=${LAT0}&lon=${LON0}${PARAM_ZONE_LIEN}&vue=${vue.join(',')}`;
    // Le soleil, s'il a quitté aujourd'hui à midi : sinon, le lien ouvre le
    // jour de celui qui le reçoit.
    const heure = Number(document.getElementById('heure').value);
    if (DATE_SIMULEE.mois !== DATE_SCENE.mois || DATE_SIMULEE.jour !== DATE_SCENE.jour) {
        lien += `&jour=${DATE_SIMULEE.mois}-${DATE_SIMULEE.jour}`;
    }
    if (heure !== DATE_SCENE.heure) lien += `&heure=${heure}`;
    const couches = [];
    for (const [nom, [id, ouverture]] of Object.entries(COUCHES)) {
        const b = document.getElementById(id);
        if (!b || b.hidden) continue;
        const allume = b.classList.contains('on');
        if (allume !== ouverture) couches.push(allume ? nom : `-${nom}`);
    }
    if (couches.length) lien += `&couches=${couches.join(',')}`;
    return lien;
}

let effacer = null;
function etat(texte) {
    clearTimeout(effacer);
    etatCouche('etat-partage', texte);
    effacer = setTimeout(() => etatCouche('etat-partage', null), 6000);
}

// Au doigt, la feuille de partage de l'appareil (Messages, courriel…) ;
// ailleurs, le lien copié. Sans presse-papiers (page hors HTTPS), le lien
// affiché, à copier à la main.
document.getElementById('btn-partager').addEventListener('click', async () => {
    const lien = lienDeLaVue();
    if (matchMedia('(pointer: coarse)').matches && navigator.share) {
        try { await navigator.share({ title: document.title, url: lien }); return; }
        catch (e) { if (e.name === 'AbortError') return; }
    }
    try {
        await navigator.clipboard.writeText(lien);
        etat('Lien de cette vue copié : caméra, soleil et couches.');
    } catch (e) {
        window.prompt('Lien de cette vue :', lien);
    }
});

// À l'ouverture d'un lien partagé : chaque bouton est remis dans l'état
// voulu dès que sa couche est là — les couches arrivent les unes après les
// autres, et le bouton d'une couche absente reste caché. La végétation est
// attendue réglée : son bouton s'allume de lui-même à son arrivée. Au-delà de
// trois minutes, ce qui n'est pas venu est abandonné.
const enAttente = new Map(Object.entries(PARTAGE.couches).filter(([nom]) => COUCHES[nom]));
if (enAttente.size) {
    const debut = performance.now();
    const minuterie = setInterval(() => {
        if (document.getElementById('s-total').textContent === '—') return;   // bâtiments pas encore construits
        for (const [nom, voulu] of enAttente) {
            const b = document.getElementById(COUCHES[nom][0]);
            if (!b || b.hidden || b.disabled || (nom === 'vegetation' && !vegReglee)) continue;
            if (b.classList.contains('on') !== voulu) b.click();
            enAttente.delete(nom);
        }
        if (!enAttente.size || performance.now() - debut > 180000) clearInterval(minuterie);
    }, 500);
}
