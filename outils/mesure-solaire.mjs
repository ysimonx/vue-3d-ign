// Mesure l'ensoleillement des toits dans Chrome, sur la carte graphique de la
// machine (Metal sous macOS) : durée du calcul, taille de la grille, et
// répartition des cellules de toit — leur part du meilleur plan dégagé du
// lieu, qui règle la palette (PALETTE_BAS) et le seuil favorable, et leur part
// de ce qu'elles recevraient sans aucune ombre.
//
//   npm install puppeteer-core
//   node outils/mesure-solaire.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003" [autre lieu…]
//
// CHROME désigne l'exécutable de Chrome ou Chromium ; par défaut celui de macOS.
import puppeteer from 'puppeteer-core';

const urls = process.argv.slice(2);
if (!urls.length) urls.push('http://localhost:8080/?lat=43.9116&lon=5.2003');
const navigateur = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  // La vraie carte graphique : sous SwiftShader, le calcul prend des minutes.
  args: ['--use-angle=metal', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1400, height: 900 },
});
let tout = true;
for (const url of urls) {
  const page = await navigateur.newPage();
  const erreurs = [];
  page.on('pageerror', e => erreurs.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.getElementById('s-total').textContent !== '—', { timeout: 15 * 60 * 1000 });
  const fin = new Promise(ok => page.on('console', m => { if (/^Ensoleillement : \d+ ms/.test(m.text())) ok(m.text()); }));
  await page.click('#t-solaire');
  console.log(`\n## ${url}\n- ${await fin}`);
  console.log(await page.evaluate(async () => {
    const { etatSolaire } = await import('/static/js/scene/couches/solaire.js');
    const { resultat: r, ciel } = etatSolaire();
    const o = ciel.optimum.e;
    const parts = [], ombres = [];
    for (let p = 0; p < r.W * r.H; p++) {
      if (r.valeurs[p] > 0) { parts.push(r.valeurs[p] / o); ombres.push(r.valeurs[p] / r.sansOmbres[p]); }
    }
    const centiles = t => {
      const u = Float64Array.from(t).sort();
      return [5, 10, 25, 50, 75, 90, 95, 99].map(c => `p${c} ${u[Math.floor(c / 100 * (u.length - 1))].toFixed(3)}`).join(', ');
    };
    return `- ${parts.length} cellules de toit, ${r.total.toits} bâtiments ; meilleur plan dégagé `
      + `${o.toFixed(0)} kWh/m²/an (${ciel.optimum.pente}° vers ${ciel.optimum.orientation}°)\n`
      + `- part de l'optimum : ${centiles(parts)}\n`
      + `- part de la valeur sans ombre : ${centiles(ombres)} ; `
      + `sans aucune perte : ${(100 * ombres.filter(x => x > 0.99).length / ombres.length).toFixed(1)} %`;
  }));
  if (erreurs.length) { tout = false; console.log('- ERREURS : ' + erreurs.join(' | ')); }
  await page.close();
}
await navigateur.close();
process.exit(tout ? 0 : 1);
