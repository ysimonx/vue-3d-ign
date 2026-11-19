// Les DPE de l'ADEME et les ventes DVF, lus au clic.

import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { URL_DPE, URL_DVF } from '../socle/reseau.js';
import { echapper } from '../socle/chargement.js';
import { toLocal } from '../socle/projection.js';
import { scene, renderer } from '../socle/rendu.js';
import { MAT_CIBLE, MAT_VOISIN, MAT_INCONNU, DECALAGE_DESSUS, meshes } from '../batiments/etat.js';
import { pointDansAnneau } from '../geometrie/polygones.js';
import { ajouterCiblesSurvol, majCiblesSurvol } from '../interface/survol.js';
import { etatCouche } from '../interface/etat-couche.js';
import { citerSource, majCredits } from '../interface/credits.js';
import { apresLaPhotoDesToits } from '../terrain/fond.js';
import { EAU_MAILLE, subdiviser, trianglesPolygone, maillageDrape, placerDrapes } from './eau.js';
import { ficheUd, centreAnneau, afficherFicheBatiment } from '../interface/fiche.js';

// Deux couches à part (/api/dpe, /api/dvf ; vue3d/dpe.py, vue3d/dvf.py) que
// la page ne demande qu'au premier clic sur leur bouton : choix de
// l'utilisateur, qui ne veut ni l'ADEME ni DVF interrogés à chaque scène.
// Chacune porte la date de sa lecture ; « Reconstruire la scène » la relit.
//
// DPE : chaque bâtiment qui en a prend la couleur de son étiquette énergie
// médiane, murs et toit ; les DPE sans bâtiment de la scène sont des
// pastilles posées au sol, à leur adresse. D'un immeuble, la fiche ne donne
// que la répartition des étiquettes ; d'une maison, ses DPE.
// Ventes : les parcelles vendues depuis cinq ans, drapées sur le sol et
// teintées par leur prix au m² médian ; le bâtiment posé dessus en prend la
// couleur. Dans un village, la parcelle vendue est presque toute sous son
// bâtiment : à Gordes, le sol teinté seul ne se voyait pas. Les DPE affichés,
// eux seuls colorent les bâtiments : les deux palettes partagent leurs
// jaunes et leurs rouges.
// Les couleurs réglementaires de l'étiquette énergie.
const DPE_COULEURS = { A: 0x009c6d, B: 0x52b153, C: 0xa5cc74, D: 0xf4e70f, E: 0xf0b40f, F: 0xeb8235,
                       G: 0xd7221f };
const enHexa = c => '#' + c.toString(16).padStart(6, '0');
let DPE = null;                     // { lu_le, nombre, batiments, adresses }
let dpeParBatiment = new Map();     // cleabs -> { resume, par_rnb, par_adresse, dpe? }
let dpeActif = false;
const dpeAvant = new Map();           // maillage -> son matériau d'avant les couleurs
const matsCouleur = new Map();        // couleur, et '-dessus' -> matériau
export let venteParBatiment = new Map();   // cleabs -> { parcelle, couleur }
let contoursVente = [];             // les contours des bâtiments vendus, à retirer
// Un bâtiment vendu se distingue aussi par son contour, même quand ce sont
// les DPE qui le colorent : demande de l'utilisateur. Cyan, hors des deux
// palettes et de l'orange du bâtiment visé. En traits de 2,5 px : à un
// pixel, le contour se perdait sur un téléphone, dans la vidéo de
// démonstration (outils/demo-video.mjs foncier). La résolution du trait,
// que three.js r160 ne règle pas (1 × 1 par défaut : un trait de 2,5 px y
// couvrait tout l'écran de cyan), est reprise du rendu avant chaque image
// (resolutionContour), redimensionnements compris.
//
// Sauf sur un rendu logiciel (SwiftShader, llvmpipe : pas de carte
// graphique, ou pas d'accès à elle) : y compiler le shader des traits épais
// gelait la page une quarantaine de secondes, mesuré le 9 octobre 2026 à
// Honfleur dans Chrome sans écran (de 3 à 0,3 image par seconde, même les
// ventes éteintes), contre 2 images par seconde stables en trait fin, dont
// le shader est déjà celui du bâtiment visé. Sur Metal, le trait épais ne
// coûte rien de visible.
const RENDU_LOGICIEL = (() => {
    try {
        const gl = renderer.getContext();
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return /SwiftShader|llvmpipe|Software|Basic Render/i.test(
            gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    } catch (e) { return false; }
})();
const MAT_CONTOUR_VENTE = RENDU_LOGICIEL ? new THREE.LineBasicMaterial({ color: 0x22d3ee })
                                         : new LineMaterial({ color: 0x22d3ee, linewidth: 2.5 });
const tailleRendu = new THREE.Vector2();
function resolutionContour(r) { MAT_CONTOUR_VENTE.resolution.copy(r.getSize(tailleRendu)); }
const groupeDpe = new THREE.Group();  // les DPE sans bâtiment, à leur adresse
groupeDpe.visible = false;
scene.add(groupeDpe);
ajouterCiblesSurvol(() => groupeDpe.visible ? groupeDpe.children : []);
let DVF = null;
export let dvfActif = false;
citerSource('dpe', () => dpeActif);
citerSource('dvf', () => dvfActif);
apresLaPhotoDesToits(() => appliquerCouleurs());
const groupeDvf = new THREE.Group();
groupeDvf.visible = false;
scene.add(groupeDvf);
ajouterCiblesSurvol(() => groupeDvf.visible ? groupeDvf.children : []);

function materiauCouleur(couleur, dessus) {
    const cle = couleur + (dessus ? '-dessus' : '');
    if (!matsCouleur.has(cle)) {
        matsCouleur.set(cle, new THREE.MeshStandardMaterial({
            color: couleur, roughness: 0.85, flatShading: !dessus,
            ...(dessus ? DECALAGE_DESSUS : {}) }));
    }
    return matsCouleur.get(cle);
}
const materiauDpe = (etiquette, dessus) => materiauCouleur(DPE_COULEURS[etiquette], dessus);

/** La couleur d'un bâtiment : son DPE si les DPE sont affichés, sinon sa vente ; null sinon. */
function couleurBatiment(ud) {
    const cle = ud.p && ud.p.cleabs;
    if (dpeActif && DPE) {
        const g = dpeParBatiment.get(cle);
        return g ? DPE_COULEURS[g.resume.mediane] : null;
    }
    const v = dvfActif && DVF && venteParBatiment.get(cle);
    return v ? v.couleur : null;
}

/**
 * Murs et toits des bâtiments qui ont un DPE ou une vente, à leur couleur ;
 * les autres gardent les leurs. Les murs d'un bâtiment vendu ont en plus
 * leur contour, ventes affichées. Rappelée après chaque pose des toits
 * (appliquerTextureToits) : les maillages d'avant sont rendus à leur
 * matériau, sauf ceux qu'on a déjà remplacés entre-temps.
 */
function appliquerCouleurs() {
    if (!dpeAvant) return;                 // bloc pas encore évalué
    const nos = new Set(matsCouleur.values());
    for (const [mesh, materiau] of dpeAvant) if (nos.has(mesh.material)) mesh.material = materiau;
    dpeAvant.clear();
    for (const { mesh, ligne } of contoursVente) { mesh.remove(ligne); ligne.geometry.dispose(); }
    contoursVente = [];
    if (!(dpeActif && DPE) && !(dvfActif && DVF)) return;
    const murs = new Set([MAT_VOISIN, MAT_CIBLE, MAT_INCONNU]);
    for (const m of meshes) {
        if (!m.isMesh || m.isInstancedMesh || m.userData.nuage) continue;
        const cle = m.userData.p && m.userData.p.cleabs;
        // Les murs seulement, pas les marches d'un toit mesuré : à
        // Versailles, leurs arêtes faisaient un gribouillis (habillerCible).
        if (dvfActif && DVF && venteParBatiment.has(cle) && murs.has(m.material) && m.name !== 'toit') {
            const aretes = new THREE.EdgesGeometry(m.geometry, 40);
            const ligne = RENDU_LOGICIEL ? new THREE.LineSegments(aretes, MAT_CONTOUR_VENTE)
                : new LineSegments2(new LineSegmentsGeometry().fromEdgesGeometry(aretes), MAT_CONTOUR_VENTE);
            if (!RENDU_LOGICIEL) { ligne.onBeforeRender = resolutionContour; aretes.dispose(); }
            m.add(ligne);
            contoursVente.push({ mesh: m, ligne });
        }
        const couleur = couleurBatiment(m.userData);
        if (couleur == null) continue;
        dpeAvant.set(m, m.material);
        m.material = materiauCouleur(couleur, m.userData.dessus);
    }
}

const pastille = e => e ? `<span class="pastille" style="background:${enHexa(DPE_COULEURS[e])}">${echapper(e)}</span>` : '—';
const nombreFr = v => v == null ? '—' : Math.round(v).toLocaleString('fr-FR');
export const dateFr = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('fr-FR') : '—';
export const dateLongue = d => d ? new Date(d + 'T12:00:00').toLocaleDateString(
    'fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '—';

/** Barre des étiquettes : chaque part à la taille de son compte. */
function barreEtiquettes(compte) {
    return '<div class="barre">' + Object.entries(compte).map(([e, n]) =>
        `<span style="flex:${Number(n)};background:${enHexa(DPE_COULEURS[e])}" title="${n} DPE ${echapper(e)}">${echapper(e)}</span>`).join('')
        + '</div>';
}

/** Le nombre de logements d'un groupe de DPE, par type. */
function typesDpe(types) {
    return Object.entries(types).map(([t, n]) => `${n} ${echapper(t)}${n > 1 && !/s$/.test(t) ? 's' : ''}`).join(', ');
}

/** Les lignes de l'infobulle d'un bâtiment, quand les DPE ou les ventes sont affichés. */
export function ligneDpe(ud) {
    const v = dvfActif && ud && ud.p && venteParBatiment.get(ud.p.cleabs);
    const vente = v ? '<br>Parcelle vendue : ' + ventesParcelle(v.parcelle, 1)[0] : '';
    const g = dpeActif && ud && ud.p && dpeParBatiment.get(ud.p.cleabs);
    if (!g) return vente;
    const r = g.resume;
    return `<br>DPE ${pastille(r.mediane)} ` + (r.n > 1 ? `médiane de ${r.n} DPE (${typesDpe(r.types)})`
                                                       : `${typesDpe(r.types)}, ${dateFr(r.au)}`) + vente;
}

/** La partie DPE de la fiche d'un bâtiment : le résumé, et le détail d'une maison. */
export function ficheDpe(ud) {
    const g = dpeActif && ud && ud.p && dpeParBatiment.get(ud.p.cleabs);
    if (!dpeActif || !DPE) return '';
    if (!g) return '<div class="sous-titre">DPE</div><div class="note">Aucun DPE rattaché à ce bâtiment.</div>';
    const r = g.resume;
    const stat = (libelle, valeur) => '<div class="stat"><span>' + libelle + '</span><b>' + valeur + '</b></div>';
    let html = '<div class="sous-titre">DPE</div>' + barreEtiquettes(r.energie)
        + stat(r.n > 1 ? 'étiquette énergie médiane' : 'étiquette énergie', pastille(r.mediane))
        + stat('DPE', `${r.n} (${typesDpe(r.types)})`)
        + (r.conso_mediane != null ? stat(r.n > 1 ? 'consommation médiane' : 'consommation',
                                          `${nombreFr(r.conso_mediane)} kWhEP/m²/an`) : '')
        + stat(r.du === r.au ? 'établi le' : 'établis', r.du === r.au ? dateFr(r.du)
                                                                     : `du ${dateFr(r.du)} au ${dateFr(r.au)}`);
    for (const d of g.dpe || []) {
        html += '<div class="liste-foncier"><div>' + pastille(d.energie) + ' ' + pastille(d.climat)
            + ` ${echapper(d.type || '')}${d.neuf ? ' neuf' : ''}, ${d.surface != null ? d.surface.toLocaleString('fr-FR') + ' m²' : 'surface inconnue'}`
            + (d.conso != null ? `, ${nombreFr(d.conso)} kWhEP/m²/an` : '')
            + `<br><i>${dateFr(d.date)}, valable jusqu'au ${dateFr(d.fin_validite)} · n° ${echapper(d.numero)}</i></div></div>`;
    }
    if (g.par_adresse) {
        html += `<div class="note">${g.par_adresse === r.n ? 'Rattaché' + (r.n > 1 ? 's' : '') : `Dont ${g.par_adresse} rattaché${g.par_adresse > 1 ? 's' : ''}`}`
            + ' par le point d\'adresse, à 5 m près : le bâtiment peut être le voisin.</div>';
    }
    return html;
}

/** Indicateur de lecture ; un échec reste affiché quelques secondes. */
let effacerEtatFoncier = null;
function etatFoncier(texte, enCours = false) {
    clearTimeout(effacerEtatFoncier);
    etatCouche('etat-foncier', texte, enCours);
    if (texte && !enCours) effacerEtatFoncier = setTimeout(() => etatCouche('etat-foncier', null), 8000);
}

/** Lit une couche au clic : une seule tentative, l'utilisateur recliquera. */
export async function lireALaDemande(libelle, source, url) {
    etatFoncier(`${libelle} : lecture ${source}…`, true);
    try {
        const r = await fetch(url, { cache: 'no-cache' });
        const couche = await r.json().catch(() => null);
        if (!r.ok) throw new Error((couche && couche.erreur) || `HTTP ${r.status}`);
        etatFoncier(null);
        return couche;
    } catch (e) {
        etatFoncier(`${libelle} indisponibles : ${e.message} Cliquer à nouveau pour réessayer.`);
        return null;
    }
}

/** Les DPE sans bâtiment : une pastille au sol, à leur adresse. */
function construireAdressesDpe() {
    const R = 2.5, N = 16;
    for (const a of DPE.adresses) {
        const [cx, cy] = toLocal(a.lon, a.lat);
        const tris = [];
        for (let k = 0; k < N; k++) {
            const t0 = 2 * Math.PI * k / N, t1 = 2 * Math.PI * (k + 1) / N;
            tris.push([[cx, cy], [cx + R * Math.cos(t0), cy + R * Math.sin(t0)],
                       [cx + R * Math.cos(t1), cy + R * Math.sin(t1)]]);
        }
        const mesh = maillageDrape(tris, materiauDpe(a.resume.mediane, true), groupeDpe, 0.4);
        const r = a.resume;
        mesh.userData = { infobulle: `<b>${echapper(a.adresse || 'DPE sans bâtiment')}</b><br>DPE ${pastille(r.mediane)} `
            + (r.n > 1 ? `médiane de ${r.n} DPE (${typesDpe(r.types)})` : `${typesDpe(r.types)}, ${dateFr(r.au)}`)
            + '<br><i>aucun bâtiment de la scène à moins de 5 m de cette adresse</i>' };
    }
    placerDrapes();
}

function resumerDpe() {
    const total = {};
    for (const g of [...DPE.batiments, ...DPE.adresses]) {
        for (const [e, n] of Object.entries(g.resume.energie)) total[e] = (total[e] || 0) + n;
    }
    const ordre = Object.fromEntries(Object.keys(DPE_COULEURS).filter(e => total[e]).map(e => [e, total[e]]));
    document.getElementById('dpe-resume').innerHTML = DPE.nombre
        ? barreEtiquettes(ordre)
          + `<div class="stat"><span>DPE</span><b>${DPE.nombre.toLocaleString('fr-FR')}</b></div>`
          + `<div class="stat"><span>bâtiments colorés</span><b>${DPE.batiments.length}</b></div>`
          + (DPE.adresses.length ? `<div class="stat"><span>adresses sans bâtiment</span><b>${DPE.adresses.length}</b></div>` : '')
        : '<div class="note">Aucun DPE dans l\'emprise.</div>';
    document.getElementById('dpe-note').innerHTML =
        `DPE des logements établis depuis juillet 2021, lus le ${dateLongue(DPE.lu_le)} ; « Reconstruire la scène » les relit. `
        + 'Un bâtiment prend la couleur de son étiquette énergie médiane. Il est désigné par l\'identifiant '
        + 'RNB du DPE, sinon par son point d\'adresse, à 5 m près. Clic sur un bâtiment : sa fiche. '
        + '<a href="https://data.ademe.fr/datasets/dpe03existant" target="_blank" rel="noopener">ADEME</a>, Licence Ouverte 2.0.';
}

document.getElementById('t-dpe').addEventListener('click', async e => {
    const bouton = e.currentTarget;
    if (!DPE) {
        if (bouton.dataset.lecture) return;
        bouton.dataset.lecture = '1';
        const couche = await lireALaDemande('DPE', 'de l\'ADEME', URL_DPE);
        delete bouton.dataset.lecture;
        if (!couche) return;
        DPE = couche;
        dpeParBatiment = new Map(DPE.batiments.map(g => [g.batiment, g]));
        construireAdressesDpe();
        resumerDpe();
    }
    dpeActif = !dpeActif;
    bouton.classList.toggle('on', dpeActif);
    groupeDpe.visible = dpeActif;
    document.getElementById('sec-dpe').hidden = !dpeActif;
    appliquerCouleurs();
    majCiblesSurvol();
    majCredits();
    if (ficheUd) afficherFicheBatiment(ficheUd);
});

// Prix au m² : cinq classes, aux quintiles des parcelles de l'emprise. Les
// prix vont de 1 à 10 d'une région à l'autre (4 700 €/m² pour une maison à
// Gordes, 11 100 pour un appartement place de la République) : une échelle
// fixe peindrait tout un lieu d'une seule couleur.
const DVF_COULEURS = [0xfde68a, 0xfbbf24, 0xf97316, 0xdc2626, 0x7f1d1d];
const DVF_SANS_PRIX = 0x8aa4c8;            // terrain, plusieurs logements, commerce…
const DVF_DECALAGE = 0.25;                 // au-dessus de l'eau (0,15 m)
const matsDvf = new Map();
function materiauDvf(couleur) {
    if (!matsDvf.has(couleur)) {
        matsDvf.set(couleur, new THREE.MeshStandardMaterial({
            color: couleur, roughness: 0.9, transparent: true, opacity: 0.8, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
    }
    return matsDvf.get(couleur);
}

// Les types de local de DVF, au singulier et au pluriel.
const LIBELLES_TYPES = { Maison: ['maison', 'maisons'], Appartement: ['appartement', 'appartements'],
                         'Local industriel. commercial ou assimilé': ['local d\'activité', 'locaux d\'activité'] };
/** Une vente sur une ligne : date, ce qui a été vendu (par type), prix. */
function ligneVente(v) {
    const parType = new Map();
    for (const l of v.locaux) if (l.type !== 'Dépendance') {
        (parType.get(l.type) || parType.set(l.type, []).get(l.type)).push(l);
    }
    const quoi = parType.size
        ? [...parType].map(([type, locaux]) => {
            const [un, plusieurs] = LIBELLES_TYPES[type] || [type.toLowerCase(), type.toLowerCase()];
            const surface = locaux.reduce((t, l) => t + (l.surface || 0), 0);
            return locaux.length === 1
                ? echapper(un) + (locaux[0].pieces ? ` ${locaux[0].pieces} p.` : '') + (surface ? ` ${nombreFr(surface)} m²` : '')
                : `${locaux.length} ${echapper(plusieurs)}` + (surface ? `, ${nombreFr(surface)} m²` : '');
        }).join(', ')
        : (v.terrain ? `terrain ${nombreFr(v.terrain)} m²` : echapper(v.nature || 'vente'));
    return `${dateFr(v.date)} · ${quoi} · ${v.valeur != null ? nombreFr(v.valeur) + ' €' : 'prix inconnu'}`
        + (v.prix_m2 ? ` · <b>${nombreFr(v.prix_m2)} €/m²</b>` : '')
        + (v.nature && !/^Vente$/.test(v.nature) ? ` <i>(${echapper(v.nature.toLowerCase())})</i>` : '');
}

/** Prix au m² médian des ventes d'une parcelle qui en ont un ; null sinon. */
function prixParcelle(p) {
    const prix = p.ventes.map(i => DVF.ventes[i].prix_m2).filter(Boolean).sort((a, b) => a - b);
    return prix.length ? prix[(prix.length - 1) >> 1] : null;
}

/** Les ventes d'une parcelle : toutes s'il y en a peu ; sinon un résumé et les trois dernières. */
function ventesParcelle(p, max = 5) {
    const ventes = p.ventes.map(i => DVF.ventes[i]);
    if (ventes.length <= max) return ventes.map(ligneVente);
    const parType = {};
    for (const v of ventes) if (v.type) (parType[v.type] = parType[v.type] || []).push(v.prix_m2);
    const resume = Object.entries(parType).map(([t, prix]) => {
        const p2 = prix.filter(Boolean).sort((a, b) => a - b);
        return `${prix.length} ${t === 'Maison' ? 'maison' : 'appartement'}${prix.length > 1 ? 's' : ''}`
            + (p2.length ? `, ${nombreFr(p2[(p2.length - 1) >> 1])} €/m² en médiane` : '');
    }).join(' ; ');
    return [`<b>${ventes.length} ventes</b>${resume ? ' : ' + resume : ''}`,
            ...ventes.slice(0, 3).map(ligneVente), `<i>… et ${ventes.length - 3} plus anciennes</i>`];
}

export function afficherVentesParcelle(p) {
    const idu = p.idu;
    document.getElementById('dvf-parcelle').innerHTML =
        `<div class="sous-titre">Parcelle ${echapper(idu.slice(5, 8))} ${echapper(idu.slice(8, 10))} ${echapper(idu.slice(10))}`
        + (p.contenance ? ` · ${nombreFr(p.contenance)} m²` : '') + '</div>'
        + '<div class="liste-foncier">' + ventesParcelle(p, 8).map(l => `<div>${l}</div>`).join('') + '</div>';
}

function construireParcelles() {
    const prix = DVF.parcelles.map(prixParcelle).filter(Boolean).sort((a, b) => a - b);
    // Bornes des cinq classes : les quintiles des parcelles qui ont un prix.
    const bornes = [1, 2, 3, 4].map(k => prix[Math.floor(k * prix.length / 5)]);
    const classe = v => bornes.filter(b => v >= b).length;
    const polygones = g => g.type === 'Polygon' ? [g.coordinates]
                         : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const p of DVF.parcelles) {
        const tris = polygones(p.geometrie).flatMap(a => subdiviser(trianglesPolygone(a), EAU_MAILLE));
        if (!tris.length) continue;
        const v = prixParcelle(p);
        const mesh = maillageDrape(tris, materiauDvf(v ? DVF_COULEURS[classe(v)] : DVF_SANS_PRIX), groupeDvf,
                                   DVF_DECALAGE);
        const lignes = ventesParcelle(p, 3);
        mesh.userData = { parcelle: p, infobulle: `<b>Parcelle vendue</b>`
            + (v ? ` · ${nombreFr(v)} €/m² en médiane` : '')
            + lignes.map(l => '<br>' + l).join('') + '<br><i>clic pour le détail dans le panneau</i>' };
        p.couleur = v ? DVF_COULEURS[classe(v)] : DVF_SANS_PRIX;
    }
    placerDrapes();
    // Le bâtiment dont le centre tombe dans une parcelle vendue en prend la couleur.
    venteParBatiment = new Map();
    for (const m of meshes) {
        const cle = m.userData.p && m.userData.p.cleabs;
        if (!cle || !m.userData.anneau || venteParBatiment.has(cle)) continue;
        const [lon, lat] = centreAnneau(m.userData.anneau);
        const p = DVF.parcelles.find(q => polygones(q.geometrie).some(a => pointDansAnneau(lon, lat, a[0])));
        if (p) venteParBatiment.set(cle, { parcelle: p, couleur: p.couleur });
    }
    return prix.length ? [prix[0], ...bornes, prix[prix.length - 1]] : null;
}

function resumerDvf(bornes) {
    const r = DVF.resume;
    const ligne = (t, libelle) => r[t] ? `<div class="stat"><span>${libelle} (${r[t].ventes} ventes)</span>`
        + `<b>${nombreFr(r[t].mediane)} €/m²</b></div>`
        + `<div class="note" style="margin-top:0">la moitié entre ${nombreFr(r[t].q1)} et ${nombreFr(r[t].q3)} €/m²</div>` : '';
    const annees = DVF.millesimes.length ? `${DVF.millesimes[0]} à ${DVF.millesimes[DVF.millesimes.length - 1]}` : '';
    const legende = bornes ? '<div class="barre">' + DVF_COULEURS.map((c, k) =>
        `<span style="flex:1;background:${enHexa(c)}" title="de ${nombreFr(bornes[k])} à ${nombreFr(bornes[k + 1])} €/m²"></span>`).join('')
        + `<span style="flex:1;background:${enHexa(DVF_SANS_PRIX)}" title="vente sans prix au m²"></span></div>`
        + `<div class="stat"><span>${nombreFr(bornes[0])} €/m²</span><b>${nombreFr(bornes[5])} €/m²</b></div>` : '';
    document.getElementById('dvf-resume').innerHTML = DVF.absent.length && !DVF.parcelles.length
        ? `<div class="note">Pas de DVF ici : en ${DVF.absent.map(echapper).join(', ')}, la publicité foncière relève `
          + 'du livre foncier d\'Alsace-Moselle, que la DGFiP ne publie pas.</div>'
        : (DVF.parcelles.length
            ? ligne('Maison', 'Maisons') + ligne('Appartement', 'Appartements') + legende
              + `<div class="stat"><span>parcelles vendues</span><b>${DVF.parcelles.length}</b></div>`
            : `<div class="note">Aucune vente de ${annees} dans l'emprise.</div>`);
    document.getElementById('dvf-parcelle').innerHTML = '';
    document.getElementById('dvf-note').innerHTML =
        `Ventes de ${annees}, lues le ${dateLongue(DVF.lu_le)} ; « Reconstruire la scène » les relit. `
        + 'Prix au m² : vente d\'un seul logement, sur sa surface bâtie déclarée (pas la loi Carrez) ; '
        + 'couleur : prix médian de la parcelle, en cinq classes aux quintiles de l\'emprise, bleu sans prix au m², '
        + 'reprise par le bâtiment posé dessus quand les DPE ne sont pas affichés ; contour cyan : bâtiment vendu. '
        + 'Clic sur une parcelle : ses ventes. Réutilisation : interdiction de réidentifier les personnes. '
        + '<a href="https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres-geolocalisees/" target="_blank" rel="noopener">DGFiP, Etalab</a>, '
        + 'Licence Ouverte 2.0 ; parcelles : Parcellaire Express, IGN.';
}

document.getElementById('t-dvf').addEventListener('click', async e => {
    const bouton = e.currentTarget;
    if (!DVF) {
        if (bouton.dataset.lecture) return;
        bouton.dataset.lecture = '1';
        const couche = await lireALaDemande('Ventes', 'du cadastre et des fichiers DVF', URL_DVF);
        delete bouton.dataset.lecture;
        if (!couche) return;
        DVF = couche;
        resumerDvf(construireParcelles());
    }
    dvfActif = !dvfActif;
    bouton.classList.toggle('on', dvfActif);
    groupeDvf.visible = dvfActif;
    document.getElementById('sec-dvf').hidden = !dvfActif;
    appliquerCouleurs();
    majCiblesSurvol();
    majCredits();
});
