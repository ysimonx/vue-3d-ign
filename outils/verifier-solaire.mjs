// Vérifie le modèle du ciel de l'ensoleillement des toits en exécutant le vrai
// code de la page (couches/solaire.js, geometrie/astronomie.js) sous Node :
// l'année type que sert le service, réduite en directions du soleil et en
// table du diffus, doit rendre à un plan dégagé ce que PVGIS lui donne.
//
//   npm install three@0.160.0          # ignoré par git, comme puppeteer-core
//   node outils/verifier-solaire.mjs [http://localhost:8080] [lieu…]
//
// Pour chaque lieu (public : Gordes, la tour Eiffel, Chamonix par défaut), le
// climat est lu au service (/api/solaire, qui le lit à PVGIS la première
// fois), la référence à PVcalc de PVGIS : rayonnement annuel dans le plan,
// horizon compris, moyenne 2005-2023. L'année type n'est pas cette moyenne :
// l'écart de leurs globaux horizontaux est ôté avant de comparer.
//
// Sort en erreur si un plan s'écarte de PVGIS de plus de ECART_MAX du meilleur
// plan du lieu — l'échelle de la carte des toits et du seuil favorable —, ou
// si le soleil de l'année type ne passe pas par ses heures.
import * as THREE from 'three';
import zlib from 'zlib';
import { sourceDesModules } from './source-page.mjs';

// Mesuré le 31 octobre 2026 : 2,9 % de l'optimum au plus (un pan sud à 45° de
// Gordes, +3,0 %). Rapporté au plan lui-même, l'écart monte à 6 % sur un pan
// nord à 60° de Paris, qui reçoit 515 kWh/m²/an contre 1 386 au meilleur.
const ECART_MAX = 0.04;
const LIEUX = {
  gordes: [43.9116, 5.2003], 'tour-eiffel': [48.8583, 2.2942], chamonix: [45.9237, 6.8694],
  strasbourg: [48.5819, 7.751],
};
const PLANS = [[0, 0], [15, 0], [30, 0], [30, 90], [30, 270], [45, 180], [60, 0], [15, 225], [30, 135]];

const src = sourceDesModules('scene');
function extraire(nom) {
  const i = src.indexOf(`function ${nom}(`);
  if (i < 0) throw new Error('introuvable dans la page : ' + nom);
  let n = 0;
  for (let j = src.indexOf('{', src.indexOf(')', i)); j < src.length; j++) {
    if (src[j] === '{') n++;
    else if (src[j] === '}' && --n === 0) return src.slice(i, j + 1);
  }
}
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
const NOMS = ['positionSoleil', 'direction', 'normalePlan', 'preparerCiel', 'planDegage', 'diffusTable'];
const CONSTS = ['RAD', 'PAS_SOLEIL_DEG', 'CIEL', 'BORDS_CIEL', 'ALBEDO', 'JOURS_DES_MOIS', 'TABLE_PENTES'];
const { preparerCiel, planDegage, positionSoleil } = new Function(
  'THREE', CONSTS.map(extraireConst).join('\n') + '\n' + NOMS.map(extraire).join('\n')
           + `\nreturn { ${NOMS.join(', ')} };`)(THREE);

const service = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const lieux = process.argv.slice(3).length ? process.argv.slice(3) : Object.keys(LIEUX);
let tout = true;

// PVGIS coupe parfois la connexion (ECONNRESET), d'une requête à l'autre : trois essais.
async function json(url) {
  for (let essai = 1; ; essai++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status} sur ${url}`);
      const octets = Buffer.from(await r.arrayBuffer());
      // fetch décompresse le gzip annoncé ; un corps resté compressé est relu.
      return JSON.parse(octets[0] === 0x1f && octets[1] === 0x8b ? zlib.gunzipSync(octets) : octets);
    } catch (e) {
      if (essai === 3) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

for (const nom of lieux) {
  const [lat, lon] = LIEUX[nom] || nom.split(',').map(Number);
  const climat = await json(`${service}/api/solaire?lat=${lat}&lon=${lon}&zone=1000`);
  const t0 = performance.now();
  const lieu = preparerCiel(climat);
  const duree = performance.now() - t0;

  // Le soleil de l'année type : à midi solaire du 21 juin, sa hauteur doit
  // être 90° − latitude + 23,44°, à quelques centièmes près.
  let midi = -90;
  for (let mn = 0; mn < 24 * 60; mn += 1) {
    midi = Math.max(midi, positionSoleil(new Date(Date.UTC(2021, 5, 21, 0, mn)), lat, lon).hauteur);
  }
  const attendu = 90 - lat + 23.44;
  if (Math.abs(midi - attendu) > 0.1) {
    console.log(`  ✗ ${nom} : soleil au plus haut le 21 juin à ${midi.toFixed(2)}°, ${attendu.toFixed(2)}° attendus`);
    tout = false;
  }

  const ref = {};
  for (const [pente, orientation] of PLANS) {
    // PVGIS : aspect 0 au sud, 90 à l'ouest.
    const aspect = ((orientation - 180 + 540) % 360) - 180;
    const r = await json(`https://re.jrc.ec.europa.eu/api/v5_3/PVcalc?lat=${lat}&lon=${lon}&peakpower=1`
                         + `&loss=14&angle=${pente}&aspect=${aspect}&outputformat=json&usehorizon=1`);
    ref[`${pente},${orientation}`] = r.outputs.totals.fixed['H(i)_y'];
  }
  const k = lieu.global / 1000 / ref['0,0'];
  console.log(`${nom} : ${lieu.faisceaux.length} directions du soleil, ${lieu.ciel.length} du ciel, `
              + `préparées en ${duree.toFixed(0)} ms ; global de l'année type / PVGIS ${k.toFixed(3)} ; `
              + `meilleur plan ${lieu.optimum.e.toFixed(0)} kWh/m²/an, ${lieu.optimum.pente}° vers ${lieu.optimum.orientation}°`);
  for (const [pente, orientation] of PLANS) {
    const e = planDegage(lieu, pente, orientation) / k, r = ref[`${pente},${orientation}`];
    const ecart = (e - r) / (lieu.optimum.e / k), ok = Math.abs(ecart) <= ECART_MAX;
    if (!ok) tout = false;
    console.log(`  ${ok ? '✓' : '✗'} pente ${String(pente).padStart(2)}° vers ${String(orientation).padStart(3)}° : `
                + `${e.toFixed(0)} contre ${r.toFixed(0)} kWh/m²/an, ${(100 * (e / r - 1)).toFixed(1)} %, `
                + `${(100 * ecart).toFixed(1)} % de l'optimum`);
  }
}
console.log(tout ? 'Ensoleillement : modèle conforme à PVGIS.' : 'Ensoleillement : écarts hors tolérance.');
process.exit(tout ? 0 : 1);
