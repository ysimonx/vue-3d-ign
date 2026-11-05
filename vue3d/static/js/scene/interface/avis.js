// L'avis des visiteurs sur le rendu (/api/avis, vue3d/avis.py) : 👍 et 👎,
// comptés pour tous, un par adresse. Un 👎 emporte le lien de la vue et sa
// capture, puis demande, sans l'exiger, ce qui ne va pas : de quoi rouvrir
// la vue telle que le visiteur l'a jugée.

import { REQUETE } from '../socle/point.js';
import { scene, camera, renderer } from '../socle/rendu.js';
import { quandLesBatimentsArrivent } from '../batiments/chargement.js';
import { etatCouche } from './etat-couche.js';
import { lienDeLaVue } from './partage.js';

const boite = document.getElementById('avis');
const btnPour = document.getElementById('avis-pour'), btnContre = document.getElementById('avis-contre');
const formulaire = document.getElementById('avis-mot'), texte = document.getElementById('avis-texte');
let mien = 0, contreEnCours = null;

let effacer = null;
function etat(message) {
    clearTimeout(effacer);
    etatCouche('etat-avis', message);
    effacer = setTimeout(() => etatCouche('etat-avis', null), 6000);
}

function montrer({ pour, contre, mien: m }) {
    mien = m;
    btnPour.querySelector('span').textContent = pour;
    btnContre.querySelector('span').textContent = contre;
    btnPour.classList.toggle('on', m > 0);
    btnContre.classList.toggle('on', m < 0);
    btnPour.setAttribute('aria-pressed', m > 0);
    btnContre.setAttribute('aria-pressed', m < 0);
    boite.hidden = false;
}

async function envoyer(donnees) {
    const r = await fetch(`api/avis?${REQUETE}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                     body: JSON.stringify(donnees) });
    const corps = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corps.erreur || `HTTP ${r.status}`);
    return corps;
}

// Au plus 1 280 px au plus grand côté : ~190 Ko en JPEG (vue3d/avis.py). Le
// tampon WebGL ne garde pas l'image d'une image à l'autre : elle est rendue
// à l'instant.
const CAPTURE_COTE = 1280;
function capturer() {
    try {
        renderer.render(scene, camera);
        const src = renderer.domElement, k = Math.min(1, CAPTURE_COTE / Math.max(src.width, src.height));
        const c = document.createElement('canvas');
        c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
        c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
        return c.toDataURL('image/jpeg', 0.75);
    } catch (e) { return null; }
}

function fermer() {
    formulaire.hidden = true;
    contreEnCours = null;
}

// Cliqué à nouveau, un avis se retire.
async function voter(avis) {
    const donnees = { avis, vue: lienDeLaVue() };
    if (avis < 0) donnees.capture = capturer();
    btnPour.disabled = btnContre.disabled = true;
    try {
        const r = await envoyer(donnees);
        montrer(r);
        if (avis < 0) {
            contreEnCours = r.id;
            texte.value = '';
            formulaire.hidden = false;
            // Au doigt, le clavier ne s'ouvre pas de lui-même : le mot est facultatif.
            if (!matchMedia('(pointer: coarse)').matches) texte.focus();
        } else {
            fermer();
            etat(avis > 0 ? 'Merci pour votre avis.' : 'Avis retiré.');
        }
    } catch (e) {
        etat(`Avis non transmis : ${e.message}`);
    } finally {
        btnPour.disabled = btnContre.disabled = false;
    }
}

btnPour.addEventListener('click', () => voter(mien > 0 ? 0 : 1));
btnContre.addEventListener('click', () => voter(mien < 0 ? 0 : -1));
formulaire.querySelector('.passer').addEventListener('click', () => {
    fermer();
    etat('Merci pour votre avis.');
});
formulaire.addEventListener('keydown', e => { if (e.key === 'Escape') formulaire.querySelector('.passer').click(); });
formulaire.addEventListener('submit', async e => {
    e.preventDefault();
    const mot = texte.value.trim();
    if (!mot) { formulaire.querySelector('.passer').click(); return; }
    const envoi = formulaire.querySelector('[type=submit]');
    envoi.disabled = true;
    try {
        montrer(await envoyer({ sur: contreEnCours, mot }));
        fermer();
        etat('Merci : votre remarque part avec la vue et sa capture.');
    } catch (err) {
        etat(`Remarque non transmise : ${err.message}`);
    } finally {
        envoi.disabled = false;
    }
});

// Au téléphone, les crédits prennent tout le bas de la vue, sur deux ou
// trois lignes : l'avis suit leur hauteur (scene.css, html.tiroir).
const credits = document.getElementById('credits');
new ResizeObserver(() => boite.style.setProperty('--credits-h', `${credits.offsetHeight}px`)).observe(credits);

// Les avis se montrent avec les bâtiments : avant, il n'y a pas de rendu à
// juger, et sans scène le serveur n'en reçoit pas.
quandLesBatimentsArrivent(async () => {
    try {
        const r = await fetch(`api/avis?${REQUETE}`);
        if (r.ok) montrer(await r.json());
    } catch (e) { /* sans avis, la vue reste entière */ }
});
