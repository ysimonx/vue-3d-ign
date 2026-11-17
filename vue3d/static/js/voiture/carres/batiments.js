// Les bâtiments des carrés : lus, construits, défaits.

import * as THREE from 'three';
import { HAUTEUR_PAR_ETAGE, PENTE_TOIT_MAX } from '../../commun/regles.js';
import { depuisLambert93 } from '../socle/lambert93.js';
import { ancres, ancrer } from '../socle/monde.js';
import { scene, COURBURE } from '../socle/rendu.js';
import { voiture } from '../socle/etat.js';
import { annoncer } from '../interface/ecran.js';
import { NIVEAU_PROCHE, preparerAltitudes, altitudeL93 } from '../sol/altitudes.js';
import { CARRE_M, CARRES_VERSION } from './grille.js';
import { integrerRoutes } from '../route/graphe.js';
import { groupeRoutes, construireRoutes } from './routes.js';

// Demandés le long de la route prévue, sur une bande de COULOIR_M de part et
// d'autre, et dans un rayon AUTOUR_M de la voiture ; montrés tant qu'ils
// sont voulus, défaits CARRE_DEFAIT_S après, oubliés (routes comprises)
// quand ils sont loin. Un carré lu reste une semaine dans le cache du
// navigateur : un aller-retour ne redemande rien au serveur.
export const AUTOUR_M = 450;
// Autour de la voiture quand la route prévue finit en impasse : bâtiments ;
// les arbres, plus lents à lire, sur VEG_IMPASSE_M.
export const IMPASSE_RAYON_M = 1000;
export const COULOIR_M = 350;
export const PAS_COULOIR_M = 100;
export const CARRES_VOULUS_MAX = 90;
export const CARRES_PARALLELE = 4;
export const CARRE_DEFAIT_S = 20;
export const CARRE_OUBLI_S = 120, CARRE_OUBLI_M = 4000;
export let carresEnVol = 0;
const groupeBati = new THREE.Group();
scene.add(groupeBati);

export async function chargerCarre(c) {
    c.etat = 'charge';
    carresEnVol++;
    try {
        const reponse = await fetch(`api/carre?i=${c.i}&j=${c.j}&v=${CARRES_VERSION}`);
        if (reponse.status === 422) { c.etat = 'hors'; return; }
        if (!reponse.ok) {
            c.etat = 'erreur';
            c.reessai = performance.now() + (Number(reponse.headers.get('retry-after')) || 15) * 1000;
            if (reponse.status === 429) annoncer('Trop de carrés demandés en une heure : le serveur en refuse pour l\'instant.');
            return;
        }
        c.donnees = await reponse.json();
        c.etat = 'pret';
        integrerRoutes(c);
        const coins = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) =>
            depuisLambert93((c.i + u) * CARRE_M, (c.j + v) * CARRE_M));
        const lons = coins.map(p => p[0]), lats = coins.map(p => p[1]);
        preparerAltitudes(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats), NIVEAU_PROCHE)
            .then(() => { c.altiPretes = true; }, () => { c.altiPretes = true; });
        // La route prévue s'arrêtait peut-être au bord de ce carré.
        voiture.recalculer = true;
    } catch (e) {
        c.etat = 'erreur';
        c.reessai = performance.now() + 15000;
    } finally {
        carresEnVol--;
    }
}

// Teintes claires, lisibles sur la photo comme sur le plan ; les toits en
// pente en tuile au sud, en ardoise au nord de la Loire.
const TEINTES_MURS = {
    'Résidentiel': 0xe6dccb, 'Commercial et services': 0xd5dde5, 'Industriel': 0xc6cbd0,
    'Agricole': 0xd9cdb0, 'Religieux': 0xeee0c2, 'Sportif': 0xd0ddcc, 'Annexe': 0xd8d3ca,
};
const TEINTE_MURS = 0xd4cfc7;
const TEINTE_TOIT_PLAT = 0xaeb3b8;
const TEINTE_TUILE = 0xb5694c, TEINTE_ARDOISE = 0x6f7884;
const LAT_ARDOISE = 47.3;
// Mêmes règles que la page (commun/regles.js). Les murs descendent sous le sol
// BD TOPO : le relief lissé du RGE ALTI s'en écarte d'un mètre ou deux sur une
// pente.
const ENFONCEMENT_M = 4;
// Toit à deux pans seulement sur une emprise presque rectangulaire et pas
// trop large : ailleurs, le rectangle englobant en inventerait la forme.
const RECTANGLE_MIN = 0.85, LARGEUR_PIGNON_MAX = 24;
// Entre la caméra et la voiture, les bâtiments s'ajourent (un pixel sur
// quatre gardé, en tramage) dans un cône qui s'élargit vers elle : en rue
// étroite, les façades de 25 m de la rue de Berri la cachaient.
export const uniformsBati = { uVoiture: { value: new THREE.Vector3() }, uRayon: { value: 0 } };
/**
 * Courbure (comme courber) et ajourage, en tramage, dans le cône qui va de
 * la caméra à la voiture ; `proche` ([début, fin] en mètres) efface en plus
 * ce qui frôle la caméra : basse, elle passait dans la canopée de Gordes.
 * Sans `cone`, seul `proche` ajoure.
 */
export function ajourer(materiau, cle, proche = null, cone = true) {
    materiau.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniformsBati);
    shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMonde;')
        .replace('#include <project_vertex>',
            'vec4 mondeP = vec4(transformed, 1.0);\n'
            + '#ifdef USE_INSTANCING\nmondeP = instanceMatrix * mondeP;\n#endif\n'
            + 'mondeP = modelMatrix * mondeP;\n'
            + 'vMonde = mondeP.xyz;\n'
            + 'vec2 ecartCam = mondeP.xz - cameraPosition.xz;\n'
            + `mondeP.y -= dot(ecartCam, ecartCam) * ${COURBURE.toExponential(8)};\n`
            + 'vec4 mvPosition = viewMatrix * mondeP;\n'
            + 'gl_Position = projectionMatrix * mvPosition;');
    shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vMonde;\nuniform vec3 uVoiture;\nuniform float uRayon;')
        .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\n'
            + 'float ajour = 0.0;\n'
            + (cone ? 'if (uRayon > 0.0) {\n' : 'if (false) {\n')
            + '  vec3 axe = uVoiture - cameraPosition;\n'
            + '  float l = length(axe);\n'
            + '  vec3 dir = axe / l;\n'
            + '  float t = dot(vMonde - cameraPosition, dir);\n'
            + '  if (t > 0.0 && t < l + 3.0) {\n'
            + '    float r = uRayon * (0.3 + 0.7 * min(t / l, 1.0));\n'
            + '    float d = length(vMonde - cameraPosition - dir * t);\n'
            + '    ajour = 0.75 * (1.0 - smoothstep(0.7 * r, r, d));\n'
            + '  }\n'
            + '}\n'
            + (proche ? `ajour = max(ajour, 1.0 - smoothstep(${proche[0].toFixed(1)}, ${proche[1].toFixed(1)}, distance(vMonde, cameraPosition)));\n` : '')
            + 'if (ajour > 0.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < ajour) discard;');
    };
    materiau.customProgramCacheKey = () => cle;
    return materiau;
}
// L'angle de vue ne change jamais pour un obstacle : une caméra qui montait
// au-dessus des toits voisins sautait sans cesse dans un village, et Yannick
// n'en a pas voulu. Ce sont les obstacles qui s'effacent : tout bâtiment à
// moins de 6 m de la caméra (elle est dans un îlot quand la rue tourne
// derrière la voiture), estompé jusqu'à 22 m, et ceux qui la séparent de la
// voiture (le cône).
const BATI_PROCHES_M = [6, 22];
const MAT_BATI = ajourer(new THREE.MeshLambertMaterial({ vertexColors: true }), 'bati', BATI_PROCHES_M);

function aireAnneau(p) {
    let a = 0;
    for (let k = 0, n = p.length / 2; k < n; k++) {
        const l = (k + 1) % n;
        a += p[2 * k] * p[2 * l + 1] - p[2 * l] * p[2 * k + 1];
    }
    return a / 2;
}

/** Le plus petit rectangle englobant (enveloppe convexe, un côté sur une arête). */
function rectangleMin(p) {
    const pts = [];
    for (let k = 0; k < p.length; k += 2) pts.push([p[k], p[k + 1]]);
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const croix = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const bas = [], haut = [];
    for (const q of pts) { while (bas.length >= 2 && croix(bas[bas.length - 2], bas[bas.length - 1], q) <= 0) bas.pop(); bas.push(q); }
    for (let k = pts.length - 1; k >= 0; k--) { const q = pts[k]; while (haut.length >= 2 && croix(haut[haut.length - 2], haut[haut.length - 1], q) <= 0) haut.pop(); haut.push(q); }
    const env = bas.slice(0, -1).concat(haut.slice(0, -1));
    let meilleur = null;
    for (let k = 0; k < env.length; k++) {
        const a = env[k], b = env[(k + 1) % env.length];
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(ang), s = Math.sin(ang);
        let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
        for (const q of env) {
            const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c;
            u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
        }
        const aire = (u1 - u0) * (v1 - v0);
        if (!meilleur || aire < meilleur.aire) meilleur = { aire, ang, u0, u1, v0, v1 };
    }
    if (!meilleur) return null;
    let { ang, u0, u1, v0, v1 } = meilleur;
    // L'axe u, celui du faîtage, le long du grand côté.
    if (v1 - v0 > u1 - u0) { ang += Math.PI / 2; [u0, u1, v0, v1] = [v0, v1, -u1, -u0]; }
    const c = Math.cos(ang), s = Math.sin(ang), um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    return { aire: meilleur.aire, longueur: u1 - u0, largeur: v1 - v0,
             cx: um * c - vm * s, cy: um * s + vm * c, ux: c, uy: s, vx: -s, vy: c };
}

/**
 * Les bâtiments d'un carré en un seul maillage (un appel de dessin) :
 * murs extrudés de l'emprise, toit à deux pans sur un rectangle, sinon
 * plat. Sommets relatifs au centre du carré, en coordonnées de la scène
 * (X est, Y altitude, Z sud), une normale par face.
 */
export function construireCarre(c) {
    const d = c.donnees;
    const cx = (c.i + 0.5) * CARRE_M, cy = (c.j + 0.5) * CARRE_M;
    const [ox, oy] = d.origine;
    const dx = ox - cx, dy = oy - cy;
    const pos = [], nor = [], col = [];
    const couleur = new THREE.Color(), teinte = new THREE.Color();
    const ardoise = depuisLambert93(cx, cy)[1] > LAT_ARDOISE;
    const va = new THREE.Vector3(), vb = new THREE.Vector3(), vn = new THREE.Vector3();
    // Un triangle (x, alt, y locaux, y vers le nord), tourné pour que sa
    // normale suive `ref` (ex, ey, ez) : vers le dehors, ou vers le ciel.
    const tri = (a, b, e, ref, ca, cb = ca, ce = ca) => {
        const A = [a[0], a[1], -a[2]], B = [b[0], b[1], -b[2]], E = [e[0], e[1], -e[2]];
        va.set(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
        vb.set(E[0] - A[0], E[1] - A[1], E[2] - A[2]);
        vn.crossVectors(va, vb);
        if (vn.lengthSq() < 1e-8) return;
        let P = [A, B, E], C = [ca, cb, ce];
        if (vn.x * ref[0] + vn.y * ref[1] - vn.z * ref[2] < 0) { P = [A, E, B]; C = [ca, ce, cb]; vn.negate(); }
        vn.normalize();
        for (let q = 0; q < 3; q++) {
            pos.push(P[q][0], P[q][1], P[q][2]); nor.push(vn.x, vn.y, vn.z); col.push(C[q].r, C[q].g, C[q].b);
        }
    };
    const pied = new THREE.Color();
    let n = 0;
    for (const b of d.batiments) {
        for (const poly of b.polygones) {
            // Anneaux en mètres, relatifs au centre ; sans le sommet de fermeture.
            const anneaux = poly.map(a => {
                const p = [];
                for (let k = 0; k + 1 < a.length; k += 2) p.push(a[k] / 10 + dx, a[k + 1] / 10 + dy);
                if (p.length >= 4 && p[0] === p[p.length - 2] && p[1] === p[p.length - 1]) p.length -= 2;
                return p;
            }).filter(p => p.length >= 6);
            if (!anneaux.length) continue;
            // Extérieur dans le sens trigonométrique, trous dans l'autre.
            anneaux.forEach((p, k) => {
                if ((aireAnneau(p) > 0) !== (k === 0)) {
                    const r = [];
                    for (let q = p.length - 2; q >= 0; q -= 2) r.push(p[q], p[q + 1]);
                    p.splice(0, p.length, ...r);
                }
            });
            const ext = anneaux[0];
            let mx = 0, my = 0;
            for (let k = 0; k < ext.length; k += 2) { mx += ext[k]; my += ext[k + 1]; }
            mx /= ext.length / 2; my /= ext.length / 2;
            let sol = b.sol;
            if (sol == null) {
                const a = altitudeL93(cx + mx, cy + my);
                sol = Number.isFinite(a) ? a : 0;
            }
            const gout = b.gouttiere, fait = b.faitage;
            let hMur = gout != null && gout > sol + 0.5 ? gout - sol
                : b.hauteur > 0 ? b.hauteur : b.etages > 0 ? HAUTEUR_PAR_ETAGE * b.etages : 4;
            hMur = Math.min(Math.max(hMur, 2), 350);
            const bas = sol - ENFONCEMENT_M, haut = sol + hMur;
            couleur.setHex(TEINTES_MURS[b.usage] || TEINTE_MURS);
            // Un écart de teinte par bâtiment : des voisins accolés se
            // distinguent ; et un pied plus sombre, qui pose les façades.
            const h = (n * 2654435761 >>> 0) / 4294967296;
            couleur.multiplyScalar(0.88 + 0.16 * h);
            pied.copy(couleur).multiplyScalar(0.62);
            n++;
            for (const p of anneaux) {
                const m = p.length / 2;
                for (let k = 0; k < m; k++) {
                    const l = (k + 1) % m;
                    const ax = p[2 * k], ay = p[2 * k + 1], bx = p[2 * l], by = p[2 * l + 1];
                    const dehors = [by - ay, 0, -(bx - ax)];
                    tri([ax, bas, ay], [bx, bas, by], [bx, haut, by], dehors, pied, pied, couleur);
                    tri([ax, bas, ay], [bx, haut, by], [ax, haut, ay], dehors, pied, couleur, couleur);
                }
            }
            const den = gout != null && fait != null ? fait - gout : 0;
            const aire = aireAnneau(ext) + anneaux.slice(1).reduce((s, p) => s + aireAnneau(p), 0);
            const r = den > 0.5 && anneaux.length === 1 ? rectangleMin(ext) : null;
            if (r && aire / r.aire >= RECTANGLE_MIN && r.largeur <= LARGEUR_PIGNON_MAX) {
                const f = Math.min(den, PENTE_TOIT_MAX * r.largeur);
                const L = r.longueur / 2, W = r.largeur / 2;
                const pt = (u, v, z) => [r.cx + u * r.ux + v * r.vx, z, r.cy + u * r.uy + v * r.vy];
                const a1 = pt(L, W, haut), a2 = pt(-L, W, haut), a3 = pt(-L, -W, haut), a4 = pt(L, -W, haut);
                const f1 = pt(L, 0, haut + f), f2 = pt(-L, 0, haut + f);
                teinte.setHex(ardoise ? TEINTE_ARDOISE : TEINTE_TUILE).multiplyScalar(0.92 + 0.12 * h);
                const versV = [r.vx, 1, r.vy], versMoinsV = [-r.vx, 1, -r.vy];
                tri(a1, a2, f2, versV, teinte); tri(a1, f2, f1, versV, teinte);
                tri(a3, a4, f1, versMoinsV, teinte); tri(a3, f1, f2, versMoinsV, teinte);
                tri(a4, a1, f1, [r.ux, 0, r.uy], couleur);
                tri(a2, a3, f2, [-r.ux, 0, -r.uy], couleur);
            } else {
                const contour = [], trous = [];
                for (let k = 0; k < ext.length; k += 2) contour.push(new THREE.Vector2(ext[k], ext[k + 1]));
                for (const p of anneaux.slice(1)) {
                    const t = [];
                    for (let k = 0; k < p.length; k += 2) t.push(new THREE.Vector2(p[k], p[k + 1]));
                    trous.push(t);
                }
                // Les indices rendus courent sur le contour puis les trous,
                // tels que triangulateShape les laisse.
                const faces = THREE.ShapeUtils.triangulateShape(contour, trous);
                const tous = contour.concat(...trous);
                teinte.setHex(TEINTE_TOIT_PLAT).multiplyScalar(0.86 + 0.2 * h);
                for (const [i0, i1, i2] of faces) {
                    const A = tous[i0], B = tous[i1], E = tous[i2];
                    tri([A.x, haut, A.y], [B.x, haut, B.y], [E.x, haut, E.y], [0, 1, 0], teinte);
                }
            }
        }
    }
    c.nbBatiments = n;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    c.mesh = new THREE.Mesh(geo, MAT_BATI);
    ancrer(c.mesh, cx, cy);
    groupeBati.add(c.mesh);
    c.routes = construireRoutes(c, cx, cy);
    ancrer(c.routes, cx, cy);
    groupeRoutes.add(c.routes);
}

export function defaireCarre(c) {
    if (!c.mesh) return;
    groupeBati.remove(c.mesh);
    ancres.delete(c.mesh);
    c.mesh.geometry.dispose();
    c.mesh = null;
    if (c.routes) {
        groupeRoutes.remove(c.routes);
        ancres.delete(c.routes);
        for (const m of c.routes.children) m.geometry.dispose();
        c.routes = null;
    }
}
