// Essai de la vue en voiture (static/voiture.html) dans un vrai navigateur :
// une conduite simulée (?simu=1), suivie pendant `duree` secondes. Relève
// toutes les cinq secondes la position, la route prévue, la limitation
// affichée et sa source, les carrés de bâtiments (lus, construits, prêts
// devant la voiture), les tuiles du sol et les images par seconde ; échoue à la moindre erreur JavaScript, à un carré
// refusé par le serveur, ou si les bâtiments ne sont jamais prêts devant.
//
//   npm install puppeteer-core
//   node outils/essai-voiture.mjs "http://localhost:8080/voiture?simu=1&lat=48.8706&lon=2.3055&vitesse=50" 60 voiture.png
//
// CHROME désigne l'exécutable de Chrome ou Chromium ; par défaut celui de
// macOS, rendu par Metal (ANGLE=swiftshader pour le rendu logiciel).
import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://localhost:8080/voiture?simu=1&lat=48.8706&lon=2.3055&vitesse=50';
const duree = Number(process.argv[3] || 60);
const sortie = process.argv[4] || 'voiture.png';
const angle = process.env.ANGLE || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const navigateur = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: [`--use-angle=${angle}`, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
           '--autoplay-policy=no-user-gesture-required'],
});
const page = await navigateur.newPage();
await page.setViewport({ width: 1280, height: 800 });
const erreurs = [];
const carres = { lus: 0, caches: 0, refus: 0 };
// Un 503 est un refus passager de la Géoplateforme : la page redemande le
// carré plus tard. Il n'est une erreur que s'il n'a jamais été rattrapé.
const passagers = new Map();          // URL → rattrapée
const tuiles = { absentes: 0 };
// Les limitations (/api/vitesses) et la signalisation (/api/signalisation)
// viennent d'Overpass, en panne par épisodes : un refus du serveur y est
// compté, pas tenu pour une erreur.
const vitesses = { lus: 0, refus: 0 }, signalisation = { lus: 0, refus: 0 };
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
page.on('console', m => {
    if (m.type() !== 'error') return;
    // Une tuile du fond refusée par l'IGN : la page la fait relire, ou prend
    // celle d'un ancêtre ; jugée par sa réponse, plus bas.
    if (/api\/tuile|data\.geopf\.fr\/wmts|Failed to load resource/.test(m.text() + (m.location()?.url || ''))) return;
    erreurs.push('console: ' + m.text());
});
page.on('requestfailed', r => {
    if (/api\/tuile|data\.geopf\.fr/.test(r.url())) return;
    erreurs.push('échec requête: ' + r.url().slice(0, 100) + ' ' + (r.failure()?.errorText || ''));
});
page.on('response', r => {
    const u = r.url();
    if (/\/api\/vitesses\?/.test(u)) {
        if (r.status() === 200) vitesses.lus++; else if (r.status() !== 304) vitesses.refus++;
        return;
    }
    if (/\/api\/signalisation\?/.test(u)) {
        if (r.status() === 200) signalisation.lus++; else if (r.status() !== 304) signalisation.refus++;
        return;
    }
    if (/\/api\/(carre|vegetation)\?/.test(u)) {
        if (r.status() === 200) {
            if (/carre/.test(u)) { if (r.fromCache()) carres.caches++; else carres.lus++; }
            if (passagers.has(u)) passagers.set(u, true);
        } else if (r.status() === 503) passagers.set(u, passagers.get(u) || false);
        else if (r.status() !== 304) { carres.refus++; erreurs.push(`HTTP ${r.status()} ${u.slice(0, 100)}`); }
        return;
    }
    if (/\/api\/tuile\//.test(u)) { if (r.status() === 404) tuiles.absentes++; return; }
    if (/data\.geopf\.fr\/wmts/.test(u)) return;
    if (r.status() >= 400) erreurs.push(`HTTP ${r.status()} ${u.slice(0, 100)}`);
});
// Images comptées dans la page : un compteur posé avant son script.
await page.evaluateOnNewDocument(() => {
    window.__images = 0;
    const compter = () => { window.__images++; requestAnimationFrame(compter); };
    requestAnimationFrame(compter);
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__voiture, { timeout: 30000 });

const releves = [];
let images0 = await page.evaluate(() => window.__images), t0 = Date.now(), depart = null;
for (let t = 5; t <= duree; t += 5) {
    await new Promise(r => setTimeout(r, 5000));
    const e = await page.evaluate(() => {
        const V = window.__voiture, v = V.voiture;
        let lus = 0, construits = 0, montres = 0, batiments = 0;
        for (const c of V.carres.values()) {
            if (c.etat === 'pret') lus++;
            if (c.mesh) { construits++; if (c.mesh.visible) { montres++; batiments += c.nbBatiments; } }
        }
        let solMontrees = 0;
        for (const t of V.tuilesSol.values()) if (t.mesh && t.mesh.visible) solMontrees++;
        const info = V.renderer.info;
        return {
            vue: v.vue, x: v.x, y: v.y, v: v.v * 3.6, horsRoute: v.horsRoute,
            chemin: v.chemin ? { longueur: v.chemin.longueur, fin: v.chemin.fin } : null,
            lus, construits, montres, batiments, aretes: V.aretes.size,
            sol: V.tuilesSol.size, solMontrees, triangles: info.render.triangles, appels: info.render.calls,
            textures: info.memory.textures, geometries: info.memory.geometries,
            rue: document.getElementById('rue-nom').textContent,
            numero: document.getElementById('rue-numero').hidden ? '' : document.getElementById('rue-numero').textContent,
            pret: document.getElementById('etat-carres').textContent,
            limite: document.getElementById('limite').hidden ? '' :
                `${document.getElementById('limite-v').textContent} (${document.getElementById('limite-source').textContent})`,
            signal: document.getElementById('signal').hidden ? '' :
                `${document.getElementById('signal').className} à ${document.getElementById('signal-d').textContent}`,
            images: window.__images, budget: V.budget,
        };
    });
    const ips = (e.images - images0) / ((Date.now() - t0) / 1000);
    images0 = e.images; t0 = Date.now();
    if (e.vue && !depart) depart = { x: e.x, y: e.y };
    const parcouru = depart ? Math.hypot(e.x - depart.x, e.y - depart.y) : 0;
    releves.push({ ...e, ips, parcouru });
    console.log(`${String(t).padStart(3)} s  ${e.vue ? `${e.v.toFixed(0)} km/h` : 'sans position'}`
        + `  ${e.numero ? e.numero + ' ' : ''}${e.rue || '—'}${e.horsRoute ? ' (hors route)' : ''}`
        + `${e.limite ? `  · limite ${e.limite}` : ''}`
        + `${e.signal ? `  · ${e.signal}` : ''}`
        + `  à ${Math.round(parcouru)} m du départ`
        + `  · chemin ${e.chemin ? Math.round(e.chemin.longueur) + ' m ' + e.chemin.fin : '—'}`
        + `  · carrés ${e.lus} lus, ${e.construits} construits, ${e.montres} montrés (${e.batiments} bât.)`
        + `  · ${e.pret}`
        + `  · sol ${e.solMontrees}/${e.sol}  · ${(e.triangles / 1e3).toFixed(0)} k tri, ${e.appels} appels`
        + `  · ${ips.toFixed(0)} i/s`);
}
await page.screenshot({ path: sortie });
// Durée de construction d'un carré (un par image au plus, carres/selection.js) :
// la médiane et le pire, avec les bâtiments du carré.
const arbres = await page.evaluate(() => {
    let lus = 0, montres = 0, n = 0;
    for (const c of window.__voiture.carres.values()) {
        if (c.veg.etat === 'pret') lus++;
        if (c.veg.mesh && c.veg.mesh.visible) { montres++; n += c.veg.nb; }
    }
    const d = window.__voiture.dureesArbres.slice().sort((a, b) => a[0] - b[0]);
    return { lus, montres, n, mediane: d.length ? d[d.length >> 1][0] : null, pire: d.length ? d[d.length - 1] : null };
});
console.log(`\nArbres : ${arbres.lus} carrés lus, ${arbres.montres} montrés (${arbres.n} arbres)`
    + (arbres.pire ? `, construction médiane ${arbres.mediane.toFixed(1)} ms, pire ${arbres.pire[0].toFixed(1)} ms (${arbres.pire[1]} arbres)` : ''));
const durees = await page.evaluate(() => window.__voiture.durees.slice());
if (durees.length) {
    const tri = durees.slice().sort((a, b) => a[0] - b[0]);
    const pire = tri[tri.length - 1];
    console.log(`\nConstruction d'un carré : médiane ${tri[tri.length >> 1][0].toFixed(1)} ms, `
        + `pire ${pire[0].toFixed(1)} ms (${pire[1]} bâtiments), sur ${tri.length}`);
}
const limites = await page.evaluate(() => {
    let osm = 0, estimees = 0, inconnues = 0;
    for (const l of window.__voiture.limites.values()) {
        for (const [v, o] of [[l.plus, l.osmPlus], [l.moins, l.osmMoins]]) {
            if (v == null) inconnues++; else if (o) osm++; else estimees++;
        }
    }
    return { troncons: window.__voiture.limites.size, osm, estimees, inconnues };
});
console.log(`\nLimitations : ${vitesses.lus} carrés lus, ${vitesses.refus} refusés (Overpass) ; ${limites.troncons} tronçons, `
    + `sens par sens ${limites.osm} OpenStreetMap, ${limites.estimees} estimées, ${limites.inconnues} inconnues`);
const panneaux = await page.evaluate(() => {
    const n = {};
    for (const l of window.__voiture.signaux.values()) for (const e of l) n[e.type] = (n[e.type] || 0) + 1;
    return n;
});
console.log(`Signalisation : ${signalisation.lus} carrés lus, ${signalisation.refus} refusés (Overpass) ; `
    + (Object.entries(panneaux).map(([t, k]) => `${k} ${t}`).join(', ') || 'aucun panneau'));
console.log(`\nCarrés : ${carres.lus} lus au serveur, ${carres.caches} du cache du navigateur, ${carres.refus} refusés ; `
    + `tuiles absentes : ${tuiles.absentes}. Capture : ${sortie}`);
const rattrapes = [...passagers.values()].filter(Boolean).length;
if (passagers.size) console.log(`Refus passagers (503) : ${passagers.size}, dont ${rattrapes} rattrapés`);
for (const [u, ok] of passagers) if (!ok) erreurs.push(`503 jamais rattrapé : ${u.slice(0, 100)}`);
const roule = releves.filter(r => r.vue && r.chemin);
if (!roule.length) erreurs.push('la voiture n\'a jamais été calée sur une route');
else if (!roule.slice(-3).some(r => /prêts sur/.test(r.pret) && !/prêts sur 0 m/.test(r.pret))) {
    erreurs.push('aucun bâtiment prêt devant la voiture en fin d\'essai');
}
console.log(erreurs.length ? `ERREURS :\n  ${erreurs.join('\n  ')}` : 'ERREURS : aucune');
await navigateur.close();
process.exit(erreurs.length ? 1 : 0);
