// Les bornes de recharge autour de la voiture et le long de la route, et leur
// fiche.

import * as THREE from 'three';
import { ALTI_NIVEAU_MIN } from '../../commun/tuiles.js';
import { PARAMS, RAD } from '../socle/parametres.js';
import { versLambert93, depuisLambert93 } from '../socle/lambert93.js';
import { ancres, ancrer } from '../socle/monde.js';
import { hote, renderer, scene, camera } from '../socle/rendu.js';
import { voiture } from '../socle/etat.js';
import { echapperHtml } from '../interface/ecran.js';
import { NIVEAU_PROCHE, preparerAltitudes, altitude } from '../sol/altitudes.js';
import { pointDuChemin } from '../route/graphe.js';

// --- Bornes de recharge -------------------------------------------------------------------
// La base nationale des IRVE (vue3d/bornes.py), par bloc de 4 km lu au
// serveur et gardé une semaine : à BORNES_AUTOUR_M autour de la voiture, et
// le long de la route prévue. Comme sur la page de la scène, une station est
// une pastille ronde à l'éclair, teinte de sa puissance la plus haute, de
// taille constante à l'écran, en haut d'un mât planté au sol ; mais dessinée
// par-dessus les bâtiments, comme les repères d'un GPS : la borne d'un
// parking est derrière les toits dès la rue voisine. Un toucher sur la
// pastille dit qui l'exploite, ses prises, son accès.
const BORNES_BLOC_M = 4000, BORNES_VERSION = 1;
const BORNES_AUTOUR_M = 3000, BORNES_OUBLI_M = 12000, BORNES_PARALLELE = 2;
const BORNES_CLASSES = [
    { max: 22, couleur: 0x34d399 },
    { max: 149, couleur: 0xf59e0b },
    { max: Infinity, couleur: 0xa855f7 },
];
const BORNE_SANS_PUISSANCE = 0x9ca3af;
const BORNE_MAT_M = 8;
// En part de la hauteur de la vue, à 55° : 32 px sur l'écran de la Tesla
// (601 px de haut), assez pour le doigt, que la page cherche à 40 px autour.
const BORNE_PASTILLE = 0.055, BORNE_TOUCHER_PX = 40;
// Le choix du bouton est retenu d'une visite à l'autre ; `bornes=0` ou `bornes=1` l'emporte.
const BORNES_CLE = 'vue3d-voiture-bornes';
export let bornesActives = PARAMS.has('bornes') ? PARAMS.get('bornes') !== '0' : (() => {
    try { return localStorage.getItem(BORNES_CLE) !== '0'; } catch (e) { return true; }
})();
export const blocsBornes = new Map();          // "bi/bj" → { bi, bj, etat, reessai, donnees, groupe, mats, stations }
const groupeBornes = new THREE.Group();
groupeBornes.visible = bornesActives;
scene.add(groupeBornes);
let bornesEnVol = 0, dernierBornes = -Infinity;
const MAT_MAT_BORNE = new THREE.LineBasicMaterial({ color: 0xe5e7eb, transparent: true, opacity: 0.85 });
const materiauxPastille = new Map();
/** Une pastille ronde, un éclair blanc sur la couleur de la classe, comme la page de la scène. */
function materiauPastille(couleur) {
    if (!materiauxPastille.has(couleur)) {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const g = c.getContext('2d');
        g.beginPath();
        g.arc(32, 32, 29, 0, 2 * Math.PI);
        g.fillStyle = '#' + couleur.toString(16).padStart(6, '0');
        g.fill();
        g.lineWidth = 4;
        g.strokeStyle = '#ffffff';
        g.stroke();
        g.beginPath();
        for (const [x, y] of [[36, 10], [20, 36], [31, 36], [27, 54], [44, 27], [33, 27], [36, 10]]) g.lineTo(x, y);
        g.fillStyle = '#ffffff';
        g.fill();
        const texture = new THREE.CanvasTexture(c);
        texture.colorSpace = THREE.SRGBColorSpace;
        materiauxPastille.set(couleur, new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false,
                                                                  depthTest: false, depthWrite: false }));
    }
    return materiauxPastille.get(couleur);
}
const couleurBorne = s => (s.puissance_max == null ? BORNE_SANS_PUISSANCE
    : BORNES_CLASSES.find(c => s.puissance_max <= c.max).couleur);

async function chargerBlocBornes(b) {
    b.etat = 'charge';
    bornesEnVol++;
    try {
        const reponse = await fetch(`api/bornes-bloc?i=${b.bi}&j=${b.bj}&v=${BORNES_VERSION}`);
        if (reponse.status === 422) { b.etat = 'hors'; return; }
        if (!reponse.ok) {
            b.etat = 'erreur';
            b.reessai = performance.now() + (Number(reponse.headers.get('retry-after')) || 30) * 1000;
            return;
        }
        b.donnees = await reponse.json();
        b.etat = 'pret';
        construireBlocBornes(b);
    } catch (e) {
        b.etat = 'erreur';
        b.reessai = performance.now() + 30000;
    } finally {
        bornesEnVol--;
    }
}

function construireBlocBornes(b) {
    b.cx = (b.bi + 0.5) * BORNES_BLOC_M; b.cy = (b.bj + 0.5) * BORNES_BLOC_M;
    b.groupe = new THREE.Group();
    ancrer(b.groupe, b.cx, b.cy, 0);
    b.stations = b.donnees.stations.map(s => {
        const [x, y] = versLambert93(s.lon, s.lat);
        const pastille = new THREE.Sprite(materiauPastille(couleurBorne(s)));
        pastille.center.set(0.5, 0);                // posée par le bas, en haut du mât
        pastille.scale.set(BORNE_PASTILLE, BORNE_PASTILLE, 1);
        pastille.renderOrder = 10;
        pastille.visible = false;                   // posée, puis montrée par desencombrerBornes
        b.groupe.add(pastille);
        return { s, x, y, pastille, niveau: -1, classe: classeBorne(s) };
    });
    // Les mâts : un segment par station, du sol à la pastille.
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(Math.max(b.stations.length, 1) * 6), 3));
    b.mats = new THREE.LineSegments(geo, MAT_MAT_BORNE);
    b.mats.frustumCulled = false;
    b.groupe.add(b.mats);
    groupeBornes.add(b.groupe);
    poserBornes(b);
}

/**
 * Chaque station sur le relief le plus fin déjà lu, reposée quand un plus
 * fin arrive ; loin de la route, aucun ne l'est peut-être : le niveau 11 du
 * RGE ALTI (une tuile de 11 km) est demandé pour le bloc.
 */
function poserBornes(b) {
    let bouge = false, sans = false;
    b.stations.forEach(st => {
        if (st.niveau >= NIVEAU_PROCHE) return;
        const [lon, lat] = depuisLambert93(st.x, st.y);
        for (let n = NIVEAU_PROCHE; n > Math.max(st.niveau, ALTI_NIVEAU_MIN - 1); n--) {
            const sol = altitude(lon, lat, n);
            if (!Number.isFinite(sol)) continue;
            st.sol = sol;
            st.pastille.position.set(st.x - b.cx, sol + BORNE_MAT_M, b.cy - st.y);
            st.niveau = n;
            bouge = true;
            break;
        }
        if (st.niveau < 0) sans = true;
    });
    if (bouge) dernierDesencombrement = -Infinity;
    if (sans && !b.altiDemandees) {
        b.altiDemandees = true;
        const coins = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) =>
            depuisLambert93((b.bi + u) * BORNES_BLOC_M, (b.bj + v) * BORNES_BLOC_M));
        const lons = coins.map(p => p[0]), lats = coins.map(p => p[1]);
        preparerAltitudes(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats), 11)
            .catch(() => { b.altiDemandees = false; });
    }
}

const distanceBloc = (b, x, y) => Math.hypot(Math.max(b.bi * BORNES_BLOC_M - x, 0, x - (b.bi + 1) * BORNES_BLOC_M),
                                             Math.max(b.bj * BORNES_BLOC_M - y, 0, y - (b.bj + 1) * BORNES_BLOC_M));

export function majBornes(maintenant) {
    if (!bornesActives || maintenant - dernierBornes < 1000) return;
    dernierBornes = maintenant;
    const v = voiture;
    if (!v.vue && (!v.attendu || v.attendu.provisoire)) return;
    const x = v.vue ? v.x : v.attendu.x, y = v.vue ? v.y : v.attendu.y;
    // Les blocs voulus, du plus près au plus loin : autour de la voiture,
    // puis sous la route prévue.
    const voulus = new Map();
    const vouloir = (bi, bj, d) => {
        const cle = `${bi}/${bj}`;
        if (!voulus.has(cle) || voulus.get(cle).d > d) voulus.set(cle, { bi, bj, d });
    };
    const M = BORNES_BLOC_M, R = BORNES_AUTOUR_M;
    for (let bi = Math.floor((x - R) / M); bi <= Math.floor((x + R) / M); bi++) {
        for (let bj = Math.floor((y - R) / M); bj <= Math.floor((y + R) / M); bj++) {
            const d = distanceBloc({ bi, bj }, x, y);
            if (d <= R) vouloir(bi, bj, d);
        }
    }
    const ch = v.chemin;
    if (ch && v.vue) {
        for (let d = v.dChemin; d <= ch.longueur; d += 500) {
            const p = pointDuChemin(ch, d);
            vouloir(Math.floor(p.x / M), Math.floor(p.y / M), d - v.dChemin);
        }
    }
    for (const { bi, bj } of [...voulus.values()].sort((a, b) => a.d - b.d)) {
        const cle = `${bi}/${bj}`;
        let b = blocsBornes.get(cle);
        if (!b) blocsBornes.set(cle, b = { bi, bj, etat: 'attente', reessai: 0 });
        if (bornesEnVol >= BORNES_PARALLELE) break;
        if (b.etat === 'attente' || (b.etat === 'erreur' && maintenant >= b.reessai)) chargerBlocBornes(b);
    }
    for (const [cle, b] of blocsBornes) {
        if (b.etat === 'charge') continue;
        if (distanceBloc(b, x, y) > BORNES_OUBLI_M) {
            if (b.groupe) {
                groupeBornes.remove(b.groupe);
                ancres.delete(b.groupe);
                b.mats.geometry.dispose();
            }
            blocsBornes.delete(cle);
        } else if (b.stations) {
            poserBornes(b);
        }
    }
}

// À Paris, 128 à 191 stations par bloc de 4 km : les bornes de 7 à 22 kW des
// parkings faisaient à l'horizon un ruban de pastilles, jusqu'à 3 km. Chacune
// a sa portée selon sa puissance — une borne lente ne sert qu'à l'arrivée,
// une rapide se cherche de loin —, et une pastille qui en recouvre une plus
// puissante, ou aussi puissante et plus proche, s'efface.
const BORNES_PORTEE_M = [600, 2000, 4000];   // jusqu'à 22 kW (ou inconnue), 23 à 149 kW, 150 kW et plus
const classeBorne = s => (s.puissance_max == null ? 0 : BORNES_CLASSES.findIndex(c => s.puissance_max <= c.max));
let dernierDesencombrement = -Infinity;
export function desencombrerBornes(maintenant) {
    if (!bornesActives || maintenant - dernierDesencombrement < 250) return;
    dernierDesencombrement = maintenant;
    const v = voiture;
    const x = v.vue ? v.x : v.attendu?.x, y = v.vue ? v.y : v.attendu?.y;
    if (x == null) return;
    camera.updateMatrixWorld();
    const hauteur = renderer.domElement.clientHeight, largeur = renderer.domElement.clientWidth;
    const taille = BORNE_PASTILLE / Math.tan(camera.fov / 2 * RAD) * hauteur / 2;
    const candidates = [];
    for (const b of blocsBornes.values()) {
        if (!b.stations) continue;
        for (const st of b.stations) {
            st.montree = false;
            if (st.niveau < 0) continue;
            st.d = Math.hypot(st.x - x, st.y - y);
            if (st.d > BORNES_PORTEE_M[st.classe]) continue;
            st.pastille.getWorldPosition(projete).project(camera);
            if (projete.z > 1 || Math.abs(projete.x) > 1.2 || Math.abs(projete.y) > 1.2) continue;
            st.sx = (projete.x + 1) / 2 * largeur;
            st.sy = (1 - projete.y) / 2 * hauteur - taille / 2;
            candidates.push(st);
        }
    }
    candidates.sort((a, b) => b.classe - a.classe || a.d - b.d);
    const grille = new Map();
    for (const st of candidates) {
        const gx = Math.floor(st.sx / taille), gy = Math.floor(st.sy / taille);
        let libre = true;
        for (let i = gx - 1; i <= gx + 1 && libre; i++) {
            for (let j = gy - 1; j <= gy + 1 && libre; j++) {
                for (const autre of grille.get(`${i},${j}`) || []) {
                    if (Math.hypot(autre.sx - st.sx, autre.sy - st.sy) < taille * 0.9) { libre = false; break; }
                }
            }
        }
        if (!libre) continue;
        st.montree = true;
        const cle = `${gx},${gy}`;
        (grille.get(cle) || grille.set(cle, []).get(cle)).push(st);
    }
    // Un mât sous chaque pastille montrée, et rien sous les autres.
    for (const b of blocsBornes.values()) {
        if (!b.stations) continue;
        const pos = b.mats.geometry.attributes.position;
        b.stations.forEach((st, k) => {
            st.pastille.visible = st.montree;
            const lx = st.x - b.cx, lz = b.cy - st.y, bas = st.montree ? st.sol : st.sol + BORNE_MAT_M;
            pos.setXYZ(2 * k, lx, st.niveau < 0 ? 0 : bas, lz);
            pos.setXYZ(2 * k + 1, lx, st.niveau < 0 ? 0 : st.sol + BORNE_MAT_M, lz);
        });
        pos.needsUpdate = true;
    }
}

const boutonBornes = document.getElementById('b-bornes');
const elCredits = document.getElementById('credits'), CREDITS = elCredits.textContent;
function majBoutonBornes() {
    boutonBornes.classList.toggle('on', bornesActives);
    elCredits.textContent = CREDITS + (bornesActives ? ' · bornes : base nationale des IRVE, data.gouv.fr' : '');
}
boutonBornes.addEventListener('click', () => {
    bornesActives = !bornesActives;
    try { localStorage.setItem(BORNES_CLE, bornesActives ? '1' : '0'); } catch (e) { /* stockage refusé : le choix vit le temps de la page */ }
    groupeBornes.visible = bornesActives;
    dernierBornes = -Infinity;
    if (!bornesActives) fermerBorne();
    majBoutonBornes();
});
majBoutonBornes();

// --- La fiche d'une borne, au toucher -----------------------------------------------------
const elBorne = document.getElementById('borne');
let fermetureBorne = null;
function fermerBorne() { elBorne.hidden = true; clearTimeout(fermetureBorne); }
elBorne.addEventListener('click', fermerBorne);
const kW = v => `${v.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} kW`;
// Hors du format date, la valeur telle quelle, échappée : `date_maj` vient de
// la base des IRVE sans contrôle, et passait en HTML (audit du 19 novembre 2026).
const dateFr = d => (/^\d{4}-\d{2}-\d{2}/.test(d || '') ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : echapperHtml(d || ''));

/** Qui l'exploite, combien de points, quelles prises, quel accès : la fiche de la page de la scène, et sa distance. */
function ficheBorne(st) {
    const s = st.s, v = voiture;
    const puissance = s.puissance_max == null ? 'puissance non déclarée'
        : s.puissance_min != null && s.puissance_min !== s.puissance_max
            ? `${kW(s.puissance_min)} à ${kW(s.puissance_max)}` : kW(s.puissance_max);
    const qui = [s.operateur, s.enseigne && s.enseigne !== s.operateur ? s.enseigne : null].filter(Boolean);
    const acces = [s.acces, s.horaires === '24/7' ? '24 h/24, 7 j/7' : s.horaires,
                   s.gratuit ? 'gratuite' : null].filter(Boolean);
    const d = v.vue ? Math.hypot(st.x - v.x, st.y - v.y) : null;
    const loin = d == null ? '' : d < 1000 ? ` · à ${Math.round(d / 10) * 10} m` : ` · à ${(d / 1000).toFixed(1).replace('.', ',')} km`;
    const teinte = '#' + couleurBorne(s).toString(16).padStart(6, '0');
    return `<span class="teinte" style="background:${teinte}"></span><b>${echapperHtml(s.nom)}</b>${loin}`
        + `<br>${qui.length ? qui.map(echapperHtml).join(' · ') : 'opérateur non déclaré'}`
        + `<br>${s.points} point${s.points > 1 ? 's' : ''} de charge · ${puissance}`
        + (s.prises.length ? `<br>prises : ${s.prises.map(echapperHtml).join(', ')}` : '')
        + (acces.length ? `<br>${acces.map(echapperHtml).join(' · ')}` : '')
        + (s.maj ? `<br><i>mise à jour le ${dateFr(s.maj)} · base nationale des IRVE</i>` : '');
}

/** La pastille la plus proche du doigt, à BORNE_TOUCHER_PX près ; null sinon. */
const projete = new THREE.Vector3();
function borneSous(px, py) {
    const r = renderer.domElement.getBoundingClientRect();
    // Le centre de la pastille, posée par le bas : une demi-hauteur au-dessus de son pied.
    const demi = BORNE_PASTILLE / Math.tan(camera.fov / 2 * RAD) / 2 * r.height / 2;
    let meilleure = null, dMin = BORNE_TOUCHER_PX;
    for (const b of blocsBornes.values()) {
        if (!b.stations) continue;
        for (const st of b.stations) {
            if (!st.pastille.visible) continue;
            st.pastille.getWorldPosition(projete).project(camera);
            if (projete.z > 1) continue;            // derrière la caméra
            const sx = r.left + (projete.x + 1) / 2 * r.width, sy = r.top + (1 - projete.y) / 2 * r.height - demi;
            const d = Math.hypot(sx - px, sy - py);
            if (d < dMin) { dMin = d; meilleure = st; }
        }
    }
    return meilleure;
}

// Un toucher, pas un glissé : la caméra se tourne au doigt.
let appuiBorne = null;
hote.addEventListener('pointerdown', e => { appuiBorne = { x: e.clientX, y: e.clientY, t: performance.now() }; });
hote.addEventListener('pointerup', e => {
    const a = appuiBorne;
    appuiBorne = null;
    if (!a || !bornesActives || Math.hypot(e.clientX - a.x, e.clientY - a.y) > 10 || performance.now() - a.t > 500) return;
    const st = borneSous(e.clientX, e.clientY);
    if (!st) { fermerBorne(); return; }
    elBorne.innerHTML = ficheBorne(st);
    elBorne.hidden = false;
    clearTimeout(fermetureBorne);
    fermetureBorne = setTimeout(fermerBorne, 20000);
});
