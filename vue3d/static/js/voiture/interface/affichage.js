// Le bandeau : rue, vitesse et limitation, prochain panneau, GPS, carrés prêts.

import { SIMU, VITESSE_SIMU_KMH, SIMU_LIMITE } from '../socle/parametres.js';
import { voiture, VERS, itineraire } from '../socle/etat.js';
import {
    elVitesse, elRue, elNom, elNumero, elGps, elCarres, majLienQuitter, echapperHtml,
} from './ecran.js';
import { manquees } from '../sol/manquees.js';
import { carres, carreDe } from '../carres/grille.js';
import { pointDuChemin } from '../route/graphe.js';
import { PAS_COULOIR_M } from '../carres/batiments.js';
import { limiteDe } from '../route/limitations.js';
import { prochainSignal } from '../route/signalisation.js';
import { simu } from '../route/simulation.js';
import { majAlerteSol } from './signalements.js';

const PETITS_MOTS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'au', 'aux', 'sur', 'sous', 'à']);
// Les abréviations du nom collaboratif (« R DE LA CHAUSSEE D'ANTIN »), quand
// la BAN n'en donne pas.
const ABREVIATIONS = { r: 'rue', av: 'avenue', ave: 'avenue', bd: 'boulevard', pl: 'place', rte: 'route',
    che: 'chemin', chem: 'chemin', imp: 'impasse', all: 'allée', qu: 'quai', sq: 'square', crs: 'cours',
    fg: 'faubourg', pass: 'passage', rpt: 'rond-point', espl: 'esplanade', prom: 'promenade', sen: 'sente' };
function nomDeVoie(nom) {
    let brut = String(nom || '').trim();
    if (!brut) return '';
    // Déjà en casse de nom propre (« Rond-point des Champs Elysées-Marcel
    // Dassault ») : tel quel. Seuls les noms tout en capitales (le nom
    // collaboratif) ou tout en minuscules (la BAN, parfois) sont refaits.
    const capitales = brut === brut.toUpperCase();
    if (!capitales && brut !== brut.toLowerCase()) return brut;
    brut = brut.toLowerCase().split(/\s+/).map((m, i) => (i === 0 && capitales && ABREVIATIONS[m]) || m).join(' ');
    const majuscule = mot => mot.split('-')
        .map((p, k) => !p || (k > 0 && PETITS_MOTS.has(p)) ? p : p[0].toUpperCase() + p.slice(1)).join('-');
    return brut.split(' ').map((mot, i) => {
        if (i > 0 && PETITS_MOTS.has(mot)) return mot;
        const m = /^([dl]')(.+)$/.exec(mot);
        if (i > 0 && m) return m[1] + majuscule(m[2]);
        return majuscule(mot);
    }).join(' ');
}
const NATURES = { 'Type autoroutier': 'Autoroute', 'Bretelle': 'Bretelle', 'Rond-point': 'Rond-point',
                  'Route à 2 chaussées': 'Route', 'Route à 1 chaussée': 'Route', 'Route empierrée': 'Route empierrée',
                  'Chemin': 'Chemin', 'Bac ou liaison maritime': 'Bac' };

const elCompteur = document.getElementById('compteur'), elLimite = document.getElementById('limite');
const elLimiteV = document.getElementById('limite-v'), elLimiteSource = document.getElementById('limite-source');
let limiteAffichee = null;
/**
 * Le panneau de la limitation du tronçon où l'on roule, dans son sens, et
 * d'où elle vient ; la vitesse en rouge au-delà. Sur un tronçon que règle la
 * signalisation locale, la dernière lue reste ; sur un tronçon dont le carré
 * n'est pas encore lu, plus de panneau : celle d'avant serait peut-être fausse.
 */
function majLimite(v) {
    const l = v.vue && v.arete && !v.horsRoute ? limiteDe(v.arete, v.sensArete) : undefined;
    if (l) limiteAffichee = l;
    else if (l === undefined) limiteAffichee = null;
    elLimite.hidden = !limiteAffichee;
    elCompteur.classList.toggle('exces', !!limiteAffichee && Math.round(v.v * 3.6) > limiteAffichee.v);
    if (!limiteAffichee) return;
    elLimiteV.textContent = limiteAffichee.v;
    elLimite.classList.toggle('estimee', !limiteAffichee.osm);
    elLimiteSource.textContent = limiteAffichee.osm ? 'OpenStreetMap' : 'estimée';
    elLimite.title = limiteAffichee.osm ? 'Limitation relevée dans OpenStreetMap'
        : 'Limitation estimée : la règle générale du code de la route, faute de donnée OpenStreetMap ici';
}
const elSignal = document.getElementById('signal'), elSignalD = document.getElementById('signal-d');
const NOMS_SIGNAUX = { stop: 'Stop', cedez: 'Cédez-le-passage', feu: 'Feu' };
/** Le prochain stop, cédez-le-passage ou feu de la route prévue, et à combien de mètres. */
function majSignal(v) {
    const s = prochainSignal(v);
    elSignal.hidden = !s;
    if (!s) return;
    elSignal.className = s.type;
    elSignalD.textContent = `${Math.round(s.d / 10) * 10} m`;
    elSignal.title = `${NOMS_SIGNAUX[s.type]} relevé dans OpenStreetMap ; un panneau qui n'y est pas saisi n'est pas annoncé`;
}
const elRond = document.querySelector('#etat .rond');
let dernierHud = -Infinity;
export function majHud(maintenant) {
    if (maintenant - dernierHud < 250) return;
    dernierHud = maintenant;
    const v = voiture;
    elVitesse.textContent = v.vue ? Math.round(v.v * 3.6) : '–';
    majLimite(v);
    majSignal(v);
    const a = v.arete;
    if (a && !v.horsRoute) {
        const nom = nomDeVoie(a.nom);
        elNom.textContent = nom || NATURES[a.nature] || 'Route sans nom';
        elNumero.hidden = !a.numero;
        if (a.numero) {
            elNumero.textContent = a.numero;
            elNumero.className = 'numero ' + ({ D: 'd', E: 'e', C: 'c', V: 'c' }[a.numero[0]] || '');
        }
        elRue.hidden = false;
    } else {
        elRue.hidden = !v.vue;
        elNom.textContent = v.vue ? 'Hors des routes' : '';
        elNumero.hidden = true;
    }
    const age = v.fix ? (maintenant - v.fix.t) / 1000 : Infinity;
    elRond.className = 'rond' + (age > 10 ? ' perdu' : v.precision > 25 ? ' faible' : '');
    const resteArrivee = itineraire && v.chemin && v.chemin.fin === 'arrivee' ? v.chemin.longueur - v.dChemin : null;
    elGps.innerHTML = SIMU && VERS ? (simu.arrive ? `Arrivée${VERS.nom ? ' : <b>' + echapperHtml(VERS.nom) + '</b>' : ''}`
            : resteArrivee != null ? `${VERS.nom ? echapperHtml(VERS.nom) : 'Arrivée'} dans <b>${resteArrivee >= 1000
                ? (resteArrivee / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(resteArrivee / 10) * 10 + ' m'}</b>`
            : 'Calcul de l\'itinéraire…')
        : SIMU ? (SIMU_LIMITE ? 'Simulation <b>aux limitations</b>' : `Simulation à <b>${VITESSE_SIMU_KMH} km/h</b>`)
        : !v.fix ? 'Position attendue…'
        : age > 10 && v.arete?.sol < 0 ? 'Tunnel : <b>position estimée</b>'
        : age > 10 ? `<b>Signal GPS perdu</b> depuis ${Math.round(age)} s`
        : `GPS <b>± ${Math.round(v.precision)} m</b>`;
    // Jusqu'où les bâtiments sont prêts le long de la route prévue.
    let pret = 0;
    const ch = v.chemin;
    if (ch) {
        for (let d = v.dChemin; d <= ch.longueur; d += PAS_COULOIR_M) {
            const p = pointDuChemin(ch, d), c = carreDe(p.x, p.y);
            if (!c || !(c.mesh || c.etat === 'hors')) break;
            pret = d - v.dChemin;
        }
    }
    let charges = 0, construits = 0;
    for (const c of carres.values()) { if (c.etat === 'pret') charges++; if (c.mesh && c.mesh.visible) construits++; }
    elCarres.innerHTML = (ch ? `Bâtiments prêts sur <b>${pret >= 1000 ? (pret / 1000).toFixed(1).replace('.', ',') + ' km'
        : Math.round(pret / 50) * 50 + ' m'}</b> devant` : `${construits} carrés de bâtiments`)
        + (manquees.size ? `<br>${manquees.size} tuile${manquees.size > 1 ? 's' : ''} en attente de réseau` : '');
    const alerte = majAlerteSol(maintenant);
    if (alerte) elCarres.innerHTML += `<br><span class="alerte">⚠ Sol ${alerte}</span>`;
    if (v.vue) majLienQuitter();
}

export function accueil(html, actions) {
    document.getElementById('accueil-texte').innerHTML = html;
    const zone = document.getElementById('accueil-actions');
    zone.replaceChildren(...actions.map(([texte, faire, principal]) => {
        const el = typeof faire === 'string' ? document.createElement('a') : document.createElement('button');
        el.textContent = texte;
        if (typeof faire === 'string') el.href = faire; else el.addEventListener('click', faire);
        if (principal) el.className = 'principal';
        return el;
    }));
    document.getElementById('accueil').hidden = false;
}
