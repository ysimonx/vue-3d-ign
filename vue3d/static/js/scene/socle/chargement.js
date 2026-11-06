// La scène demandée au serveur : zone, reconstruction, reprises, avancement
// affiché, et les couches demandées d'avance.

import { LAT0, LON0, ZONE_DEFAUT_M, ZONE, REQUETE } from './point.js';
import {
    URL_VUE3D, URL_VUE3D_ORTHO, URL_MONUMENTS, URL_OUVRAGES, URL_PISCINES, URL_PANNEAUX,
    chargerImage,
} from './reseau.js';

const selectZone = document.getElementById('in-zone');
// Une zone hors des choix proposés (?zone=850) s'ajoute à la liste.
if (![...selectZone.options].some(o => o.value === String(ZONE))) {
    selectZone.add(new Option(`${ZONE.toLocaleString('fr-FR')} m`, String(ZONE)));
}
selectZone.value = String(ZONE);
selectZone.addEventListener('change', () => {
    const u = new URL(location.href);
    // Le point s'écrit toujours : sans lui, l'accueil redemanderait la position.
    u.searchParams.set('lat', LAT0);
    u.searchParams.set('lon', LON0);
    // La zone par défaut ne s'écrit pas : le lien reste court.
    if (selectZone.value !== String(ZONE_DEFAUT_M)) u.searchParams.set('zone', selectZone.value);
    else u.searchParams.delete('zone');
    location.assign(u.pathname + u.search + u.hash);
});
// Reconstruire la scène : le serveur la met de côté avec ses couches
// (/api/reconstruire), et la page rechargée la reconstruit d'après les données
// de l'IGN du moment ; si l'IGN ne répond pas, l'ancienne revient. Le serveur
// refuse, en disant pourquoi, moins de 10 min après sa construction, ou
// pendant qu'elle ou une de ses couches se calcule.
document.getElementById('btn-reconstruire').addEventListener('click', async e => {
    const bouton = e.currentTarget;
    if (!confirm("Relire les données de l'IGN et reconstruire cette scène et ses couches ?\n"
                 + 'Quelques secondes pour la scène ; véhicules, piscines et bateaux se détectent ensuite.')) return;
    bouton.disabled = true;
    try {
        const r = await fetch(`api/reconstruire?${REQUETE}`, { method: 'POST' });
        if (r.ok) {
            location.reload();
            return;
        }
        const corps = await r.json().catch(() => ({}));
        alert(corps.erreur || `Reconstruction impossible (HTTP ${r.status}).`);
    } catch (err) {
        alert(`Reconstruction impossible : ${err.message}`);
    }
    bouton.disabled = false;
});

// La scène — bâtiments, toitures, houppiers, routes, relief — arrive en un seul
// fichier. Sa première construction prend quelques secondes côté serveur ;
// les suivantes sont lues sur disque.
export let ARTEFACT = null;
export let ERREUR_SCENE = null;
const attente = document.getElementById('attente');
attente.hidden = false;
attente.innerHTML = 'Construction de la scène…<br><small>quelques secondes la première fois, '
    + 'instantané ensuite</small>';
// La demande partie avant three.js (DEMANDE_SCENE, en tête de page), si elle
// vise bien cette scène.
const demandeScene = window.DEMANDE_SCENE && window.DEMANDE_SCENE.url === URL_VUE3D
    ? window.DEMANDE_SCENE.reponse : fetch(URL_VUE3D);
// Premières demandes de l'orthophoto et des couches à part, envoyées dès que
// la scène est reçue : elle est alors écrite, et le serveur prépare le reste
// pendant que la page construit ses maillages. Elles partaient après le
// relief et les bâtiments, et les piscines après la végétation et la
// première image : à Gordes, scène en cache, à 3,1 s et 9,0 s de la
// navigation, contre 1,4 s pour toutes désormais (médianes de trois
// chargements, outils/chrono-page.mjs). Une fois le corps de la scène reçu,
// pas dès ses en-têtes : l'orthophoto (138 Ko à Gordes, 670 Ko en zone de
// 1 000 m) et cinq autres demandes partaient pendant que la scène (245 Ko,
// 1,1 à 1,4 Mo en zone de 1 000 m) arrivait encore ; sur un lien lent, elles
// lui prenaient de la bande passante, et sept demandes à la fois dépassent
// les six connexions par serveur de HTTP/1.1. En local, cela ne coûte que le
// décodage du JSON : les réponses arrivent 20 à 30 ms après la fin de la
// scène au lieu de 0 à 30 ms avant (Gordes en zone de 1 000 m, scène en
// cache, Chrome), pourvu que la page rende la main une fois avant ses
// maillages (plus bas). Pas les véhicules : des demandes qui attendent une
// détection de plusieurs minutes bloqueraient les autres. Chaque chargeur
// prend la sienne à son premier essai (requete).
const demandesAnticipees = new Map();
function demanderSuite() {
    for (const [url, options] of [
        [URL_MONUMENTS], [URL_OUVRAGES], ['api/sante', { cache: 'no-store' }],
        [URL_PISCINES, { cache: 'no-cache' }], [URL_PANNEAUX, { cache: 'no-cache' }]]) {
        const reponse = fetch(url, options);
        reponse.catch(() => {});      // l'erreur est traitée par le chargeur
        demandesAnticipees.set(url, reponse);
    }
    const image = chargerImage(URL_VUE3D_ORTHO, false);
    image.catch(() => {});
    demandesAnticipees.set(URL_VUE3D_ORTHO, image);
}
/** La réponse anticipée de `url`, une seule fois ; sinon une nouvelle demande. */
export function requete(url, options, charger = fetch) {
    const reponse = demandesAnticipees.get(url);
    demandesAnticipees.delete(url);
    return reponse || charger(url, options);
}
// Une scène indisponible est redemandée seule, sans recharger la page : un
// 503 (un service de l'IGN n'a pas répondu, rien n'a été mis en cache) ou une
// connexion coupée (le serveur relancé pendant l'attente). Le 2 octobre 2026,
// la Géoplateforme a mis plus de dix minutes à se remettre : deux
// constructions du même point ont échoué à dix minutes d'écart (orthophoto
// expirée en 160 s, relief refusé en 400 au bout de 89 s), et une même
// requête WMS répondait en 60, 20 puis 4 s. D'où des attentes croissantes, et
// une fin : une page oubliée ouverte ne relance pas l'IGN toute la nuit. Huit
// essais de plus, une demi-heure d'attente en tout, chacun d'une quinzaine de
// requêtes vers l'IGN, loin de ses quotas. Une autre erreur (point invalide,
// hors de France, erreur du serveur) n'est pas réessayée : elle reviendrait.
const ATTENTES_SCENE_S = [30, 60, 120, 300, 300, 300, 300, 300];
class ScenePasDisponible extends Error {}
export const echapper = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function lireScene(demande) {
    let r;
    try { r = await demande; }
    catch (err) { throw new ScenePasDisponible(`le serveur ne répond pas (${err.message})`); }
    if (r.ok) {
        const a = await r.json();
        demanderSuite();
        // La main rendue une fois : Chrome n'envoie ces demandes qu'à une
        // tâche suivante. Sans cela, elles partaient après les maillages,
        // 413 ms après la fin de la scène à Gordes en zone de 1 000 m,
        // contre 20 ms ainsi. Par un MessageChannel plutôt qu'un
        // setTimeout : dans un onglet en arrière-plan, Chrome aligne les
        // minuteries sur des réveils d'une seconde, pas les messages
        // (envoi à +16 à +23 ms, mesuré à la contre-vérification).
        await new Promise(ok => {
            const canal = new MessageChannel();
            canal.port1.onmessage = () => ok();
            canal.port2.postMessage(0);
        });
        return a;
    }
    const corps = await r.json().catch(() => ({}));
    const message = corps.erreur || `HTTP ${r.status}`;
    throw [502, 503, 504].includes(r.status) ? new ScenePasDisponible(message) : new Error(message);
}
/** Le message d'une scène pas encore disponible, avec le temps avant le prochain essai. */
function attendreNouvelEssai(message, secondes) {
    return new Promise(ok => {
        const fin = Date.now() + secondes * 1000;
        const afficher = () => {
            const reste = Math.max(0, Math.ceil((fin - Date.now()) / 1000));
            attente.innerHTML = 'Scène indisponible pour l\'instant<br><small>' + echapper(message)
                + `</small><br><small>Nouvel essai dans ${reste} s…</small>`;
            if (reste > 0) return;
            clearInterval(minuterie);
            attente.innerHTML = 'Construction de la scène…<br><small>nouvel essai</small>';
            ok();
        };
        const minuterie = setInterval(afficher, 1000);
        afficher();
    });
}
async function obtenirScene() {
    for (let essai = 0; ; essai++) {
        try {
            return await lireScene(essai === 0 ? demandeScene : fetch(URL_VUE3D));
        } catch (err) {
            if (!(err instanceof ScenePasDisponible) || essai >= ATTENTES_SCENE_S.length) throw err;
            await attendreNouvelEssai(err.message, ATTENTES_SCENE_S[essai]);
        }
    }
}
export const chargementArtefact = obtenirScene()
    .then(a => { ARTEFACT = a; attente.hidden = true; return a; })
    .catch(err => {
        ERREUR_SCENE = err.message;
        attente.innerHTML = 'Scène indisponible<br><small>' + echapper(err.message) + '</small>'
            + (err instanceof ScenePasDisponible ? '<br><small>Recharger la page pour réessayer.</small>' : '');
        return null;
    });
// Suivi de la construction : pendant l'attente, le serveur dit à quelle étape
// il en est (/api/avancement). Une scène déjà en cache arrive avant la
// première question. Un confort : son échec ne touche pas la scène.
//
// Part de la barre que remplissent les lectures, puis les toitures ; les
// houppiers et l'envoi de la scène ont le reste. Les étapes comptées une à
// une, les seize lectures faisaient 89 % de la barre : elles finissent
// ensemble en 3 s environ, et la barre restait à 89 % pendant tout le calcul.
// Durées mesurées en zone de 1 000 m, depuis /api/avancement (médianes de six
// constructions, trois natives et trois dans le conteneur, charge de 56 à 72) :
// lectures 3,1 s, toitures 0,7 s, houppiers et envoi 1,1 s à Gordes
// (63 / 14 / 23 %) ; 2,7, 2,8 et 1,3 s à Strasbourg (40 / 41 / 19 %). En
// moyenne 52 / 27 / 21 %, arrondi. L'emprise de 356 m donne 68 et 70 % aux
// lectures (1,2 et 1,8 s en tout) : la barre y passe vite de toute façon.
const PART_LECTURES = 0.5, PART_TOITURES = 0.3;
/**
 * Part de la construction faite quand le serveur annonce l'étape `etape` sur
 * `total` : les étapes terminées, pas celle en cours. Les deux dernières sont
 * les toitures et les houppiers (scene.ETAPES_SCENE), les autres des
 * lectures, comptées chacune pour autant.
 */
function partConstruite(etape, total) {
    const lectures = total - 2;
    if (etape <= lectures) return PART_LECTURES * Math.max(etape - 1, 0) / lectures;
    return etape === lectures + 1 ? PART_LECTURES : PART_LECTURES + PART_TOITURES;
}
// Une question à la fois : posées sans attendre la réponse, elles s'empilaient
// quand le service était saturé (240 en attente le 6 novembre 2026).
let suiviEnVol = false;
const suiviConstruction = setInterval(async () => {
    if (suiviEnVol) return;
    suiviEnVol = true;
    try {
        const r = await fetch(`api/avancement?${REQUETE}`, { cache: 'no-store' });
        const a = r.ok ? await r.json() : null;
        if (!a || a.etat !== 'construction' || ARTEFACT || ERREUR_SCENE) return;
        attente.innerHTML = '<div>Construction de la scène…<br><small>'
            + `étape ${a.etape} sur ${a.total} : ${a.libelle} · ${a.secondes} s</small>`
            + `<div class="avancement"><i style="width:${Math.round(100 * partConstruite(a.etape, a.total))}%"></i></div></div>`;
    } catch (e) {
        /* réseau coupé : le message d'attente d'origine reste */
    } finally {
        suiviEnVol = false;
    }
}, 500);
chargementArtefact.finally(() => clearInterval(suiviConstruction));
