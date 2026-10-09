// Démo filmée de la page : un Chrome sans écran charge des lieux, la caméra
// suit un scénario (orbite, toits, végétation, course du soleil, véhicules,
// piscines, nuage LiDAR), et chaque image est capturée à horloge figée, puis
// ffmpeg assemble la vidéo et, sur demande, une voix off.
//
//   npm install puppeteer-core
//   node outils/demo-video.mjs youtube     # 1920×1080, panneau visible, légendes incrustées
//   node outils/demo-video.mjs linkedin    # 1080×1350, vue seule, texte court
//   node outils/demo-video.mjs readme      # GIF muet de quelques secondes, pour le README
//   node outils/demo-video.mjs foncier     # 1080×1080, DPE et ventes DVF à Honfleur (zone de 1 000 m), pour LinkedIn
//   node outils/demo-video.mjs industrie   # 1080×1080, sites industriels : BD TOPO, puis LiDAR HD
//   node outils/demo-video.mjs gadzarts    # 1080×1080, les huit campus Arts et Métiers, de l'aube au soir
//   MUSIQUE=morceau.mp3 node outils/demo-video.mjs gadzarts   # avec une musique dessous
//
// Le film `foncier` ne montre des DPE et des ventes que des couleurs et des
// chiffres réunis (médianes, répartition des étiquettes d'un immeuble) :
// jamais l'infobulle d'une vente ni d'une adresse. Les conditions de DVF
// interdisent de permettre la réidentification des personnes, et une vidéo
// publiée se voit de partout.
//
// Sans voix par défaut : les légendes incrustées portent le texte, et les
// voix de synthèse de macOS, jugées à l'écoute, n'ont pas leur place dans la
// vidéo. Le texte à lire est écrit dans SORTIE (demo-voix-off.txt),
// une phrase par séquence ; VOIX_DOSSIER désigne un dossier d'enregistrements
// nommés comme les séquences (titre.m4a, orbite.m4a, …), montés sur la
// vidéo, chacun donnant sa durée à sa séquence. VOIX="Audrey (Premium)"
// prend à la place une voix de `say` (les voix Premium ou Enhanced
// s'installent dans Réglages Système › Accessibilité › Contenu énoncé).
// CHROME, VUE3D_URL (http://localhost:8080) et SORTIE (docs/demo) sont les
// autres réglages. Un serveur doit tourner, avec les véhicules (VUE3D_VEHICULES) ;
// les lieux filmés sont construits à la première demande, ce qui peut
// prendre plusieurs minutes pour le nuage de la tour Eiffel.
//
// Pourquoi une horloge figée : le rendu est capturé image par image (84 ms
// la capture JPEG en 1080p, mesuré), bien plus lent que la cadence de la
// vidéo. requestAnimationFrame et performance.now sont donc repris à la
// page : chaque pas avance le temps de 1/30 s et exécute la boucle de rendu,
// puis l'image est prise. L'orbite, l'inertie et la carte d'ombre figée en
// mouvement sont ceux de la page, à la vitesse exacte de la vidéo, quelle
// que soit celle de la machine.
import puppeteer from 'puppeteer-core';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FORMAT = process.argv[2] || 'youtube';
const BASE = (process.env.VUE3D_URL || 'http://localhost:8080').replace(/\/$/, '');
const VOIX = process.env.VOIX || '';
const VOIX_DOSSIER = process.env.VOIX_DOSSIER || '';
// Une musique (fichier audio local) posée sous un film sans voix, coupée à sa
// longueur avec un fondu de sortie. Ses droits sont à vérifier avant de publier.
const MUSIQUE = process.env.MUSIQUE || '';
const AVEC_VOIX = Boolean(VOIX || VOIX_DOSSIER);
const SORTIE = process.env.SORTIE || 'docs/demo';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FPS = 30;
const DEPOT = 'github.com/ysimonx/vue-3d-ign';

const FORMATS = {
    // Le panneau de la page reste visible : c'est l'application telle quelle.
    youtube: { largeur: 1920, hauteur: 1080, panneau: true, voix: AVEC_VOIX, texte: 'long', police: 30 },
    // Lu sur un téléphone, souvent sans le son : vue seule, texte court et gros.
    linkedin: { largeur: 1080, hauteur: 1350, panneau: false, voix: AVEC_VOIX, texte: 'court', police: 40 },
    // Un GIF de quelques secondes dans le README, sans son.
    readme: { largeur: 1280, hauteur: 720, panneau: false, voix: false, texte: 'court', police: 34, gif: true },
    // DPE et ventes, au carré pour LinkedIn : un film à lui, muet, son texte
    // incrusté (choix de l'utilisateur : ni voix off, ni sous-titres).
    foncier: { largeur: 1080, hauteur: 1080, panneau: false, voix: false, texte: 'court', police: 38,
               sansVoixOff: true },
    // Trois sites industriels, la BD TOPO puis le LiDAR HD : même forme.
    industrie: { largeur: 1080, hauteur: 1080, panneau: false, voix: false, texte: 'court', police: 38,
                 sansVoixOff: true },
    // Les huit campus Arts et Métiers : même forme, et des intertitres.
    gadzarts: { largeur: 1080, hauteur: 1080, panneau: false, voix: false, texte: 'court', police: 38,
                sansVoixOff: true, musiqueApres: 'g-avertissement' },
};
const fmt = FORMATS[FORMAT];
if (!fmt) { console.error(`format inconnu : ${FORMAT} (youtube | linkedin | readme)`); process.exit(2); }

const TRAVAIL = path.join(os.tmpdir(), 'vue3d-demo', FORMAT);
fs.rmSync(TRAVAIL, { recursive: true, force: true });
fs.mkdirSync(TRAVAIL, { recursive: true });
fs.mkdirSync(SORTIE, { recursive: true });

// --- Lieux ------------------------------------------------------------------
const GORDES = { lat: 43.9116, lon: 5.2003 };
const EIFFEL = { lat: 48.8583, lon: 2.2942, zone: 1000, tour: { lat: 48.85837, lon: 2.29448 } };
const MONT = { lat: 48.6360, lon: -1.5113, abbaye: { lat: 48.6361, lon: -1.5115 } };
// Le Vieux Bassin de Honfleur : 403 DPE et 137 ventes dans l'emprise par
// défaut, maisons et appartements, contre 185 DPE et 39 parcelles vendues
// autour du palais de l'Isle à Annecy (compté le 9 octobre 2026). Filmé en
// zone de 1 000 m : dans l'emprise par défaut, le relief flou des environs
// mangeait le cadre (avis de l'utilisateur sur le premier montage).
const HONFLEUR = { lat: 49.4192, lon: 0.2333, zone: 1000 };
// Sites industriels, au centre de leur zone d'activité BD TOPO, en zone de
// 1 000 m ; `amas` : le quartier (maille de 80 m) où le LiDAR HD voit le plus
// de structures que la BD TOPO ne modélise pas. Orthophotos vérifiées non
// floutées le 2026-10-09 (netteté au laplacien de 296 à 710, autant ou plus
// que Honfleur et Gordes). `structures` : compté ce jour-là sur la couche
// du nuage, points bâtis à plus de 2 m du sol, hors des bâtiments,
// réservoirs et constructions ponctuelles de la BD TOPO (à 1 m près) et
// sans les tabliers de pont (classe 17, que la BD TOPO a en ouvrages), en
// îlots de cellules de 2 m d'au moins 10 m². La part de ces points parmi
// les points bâtis (9 % à Gonfreville, 28 % à Pierre-Bénite, 31 % à
// Cordemais) n'est pas à l'image : elle dépend de la place des cuves.
const GONFREVILLE = { lat: 49.4879, lon: 0.2390, zone: 1000, amas: { lat: 49.48597, lon: 0.24069 },
                      bdtopo: '103 bâtiments, 98 réservoirs', structures: 173 };
const PIERRE_BENITE = { lat: 45.7086, lon: 4.8275, zone: 1000, amas: { lat: 45.70763, lon: 4.82891 },
                        bdtopo: '192 bâtiments, 17 réservoirs', structures: 302 };
const CORDEMAIS = { lat: 47.2783, lon: -1.8825, zone: 1000, amas: { lat: 47.27665, lon: -1.88166 },
                    bdtopo: '68 bâtiments, 12 réservoirs', structures: 144 };
// Les huit campus Arts et Métiers, au centre de leur emprise d'enseignement
// supérieur dans la BD TOPO (l'abbaye pour Cluny), dans l'ordre de leur
// fondation. Dates vérifiées le 2026-10-09 sur l'histoire publiée par
// l'école : Châlons 1806 (l'école de Liancourt, 1780, y emménage), Angers 1815
// (fondée à Beaupréau en 1811), Aix 1843, Cluny 1891 (1890 selon d'autres
// chronologies), Lille 1900, Paris 1912, Bordeaux-Talence 1963, Metz 1997.
const CAMPUS = {
    // `cible` : le bâtiment à filmer quand ce n'est pas la plus grande emprise
    // du campus — à Angers, un gymnase de 2009 ; on prend l'édifice religieux
    // de 22 m, voisin de l'ancienne abbaye du Ronceray. À Paris, le bâtiment
    // du boulevard de l'Hôpital (1914 dans la BD TOPO), et non les ateliers.
    chalons: { lat: 48.95739, lon: 4.35777, zone: 1000 },
    angers: { lat: 47.47590, lon: -0.55993, zone: 1000, cible: { lat: 47.47503, lon: -0.56106 } },
    aix: { lat: 43.52986, lon: 5.45500, zone: 1000 }, cluny: { lat: 46.43467, lon: 4.65942, zone: 1000 },
    lille: { lat: 50.62801, lon: 3.07222, zone: 1000 },
    paris: { lat: 48.83351, lon: 2.35837, zone: 1000, cible: { lat: 48.83364, lon: 2.35797 } },
    talence: { lat: 44.80433, lon: -0.60208, zone: 1000 }, metz: { lat: 49.09450, lon: 6.22616, zone: 1000 },
};
const urlDe = l => `${BASE}/?lat=${l.lat}&lon=${l.lon}${l.zone ? `&zone=${l.zone}` : ''}`;

// --- Scénario ---------------------------------------------------------------
// Chaque séquence : le lieu, le texte lu (long) et sa forme courte, la durée
// minimale à l'écran (la voix l'allonge au besoin), et ce que fait la caméra.
// `gif` est la durée, plus courte, du GIF du README. `cadre` décrit une prise de vue : le point visé, la distance de la caméra,
// son azimut (d'où elle regarde, 0 = du nord) et son élévation, en degrés.
const SEQUENCES = [
    {
        // La tour d'abord, seule à l'écran : le titre ne vient qu'après trois
        // secondes de vue libre, le voile de la carte cacherait le plus
        // spectaculaire.
        id: 'titre', lieu: EIFFEL, duree: 9, gif: 4, formats: ['youtube', 'linkedin', 'readme'],
        long: 'Vue 3D IGN reconstruit en trois dimensions n’importe quel lieu de France métropolitaine, à partir des seules données ouvertes de l’IGN.',
        court: 'N’importe quel lieu de France, en 3D, depuis les données ouvertes de l’IGN',
        carte: { titre: 'Vue 3D IGN', sous: 'La France en 3D, à partir des données ouvertes de l’IGN' }, carteDifferee: true,
        async jouer(s) {
            const debut = Math.min(3, s.duree * 0.4);
            await s.orbiter(s.duree, { cadre: { ...EIFFEL.tour, hauteur: 120, distance: 620, azimut: 150, elevation: 18 }, vitesse: 5,
                                       fn: t => s.carte(Math.min(1, Math.max(0, (t * s.duree - debut) / FONDU_S))) });
        },
    },
    {
        id: 'eiffel', lieu: EIFFEL, duree: 12, formats: ['youtube', 'linkedin'],
        long: 'Un ouvrage ajouré n’a pas de volume dans la BD TOPO. La tour Eiffel, que la base extrude en blocs, est dessinée en points du nuage LiDAR HD, des arches à l’antenne.',
        court: 'La tour Eiffel en points du nuage LiDAR HD, des arches à l’antenne',
        async jouer(s) {
            await s.glisser(s.duree * 0.4, null, { ...EIFFEL.tour, hauteur: 120, distance: 520, azimut: 230, elevation: 12 });
            await s.orbiter(s.duree * 0.6, { vitesse: 6 });
        },
    },
    {
        id: 'nuage', lieu: EIFFEL, duree: 9, formats: ['youtube', 'linkedin'],
        long: 'Le bouton Nuage LiDAR montre tout le bâti en points, tel que l’avion l’a mesuré.',
        court: 'Tout le bâti en points LiDAR, d’un bouton',
        async jouer(s) {
            await s.basculer('t-nuage');
            await s.orbiter(s.duree, { cadre: { ...EIFFEL.tour, hauteur: 60, distance: 650, azimut: 230, elevation: 30 }, vitesse: 5 });
            await s.basculer('t-nuage');
        },
    },
    {
        // Caméra au sud-ouest, à 60° du soleil de midi (azimut 150 à 180°) :
        // dans l'axe du soleil, les ombres se cachent derrière les bâtiments et
        // la vue paraît plate ; plus bas que 35°, le ciel noir mange le cadre.
        id: 'sources', lieu: GORDES, duree: 9, formats: ['youtube'],
        long: 'On donne une adresse, un lieu ou des coordonnées. Ici le village de Gordes : la BD TOPO fournit les bâtiments, le RGE ALTI le relief, et la photo aérienne habille le sol.',
        court: 'Bâtiments de la BD TOPO, relief du RGE ALTI, photo aérienne au sol',
        async jouer(s) {
            await s.glisser(s.duree, { ...GORDES, distance: 330, azimut: 235, elevation: 40 },
                                     { ...GORDES, distance: 230, azimut: 250, elevation: 34 });
        },
    },
    {
        id: 'orbite', lieu: GORDES, duree: 8, gif: 3, formats: ['youtube', 'linkedin', 'readme'],
        long: 'Le mode orbite fait tourner la vue autour du point, à la vitesse que l’on choisit.',
        court: 'Mode orbite, à la vitesse choisie',
        async jouer(s) {
            await s.orbiter(s.duree * 0.45, { cadre: { ...GORDES, distance: 230, azimut: 250, elevation: 34 }, vitesse: 5 });
            await s.orbiter(s.duree * 0.55, { vitesse: 14 });
        },
    },
    {
        id: 'toits', lieu: GORDES, duree: 11, formats: ['youtube', 'linkedin'],
        long: 'Les toits sont mesurés dans le nuage LiDAR HD : gouttière, faîtage, et des pans ajustés sur les points, publiés seulement quand le volume est fermé.',
        court: 'Toits mesurés au LiDAR HD : gouttière, faîtage, pans',
        async jouer(s) {
            const cadre = { ...GORDES, distance: 90, azimut: 200, elevation: 35 };
            await s.glisser(s.duree * 0.35, null, cadre);
            // Sans la mesure, puis avec : la différence se voit sur les faîtages.
            await s.basculer('t-mesure'); await s.orbiter(s.duree * 0.25, { vitesse: 3 });
            await s.basculer('t-mesure'); await s.orbiter(s.duree * 0.40, { vitesse: 3 });
        },
    },
    {
        id: 'vegetation', lieu: GORDES, duree: 10, formats: ['youtube', 'linkedin'],
        long: 'Chaque arbre est segmenté sur la grille de hauteur à cinquante centimètres : ici, deux mille cent soixante houppiers, chacun à sa hauteur, avec sa couronne.',
        court: 'Chaque arbre segmenté sur la grille de hauteur : 2 160 houppiers',
        async jouer(s) {
            await s.basculer('t-veg');                    // sans, d'abord
            await s.glisser(s.duree * 0.3, null, { ...GORDES, distance: 260, azimut: 240, elevation: 30 });
            await s.basculer('t-veg');                    // puis les arbres apparaissent
            await s.orbiter(s.duree * 0.7, { vitesse: 5 });
        },
    },
    {
        id: 'heure', lieu: GORDES, duree: 11, gif: 4, formats: ['youtube', 'linkedin', 'readme'],
        long: 'Le soleil est calculé pour le lieu, la date et l’heure. Les ombres portées suivent sa course, du matin au soir.',
        court: 'Les ombres suivent la course du soleil, heure par heure',
        async jouer(s) {
            await s.glisser(1.5, null, { ...GORDES, distance: 260, azimut: 240, elevation: 30 });
            await s.heures(s.duree - 1.5, 7.5, 19.5);
        },
    },
    {
        id: 'saison', lieu: GORDES, duree: 10, formats: ['youtube', 'linkedin'],
        long: 'Et sa saison : au 21 décembre, le soleil rase le relief et les ombres s’allongent ; au 21 juin, il est haut.',
        court: '21 décembre : soleil rasant · 21 juin : soleil haut',
        async jouer(s) {
            await s.saison(12, 21, 14); await s.orbiter(s.duree * 0.5, { vitesse: 3 });
            await s.saison(6, 21, 14); await s.orbiter(s.duree * 0.5, { vitesse: 3 });
        },
    },
    {
        id: 'vehicules', lieu: GORDES, duree: 11, gif: 3, formats: ['youtube', 'linkedin', 'readme'],
        long: 'Un réseau de neurones lit la photo aérienne : les véhicules sont posés là où ils étaient le jour de la prise de vue, à leurs dimensions.',
        court: 'Véhicules lus sur la photo aérienne par un réseau de neurones',
        async jouer(s) {
            await s.saison(null);                        // retour à aujourd'hui, midi
            const ou = await s.amas('vehicules');
            await s.glisser(s.duree * 0.4, null, { ...ou, distance: 70, azimut: 210, elevation: 45 });
            await s.survoler(ou.exemple, s.duree * 0.6);
        },
    },
    {
        id: 'piscines', lieu: GORDES, duree: 8, formats: ['youtube', 'linkedin'],
        long: 'Les piscines, lues de la même façon, prennent la couleur de leur eau ce jour-là.',
        court: 'Les piscines aussi, à la couleur de leur eau',
        async jouer(s) {
            const ou = await s.amas('piscines');
            await s.glisser(s.duree * 0.45, null, { ...ou, distance: 80, azimut: 160, elevation: 40 });
            await s.survoler(ou.exemple, s.duree * 0.55);
        },
    },
    {
        id: 'mont', lieu: MONT, duree: 9, formats: ['youtube'],
        long: 'Hors couverture LiDAR, un monument est repris au modèle 3D d’OpenStreetMap : l’abbaye du Mont-Saint-Michel, flèche comprise.',
        court: 'Hors LiDAR, l’abbaye vient du modèle 3D d’OpenStreetMap',
        async jouer(s) { await s.orbiter(s.duree, { cadre: { ...MONT.abbaye, hauteur: 40, distance: 420, azimut: 200, elevation: 22 }, vitesse: 5 }); },
    },
    {
        id: 'fin', lieu: MONT, duree: 7, formats: ['youtube', 'linkedin'],
        long: `Vue 3D IGN est un logiciel libre, sous licence MIT. Le code est sur GitHub : ${DEPOT.replace('github.com/', '')}.`,
        court: 'Logiciel libre (MIT) · github.com/ysimonx/vue-3d-ign',
        carte: { titre: 'Vue 3D IGN', sous: `Logiciel libre (MIT) · ${DEPOT}\nDonnées © IGN, Licence Ouverte 2.0` },
        async jouer(s) { await s.orbiter(s.duree, { vitesse: 4 }); },
    },
    // --- Film « foncier » : DPE et ventes DVF, au clic ---------------------
    // Des zooms, pas d'orbite : l'orbite de chaque séquence faisait un film
    // répétitif (avis de l'utilisateur). Le plus large recul reste sous
    // 800 m, pour que la scène de 1 000 m sur 650 remplisse le carré.
    {
        id: 'f-titre', lieu: HONFLEUR, duree: 7, formats: ['foncier'],
        court: 'Honfleur, le Vieux Bassin, en 3D depuis les données ouvertes',
        carte: { titre: 'DPE et ventes', sous: 'Vue 3D IGN · deux clics, des données ouvertes' }, carteDifferee: true,
        async jouer(s) {
            await s.glisser(s.duree, { ...HONFLEUR, distance: 800, azimut: 195, elevation: 50 },
                                     { ...HONFLEUR, distance: 640, azimut: 205, elevation: 46 },
                            t => s.carte(Math.min(1, Math.max(0, (t * s.duree - 2.5) / FONDU_S))));
        },
    },
    {
        id: 'f-dpe', lieu: HONFLEUR, duree: 10, formats: ['foncier'],
        court: 'Un clic : chaque bâtiment à la couleur de son DPE (ADEME)',
        async jouer(s) {
            await s.allumer('t-dpe');
            await s.cartouche(await s.legendeDpe());
            await s.glisser(s.duree, null, { ...HONFLEUR, distance: 330, azimut: 218, elevation: 38 });
        },
    },
    {
        id: 'f-immeuble', lieu: HONFLEUR, duree: 8, formats: ['foncier'],
        court: 'D’un immeuble : la répartition de ses DPE, pas la liste',
        async jouer(s) {
            const b = await s.immeuble();
            await s.glisser(s.duree * 0.45, null, { ...b, distance: 110, azimut: 225, elevation: 32 });
            await s.survoler(b, s.duree * 0.55);
        },
    },
    {
        id: 'f-dvf', lieu: HONFLEUR, duree: 11, formats: ['foncier'],
        court: 'Un autre clic : les ventes depuis 2021 (DVF), au prix du m²',
        async jouer(s) {
            // Les ventes d'abord, puis le DPE éteint : dans l'autre ordre, un
            // instant tout gris entre les deux couches.
            await s.allumer('t-dvf');
            await s.eteindre('t-dpe');
            await s.cartouche(await s.legendeDvf());
            const v = await s.amasVentes();
            // Recul sur la ville, puis zoom sur le quartier le plus vendu.
            await s.glisser(s.duree * 0.4, null, { ...HONFLEUR, distance: 620, azimut: 200, elevation: 44 });
            await s.glisser(s.duree * 0.6, null, { ...v, distance: 230, azimut: 185, elevation: 36 });
        },
    },
    {
        id: 'f-deux', lieu: HONFLEUR, duree: 8, formats: ['foncier'],
        court: 'Ensemble : la couleur du DPE, les bâtiments vendus cernés de cyan',
        async jouer(s) {
            await s.allumer('t-dpe');
            await s.cartouche(await s.legendeDpe(true));
            const v = await s.amasVentes();
            await s.glisser(s.duree, null, { ...v, distance: 120, azimut: 168, elevation: 33 });
        },
    },
    {
        id: 'f-fin', lieu: HONFLEUR, duree: 6, formats: ['foncier'],
        // La carte dit tout : pas de légende en dessous, qui la répéterait.
        court: '',
        carte: { titre: 'Vue 3D IGN', sous: `Logiciel libre (MIT)\n${DEPOT}\n\nDPE © ADEME · ventes © DGFiP (DVF) · © IGN\nLicence Ouverte 2.0` },
        async jouer(s) {
            await s.cartouche('');
            await s.glisser(s.duree, null, { ...HONFLEUR, distance: 760, azimut: 200, elevation: 48 });
        },
    },
    // --- Film « industrie » : la BD TOPO, puis le LiDAR HD -------------------
    // Pour chaque site : la BD TOPO seule, en plan large qui se resserre ;
    // puis le nuage LiDAR HD allumé, en zoom sur le quartier où il voit le
    // plus de structures absentes de la BD TOPO. De loin, les points beiges
    // se fondent dans les volumes et la photo : le LiDAR s'allume de près.
    {
        id: 'i-titre', lieu: GONFREVILLE, duree: 6, formats: ['industrie'],
        court: 'Sites industriels, en 3D depuis les données ouvertes de l’IGN',
        carte: { titre: 'BD TOPO ou LiDAR ?', sous: 'Vue 3D IGN · trois sites industriels, deux modèles' }, carteDifferee: true,
        async jouer(s) {
            await s.glisser(s.duree, { ...GONFREVILLE, distance: 820, azimut: 195, elevation: 50 },
                                     { ...GONFREVILLE, distance: 700, azimut: 200, elevation: 46 },
                            t => s.carte(Math.min(1, Math.max(0, (t * s.duree - 2) / FONDU_S))));
        },
    },
    ...[['Total', 'TotalEnergies, Gonfreville-l’Orcher', GONFREVILLE, 200], ['Arkema', 'Arkema, Pierre-Bénite', PIERRE_BENITE, 215],
        ['EDF', 'EDF, centrale de Cordemais', CORDEMAIS, 205]].flatMap(([id, nom, site, azimut]) => [
        {
            id: `i-${id}-bdtopo`, lieu: site, duree: 6, formats: ['industrie'],
            court: `${nom} : les volumes de la BD TOPO`,
            async jouer(s) {
                await s.cartouche(`<b>BD TOPO</b><br>${site.bdtopo}`);
                if (await allume('t-nuage')) await cliquer('t-nuage');
                await s.glisser(s.duree, { ...site, distance: 720, azimut: azimut - 10, elevation: 46 },
                                         { ...site.amas, distance: 380, azimut, elevation: 40 });
            },
        },
        {
            id: `i-${id}-lidar`, lieu: site, duree: 9, formats: ['industrie'],
            court: `Le LiDAR HD : ${site.structures} structures que la BD TOPO ne modélise pas`,
            async jouer(s) {
                await s.allumer('t-nuage');
                await s.cartouche(`<b>BD TOPO</b><br>${site.bdtopo}<br><b>+ LiDAR HD</b><br>${site.structures} structures de plus`);
                await s.glisser(s.duree, null, { ...site.amas, distance: 170, azimut: azimut + 8, elevation: 34 });
            },
        },
    ]),
    {
        id: 'i-fin', lieu: CORDEMAIS, duree: 6, formats: ['industrie'],
        court: '',
        carte: { titre: 'Vue 3D IGN', sous: `Logiciel libre (MIT)\n${DEPOT}\n\nBD TOPO et LiDAR HD © IGN\nLicence Ouverte 2.0` },
        async jouer(s) {
            await s.cartouche('');
            await s.glisser(s.duree, null, { ...CORDEMAIS, distance: 760, azimut: 205, elevation: 46 });
        },
    },
    // --- Film « gadzarts » : huit campus, une journée -------------------------
    // Monté sur 70 s, la durée de la musique que l'utilisateur y pose
    // (MUSIQUE). Les photos réelles viennent de Wikimedia Commons ; Talence
    // n'en a aucune (cherché le 2026-10-09).
    // Les campus dans l'ordre de leur fondation, et le soleil de la page qui
    // traverse la journée de l'un à l'autre : 8 h 30 à Châlons, 18 h 30 à
    // Metz. Un mouvement de caméra par campus, jamais deux fois le même (avis
    // de l'utilisateur : pas toujours l'approche du ciel qui zoome), cadré
    // sur le bâtiment principal (batimentPrincipal) ; le nuage LiDAR HD s'y
    // allume en cours de plan. Les plans rasants restent au-dessus de 16° :
    // la page n'a pas de ciel, et plus bas un tiers de l'image était noir —
    // sauf à Cluny, où le clocher en points s'y découpe.
    {
        // Le chant gadz'arts prévenu d'avance (demande de l'utilisateur) : la
        // musique ne part qu'après ce carton (musiqueApres).
        id: 'g-avertissement', lieu: CAMPUS.chalons, duree: 3, formats: ['gadzarts'],
        court: '',
        carte: { titre: 'Attention', sous: 'Ce film contient un chant gadz’arts :\nvous voudrez peut-être couper le son 🙂' },
        async jouer(s) {
            const b = await s.batimentPrincipal();
            await s.heure(8.4);
            await s.glisser(s.duree, { ...b, distance: 950, azimut: b.axe + 55, elevation: 32 },
                                     { ...b, distance: 900, azimut: b.axe + 60, elevation: 30 });
        },
    },
    {
        id: 'g-titre', lieu: CAMPUS.chalons, duree: 4.5, formats: ['gadzarts'],
        court: '',
        carte: { titre: 'Les Tabagn’s des Gadz’Arts', sous: 'Huit campus Arts et Métiers, deux siècles,\nvus par le LiDAR HD de l’IGN' },
        async jouer(s) {
            const b = await s.batimentPrincipal();
            await s.heure(8.4);
            await s.glisser(s.duree, null, { ...b, distance: 700, azimut: b.axe + 75, elevation: 26 });
        },
    },
    {
        // La grue : du pied de la façade jusqu'au-dessus des toits.
        id: 'g-chalons', lieu: CAMPUS.chalons, duree: 7.3, formats: ['gadzarts'],
        court: 'Le berceau : l’école de Liancourt (1780) s’y installe en 1806',
        async jouer(s) {
            const b = await s.batimentPrincipal();
            await s.chapitre('1806', 'Châlons-en-Champagne');
            await s.photo('File:Arts et métiers Châlons 45596.jpg', 'Public domain',
                          'L’école de Châlons, gravée par P.-M. Barbat en 1879 · domaine public', 3.0, 3.8);
            const lidar = s.lidarA(0.5);
            await s.glisser(s.duree, { ...b, hauteur: b.hauteur * 0.5, distance: 160, azimut: b.axe + 90, elevation: 16 },
                                     { ...b, distance: 340, azimut: b.axe + 115, elevation: 44 },
                            async t => { await s.heure(8.5 + 1.2 * t); await lidar(t); });
        },
    },
    {
        // Le travelling : le long de la Maine, la rivière devant, le campus en
        // face. De près, le long d'une façade, le mur couvert de points se
        // lisait comme du sable.
        id: 'g-angers', lieu: CAMPUS.angers, duree: 7.3, formats: ['gadzarts'],
        court: 'La deuxième école, née à Beaupréau, rejoint Angers en 1815',
        async jouer(s) {
            await s.chapitre('1815', 'Angers');
            await s.photo('File:ENSAM, Angers.jpg', 'CC BY-SA 2.0',
                          'Le campus dans l’ancienne abbaye du Ronceray, photo Iman_day, 2011 · CC BY-SA 2.0', 3.0, 3.8);
            const lidar = s.lidarA(0.5);
            const c = CAMPUS.angers;
            await s.glisser(s.duree, { ...s.decaler(c, 0, 170), distance: 270, azimut: 95, elevation: 28 },
                                     { ...s.decaler(c, 180, 150), distance: 250, azimut: 85, elevation: 33 },
                            async t => { await s.heure(9.7 + 1.2 * t); await lidar(t); });
        },
    },
    {
        // La plongée : à la verticale, la vue tourne et s'incline.
        id: 'g-aix', lieu: CAMPUS.aix, duree: 7.3, formats: ['gadzarts'],
        court: 'Aix-en-Provence, la troisième école, en 1843',
        async jouer(s) {
            const b = await s.batimentPrincipal();
            await s.chapitre('1843', 'Aix-en-Provence');
            await s.photo('File:Amphithéâtre ENSAM - Aix-en-Provence.jpeg', 'Public domain',
                          'L’amphithéâtre, carte postale de 1907 · domaine public', 3.0, 3.8);
            const lidar = s.lidarA(0.45);
            await s.glisser(s.duree, { ...b, distance: 300, azimut: b.axe, elevation: 86 },
                                     { ...b, distance: 190, azimut: b.axe + 80, elevation: 44 },
                            async t => { await s.heure(10.9 + 1.2 * t); await lidar(t); });
        },
    },
    {
        // L'arc rasant : autour du clocher de l'abbaye, en contre-plongée.
        id: 'g-cluny', lieu: CAMPUS.cluny, duree: 7.3, formats: ['gadzarts'],
        court: 'Cluny : en 1891, l’école entre dans l’abbaye',
        async jouer(s) {
            const c = await s.sommet(150);
            await s.chapitre('1891', 'Cluny');
            await s.photo('File:Abbaye de Cluny, le clocher de l\'Eau Bénite et la tour de l\'Horloge - A9484.jpg', 'CC BY-SA 4.0',
                          'Le clocher de l’Eau-Bénite en 1916, autochrome de Georges Chevalier · musée Albert-Kahn · CC BY-SA 4.0', 3.0, 3.8);
            const lidar = s.lidarA(0.0);
            await s.glisser(s.duree, { ...c, hauteur: c.h * 0.45, distance: 150, azimut: 150, elevation: 6 },
                                     { ...c, hauteur: c.h * 0.4, distance: 115, azimut: 255, elevation: 14 },
                            async t => { await s.heure(12.1 + 1.2 * t); await lidar(t); });
        },
    },
    {
        // Le survol : on arrive du sud, au ras des toits.
        id: 'g-lille', lieu: CAMPUS.lille, duree: 7.3, formats: ['gadzarts'],
        court: 'Lille, 1900 : les premiers bâtiments construits pour l’école',
        async jouer(s) {
            const b = await s.batimentPrincipal();
            await s.chapitre('1900', 'Lille');
            await s.photo('File:Lille Arts et métiers.JPG', 'Public domain', 'La façade, photo Velvet, 2010 · domaine public', 3.0, 3.8);
            const lidar = s.lidarA(0.5);
            await s.glisser(s.duree, { ...s.decaler(b, 190, 420), distance: 170, azimut: 190, elevation: 20 },
                                     { ...b, distance: 150, azimut: 200, elevation: 30 },
                            async t => { await s.heure(13.3 + 1.2 * t); await lidar(t); });
        },
    },
    {
        // Le recul : du détail de la façade à tout Paris.
        id: 'g-paris', lieu: CAMPUS.paris, duree: 7.3, formats: ['gadzarts'],
        court: 'Paris, boulevard de l’Hôpital, 1912',
        async jouer(s) {
            const b = await s.batimentPrincipal();
            await s.chapitre('1912', 'Paris');
            await s.photo('File:P1000874 Paris XIII Boulevard de l\'Hopital ENSAM reductwk.JPG', 'CC BY-SA 3.0',
                          'Boulevard de l’Hôpital, photo Mbzt, 2011 · CC BY-SA 3.0', 3.0, 3.8);
            const lidar = s.lidarA(0.25);
            await s.glisser(s.duree, { ...b, distance: 85, azimut: b.axe + 90, elevation: 62 },
                                     { ...b, distance: 760, azimut: b.axe + 130, elevation: 36 },
                            async t => { await s.heure(14.5 + 1.2 * t); await lidar(t); });
        },
    },
    {
        // La descente en diagonale : de haut, en travers du campus, jusqu'au sol.
        id: 'g-talence', lieu: CAMPUS.talence, duree: 7.3, formats: ['gadzarts'],
        court: 'Bordeaux-Talence, 1963, en pleines Trente Glorieuses',
        async jouer(s) {
            const b = await s.batimentPrincipal();
            await s.chapitre('1963', 'Bordeaux-Talence');
            const lidar = s.lidarA(0.4);
            await s.glisser(s.duree, { ...s.decaler(b, 315, 220), distance: 450, azimut: 225, elevation: 58 },
                                     { ...s.decaler(b, 135, 40), distance: 150, azimut: 255, elevation: 22 },
                            async t => { await s.heure(15.7 + 1.2 * t); await lidar(t); });
        },
    },
    {
        // L'avancée rasante, dans la lumière du soir, le soleil dans le dos.
        id: 'g-metz', lieu: CAMPUS.metz, duree: 8, formats: ['gadzarts'],
        court: 'Metz, 1997 : le plus jeune campus',
        async jouer(s) {
            const b = await s.batimentPrincipal(180);
            await s.chapitre('1997', 'Metz');
            await s.photo('File:9409 P COM PHOTO 7.jpg', 'CC BY-SA 4.0',
                          'Le hall du campus de Metz, photo Atelierremon, 2006 · CC BY-SA 4.0', 3.0, 4.2);
            const lidar = s.lidarA(0.3);
            await s.glisser(s.duree, { ...b, distance: 420, azimut: 255, elevation: 24 },
                                     { ...b, distance: 150, azimut: 280, elevation: 18 },
                            async t => { await s.heure(16.9 + 1.5 * t); await lidar(t); });
        },
    },
    {
        id: 'g-fin', lieu: CAMPUS.metz, duree: 6.5, formats: ['gadzarts'],
        court: '',
        carte: { titre: 'Les Tabagn’s des Gadz’Arts', sous: `1806 – 1997 · huit campus\n\nVue 3D IGN, logiciel libre (MIT) · ${DEPOT}\nLiDAR HD et BD TOPO © IGN, Licence Ouverte 2.0\nPhotos : Wikimedia Commons (auteurs et licences à l’image)` },
        async jouer(s) {
            await s.glisser(s.duree, null, { ...CAMPUS.metz, distance: 720, azimut: 290, elevation: 40 });
        },
    },
];

// --- Voix -------------------------------------------------------------------
// Avec une voix, les phrases sont dites avant le tournage : la durée de chaque
// séquence est le plus long de sa durée minimale et de sa phrase, plus une
// respiration. Sans voix, la durée minimale, qui laisse lire la légende.
const RESPIRATION_S = 0.7;
const dureeAudio = f => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout);
const sequences = SEQUENCES.filter(q => q.formats.includes(FORMAT));
for (const q of sequences) {
    q.legende = fmt.texte === 'long' ? q.long : q.court;
    if (fmt.gif && q.gif) q.duree = q.gif;
    if (fmt.voix) {
        const enregistre = ['m4a', 'wav', 'aiff', 'mp3'].map(e => path.join(VOIX_DOSSIER, `${q.id}.${e}`)).find(f => VOIX_DOSSIER && fs.existsSync(f));
        if (enregistre) q.audio = enregistre;
        else if (!VOIX) { console.error(`aucun enregistrement pour « ${q.id} » dans ${VOIX_DOSSIER}`); process.exit(1); }
        else {
            q.audio = path.join(TRAVAIL, `${q.id}.aiff`);
            const r = spawnSync('say', ['-v', VOIX, '-o', q.audio, q.long]);
            if (r.status !== 0) { console.error(`say a échoué pour « ${q.id} » : ${r.stderr}`); process.exit(1); }
        }
        q.duree = Math.max(q.duree, dureeAudio(q.audio) + RESPIRATION_S);
    }
}
if (!fmt.gif && !fmt.sansVoixOff) {
    fs.writeFileSync(path.join(SORTIE, 'demo-voix-off.txt'),
        'Voix off de la démo, une phrase par séquence : à enregistrer sous le nom de la séquence\n'
        + '(titre.m4a, orbite.m4a, …) dans un dossier donné par VOIX_DOSSIER à outils/demo-video.mjs.\n\n'
        + sequences.map(q => `${q.id}\n  ${q.long}\n`).join('\n'));
}
console.log(`${FORMAT} : ${sequences.length} séquences, ${sequences.reduce((a, q) => a + q.duree, 0).toFixed(0)} s`);

// --- Chrome -----------------------------------------------------------------
const navigateur = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    // Le rendu doit passer par la carte graphique : SwiftShader rend 4 images
    // par seconde à Gordes, Metal 60.
    args: ['--ignore-gpu-blocklist', '--use-angle=metal', `--window-size=${fmt.largeur},${fmt.hauteur}`],
});
const page = await navigateur.newPage();
await page.setViewport({ width: fmt.largeur, height: fmt.hauteur, deviceScaleFactor: 1 });
const erreurs = [];
page.on('pageerror', e => erreurs.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') erreurs.push('console: ' + m.text()); });
page.on('response', r => { if (r.status() >= 400) erreurs.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`); });

// Horloge figée : voir l'en-tête. Posée avant tout script de la page.
await page.evaluateOnNewDocument(() => {
    const vraiRAF = window.requestAnimationFrame.bind(window);
    const vraiNow = performance.now.bind(performance);
    let manuel = false, horloge = 0, file = [];
    window.requestAnimationFrame = cb => { if (!manuel) return vraiRAF(cb); file.push(cb); return file.length; };
    performance.now = () => manuel ? horloge : vraiNow();
    window.__manuel = () => { horloge = vraiNow(); manuel = true; };
    window.__pret = () => file.length > 0;
    window.__pas = dt => { horloge += dt; const cbs = file; file = []; for (const cb of cbs) cb(horloge); };
});

// La page est servie telle quelle, à deux ajouts près : les objets de la
// scène exposés au script (window.__demo), et le style des légendes.
const STYLE_DEMO = `
    ${fmt.panneau ? '' : '#panel, #hint { display:none !important; }'}
    /* Les indicateurs de lecture des couches (nuage LiDAR, monuments…) : du
       bruit à l'image, apparu à l'ouverture du film foncier. */
    .etat-couche { display:none !important; }
    #decalage { display:none !important; }
    #tip { font-size:${Math.round(fmt.police * 0.55)}px !important; line-height:1.35 !important; max-width:${fmt.police * 12}px; }
    #demo-legende { position:absolute; left:50%; bottom:7%; transform:translateX(-50%); z-index:5;
        max-width:84%; padding:${fmt.police * 0.45}px ${fmt.police * 0.8}px; border-radius:${fmt.police * 0.35}px;
        background:rgba(18,20,24,.82); color:#fff; font:500 ${fmt.police}px/1.3 system-ui, -apple-system, "Helvetica Neue", sans-serif;
        text-align:center; text-wrap:balance; opacity:0; pointer-events:none; }
    #demo-cartouche { position:absolute; left:4%; top:4%; z-index:5; padding:${fmt.police * 0.4}px ${fmt.police * 0.5}px;
        border-radius:${fmt.police * 0.3}px; background:rgba(18,20,24,.82); color:#fff; min-width:${fmt.police * 8}px;
        font:500 ${Math.round(fmt.police * 0.55)}px/1.35 system-ui, -apple-system, "Helvetica Neue", sans-serif; }
    #demo-cartouche:empty { display:none; }
    #demo-cartouche .barre { height:${Math.round(fmt.police * 0.6)}px; margin:${fmt.police * 0.2}px 0; }
    #demo-cartouche .barre span { font-size:${Math.round(fmt.police * 0.42)}px; }
    #demo-chapitre { position:absolute; left:6%; top:6%; z-index:5; color:#fff; opacity:0; pointer-events:none;
        font-family:system-ui, -apple-system, "Helvetica Neue", sans-serif; text-shadow:0 2px 14px rgba(0,0,0,.75), 0 0 2px rgba(0,0,0,.6); }
    #demo-chapitre b { display:block; font-size:${fmt.police * 2.8}px; font-weight:800; letter-spacing:-.03em; line-height:1; }
    #demo-chapitre span { display:block; font-size:${fmt.police * 1.05}px; font-weight:600; margin-top:${fmt.police * 0.25}px; }
    #demo-photo { position:absolute; right:5%; top:6%; z-index:5; width:42%; padding:${fmt.police * 0.3}px ${fmt.police * 0.3}px 0;
        background:#f4f1ea; border-radius:3px; box-shadow:0 10px 30px rgba(0,0,0,.55); transform:rotate(1.6deg);
        opacity:0; pointer-events:none; }
    #demo-photo img { display:block; width:100%; max-height:${Math.round(fmt.hauteur * 0.42)}px; object-fit:cover; }
    #demo-photo span { display:block; padding:${fmt.police * 0.22}px 2px ${fmt.police * 0.28}px; color:#2b2b2b;
        font:500 ${Math.round(fmt.police * 0.4)}px/1.3 system-ui, -apple-system, "Helvetica Neue", sans-serif; }
    #demo-carte { position:absolute; inset:0; z-index:4; display:flex; flex-direction:column; align-items:center;
        justify-content:center; gap:${fmt.police * 0.6}px; background:rgba(18,20,24,.62); color:#fff; opacity:0; pointer-events:none;
        font-family:system-ui, -apple-system, "Helvetica Neue", sans-serif; text-align:center; padding:0 8%; }
    #demo-carte h1 { margin:0; font-size:${fmt.police * 2.6}px; font-weight:700; letter-spacing:-.02em; }
    #demo-carte p { margin:0; font-size:${fmt.police * 1.1}px; opacity:.9; white-space:pre-line; line-height:1.4; }
`;
const HTML_DEMO = '<div id="demo-carte"><h1></h1><p></p></div><div id="demo-legende"></div><div id="demo-cartouche"></div>'
    + '<div id="demo-chapitre"><b></b><span></span></div><div id="demo-photo"><img alt=""><span></span></div>';
await page.setRequestInterception(true);
page.on('request', async r => {
    if (r.resourceType() !== 'document') return r.continue();
    const rep = await fetch(r.url());
    let html = await rep.text();
    const ancre = 'requestAnimationFrame(boucle);\n</script>';
    if (!html.includes(ancre)) { console.error('page inattendue : la boucle de rendu est introuvable'); process.exit(1); }
    html = html.replace(ancre, `window.__demo = { THREE, camera, controls, renderer, scene, ySol, majSoleil, DATE_SIMULEE,
            LON0, LAT0, M_PAR_DEGRE_LON, M_PAR_DEGRE_LAT, vegChargee: () => vegChargee };\n${ancre}`)
               .replace('</style>', STYLE_DEMO + '</style>')
               .replace('<div id="tip"></div>', '<div id="tip"></div>' + HTML_DEMO);
    r.respond({ status: rep.status, contentType: 'text/html; charset=utf-8', body: html });
});

// --- Encodage au fil de l'eau ------------------------------------------------
// Les images partent dans ffmpeg par un tube : 5 000 JPEG ne tiennent pas sur
// disque pour rien.
const VIDEO_MUETTE = path.join(TRAVAIL, 'muette.mp4');
const ffmpeg = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', VIDEO_MUETTE], { stdio: ['pipe', 'inherit', 'inherit'] });
let images = 0;
async function capturer() {
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ffmpeg.stdin.write(jpeg)) await new Promise(r => ffmpeg.stdin.once('drain', r));
    images++;
}

// --- Prises de vue ----------------------------------------------------------
const lisser = t => t * t * (3 - 2 * t);
// Clic par le DOM : le panneau peut être masqué (formats sans panneau).
const cliquer = id => page.$eval('#' + id, b => b.click());
const allume = id => page.$eval('#' + id, b => b.classList.contains('on'));
const RAD = Math.PI / 180;
let lieuCourant = null;

/** Charge un lieu, attend la scène et toutes ses couches, puis fige l'horloge. */
async function charger(lieu) {
    if (lieuCourant === lieu) return;
    lieuCourant = lieu;
    console.log(`  ${urlDe(lieu)}`);
    if (FORMAT === 'foncier') {
        // Le serveur construit la scène, puis lit DPE et ventes : le clic
        // filmé les trouve en cache, sans attente à l'image.
        for (const nom of ['scene', 'dpe', 'dvf']) await couche(nom);
    }
    if (FORMAT === 'industrie' || FORMAT === 'gadzarts') {
        // Le nuage d'une zone de 1 000 m se lit en 30 à 90 s : d'avance.
        // Hors couverture LiDAR HD (Lille, en octobre 2026), il n'y en a pas.
        await couche('scene');
        lieu.sansNuage = !(await couche('nuage'));
    }
    await page.goto(urlDe(lieu), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('attente').hidden, { timeout: 15 * 60 * 1000 });
    await page.waitForFunction(() => window.__demo && window.__demo.vegChargee()
        && [...document.querySelectorAll('.etat-couche')].every(e => e.hidden || !e.classList.contains('en-cours')),
        { timeout: 15 * 60 * 1000 });
    // Le bouton du nuage n'apparaît qu'une fois ses points construits.
    if ((FORMAT === 'industrie' || FORMAT === 'gadzarts') && !lieu.sansNuage) {
        await page.waitForFunction(() => !document.getElementById('t-nuage').hidden, { timeout: 15 * 60 * 1000 });
    }
    await new Promise(r => setTimeout(r, 2500));       // textures et compilation des matériaux
    // L'orbite démarre d'elle-même avec la scène : la caméra est au script.
    if (await allume('t-orbit')) await cliquer('t-orbit');
    await page.evaluate(() => window.__manuel());
    // Scruté à intervalle : par défaut, puppeteer scrute par requestAnimationFrame, désormais figé.
    await page.waitForFunction(() => window.__pret(), { timeout: 5000, polling: 100 });
    await page.evaluate(() => { document.getElementById('tip').style.display = 'none'; });
}

/** Une couche du lieu courant, lue par le script (déjà en cache côté serveur). */
async function couche(nom) {
    const l = lieuCourant;
    const r = await fetch(`${BASE}/api/${nom}?lat=${l.lat}&lon=${l.lon}${l.zone ? `&zone=${l.zone}` : ''}`);
    if (!r.ok) throw new Error(`/api/${nom} : HTTP ${r.status}`);
    return r.json();
}

/** Caméra posée sur un cadre : point visé (lon, lat, hauteur au-dessus du sol), distance, azimut, élévation. */
const poserCadre = c => page.evaluate(c => {
    const d = window.__demo;
    const x = (c.lon - d.LON0) * d.M_PAR_DEGRE_LON, z = -(c.lat - d.LAT0) * d.M_PAR_DEGRE_LAT;
    const y = d.ySol(c.lon, c.lat) + (c.hauteur || 0);
    const r = Math.PI / 180, cosE = Math.cos(c.elevation * r);
    d.controls.target.set(x, y, z);
    d.camera.position.set(x + c.distance * Math.sin(c.azimut * r) * cosE, y + c.distance * Math.sin(c.elevation * r),
                          z - c.distance * Math.cos(c.azimut * r) * cosE);
}, c);
const cadreEntre = (a, b, t) => ({
    lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t,
    hauteur: (a.hauteur || 0) + ((b.hauteur || 0) - (a.hauteur || 0)) * t,
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * t),
    azimut: a.azimut + (b.azimut - a.azimut) * t, elevation: a.elevation + (b.elevation - a.elevation) * t,
});
let dernierCadre = null;

/** Cadre courant lu sur la caméra (après une orbite, par exemple). */
const lireCadre = () => page.evaluate(() => {
    const d = window.__demo, t = d.controls.target, p = d.camera.position;
    const v = p.clone().sub(t), dist = v.length();
    return { lon: d.LON0 + t.x / d.M_PAR_DEGRE_LON, lat: d.LAT0 - t.z / d.M_PAR_DEGRE_LAT,
             hauteur: t.y - d.ySol(d.LON0 + t.x / d.M_PAR_DEGRE_LON, d.LAT0 - t.z / d.M_PAR_DEGRE_LAT),
             distance: dist, azimut: Math.atan2(v.x, -v.z) / (Math.PI / 180), elevation: Math.asin(v.y / dist) / (Math.PI / 180) };
});

/** Légende et carte de titre : opacité réglée image par image, l'horloge étant figée. */
let legende = { texte: '', debut: 0, fin: 0 };
let chapitre = { debut: 0, fin: 0 };
let photo = { debut: 0, fin: 0 };
const FONDU_S = 0.4;
async function habiller() {
    const t = images / FPS;
    const fondu = e => Math.max(0, Math.min(1, (t - e.debut) / FONDU_S, (e.fin - t) / FONDU_S));
    await page.evaluate((o, oc, op) => {
        document.getElementById('demo-legende').style.opacity = o;
        document.getElementById('demo-chapitre').style.opacity = oc;
        document.getElementById('demo-photo').style.opacity = op;
    }, legende.texte ? fondu(legende) : 0, fondu(chapitre), fondu(photo));
}
async function carte(c, opacite) {
    await page.evaluate((c, o) => {
        const e = document.getElementById('demo-carte');
        if (c) { e.querySelector('h1').textContent = c.titre; e.querySelector('p').textContent = c.sous; }
        e.style.opacity = o;
    }, c, opacite);
}

/** `n` images, `fn(t)` appelée avant chacune avec l'avancement de 0 à 1. */
async function filmer(secondes, fn) {
    const n = Math.max(1, Math.round(secondes * FPS));
    for (let i = 0; i < n; i++) {
        if (fn) await fn(n > 1 ? i / (n - 1) : 1);
        await page.evaluate(dt => window.__pas(dt), 1000 / FPS);
        await habiller();
        await capturer();
    }
}

const outils = {
    /** Pose la caméra sans mouvement. */
    async poser(c) { dernierCadre = c; await poserCadre(c); },
    /** Glissement lissé d'un cadre à l'autre ; `de` absent : depuis la caméra actuelle ;
     *  `fn(t)`, s'il est donné, appelée à chaque image (fondu d'une carte). */
    async glisser(secondes, de, vers, fn) {
        de = de || dernierCadre || await lireCadre();
        dernierCadre = vers;
        await filmer(secondes, async t => {
            await poserCadre(cadreEntre(de, vers, lisser(t)));
            if (fn) await fn(t);
        });
    },
    /** L'orbite de la page, à sa vitesse (degrés par seconde), depuis un cadre ou la caméra actuelle. */
    async orbiter(secondes, { cadre, vitesse, fn }) {
        if (cadre) await outils.poser(cadre);
        await page.evaluate(v => { document.getElementById('speed').value = v; }, vitesse);
        if (!await allume('t-orbit')) await cliquer('t-orbit');
        await filmer(secondes, fn);
        await cliquer('t-orbit');
        dernierCadre = null;
    },
    /** Opacité de la carte de titre de la séquence (carteDifferee). */
    async carte(opacite) { await carte(null, opacite); },
    /** Bouton du panneau, puis quelques images pour que la bascule se voie. */
    async basculer(id) { await cliquer(id); await filmer(0.25); },
    /** Le curseur de l'heure, de `de` à `a` heures. */
    async heures(secondes, de, a) {
        await filmer(secondes, t => page.evaluate(h => {
            const c = document.getElementById('heure'); c.value = h; c.dispatchEvent(new Event('input'));
        }, de + (a - de) * lisser(t)));
    },
    /** Un cran de saison (mois, jour) à l'heure donnée ; `null` : aujourd'hui à midi. */
    async saison(mois, jour, heure = 12) {
        await page.evaluate((mois, jour, heure) => {
            const c = document.getElementById('heure'); c.value = heure; c.dispatchEvent(new Event('input'));
            if (mois) document.querySelector(`.saison-cran[data-mois="${mois}"][data-jour="${jour}"]`).click();
            else document.getElementById('saison-aujourdhui').click();
        }, mois, jour, heure);
    },
    /** L'amas le plus dense d'une couche de l'orthophoto (véhicules ou piscines) du lieu courant, et un exemple dedans. */
    async amas(couche) {
        const l = lieuCourant;
        const url = `${BASE}/api/${couche}?lat=${l.lat}&lon=${l.lon}${l.zone ? `&zone=${l.zone}` : ''}${couche === 'vehicules' ? '&detecteur=rtmdet' : ''}`;
        const objets = (await (await fetch(url)).json())[couche] || [];
        if (!objets.length) throw new Error(`aucun objet dans ${url}`);
        // Mailles de 25 m : la plus peuplée, et l'objet le plus près de son centre.
        const m = 25 / 111320, cases = new Map();
        for (const o of objets) {
            const k = `${Math.floor(o[0] / m)},${Math.floor(o[1] / m)}`;
            (cases.get(k) || cases.set(k, []).get(k)).push(o);
        }
        const amas = [...cases.values()].sort((a, b) => b.length - a.length)[0];
        const lon = amas.reduce((s, o) => s + o[0], 0) / amas.length, lat = amas.reduce((s, o) => s + o[1], 0) / amas.length;
        const ex = amas.sort((a, b) => Math.hypot(a[0] - lon, a[1] - lat) - Math.hypot(b[0] - lon, b[1] - lat))[0];
        return { lon, lat, exemple: { lon: ex[0], lat: ex[1], hauteur: couche === 'vehicules' ? 1 : 0 } };
    },
    /** Allume un bouton du panneau et attend que sa couche soit lue (DPE, ventes : au clic). */
    async allumer(id) {
        if (!await allume(id)) await cliquer(id);
        // Scruté à intervalle, l'horloge de la page étant figée ; la lecture
        // est déjà en cache (prechauffer).
        await page.waitForFunction(id => document.getElementById(id).classList.contains('on'),
                                   { timeout: 120000, polling: 100 }, id);
        await filmer(0.25);
    },
    async eteindre(id) { if (await allume(id)) await cliquer(id); await filmer(0.25); },
    /** Le cartouche de légende, en haut à gauche ; '' le masque. */
    async cartouche(html) { await page.evaluate(h => { document.getElementById('demo-cartouche').innerHTML = h; }, html); },
    /** Légende des DPE de l'emprise : répartition des étiquettes, et le contour des ventes. */
    async legendeDpe(avecVentes = false) {
        const d = await couche('dpe');
        const total = {};
        for (const g of [...d.batiments, ...d.adresses]) {
            for (const [e, n] of Object.entries(g.resume.energie)) total[e] = (total[e] || 0) + n;
        }
        const couleurs = { A: '#009c6d', B: '#52b153', C: '#a5cc74', D: '#f4e70f', E: '#f0b40f', F: '#eb8235', G: '#d7221f' };
        return `<b>${d.nombre.toLocaleString('fr-FR')} DPE</b> · étiquette énergie<div class="barre">`
            + Object.keys(couleurs).filter(e => total[e]).map(e =>
                `<span style="flex:${total[e]};background:${couleurs[e]}">${e}</span>`).join('') + '</div>'
            + (avecVentes ? '<span style="color:#22d3ee">▢</span> bâtiment vendu depuis 2021' : '');
    },
    /** Légende des ventes : les cinq classes de prix et les médianes par type. */
    async legendeDvf() {
        const v = await couche('dvf');
        const fr = n => Math.round(n).toLocaleString('fr-FR');
        const ligne = (t, l) => v.resume[t] ? `<br>${l} : ${fr(v.resume[t].mediane)} €/m² <i>(${v.resume[t].ventes} ventes)</i>` : '';
        return `<b>Ventes ${v.millesimes[0]}-${v.millesimes[v.millesimes.length - 1]}</b> · prix médians`
            + '<div class="barre">' + ['#fde68a', '#fbbf24', '#f97316', '#dc2626', '#7f1d1d'].map(c =>
                `<span style="flex:1;background:${c}"></span>`).join('') + '</div>moins cher → plus cher'
            + '<br><span style="color:#8aa4c8">■</span> vente sans prix au m²'
            + ligne('Maison', 'Maisons') + ligne('Appartement', 'Appartements');
    },
    /** Intertitre de chapitre (l'année, la ville), en fondu, pendant `secondes`. */
    async chapitre(annee, ville, secondes = 3.2) {
        await page.evaluate((a, v) => {
            const e = document.getElementById('demo-chapitre');
            e.querySelector('b').textContent = a; e.querySelector('span').textContent = v;
        }, annee, ville);
        chapitre = { debut: images / FPS, fin: images / FPS + secondes };
    },
    /** Une photo réelle de Wikimedia Commons, posée en tirage dans le coin, de `dans` à
     *  `dans + pendant` secondes. Lue au tournage, jamais gardée dans le dépôt ; sa licence
     *  est vérifiée : changée sur Commons, le tournage s'arrête plutôt que de mal créditer. */
    async photo(titre, licence, legende, dans, pendant) {
        const ua = { 'User-Agent': 'vue-3d-ign-demo/1.0 (https://github.com/ysimonx/vue-3d-ign)' };
        const api = 'https://commons.wikimedia.org/w/api.php?format=json&action=query&prop=imageinfo&iiprop=url|extmetadata'
            + `&iiurlwidth=900&titles=${encodeURIComponent(titre)}`;
        const info = Object.values((await (await fetch(api, { headers: ua })).json()).query.pages)[0].imageinfo[0];
        const lue = (info.extmetadata.LicenseShortName || {}).value;
        if (lue !== licence) throw new Error(`${titre} : licence « ${lue} » sur Commons, « ${licence} » attendue`);
        const octets = Buffer.from(await (await fetch(info.thumburl, { headers: ua })).arrayBuffer());
        await page.evaluate((src, l) => {
            const e = document.getElementById('demo-photo');
            e.querySelector('img').src = src; e.querySelector('span').textContent = l;
        }, `data:image/jpeg;base64,${octets.toString('base64')}`, legende);
        photo = { debut: images / FPS + dans, fin: images / FPS + dans + pendant };
    },
    /** L'heure du soleil, à l'instant (curseur de la page). */
    async heure(h) {
        await page.evaluate(h => { const c = document.getElementById('heure'); c.value = h; c.dispatchEvent(new Event('input')); }, h);
    },
    /** Le bâtiment principal autour du point : la plus grande emprise à moins de `rayon` m,
     *  son centre, son grand axe (azimut depuis le nord, par l'analyse en composantes
     *  principales de ses sommets), sa longueur et sa hauteur BD TOPO. */
    async batimentPrincipal(rayon = 120) {
        const s = await couche('scene');
        const l = lieuCourant, kx = 111320 * Math.cos(l.lat * RAD);
        let meilleur = null;
        for (const f of s.batiments.features) {
            const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
            const a = polys[0][0].map(([x, y]) => [(x - l.lon) * kx, (y - l.lat) * 111320]);
            let aire = 0;
            for (let i = 0, j = a.length - 1; i < a.length; j = i++) aire += a[j][0] * a[i][1] - a[i][0] * a[j][1];
            aire = Math.abs(aire) / 2;
            const c = [a.reduce((t, p) => t + p[0], 0) / a.length, a.reduce((t, p) => t + p[1], 0) / a.length];
            if (Math.hypot(...c) > rayon) continue;
            // Le lieu désigne son bâtiment (`cible`) : le plus proche ; sinon la plus grande emprise.
            // Au moins 500 m² : à Angers, une annexe de 136 m² était plus près de la cible que l'édifice.
            if (l.cible && aire < 500) continue;
            const ecart = l.cible ? Math.hypot(c[0] - (l.cible.lon - l.lon) * kx, c[1] - (l.cible.lat - l.lat) * 111320) : -aire;
            if (meilleur && ecart >= meilleur.ecart) continue;
            meilleur = { aire, a, c, ecart, h: f.properties.hauteur || 10 };
        }
        const { a, c, aire, h } = meilleur;
        let sxx = 0, syy = 0, sxy = 0;
        for (const [x, y] of a) { sxx += (x - c[0]) ** 2; syy += (y - c[1]) ** 2; sxy += (x - c[0]) * (y - c[1]); }
        const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);            // depuis l'est, sens trigonométrique
        const ux = Math.cos(theta), uy = Math.sin(theta);
        const proj = a.map(([x, y]) => (x - c[0]) * ux + (y - c[1]) * uy);
        const b = { lon: l.lon + c[0] / kx, lat: l.lat + c[1] / 111320, axe: (90 - theta / RAD + 360) % 180,
                    longueur: Math.max(...proj) - Math.min(...proj), hauteur: h, aire: Math.round(aire) };
        console.log(`    bâtiment principal : ${b.aire} m², ${b.longueur.toFixed(0)} m de long, axe ${b.axe.toFixed(0)}°, ${b.hauteur} m`);
        return b;
    },
    /** Une fonction d'image qui allume le nuage LiDAR HD, une fois, passé `seuil` du plan. */
    lidarA(seuil) {
        let fait = false;
        return async t => {
            if (fait || t < seuil || lieuCourant.sansNuage) return;
            fait = true;
            if (!await allume('t-nuage')) await cliquer('t-nuage');
        };
    },
    /** Le point le plus haut du nuage à moins de `rayon` m du lieu (un clocher), et sa hauteur. */
    async sommet(rayon) {
        const n = await couche('nuage');
        const l = lieuCourant, kx = 111320 * Math.cos(l.lat * RAD);
        const lon = new Int32Array(Buffer.from(n.lon, 'base64').buffer.slice(0));
        const lat = new Int32Array(Buffer.from(n.lat, 'base64').buffer.slice(0));
        const h = new Uint16Array(Buffer.from(n.h, 'base64').buffer.slice(0));
        let k = -1;
        for (let i = 0; i < h.length; i++) {
            const x = (n.origine[0] + lon[i] * 1e-7 - l.lon) * kx, y = (n.origine[1] + lat[i] * 1e-7 - l.lat) * 111320;
            if (Math.hypot(x, y) <= rayon && h[i] < 15000 && (k < 0 || h[i] > h[k])) k = i;
        }
        const c = { lon: n.origine[0] + lon[k] * 1e-7, lat: n.origine[1] + lat[k] * 1e-7, h: h[k] / 100 };
        console.log(`    sommet du nuage : ${c.h.toFixed(1)} m`);
        return c;
    },
    /** Un point à `d` mètres de `b` le long de l'azimut `az` (degrés depuis le nord). */
    decaler(b, az, d) {
        const kx = 111320 * Math.cos(b.lat * RAD);
        return { ...b, lon: b.lon + d * Math.sin(az * RAD) / kx, lat: b.lat + d * Math.cos(az * RAD) / 111320 };
    },
    /** Le quartier le plus vendu : la maille de 60 m qui a le plus de parcelles vendues, son centre. */
    async amasVentes() {
        const v = await couche('dvf');
        const m = 60 / 111320, cases = new Map();
        for (const p of v.parcelles) {
            const g = p.geometrie, anneau = g.type === 'Polygon' ? g.coordinates[0] : g.coordinates[0][0];
            const c = [anneau.reduce((t, q) => t + q[0], 0) / anneau.length, anneau.reduce((t, q) => t + q[1], 0) / anneau.length];
            const k = `${Math.floor(c[0] / m)},${Math.floor(c[1] / m)}`;
            (cases.get(k) || cases.set(k, []).get(k)).push(c);
        }
        const amas = [...cases.values()].sort((a, b) => b.length - a.length)[0];
        return { lon: amas.reduce((t, c) => t + c[0], 0) / amas.length, lat: amas.reduce((t, c) => t + c[1], 0) / amas.length };
    },
    /** Un immeuble du centre, le plus diagnostiqué : la page n'en donne que le résumé. Pris à
     *  moins de 250 m du point, résidentiel et d'au moins 8 m : en zone de 1 000 m, le plus
     *  diagnostiqué de toute la scène était un bâtiment des abords, sous les arbres, dessiné
     *  à 3 m faute de hauteur connue, d'un gros plan flou. */
    async immeuble() {
        const d = await couche('dpe');
        const s = await couche('scene');
        const l = lieuCourant, kx = 111320 * Math.cos(l.lat * RAD);
        const centre = f => {
            const a = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
            return [a.reduce((t, p) => t + p[0], 0) / a.length, a.reduce((t, p) => t + p[1], 0) / a.length];
        };
        const parCle = new Map(s.batiments.features.map(f => [f.properties.cleabs, f]));
        const candidats = d.batiments.filter(b => !b.dpe && b.resume.n >= 5).map(b => ({ b, f: parCle.get(b.batiment) }))
            .filter(({ f }) => f && f.properties.usage_1 === 'Résidentiel' && (f.properties.hauteur || 0) >= 8)
            .map(c => ({ ...c, c: centre(c.f) }))
            .filter(({ c }) => Math.hypot((c[0] - l.lon) * kx, (c[1] - l.lat) * 111320) <= 250)
            .sort((x, y) => y.b.resume.n - x.b.resume.n);
        if (!candidats.length) throw new Error('aucun immeuble d\'au moins cinq DPE au centre');
        const { b, f, c } = candidats[0];
        console.log(`    immeuble ${b.batiment} : ${b.resume.n} DPE, médiane ${b.resume.mediane}, ${f.properties.hauteur} m`);
        return { lon: c[0], lat: c[1], hauteur: 4 };
    },
    /** La souris va sur un objet et y reste : son infobulle s'ouvre. */
    async survoler(p, secondes) {
        const ecran = await page.evaluate(p => {
            const d = window.__demo;
            const v = new d.THREE.Vector3((p.lon - d.LON0) * d.M_PAR_DEGRE_LON, d.ySol(p.lon, p.lat) + p.hauteur, -(p.lat - d.LAT0) * d.M_PAR_DEGRE_LAT);
            v.project(d.camera);
            const r = d.renderer.domElement.getBoundingClientRect();
            return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
        }, p);
        await page.evaluate(() => { document.getElementById('tip').style.display = ''; });
        const depart = { x: ecran.x + 120, y: ecran.y + 90 };
        await filmer(secondes * 0.3, t => page.mouse.move(depart.x + (ecran.x - depart.x) * lisser(t), depart.y + (ecran.y - depart.y) * lisser(t)));
        await filmer(secondes * 0.7);
        await page.mouse.move(5, fmt.hauteur - 5);
        await page.evaluate(() => { document.getElementById('tip').style.display = 'none'; });
    },
};

// --- Tournage -----------------------------------------------------------------
for (const q of sequences) {
    console.log(`${q.id} (${q.duree.toFixed(1)} s)`);
    await charger(q.lieu);
    const debut = images / FPS;
    q.debut = debut;
    legende = { texte: q.legende, debut, fin: debut + q.duree };
    await page.evaluate(t => { document.getElementById('demo-legende').textContent = t; }, q.legende);
    if (q.carte) await carte(q.carte, q.carteDifferee ? 0 : 1);
    const avant = images;
    await q.jouer({ ...outils, duree: q.duree });
    // Au nombre d'images près, la séquence dure ce que dit sa voix.
    const manque = Math.round(q.duree * FPS) - (images - avant);
    if (manque > 0) await filmer(manque / FPS);
    if (q.carte) await carte(null, 0);
}
ffmpeg.stdin.end();
await new Promise(r => ffmpeg.on('close', r));
await navigateur.close();
if (erreurs.length) console.warn('Erreurs de la page :\n  ' + erreurs.join('\n  '));

// --- Assemblage ---------------------------------------------------------------
const nom = path.join(SORTIE, `demo-${FORMAT}`);
if (fmt.gif) {
    // Deux passes : la palette est calculée sur toute la séquence, puis
    // appliquée avec un tramage ordonné. Le GIF ne compresse que ce qui ne
    // bouge pas d'une image à l'autre, et l'orthophoto ne se répète jamais :
    // 22 s en 800 px à 12 images/s pesaient 51 Mo, les mêmes 14 s en 640 px à
    // 10 images/s 15 Mo, en 480 px à 8 images/s et 96 couleurs 6,7 Mo. Sans
    // tramage, ou en sierra, le fichier grossit (11,7 et 13,5 Mo en 560 px).
    const filtre = `fps=8,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', VIDEO_MUETTE, '-filter_complex', filtre, `${nom}.gif`], { stdio: 'inherit' });
    fs.copyFileSync(VIDEO_MUETTE, `${nom}.mp4`);
} else if (!fmt.voix && MUSIQUE) {
    const duree = images / FPS, fondu = 2.5;
    // La musique part après la séquence `musiqueApres` (un avertissement), sinon d'emblée.
    const apres = fmt.musiqueApres && sequences.find(q => q.id === fmt.musiqueApres);
    const decalage = apres ? Math.round((apres.debut + apres.duree) * 1000) : 0;
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', VIDEO_MUETTE, '-i', MUSIQUE, '-map', '0:v', '-map', '1:a',
                         '-af', `adelay=${decalage}:all=1,apad,afade=t=out:st=${(duree - fondu).toFixed(2)}:d=${fondu}`, '-t', duree.toFixed(3),
                         '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', `${nom}.mp4`], { stdio: 'inherit' });
} else if (!fmt.voix) {
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', VIDEO_MUETTE, '-c:v', 'copy', '-movflags', '+faststart', `${nom}.mp4`], { stdio: 'inherit' });
} else {
    // La piste son : chaque phrase complétée de silence à la durée de sa séquence.
    const liste = path.join(TRAVAIL, 'pistes.txt');
    const lignes = [];
    for (const q of sequences) {
        const piste = path.join(TRAVAIL, `${q.id}.wav`);
        const duree = (Math.round(q.duree * FPS) / FPS).toFixed(3);
        spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', q.audio, '-af', `apad=whole_dur=${duree}`, '-ar', '48000', '-ac', '2', '-t', duree, piste], { stdio: 'inherit' });
        lignes.push(`file '${piste}'`);
    }
    fs.writeFileSync(liste, lignes.join('\n') + '\n');
    const son = path.join(TRAVAIL, 'son.wav');
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', liste, '-c', 'copy', son], { stdio: 'inherit' });
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', VIDEO_MUETTE, '-i', son, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
                         '-shortest', '-movflags', '+faststart', `${nom}.mp4`], { stdio: 'inherit' });
}
console.log(`${images} images, ${(images / FPS).toFixed(1)} s → ${nom}.${fmt.gif ? 'gif' : 'mp4'}`);
process.exit(erreurs.length ? 1 : 0);
