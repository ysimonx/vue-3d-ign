// Vérifie la géométrie de la page en exécutant son vrai code : les fonctions
// sont extraites de vue3d/static/index.html et appelées sous Node, avec le
// three.js de la page. La relecture ne suffit pas — c'est ainsi qu'ont été
// trouvées des facettes retournées, puis un pignon sur deux manquant au toit
// découpé (un côté du contour posé sur le bord de sa boîte, jeté dehors par
// l'arrondi).
//
//   npm install three@0.160.0          # ignoré par git, comme puppeteer-core
//   node outils/verifier-geometrie.mjs
//
// Les contrôles :
// - volumes des ouvrages (prismeLeLong, dalle) : fermés — chaque arête portée
//   par deux triangles, en sens opposés — et de volume positif, donc orientés
//   vers l'extérieur ;
// - toit résumé découpé sur l'emprise (geometrieToitDecoupe) : pans tournés
//   vers le haut, d'aire égale à celle de l'emprise, pignons tournés vers
//   l'extérieur, volume égal à l'intégrale de la hauteur du toit ;
// - véhicules (blocsVehicule, repereVehicule) : chaque bloc fermé, tourné vers
//   l'extérieur, dans le gabarit unité ; le repère d'un véhicule posé sur une
//   pente reste orthonormé, direct, le toit vers le haut ;
// - normales et sphères englobantes que la page calcule elle-même, pour aller
//   plus vite (normalesFacettes, normalesPliees, normalesIndexees,
//   sphereEnglobante) : identiques à l'octet à celles de three.js
//   (computeVertexNormals, toCreasedNormals, computeBoundingSphere) ;
//   houppiers (ajouterHouppier) et leur tampon indexé : remis à plat,
//   identiques à ceux de la page d'origine (bc716ba), recopiés ici, aux
//   triangles dégénérés près, et à la taille annoncée par facesHouppier et
//   sommetsHouppier ; fermés et tournés vers l'extérieur, en forme détaillée
//   comme simple ; végétation sans les masses qu'expliquent les ouvrages
//   (vegetationExtraite) : identique à sa reconstruction ;
// - barre d'avancement (partConstruite) : croissante, d'accord avec les étapes
//   que compte le serveur.
//
// Sort en erreur si un contrôle est manqué, après les avoir tous faits.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import fs from 'fs';
import { fileURLToPath } from 'url';

const page = fileURLToPath(new URL('../vue3d/static/index.html', import.meta.url));
const src = fs.readFileSync(page, 'utf8');
function extraire(nom) {
  const i = src.indexOf(`function ${nom}(`);
  if (i < 0) throw new Error('introuvable dans la page : ' + nom);
  let n = 0;
  for (let j = src.indexOf('{', src.indexOf(')', i)); j < src.length; j++) {
    if (src[j] === '{') n++;
    else if (src[j] === '}' && --n === 0) return src.slice(i, j + 1);
  }
}
// Une déclaration `const NOM = …;` de la page, jusqu'au point-virgule hors
// de toute parenthèse, crochet ou accolade.
function extraireConst(nom) {
  const i = src.indexOf(`const ${nom} =`);
  if (i < 0) throw new Error('introuvable dans la page : ' + nom);
  let n = 0;
  for (let j = i; j < src.length; j++) {
    if ('([{'.includes(src[j])) n++;
    else if (')]}'.includes(src[j])) n--;
    else if (src[j] === ';' && n === 0) return src.slice(i, j + 1);
  }
}
// Projection locale de la page, autour d'un point à 45° N.
const M = 111320, MLON = 111320 * Math.cos(45 * Math.PI / 180);
const toLocal = (lon, lat) => [(lon - 2) * MLON, (lat - 45) * M];
const NOMS = ['couperPolygone', 'enveloppeConvexe', 'rectangleMin', 'rectangleSelonAxe',
              'geometrieToitDecoupe', 'stationsLeLong', 'prismeLeLong', 'dalle',
              'blocsVehicule', 'repereVehicule', 'normalesFacettes', 'poserNormaleFacette', 'geometrieFacettes',
              'normalesPliees', 'normalesIndexees', 'sphereEnglobante',
              'alea', 'portDe', 'portMesure', 'gabaritHouppier', 'facesHouppier', 'sommetsHouppier', 'ajouterHouppier',
              'nouveauTampon', 'facesHouppierSimple', 'sommetsHouppierSimple', 'ajouterHouppierSimple',
              'vegetationExtraite', 'partConstruite'];
const CONSTS = ['PORTS', 'SEGMENTS_HOUPPIER', 'SEGMENTS_SIMPLE', 'ANGLES_HOUPPIER', 'COS_HOUPPIER', 'BOSSES_HOUPPIER',
                'EMPRISE_HOUPPIER', 'HAUTEUR_MIN_TRONC', 'PART_LECTURES'];
const { rectangleMin, rectangleSelonAxe, geometrieToitDecoupe, stationsLeLong, prismeLeLong, dalle,
        blocsVehicule, repereVehicule, normalesFacettes, normalesPliees, normalesIndexees, sphereEnglobante,
        alea, portDe, facesHouppier, sommetsHouppier, ajouterHouppier, nouveauTampon, vegetationExtraite, partConstruite,
        facesHouppierSimple, sommetsHouppierSimple, ajouterHouppierSimple,
        SEGMENTS_HOUPPIER, EMPRISE_HOUPPIER, HAUTEUR_MIN_TRONC, PART_LECTURES } =
  new Function('THREE', 'toLocal', CONSTS.map(extraireConst).join('\n') + '\n' + NOMS.map(extraire).join('\n')
               + `\nreturn { ${NOMS.concat(CONSTS).join(', ')} };`)(THREE, toLocal);
let tout = true;

// --- Volumes des ouvrages ---------------------------------------------------
{
const ll3 = (x, y, z) => [2 + x / MLON, 45 + y / M, z];

// Hauteur d'un sommet { z, dz }, sol plat à 100 m : comme maillagePose, plancher 0.
const SOL = 100;
const pos = s => [s.x, (s.z == null ? 0 : Math.max(s.z - SOL, 0)) + s.dz, -s.y];
function verifierVolume(nom, tris) {
  const cle = p => p.map(v => v.toFixed(4)).join(',');
  const aretes = new Map();
  let volume = 0, degeneres = 0;
  for (const t of tris) {
    const [a, b, c] = t.map(pos);
    const n = [(b[1]-a[1])*(c[2]-a[2]) - (b[2]-a[2])*(c[1]-a[1]), (b[2]-a[2])*(c[0]-a[0]) - (b[0]-a[0])*(c[2]-a[2]), (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])];
    if (Math.hypot(...n) < 1e-9) { degeneres++; }
    volume += (a[0] * (b[1]*c[2] - b[2]*c[1]) - a[1] * (b[0]*c[2] - b[2]*c[0]) + a[2] * (b[0]*c[1] - b[1]*c[0])) / 6;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = cle(u) + '>' + cle(v);
      aretes.set(k, (aretes.get(k) || 0) + 1);
    }
  }
  let ouvertes = 0, doubles = 0;
  for (const [k, n] of aretes) {
    const [u, v] = k.split('>');
    if (u === v) continue;               // arête d'un triangle dégénéré
    if (n !== 1) doubles++;
    if ((aretes.get(v + '>' + u) || 0) !== 1) ouvertes++;
  }
  const ok = ouvertes === 0 && doubles === 0 && volume > 0;
  console.log(`${ok ? 'OK ' : 'KO '} ${nom} : ${tris.length} triangles, volume ${volume.toFixed(1)} m³, arêtes sans vis-à-vis ${ouvertes}, arêtes doublées ${doubles}, triangles dégénérés ${degeneres}`);
  return ok;
}
const haut = dz => s => ({ z: s.z, dz }), sol = () => ({ z: null, dz: -0.5 });
// Mur droit, mur coudé, mur en épingle, mur à sommet doublé.
const lignes = {
  'mur droit': [ll3(0, 0, 110), ll3(30, 0, 112)],
  'mur coudé': [ll3(0, 0, 110), ll3(20, 0, 110), ll3(20, 15, 115), ll3(40, 30, 108)],
  'mur en épingle': [ll3(0, 0, 110), ll3(20, 0, 110), ll3(0, 1.5, 110)],
  'mur à sommet doublé': [ll3(0, 0, 110), ll3(10, 0, 110), ll3(10, 0, 110), ll3(10, 12, 111)],
  'mur vers le sud-ouest': [ll3(30, 30, 108), ll3(0, 0, 108)],
};
for (const [nom, l] of Object.entries(lignes)) {
  const st = stationsLeLong(l, 2);
  tout = verifierVolume(nom, prismeLeLong(st, 1, haut(0), sol)) && tout;
  tout = verifierVolume(nom + ' (tablier)', prismeLeLong(st, 4, haut(0), haut(-1))) && tout;
}
// Dalles : contour dans les deux sens, avec et sans trou, fermé par son premier point.
const carre = [ll3(0, 0, 105), ll3(40, 0, 105), ll3(40, 20, 107), ll3(0, 20, 107), ll3(0, 0, 105)];
const trou = [ll3(10, 5, 105), ll3(20, 5, 105), ll3(20, 12, 106), ll3(10, 12, 106), ll3(10, 5, 105)];
const enL = [ll3(0, 0, 105), ll3(30, 0, 105), ll3(30, 10, 105), ll3(10, 10, 106), ll3(10, 30, 107), ll3(0, 30, 107), ll3(0, 0, 105)];
tout = verifierVolume('dalle, sens trigonométrique', dalle(carre, [], 1)) && tout;
tout = verifierVolume('dalle, sens des aiguilles', dalle(carre.slice().reverse(), [], 1)) && tout;
tout = verifierVolume('dalle trouée', dalle(carre, [trou], 1)) && tout;
tout = verifierVolume('dalle trouée, trou dans l\'autre sens', dalle(carre, [trou.slice().reverse()], 1)) && tout;
tout = verifierVolume('dalle en L', dalle(enL, [], 1)) && tout;
tout = verifierVolume('dalle en L, sens des aiguilles', dalle(enL.slice().reverse(), [], 1)) && tout;
}

// --- Toit résumé découpé sur l'emprise ----------------------------------------
{
const ll = ([x, y]) => [2 + x / MLON, 45 + y / M];
const fermer = a => a.concat([a[0]]);
const tourner = (pts, deg) => { const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180); return pts.map(([x, y]) => [x * c - y * s, x * s + y * c]); };
const aire = a => { let s = 0; for (let k = 0; k < a.length; k++) { const p = a[k], q = a[(k + 1) % a.length]; s += p[0] * q[1] - q[0] * p[1]; } return Math.abs(s / 2); };
const dans = (p, a) => { let d = false; for (let i = 0, j = a.length - 1; i < a.length; j = i++) { const [xi, yi] = a[i], [xj, yj] = a[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) d = !d; } return d; };

function verifier(nom, contour, trous, boitesDe, hMur) {
  const pts = contour, rects = boitesDe(pts);
  const geo = geometrieToitDecoupe(fermer(contour).map(ll), trous.map(t => fermer(t).map(ll)), rects, hMur);
  if (!geo) { console.log('KO ', nom, ': aucune géométrie'); return false; }
  const pos = geo.attributes.position.array;
  let aireHaut = 0, volume = 0, versBas = 0, pignonsDedans = 0, hMax = -Infinity, hMin = Infinity, nPignons = 0;
  // centre de gravité grossier de l'emprise, pour juger du sens des pignons d'une emprise convexe
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  for (let i = 0; i < pos.length; i += 9) {
    const a = [pos[i], pos[i + 1], pos[i + 2]], b = [pos[i + 3], pos[i + 4], pos[i + 5]], c = [pos[i + 6], pos[i + 7], pos[i + 8]];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(...n);
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    if (Math.abs(n[1]) > 1e-6 * l) {                 // un pan
      if (n[1] < 0) versBas++;
      aireHaut += n[1] / 2;
      for (const p of [a, b, c]) { hMax = Math.max(hMax, p[1]); hMin = Math.min(hMin, p[1]); }
    } else {                                         // un pignon, vertical
      nPignons++;
      if (l < 1e-9) continue;                        // triangle aplati au bas d'un pignon
      // Un pas vers où regarde le pignon : on doit sortir du bâtiment (ou entrer dans une cour).
      const m = [(a[0] + b[0] + c[0]) / 3 + 0.05 * n[0] / l, -(a[2] + b[2] + c[2]) / 3 - 0.05 * n[2] / l];
      if (dans(m, pts) && !trous.some(t => dans(m, t))) pignonsDedans++;
    }
  }
  // Volume attendu : intégrale de (toit − hMur) sur l'emprise, par échantillonnage ; le toit d'un
  // point est le plus haut des boîtes qui le couvrent, comme des pans qui se traversent.
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const [xa, xb, ya, yb] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const N = 500; let attendu = 0, couvert = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const p = [xa + (xb - xa) * (i + 0.5) / N, ya + (yb - ya) * (j + 0.5) / N];
    if (!dans(p, pts) || trous.some(t => dans(p, t))) continue;
    let somme = 0, un = false;
    for (const b of rects) {
      const { ang, x0, x1, y0, y1 } = b.rect, co = Math.cos(ang), si = Math.sin(ang);
      const q = [p[0] * co + p[1] * si, -p[0] * si + p[1] * co];
      if (q[0] < x0 || q[0] > x1 || q[1] < y0 || q[1] > y1) continue;
      const mu = (x0 + x1) / 2, mw = (y0 + y1) / 2, du = (x1 - x0) / 2, dw = (y1 - y0) / 2;
      const sx = b.suivantX ?? (x1 - x0 >= y1 - y0);
      const h = b.pyramide ? b.g + (b.f - b.g) * (1 - Math.max(Math.abs(q[0] - mu) / du, Math.abs(q[1] - mw) / dw))
              : sx ? b.g + (b.f - b.g) * (1 - Math.abs(q[1] - mw) / dw) : b.g + (b.f - b.g) * (1 - Math.abs(q[0] - mu) / du);
      somme += h - hMur; un = true;
    }
    if (un) { couvert++; attendu += somme; }
  }
  const cellule = (xb - xa) * (yb - ya) / (N * N);
  attendu *= cellule; const aireAttendue = couvert * cellule * (rects.length === 1 ? 1 : NaN);
  // Le volume des seuls pans et pignons, ouvert par-dessous : on le ferme par la base à hMur.
  const base = rects.length === 1 ? hMur * couvert * cellule : NaN;
  const okAire = rects.length > 1 || Math.abs(aireHaut - aireAttendue) < 0.01 * aireAttendue;
  // La base, tournée vers le bas à la hauteur hMur, compte pour −hMur × aire / 3 dans la somme.
  const volumeFerme = volume - (rects.length === 1 ? base / 3 : 0);
  const okVolume = rects.length > 1 || Math.abs(volumeFerme - attendu) < 0.02 * attendu + 0.5;
  const ok = versBas === 0 && pignonsDedans === 0 && okAire && okVolume;
  console.log(`${ok ? 'OK ' : 'KO '} ${nom} : ${pos.length / 9} triangles ; pans vers le bas ${versBas} ; aire des pans ${aireHaut.toFixed(1)} m² (emprise sous les boîtes ${rects.length === 1 ? aireAttendue.toFixed(1) : '—'}) ; hauteurs ${hMin.toFixed(2)} à ${hMax.toFixed(2)} ; pignons ${nPignons} dont vers l'intérieur ${pignonsDedans} ; volume ${rects.length === 1 ? volumeFerme.toFixed(1) + ' m³ pour ' + attendu.toFixed(1) : '—'}`);
  return ok;
}
const rect = [[0, 0], [20, 0], [20, 10], [0, 10]];
const enL = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 18], [0, 18]];
const cercle = Array.from({ length: 24 }, (_, k) => [6 * Math.cos(k * Math.PI / 12), 6 * Math.sin(k * Math.PI / 12)]);
const cour = [[0, 0], [30, 0], [30, 24], [0, 24]], trou = [[10, 8], [20, 8], [20, 16], [10, 16]];
const min = extra => pts => [{ rect: rectangleMin(pts), g: 4, f: 7, ...extra }];
const axe = (deg, extra) => pts => [{ rect: rectangleSelonAxe(pts, deg * Math.PI / 180), g: 4, f: 7, suivantX: true, ...extra }];
for (const sens of ['', ' (sens des aiguilles)']) {
  const o = a => sens ? a.slice().reverse() : a;
  tout = verifier('rectangle, deux pans' + sens, o(rect), [], min({}), 4) && tout;
  tout = verifier('rectangle tourné de 30°' + sens, o(tourner(rect, 30)), [], min({}), 4) && tout;
  tout = verifier('rectangle, faîtage mesuré en biais à 25°' + sens, o(rect), [], axe(25), 4) && tout;
  tout = verifier('maison en L' + sens, o(enL), [], min({}), 4) && tout;
  tout = verifier('maison en L, faîtage à 40°' + sens, o(tourner(enL, 10)), [], axe(40), 4) && tout;
  tout = verifier('tour ronde, pyramide' + sens, o(cercle), [], min({ pyramide: true }), 4) && tout;
  tout = verifier('rectangle, pyramide' + sens, o(rect), [], min({ pyramide: true }), 4) && tout;
  tout = verifier('îlot à cour' + sens, o(cour), [o(trou)], min({}), 4) && tout;
  tout = verifier('faîtage le long du petit côté' + sens, o(rect), [], pts => [{ rect: rectangleMin(pts), g: 4, f: 7, suivantX: false }], 4) && tout;
  tout = verifier('murs plus bas que la gouttière' + sens, o(rect), [], min({}), 3) && tout;
}
// Deux corps sur une maison en L : chacun sa boîte, pans vers le haut, pignons dehors (emprise non convexe : sens non jugé).
const corps = [{ rect: { ang: 0, x0: 0, x1: 20, y0: 0, y1: 8 }, g: 4, f: 7, suivantX: true },
               { rect: { ang: Math.PI / 2, x0: 8, x1: 18, y0: -8, y1: 0 }, g: 4.5, f: 6.5, pyramide: true }];
const g2 = geometrieToitDecoupe(fermer(enL).map(ll), [], corps, 4);
let bas = 0; const p2 = g2.attributes.position.array;
for (let i = 0; i < p2.length; i += 9) { const ny = (p2[i + 5] - p2[i + 2]) * (p2[i + 6] - p2[i]) - (p2[i + 3] - p2[i]) * (p2[i + 8] - p2[i + 2]); if (ny < -1e-9) bas++; }
console.log(`${bas === 0 ? 'OK ' : 'KO '} deux corps sur une maison en L : ${p2.length / 9} triangles, pans vers le bas ${bas}`);
// Une boîte hors de l'emprise ne donne rien.
const rien = geometrieToitDecoupe(fermer(rect).map(ll), [], [{ rect: { ang: 0, x0: 100, x1: 120, y0: 0, y1: 10 }, g: 4, f: 7 }], 4);
console.log(`${rien === null ? 'OK ' : 'KO '} boîte hors de l'emprise : ${rien === null ? 'null' : 'géométrie'}`);
tout = tout && bas === 0 && rien === null;
}

// --- Véhicules ------------------------------------------------------------------
{
for (const gabarit of ['voiture', 'fourgon', 'car']) {
  const blocs = blocsVehicule(gabarit);
  let ouvertes = 0, dehors = 0, retournes = 0, volume = 0;
  for (const b of blocs) {
    const aretes = new Map();
    let v = 0;
    const cle = p => p.map(c => c.toFixed(5)).join(',');
    for (const [a, bb, c] of b.tris) {
      v += (a[0] * (bb[1] * c[2] - bb[2] * c[1]) - a[1] * (bb[0] * c[2] - bb[2] * c[0]) + a[2] * (bb[0] * c[1] - bb[1] * c[0])) / 6;
      for (const [u, w] of [[a, bb], [bb, c], [c, a]]) aretes.set(cle(u) + '>' + cle(w), (aretes.get(cle(u) + '>' + cle(w)) || 0) + 1);
      for (const p of [a, bb, c]) if (Math.abs(p[0]) > 0.5 + 1e-9 || p[1] < -1e-9 || p[1] > 1 + 1e-9 || Math.abs(p[2]) > 0.52) dehors++;
    }
    for (const [k, n] of aretes) { const [u, w] = k.split('>'); if (n !== 1 || (aretes.get(w + '>' + u) || 0) !== 1) ouvertes++; }
    if (v <= 0) retournes++;
    volume += v;
  }
  const teintes = new Set(blocs.map(b => b.teinte));
  const ok = ouvertes === 0 && dehors === 0 && retournes === 0 && teintes.has('caisse') && teintes.has('vitre') && teintes.has('roue');
  console.log(`${ok ? 'OK ' : 'KO '} véhicule « ${gabarit} » : ${blocs.length} blocs, volume ${volume.toFixed(2)} du gabarit, arêtes sans vis-à-vis ${ouvertes}, blocs retournés ${retournes}, sommets hors gabarit ${dehors}`);
  tout = tout && ok;
}
// Repère : caps tous les 15°, pentes jusqu'à 100 % en long et en travers.
let mauvais = 0, essais = 0, pire = 0;
const scal = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
for (let cap = 0; cap < 360; cap += 15) for (const pl of [-1, -0.2, 0, 0.2, 1]) for (const pt of [-1, -0.2, 0, 0.2, 1]) {
  const est = Math.sin(cap * Math.PI / 180), nord = Math.cos(cap * Math.PI / 180), L = 4.3, W = 1.8;
  const { X, Y, Z } = repereVehicule(est, nord, L, W, pl * L / 2, -pl * L / 2, -pt * W / 2, pt * W / 2);
  const det = scal(X, [Y[1] * Z[2] - Y[2] * Z[1], Y[2] * Z[0] - Y[0] * Z[2], Y[0] * Z[1] - Y[1] * Z[0]]);
  const ecart = Math.max(Math.abs(scal(X, X) - 1), Math.abs(scal(Y, Y) - 1), Math.abs(scal(Z, Z) - 1), Math.abs(scal(X, Y)), Math.abs(scal(Y, Z)), Math.abs(det - 1));
  // L'avant pointe vers le cap et monte avec la pente ; la droite descend si le sol descend à droite.
  const sens = X[0] * est - X[2] * nord > 0 && Math.sign(X[1]) === Math.sign(pl) && Z[0] * nord + Z[2] * est > 0;
  essais++; pire = Math.max(pire, ecart);
  if (ecart > 1e-9 || Y[1] <= 0 || !sens) mauvais++;
}
const plat = repereVehicule(0, 1, 4.3, 1.8, 0, 0, 0, 0);       // cap nord, sol plat
const platOk = [plat.X, plat.Y, plat.Z].flat().every((c, i) => Math.abs(c - [0, 0, -1, 0, 1, 0, 1, 0, 0][i]) < 1e-12);
console.log(`${mauvais === 0 && platOk ? 'OK ' : 'KO '} repère d'un véhicule : ${essais} poses, ${mauvais} fausses, écart à l'orthonormé ${pire.toExponential(1)}, à plat cap nord ${platOk ? 'avant au nord, droite à l\'est' : 'FAUX'}`);
tout = tout && mauvais === 0 && platOk;
}

// --- Normales et sphères calculées par la page ----------------------------------
// Elles remplacent celles de three.js pour aller plus vite : elles doivent en
// être la copie à l'octet, faute de quoi la scène changerait.
{
// Tirage pseudo-aléatoire reproductible (LCG), pour des essais stables.
let graine = 12345;
const hasard = () => ((graine = (Math.imul(graine, 1103515245) + 12345) >>> 0) / 4294967296);
const memes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength),
                                                                 Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
const geoDe = pos => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); return g; };
// Toit en nappe : une grille de 0,5 m relevée d'un faîtage, bruitée de quelques
// centimètres comme le LiDAR, à des centaines de mètres du centre, coupée en
// triangles non indexés ; plus des triangles dégénérés et des sommets doublés.
function nappe(n, x0, z0) {
  const h = (i, j) => 6 + 3 * (1 - Math.abs(j - n / 2) / (n / 2)) + 0.05 * hasard() + (i > n / 2 ? 1.5 : 0);
  const v = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = (a, b) => [x0 + a * 0.5, h(a, b), z0 - b * 0.5];
    const [a, b, c, d] = [p(i, j), p(i + 1, j), p(i + 1, j + 1), p(i, j + 1)];
    v.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  v.push(x0, 7, z0, x0, 7, z0, x0 + 1, 7, z0);                 // dégénéré : deux sommets confondus
  v.push(x0, 7, z0, x0 + 0.001, 7, z0, x0 + 0.002, 7, z0);     // dégénéré : alignés, au centimètre
  // Des triangles quelconques autour de la nappe, de toutes tailles.
  for (let k = 0; k < 200; k++) for (let s = 0; s < 3; s++) v.push(x0 + 40 * hasard(), 30 * hasard(), z0 - 40 * hasard());
  return new Float32Array(v);
}
let ok = true, essais = 0;
for (const [n, x0, z0] of [[8, 0, 0], [30, 412.3, -287.9], [60, -950.7, 801.1]]) {
  const pos = nappe(n, x0, z0);
  // Facettes : computeVertexNormals.
  const ref = geoDe(pos.slice()); ref.computeVertexNormals();
  ok = memes(normalesFacettes(pos), ref.attributes.normal.array) && ok;
  // Pliées : toCreasedNormals, au pli des toits (40°) et à d'autres angles.
  for (const angle of [40 * Math.PI / 180, Math.PI / 3, 0.05]) {
    const r = toCreasedNormals(geoDe(pos.slice()), angle);
    ok = memes(normalesPliees(geoDe(pos.slice()), angle).attributes.normal.array, r.attributes.normal.array) && ok;
    essais++;
  }
  // Sphère englobante.
  const g = geoDe(pos.slice());
  sphereEnglobante(g);
  ok = g.boundingSphere.center.equals((ref.computeBoundingSphere(), ref.boundingSphere.center))
       && g.boundingSphere.radius === ref.boundingSphere.radius && ok;
  essais += 2;
}
// Indexées : un terrain (PlaneGeometry) relevé deux fois de suite — la seconde
// remet à zéro les normales existantes —, et une face qui répète un sommet.
for (const seg of [16, 64]) {
  const a = new THREE.PlaneGeometry(300, 200, seg, seg), b = a.clone();
  for (let passe = 0; passe < 2; passe++) {
    for (let i = 0; i < a.attributes.position.count; i++) {
      const y = 50 * hasard() - 25;
      a.attributes.position.array[3 * i + 2] = y; b.attributes.position.array[3 * i + 2] = y;
    }
    a.computeVertexNormals(); normalesIndexees(b);
    ok = memes(a.attributes.normal.array, b.attributes.normal.array) && ok;
    essais++;
  }
}
{
  const pos = new Float32Array([0, 0, 0, 1, 0.2, 0, 0, 0.3, 1, 1, 1, 1]);
  const a = geoDe(pos.slice()), b = geoDe(pos.slice());
  a.setIndex([0, 1, 2, 1, 3, 2, 0, 0, 3, 2, 3, 2]); b.setIndex([0, 1, 2, 1, 3, 2, 0, 0, 3, 2, 3, 2]);
  a.computeVertexNormals(); normalesIndexees(b);
  ok = memes(a.attributes.normal.array, b.attributes.normal.array) && ok;
  essais++;
}
console.log(`${ok ? 'OK ' : 'KO '} normales et sphères de la page contre three.js : ${essais} essais, ${ok ? 'identiques à l\'octet' : 'DIFFÉRENTES'}`);
tout = tout && ok;
}

// --- Tampon des houppiers ----------------------------------------------------------
// La page d'origine (bc716ba) sert de référence : son tampon, en tableaux
// JavaScript et computeVertexNormals, et son ajouterHouppier, dont la boucle
// d'anneaux tirait le lobage (th, bosse) et ses cosinus et sinus à chaque
// anneau. La page les calcule une fois par houppier, et écrit dans des
// tableaux typés : elle doit rendre les mêmes octets, à la taille exacte
// annoncée par facesHouppier comme en s'agrandissant. Prendre des deux côtés
// l'ajouterHouppier de la page laissait passer tout écart dans sa boucle.
// Une forme de houppier changée exprès se reporte ici, dans la référence.
// Le tampon est désormais indexé, et le houppier ne pose plus les triangles
// dégénérés contre son sommet et le centre de son dessous : remise à plat,
// sa géométrie doit rendre les positions, couleurs, bases et éléments de la
// référence privée de ces triangles, à l'octet ; ses normales sont celles de
// computeVertexNormals sur la géométrie indexée.
{
function ajouterHouppierOrigine(tampon, el, sol) {
  const port = portDe(el);
  const h = el.h;
  const p = el.profil && el.profil.length ? el.profil : [1, 0.9, 0.8, 0.7, 0.6, 0.5];
  const nb = p.length;
  const etirement = Math.sqrt(Math.max(el.allongement || 1, 1));
  const rBase = Math.max(el.r * EMPRISE_HOUPPIER, 0.5);
  const a = rBase * etirement;
  const b = Math.max(rBase / etirement, 0.4);
  const axe = (el.axe_deg || 0) * Math.PI / 180;
  const hBase = h >= HAUTEUR_MIN_TRONC ? h * port.tronc : 0;
  const hMin = hBase + Math.max(0.4, h * 0.08);
  const g = alea(el.lon, el.lat);
  const teinte = 0.9 + g * 0.2;
  const anneaux = [{ u: 0, y: h }];
  for (let k = 0; k < nb; k++) anneaux.push({ u: (k + 0.5) / nb, y: Math.max(p[k] * h, hMin) });
  const yBord = Math.max(p[nb - 1] * h - Math.min(0.8, (h - hBase) * 0.08), hBase + 0.3);
  anneaux.push({ u: 1.0, y: yBord });
  const montee = Math.min(0.6, (h - hBase) * 0.04);
  anneaux.push({ u: 1.0, y: hBase });
  anneaux.push({ u: 0.6, y: hBase + montee * 0.7 });
  anneaux.push({ u: 0, y: hBase + montee });
  const couleur = new THREE.Color();
  const cx = el.x, cz = -el.y;
  const cosA = Math.cos(axe), sinA = Math.sin(axe);
  const pts = [];
  for (let i = 0; i < anneaux.length; i++) {
    const { u, y } = anneaux[i];
    const t = (y - hBase) / Math.max(h - hBase, 0.1);
    couleur.copy(port.base).lerp(port.cime, Math.max(0, Math.min(1, t))).multiplyScalar(teinte);
    const ligne = [];
    const interieur = u > 0 && u < 1;
    for (let s = 0; s < SEGMENTS_HOUPPIER; s++) {
      const th = s / SEGMENTS_HOUPPIER * Math.PI * 2;
      const bosse = 1 + 0.10 * Math.sin(3 * th + g * 6.28)
                      + 0.08 * (alea(el.lon + s, el.lat) - 0.5);
      const ex = a * u * bosse * Math.cos(th), ez = b * u * bosse * Math.sin(th);
      const x = cx + ex * cosA - ez * sinA;
      const z = cz - (ex * sinA + ez * cosA);
      const dy = interieur
        ? (alea(el.lat + i, el.lon + s) - 0.5) * Math.min(0.9, (h - hBase) * 0.07)
        : 0;
      ligne.push(tampon.sommet(x, sol + y + dy, z, couleur));
    }
    pts.push(ligne);
  }
  let faces = 0;
  for (let i = 0; i + 1 < anneaux.length; i++) {
    for (let s = 0; s < SEGMENTS_HOUPPIER; s++) {
      const s1 = (s + 1) % SEGMENTS_HOUPPIER;
      tampon.face(pts[i][s], pts[i + 1][s], pts[i + 1][s1]);
      tampon.face(pts[i][s], pts[i + 1][s1], pts[i][s1]);
      faces += 2;
    }
  }
  return faces;
}
function ancienTampon() {
  const sommets = [], positions = [], couleurs = [], elements = [];
  let courant = 0;
  return {
    element(n) { courant = n; },
    sommet(x, y, z, c) { sommets.push([x, y, z, c.r, c.g, c.b, courant]); return sommets.length - 1; },
    face(i, j, k) {
      for (const n of [i, j, k]) { const s = sommets[n]; positions.push(s[0], s[1], s[2]); couleurs.push(s[3], s[4], s[5]); elements.push(s[6]); }
    },
    geometrie() {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(couleurs, 3));
      geo.computeVertexNormals();
      geo.userData.baseY = Float32Array.from(positions.filter((_, i) => i % 3 === 1));
      geo.userData.elements = Int32Array.from(elements);
      return geo;
    },
  };
}
let graine = 777;
const hasard = () => ((graine = (Math.imul(graine, 1103515245) + 12345) >>> 0) / 4294967296);
const elements = Array.from({ length: 300 }, (_, k) => {
  const nb = [0, 4, 6, 8, 11][k % 5];
  const profil = Array.from({ length: nb }, (_, i) => 1 - i / (nb + 1) - 0.1 * hasard());
  const lon = 2 + (hasard() - 0.5) * 0.01, lat = 45 + (hasard() - 0.5) * 0.01;
  const [x, y] = toLocal(lon, lat);
  return { lon, lat, x, y, h: 1 + 25 * hasard(), r: 0.5 + 6 * hasard(), allongement: 1 + 2 * hasard(),
           axe_deg: 360 * hasard(), profil, classe: k % 3 ? 'vegetation' : 'sursol',
           essence: ['Pin', 'Chêne', 'Mixte', ''][k % 4], nature: ['Bois', 'Haie', ''][k % 3] };
});
// Base à 0, comme la page (construireVegetation) : placerVegetation la pose.
const construireAvec = (tampon, ajouter = ajouterHouppier) => {
  let faces = 0;
  elements.forEach((el, n) => { tampon.element(n); faces += ajouter(tampon, el, 0); });
  return { geo: tampon.geometrie(), faces };
};
const memes = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength),
                                                                 Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0;
const ATTRIBUTS = ['position', 'color', 'baseY', 'elements'];
// Triangles à plat de l'ancien tampon, sans les dégénérés (deux sommets
// confondus) : position, couleur, normale, base et élément de chaque sommet.
function sansDegeneres(geo) {
  const P = geo.attributes.position.array;
  const meme = (i, j) => P[3 * i] === P[3 * j] && P[3 * i + 1] === P[3 * j + 1] && P[3 * i + 2] === P[3 * j + 2];
  const garde = [];
  for (let t = 0; t < P.length / 9; t++) if (!meme(3 * t, 3 * t + 1) && !meme(3 * t + 1, 3 * t + 2) && !meme(3 * t, 3 * t + 2)) garde.push(t);
  const pris = (src, k) => { const r = new src.constructor(3 * k * garde.length); garde.forEach((t, n) => r.set(src.subarray(3 * k * t, 3 * k * (t + 1)), 3 * k * n)); return r; };
  return { position: pris(P, 3), color: pris(geo.attributes.color.array, 3), normal: pris(geo.attributes.normal.array, 3),
           baseY: pris(geo.userData.baseY, 1), elements: pris(geo.userData.elements, 1), faces: garde.length };
}
// Triangles à plat du tampon indexé de la page.
function aPlat(geo) {
  const I = geo.index.array, P = geo.attributes.position.array, C = geo.attributes.color.array;
  const r = { position: new Float32Array(3 * I.length), color: new Float32Array(3 * I.length),
              baseY: new Float32Array(I.length), elements: new Int32Array(I.length), faces: I.length / 3 };
  I.forEach((v, n) => { r.position.set(P.subarray(3 * v, 3 * v + 3), 3 * n); r.color.set(C.subarray(3 * v, 3 * v + 3), 3 * n);
                        r.baseY[n] = geo.userData.baseY[v]; r.elements[n] = geo.userData.elements[v]; });
  return r;
}
// La page d'origine entière, tampon et houppier : la référence.
const ref = construireAvec(ancienTampon(), ajouterHouppierOrigine);
const refPleine = sansDegeneres(ref.geo);
// Le houppier de la page seul, dans l'ancien tampon : un écart ici est dans
// sa boucle d'anneaux, pas dans le tampon.
const seul = construireAvec(ancienTampon());
const aplatiSeul = { position: seul.geo.attributes.position.array, color: seul.geo.attributes.color.array,
                     normal: seul.geo.attributes.normal.array, ...seul.geo.userData };
const okH = seul.faces === refPleine.faces && ATTRIBUTS.concat('normal').every(n => memes(aplatiSeul[n], refPleine[n]));
console.log(`${okH ? 'OK ' : 'KO '} houppiers de la page contre la boucle d'anneaux d'origine (bc716ba) : ${elements.length} éléments, ${seul.faces} faces `
            + `(${ref.faces - refPleine.faces} dégénérées en moins), ${okH ? 'identiques à l\'octet' : 'DIFFÉRENTS'}`);
// Puis le tampon indexé : la page d'aujourd'hui contre celle d'origine, à la
// taille annoncée comme en s'agrandissant ; un élément par face et par sommet,
// dans l'ordre, sans sommet partagé avec un autre élément.
const annonceF = elements.reduce((n, el) => n + facesHouppier(el), 0);
const annonceS = elements.reduce((n, el) => n + sommetsHouppier(el), 0);
let ok = annonceF === refPleine.faces, nbSommets = 0;
for (const t of [nouveauTampon(annonceF, annonceS), nouveauTampon(7), nouveauTampon()]) {
  const { geo } = construireAvec(t), plat = aPlat(geo);
  ok = ok && ATTRIBUTS.every(n => memes(plat[n], refPleine[n])) && geo.attributes.position.count === annonceS;
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', geo.attributes.position.clone());
  r.setIndex(geo.index.clone());
  r.computeVertexNormals();
  ok = ok && memes(geo.attributes.normal.array, r.attributes.normal.array);
  const { facesDebut, sommetsDebut } = geo.userData, I = geo.index.array;
  let f = 0, s = 0;
  elements.forEach((el, n) => {
    ok = ok && facesDebut[n] === f && sommetsDebut[n] === s;
    for (let i = 3 * f; i < 3 * (f + facesHouppier(el)); i++) ok = ok && I[i] >= s && I[i] < s + sommetsHouppier(el);
    f += facesHouppier(el); s += sommetsHouppier(el);
  });
  nbSommets = geo.attributes.position.count;
}
console.log(`${ok ? 'OK ' : 'KO '} tampon indexé des houppiers : ${elements.length} éléments, ${annonceF} faces et ${nbSommets} sommets (${annonceS} annoncés) `
            + `pour ${3 * ref.faces} sommets à plat, identique à l'ancien en tableaux JavaScript une fois remis à plat`);
tout = tout && okH && ok;

// Masses retirées par les ouvrages : la géométrie recopiée d'un maillage déjà
// posé sur le relief doit être celle du tampon pour les éléments restants.
const construireListe = liste => {
  const t = nouveauTampon(liste.reduce((n, el) => n + facesHouppier(el), 0),
                          liste.reduce((n, el) => n + sommetsHouppier(el), 0));
  liste.forEach((el, n) => { t.element(n); ajouterHouppier(t, el, 0); });
  return t.geometrie();
};
const complet = construireListe(elements);
// Posé comme par placerVegetation : chaque élément relevé de son sol.
const sols = elements.map(() => Math.fround(300 * hasard()));
const pY = complet.attributes.position.array, bY = complet.userData.baseY, qE = complet.userData.elements;
for (let i = 0; i < qE.length; i++) pY[3 * i + 1] = bY[i] + sols[qE[i]];
const mesh = { geometry: complet, userData: { elements } };
const restants = elements.filter((_, k) => k % 3 !== 1 && k !== elements.length - 1);
const extrait = vegetationExtraite(mesh, restants), attendu = construireListe(restants);
let okE = !!extrait && memes(extrait.index.array, attendu.index.array);
for (const n of ['position', 'color', 'normal']) okE = okE && memes(extrait.attributes[n].array, attendu.attributes[n].array);
for (const n of ['baseY', 'elements', 'facesDebut', 'sommetsDebut']) okE = okE && memes(extrait.userData[n], attendu.userData[n]);
okE = okE && vegetationExtraite(mesh, [elements[5], elements[2]]) === null;          // hors d'ordre
console.log(`${okE ? 'OK ' : 'KO '} végétation sans les masses retirées : ${restants.length} éléments sur ${elements.length}, recopiés à l'identique de la reconstruction`);
tout = tout && okE;

// Formes détaillée et simple, la seconde dessinée pendant le mouvement quand
// la vue rame : chaque houppier fermé — chaque arête portée par deux
// triangles, en sens opposés —, tourné vers l'extérieur (volume positif), au
// nombre de faces annoncé ; la forme simple culmine à la hauteur mesurée,
// comme le sommet de la forme détaillée (le grain d'une couronne intérieure
// peut, lui, la dépasser).
{
  // Les éléments du tampon, et des profils courts : une à trois couronnes,
  // où le quart et les trois quarts du rayon tombent entre deux d'entre elles.
  const essais = elements.concat(elements.slice(0, 30).map((el, k) => ({
    ...el, profil: el.profil.length ? el.profil.slice(0, 1 + k % 3) : [0.9] })));
  const parElement = (geo, f) => {
    const pos = geo.attributes.position.array, quel = geo.userData.elements, I = geo.index.array;
    const tris = essais.map(() => []);
    const p = v => [pos[3 * v], pos[3 * v + 1], pos[3 * v + 2]];
    for (let t = 0; t < I.length / 3; t++) tris[quel[I[3 * t]]].push([p(I[3 * t]), p(I[3 * t + 1]), p(I[3 * t + 2])]);
    return tris.map(f);
  };
  const bilan = tris => {
    const cle = v => v.map(x => x.toFixed(5)).join(',');
    const aretes = new Map();
    let volume = 0;
    for (const [a, b, c] of tris) {
      volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) { const k = cle(u) + '>' + cle(v); aretes.set(k, (aretes.get(k) || 0) + 1); }
    }
    let defauts = 0;
    for (const [k, n] of aretes) {
      const [u, v] = k.split('>');
      if (u !== v && (n !== 1 || aretes.get(v + '>' + u) !== 1)) defauts++;
    }
    return { volume, defauts, sommet: Math.max(...tris.flat().map(v => v[1])) };
  };
  const td = nouveauTampon();
  let annonceD = true;
  essais.forEach((el, n) => { td.element(n); if (ajouterHouppier(td, el, 0) !== facesHouppier(el)) annonceD = false; });
  const detailles = parElement(td.geometrie(), bilan);
  const ouvertsD = detailles.filter(b => b.defauts).length, retournesD = detailles.filter(b => !(b.volume > 0)).length;
  const okD = annonceD && !ouvertsD && !retournesD;
  console.log(`${okD ? 'OK ' : 'KO '} houppiers détaillés : ${essais.length} éléments dont ${essais.length - elements.length} à profil court, `
              + `ouverts ${ouvertsD}, retournés ${retournesD}`);
  const t = nouveauTampon(essais.length * facesHouppierSimple(), essais.length * sommetsHouppierSimple());
  let annonce = true;
  essais.forEach((el, n) => { t.element(n); if (ajouterHouppierSimple(t, el, 0) !== facesHouppierSimple()) annonce = false; });
  const geoS = t.geometrie();
  annonce = annonce && geoS.attributes.position.count === essais.length * sommetsHouppierSimple();
  const simples = parElement(geoS, bilan);
  const ouverts = simples.filter(b => b.defauts).length, retournes = simples.filter(b => !(b.volume > 0)).length;
  const sommets = simples.filter((b, k) => Math.abs(b.sommet - essais[k].h) > 1e-4).length;
  const okS = annonce && !ouverts && !retournes && !sommets;
  console.log(`${okS ? 'OK ' : 'KO '} houppiers simples : ${essais.length} éléments dont ${essais.length - elements.length} à profil court, ${facesHouppierSimple()} faces chacun `
              + `contre ${complet.index.count / 3 / elements.length} en moyenne, ouverts ${ouverts}, `
              + `retournés ${retournes}, sommet hors de la hauteur mesurée ${sommets}`);
  tout = tout && okD && okS;
}
}

// --- Barre d'avancement ---------------------------------------------------------
// Pas de la géométrie, mais du code de la page qu'aucun test Python ne voit.
// partConstruite suppose que les deux dernières étapes du serveur sont les
// toitures et les houppiers (vue3d/scene.py) : lu là-bas, pas recopié ici.
{
const scene = fs.readFileSync(fileURLToPath(new URL('../vue3d/scene.py', import.meta.url)), 'utf8');
const total = Number(/^ETAPES_SCENE = (\d+)$/m.exec(scene)?.[1]);
const calculs = (/^ETAPES_DE_CALCUL = \(([^)]*)\)/m.exec(scene)?.[1].match(/"[^"]*"/g) || []).length;
const parts = Array.from({ length: total }, (_, k) => partConstruite(k + 1, total));
const croissante = parts.every((p, k) => k === 0 || p > parts[k - 1]);
const ok = total > 2 && calculs === 2 && parts[0] === 0 && croissante && parts[total - 1] < 1
           && parts[total - 2] === PART_LECTURES && parts[total - 3] < PART_LECTURES;
console.log(`${ok ? 'OK ' : 'KO '} barre d'avancement : ${total} étapes dont ${calculs} de calcul, `
            + `${parts.map(p => Math.round(100 * p)).join(' ')} %`);
tout = tout && ok;
}

process.exit(tout ? 0 : 1);
