// Les boutons d'export et leurs options.

import { ERREUR_SCENE } from '../socle/chargement.js';
import { terrain, reliefRegle } from '../terrain/etat.js';
import { vegPrete } from '../vegetation/etat.js';
import { vegChargee } from '../vegetation/couche.js';
import { ecrireIfc } from './ifc.js';
import { ecrireCityGml } from './citygml.js';
import { modeleExport } from './modele.js';

const optionsExport = { relief: true, batiments: true, arbres: true, masses: false };
for (const [cle, id] of [['relief', 'x-relief'], ['batiments', 'x-batiments'],
                         ['arbres', 'x-arbres'], ['masses', 'x-masses']]) {
    const bouton = document.getElementById(id);
    bouton.addEventListener('click', () => {
        optionsExport[cle] = !optionsExport[cle];
        bouton.classList.toggle('on', optionsExport[cle]);
    });
}
const FORMATS_EXPORT = {
    ifc: { nom: 'IFC', ecrire: ecrireIfc, extension: 'ifc', type: 'application/x-step',
           reperes: m => `Lambert-93, origine en ${m.origine.x} E, ${m.origine.y} N, ${m.origine.z} m.` },
    citygml: { nom: 'CityGML', ecrire: ecrireCityGml, extension: 'gml', type: 'application/gml+xml',
               reperes: m => `Lambert-93${m.crs.datumVertical ? ` et ${m.crs.datumVertical}` : ''}, coordonnées absolues.` },
};
const noteExport = document.getElementById('note-export');
const boutonsExport = [...document.querySelectorAll('[data-format]')];

// Le merci, une fois par page : au second export, il gênerait.
const merci = document.getElementById('merci-export');
let merciMontre = false;
function remercier(fichier) {
    if (merciMontre) return;
    merciMontre = true;
    merci.querySelector('.fichier').textContent = fichier;
    merci.hidden = false;
}
const fermerMerci = () => { merci.hidden = true; };
merci.querySelector('.fermer').addEventListener('click', fermerMerci);
merci.querySelector('a').addEventListener('click', fermerMerci);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !merci.hidden) fermerMerci(); });

async function exporter(format) {
    const { nom, ecrire, extension, type, reperes } = FORMATS_EXPORT[format];
    // Les bâtiments sont posés sur le relief : sans lui, pas d'altitudes.
    if (!terrain || !vegChargee) {
        noteExport.textContent = ERREUR_SCENE ? `Scène indisponible : ${ERREUR_SCENE}`
            : !terrain && reliefRegle ? 'Relief indisponible : pas d\'altitudes à exporter.'
            : 'La scène n\'est pas encore prête.';
        return;
    }
    for (const b of boutonsExport) b.disabled = true;
    noteExport.textContent = `Écriture du fichier ${nom}…`;
    // La note s'affiche avant le calcul, qui tient la main une à deux secondes en zone de 1 000 m.
    await new Promise(ok => requestAnimationFrame(() => setTimeout(ok)));
    try {
        const modele = modeleExport(optionsExport);
        const texte = ecrire(modele);
        const fichier = new Blob(Array.isArray(texte) ? texte : [texte], { type });
        const lien = document.createElement('a');
        lien.href = URL.createObjectURL(fichier);
        lien.download = `${modele.base}.${extension}`;
        document.body.append(lien);
        lien.click();
        lien.remove();
        setTimeout(() => URL.revokeObjectURL(lien.href), 60000);
        const c = modele.compte;
        const nombre = (n, mot) => `${n.toLocaleString('fr-FR')} ${mot}${n > 1 ? 's' : ''}`;
        noteExport.textContent = `${lien.download} : ${(fichier.size / 1e6).toFixed(1).replace('.', ',')} Mo, `
            + [optionsExport.batiments && nombre(c.batiments, 'bâtiment'),
               optionsExport.arbres && (vegPrete ? nombre(c.arbres, 'arbre') : 'pas d\'arbres (hors LiDAR HD)'),
               optionsExport.masses && vegPrete && nombre(c.masses, 'masse'),
               c.maille && `relief à ${c.maille.toFixed(1).replace('.', ',')} m`].filter(Boolean).join(', ')
            + '. ' + reperes(modele);
        remercier(lien.download);
    } catch (err) {
        noteExport.textContent = 'Export impossible : ' + err.message;
        console.error(err);
    } finally {
        for (const b of boutonsExport) b.disabled = false;
    }
}
for (const b of boutonsExport) b.addEventListener('click', () => exporter(b.dataset.format));
