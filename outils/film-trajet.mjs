// Film monté dans la vue en voiture (static/voiture.html) : des tronçons de
// route choisis, d'un même trajet ou de lieux différents, filmés en conduite
// simulée, avec légendes incrustées, titre, fondus enchaînés et carton de fin.
// Un peu plus d'une minute, au carré (LinkedIn) ou en paysage (YouTube).
//
//   node outils/film-trajet.mjs outils/trajets/provence.json carre
//   node outils/film-trajet.mjs outils/trajets/rousset-saint-antonin.json paysage [sortie.mp4]
//
// SERVEUR (http://localhost:8080) sert la page et les carrés ; CHROME, FPS (30) ;
// TRONCONS=2,5 n'en tourne que ceux-là, pour un essai.
// Sortie par défaut : docs/demo/demo-trajet-<plan>-<cadre>.mp4.
//
// Le plan : l'heure du soleil (la même lumière d'un tronçon à l'autre), et les
// tronçons, repérés en mètres le long d'un itinéraire de la Géoplateforme —
// celui du plan (`depart`, `arrivee`), ou le leur (`route`). Pas celui de la
// page : elle ne cherche son chemin que dans une bande de 400 m autour de la
// droite qui joint départ et arrivée, et Rousset → Saint-Antonin-sur-Bayon
// s'en écarte de 2,2 km. Chaque tronçon est une conduite simulée de `de` vers
// `vers` (mètres, ou "arrivee"), filmée `arret` secondes avant le départ puis
// `duree` secondes ; ou jusqu'à l'arrivée, un `panoramique` éventuel (la vue
// tourne autour de la voiture arrêtée, vers `cap`) tenu `tenue` secondes, et
// pour le dernier le carton de fin, tenu `fin` secondes ; `camera` (tangage,
// recul) la relève, au-dessus des immeubles d'une ville, et son `champ`
// (angle de vue vertical, 55° dans la page) resserré grossit une montagne à
// l'horizon : à 32°, la Sainte-Victoire vue de Rousset, à 6,8 km, est 1,7
// fois plus haute à l'écran. Le cartouche de la
// page dit la distance qui reste jusqu'à l'arrivée de l'itinéraire entier, et
// non du tronçon.
//
// Même horloge figée que film-voiture.mjs : la voiture roule à la vitesse
// exacte du film, le réseau garde son temps réel.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [cheminPlan, cadre = 'carre', sortieDemandee] = process.argv.slice(2);
const CADRES = { carre: { largeur: 1080, hauteur: 1080, police: 38 }, paysage: { largeur: 1920, hauteur: 1080, police: 32 } };
if (!cheminPlan || !CADRES[cadre]) {
    console.error('usage : node outils/film-trajet.mjs <plan.json> carre|paysage [sortie.mp4]');
    process.exit(2);
}
const plan = JSON.parse(fs.readFileSync(cheminPlan, 'utf8'));
const { largeur: LARGEUR, hauteur: HAUTEUR, police: P } = CADRES[cadre];
const SERVEUR = process.env.SERVEUR || 'http://localhost:8080';
const FPS = Number(process.env.FPS || 30);
const FONDU_S = 0.5;                    // entre deux tronçons
const ELAN_S = 2.5;                     // un tronçon après le premier commence lancé
const sortie = sortieDemandee || `docs/demo/demo-trajet-${path.basename(cheminPlan, '.json')}-${cadre}.mp4`;
// Le film montre la vue en voiture : « Essayez-la » mène à elle, pas à l'accueil.
const SITE = 'vue-3d-ign.kysoe.com/voiture', DEPOT = 'github.com/ysimonx/vue-3d-ign', LINKEDIN = 'linkedin.com/in/ysimon';

// --- Les itinéraires de la Géoplateforme --------------------------------------------------------
const itineraires = new Map();
/** L'itinéraire en voiture de `depart` à `arrivee` ({ lat, lon, nom }) : sa longueur, et pointA(s). */
async function itineraire(depart, arrivee) {
    const cle = JSON.stringify([depart, arrivee]);
    if (itineraires.has(cle)) return itineraires.get(cle);
    const url = new URL('https://data.geopf.fr/navigation/itineraire');
    for (const [k, v] of Object.entries({ resource: 'bdtopo-osrm', profile: 'car', optimization: 'fastest',
        geometryFormat: 'geojson', start: `${depart.lon},${depart.lat}`, end: `${arrivee.lon},${arrivee.lat}` })) {
        url.searchParams.set(k, v);
    }
    const route = await (await fetch(url)).json();
    const coords = route.geometry.coordinates;                 // [lon, lat]
    const kx = 111320 * Math.cos(depart.lat * Math.PI / 180);
    const cumul = [0];
    for (let i = 1; i < coords.length; i++) {
        cumul.push(cumul[i - 1] + Math.hypot((coords[i][0] - coords[i - 1][0]) * kx, (coords[i][1] - coords[i - 1][1]) * 111320));
    }
    const longueur = cumul[cumul.length - 1];
    /** [lat, lon] à `s` mètres du départ, le long de l'itinéraire. */
    const pointA = s => {
        for (let i = 0; i < cumul.length - 1; i++) {
            if (cumul[i + 1] >= s) {
                const t = (s - cumul[i]) / ((cumul[i + 1] - cumul[i]) || 1), a = coords[i], b = coords[i + 1];
                return [a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t];
            }
        }
        return [coords[coords.length - 1][1], coords[coords.length - 1][0]];
    };
    console.log(`itinéraire IGN vers ${arrivee.nom} : ${(longueur / 1000).toFixed(2)} km, ${Math.round(route.duration / 60)} min`);
    const r = { longueur, pointA, nom: arrivee.nom };
    itineraires.set(cle, r);
    return r;
}

// --- L'habillage : légende, titre, carton de fin ------------------------------------------------
const echapper = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const STYLE = `
    #boutons { display:none !important; }
    #film-legende { position:absolute; left:7%; right:7%; bottom:${cadre === 'carre' ? 10 : 9}%; z-index:30; width:fit-content;
        margin:0 auto; padding:${P * 0.45}px ${P * 0.8}px; border-radius:${P * 0.35}px; background:rgba(18,20,24,.82);
        color:#fff; font:500 ${P}px/1.3 system-ui, -apple-system, "Helvetica Neue", sans-serif; text-align:center;
        text-wrap:balance; opacity:0; pointer-events:none; }
    .film-carte { position:absolute; inset:0; z-index:31; display:flex; flex-direction:column; align-items:center;
        justify-content:center; gap:${P * 0.6}px; background:rgba(18,20,24,.74); color:#fff; opacity:0; pointer-events:none;
        font-family:system-ui, -apple-system, "Helvetica Neue", sans-serif; text-align:center; padding:0 8%; }
    .film-carte h1 { margin:0; font-size:${P * 2.1}px; font-weight:700; letter-spacing:-.02em; text-wrap:balance; }
    .film-carte p { margin:0; font-size:${P * 1.05}px; opacity:.9; white-space:pre-line; line-height:1.4; }
    .film-carte .liens { display:flex; flex-direction:column; gap:${P * 0.55}px; margin-top:${P * 0.3}px; }
    .film-carte .liens b { display:block; font-size:${Math.round(P * 0.7)}px; font-weight:500; opacity:.75; }
    .film-carte .liens span { display:block; font-size:${Math.round(P * 1.05)}px; font-weight:700; color:#ffb347; }
    .film-carte .credits { margin-top:${P * 1.1}px; font-size:${Math.round(P * 0.55)}px; opacity:.7; line-height:1.5; }
`;
const TITRE = `<h1>${echapper(plan.titre)}</h1><p>${echapper(plan.sousTitre || '')}</p>`;
const FIN = `<h1>Vue 3D IGN</h1><div class="liens">`
    + `<div><b>Essayez-la</b><span>${SITE}</span></div>`
    + `<div><b>Le code, libre (MIT)</b><span>${DEPOT}</span></div>`
    + `<div><b>Yannick Simon</b><span>${LINKEDIN}</span></div></div>`
    + `<div class="credits">${echapper(plan.credits || '')}<br>Données © IGN · Licence Ouverte 2.0</div>`;
const fondu = (t, debut, finS = Infinity) => Math.max(0, Math.min(1, (t - debut) / 0.5, (finS - t) / 0.5));

// --- Tournage d'un tronçon ----------------------------------------------------------------------
const navigateur = await puppeteer.launch({
    executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    args: ['--use-angle=metal', '--ignore-gpu-blocklist', `--window-size=${LARGEUR},${HAUTEUR}`],
});
const travail = fs.mkdtempSync(path.join(os.tmpdir(), 'film-trajet-'));
const erreurs = [];

async function tourner(troncon, n) {
    const route = troncon.route ? await itineraire(troncon.route.depart, troncon.route.arrivee)
        : await itineraire(plan.depart, plan.arrivee);
    const arrivant = troncon.vers === 'arrivee', dernierFilm = n === plan.troncons.length - 1;
    const sVers = arrivant ? route.longueur : troncon.vers;
    // `de` négatif : compté depuis le bout de l'itinéraire, pour une arrivée.
    const de = troncon.de < 0 ? Math.max(route.longueur + troncon.de, 0) : troncon.de;
    // L'arrivée un peu avant le bout de l'itinéraire, sur sa dernière rue : au
    // bout même, la page se calait sur la route voisine la plus proche (à
    // Saint-Antonin, une route empierrée, 190 m de détour).
    const [la, lo] = route.pointA(de), [va, vo] = route.pointA(arrivant ? route.longueur - 15 : sVers);
    const adresse = `${SERVEUR}/voiture?simu=1&attente=1&lat=${la.toFixed(6)}&lon=${lo.toFixed(6)}`
        + `&vers=${va.toFixed(6)},${vo.toFixed(6)}&versnom=${encodeURIComponent(route.nom)}`
        + `&vitesse=${troncon.vitesse}&heure=${encodeURIComponent(troncon.heure || plan.heure || '14:00')}`;
    const page = await navigateur.newPage();
    await page.setViewport({ width: LARGEUR, height: HAUTEUR, deviceScaleFactor: 1 });
    page.on('pageerror', e => erreurs.push(`tronçon ${n + 1} : ${e.message}`));
    await page.evaluateOnNewDocument(() => {
        const vraiRAF = window.requestAnimationFrame.bind(window);
        const vraiNow = performance.now.bind(performance);
        let manuel = false, horloge = 0, file = [];
        window.requestAnimationFrame = cb => { if (!manuel) return vraiRAF(cb); file.push(cb); return file.length; };
        performance.now = () => (manuel ? horloge : vraiNow());
        window.__manuel = () => { horloge = vraiNow(); manuel = true; };
        window.__pas = dt => { horloge += dt; const cbs = file; file = []; for (const cb of cbs) cb(horloge); };
    });
    await page.goto(adresse, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__voiture, { timeout: 60000 });
    await page.evaluate((style, titre, fin) => {
        const s = document.createElement('style'); s.textContent = style; document.head.append(s);
        const ajouter = (id, cls, html) => { const d = document.createElement('div'); d.id = id; d.className = cls; d.innerHTML = html; document.body.append(d); };
        ajouter('film-legende', '', '');
        ajouter('film-titre', 'film-carte', titre);
        ajouter('film-fin', 'film-carte', fin);
    }, STYLE, TITRE, FIN);
    await page.evaluate(t => { document.getElementById('film-legende').textContent = t; }, troncon.legende || '');

    // Prêt : l'itinéraire, la photo nette sous la voiture, les arbres autour ;
    // puis le temps que le relief et la photo du lointain arrivent (la
    // montagne, à quelques kilomètres), sans quoi le film s'ouvre sur un
    // horizon vide.
    const t0 = Date.now();
    for (;;) {
        const e = await page.evaluate(() => {
            const V = window.__voiture, v = V.voiture;
            let z = 0, arbres = 0;
            for (const t of V.tuilesSol.values()) {
                if (t.mesh && t.mesh.visible && t.mesh.material.map && v.x >= t.minX && v.x <= t.maxX
                    && v.y >= t.minY && v.y <= t.maxY) z = Math.max(z, t.z);
            }
            for (const c of V.carres.values()) if (c.veg.mesh && c.veg.mesh.visible) arbres++;
            return { iti: !!V.itineraire, vue: v.vue, z, arbres, chemin: v.chemin && v.chemin.fin };
        });
        if (e.iti && e.vue && e.z >= 18 && e.arbres >= 3 && e.chemin === 'arrivee') break;
        if (Date.now() - t0 > 120000) { console.log(`  tronçon ${n + 1} pas tout à fait prêt :`, JSON.stringify(e)); break; }
        await new Promise(r => setTimeout(r, 1000));
    }
    await new Promise(r => setTimeout(r, 8000));
    const longueurPage = await page.evaluate(() => Math.round(window.__voiture.itineraire?.longueur ?? -1));
    const longueurIgn = Math.round(sVers - de);
    console.log(`tronçon ${n + 1} : ${Math.round(de)} → ${arrivant ? 'arrivée' : sVers} m, itinéraire de la page ${longueurPage} m`
        + ` (IGN ${longueurIgn} m)${longueurPage > 1.25 * longueurIgn + 50 ? ' — DÉTOUR ? vérifier les images' : ''}`);

    const fichier = path.join(travail, `t${n}.mp4`);
    const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-pix_fmt', 'yuv420p', fichier],
        { stdio: ['pipe', 'inherit', 'inherit'] });
    const cdp = await page.createCDPSession();
    // Le reste affiché : celui du tronçon, plus l'itinéraire IGN au-delà de sa destination.
    const apres = arrivant ? 0 : route.longueur - sVers;
    const pas = (o) => page.evaluate((dt, o) => {
        const V = window.__voiture, v = V.voiture;
        if (o.camera) {
            // La caméra du tronçon, plus haute ou plus reculée, tenue comme au doigt.
            const c = V.camVue;
            c.tangage = o.camera.tangage || 0;
            if (o.camera.recul) c.recul = o.camera.recul;
            if (o.camera.champ && V.camera.fov !== o.camera.champ) {
                V.camera.fov = o.camera.champ;
                V.camera.updateProjectionMatrix();
            }
            c.dernierGeste = performance.now();
        }
        if (o.pano) {
            // Le panoramique de l'arrivée : la vue tourne autour de la voiture
            // arrêtée, comme au doigt (le geste tenu la garde tournée).
            const c = V.camVue, ecart = ((o.pano.cap - c.cap) % 360 + 540) % 360 - 180;
            c.lacet = ecart * o.pano.u;
            c.tangage = o.pano.tangage * o.pano.u;
            if (o.pano.recul) c.recul = 45 + (o.pano.recul - 45) * o.pano.u;
            c.dernierGeste = performance.now();
        }
        window.__pas(dt);
        document.getElementById('film-legende').style.opacity = o.legende;
        document.getElementById('film-titre').style.opacity = o.titre;
        document.getElementById('film-fin').style.opacity = o.fin;
        if (V.itineraire && !V.simu.arrive && v.chemin && v.chemin.fin === 'arrivee') {
            const r = v.chemin.longueur - v.dChemin + o.apres;
            const el = document.getElementById('etat-gps'), b = document.createElement('b');
            b.textContent = r >= 1000 ? (r / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(r / 10) * 10 + ' m';
            el.textContent = `${o.nom} dans `;
            el.append(b);
        }
        return { arrive: V.simu.arrive && v.v < 0.3 };
    }, 1000 / FPS, o);
    let images = 0;
    async function filmer(o) {
        const etat = await pas(o);
        const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 92 });
        const jpeg = Buffer.from(data, 'base64');
        if (!ffmpeg.stdin.write(jpeg)) await new Promise(r => ffmpeg.stdin.once('drain', r));
        images++;
        return etat;
    }
    const base = { apres, nom: route.nom, legende: 0, titre: 0, fin: 0, camera: troncon.camera || null };
    const arret = troncon.arret || 0, debutLegende = troncon.titre ? 5 : 0.6;
    // Un dernier tronçon sans arrivée finit en roulant, sous le carton de fin.
    const roule = arret + (troncon.duree || Infinity);
    const finRoulant = !arrivant && dernierFilm ? troncon.fin || 0 : 0;
    const total = roule + finRoulant;
    const habillage = t => ({ ...base,
        titre: troncon.titre ? fondu(t, 0.2, 4.6) : 0,
        legende: fondu(t, debutLegende, roule - 0.7),
        fin: finRoulant ? fondu(t, roule) : 0 });

    await page.evaluate(() => window.__manuel());
    for (let i = 0; i < arret * FPS; i++) await filmer(habillage(i / FPS));
    await page.evaluate(() => window.__voiture.partir());
    if (n > 0) {
        // L'élan, au rythme réel et sans image : le film reprend la voiture lancée.
        for (let i = 0; i < ELAN_S * FPS; i++) {
            await pas(base);
            await new Promise(r => setTimeout(r, 1000 / FPS));
        }
    }
    if (!arrivant) {
        while (images < total * FPS) await filmer(habillage(images / FPS));
    } else {
        // Arrivé : le panoramique s'il y en a un, la légende effacée à sa
        // moitié pour que la vue se découvre nette, tenue `tenue` secondes ;
        // puis, au dernier tronçon, le carton de fin, tenu `fin` secondes.
        let arrivee = null;
        const pano = troncon.panoramique;
        const debutFin = () => arrivee + (pano ? 0.5 + pano.duree + (pano.tenue ?? 0.8) : 1.5);
        const finLegende = () => (pano ? arrivee + 0.5 + pano.duree / 2 : debutFin() - 0.3);
        for (;;) {
            const t = images / FPS;
            let o = habillage(t);
            if (arrivee !== null) {
                o = { ...base, legende: fondu(t, -1, finLegende()), fin: dernierFilm ? fondu(t, debutFin()) : 0 };
                if (pano) {
                    const u = Math.min(Math.max((t - arrivee - 0.5) / pano.duree, 0), 1);
                    o.pano = { cap: pano.cap, tangage: pano.tangage || 0, recul: pano.recul, u: u * u * (3 - 2 * u) };
                }
            }
            const etat = await filmer(o);
            if (etat.arrive && arrivee === null) arrivee = t;
            if (arrivee !== null && t >= debutFin() + (dernierFilm ? troncon.fin : 0)) break;
            if (t > 120) { erreurs.push('arrivée non atteinte en 120 s'); break; }
        }
    }
    ffmpeg.stdin.end();
    await new Promise(r => ffmpeg.on('close', r));
    await page.close();
    console.log(`  ${(images / FPS).toFixed(1)} s filmées`);
    return { fichier, duree: images / FPS };
}

// TRONCONS=5 (ou 2,5) : ceux-là seulement, pour un essai.
const choisis = process.env.TRONCONS ? process.env.TRONCONS.split(',').map(Number) : null;
const morceaux = [];
for (const [n, t] of plan.troncons.entries()) if (!choisis || choisis.includes(n + 1)) morceaux.push(await tourner(t, n));
await navigateur.close();

// --- Le montage : fondus enchaînés ---------------------------------------------------------------
fs.mkdirSync(path.dirname(sortie), { recursive: true });
const filtres = [];
let duree = morceaux[0].duree, precedent = '0:v';
for (let k = 1; k < morceaux.length; k++) {
    const nom = k === morceaux.length - 1 ? 'v' : `v${k}`;
    filtres.push(`[${precedent}][${k}:v]xfade=transition=fade:duration=${FONDU_S}:offset=${(duree - FONDU_S).toFixed(3)}[${nom}]`);
    duree += morceaux[k].duree - FONDU_S;
    precedent = nom;
}
await new Promise((ok, ko) => {
    const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', ...morceaux.flatMap(m => ['-i', m.fichier]),
        ...(filtres.length ? ['-filter_complex', filtres.join(';'), '-map', '[v]'] : []),
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sortie],
        { stdio: 'inherit' });
    p.on('close', c => (c ? ko(new Error(`ffmpeg : ${c}`)) : ok()));
});
fs.rmSync(travail, { recursive: true, force: true });
console.log(`${sortie} : ${duree.toFixed(1)} s, ${(fs.statSync(sortie).size / 1e6).toFixed(1)} Mo`);
if (erreurs.length) { console.log('ERREURS :\n  ' + erreurs.join('\n  ')); process.exit(1); }
