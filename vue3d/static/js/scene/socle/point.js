// Le point visé : sa position (URL, géolocalisation, accueil), sa zone, et la
// pose de caméra héritée d'un décalage.

// Donné dans l'URL (?lat=…&lon=…). Sans point, la page a d'abord proposé de se
// géolocaliser (DEPART, en tête de page) : la position autorisée est alors
// dans l'URL. Sinon, l'accueil : la tour Eiffel, lieu public couvert par le
// LiDAR HD, nuage allumé — la BD TOPO l'extrude en cubes, le nuage la montre
// des arches à l'antenne. Même point que les films de démo, dont la scène est
// en cache. La caméra prend leur plan d'ouverture (outils/demo-video.mjs) :
// la tour entière, du Champ-de-Mars, à 620 m.
export const DEPART = await window.DEPART;
const PARAMS = new URLSearchParams(location.search);
export const POINT_DEFAUT = { lat: 48.8583, lon: 2.2942, nom: 'Tour Eiffel',
                              vue: { lat: 48.85837, lon: 2.29448, hauteur: 120, distance: 620, azimut: 150, elevation: 18 } };
const lireCoord = n => { const v = Number(String(PARAMS.get(n) || '').replace(',', '.')); return Number.isFinite(v) && PARAMS.get(n) !== null ? v : null; };
export const ACCUEIL = lireCoord('lat') === null || lireCoord('lon') === null;
export const LAT0 = ACCUEIL ? POINT_DEFAUT.lat : lireCoord('lat');
export const LON0 = ACCUEIL ? POINT_DEFAUT.lon : lireCoord('lon');
export const CENTER = [LON0, LAT0];
// Côté nord-sud de la zone, en mètres (?zone=…) ; absent, 1 000 m : 4 s à
// Gordes, 6 s à Strasbourg sur un Mac M4 (README), assez vite pour l'ouvrir
// d'emblée. Le serveur construit jusqu'à 2 000 m, quatre fois la surface, à
// la demande seulement. Mêmes arrondi et bornes que scene.zone_normalisee,
// pour que la page attende l'emprise que le serveur construit.
export const ZONE_DEFAUT_M = 1000;
const ZONE_MAX_M = 2000;
// L'emprise du serveur sans zone= (scene.SCENE_DELTA, ~356 m), que la page ne
// demande plus : les distances de vue, le brouillard et les ombres ont été
// réglés pour elle, et la suivent quand la zone grandit.
const EMPRISE_REFERENCE_M = 2 * 0.0016 * 111320;
export const ZONE = (() => {
    const v = lireCoord('zone') ?? ZONE_DEFAUT_M;
    return Math.min(Math.max(Math.round(v / 50) * 50, 150), ZONE_MAX_M);
})();
export const ECHELLE_ZONE = Math.max(1, ZONE / EMPRISE_REFERENCE_M);
// Au-delà de 1 000 m, les fonds en tuiles WMTS descendent d'un zoom : quatre
// fois la surface en autant de tuiles qu'à 1 000 m. Au même zoom, l'anneau
// d'une zone de 2 000 m (11 km de côté) en demandait environ 700, sur une
// toile de 6 900 px que Safari sur iOS refuse (16,7 Mpx au plus).
export const ZOOM_EN_MOINS = ZONE > 1000 ? 1 : 0;
const PARAM_ZONE = `&zone=${ZONE}`;
// Dans les liens vers un autre point, la zone par défaut ne s'écrit pas : ils
// restent courts, comme ceux du sélecteur de zone.
export const PARAM_ZONE_LIEN = ZONE === ZONE_DEFAUT_M ? '' : PARAM_ZONE;
// Page rechargée par « Ma position » pour se recentrer, ou ouverte sur la
// position autorisée au départ (moi=1, DEPART) : le suivi
// reprend de lui-même, sans nouveau recentrage automatique — pas de boucle si
// un relevé tombe encore hors de la scène. Le drapeau est retiré de l'URL :
// un lien partagé ne doit pas géolocaliser celui qui l'ouvre.
export const RELANCE_MOI = PARAMS.get('moi') === '1';
if (RELANCE_MOI) {
    const u = new URL(location.href);
    u.searchParams.delete('moi');
    history.replaceState(null, '', u.pathname + u.search + u.hash);
}
// Une vue partagée (interface/partage) : la caméra (`vue=lat,lon,hauteur,
// distance,azimut,elevation`, comme celle de l'accueil), le jour (`jour=MM-JJ`)
// et l'heure (`heure=13.25`) du soleil, les couches allumées ou, précédées
// d'un tiret, éteintes (`couches=solaire,dpe,-vegetation`). Lus une fois puis
// retirés de l'adresse, comme `moi` : la flèche de décalage, la recherche ou
// « Reconstruire » repartent de l'adresse, et n'ont pas à les emporter.
export const PARTAGE = (() => {
    const vue = (PARAMS.get('vue') || '').split(',').map(Number);
    const jour = /^(\d{1,2})-(\d{1,2})$/.exec(PARAMS.get('jour') || '');
    const heure = Number(PARAMS.get('heure'));
    const couches = (PARAMS.get('couches') || '').split(',').filter(c => /^-?[a-z]+$/.test(c));
    const p = {
        vue: vue.length === 6 && vue.every(Number.isFinite)
            ? { lat: vue[0], lon: vue[1], hauteur: vue[2], distance: vue[3], azimut: vue[4], elevation: vue[5] } : null,
        jour: jour && +jour[1] >= 1 && +jour[1] <= 12 && +jour[2] >= 1 && +jour[2] <= 31
            ? { mois: +jour[1], jour: +jour[2] } : null,
        heure: PARAMS.get('heure') !== null && heure >= 0 && heure <= 24 ? heure : null,
        couches: Object.fromEntries(couches.map(c => c.startsWith('-') ? [c.slice(1), false] : [c, true])),
    };
    if (['vue', 'jour', 'heure', 'couches'].some(n => PARAMS.has(n))) {
        const u = new URL(location.href);
        for (const n of ['vue', 'jour', 'heure', 'couches']) u.searchParams.delete(n);
        history.replaceState(null, '', u.pathname + u.search + u.hash);
    }
    return p;
})();
// Page rechargée par une flèche de décalage : la caméra y laisse sa pose
// (cadrer) et l'état de l'orbite, pour ce point seulement et une fois. Dans
// l'onglet, jamais dans l'URL : un lien partagé s'ouvre cadré d'office.
export const CLE_POSE = 'vue3d-pose';
export const POSE_HERITEE = (() => {
    try {
        const p = JSON.parse(sessionStorage.getItem(CLE_POSE) || 'null');
        sessionStorage.removeItem(CLE_POSE);
        const vecteur = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
        if (p && p.lat === LAT0 && p.lon === LON0 && p.zone === ZONE
            && vecteur(p.cible) && vecteur(p.ecart)) return p;
    } catch (e) { /* stockage refusé ou illisible */ }
    return null;
})();
export const REQUETE = `lat=${LAT0}&lon=${LON0}${PARAM_ZONE}`;
document.getElementById('coord-point').textContent = `${LAT0.toFixed(5)}, ${LON0.toFixed(5)}`;
