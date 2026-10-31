// Vérifie l'ordre d'évaluation des modules d'une page : celui que donne le
// navigateur (parcours en profondeur des imports, attente de haut niveau
// comprise) doit être celui de son main.js, qui liste les modules dans
// l'ordre de leurs effets — écouteurs, `scene.add`, attentes de la scène.
// Un module qui en importe un autre placé plus loin le fait évaluer plus tôt :
// la page de la scène posait alors le relief avant les bâtiments, ou
// l'inverse, selon l'ordre où leurs attentes de la scène s'inscrivaient.
// Seuls y échappent les modules sans effet au chargement (SANS_EFFET) :
// fonctions et constantes, qu'il est indifférent d'évaluer plus tôt ; ceux
// de js/commun/, partagés par les pages, n'ont que cela.
//
//   node outils/verifier-modules.mjs            # scene et voiture
//   node outils/verifier-modules.mjs scene
//
// Sort en erreur au premier écart, après avoir tout listé.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const JS = fileURLToPath(new URL('../vue3d/static/js/', import.meta.url));
// Évaluables à tout moment : ils ne font que déclarer. interface/tiroir
// écoute Échap sur window comme le drone, mais chacun pour lui (le tiroir ne
// regarde que defaultPrevented, que le drone ne pose pas).
const SANS_EFFET = {
  scene: ['geometrie/normales', 'geometrie/polygones', 'geometrie/astronomie', 'interface/etat-couche', 'vegetation/textures',
          'vegetation/formes', 'interface/tiroir', 'couches/ecarts-toits', 'interface/fiche',
          'batiments/monuments', 'batiments/cible', 'batiments/construction'],
  voiture: [],
};

const IMPORT = /^import\s+(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"];?/gms;
const ATTENTE = /^(?:export\s+)?(?:const|let)\s+\w+\s*=\s*await\s|^await\s/m;

function verifier(page) {
  const racine = path.join(JS, page);
  const principal = path.join(racine, 'main.js');
  const modules = new Map();
  const lire = f => {
    if (modules.has(f)) return modules.get(f);
    const src = fs.readFileSync(f, 'utf8');
    const deps = [...src.matchAll(IMPORT)].map(m => m[1]).filter(s => s.startsWith('.'))
      .map(s => path.resolve(path.dirname(f), s));
    const m = { f, deps, attente: ATTENTE.test(src) };
    modules.set(f, m);
    deps.forEach(lire);
    return m;
  };
  lire(principal);
  const nom = f => path.relative(racine, f).replace(/\.js$/, '');
  // L'ordre voulu : celui des imports de main.js.
  const voulu = modules.get(principal).deps.map(nom);
  // L'ordre du navigateur : post-fixe ; ce qui dépend d'une attente passe après.
  const postfixe = [], vu = new Set();
  const parcourir = f => { if (vu.has(f)) return; vu.add(f); modules.get(f).deps.forEach(parcourir); postfixe.push(f); };
  parcourir(principal);
  const attend = new Map();
  const dependDUneAttente = f => {
    if (attend.has(f)) return attend.get(f);
    attend.set(f, false);
    const m = modules.get(f), v = m.attente || m.deps.some(dependDUneAttente);
    attend.set(f, v);
    return v;
  };
  const reel = [...postfixe.filter(f => !dependDUneAttente(f)), ...postfixe.filter(dependDUneAttente)]
    .filter(f => f.startsWith(racine + path.sep)).map(nom).filter(n => n !== 'main');
  const libres = new Set(SANS_EFFET[page] || []);
  const sansLibres = l => l.filter(n => !libres.has(n));
  const a = sansLibres(voulu), b = sansLibres(reel);
  const ecarts = [];
  a.forEach((n, k) => { if (b[k] !== n) ecarts.push(`${k + 1}. attendu ${n}, évalué ${b[k]}`); });
  const absents = [...modules.keys()].filter(f => f.startsWith(racine + path.sep)).map(nom)
    .filter(n => n !== 'main' && !voulu.includes(n));
  for (const n of absents) ecarts.push(`${n} n'est pas importé par main.js`);
  const propres = [...modules.keys()].filter(f => f.startsWith(racine + path.sep)).length - 1;
  console.log(`${page} : ${propres} modules, ${ecarts.length ? ecarts.length + ' écart(s)' : 'dans l\'ordre de main.js'}`);
  for (const e of ecarts.slice(0, 20)) console.log('  ' + e);
  return ecarts.length === 0;
}

const pages = process.argv.slice(2).length ? process.argv.slice(2)
  : fs.readdirSync(JS).filter(d => fs.existsSync(path.join(JS, d, 'main.js'))).sort();
const ok = pages.map(verifier).every(Boolean);
process.exit(ok ? 0 : 1);
