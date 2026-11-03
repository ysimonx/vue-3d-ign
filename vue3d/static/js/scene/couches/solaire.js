// L'ensoleillement des toits : l'année type de PVGIS, et l'ombre de tout ce
// que la scène dessine, cumulées sur le GPU.

import * as THREE from 'three';
import { URL_SOLAIRE } from '../socle/reseau.js';
import { renderer, scene } from '../socle/rendu.js';
import { exagVert } from '../terrain/etat.js';
import { apresLaPhotoDesToits, appliquerTextureToits } from '../terrain/fond.js';
import { meshesToits, DECALAGE_DESSUS } from '../batiments/etat.js';
import { groupeVegetation, vegReglee } from '../vegetation/etat.js';
import { positionSoleil } from '../geometrie/astronomie.js';
import { portDe } from '../vegetation/formes.js';
import { etatCouche } from '../interface/etat-couche.js';
import { citerSource, majCredits } from '../interface/credits.js';
import { lireALaDemande, dateLongue } from './foncier.js';
import { ficheUd, afficherFicheBatiment, ajouterSectionFiche } from '../interface/fiche.js';

// Une couche à part (/api/solaire ; vue3d/solaire.py), lue au premier clic sur
// son bouton, comme les DPE : l'année type de PVGIS, le rayonnement direct et
// diffus de chacune de ses 8 760 heures. PVGIS y a déjà éteint le direct quand
// le soleil passe derrière le relief lointain. Le reste de l'ombre est celle
// de la scène telle qu'elle est dessinée — bâtiments, toits mesurés, arbres,
// relief et anneau jusqu'à RECUL_SOLEIL_M — et se calcule ici, sur le GPU.
//
// Le ciel. Le direct, et la part du diffus qui vient des abords du soleil,
// arrivent de sa direction ; le reste du diffus, du ciel entier, réparti
// selon Muneer, le modèle de PVGIS. Choisi contre PVcalc de PVGIS
// (rayonnement annuel dans le plan, horizon compris), sur des plans dégagés
// de pente 0 à 60° et huit orientations, à Gordes, à la tour Eiffel et à
// Chamonix, le 31 octobre 2026, avec le global horizontal de l'année type
// ramené à la moyenne 2005-2023 de PVcalc (dont il s'écarte de −3,3 à
// +5,4 %) :
//
//   écart maximal       ciel isotrope 8,5 %   Hay-Davies 8,9 %   Muneer 3,9 %
//
// Le code de cette page, sur neuf plans et quatre lieux, Strasbourg en plus
// (node outils/verifier-solaire.mjs) : 3,0 % au plus sur un plan favorable
// (un pan sud à 45° de Gordes), 6,1 % sur un pan nord à 60° de Paris, qui
// reçoit 515 kWh/m²/an ; jamais plus de 2,9 % du meilleur plan du lieu.
//
// Le calcul. Une grille des toits vus du ciel, à la maille du MNH dont ils
// sont tirés (PAS_M), garde pour chaque cellule le toit le plus haut, sa
// normale et son altitude. Puis, pour chaque direction du soleil et du ciel,
// une carte d'ombre de toute la scène, et la grille cumule ce qui l'atteint.
// Le diffus du ciel est celui d'un toit dégagé de même pente et orientation
// (TABLE), multiplié par la part du ciel que le toit voit, pondérée par
// l'incidence, sur CIEL directions.

const RAD = Math.PI / 180;
// Les heures de soleil de l'année type, regroupées par case de PAS_SOLEIL_DEG
// d'azimut et de hauteur : 222 cases à la tour Eiffel, 259 à Gordes, chacune
// une carte d'ombre. La direction d'une case est la moyenne de ses heures
// pondérée par leur rayonnement : sur un toit dégagé, l'incidence en est
// exacte ; seule l'ombre est floue, d'au plus 2,5°. Les cases de moins de 0,1 %
// du total y portent encore 1 à 2 % du rayonnement : toutes sont gardées.
const PAS_SOLEIL_DEG = 5;
// Les directions du ciel, par couronne : [hauteur, nombre], couronnes de 12°
// (6° la dernière, de 84 à 90°), à peu près un angle solide par direction —
// 76 directions, la moitié du découpage de Tregenza, assez pour un diffus qui
// varie lentement d'un toit à l'autre. BORDS_CIEL : les limites des couronnes.
const CIEL = [[6, 16], [18, 15], [30, 14], [42, 12], [54, 9], [66, 6], [78, 3], [87, 1]];
const BORDS_CIEL = [0, 12, 24, 36, 48, 60, 72, 84, 90];
const ALBEDO = 0.2;
// Les arbres ne sont pas des murs. Un houppier laisse passer 1,3 à 5,3 % du
// soleil direct en feuilles, 40,2 à 51,9 % sans feuilles (Konarska et al.,
// 2014, arbres de rue de Göteborg ; SOLWEIG en garde 3 % en feuilles). Un
// pin, un résineux ou un chêne vert (portDe) garde les siennes ; un feuillu
// les porte du JOUR_FEUILLES au JOUR_CHUTE : débourrement du chêne pédonculé
// le 8 avril, jaunissement le 25 octobre (RENECOFOR, INRAE, 1997-2003). Hors
// massif de la BD Forêt, l'essence est inconnue et le port vient du profil
// mesuré : un chêne vert en dôme y passe pour un feuillu.
//
// Mesuré contre des arbres opaques toute l'année (node
// outils/mesure-solaire.mjs, zones de 1 000 m, 3 novembre 2026) : la part
// perdue à l'ombre ne baisse que de 0,1 à 0,2 point (8,7 à 8,5 % à Gordes,
// 17,3 à 17,2 % à Strasbourg, 13,1 à 13,0 % à la tour Eiffel) — l'hiver
// pèse peu dans l'année, et le bâti cache déjà le soleil bas. Le gain va aux
// toits sous des feuillus : 46 sur 1 390 gagnent 1 % ou plus, jusqu'à 14 %
// pour un petit bâtiment du Champ-de-Mars, 5,6 % pour un toit de 46 m² à
// Strasbourg. Le prix : les houppiers dans une seconde carte d'ombre, et 13
// à 14 % de directions du soleil en plus.
const TRANSMISSION_FEUILLES = 0.03;
const TRANSMISSION_SANS_FEUILLES = 0.46;
const JOUR_FEUILLES = 98, JOUR_CHUTE = 298;
// La maille de la grille des toits : celle du MNH, plus grossière seulement
// au-delà de TAILLE_MAX cellules de côté (zone de 2 000 m).
const PAS_M = 0.5;
const TAILLE_MAX = 4096;
// Les cartes d'ombre : 4 096 texels sur la diagonale d'une zone de 1 000 m,
// 0,35 m chacun, sous la maille des toits.
const TAILLE_OMBRE = 4096;
// Jusqu'où, vers le soleil, un obstacle compte : l'anneau de relief, autour
// de la scène, en est. Au-delà, l'horizon de PVGIS.
const RECUL_SOLEIL_M = 4000;
// Biais de la comparaison des profondeurs, en mètres : les obstacles y sont
// rendus par leurs faces arrière, celles qui regardent à l'opposé du soleil.
// Le toit éclairé n'est donc jamais dans la carte, qui garde la sortie de
// l'obstacle, plus loin du soleil que lui : pas d'acné à combattre par un
// grand biais, qui effacerait les petits obstacles.
const BIAIS_M = 0.05;
// Cartes d'ombre par image : la vue reste fluide, et le calcul n'en dure
// guère plus — 1,7 s à Gordes en zone de 1 000 m, 1,4 s tout d'un bloc
// (mesuré avant la carte des houppiers, qui porte le calcul à 2,4 s).
const PASSES_PAR_IMAGE = 4;

// Favorable : au moins PART_FAVORABLE du meilleur plan dégagé du lieu, et non
// un seuil fixe — 1 000 kWh/m²/an, c'est le nord du pays au plus beau, le
// Midi à l'ombre. Le modèle ci-dessus, plans dégagés (part de l'optimum) :
//
//                       à plat   pente 15°           pente 30°           pente 45°
//                                est-ouest   nord    est-ouest   nord    est-ouest   nord
//   Gordes               0,80    0,79-0,80   0,65    0,76-0,77   0,51    0,72-0,74   0,39
//   tour Eiffel          0,86    0,84        0,73    0,81-0,82   0,60    0,76-0,77   0,48
//   Chamonix             0,87    0,82-0,88   0,75    0,75-0,86   0,61    0,69-0,81   0,48
//
// À 70 %, un pan est ou ouest jusqu'à 45° reste favorable partout, un pan
// nord de 30° nulle part ; un pan nord de 15° l'est au nord du pays, pas au
// sud, où le soleil vient davantage en direct.
const PART_FAVORABLE = 0.7;
// Production : la puissance posée sur la surface favorable, à COUVERTURE
// (bords, cheminées, lucarnes : une convention, pas une mesure) et à
// KWC_PAR_M2 de panneaux (un module à 21 % de rendement), multipliée par le
// rayonnement reçu et RENDEMENT_SYSTEME : le rapport de la production au
// rayonnement de PVcalc, pertes de 14 %, de 0,776 à 0,822 sur les plans
// favorables de Gordes, de la tour Eiffel et de Chamonix.
const COUVERTURE = 0.7;
const KWC_PAR_M2 = 0.21;
const RENDEMENT_SYSTEME = 0.79;
// La palette : une rampe d'une seule teinte chaude, d'un brun sombre (peu de
// soleil) au jaune pâle (le meilleur plan du lieu), clarté croissante en
// OKLCH (0,30 à 0,93). Elle part de PALETTE_BAS de l'optimum, au-dessous de
// quoi tout est brun : à Gordes, la moitié des cellules de toit reçoit de 64
// à 82 % de l'optimum, et neuf sur dix moins de 90 % (node
// outils/mesure-solaire.mjs) ; une rampe partie de 30 % les peignait toutes
// du même orange.
const PALETTE = ['#4f1c01', '#723607', '#975104', '#bb710c', '#de9215', '#fdb72e', '#fee5b3'];
const PALETTE_BAS = 0.5;

const JOURS_DES_MOIS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// Les pentes (0 à 90° par 5°) et orientations (par 10°) de la table du diffus.
const TABLE_PENTES = 19, TABLE_ORIENTATIONS = 36;

let CLIMAT = null;          // la couche de PVGIS
let CIEL_LIEU = null;       // ce qu'on en tire (preparerCiel)
let RESULTAT = null;        // le dernier calcul (calculer)
let solaireActif = false;
let jetonCalcul = 0;
citerSource('solaire', () => solaireActif);

/** Direction de la scène (x vers l'est, y vers le haut, z vers le sud). */
function direction(azimut, hauteur) {
    const c = Math.cos(hauteur * RAD);
    return new THREE.Vector3(Math.sin(azimut * RAD) * c, Math.sin(hauteur * RAD), -Math.cos(azimut * RAD) * c);
}

/** Normale d'un plan de pente `pente` qui regarde vers `orientation` (degrés depuis le nord). */
function normalePlan(pente, orientation) {
    return direction(orientation, 90 - pente);
}

/**
 * Ce que l'année type donne au calcul : les directions du soleil et leur
 * poids, celles du ciel, la table du diffus d'un plan dégagé, et le meilleur
 * plan dégagé du lieu. Les rayonnements sont en Wh/m² sur l'année.
 */
export function preparerCiel(c) {
    const cases = new Map();
    const table = new Float64Array(TABLE_PENTES * TABLE_ORIENTATIONS);
    const normales = [], isotropes = [], plis = [];
    for (let j = 0; j < TABLE_PENTES; j++) {
        const b = 5 * j * RAD;
        isotropes.push((1 + Math.cos(b)) / 2);
        plis.push(Math.sin(b) - b * Math.cos(b) - Math.PI * Math.sin(b / 2) ** 2);
        for (let i = 0; i < TABLE_ORIENTATIONS; i++) normales.push(normalePlan(5 * j, 10 * i));
    }
    let k = 0, jourAn = 0, global = 0, direct = 0, diffus = 0, diffusFeuilles = 0;
    for (let mois = 1; mois <= 12; mois++) {
        for (let jour = 1; jour <= JOURS_DES_MOIS[mois - 1]; jour++) {
            jourAn++;
            const I0 = 1361 * (1 + 0.033 * Math.cos(2 * Math.PI * jourAn / 365));
            const feuilles = jourAn >= JOUR_FEUILLES && jourAn <= JOUR_CHUTE;
            for (let heure = 0; heure < 24; heure++, k++) {
                const B = c.direct_normal[k], Dh = c.diffus_horizontal[k];
                global += c.global_horizontal[k]; direct += B; diffus += Dh;
                if (feuilles) diffusFeuilles += Dh;
                if (B <= 0 && Dh <= 0) continue;
                const instant = new Date(Date.UTC(c.annees[mois - 1], mois - 1, jour, heure)
                                         + c.decalage_h * 3600e3);
                const { azimut, hauteur } = positionSoleil(instant, c.lat, c.lon);
                const s = direction(azimut, hauteur);
                // Muneer : Kb, la part du direct dans le rayonnement hors
                // atmosphère, dit la clarté du ciel.
                const Kb = hauteur > 0 ? Math.min(B / I0, 1) : 0;
                if (hauteur > 0) {
                    const w = B + Dh * Kb / (hauteur >= 5.7 ? Math.sin(hauteur * RAD) : 0.1 - 0.008 * hauteur);
                    if (w > 0) {
                        // Une même position du soleil revient au printemps,
                        // feuillus nus, et à l'automne, en feuilles : deux cases.
                        const cle = (Math.floor(azimut / PAS_SOLEIL_DEG) * 100 + Math.floor(hauteur / PAS_SOLEIL_DEG)) * 2
                                  + (feuilles ? 1 : 0);
                        const v = cases.get(cle) || cases.set(cle, new THREE.Vector3()).get(cle);
                        v.addScaledVector(s, w);
                    }
                }
                if (Dh > 0) {
                    const N = 0.00263 - 0.712 * Kb - 0.6883 * Kb * Kb;
                    for (let j = 0, m = 0; j < TABLE_PENTES; j++) {
                        for (let i = 0; i < TABLE_ORIENTATIONS; i++, m++) {
                            const eclaire = hauteur > 0 && normales[m].dot(s) > 0;
                            table[m] += eclaire ? Dh * (1 - Kb) * (isotropes[j] + N * plis[j])
                                                : Dh * (isotropes[j] + 0.25227 * plis[j]);
                        }
                    }
                }
            }
        }
    }
    const faisceaux = [...cases].map(([cle, v]) => ({ d: v.clone().normalize(), w: v.length(), feuilles: cle % 2 === 1 }));
    const ciel = [];
    CIEL.forEach(([h, n], r) => {
        const angle = 2 * Math.PI * (Math.sin(BORDS_CIEL[r + 1] * RAD) - Math.sin(BORDS_CIEL[r] * RAD)) / n;
        // Couronnes décalées d'une demi-case l'une sur l'autre.
        for (let i = 0; i < n; i++) ciel.push({ d: direction((i + (r % 2) / 2) * 360 / n, h), w: angle });
    });
    // Le ciel vient de toutes les saisons : un feuillu y laisse passer la
    // moyenne de ses deux états, pondérée par le diffus de chacune.
    const transmissionCiel = (diffusFeuilles * TRANSMISSION_FEUILLES
                              + (diffus - diffusFeuilles) * TRANSMISSION_SANS_FEUILLES) / (diffus || 1);
    const lieu = { faisceaux, ciel, table, global, direct, diffus, transmissionCiel };
    // Le meilleur plan dégagé : la référence du « favorable » et de la palette.
    let optimum = { e: 0 };
    for (let pente = 0; pente <= 60; pente += 5) {
        for (let orientation = 0; orientation < 360; orientation += 10) {
            const e = planDegage(lieu, pente, orientation);
            if (e > optimum.e) optimum = { e, pente, orientation };
        }
    }
    lieu.optimum = optimum;
    return lieu;
}

/** Rayonnement annuel d'un plan dégagé, en kWh/m² : l'unité du calcul sur le GPU. */
export function planDegage(lieu, pente, orientation) {
    const n = normalePlan(pente, orientation);
    let e = 0;
    for (const f of lieu.faisceaux) e += f.w * Math.max(0, n.dot(f.d));
    return (e + diffusTable(lieu.table, pente, orientation) + ALBEDO * lieu.global * (1 - n.y) / 2) / 1000;
}

/** Le diffus du ciel d'un plan dégagé, en Wh/m², lu dans la table (bilinéaire). */
function diffusTable(table, pente, orientation) {
    const fb = Math.min(Math.max(pente / 5, 0), TABLE_PENTES - 1);
    const j0 = Math.min(Math.floor(fb), TABLE_PENTES - 2), tb = fb - j0;
    const fo = ((orientation % 360) + 360) % 360 / 10;
    const i0 = Math.floor(fo) % TABLE_ORIENTATIONS, i1 = (i0 + 1) % TABLE_ORIENTATIONS, to = fo - Math.floor(fo);
    const v = (j, i) => table[j * TABLE_ORIENTATIONS + i];
    return (v(j0, i0) * (1 - to) + v(j0, i1) * to) * (1 - tb) + (v(j0 + 1, i0) * (1 - to) + v(j0 + 1, i1) * to) * tb;
}

// --- Le calcul sur le GPU ------------------------------------------------------

const QUAD = new THREE.PlaneGeometry(2, 2);
const SOMMET_QUAD = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';

// La grille des toits : chaque toit dessiné à plat, vu du ciel, son altitude
// en profondeur pour que le plus haut l'emporte. Normale (x, z), altitude,
// rang du toit (0 : pas de toit).
const MAT_GRILLE = new THREE.ShaderMaterial({
    uniforms: { emprise: { value: new THREE.Vector4() }, altitudes: { value: new THREE.Vector2() },
                rang: { value: 0 } },
    vertexShader: `
        uniform vec4 emprise;
        uniform vec2 altitudes;
        varying vec3 vNormale;
        varying float vY;
        void main() {
            vec4 p = modelMatrix * vec4(position, 1.0);
            vNormale = mat3(modelMatrix) * normal;
            vY = p.y;
            gl_Position = vec4((p.x - emprise.x) * emprise.z * 2.0 - 1.0, (p.z - emprise.y) * emprise.w * 2.0 - 1.0,
                               1.0 - 2.0 * (p.y - altitudes.x) * altitudes.y, 1.0);
        }`,
    fragmentShader: `
        uniform float rang;
        varying vec3 vNormale;
        varying float vY;
        void main() {
            // Un triangle dégénéré n'a pas de normale : il ne compte pas.
            float l = length(vNormale);
            if (!(l > 1e-6)) discard;
            vec3 n = vNormale / l;
            if (n.y < 0.0) n = -n;
            gl_FragColor = vec4(n.x, n.z, vY, rang);
        }`,
    side: THREE.DoubleSide,
});

// Les obstacles, par leurs faces arrière (BIAIS_M) : le bâti, le relief, les
// masses et les troncs dans une carte, opaques ; les houppiers dans une autre,
// chacun avec son feuillage (1 persistant, 0 caduc), qui dit ce qu'il laisse
// passer. Deux cartes : un arbre devant un mur ne doit pas éclairer ce qu'il
// cache.
const MAT_OBSTACLE = new THREE.MeshBasicMaterial({ side: THREE.BackSide, colorWrite: false });
const MAT_HOUPPIER = new THREE.ShaderMaterial({
    vertexShader: `
        attribute float persistant;
        varying float vPersistant;
        void main() {
            vPersistant = persistant;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
    fragmentShader: `
        varying float vPersistant;
        void main() { gl_FragColor = vec4(vPersistant, 0.0, 0.0, 1.0); }`,
    side: THREE.BackSide,
});

// Une direction de plus dans le cumul : R le soleil, G le ciel vu, B le ciel
// d'un toit dégagé, A le soleil d'un toit dégagé, chacun pondéré par
// l'incidence.
const MAT_CUMUL = new THREE.ShaderMaterial({
    uniforms: {
        grille: { value: null }, precedent: { value: null }, ombre: { value: null },
        ombreArbres: { value: null }, feuillage: { value: null },
        transmissionCaduc: { value: 1 }, transmissionPersistant: { value: 1 },
        matriceOmbre: { value: new THREE.Matrix4() }, dir: { value: new THREE.Vector3() },
        poidsSoleil: { value: 0 }, poidsCiel: { value: 0 }, biais: { value: 0 },
        emprise: { value: new THREE.Vector4() }, tailleOmbre: { value: 1 }, premiere: { value: 0 },
    },
    vertexShader: SOMMET_QUAD,
    fragmentShader: `
        precision highp float;
        uniform sampler2D grille, precedent, ombre, ombreArbres, feuillage;
        uniform mat4 matriceOmbre;
        uniform vec3 dir;
        uniform float poidsSoleil, poidsCiel, biais, tailleOmbre, premiere;
        uniform float transmissionCaduc, transmissionPersistant;
        uniform vec4 emprise;
        // La part du rayon qui passe à un texel : rien derrière le bâti,
        // ce que laisse un houppier derrière un arbre, tout sinon.
        float passe(ivec2 t, float z) {
            t = clamp(t, ivec2(0), ivec2(int(tailleOmbre) - 1));
            float bati = step(z, texelFetch(ombre, t, 0).r);
            float libre = step(z, texelFetch(ombreArbres, t, 0).r);
            float transmis = mix(transmissionCaduc, transmissionPersistant, texelFetch(feuillage, t, 0).r);
            return bati * mix(transmis, 1.0, libre);
        }
        void main() {
            ivec2 px = ivec2(gl_FragCoord.xy);
            vec4 g = texelFetch(grille, px, 0);
            // La première passe part de zéro : le cumul n'a pas à être effacé.
            vec4 avant = premiere > 0.5 ? vec4(0.0) : texelFetch(precedent, px, 0);
            vec3 n = vec3(g.x, sqrt(max(0.0, 1.0 - g.x * g.x - g.y * g.y)), g.y);
            float ci = dot(n, dir);
            if (g.w < 0.5 || ci <= 0.0) { gl_FragColor = avant; return; }
            vec2 xz = emprise.xy + gl_FragCoord.xy / vec2(textureSize(grille, 0)) / emprise.zw;
            vec4 c = matriceOmbre * vec4(xz.x, g.z, xz.y, 1.0);
            vec3 s = c.xyz / c.w * 0.5 + 0.5;
            // Quatre texels, pondérés comme une lecture bilinéaire : l'ombre
            // d'un bord se dégrade sur un texel au lieu de crénelage.
            vec2 t = s.xy * tailleOmbre - 0.5;
            vec2 f = fract(t);
            ivec2 b = ivec2(floor(t));
            float z = s.z - biais;
            float vu = mix(mix(passe(b, z), passe(b + ivec2(1, 0), z), f.x),
                           mix(passe(b + ivec2(0, 1), z), passe(b + ivec2(1, 1), z), f.x), f.y);
            gl_FragColor = avant + vec4(poidsSoleil * ci * vu, poidsCiel * ci * vu, poidsCiel * ci, poidsSoleil * ci);
        }`,
    depthTest: false, depthWrite: false,
});

// Le cumul en kWh/m²/an : soleil, plus le diffus d'un toit dégagé de même pente
// et orientation multiplié par la part du ciel vue, plus le sol. Avec la
// surface réelle d'une cellule (1/ny), le rang du toit, et ce que la cellule
// recevrait sans aucune ombre.
const MAT_FIN = new THREE.ShaderMaterial({
    uniforms: { grille: { value: null }, cumul: { value: null }, table: { value: null }, sol: { value: 0 } },
    vertexShader: SOMMET_QUAD,
    fragmentShader: `
        precision highp float;
        uniform sampler2D grille, cumul, table;
        uniform float sol;
        float lire(int j, int i) { return texelFetch(table, ivec2(i, j), 0).r; }
        void main() {
            ivec2 px = ivec2(gl_FragCoord.xy);
            vec4 g = texelFetch(grille, px, 0);
            if (g.w < 0.5) { gl_FragColor = vec4(0.0); return; }
            vec4 a = texelFetch(cumul, px, 0);
            float ny = sqrt(max(0.0, 1.0 - g.x * g.x - g.y * g.y));
            float pente = degrees(acos(clamp(ny, 0.0, 1.0)));
            float orientation = mod(degrees(atan(g.x, -g.y)) + 360.0, 360.0);
            float fb = clamp(pente / 5.0, 0.0, ${TABLE_PENTES - 1}.0);
            int j0 = min(int(fb), ${TABLE_PENTES - 2});
            float tb = fb - float(j0);
            float fo = orientation / 10.0;
            int i0 = int(fo) % ${TABLE_ORIENTATIONS};
            int i1 = (i0 + 1) % ${TABLE_ORIENTATIONS};
            float to = fract(fo);
            float degage = mix(mix(lire(j0, i0), lire(j0, i1), to), mix(lire(j0 + 1, i0), lire(j0 + 1, i1), to), tb);
            float vu = a.b > 0.0 ? a.g / a.b : 1.0;
            float reflechi = sol * (1.0 - ny) * 0.5;
            gl_FragColor = vec4((a.r + degage * vu + reflechi) / 1000.0, 1.0 / max(ny, 0.05), g.w,
                                (a.a + degage + reflechi) / 1000.0);
        }`,
    depthTest: false, depthWrite: false,
});

/**
 * Les maillages qui portent une ombre : ceux de la vue, et toujours les
 * arbres. { bati, houppiers } : les houppiers à part, les masses et les
 * troncs avec le bâti.
 */
function obstacles() {
    const bati = [], houppiers = [];
    const parcourir = (o, vu, arbres) => {
        // Les repères des bornes, et les formes simples des arbres en
        // mouvement, qui doublent les détaillées.
        if (o.userData.bornes || o.userData.source) return;
        arbres = arbres || o === groupeVegetation;
        vu = arbres || (vu && o.visible);
        if (o.isMesh && o.castShadow && vu) (o.userData.genre === 'houppier' ? houppiers : bati).push(o);
        for (const c of o.children) parcourir(c, vu, arbres);
    };
    parcourir(scene, true, false);
    return { bati, houppiers };
}

/** Feuillage persistant : pin, résineux, chêne vert ; le mélèze perd ses aiguilles. */
const persistant = el => !/mélèze|meleze/i.test(el.essence || '') && ['pin', 'conifère', 'chêne vert'].includes(portDe(el).nom);

// La géométrie d'un maillage de houppiers, sommets et faces partagés, avec le
// feuillage de chaque sommet : celui de son arbre (vegetation/formes,
// nouveauTampon : `elements`, l'arbre de chaque sommet). Gardée tant que le
// maillage ne change pas.
const geometriesFeuillage = new WeakMap();
function geometrieFeuillage(mesh) {
    const source = mesh.geometry;
    let g = geometriesFeuillage.get(source);
    if (g) return g;
    const quel = source.userData.elements, arbres = mesh.userData.elements;
    const feuillage = new Float32Array(source.attributes.position.count);
    for (let i = 0; i < feuillage.length; i++) feuillage[i] = persistant(arbres[quel[i]]) ? 1 : 0;
    g = new THREE.BufferGeometry();
    g.setIndex(source.index);
    g.setAttribute('position', source.attributes.position);
    g.setAttribute('persistant', new THREE.BufferAttribute(feuillage, 1));
    g.boundingSphere = source.boundingSphere;
    geometriesFeuillage.set(source, g);
    return g;
}

/** Une copie qui partage la géométrie de `o` (et ses instances), posée comme lui. */
function doublure(o, materiau) {
    const d = o.isInstancedMesh ? new THREE.InstancedMesh(o.geometry, materiau, o.count) : new THREE.Mesh(o.geometry, materiau);
    if (o.isInstancedMesh) { d.instanceMatrix = o.instanceMatrix; d.count = o.count; }
    d.matrixAutoUpdate = false;
    d.matrix.copy(o.matrixWorld);
    return d;
}


/**
 * L'ensoleillement de chaque cellule de toit, en kWh/m²/an, et ce qu'on en
 * tire par bâtiment. `avancer(part)` suit le calcul ; rend null s'il a été
 * remplacé par un autre (jeton).
 */
async function calculer(lieu, jeton, avancer) {
    scene.updateMatrixWorld();
    const toits = meshesToits.filter(t => t.geometry.attributes.normal);
    if (!toits.length) return { vide: true };
    const boite = new THREE.Box3();
    for (const t of toits) boite.expandByObject(t);
    const pas = Math.max(PAS_M, (boite.max.x - boite.min.x + 2) / TAILLE_MAX, (boite.max.z - boite.min.z + 2) / TAILLE_MAX);
    const W = Math.ceil((boite.max.x - boite.min.x + 2) / pas), H = Math.ceil((boite.max.z - boite.min.z + 2) / pas);
    const x0 = boite.min.x - 1, z0 = boite.min.z - 1;
    const emprise = new THREE.Vector4(x0, z0, 1 / (W * pas), 1 / (H * pas));
    const tailleOmbre = Math.min(TAILLE_OMBRE, renderer.capabilities.maxTextureSize);

    const cible = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter,
                    magFilter: THREE.NearestFilter, generateMipmaps: false, depthBuffer: false };
    const rtGrille = new THREE.WebGLRenderTarget(W, H, { ...cible, depthBuffer: true });
    const rtCumul = [new THREE.WebGLRenderTarget(W, H, cible), new THREE.WebGLRenderTarget(W, H, cible)];
    const rtOmbre = new THREE.WebGLRenderTarget(tailleOmbre, tailleOmbre, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false });
    rtOmbre.depthTexture = new THREE.DepthTexture(tailleOmbre, tailleOmbre, THREE.UnsignedIntType);
    const rtArbres = new THREE.WebGLRenderTarget(tailleOmbre, tailleOmbre, {
        format: THREE.RedFormat, type: THREE.UnsignedByteType, minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter, depthBuffer: true, generateMipmaps: false });
    rtArbres.depthTexture = new THREE.DepthTexture(tailleOmbre, tailleOmbre, THREE.UnsignedIntType);
    const camQuad = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const scQuad = new THREE.Scene();
    const quad = new THREE.Mesh(QUAD, MAT_CUMUL);
    quad.frustumCulled = false;
    scQuad.add(quad);
    const tableTexture = new THREE.DataTexture(new Float32Array(lieu.table), TABLE_ORIENTATIONS, TABLE_PENTES,
                                               THREE.RedFormat, THREE.FloatType);
    tableTexture.needsUpdate = true;

    const etatAvant = { cible: renderer.getRenderTarget(), couleur: renderer.getClearColor(new THREE.Color()),
                        alpha: renderer.getClearAlpha(), autoClear: renderer.autoClear };
    const rendre = (sc, cam, rt) => {
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0);
        renderer.autoClear = true;
        renderer.render(sc, cam);
    };
    const restaurer = () => {
        renderer.setRenderTarget(etatAvant.cible);
        renderer.setClearColor(etatAvant.couleur, etatAvant.alpha);
        renderer.autoClear = etatAvant.autoClear;
    };
    // Rendu à la vue avant chaque image : laissée sur une cible du calcul, la
    // boucle de la page y dessinait la scène entière. Le 31 octobre 2026, le
    // premier cumul en gardait les couleurs de la photo aérienne, une
    // direction du ciel de trop sur chaque cellule (77 comptées sur 76), et un
    // ciel « vu » plus grand que le ciel dégagé.
    const attendreImage = () => { restaurer(); return new Promise(r => requestAnimationFrame(r)); };
    const liberer = () => {
        for (const rt of [rtGrille, ...rtCumul, rtOmbre, rtArbres]) rt.dispose();
        rtOmbre.depthTexture.dispose();
        rtArbres.depthTexture.dispose();
        tableTexture.dispose();
    };

    try {
        // La grille des toits.
        const scGrille = new THREE.Scene();
        toits.forEach((t, i) => {
            const d = doublure(t, MAT_GRILLE);
            d.frustumCulled = false;
            d.onBeforeRender = () => { MAT_GRILLE.uniforms.rang.value = i + 1; MAT_GRILLE.uniformsNeedUpdate = true; };
            scGrille.add(d);
        });
        scGrille.updateMatrixWorld();
        MAT_GRILLE.uniforms.emprise.value.copy(emprise);
        MAT_GRILLE.uniforms.altitudes.value.set(boite.min.y - 1, 1 / (boite.max.y - boite.min.y + 2));
        rendre(scGrille, camQuad, rtGrille);

        // Les obstacles, et la caméra du soleil.
        const { bati, houppiers } = obstacles();
        const scObstacles = new THREE.Scene(), scArbres = new THREE.Scene();
        for (const o of bati) scObstacles.add(doublure(o, MAT_OBSTACLE));
        for (const o of houppiers) {
            const d = new THREE.Mesh(geometrieFeuillage(o), MAT_HOUPPIER);
            d.matrixAutoUpdate = false;
            d.matrix.copy(o.matrixWorld);
            scArbres.add(d);
        }
        scObstacles.updateMatrixWorld();
        scArbres.updateMatrixWorld();
        const camSoleil = new THREE.OrthographicCamera();
        const centre = boite.getCenter(new THREE.Vector3());
        const coins = [];
        for (const x of [boite.min.x, boite.max.x]) for (const y of [boite.min.y, boite.max.y])
            for (const z of [boite.min.z, boite.max.z]) coins.push(new THREE.Vector3(x, y, z));
        const v = new THREE.Vector3();

        const directions = [
            ...lieu.faisceaux.map(f => ({ d: f.d, soleil: f.w, ciel: 0,
                                          caduc: f.feuilles ? TRANSMISSION_FEUILLES : TRANSMISSION_SANS_FEUILLES })),
            ...lieu.ciel.map(c => ({ d: c.d, soleil: 0, ciel: c.w, caduc: lieu.transmissionCiel }))];
        let courant = 0;
        for (let k = 0; k < directions.length;) {
            await attendreImage();
            if (jeton !== jetonCalcul) return null;
            for (let n = 0; n < PASSES_PAR_IMAGE && k < directions.length; n++, k++) {
                const { d, soleil, ciel, caduc } = directions[k];
                camSoleil.position.copy(centre).addScaledVector(d, RECUL_SOLEIL_M);
                camSoleil.up.set(0, 1, 0);
                if (Math.abs(d.y) > 0.99) camSoleil.up.set(0, 0, -1);
                camSoleil.lookAt(centre);
                camSoleil.updateMatrixWorld();
                let l = Infinity, r = -Infinity, b = Infinity, h = -Infinity, loin = 0;
                for (const c of coins) {
                    v.copy(c).applyMatrix4(camSoleil.matrixWorldInverse);
                    l = Math.min(l, v.x); r = Math.max(r, v.x); b = Math.min(b, v.y); h = Math.max(h, v.y);
                    loin = Math.max(loin, -v.z);
                }
                Object.assign(camSoleil, { left: l - 2, right: r + 2, bottom: b - 2, top: h + 2, near: 1, far: loin + 10 });
                camSoleil.updateProjectionMatrix();
                rendre(scObstacles, camSoleil, rtOmbre);
                rendre(scArbres, camSoleil, rtArbres);

                const u = MAT_CUMUL.uniforms;
                u.grille.value = rtGrille.texture;
                u.precedent.value = rtCumul[courant].texture;
                u.ombre.value = rtOmbre.depthTexture;
                u.ombreArbres.value = rtArbres.depthTexture;
                u.feuillage.value = rtArbres.texture;
                u.transmissionCaduc.value = caduc;
                u.transmissionPersistant.value = TRANSMISSION_FEUILLES;
                u.matriceOmbre.value.multiplyMatrices(camSoleil.projectionMatrix, camSoleil.matrixWorldInverse);
                u.dir.value.copy(d);
                u.poidsSoleil.value = soleil;
                u.poidsCiel.value = ciel;
                u.biais.value = BIAIS_M / (camSoleil.far - camSoleil.near);
                u.emprise.value.copy(emprise);
                u.tailleOmbre.value = tailleOmbre;
                u.premiere.value = k === 0 ? 1 : 0;
                quad.material = MAT_CUMUL;
                courant = 1 - courant;
                rendre(scQuad, camQuad, rtCumul[courant]);
            }
            avancer(k / directions.length);
        }

        MAT_FIN.uniforms.grille.value = rtGrille.texture;
        MAT_FIN.uniforms.cumul.value = rtCumul[courant].texture;
        MAT_FIN.uniforms.table.value = tableTexture;
        MAT_FIN.uniforms.sol.value = ALBEDO * lieu.global;
        // Dans l'autre tampon du cumul, qui ne sert plus : 45 Mo de moins
        // sur le GPU à Gordes en zone de 1 000 m.
        quad.material = MAT_FIN;
        rendre(scQuad, camQuad, rtCumul[1 - courant]);
        const pixels = new Float32Array(W * H * 4);
        renderer.readRenderTargetPixels(rtCumul[1 - courant], 0, 0, W, H, pixels);
        return { W, H, pas, x0, z0, pixels, toits };
    } finally {
        restaurer();
        liberer();
    }
}

// --- Ce qu'on en tire ----------------------------------------------------------

const couleurs = PALETTE.map(h => new THREE.Color(h));
function couleur(part, sortie) {
    const t = Math.min(Math.max((part - PALETTE_BAS) / (1 - PALETTE_BAS), 0), 1) * (couleurs.length - 1);
    const k = Math.min(Math.floor(t), couleurs.length - 2);
    // Interpolée en sRGB, entre deux crans voisins de la rampe.
    const a = couleurs[k], b = couleurs[k + 1], f = t - k;
    sortie[0] = Math.round(255 * (a.r + (b.r - a.r) * f));
    sortie[1] = Math.round(255 * (a.g + (b.g - a.g) * f));
    sortie[2] = Math.round(255 * (a.b + (b.b - a.b) * f));
}

/** Les chiffres par bâtiment, la carte des toits, et la valeur de chaque cellule. */
function exploiter(brut, lieu) {
    const { W, H, pas, x0, z0, pixels, toits } = brut;
    const optimum = lieu.optimum.e;
    const seuil = PART_FAVORABLE * optimum;
    const valeurs = new Float32Array(W * H), sansOmbres = new Float32Array(W * H);
    const image = new Uint8Array(W * H * 4);
    const parBatiment = new Map();
    const total = { aire: 0, somme: 0, sansOmbre: 0, favorable: 0, sommeFavorable: 0, toits: 0 };
    const rgb = [0, 0, 0];
    for (let p = 0; p < W * H; p++) {
        const rang = pixels[4 * p + 2];
        if (rang < 0.5) continue;
        const e = pixels[4 * p], aire = pas * pas * pixels[4 * p + 1], sansOmbre = pixels[4 * p + 3];
        if (!(e >= 0 && aire > 0)) continue;
        valeurs[p] = e;
        sansOmbres[p] = sansOmbre;
        couleur(e / optimum, rgb);
        image[4 * p] = rgb[0]; image[4 * p + 1] = rgb[1]; image[4 * p + 2] = rgb[2]; image[4 * p + 3] = 255;
        const ud = toits[Math.round(rang) - 1].userData;
        const cle = ud.anneau || ud;
        let s = parBatiment.get(cle);
        if (!s) parBatiment.set(cle, s = { aire: 0, somme: 0, sansOmbre: 0, favorable: 0, sommeFavorable: 0, max: 0 });
        for (const t of [s, total]) {
            t.aire += aire; t.somme += e * aire; t.sansOmbre += sansOmbre * aire;
            if (e >= seuil) { t.favorable += aire; t.sommeFavorable += e * aire; }
        }
        s.max = Math.max(s.max, e);
    }
    total.toits = parBatiment.size;
    // Deux cellules de débord autour des toits, de la couleur voisine : le
    // filtrage de la texture ne mêle plus leur bord au noir d'à côté.
    for (let passe = 0; passe < 2; passe++) {
        const avant = image.slice();
        for (let j = 0; j < H; j++) {
            for (let i = 0; i < W; i++) {
                const p = j * W + i;
                if (avant[4 * p + 3]) continue;
                const q = i + 1 < W && avant[4 * p + 7] ? p + 1 : i > 0 && avant[4 * p - 1] ? p - 1
                    : j + 1 < H && avant[4 * (p + W) + 3] ? p + W : j > 0 && avant[4 * (p - W) + 3] ? p - W : -1;
                if (q < 0) continue;
                image[4 * p] = avant[4 * q]; image[4 * p + 1] = avant[4 * q + 1];
                image[4 * p + 2] = avant[4 * q + 2]; image[4 * p + 3] = 254;
            }
        }
    }
    const texture = new THREE.DataTexture(image, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    texture.needsUpdate = true;
    return { W, H, pas, x0, z0, valeurs, sansOmbres, parBatiment, total, texture, toits: new Set(toits) };
}

// La photo des toits est remplacée par la carte. Sa coordonnée de texture
// vient de la position (x, z) du sommet, sans toucher aux géométries, que la
// photo garde. La couleur est surtout émise : éclairée comme la photo, un pan
// nord était sombre de l'heure choisie autant que de son année, et la carte
// ne se lisait plus. Émise à 0,7, plus 0,11 de diffus sous un soleil de 2 et
// un ciel de 1,1 (socle/rendu) : un pan au soleil rend sa couleur à 1,05, à
// l'ombre à 0,82 — la forme du toit se lit encore.
const solOrigine = { value: new THREE.Vector2() }, solEchelle = { value: new THREE.Vector2() };
function materiauCarte(dessus) {
    const m = new THREE.MeshStandardMaterial({ color: 0x5c5c5c, emissive: 0xffffff, emissiveIntensity: 0.7,
                                               roughness: 0.9, metalness: 0, ...(dessus ? DECALAGE_DESSUS : {}) });
    m.onBeforeCompile = s => {
        s.uniforms.solOrigine = solOrigine;
        s.uniforms.solEchelle = solEchelle;
        s.vertexShader = 'uniform vec2 solOrigine;\nuniform vec2 solEchelle;\n' + s.vertexShader.replace(
            '#include <uv_vertex>',
            '#include <uv_vertex>\n vMapUv = ((modelMatrix * vec4(position, 1.0)).xz - solOrigine) * solEchelle;'
            + '\n vEmissiveMapUv = vMapUv;');
    };
    m.customProgramCacheKey = () => 'carte-solaire';
    return m;
}
const MAT_CARTE = materiauCarte(false), MAT_CARTE_DESSUS = materiauCarte(true);

function poserCarte() {
    if (!RESULTAT) return;
    const { W, H, pas, x0, z0, texture } = RESULTAT;
    solOrigine.value.set(x0, z0);
    solEchelle.value.set(1 / (W * pas), 1 / (H * pas));
    for (const m of [MAT_CARTE, MAT_CARTE_DESSUS]) {
        if (m.map !== texture) { m.map = m.emissiveMap = texture; m.needsUpdate = true; }
    }
    for (const t of meshesToits) t.material = t.userData.dessus ? MAT_CARTE_DESSUS : MAT_CARTE;
}

// Après la photo et les couleurs des DPE : la carte l'emporte sur les toits.
// Des toits nouveaux (monuments arrivés, bouton des toits) se recalculent.
apresLaPhotoDesToits(() => {
    if (!solaireActif || !RESULTAT) return;
    poserCarte();
    if (meshesToits.some(t => !RESULTAT.toits.has(t))) lancer();
});

// --- Interface -----------------------------------------------------------------

const bouton = document.getElementById('t-solaire');
const nombreFr = (v, chiffres = 0) => v.toLocaleString('fr-FR', { maximumFractionDigits: chiffres });
const stat = (libelle, valeur) => `<div class="stat"><span>${libelle}</span><b>${valeur}</b></div>`;
const ORIENTATIONS = ['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'];
const orientationFr = a => ORIENTATIONS[Math.round(a / 45) % 8];

/** Ce qu'un bâtiment peut produire, d'après la surface favorable de son toit. */
function production(s) {
    const kwc = s.favorable * COUVERTURE * KWC_PAR_M2;
    const moyenne = s.favorable ? s.sommeFavorable / s.favorable : 0;
    return { kwc, kwh: kwc * moyenne * RENDEMENT_SYSTEME };
}

function legende() {
    const o = CIEL_LIEU.optimum.e;
    const crans = [PALETTE_BAS, PART_FAVORABLE, 0.85, 1].map(p => ({ p, e: Math.round(p * o / 10) * 10 }));
    const pos = p => `${(100 * (p - PALETTE_BAS) / (1 - PALETTE_BAS)).toFixed(1)}%`;
    return `<div class="legende-solaire"><div class="barre-solaire" style="background:linear-gradient(to right, ${PALETTE.join(', ')})">`
        + `<i style="left:${pos(PART_FAVORABLE)}" title="favorable"></i></div>`
        + `<div class="crans-solaire">${crans.map(c => `<span style="left:${pos(c.p)}">${nombreFr(c.e)}</span>`).join('')}</div>`
        + `<div class="note">kWh/m²/an reçus par le toit ; le trait marque le seuil favorable, `
        + `${Math.round(100 * PART_FAVORABLE)} % du meilleur plan dégagé.</div></div>`;
}

function resumer() {
    const c = CLIMAT, l = CIEL_LIEU, t = RESULTAT && RESULTAT.total;
    const o = l.optimum;
    document.getElementById('solaire-resume').innerHTML = legende()
        + stat('rayonnement global, à plat', `${nombreFr(l.global / 1000)} kWh/m²/an`)
        + stat('meilleur plan dégagé', `${nombreFr(o.e)} kWh/m²/an`)
        + `<div class="note" style="margin-top:0">pente ${o.pente}°, orienté ${o.orientation}° (${orientationFr(o.orientation)})</div>`
        + (t ? stat('toits calculés', `${nombreFr(t.toits)}, ${nombreFr(t.aire)} m²`)
               + stat('surface favorable', `${nombreFr(t.favorable)} m² (${Math.round(100 * t.favorable / (t.aire || 1))} %)`)
               + stat('production possible', `${nombreFr(production(t).kwh / 1000)} MWh/an`)
             : '');
    document.getElementById('solaire-note').innerHTML =
        `Année type ${echapperTexte(c.source.rayonnement || 'PVGIS')} ${c.source.debut}-${c.source.fin}, lue le `
        + `${dateLongue(c.lu_le)} ; « Reconstruire la scène » la relit. Le direct et le diffus de chaque heure, `
        + 'ciel de Muneer comme PVGIS, dont un toit dégagé reste à 3 % près. L\'ombre est celle de la vue : '
        + 'bâtiments et toits tels que dessinés, relief jusqu\'à 4 km, et les arbres, qui laissent passer 3 % '
        + 'du soleil en feuilles, 46 % sans (les feuillus, du 26 octobre au 7 avril) ; au-delà, '
        + 'l\'horizon de PVGIS. Production : panneaux sur 70 % de la surface favorable, 0,21 kWc/m², '
        + 'rendement du système 0,79 — un ordre de grandeur, pas une étude. Clic sur un toit : sa fiche. '
        + '<a href="https://joint-research-centre.ec.europa.eu/photovoltaic-geographical-information-system-pvgis_fr" '
        + 'target="_blank" rel="noopener">PVGIS</a> © Union européenne.';
}
const echapperTexte = s => String(s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

/** La partie de la fiche d'un bâtiment : l'ensoleillement de son toit. */
ajouterSectionFiche(ud => {
    if (!solaireActif || !RESULTAT || !ud) return '';
    const s = RESULTAT.parBatiment.get(ud.anneau || ud);
    if (!s) return '<div class="sous-titre">Ensoleillement</div><div class="note">'
        + (ud.inconnue ? 'Bâtiment sous les arbres : son toit n\'est pas dessiné, son ensoleillement n\'est pas calculé.'
                       : 'Pas de toit calculé pour ce bâtiment.') + '</div>';
    const { kwc, kwh } = production(s);
    return '<div class="sous-titre">Ensoleillement du toit</div>'
        + stat('reçu en moyenne', `${nombreFr(s.somme / s.aire)} kWh/m²/an`)
        + stat('au mieux', `${nombreFr(s.max)} kWh/m²/an`)
        + stat('perdu à l\'ombre', `${Math.round(100 * (1 - s.somme / s.sansOmbre))} %`)
        + stat('surface du toit', `${nombreFr(s.aire)} m²`)
        + stat('surface favorable', `${nombreFr(s.favorable)} m² (${Math.round(100 * s.favorable / s.aire)} %)`)
        + (kwc >= 0.1 ? stat('puissance possible', `${nombreFr(kwc, 1)} kWc`)
                        + stat('production possible', `${nombreFr(Math.round(kwh / 10) * 10)} kWh/an`) : '')
        + `<div class="note">Favorable : au moins ${nombreFr(PART_FAVORABLE * CIEL_LIEU.optimum.e)} kWh/m²/an, `
        + `${Math.round(100 * PART_FAVORABLE)} % du meilleur plan dégagé du lieu. Surface en pente, mesurée sur le toit dessiné.</div>`;
});

/** La valeur sous le pointeur, pour l'infobulle d'un toit. */
export function ligneSolaire(touche) {
    if (!solaireActif || !RESULTAT || !touche || touche.object.name !== 'toit') return '';
    const { W, H, pas, x0, z0, valeurs } = RESULTAT;
    const i = Math.floor((touche.point.x - x0) / pas), j = Math.floor((touche.point.z - z0) / pas);
    const e = i >= 0 && j >= 0 && i < W && j < H ? valeurs[j * W + i] : 0;
    return e ? `<br>Soleil ici : <b>${nombreFr(Math.round(e / 10) * 10)} kWh/m²/an</b>` : '';
}

/** Le dernier calcul et le ciel du lieu, pour les outils de mesure (outils/). */
export function etatSolaire() { return { resultat: RESULTAT, ciel: CIEL_LIEU }; }

let jetonEtat = null;
function etat(texte, enCours = false) {
    clearTimeout(jetonEtat);
    etatCouche('etat-solaire', texte, enCours);
    if (texte && !enCours) jetonEtat = setTimeout(() => etatCouche('etat-solaire', null), 8000);
}

/** Le calcul, relancé si un autre l'a remplacé. */
async function lancer() {
    const jeton = ++jetonCalcul;
    if (exagVert !== 1) {
        etat('Ensoleillement : relief exagéré, l\'ombre serait fausse. Remettre l\'exagération à 1.');
        return;
    }
    if (!renderer.extensions.has('EXT_color_buffer_float')) {
        etat('Ensoleillement : ce navigateur ne sait pas rendre dans une texture flottante.');
        return;
    }
    // Les arbres portent l'ombre la plus fréquente sur un toit : on les attend.
    for (let attente = 0; !vegReglee && attente < 600; attente++) {
        etat('Ensoleillement : attente de la végétation…', true);
        await new Promise(r => setTimeout(r, 200));
        if (jeton !== jetonCalcul) return;
    }
    const debut = performance.now();
    etat('Ensoleillement : 0 %', true);
    const brut = await calculer(CIEL_LIEU, jeton,
                                part => etat(`Ensoleillement : ${Math.round(100 * part)} %`, true));
    if (!brut || jeton !== jetonCalcul) return;
    if (RESULTAT) RESULTAT.texture.dispose();
    RESULTAT = brut.vide ? null : exploiter(brut, CIEL_LIEU);
    etat(null);
    console.info(`Ensoleillement : ${(performance.now() - debut).toFixed(0)} ms, `
                 + `${CIEL_LIEU.faisceaux.length} + ${CIEL_LIEU.ciel.length} directions`
                 + (RESULTAT ? `, grille ${RESULTAT.W} × ${RESULTAT.H}` : ''));
    resumer();
    if (solaireActif) poserCarte();
    if (ficheUd) afficherFicheBatiment(ficheUd);
}

bouton.addEventListener('click', async () => {
    if (!CLIMAT) {
        if (bouton.dataset.lecture) return;
        bouton.dataset.lecture = '1';
        const couche = await lireALaDemande('Ensoleillement', 'de PVGIS', URL_SOLAIRE);
        delete bouton.dataset.lecture;
        if (!couche) return;
        CLIMAT = couche;
        CIEL_LIEU = preparerCiel(CLIMAT);
    }
    solaireActif = !solaireActif;
    bouton.classList.toggle('on', solaireActif);
    document.getElementById('sec-solaire').hidden = !solaireActif;
    majCredits();
    resumer();
    if (!solaireActif) {
        jetonCalcul++;
        etat(null);
        appliquerTextureToits();
    } else if (RESULTAT && meshesToits.every(t => RESULTAT.toits.has(t))) {
        poserCarte();
    } else {
        lancer();
    }
    if (ficheUd) afficherFicheBatiment(ficheUd);
});
