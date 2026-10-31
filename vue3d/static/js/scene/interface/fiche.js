// La fiche d'un bâtiment, et ses liens : Street View orienté, recentrer, y aller.

import { CENTER, PARAM_ZONE_LIEN } from '../socle/point.js';
import { chargementArtefact } from '../socle/chargement.js';
import { M_PAR_DEGRE_LAT, M_PAR_DEGRE_LON, toLocal } from '../socle/projection.js';
import { toitsEnPente, toitsMesures, CIBLE } from '../batiments/etat.js';
import { noteNuage } from '../couches/nuage.js';
import { ECART_TOIT_M, ecartsParToit } from '../couches/ecarts-toits.js';
import { ficheDpe } from '../couches/foncier.js';

/**
 * Lien Street View vers le bâtiment sélectionné.
 *
 * Le point de vue est le centre de l'emprise : Google retient le panorama le
 * plus proche, c'est-à-dire celui de la rue qui dessert le bâtiment. On utilise
 * le format documenté (Maps URLs API) et non l'ancien `cbll=`, jamais spécifié.
 *
 * Le dernier sommet d'un anneau GeoJSON répète le premier : l'inclure
 * décalerait le centre vers ce point.
 */
export function lienStreetView(anneau) {
    if (!anneau || anneau.length < 3) return '';
    const [lon, lat] = centreAnneau(anneau);
    const url = 'https://www.google.com/maps/@?api=1&amp;map_action=pano&amp;viewpoint='
        + lat.toFixed(6) + ',' + lon.toFixed(6);
    return '<a class="lien-ext" href="' + url + '" target="_blank" rel="noopener noreferrer">'
        + 'Voir en Street View ↗</a>';
}

/**
 * Lien qui recharge la page centrée sur le bâtiment : la scène est toujours
 * cadrée sur son point, et un bâtiment coupé par le bord, ou vu de loin, se
 * lit mieux au centre de la sienne. Le point est le centre de l'emprise.
 */
export function lienRecentrer(anneau) {
    if (!anneau || anneau.length < 3) return '';
    return lienRecentrerSur(centreAnneau(anneau), 'sur ce bâtiment');
}

/** Le même lien, sur un point : un arbre, un véhicule, un bateau, une piscine. */
export function lienRecentrerSur([lon, lat], quoi) {
    return ' <a class="lien-ext lien-recentrer" href="?lat=' + lat.toFixed(6) + '&amp;lon=' + lon.toFixed(6) + PARAM_ZONE_LIEN.replace('&', '&amp;') + '">'
        + 'Recentrer la scène ' + quoi + '</a>';
}

/**
 * Lien « Y aller » : l'itinéraire jusqu'au point dans l'application de cartes
 * de l'appareil — Plans sur iPhone et iPad, Google Maps ailleurs (son
 * application sur Android, son site sinon), qui calent le point sur la rue la
 * plus proche. Une page ne peut pas guider la voiture elle-même : sur l'écran
 * d'une Tesla, l'itinéraire s'ouvre dans Google Maps ; depuis le téléphone,
 * le partage vers l'application Tesla l'envoie à la voiture.
 */
const APPAREIL_APPLE = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);     // iPad en mode ordinateur
export function lienYAller([lon, lat]) {
    const point = lat.toFixed(6) + ',' + lon.toFixed(6);
    const url = APPAREIL_APPLE ? 'https://maps.apple.com/?daddr=' + point + '&amp;dirflg=d'
                               : 'https://www.google.com/maps/dir/?api=1&amp;destination=' + point;
    return ' <a class="lien-ext lien-y-aller" href="' + url + '" target="_blank" rel="noopener noreferrer">'
        + 'Y aller ↗</a>';
}

// --- Orientation Street View --------------------------------------------
// Google pose la vue sur le panorama le plus proche du point demandé, avec un
// cap par défaut quelconque. Pour regarder le bâtiment, on se place sur la
// route la plus proche (BD TOPO troncon_de_route) et on vise son centre depuis
// là : le panorama retenu est alors celui de cette rue, et le cap est juste.
// Les routes ne sont chargées qu'au premier clic sur un bâtiment.
let segmentsRoute = null;      // [[x0,y0,x1,y1], ...] en mètres locaux
let chargementRoutes = null;
let jetonFiche = 0;            // invalide une orientation arrivée après un autre clic
export let ficheUd = null;                 // le bâtiment de la fiche, redessinée quand les DPE changent

function chargerRoutes() {
    if (chargementRoutes) return chargementRoutes;
    chargementRoutes = chargementArtefact
        .then(a => (a && a.routes) || { features: [] })
        .then(json => {
            const segs = [];
            for (const f of json.features || []) {
                const g = f.geometry || {};
                const lignes = g.type === 'LineString' ? [g.coordinates]
                             : g.type === 'MultiLineString' ? g.coordinates : [];
                for (const ligne of lignes) {
                    for (let i = 1; i < ligne.length; i++) {
                        const [ax, ay] = toLocal(ligne[i - 1][0], ligne[i - 1][1]);
                        const [bx, by] = toLocal(ligne[i][0], ligne[i][1]);
                        segs.push([ax, ay, bx, by]);
                    }
                }
            }
            segmentsRoute = segs;
            return segs;
        })
        .catch(() => { segmentsRoute = []; return []; });
    return chargementRoutes;
}

/** Point de route le plus proche d'un point local, ou null sans route. */
function pointRouteLePlusProche(px, py) {
    let meilleur = null, dMin = Infinity;
    for (const [ax, ay, bx, by] of segmentsRoute || []) {
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
        const qx = ax + t * dx, qy = ay + t * dy;
        const d = Math.hypot(px - qx, py - qy);
        if (d < dMin) { dMin = d; meilleur = { x: qx, y: qy, dist: d }; }
    }
    return meilleur;
}

/**
 * Centroïde de surface d'un anneau lon/lat (formule des lacets).
 *
 * Pas la moyenne des sommets : la BD TOPO densifie les façades détaillées, et
 * la moyenne dérive vers elles de plusieurs mètres. Depuis une rue à 12 m,
 * quelques mètres d'écart font des dizaines de degrés de cap (mesuré : 29°).
 * Repli sur la moyenne si l'aire est nulle (anneau dégénéré).
 */
export function centreAnneau(anneau) {
    const pts = anneau.length > 1
        && anneau[0][0] === anneau[anneau.length - 1][0]
        && anneau[0][1] === anneau[anneau.length - 1][1] ? anneau.slice(0, -1) : anneau;
    // En mètres locaux, sinon la formule mélange des degrés de longitude et
    // de latitude qui n'ont pas la même longueur.
    const loc = pts.map(([lo, la]) => toLocal(lo, la));
    let aire = 0, cx = 0, cy = 0;
    for (let i = 0, j = loc.length - 1; i < loc.length; j = i++) {
        const f = loc[j][0] * loc[i][1] - loc[i][0] * loc[j][1];
        aire += f; cx += (loc[j][0] + loc[i][0]) * f; cy += (loc[j][1] + loc[i][1]) * f;
    }
    if (Math.abs(aire) < 1e-6) {
        let lon = 0, lat = 0;
        for (const [lo, la] of pts) { lon += lo; lat += la; }
        return [lon / pts.length, lat / pts.length];
    }
    cx /= 3 * aire; cy /= 3 * aire;
    return [CENTER[0] + cx / M_PAR_DEGRE_LON, CENTER[1] + cy / M_PAR_DEGRE_LAT];
}

/** Remplace le lien centroïde de la fiche par un lien posé sur la rue, orienté. */
async function orienterStreetView(anneau, jeton) {
    if (!anneau || anneau.length < 3) return;
    await chargerRoutes();
    if (jeton !== jetonFiche) return;          // l'utilisateur a cliqué ailleurs
    const lien = document.querySelector('#fiche-batiment .lien-ext');
    if (!lien) return;
    const [lon, lat] = centreAnneau(anneau);
    const [cx, cy] = toLocal(lon, lat);
    const q = pointRouteLePlusProche(cx, cy);
    // Au-delà, la « rue la plus proche » n'est plus celle du bâtiment : on garde
    // le centroïde, Google se débrouille.
    if (!q || q.dist > 120) return;
    const cap = (Math.atan2(cx - q.x, cy - q.y) * 180 / Math.PI + 360) % 360;
    const lonR = CENTER[0] + q.x / M_PAR_DEGRE_LON;
    const latR = CENTER[1] + q.y / M_PAR_DEGRE_LAT;
    lien.href = 'https://www.google.com/maps/@?api=1&map_action=pano&viewpoint='
        + latR.toFixed(6) + ',' + lonR.toFixed(6) + '&heading=' + cap.toFixed(0);
    lien.textContent = 'Voir en Street View (depuis la rue, orienté) ↗';
}

// Les parties de la fiche qu'ajoutent les couches qui la lisent sans qu'elle
// les importe : l'ensoleillement du toit (couches/solaire), après les DPE.
const sectionsFiche = [];
/** `section(ud)` rend le HTML de sa partie de la fiche, ou ''. */
export function ajouterSectionFiche(section) { sectionsFiche.push(section); }

// Champs BD TOPO affichés dans la fiche, dans cet ordre. Les absents sont dits
// « non renseigné » plutôt que masqués : une fiche qui rétrécit silencieusement
// laisse croire à une donnée perdue en route.
const LIBELLES_BDTOPO = [
    ['usage_1', 'Usage', ''],
    ['usage_2', 'Usage secondaire', ''],
    ['nature', 'Nature', ''],
    ['hauteur', 'Hauteur déclarée', ' m'],
    ['nombre_d_etages', 'Étages', ''],
    ['nombre_de_logements', 'Logements', ''],
    ['date_d_apparition', 'Apparu le', ''],
    ['materiaux_des_murs', 'Matériaux des murs (code)', ''],
    ['materiaux_de_la_toiture', 'Matériaux de toiture (code)', ''],
];

/** Remplit la fiche latérale d'un bâtiment, avec ses mesures LiDAR. */
export function afficherFicheBatiment(ud) {
    const jeton = ++jetonFiche;
    ficheUd = ud;
    orienterStreetView(ud.anneau, jeton);
    const p = ud.p || {};
    const lignes = LIBELLES_BDTOPO.map(([cle, libelle, unite]) => {
        const v = p[cle];
        const texte = (v === null || v === undefined || v === '')
            ? '<i style="opacity:.55">non renseigné</i>'
            : (typeof v === 'number' ? (Math.round(v * 100) / 100) : v) + unite;
        return '<div class="stat"><span>' + libelle + '</span><b>' + texte + '</b></div>';
    }).join('');
    const stat = (libelle, valeur) => '<div class="stat"><span>' + libelle + '</span><b>' + valeur + '</b></div>';
    const metres = v => v.toFixed(1).replace('.', ',') + ' m';
    const vise = CIBLE && ud.anneau === CIBLE.anneau
        ? stat('distance au point', CIBLE.distance === 0 ? 'dedans' : metres(CIBLE.distance)) : '';
    // Le toit tel qu'il est dessiné, et pourquoi : la surface mesurée n'est
    // retenue que là où le toit résumé s'écarte du LiDAR (vue3d/toits.py).
    const l = ud.lidar;
    const forme = !l ? ''
        : stat('toit dessiné', l.pans && toitsEnPente && toitsMesures ? `${l.pans.n_pans} pan(s) mesuré(s)`
               : l.surface && toitsEnPente && toitsMesures ? 'surface mesurée'
               : (l.corps && l.corps.length >= 2 ? `${l.corps.length} corps de toit`
                  : (l.faitage - l.gouttiere > 0.5 ? 'deux pans' : 'plat')))
          + (l.ecart_resume != null ? stat('écart du toit résumé au LiDAR', metres(l.ecart_resume)) : '');
    // Le toit dessiné contre les points du nuage (verifierToits).
    const v = ecartsParToit.get(ud.anneau);
    const signe = x => (x > 0 ? '+' : x < 0 ? '−' : '') + metres(Math.abs(x));
    const verif = !v ? ''
        : stat(`hors de la forme du toit${v.enEcart ? ' ⚠' : ''}`, `${Math.round(100 * v.part)} % de ${v.n} points`)
          + stat('décalage au nuage LiDAR', signe(v.mediane))
          + `<div class="note">Le toit dessiné contre le point le plus haut de chaque mètre carré du nuage `
          + `LiDAR HD (${v.phase}). Le décalage est l'écart médian, positif quand le toit passe sous les `
          + `points ; hors de la forme, les points à plus de ${metres(ECART_TOIT_M)} du toit, décalage ôté.</div>`;
    const mesure = ud.nuage ? noteNuage(ud.nuage) : ud.lidar
        ? stat('gouttière LiDAR', metres(ud.lidar.gouttiere))
          + stat('faîtage LiDAR', metres(ud.lidar.faitage)) + forme
        : (ud.inconnue
            ? '<div class="note">Hauteur inconnue : bâtiment sous les arbres, le LiDAR y lit la canopée.</div>'
            : '<div class="note">Pas de mesure LiDAR fiable : hauteurs de la BD TOPO.</div>');
    // Le bord de la scène coupe les bâtiments qui en sortent (vue3d/batiments.py) :
    // les attributs ci-dessus décrivent le bâtiment entier, pas le morceau dessiné.
    const coupe = p.coupe
        ? '<div class="note">Coupé par le bord de la scène : ' + Math.round(100 * p.coupe.part)
          + ' % de son emprise est dessinée. Les attributs BD TOPO sont ceux du bâtiment entier.</div>'
        : '';
    document.getElementById('fiche-batiment').innerHTML = vise + lignes + mesure + verif + coupe + ficheDpe(ud)
        + sectionsFiche.map(section => section(ud)).join('')
        + '<div class="note">BD TOPO <code>' + (p.cleabs || '—') + '</code></div>'
        + lienStreetView(ud.anneau) + lienRecentrer(ud.anneau)
        + (ud.anneau && ud.anneau.length >= 3 ? lienYAller(centreAnneau(ud.anneau)) : '');
}
