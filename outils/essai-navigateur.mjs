// Essai de la page dans un vrai navigateur : charge un point, attend la scène,
// survole et clique le bâtiment visé, bascule au 21 décembre, pilote le drone
// quelques mètres, décale la scène vers le nord, cherche un lieu
// (« place du chateau gordes ») et s'y rend, et relève toute erreur JavaScript
// ou requête en échec. C'est le seul moyen de vérifier les
// chemins d'exécution du rendu, que les tests Python ne voient pas.
//
//   npm install puppeteer-core
//   node outils/essai-navigateur.mjs "http://localhost:8080/?lat=43.9116&lon=5.2003" capture.png
//
// CHROME désigne l'exécutable de Chrome ou Chromium ; par défaut celui de macOS.
import puppeteer from 'puppeteer-core';
const url = process.argv[2] || 'http://localhost:8080/';
const sortie = process.argv[3] || 'capture.png';
const navigateur = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await navigateur.newPage();
await page.setViewport({ width: 1400, height: 850 });
const erreurs = [];
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') erreurs.push('console: ' + m.text()); });
// Une fois la page quittée pour le lieu cherché, ses requêtes en cours sont
// interrompues : c'est attendu.
let quittee = false;
page.on('requestfailed', r => {
  if (quittee && r.failure()?.errorText === 'net::ERR_ABORTED') return;
  erreurs.push('échec requête: ' + r.url().slice(0, 100) + ' ' + (r.failure()?.errorText || ''));
});
page.on('response', r => { if (r.status() >= 400) erreurs.push(`HTTP ${r.status()} ${r.url().slice(0, 100)}`); });
await page.goto(url, { waitUntil: 'domcontentloaded' });
// Attend la scène, puis la végétation et le relief.
await page.waitForFunction(() => document.getElementById('attente').hidden
                          || /indisponible/.test(document.getElementById('attente').textContent),
                          { timeout: 120000 });
await new Promise(r => setTimeout(r, 12000));
const etat = await page.evaluate(() => ({
  attente: document.getElementById('attente').hidden ? '(masqué)' : document.getElementById('attente').textContent,
  batiments: document.getElementById('note').textContent,
  terrain: document.getElementById('s-src').textContent + ' · ' + document.getElementById('s-amp').textContent,
  vegetation: document.getElementById('v-note').textContent.slice(0, 160),
  soleil: document.getElementById('s-date').textContent + ' · ' + document.getElementById('s-hauteur').textContent,
  nom: document.getElementById('nom-point').hidden ? '(aucun)' : document.getElementById('nom-point').textContent,
  // Sans carte graphique (SwiftShader), l'orbite rame : le conseil vient.
  conseil: document.getElementById('conseil-veg').hidden ? '(aucun)'
         : document.querySelector('#conseil-veg span').textContent,
}));
console.log(JSON.stringify(etat, null, 1));
// Arrête l'orbite, puis survole et clique au centre (bâtiment visé).
await page.click('#t-orbit');
// L'orbite avance d'un cran par image : là où elle s'arrête dépend de la vitesse
// du rendu, et un arbre peut alors masquer le bâtiment visé (constaté à Gordes,
// un feuillu de 9 m devant lui). La végétation est masquée pour le clic.
if (await page.$eval('#t-veg', e => e.classList.contains('on'))) await page.click('#t-veg');
const cadre = await page.$eval('#scene canvas', c => { const r = c.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
// La fiche du bâtiment visé s'ouvre d'elle-même : on la relève, puis on la
// vide pour que le clic soit réellement éprouvé.
console.log('fiche à l\'ouverture :', (await page.$eval('#fiche-batiment', e => e.textContent.trim())).slice(0, 120) || '(vide)');
console.log('note :', await page.$eval('#note-batiment', e => e.textContent));
await page.$eval('#fiche-batiment', e => { e.innerHTML = ''; });
let fiche = '';
for (const [fx, fy] of [[0.5, 0.5], [0.5, 0.45], [0.48, 0.52], [0.52, 0.5], [0.45, 0.48]]) {
  const x = cadre.x + cadre.w * fx, y = cadre.y + cadre.h * fy;
  await page.mouse.move(x, y);
  await new Promise(r => setTimeout(r, 300));
  await page.mouse.click(x, y);
  await new Promise(r => setTimeout(r, 400));
  fiche = await page.$eval('#fiche-batiment', e => e.textContent.trim());
  if (fiche) break;
}
console.log('fiche après clic :', fiche.slice(0, 200) || '(vide)');
// Curseur de saison au 21 décembre, et heure à 13 h.
await page.evaluate(() => document.querySelector('.saison-cran[data-mois="12"]').click());
await page.evaluate(() => { const h = document.getElementById('heure'); h.value = 13; h.dispatchEvent(new Event('input')); });
console.log('soleil au 21 décembre, 13 h :', await page.$eval('#s-date', e => e.textContent), '·', await page.$eval('#s-hauteur', e => e.textContent));
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: sortie });
// DPE et ventes DVF : lus seulement au clic (ADEME, cadastre et fichiers
// DVF), leur section du panneau s'ouvre ; la fiche du bâtiment visé dit
// ses DPE, ou qu'il n'en a pas.
for (const [bouton, section, resume] of [['#t-dpe', '#sec-dpe', '#dpe-resume'], ['#t-dvf', '#sec-dvf', '#dvf-resume']]) {
  try {
    await page.click(bouton);
    await page.waitForFunction(s => !document.querySelector(s).hidden, { timeout: 90000 }, section);
    console.log(`${bouton.slice(3).toUpperCase()} :`, (await page.$eval(resume, e => e.innerText.replace(/\s+/g, ' ').trim())).slice(0, 200));
  } catch (e) {
    erreurs.push(`${bouton} : ` + (await page.$eval('#etat-foncier', e => e.textContent).catch(() => e.message)));
  }
}
console.log('fiche avec DPE :', (await page.$eval('#fiche-batiment', e => e.innerText.replace(/\s+/g, ' '))).match(/DPE.{0,120}/)?.[0] || '(aucun)');
await new Promise(r => setTimeout(r, 800));
await page.screenshot({ path: sortie.replace(/(\.png)?$/, '-dpe-dvf.png') });
// Éteints, pour que la suite voie la page telle qu'elle s'ouvre.
await page.click('#t-dpe');
await page.click('#t-dvf');
// Drone : il décolle, avance tant que la flèche est tenue, dit sa vitesse,
// et Échap rend la main à la souris.
try {
  await page.click('#t-drone');
  await page.keyboard.down('ArrowUp');
  await new Promise(r => setTimeout(r, 2000));
  const hud = await page.$eval('#hud-drone', e => e.hidden ? '' : e.textContent);
  await page.keyboard.up('ArrowUp');
  console.log('drone :', hud || '(pas de télémétrie)');
  if (!(Number((hud.match(/(\d+) km\/h/) || [])[1]) > 0)) erreurs.push('drone : immobile, ' + (hud || 'pas de télémétrie'));
  await page.keyboard.press('Escape');
  await new Promise(r => setTimeout(r, 500));
  if (await page.$eval('#t-drone', e => e.classList.contains('on'))) erreurs.push('drone : Échap ne le quitte pas');
  if (!(await page.$eval('#hud-drone', e => e.hidden))) erreurs.push('drone : télémétrie restée affichée');
} catch (e) {
  erreurs.push('drone : ' + e.message);
}
// Flèche du nord : un quart de zone plus au nord, au pas de la clé du cache ;
// la caméra garde son cap (les pointes des flèches n'ont pas tourné) et
// l'orbite, arrêtée plus haut, ne repart pas.
try {
  const depart = new URL(page.url()).searchParams;
  const zone = Number(depart.get('zone')) || null;
  const demi = zone ? Math.min(Math.max(Math.round(zone / 50) * 50, 150), 1000) / 2 / 111320 : 0.0016;
  const attendu = [Number(depart.get('lat') ?? 43.9116) + demi / 2, Number(depart.get('lon') ?? 5.2003)]
    .map(v => String(Number(v.toFixed(4))));
  const caps = () => page.$$eval('#decalage .pointe', ps => ps.map(p => p.style.transform).join(' '));
  const avant = await caps();
  if (!avant.trim()) erreurs.push('décalage : flèches non posées');
  console.log('flèche du nord :', await page.$eval('#decalage [data-vers="n"]', b => b.title));
  quittee = true;
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
                     page.click('#decalage [data-vers="n"]')]);
  const u = new URL(page.url());
  console.log('après décalage :', u.search);
  if (u.searchParams.get('lat') !== attendu[0] || u.searchParams.get('lon') !== attendu[1]) {
    erreurs.push(`décalage : ${u.search}, attendu lat=${attendu[0]}&lon=${attendu[1]}`);
  }
  await page.waitForFunction(() => !document.getElementById('decalage').hidden, { timeout: 120000 });
  await new Promise(r => setTimeout(r, 1500));
  const apres = await caps();
  if (apres !== avant) erreurs.push(`décalage : cap changé, ${avant} → ${apres}`);
  if (await page.$eval('#t-orbit', e => e.classList.contains('on'))) erreurs.push('décalage : orbite repartie');
} catch (e) {
  erreurs.push('décalage : ' + e.message);
}
// Recherche d'un lieu : suggestions du géocodage de l'IGN, puis Entrée, qui
// mène à la première. Le nom choisi doit suivre, sans passer par l'URL.
await page.type('#in-lieu', 'place du chateau gordes');
try {
  await page.waitForFunction(() => document.querySelector('#suggestions li[role="option"]'), { timeout: 20000 });
  console.log('suggestion :', await page.$eval('#suggestions li', li => li.textContent));
  quittee = true;
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.keyboard.press('Enter')]);
  const u = new URL(page.url());
  const [lat, lon] = [Number(u.searchParams.get('lat')), Number(u.searchParams.get('lon'))];
  console.log('après Entrée :', u.search);
  if (Math.abs(lat - 43.9112) > 0.001 || Math.abs(lon - 5.1997) > 0.001) erreurs.push('recherche : mauvais point ' + u.search);
  if ([...u.searchParams.keys()].some(k => !['lat', 'lon', 'zone'].includes(k))) erreurs.push('recherche : URL ' + u.search);
  await page.waitForFunction(() => !document.getElementById('nom-point').hidden, { timeout: 10000 });
  const nom = await page.$eval('#nom-point', e => e.textContent);
  console.log('nom affiché :', nom);
  if (nom !== 'Place du Château') erreurs.push('recherche : nom affiché « ' + nom + ' »');
} catch (e) {
  erreurs.push('recherche : ' + e.message);
}
console.log('ERREURS :', erreurs.length ? '\n  ' + erreurs.join('\n  ') : 'aucune');
await navigateur.close();
process.exit(erreurs.length ? 1 : 0);
