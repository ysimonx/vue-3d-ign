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
import { estModulePrincipal, repondreAvecCrochet } from './crochet-page.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

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
// --- Série « fonctionnalités » -------------------------------------------------
// Un film par fonctionnalité, chacun en deux cadres, au choix du second
// argument : carré pour LinkedIn (vue seule, lue sur un téléphone, texte
// gros), paysage pour YouTube (l'application telle quelle, panneau compris, où
// le curseur incrusté clique les boutons). Muets, le texte incrusté (choix de
// l'utilisateur) ; un lieu emblématique en ouverture ; la fin donne le site en
// ligne, le dépôt et le profil LinkedIn.
//
//   node outils/demo-video.mjs bornes carre      # docs/demo/demo-bornes-carre.mp4
//   node outils/demo-video.mjs bornes paysage    # docs/demo/demo-bornes-paysage.mp4
//   node outils/demo-video.mjs ensoleillement carre   # Strasbourg : le soleil des toits, puis le partage de la vue
const SERIE = ['lidar', 'recherche', 'dpe-dvf', 'drone', 'bornes', 'vehicules', 'soleil', 'export', 'ensoleillement'];
const DANS_SERIE = SERIE.includes(FORMAT);
const ASPECT = DANS_SERIE ? (process.argv[3] || 'carre') : null;
const ASPECTS = {
    carre: { largeur: 1080, hauteur: 1080, panneau: false, voix: false, texte: 'court', police: 38, sansVoixOff: true },
    paysage: { largeur: 1920, hauteur: 1080, panneau: true, voix: false, texte: 'court', police: 32, sansVoixOff: true },
};
// La recherche se tape dans le panneau, les exports s'y cliquent : il reste visible au carré.
const AVEC_PANNEAU = ['recherche', 'export'];
const fmt = DANS_SERIE
    ? ASPECTS[ASPECT] && { ...ASPECTS[ASPECT], serie: true, panneau: ASPECTS[ASPECT].panneau || AVEC_PANNEAU.includes(FORMAT) }
    : FORMATS[FORMAT];
if (!fmt) {
    console.error(`format inconnu : ${FORMAT} ${ASPECT || ''} (youtube | linkedin | readme | foncier | industrie | gadzarts, `
                  + `ou ${SERIE.join(' | ')} suivi de carre | paysage)`);
    process.exit(2);
}
const NOM_FILM = DANS_SERIE ? `${FORMAT}-${ASPECT}` : FORMAT;

const TRAVAIL = path.join(os.tmpdir(), 'vue3d-demo', NOM_FILM);
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
// Les lieux de la série, en zone de 1 000 m, choisis le 2026-10-16 sur des
// aperçus au carré : Étretat écarté (la mer y passe 2 % de la scène, le
// relief RGE ALTI manque, les falaises sortent en murs sombres), Moustiers
// aussi (la montagne en gradins derrière le village), Rocamadour pour le
// drone (au décollage, les volumes gris du sanctuaire emplissaient l'image,
// puis un causse plat). Comptés ce jour-là :
// Chambord, 169 343 points LiDAR et 7 918 arbres ; La Rochelle, 3 716 DPE et
// 606 parcelles vendues ; l'Arc de Triomphe, 31 stations de recharge ;
// Saint-Tropez, 184 bateaux, 457 véhicules, 36 piscines.
const CHAMBORD = { lat: 47.6161, lon: 1.5171, zone: 1000 };
const VERSAILLES = { lat: 48.8049, lon: 2.1204, zone: 1000 };
// Les points où mène la recherche : ceux que rend le géocodage de l'IGN.
const ARC = { lat: 48.87379, lon: 2.295057, zone: 1000 };
const HAUSSMANN = { lat: 48.873199, lon: 2.332434, zone: 1000 };
const OPERA = { lon: 2.33163, lat: 48.87197 };
const LA_ROCHELLE = { lat: 46.1585, lon: -1.1520, zone: 1000 };
// Le lac d'Annecy, vu de la vieille ville : sa photo et les sommets alentour
// ne sont chargés qu'au bout de 20 à 25 s (chauffer), gris foncé avant.
const ANNECY = { lat: 45.8992, lon: 6.1294, zone: 1000 };
const SAINT_TROPEZ = { lat: 43.2722, lon: 6.6403, zone: 1000 };
const CHAMONIX = { lat: 45.9237, lon: 6.8694, zone: 1000 };
// Le point est sur la nef : la cathédrale est le bâtiment le plus proche de l'origine du fichier IFC.
const NOTRE_DAME = { lat: 48.85296, lon: 2.34991, zone: 1000 };
// La Grande Île de Strasbourg : 1 148 toits calculés en zone de 1 000 m,
// cours étroites et pans à l'ombre de leurs voisins (mesuré le 3 novembre 2026).
const STRASBOURG = { lat: 48.5819, lon: 7.751, zone: 1000 };
const SITE = 'vue-3d-ign.kysoe.com';
const SITE_DEMO = `https://${SITE}`;
const LINKEDIN = 'linkedin.com/in/ysimon';
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

// --- Série : les films ------------------------------------------------------------
// Chaque film : une ouverture sur son lieu, le titre en fondu après deux
// secondes et demie de vue libre ; les fonctions montrées en zooms (pas
// d'orbite, jugée répétitive) ; la fin sur les liens. Chaque ouverture est
// préchauffée (chauffer) : sans l'anneau et l'horizon, encore à charger, la
// scène flottait dans le vide, au paysage surtout.
const apparaitre = (s, t, debut = 2.5) => s.carte(Math.min(1, Math.max(0, (t * s.duree - debut) / FONDU_S)));
/** Le carton de fin d'un film : le site en ligne, le dépôt, le profil LinkedIn, puis les crédits. */
function finSerie(film, lieu, vers, credits) {
    return {
        id: `${film}-fin`, lieu, duree: 7, formats: [film], court: '',
        carte: { titre: 'Vue 3D IGN', html: `<div class="fin-liens">`
            + `<div><b>Essayez-la</b><span>${SITE}</span></div>`
            + `<div><b>Le code, libre (MIT)</b><span>github.com/ysimonx/vue-3d-ign</span></div>`
            + `<div><b>Yannick Simon</b><span>${LINKEDIN}</span></div></div>`
            + `<div class="fin-credits">${credits}<br>Données © IGN · Licence Ouverte 2.0</div>` },
        async jouer(s) {
            await s.cartouche('');
            await s.cacherCurseur();
            await s.fermerInfobulle();
            await s.glisser(s.duree, null, vers);
        },
    };
}
const SEQUENCES_SERIE = [
    // --- LiDAR HD : Chambord ---------------------------------------------------
    // Les monuments d'OpenStreetMap éteints tout le film : ils remplaceraient
    // le château par son modèle, et le film parle du relevé de l'IGN.
    {
        id: 'l-titre', lieu: CHAMBORD, duree: 7, formats: ['lidar'],
        court: 'Le château de Chambord, en 3D depuis les données ouvertes de l’IGN',
        carte: { titre: 'LiDAR HD', sous: 'Vue 3D IGN · le relevé laser de l’IGN, en 3D' }, carteDifferee: true,
        async jouer(s) {
            await s.chauffer({ ...CHAMBORD, hauteur: 20, distance: 820, azimut: 180, elevation: 34 }, 20);
            await s.eteindre('t-monuments');
            await s.glisser(s.duree, { ...CHAMBORD, hauteur: 20, distance: 820, azimut: 180, elevation: 34 },
                                     { ...CHAMBORD, hauteur: 20, distance: 600, azimut: 200, elevation: 28 }, t => apparaitre(s, t));
        },
    },
    {
        id: 'l-bdtopo', lieu: CHAMBORD, duree: 7, formats: ['lidar'],
        court: 'Sans le LiDAR : les volumes de la BD TOPO, des toits estimés',
        async jouer(s) {
            await s.bouton('t-mesure', false);
            await s.glisser(s.duree, null, { ...CHAMBORD, hauteur: 25, distance: 300, azimut: 215, elevation: 30 });
        },
    },
    {
        id: 'l-toits', lieu: CHAMBORD, duree: 8, formats: ['lidar'],
        court: 'Avec le LiDAR HD : les toits mesurés, faîtages, lanternes et cheminées',
        async jouer(s) {
            await s.bouton('t-mesure', true);
            await s.glisser(s.duree, null, { ...CHAMBORD, hauteur: 30, distance: 210, azimut: 240, elevation: 30 });
        },
    },
    {
        id: 'l-nuage', lieu: CHAMBORD, duree: 10, formats: ['lidar'],
        court: 'Le nuage LiDAR HD : chaque point mesuré par l’avion',
        async jouer(s) {
            const n = await couche('nuage');
            await s.bouton('t-nuage', true);
            await s.cartouche(`<b>Nuage LiDAR HD</b><br>${n.n.toLocaleString('fr-FR')} points`);
            await s.glisser(s.duree, null, { ...CHAMBORD, hauteur: 30, distance: 260, azimut: 290, elevation: 24 });
        },
    },
    {
        id: 'l-arbres', lieu: CHAMBORD, duree: 8, formats: ['lidar'],
        court: 'Chaque arbre, segmenté sur la hauteur mesurée à 50 cm',
        async jouer(s) {
            const scene = await couche('scene');
            await s.bouton('t-nuage', false);
            await s.cartouche(`<b>${(scene.houppiers || []).length.toLocaleString('fr-FR')} arbres</b><br>chacun à sa hauteur`);
            await s.glisser(s.duree, null, { ...CHAMBORD, distance: 700, azimut: 160, elevation: 42 });
        },
    },
    finSerie('lidar', CHAMBORD, { ...CHAMBORD, distance: 820, azimut: 150, elevation: 44 }, 'LiDAR HD et BD TOPO © IGN'),

    // --- Recherche et recentrage : Versailles, l'Arc, Haussmann, l'Opéra --------
    {
        id: 'r-titre', lieu: VERSAILLES, duree: 6, formats: ['recherche'],
        court: 'Le château de Versailles',
        carte: { titre: 'Chercher un lieu', sous: 'Vue 3D IGN · une adresse, un monument, une entreprise' }, carteDifferee: true,
        async jouer(s) {
            await s.chauffer({ ...VERSAILLES, hauteur: 20, distance: 700, azimut: 100, elevation: 30 }, 20);
            await s.glisser(s.duree, { ...VERSAILLES, hauteur: 20, distance: 700, azimut: 100, elevation: 30 },
                                     { ...VERSAILLES, hauteur: 20, distance: 520, azimut: 115, elevation: 26 }, t => apparaitre(s, t, 2));
        },
    },
    {
        id: 'r-monument', lieu: VERSAILLES, duree: 7, formats: ['recherche'],
        court: 'Un monument, une adresse ou une entreprise : la liste vient dès la frappe',
        async jouer(s) {
            await s.chercher('arc de triomphe', 'Arc de Triomphe');
        },
    },
    {
        id: 'r-arc', lieu: ARC, duree: 7, formats: ['recherche'],
        court: 'La scène se construit autour du lieu choisi',
        async jouer(s) {
            await s.glisser(s.duree, { ...ARC, hauteur: 20, distance: 520, azimut: 140, elevation: 36 },
                                     { ...ARC, hauteur: 20, distance: 330, azimut: 165, elevation: 30 });
        },
    },
    {
        id: 'r-adresse', lieu: ARC, duree: 8, formats: ['recherche'],
        court: 'Ou une adresse, au numéro près',
        async jouer(s) {
            await s.chercher('40 boulevard haussmann paris', '40 Boulevard Haussmann');
        },
    },
    {
        id: 'r-haussmann', lieu: HAUSSMANN, duree: 6, formats: ['recherche'],
        court: 'Boulevard Haussmann : les Galeries Lafayette, l’Opéra derrière',
        async jouer(s) {
            await s.glisser(s.duree, { ...HAUSSMANN, hauteur: 10, distance: 480, azimut: 20, elevation: 34 },
                                     { ...HAUSSMANN, hauteur: 10, distance: 360, azimut: 10, elevation: 30 });
        },
    },
    {
        id: 'r-recentrer', lieu: HAUSSMANN, duree: 9, formats: ['recherche'],
        court: 'Un clic sur un bâtiment, un arbre, un véhicule : « Recentrer la scène » autour de lui',
        async jouer(s) {
            await s.cliquerSur({ ...OPERA, hauteur: 22 }, 1.4);
            await filmer(1.6);
            await s.suivreLien('#tip a.lien-recentrer', 1.2);
        },
    },
    {
        id: 'r-opera', lieu: null, duree: 9, formats: ['recherche'],
        court: '« Y aller » : l’itinéraire jusqu’à lui, dans Plans ou Google Maps',
        async jouer(s) {
            const ici = { ...lieuCourant };
            await s.glisser(4, { ...ici, hauteur: 20, distance: 420, azimut: 195, elevation: 32 },
                               { ...ici, hauteur: 20, distance: 300, azimut: 210, elevation: 30 });
            await s.cliquerSur({ ...ici, hauteur: 22 }, 1.2);
            await s.curseurVers({ selecteur: '#tip a.lien-y-aller' }, 1.2);
            await filmer(2);
        },
    },
    { ...finSerie('recherche', null, null, 'Géocodage © IGN · entreprises : répertoire SIRENE (INSEE)'), lieu: null,
      async jouer(s) {
          await s.cartouche(''); await s.cacherCurseur(); await s.fermerInfobulle();
          await s.glisser(s.duree, null, { ...lieuCourant, distance: 700, azimut: 230, elevation: 40 });
      } },

    // --- DPE et ventes : La Rochelle --------------------------------------------
    // Comme le film « foncier » : jamais l'infobulle d'une vente ni d'une
    // adresse, seulement des couleurs et des chiffres réunis.
    {
        id: 'd-titre', lieu: LA_ROCHELLE, duree: 7, formats: ['dpe-dvf'],
        court: 'La Rochelle, le Vieux-Port, en 3D depuis les données ouvertes',
        carte: { titre: 'DPE et ventes', sous: 'Vue 3D IGN · deux clics, des données ouvertes' }, carteDifferee: true,
        async jouer(s) {
            await s.chauffer({ ...LA_ROCHELLE, distance: 820, azimut: 190, elevation: 50 }, 20);
            await s.glisser(s.duree, { ...LA_ROCHELLE, distance: 820, azimut: 190, elevation: 50 },
                                     { ...LA_ROCHELLE, distance: 640, azimut: 200, elevation: 46 }, t => apparaitre(s, t));
        },
    },
    {
        id: 'd-dpe', lieu: LA_ROCHELLE, duree: 10, formats: ['dpe-dvf'],
        court: 'Un clic : chaque bâtiment à la couleur de son DPE (ADEME)',
        async jouer(s) {
            await s.bouton('t-dpe', true);
            await s.cartouche(await s.legendeDpe());
            await s.glisser(s.duree, null, { ...LA_ROCHELLE, distance: 340, azimut: 215, elevation: 38 });
        },
    },
    {
        id: 'd-immeuble', lieu: LA_ROCHELLE, duree: 8, formats: ['dpe-dvf'],
        court: 'D’un immeuble : la répartition de ses DPE, pas la liste',
        async jouer(s) {
            const b = await s.immeuble();
            await s.glisser(s.duree * 0.45, null, { ...b, distance: 110, azimut: 225, elevation: 32 });
            await s.survoler(b, s.duree * 0.55);
        },
    },
    {
        id: 'd-dvf', lieu: LA_ROCHELLE, duree: 11, formats: ['dpe-dvf'],
        court: 'Un autre clic : les ventes depuis 2021 (DVF), au prix du m²',
        async jouer(s) {
            await s.bouton('t-dvf', true);
            await s.bouton('t-dpe', false);
            await s.cartouche(await s.legendeDvf());
            const v = await s.amasVentes();
            await s.glisser(s.duree * 0.4, null, { ...LA_ROCHELLE, distance: 620, azimut: 200, elevation: 44 });
            await s.glisser(s.duree * 0.6, null, { ...v, distance: 230, azimut: 185, elevation: 36 });
        },
    },
    {
        id: 'd-deux', lieu: LA_ROCHELLE, duree: 8, formats: ['dpe-dvf'],
        court: 'Ensemble : la couleur du DPE, les bâtiments vendus cernés de cyan',
        async jouer(s) {
            await s.bouton('t-dpe', true);
            await s.cartouche(await s.legendeDpe(true));
            const v = await s.amasVentes();
            await s.glisser(s.duree, null, { ...v, distance: 130, azimut: 168, elevation: 33 });
        },
    },
    finSerie('dpe-dvf', LA_ROCHELLE, { ...LA_ROCHELLE, distance: 760, azimut: 200, elevation: 48 },
             'DPE © ADEME · ventes © DGFiP (DVF géolocalisées, Etalab)'),

    // --- Drone : le lac d'Annecy ---------------------------------------------------
    // Décollage de la vieille ville, tourné vers le sud-est : le drone survole
    // le lac en montant, les montagnes en face.
    {
        id: 'dr-titre', lieu: ANNECY, duree: 6, formats: ['drone'],
        court: 'Annecy, la vieille ville et le lac',
        carte: { titre: 'Le drone', sous: 'Vue 3D IGN · survoler le paysage, au clavier ou au doigt' }, carteDifferee: true,
        async jouer(s) {
            await s.chauffer({ ...ANNECY, hauteur: 20, distance: 900, azimut: 315, elevation: 22 }, 25);
            await s.glisser(s.duree, { ...ANNECY, hauteur: 20, distance: 900, azimut: 315, elevation: 22 },
                                     { ...ANNECY, hauteur: 20, distance: 700, azimut: 322, elevation: 18 }, t => apparaitre(s, t, 2));
        },
    },
    {
        id: 'dr-decollage', lieu: ANNECY, duree: 5, formats: ['drone'],
        court: 'Un bouton : le drone décolle de ce que l’on regarde',
        async jouer(s) {
            await s.glisser(1.6, null, { ...ANNECY, hauteur: 20, distance: 240, azimut: 318, elevation: 18 });
            await s.vitesse(10);
            await s.bouton('t-drone', true);
            await s.lacher();
            await s.voler(s.duree - 2.2, ['Space']);
        },
    },
    {
        id: 'dr-vol', lieu: ANNECY, duree: 13, formats: ['drone'],
        court: 'Avancer, tourner, monter, descendre : au clavier, ou au doigt sur l’écran',
        async jouer(s) {
            await s.voler(5, ['ArrowUp']);
            await s.voler(2.5, ['ArrowUp', 'ArrowRight']);
            await s.voler(3, ['ArrowUp']);
            await s.voler(2.5, ['ArrowUp', 'ArrowLeft']);
        },
    },
    {
        id: 'dr-horizon', lieu: ANNECY, duree: 9, formats: ['drone'],
        court: 'Au-delà de la scène : le relief et la photo aérienne jusqu’à 60 km',
        async jouer(s) {
            await s.voler(s.duree, ['ArrowUp', 'Space']);
        },
    },
    {
        ...finSerie('drone', ANNECY, null, 'RGE ALTI, orthophotos et BD TOPO © IGN'),
        async jouer(s) { await s.cartouche(''); await s.voler(s.duree, ['ArrowUp']); },
    },

    // --- Bornes de recharge : l'Arc de Triomphe -----------------------------------
    {
        id: 'b-titre', lieu: ARC, duree: 6, formats: ['bornes'],
        court: 'L’Arc de Triomphe et la place de l’Étoile',
        carte: { titre: 'Bornes de recharge', sous: 'Vue 3D IGN · la base nationale des IRVE, d’un clic' }, carteDifferee: true,
        async jouer(s) {
            await s.chauffer({ ...ARC, hauteur: 20, distance: 760, azimut: 140, elevation: 40 }, 20);
            await s.glisser(s.duree, { ...ARC, hauteur: 20, distance: 760, azimut: 140, elevation: 40 },
                                     { ...ARC, hauteur: 20, distance: 580, azimut: 160, elevation: 36 }, t => apparaitre(s, t, 2));
        },
    },
    {
        id: 'b-allumer', lieu: ARC, duree: 9, formats: ['bornes'],
        court: 'Un clic : chaque station de recharge, teinte de sa puissance',
        async jouer(s) {
            await s.bouton('t-bornes', true);
            await s.cartouche(await s.legendeBornes());
            await s.glisser(s.duree, null, { ...ARC, distance: 760, azimut: 175, elevation: 52 });
        },
    },
    {
        id: 'b-station', lieu: ARC, duree: 10, formats: ['bornes'],
        court: 'Opérateur, points de charge, puissance, prises, accès',
        async jouer(s) {
            const st = await s.stationAMontrer();
            await s.glisser(4, null, { ...st, distance: 210, azimut: 200, elevation: 42 });
            await s.cliquerSur({ ecran: await s.pastille(st) }, 1.4);
            await filmer(s.duree - 5.6);
        },
    },
    {
        id: 'b-yaller', lieu: ARC, duree: 6, formats: ['bornes'],
        court: '« Y aller » : l’itinéraire jusqu’à la borne, dans Plans ou Google Maps',
        async jouer(s) {
            await s.curseurVers({ selecteur: '#tip a.lien-y-aller' }, 1.4);
            await filmer(s.duree - 1.4);
        },
    },
    finSerie('bornes', ARC, { ...ARC, distance: 800, azimut: 200, elevation: 50 },
             'Bornes : base nationale des IRVE (data.gouv.fr)'),

    // --- Véhicules, bateaux, piscines : Saint-Tropez --------------------------------
    {
        id: 'v-titre', lieu: SAINT_TROPEZ, duree: 6, formats: ['vehicules'],
        court: 'Saint-Tropez, le port et la vieille ville',
        carte: { titre: 'Bateaux, véhicules, piscines', sous: 'Vue 3D IGN · lus sur la photo aérienne' }, carteDifferee: true,
        async jouer(s) {
            await s.chauffer({ ...SAINT_TROPEZ, distance: 780, azimut: 195, elevation: 40 }, 20);
            await s.glisser(s.duree, { ...SAINT_TROPEZ, distance: 780, azimut: 195, elevation: 40 },
                                     { ...SAINT_TROPEZ, distance: 580, azimut: 205, elevation: 34 }, t => apparaitre(s, t, 2));
        },
    },
    {
        id: 'v-bateaux', lieu: SAINT_TROPEZ, duree: 9, formats: ['vehicules'],
        court: 'Les bateaux du port, lus sur la photo aérienne par un réseau de neurones',
        async jouer(s) {
            const ou = await s.amas('navires');
            await s.glisser(s.duree * 0.45, null, { ...ou, distance: 150, azimut: 200, elevation: 42 });
            await s.survoler(ou.exemple, s.duree * 0.55);
        },
    },
    {
        id: 'v-vehicules', lieu: SAINT_TROPEZ, duree: 8, formats: ['vehicules'],
        court: 'Les véhicules, là où ils étaient le jour de la prise de vue',
        async jouer(s) {
            const ou = await s.amas('vehicules');
            await s.glisser(s.duree * 0.45, null, { ...ou, distance: 90, azimut: 210, elevation: 45 });
            await s.survoler(ou.exemple, s.duree * 0.55);
        },
    },
    {
        id: 'v-piscines', lieu: SAINT_TROPEZ, duree: 8, formats: ['vehicules'],
        court: 'Les piscines, à la couleur de leur eau ce jour-là',
        async jouer(s) {
            const ou = await s.amas('piscines');
            // Presque à la verticale : vue en biais, la maison voisine cachait
            // la piscine, et c'est son infobulle qui s'ouvrait.
            await s.glisser(s.duree * 0.45, null, { ...ou, distance: 85, azimut: 160, elevation: 66 });
            await s.survoler(ou.exemple, s.duree * 0.55);
        },
    },
    {
        id: 'v-recentrer', lieu: SAINT_TROPEZ, duree: 8, formats: ['vehicules'],
        court: 'Un clic sur un bateau : sa fiche, et « Recentrer la scène » sur lui',
        async jouer(s) {
            const ou = await s.amas('navires');
            await s.glisser(2.5, null, { ...ou.exemple, distance: 120, azimut: 190, elevation: 44 });
            await s.cliquerSur(ou.exemple, 1.3);
            await s.curseurVers({ selecteur: '#tip a.lien-recentrer' }, 1.2);
            await filmer(s.duree - 5);
        },
    },
    finSerie('vehicules', SAINT_TROPEZ, { ...SAINT_TROPEZ, distance: 760, azimut: 205, elevation: 44 },
             'Détection RTMDet sur l’orthophoto © IGN'),

    // --- Le soleil : Chamonix, face au Mont-Blanc -------------------------------------
    // Caméra au nord de la ville, tournée vers le massif : l'horizon (tuiles du
    // RGE ALTI) est chargé avant le tournage (chauffer).
    {
        id: 'so-titre', lieu: CHAMONIX, duree: 7, formats: ['soleil'],
        court: 'Chamonix, face au massif du Mont-Blanc',
        carte: { titre: 'Le soleil', sous: 'Vue 3D IGN · sa vraie course, au lieu, au jour et à l’heure' }, carteDifferee: true,
        async jouer(s) {
            await s.heure(11);
            await s.chauffer({ ...CHAMONIX, hauteur: 200, distance: 1500, azimut: 15, elevation: 16 }, 30);
            await s.glisser(s.duree, { ...CHAMONIX, hauteur: 200, distance: 1500, azimut: 15, elevation: 16 },
                                     { ...CHAMONIX, hauteur: 200, distance: 1150, azimut: 5, elevation: 13 }, t => apparaitre(s, t));
        },
    },
    {
        id: 'so-heures', lieu: CHAMONIX, duree: 12, formats: ['soleil'],
        court: 'Heure par heure : les ombres du relief et des bâtiments suivent le soleil',
        async jouer(s) { await s.heures(s.duree, 7.5, 19); },
    },
    {
        id: 'so-hiver', lieu: CHAMONIX, duree: 8, formats: ['soleil'],
        court: '21 décembre, midi : le soleil passe à peine le massif',
        async jouer(s) {
            await s.saison(12, 21, 12);
            await s.glisser(s.duree, null, { ...CHAMONIX, hauteur: 80, distance: 650, azimut: 350, elevation: 20 });
        },
    },
    {
        id: 'so-ete', lieu: CHAMONIX, duree: 7, formats: ['soleil'],
        court: '21 juin, midi : la vallée en plein soleil',
        async jouer(s) {
            await s.saison(6, 21, 12);
            await s.glisser(s.duree, null, { ...CHAMONIX, hauteur: 80, distance: 600, azimut: 20, elevation: 22 });
        },
    },
    finSerie('soleil', CHAMONIX, { ...CHAMONIX, hauteur: 300, distance: 1700, azimut: 0, elevation: 18 },
             'RGE ALTI, LiDAR HD et BD TOPO © IGN'),

    // --- L'ensoleillement des toits : Strasbourg -------------------------------------
    // Le calcul se fait pendant le tournage, quatre cartes d'ombre par image du
    // film : les toits passent de la photo à la carte en trois secondes.
    {
        id: 'en-titre', lieu: STRASBOURG, duree: 7, formats: ['ensoleillement'],
        court: 'Strasbourg, la cathédrale et la Grande Île',
        carte: { titre: 'Ensoleillement', sous: 'Vue 3D IGN · le soleil d’une année, toit par toit' }, carteDifferee: true,
        async jouer(s) {
            await s.chauffer({ ...STRASBOURG, hauteur: 30, distance: 780, azimut: 200, elevation: 38 }, 20);
            await s.glisser(s.duree, { ...STRASBOURG, hauteur: 30, distance: 780, azimut: 200, elevation: 38 },
                                     { ...STRASBOURG, hauteur: 30, distance: 560, azimut: 190, elevation: 42 }, t => apparaitre(s, t));
        },
    },
    {
        id: 'en-allumer', lieu: STRASBOURG, duree: 10, formats: ['ensoleillement'],
        court: 'Un clic : chaque toit, du soleil reçu sur une année type de PVGIS',
        async jouer(s) {
            await s.bouton('t-solaire', true);
            await s.cartouche(await s.legendeSolaire());
            await s.glisser(s.duree, null, { ...STRASBOURG, hauteur: 20, distance: 420, azimut: 170, elevation: 55 });
        },
    },
    {
        id: 'en-ombres', lieu: STRASBOURG, duree: 9, formats: ['ensoleillement'],
        court: 'L’ombre des voisins, des arbres et du relief, toute l’année',
        async jouer(s) {
            const t = await s.toitAMontrer();
            await s.glisser(s.duree, null, { ...t, hauteur: 10, distance: 230, azimut: 160, elevation: 60 });
        },
    },
    {
        id: 'en-toit', lieu: STRASBOURG, duree: 11, formats: ['ensoleillement'],
        court: 'Un toit : son soleil, sa surface favorable, ce qu’il pourrait produire',
        async jouer(s) {
            const t = await s.toitAMontrer();
            await s.glisser(3, null, { ...t, hauteur: 10, distance: 150, azimut: 170, elevation: 52 });
            await s.cliquerSur(t, 1.3);
            await s.cartouche(await s.ficheSolaire());
            await filmer(s.duree - 4.75);
        },
    },
    {
        id: 'en-partage', lieu: STRASBOURG, duree: 7, formats: ['ensoleillement'],
        court: 'Partager la vue : un lien qui la rouvre telle quelle',
        async jouer(s) {
            await s.fermerInfobulle();
            await s.cartouche('');
            await s.bouton('btn-partager');
            const lien = await page.evaluate(async () => (await import('/static/js/scene/interface/partage.js')).lienDeLaVue());
            await s.cartouche(`<b>Lien copié</b><br>${lien.replace(/^https?:\/\/[^/]+/, SITE_DEMO).replace(/&/g, '&amp;').replace(/,/g, ',<wbr>')}`);
            await filmer(s.duree - 1.6);
        },
    },
    finSerie('ensoleillement', STRASBOURG, { ...STRASBOURG, hauteur: 30, distance: 760, azimut: 200, elevation: 44 },
             'Climat : PVGIS © Union européenne · LiDAR HD et BD TOPO © IGN'),

    // --- Export BIM : Notre-Dame de Paris ---------------------------------------------
    // La page écrit la maquette (IFC 4, puis CityGML 2.0) ; le fichier IFC est
    // ensuite rouvert dans outils/visionneuse-ifc.html, où web-ifc le relit sans
    // rien devoir à la page : ce qu'on y voit est ce que le fichier contient.
    // Les cadres de la visionneuse visent un point en mètres (est, nord) depuis
    // l'origine du fichier, le centre de la scène.
    {
        id: 'e-titre', lieu: NOTRE_DAME, duree: 7, formats: ['export'],
        court: 'Notre-Dame de Paris et l’île de la Cité',
        carte: { titre: 'Export BIM', sous: 'Vue 3D IGN · la maquette du lieu, en IFC ou en CityGML' }, carteDifferee: true,
        async jouer(s) {
            await s.chauffer({ ...NOTRE_DAME, hauteur: 20, distance: 800, azimut: 120, elevation: 34 }, 20);
            await s.glisser(s.duree, { ...NOTRE_DAME, hauteur: 20, distance: 800, azimut: 120, elevation: 34 },
                                     { ...NOTRE_DAME, hauteur: 20, distance: 600, azimut: 135, elevation: 32 }, t => apparaitre(s, t, 2));
        },
    },
    {
        id: 'e-ifc', lieu: NOTRE_DAME, duree: 10, formats: ['export'],
        court: 'Relief, bâtiments, arbres : un clic, et la maquette part en IFC 4',
        async jouer(s) {
            // Le curseur part du panneau : venu de la vue, il ouvrait au passage l'infobulle d'un arbre.
            await montrerCurseur({ x: 150, y: 600 });
            await page.mouse.move(150, 600);
            for (const id of ['x-relief', 'x-batiments', 'x-arbres']) { await s.curseurVers({ selecteur: '#' + id }, 0.6); await filmer(0.25); }
            const { note } = await s.exporter('btn-ifc');
            await s.cartouche(cartoucheExport('IFC 4', note, 'Lambert-93, altitudes NGF'));
            await s.glisser(5.6, null, { ...NOTRE_DAME, hauteur: 20, distance: 420, azimut: 150, elevation: 30 });
        },
    },
    {
        id: 'e-citygml', lieu: NOTRE_DAME, duree: 7, formats: ['export'],
        court: 'Ou en CityGML 2.0, pour les SIG et les maquettes urbaines',
        async jouer(s) {
            const { note } = await s.exporter('btn-citygml');
            await s.cartouche(cartoucheExport('CityGML 2.0', note));
            await s.glisser(5.2, null, { ...NOTRE_DAME, hauteur: 25, distance: 330, azimut: 175, elevation: 32 });
        },
    },
    {
        id: 'e-visionneuse', lieu: null, duree: 9, formats: ['export'],
        court: 'Rouvert dans une visionneuse IFC : chaque bâtiment, chaque arbre est un objet',
        async jouer(s) {
            await s.cartouche('');
            await s.ouvrirIfc();
            await s.glisser(s.duree, { est: 0, nord: 0, hauteur: 10, distance: 900, azimut: 150, elevation: 38 },
                                     { est: 0, nord: 0, hauteur: 15, distance: 560, azimut: 168, elevation: 33 });
        },
    },
    {
        id: 'e-batiment', lieu: null, duree: 10, formats: ['export'],
        court: 'Un bâtiment : classe IFC, identifiant BD TOPO, usage, hauteur et sa source',
        async jouer(s) {
            const id = await page.evaluate(() => window.__visionneuse.plusProche('Bâtiment existant', 0, 0));
            await s.glisser(3, null, { est: 0, nord: 0, hauteur: 30, distance: 330, azimut: 200, elevation: 30 });
            await s.cliquerObjet(id, 1.2);
            await filmer(s.duree - 5.15);
        },
    },
    {
        id: 'e-arbre', lieu: null, duree: 9, formats: ['export'],
        court: 'Un arbre : sa hauteur et son houppier, mesurés au LiDAR HD',
        async jouer(s) {
            // Le plus haut du square Jean-XXIII, au chevet : le plus proche du
            // point était un pin de 8 m, perdu dans la masse.
            const id = await page.evaluate(() => window.__visionneuse.plusHaut('Arbre', 80, -55, 45));
            const c = await page.evaluate(id => window.__visionneuse.centre(id), id);
            await s.glisser(3, null, { ...c, distance: 85, azimut: 165, elevation: 30 });
            await s.cliquerObjet(id, 1.2);
            await filmer(s.duree - 5.15);
        },
    },
    { ...finSerie('export', null, null, 'Monuments © contributeurs OpenStreetMap (ODbL) · visionneuse : web-ifc (MPL-2.0)'),
      async jouer(s) {
          await s.cartouche(''); await s.cacherCurseur();
          await page.evaluate(() => window.__visionneuse.choisir(null));
          await s.glisser(s.duree, null, { est: 0, nord: 0, hauteur: 10, distance: 820, azimut: 200, elevation: 40 });
      } },

];
/** Le cartouche d'un export, tiré de la note de la page : format, taille, contenu, repère. */
function cartoucheExport(format, note, repere) {
    const m = note.match(/ : ([\d,]+ Mo), (.*?)\. ([^,.]*)/);
    if (!m) throw new Error(`note d'export inattendue : ${note}`);
    const contenu = m[2].split(', ');
    return `<b>${format}</b> · ${m[1]}<br>${contenu.slice(0, -1).join(' · ')}<br>${contenu.at(-1)}<br>${repere || m[3]}`;
}
// Ce que chaque film lit d'avance, sur le serveur, avant de filmer : le clic
// filmé trouve alors sa couche en cache, sans attente à l'image.
const PRELECTURES = { lidar: ['nuage'], 'dpe-dvf': ['dpe', 'dvf'], bornes: ['bornes'], ensoleillement: ['solaire'] };

// --- Voix -------------------------------------------------------------------
// Avec une voix, les phrases sont dites avant le tournage : la durée de chaque
// séquence est le plus long de sa durée minimale et de sa phrase, plus une
// respiration. Sans voix, la durée minimale, qui laisse lire la légende.
const RESPIRATION_S = 0.7;
const dureeAudio = f => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).stdout);
const sequences = [...SEQUENCES, ...SEQUENCES_SERIE].filter(q => q.formats.includes(FORMAT));
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
// Le bouton de partage copie son lien : le presse-papiers est permis, et le
// prompt de repli, s'il vient, refermé plutôt que de bloquer la page.
await navigateur.defaultBrowserContext().overridePermissions(BASE, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
page.on('dialog', d => d.dismiss());
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
    ${fmt.serie ? '#hint { display:none !important; } #hud-drone:not([hidden]) { display:block !important; }' : ''}
    /* Les liens de l'infobulle épinglée (Recentrer, Y aller), à la taille de son texte. */
    #tip .lien-ext { font-size:${Math.round(fmt.police * 0.5)}px !important; padding:${Math.round(fmt.police * 0.15)}px ${Math.round(fmt.police * 0.3)}px !important; }
    ${fmt.serie ? '#demo-carte { background:rgba(18,20,24,.74) !important; }' : ''}
    /* Centrée par ses deux bords plutôt que par left:50% et translateX(-50%) :
       sa largeur y était bornée à la moitié de la vue, et la légende du carré,
       panneau visible, tenait sur quatre lignes de 390 px. */
    ${fmt.serie ? '#demo-legende { left:8% !important; right:8%; width:fit-content; margin:0 auto; transform:none !important; max-width:none; }' : ''}
    /* Le carton de fin de la série : trois liens, puis les crédits. */
    #demo-carte .fin-liens { display:flex; flex-direction:column; gap:${fmt.police * 0.55}px; margin-top:${fmt.police * 0.3}px; white-space:normal; }
    #demo-carte .fin-liens b { display:block; font-size:${Math.round(fmt.police * 0.7)}px; font-weight:500; opacity:.75; }
    #demo-carte .fin-liens span { display:block; font-size:${Math.round(fmt.police * 1.05)}px; font-weight:700; color:#ffb347; }
    #demo-carte .fin-credits { margin-top:${fmt.police * 1.1}px; font-size:${Math.round(fmt.police * 0.55)}px; opacity:.7; }
    /* Le curseur incrusté : la souris d'un navigateur sans écran ne se filme pas. */
    #demo-curseur { position:fixed; left:0; top:0; z-index:40; width:${Math.round(fmt.police * 1.15)}px;
        height:${Math.round(fmt.police * 1.15)}px; pointer-events:none; opacity:0; margin:-2px 0 0 -3px;
        filter:drop-shadow(0 2px 4px rgba(0,0,0,.55)); }
    #demo-onde { position:fixed; left:0; top:0; z-index:39; width:${fmt.police * 1.6}px; height:${fmt.police * 1.6}px;
        margin:-${fmt.police * 0.8}px 0 0 -${fmt.police * 0.8}px; border-radius:50%; border:3px solid #fff;
        background:rgba(255,179,71,.35); opacity:0; pointer-events:none; }
`;
// La fiche de la visionneuse IFC (film « export »), lisible à l'image : en
// paysage à droite, au carré en bas, la vue au-dessus, sur deux colonnes
// posées en grille — le fichier, son repère et son contenu à gauche, la
// sélection à droite. En colonnes CSS, la gauche débordait en 19 px, et la
// sélection partait dans une troisième colonne, hors de l'image. En 16 px, la
// fiche de la cathédrale (sept propriétés) tient dans la moitié basse. La
// légende et le cartouche restent sur la vue, la carte de titre couvre tout.
const STYLE_VISIONNEUSE = ASPECT === 'carre' ? `
    :root { font-size:16px; --bas:50%; }
    #vue, #depot { inset:0 0 var(--bas) 0 !important; }
    #fiche { top:auto !important; height:var(--bas); width:100% !important; border-left:0 !important;
        border-top:1px solid var(--bord); overflow:hidden !important; display:grid; grid-template-columns:1fr 1fr;
        grid-template-rows:repeat(6, auto) 1fr; column-gap:2.2rem; align-content:start; }
    #fiche > * { grid-column:1; align-self:start; }
    #fiche > h2:last-of-type { grid-column:2; grid-row:1; margin-top:0; }
    #fiche > #choix { grid-column:2; grid-row:2 / -1; }
    #demo-legende { bottom:calc(var(--bas) + 2.5%) !important; }
` : `
    :root { font-size:17px; }
    #demo-legende { right:calc(var(--fiche) + 8%) !important; }
`;
const HTML_DEMO = '<div id="demo-carte"><h1></h1><p></p></div><div id="demo-legende"></div><div id="demo-cartouche"></div>'
    + '<div id="demo-chapitre"><b></b><span></span></div><div id="demo-photo"><img alt=""><span></span></div>'
    + '<div id="demo-onde"></div><div id="demo-curseur"><svg viewBox="0 0 24 24" width="100%" height="100%">'
    + '<path d="M3 2l15 11.5-6.6.9 3.9 7.4-2.9 1.5-3.9-7.5L3 20.3z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg></div>'
    ;
// Les objets de la scène, lus par le script : importés à la suite du module
// principal de la page (outils/crochet-page.mjs).
const CROCHET_DEMO = `import * as THREE from 'three';
import { LON0, LAT0 } from './socle/point.js';
import { M_PAR_DEGRE_LON, M_PAR_DEGRE_LAT } from './socle/projection.js';
import { ySol } from './terrain/etat.js';
import { scene, camera, renderer, controls } from './socle/rendu.js';
import { MAT_CIBLE, MAT_CONTOUR_CIBLE, MAT_VOISIN, groupeBatiments } from './batiments/etat.js';
import { vegChargee } from './vegetation/couche.js';
import { drone, touchesDrone } from './interface/drone.js';
import { DATE_SIMULEE, majSoleil } from './interface/soleil.js';
window.__demo = { THREE, camera, controls, renderer, scene, ySol, majSoleil, DATE_SIMULEE,
    LON0, LAT0, M_PAR_DEGRE_LON, M_PAR_DEGRE_LAT, vegChargee: () => vegChargee,
    MAT_CIBLE, MAT_CONTOUR_CIBLE, MAT_VOISIN, drone, touchesDrone, groupeBatiments };`;
await page.setRequestInterception(true);
page.on('request', async r => {
    if (estModulePrincipal(r)) return repondreAvecCrochet(r, CROCHET_DEMO);
    if (r.resourceType() !== 'document') return r.continue();
    const rep = await fetch(r.url());
    let html = await rep.text();
    if (VISIONNEUSE && r.url().startsWith(VISIONNEUSE)) {
        if (!html.includes('<div id="vue"></div>')) { console.error('visionneuse inattendue : #vue introuvable'); process.exit(1); }
        html = html.replace('</style>', STYLE_DEMO + STYLE_VISIONNEUSE + '</style>')
                   .replace('<div id="vue"></div>', '<div id="vue"></div>' + HTML_DEMO);
        return r.respond({ status: rep.status, contentType: 'text/html; charset=utf-8', body: html });
    }
    // Le style des légendes après celui de la page, qui est dans sa feuille.
    if (!html.includes('</head>') || !html.includes('<div id="tip"></div>')) {
        console.error('page inattendue : </head> ou #tip introuvable'); process.exit(1);
    }
    html = html.replace('</head>', `<style>${STYLE_DEMO}</style>\n</head>`)
               .replace('<div id="tip"></div>', '<div id="tip"></div>' + HTML_DEMO);
    r.respond({ status: rep.status, contentType: 'text/html; charset=utf-8', body: html });
});

// --- Visionneuse IFC (film « export ») --------------------------------------------
// Le fichier téléchargé par la page (dans TRAVAIL) et outils/visionneuse-ifc.html,
// servis par un petit serveur local, lancé à la demande : la visionneuse lit
// le fichier par fetch, comme sur n'importe quel serveur.
const VISIONNEUSE_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'visionneuse-ifc.html');
let VISIONNEUSE = null;
let fichierIfc = null;          // le dernier IFC exporté par la page
async function serveurVisionneuse() {
    if (VISIONNEUSE) return VISIONNEUSE;
    const s = http.createServer((q, r) => {
        const nom = path.basename(decodeURIComponent(new URL(q.url, 'http://x').pathname));
        const f = nom === 'visionneuse-ifc.html' ? VISIONNEUSE_HTML : path.join(TRAVAIL, nom);
        if (!fs.existsSync(f)) { r.writeHead(404); return r.end(); }
        r.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
        fs.createReadStream(f).pipe(r);
    });
    await new Promise(ok => s.listen(0, '127.0.0.1', ok));
    s.unref();
    return VISIONNEUSE = `http://127.0.0.1:${s.address().port}`;
}
if (FORMAT === 'export') {
    // Les fichiers exportés arrivent dans TRAVAIL, sans boîte de dialogue.
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: TRAVAIL });
}

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
let cartoucheCourant = '';
let curseur = null;             // le curseur incrusté, en pixels de la page ; null : caché

/** Charge un lieu, attend la scène et toutes ses couches, puis fige l'horloge.
 *  `null` : on reste où la page est allée d'elle-même (suivreNavigation). */
async function charger(lieu) {
    if (!lieu || lieuCourant === lieu) return;
    // La page y est déjà allée d'elle-même (une suggestion choisie) : pas de rechargement.
    const ici = lieuCourant;
    if (ici && Math.abs(ici.lat - lieu.lat) < 1e-6 && Math.abs(ici.lon - lieu.lon) < 1e-6
        && (ici.zone || 1000) === (lieu.zone || 1000)) { lieuCourant = lieu; return; }
    lieuCourant = lieu;
    console.log(`  ${urlDe(lieu)}`);
    if (FORMAT === 'foncier') {
        // Le serveur construit la scène, puis lit DPE et ventes : le clic
        // filmé les trouve en cache, sans attente à l'image.
        for (const nom of ['scene', 'dpe', 'dvf']) await couche(nom);
    }
    if (FORMAT === 'industrie' || FORMAT === 'gadzarts' || FORMAT === 'lidar') {
        // Le nuage d'une zone de 1 000 m se lit en 30 à 90 s : d'avance.
        // Hors couverture LiDAR HD (Lille, en octobre 2026), il n'y en a pas.
        await couche('scene');
        lieu.sansNuage = !(await couche('nuage'));
    }
    if (fmt.serie) {
        await couche('scene');
        for (const c of PRELECTURES[FORMAT] || []) await couche(c);
    }
    await page.goto(urlDe(lieu), { waitUntil: 'domcontentloaded' });
    await preparer(lieu);
}

/** La page d'un lieu chargée : ses couches attendues, l'horloge figée, l'habillage reposé. */
async function preparer(lieu) {
    await page.waitForFunction(() => document.getElementById('attente').hidden, { timeout: 15 * 60 * 1000 });
    await page.waitForFunction(() => window.__demo && window.__demo.vegChargee()
        && [...document.querySelectorAll('.etat-couche')].every(e => e.hidden || !e.classList.contains('en-cours')),
        { timeout: 15 * 60 * 1000 });
    // Le bouton du nuage n'apparaît qu'une fois ses points construits.
    if ((FORMAT === 'industrie' || FORMAT === 'gadzarts' || FORMAT === 'lidar') && !lieu.sansNuage) {
        await page.waitForFunction(() => !document.getElementById('t-nuage').hidden, { timeout: 15 * 60 * 1000 });
    }
    await new Promise(r => setTimeout(r, 2500));       // textures et compilation des matériaux
    // L'orbite démarre d'elle-même avec la scène : la caméra est au script.
    if (await allume('t-orbit')) await cliquer('t-orbit');
    // Le bâtiment visé (orange) dit à l'utilisateur de quel bâtiment parle la
    // fiche ; dans un film, il ne fait qu'attirer l'œil, sur Chambord tout le château.
    if (fmt.serie) {
        await page.evaluate(() => {
            const d = window.__demo;
            d.MAT_CONTOUR_CIBLE.visible = false;
            d.MAT_CIBLE.color.copy(d.MAT_VOISIN.color);
            d.MAT_CIBLE.roughness = d.MAT_VOISIN.roughness;
        });
    }
    await page.evaluate(() => window.__manuel());
    // Scruté à intervalle : par défaut, puppeteer scrute par requestAnimationFrame, désormais figé.
    await page.waitForFunction(() => window.__pret(), { timeout: 5000, polling: 100 });
    await page.evaluate(() => { document.getElementById('tip').style.display = 'none'; });
    // Une navigation de la page a remis le document à neuf : la légende et le
    // cartouche de la séquence en cours sont reposés.
    curseur = null;
    await page.evaluate((l, c) => {
        document.getElementById('demo-legende').textContent = l;
        document.getElementById('demo-cartouche').innerHTML = c;
    }, legende.texte || '', cartoucheCourant);
}

/** La page part d'elle-même (une suggestion, « Recentrer la scène ») : on la suit jusqu'au nouveau lieu. */
async function suivreNavigation(declencher) {
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15 * 60 * 1000 });
    await declencher();
    await navigation;
    const u = new URL(page.url());
    const lieu = { lat: Number(u.searchParams.get('lat')), lon: Number(u.searchParams.get('lon')),
                   zone: Number(u.searchParams.get('zone')) || 1000 };
    lieuCourant = lieu;
    dernierCadre = null;
    console.log(`  → ${urlDe(lieu)}`);
    await preparer(lieu);
    // Un cadre propre plutôt que la vue d'ouverture de la page, trop proche ;
    // l'anneau et l'horizon du nouveau lieu chargés avant de filmer : sans
    // cela, la scène flottait dans le vide les premières secondes.
    await outils.chauffer({ ...lieu, hauteur: 15, distance: 500, azimut: 150, elevation: 32 }, 12);
}

/** Une couche du lieu courant, lue par le script (déjà en cache côté serveur). */
async function couche(nom) {
    const l = lieuCourant;
    const r = await fetch(`${BASE}/api/${nom}?lat=${l.lat}&lon=${l.lon}${l.zone ? `&zone=${l.zone}` : ''}`);
    if (!r.ok) throw new Error(`/api/${nom} : HTTP ${r.status}`);
    return r.json();
}

/** Caméra posée sur un cadre : point visé (lon, lat, hauteur au-dessus du sol), distance, azimut, élévation ;
 *  dans la visionneuse IFC, point visé en mètres (est, nord) depuis l'origine du fichier. */
const poserCadre = c => page.evaluate(c => {
    if (c.est != null) return window.__visionneuse.poser(c);
    const d = window.__demo;
    const x = (c.lon - d.LON0) * d.M_PAR_DEGRE_LON, z = -(c.lat - d.LAT0) * d.M_PAR_DEGRE_LAT;
    const y = d.ySol(c.lon, c.lat) + (c.hauteur || 0);
    const r = Math.PI / 180, cosE = Math.cos(c.elevation * r);
    d.controls.target.set(x, y, z);
    d.camera.position.set(x + c.distance * Math.sin(c.azimut * r) * cosE, y + c.distance * Math.sin(c.elevation * r),
                          z - c.distance * Math.cos(c.azimut * r) * cosE);
}, c);
const cadreEntre = (a, b, t) => ({
    ...(b.est != null ? { est: a.est + (b.est - a.est) * t, nord: a.nord + (b.nord - a.nord) * t }
                      : { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t }),
    hauteur: (a.hauteur || 0) + ((b.hauteur || 0) - (a.hauteur || 0)) * t,
    distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * t),
    azimut: a.azimut + (b.azimut - a.azimut) * t, elevation: a.elevation + (b.elevation - a.elevation) * t,
});
let dernierCadre = null;

/** Cadre courant lu sur la caméra (après une orbite, par exemple). */
const lireCadre = () => page.evaluate(() => {
    if (window.__visionneuse) return window.__visionneuse.lire();
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
        if (c) {
            e.querySelector('h1').textContent = c.titre;
            if (c.html) e.querySelector('p').innerHTML = c.html; else e.querySelector('p').textContent = c.sous;
        }
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
        return { lon, lat, exemple: { lon: ex[0], lat: ex[1], hauteur: couche === 'vehicules' ? 1 : couche === 'navires' ? 1.5 : 0 } };
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
    async cartouche(html) {
        cartoucheCourant = html;
        await page.evaluate(h => { document.getElementById('demo-cartouche').innerHTML = h; }, html);
    },
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

    // --- Série : le curseur, les clics, la frappe, le drone, les bornes -------------
    /** Le curseur incrusté glisse jusqu'à `cible` — {x, y}, {ecran}, {selecteur} ou un
     *  point {lon, lat, hauteur} —, la vraie souris avec lui : les survols s'ouvrent. */
    async curseurVers(cible, secondes) {
        const fin = await ecranDe(cible);
        const debut = curseur || { x: fin.x + fmt.largeur * 0.14, y: fin.y + fmt.hauteur * 0.12 };
        await filmer(secondes, async t => {
            const k = lisser(t);
            await montrerCurseur({ x: debut.x + (fin.x - debut.x) * k, y: debut.y + (fin.y - debut.y) * k });
            await page.mouse.move(curseur.x, curseur.y);
        });
    },
    /** L'onde d'un clic sous le curseur ; le vrai clic part au premier tiers. */
    async clic() {
        let fait = false;
        await filmer(0.45, async t => {
            if (!fait && t >= 0.3) { fait = true; await page.mouse.click(curseur.x, curseur.y); }
            await onde(t);
        });
        await onde(null);
    },
    async cacherCurseur() { await montrerCurseur(null); },
    /** Le curseur caché, la souris hors de la vue, l'infobulle de survol refermée (le drone vole seul). */
    async lacher() {
        await montrerCurseur(null);
        await page.mouse.move(2, fmt.hauteur - 2);
        await page.evaluate(() => { const t = document.getElementById('tip'); if (!t.classList.contains('epingle')) t.style.display = 'none'; });
    },
    /** L'infobulle épinglée refermée : sous le carton de fin, elle brouillait les liens. */
    async fermerInfobulle() {
        await page.evaluate(() => { const t = document.getElementById('tip'); if (t) { t.style.display = 'none'; t.classList.remove('epingle'); } });
    },
    /** Le curseur va sur un point de la scène (ou de l'écran) et clique. */
    async cliquerSur(cible, secondes) { await outils.curseurVers(cible, secondes); await outils.clic(); },
    /** Le curseur va sur un lien de la page qui la recharge ailleurs, clique, et la suit. */
    async suivreLien(selecteur, secondes) {
        await outils.curseurVers({ selecteur }, secondes);
        await filmer(0.3, t => onde(t * 0.6));
        await suivreNavigation(() => page.mouse.click(curseur.x, curseur.y));
    },
    /** Un bouton : visible, le curseur va le cliquer ; dans un panneau masqué (au carré),
     *  le clic passe par le DOM. `on` : l'état voulu, rien n'est fait s'il y est déjà. */
    async bouton(id, on) {
        if (on !== undefined && (await allume(id)) === on) return;
        const r = await page.$eval('#' + id, b => {
            const r = b.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, visible: r.width > 0 && r.height > 0 };
        });
        if (r.visible) {
            await outils.curseurVers(r, 0.9);
            await outils.clic();
            // Le curseur a traversé la vue : l'infobulle d'un survol resterait affichée.
            await page.evaluate(() => { const t = document.getElementById('tip'); if (!t.classList.contains('epingle')) t.style.display = 'none'; });
        } else await cliquer(id);
        if (on) await page.waitForFunction(id => document.getElementById(id).classList.contains('on'),
                                           { timeout: 120000, polling: 100 }, id);
        await filmer(0.25);
    },
    /** Tape `texte` dans le champ de recherche, attend la liste, et choisit la première
     *  suggestion, qui doit commencer par `attendu` : la page part vers le lieu. */
    async chercher(texte, attendu) {
        await outils.curseurVers({ selecteur: '#in-lieu' }, 1);
        await outils.clic();
        await page.$eval('#in-lieu', e => { e.value = ''; e.dispatchEvent(new Event('input')); });
        for (const c of texte) { await page.keyboard.type(c); await filmer(1 / 14); }
        // La liste vient du géocodage, en temps réel : l'horloge de la page est
        // figée, pas le réseau ni ses minuteries.
        await page.waitForFunction((t, a) => {
            const li = document.querySelector('#suggestions li[role="option"]');
            return document.getElementById('in-lieu').value === t && !document.getElementById('suggestions').hidden
                && li && li.textContent.startsWith(a);
        }, { timeout: 60000, polling: 100 }, texte, attendu);
        await filmer(1.2);
        await outils.suivreLien('#suggestions li[role="option"]', 0.8);
    },
    /** Le curseur de vitesse de la page (le drone y prend la sienne). */
    async vitesse(v) {
        await page.evaluate(v => { const c = document.getElementById('speed'); c.value = v; c.dispatchEvent(new Event('input')); }, v);
    },
    /** Le drone, touches tenues pendant `secondes`. */
    async voler(secondes, touches) {
        for (const t of touches) await page.keyboard.down(t);
        await filmer(secondes);
        for (const t of touches) await page.keyboard.up(t);
    },

    /** La légende de l'ensoleillement : la rampe des toits, en kWh/m²/an du lieu. */
    async legendeSolaire() {
        return page.evaluate(async () => {
            const { etatSolaire } = await import('/static/js/scene/couches/solaire.js');
            const o = etatSolaire().ciel.optimum.e, fr = v => (Math.round(v / 10) * 10).toLocaleString('fr-FR');
            const rampe = ['#4f1c01', '#723607', '#975104', '#bb710c', '#de9215', '#fdb72e', '#fee5b3'];
            return `<b>Soleil reçu</b> · kWh/m²/an<div class="barre" style="background:linear-gradient(to right, ${rampe.join(', ')})"></div>`
                + `${fr(0.5 * o)} → ${fr(o)}, le meilleur plan du lieu<br>favorable : au moins ${fr(0.7 * o)}`;
        });
    },
    /** Un toit à montrer, au calcul fini : le plus grand toit en pente mesuré au LiDAR,
     *  favorable sur 40 à 75 % de sa surface — un pan au soleil, un pan à l'ombre —, à
     *  moins de 300 m du point, et un point de son toit sous le centre de son emprise.
     *  Favorable à plus de 80 %, c'était un toit plat de la BD TOPO, d'une seule couleur. */
    async toitAMontrer() {
        await page.waitForFunction(async () => (await import('/static/js/scene/couches/solaire.js')).etatSolaire().resultat,
                                   { timeout: 120000, polling: 200 });
        const t = await page.evaluate(async () => {
            const d = window.__demo;
            const { etatSolaire } = await import('/static/js/scene/couches/solaire.js');
            const { meshesToits } = await import('/static/js/scene/batiments/etat.js');
            const r = etatSolaire().resultat;
            const mesure = new Set(meshesToits.filter(m => m.userData.surface).map(m => m.userData.anneau));
            const bas = new d.THREE.Raycaster(), haut = new d.THREE.Vector3(), vers = new d.THREE.Vector3(0, -1, 0);
            let meilleur = null;
            for (const [anneau, s] of r.parBatiment) {
                if (!mesure.has(anneau) || s.favorable < 0.4 * s.aire || s.favorable > 0.75 * s.aire || s.aire < 250) continue;
                const pts = anneau.slice(0, -1);
                const lon = pts.reduce((a, p) => a + p[0], 0) / pts.length, lat = pts.reduce((a, p) => a + p[1], 0) / pts.length;
                const x = (lon - d.LON0) * d.M_PAR_DEGRE_LON, z = -(lat - d.LAT0) * d.M_PAR_DEGRE_LAT;
                if (Math.hypot(x, z) > 300 || (meilleur && s.aire <= meilleur.aire)) continue;
                bas.set(haut.set(x, 1000, z), vers);
                const touche = bas.intersectObjects(meshesToits, false)[0];
                if (!touche || touche.object.userData.anneau !== anneau) continue;
                meilleur = { lon, lat, hauteur: touche.point.y - d.ySol(lon, lat), aire: s.aire };
            }
            return meilleur;
        });
        if (!t) throw new Error('aucun toit favorable à montrer');
        console.log(`    toit montré : ${Math.round(t.aire)} m², à ${t.hauteur.toFixed(1)} m`);
        return t;
    },
    /** Les chiffres du soleil de la fiche du bâtiment cliqué, tels que la page les donne. */
    async ficheSolaire() {
        return page.evaluate(() => {
            const titres = [...document.querySelectorAll('#fiche-batiment .sous-titre')];
            const t = titres.find(e => /Ensoleillement du toit/.test(e.textContent));
            const lignes = [];
            for (let e = t && t.nextElementSibling; e && e.classList.contains('stat'); e = e.nextElementSibling) {
                const [l, v] = e.children;
                if (/reçu en moyenne|favorable|puissance|production/.test(l.textContent)) lignes.push(`${l.textContent} : <b>${v.textContent}</b>`);
            }
            return `<b>Ce toit</b><br>${lignes.join('<br>')}`;
        });
    },
    /** Les tuiles de l'horizon chargées pour un cadre, avant de le filmer : la page
     *  tourne à vide, sans capture, pendant `secondes` réelles. */
    async chauffer(cadre, secondes = 20) {
        await outils.poser(cadre);
        const fin = Date.now() + secondes * 1000;
        while (Date.now() < fin) {
            await page.evaluate(dt => window.__pas(dt), 1000 / FPS);
            await new Promise(r => setTimeout(r, 60));
        }
    },
    /** Un export de la page : le curseur clique son bouton, le fichier arrive dans TRAVAIL.
     *  L'écriture tient la page une à deux secondes au premier pas de rendu ; l'horloge
     *  étant figée, le film n'en voit rien. Rend le fichier et la note de la page. */
    async exporter(id) {
        await page.$eval('#' + id, b => b.scrollIntoView({ block: 'nearest' }));
        await outils.bouton(id);
        for (let i = 0; i < 300 && await page.$eval('#note-export', e => /Écriture/.test(e.textContent)); i++) await filmer(1 / FPS);
        const note = await page.$eval('#note-export', e => e.textContent.trim());
        const fichier = path.join(TRAVAIL, note.split(' : ')[0]);
        // Chrome écrit dans un .crdownload, renommé une fois le fichier complet.
        for (let i = 0; i < 600 && !fs.existsSync(fichier); i++) await new Promise(r => setTimeout(r, 100));
        if (!fs.existsSync(fichier)) throw new Error(`export ${id} : ${fichier} absent — ${note}`);
        if (fichier.endsWith('.ifc')) fichierIfc = fichier;
        console.log(`    ${note}`);
        return { fichier, note };
    },
    /** Le dernier IFC exporté, ouvert dans la visionneuse ; l'horloge refigée, l'habillage reposé. */
    async ouvrirIfc() {
        const base = await serveurVisionneuse();
        await page.goto(`${base}/visionneuse-ifc.html?fichier=${encodeURIComponent(path.basename(fichierIfc))}`,
                        { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.__visionneuse && window.__visionneuse.pret, { timeout: 5 * 60 * 1000, polling: 200 });
        console.log(`  visionneuse : ${fichierIfc}`);
        lieuCourant = { visionneuse: fichierIfc };
        dernierCadre = null;
        curseur = null;
        await page.evaluate(() => window.__manuel());
        await page.waitForFunction(() => window.__pret(), { timeout: 5000, polling: 100 });
        await page.evaluate((l, c) => {
            document.getElementById('demo-legende').textContent = l;
            document.getElementById('demo-cartouche').innerHTML = c;
        }, legende.texte || '', cartoucheCourant);
    },
    /** Dans la visionneuse, le curseur clique un objet (son numéro dans le fichier) là où
     *  rien ne le cache, puis s'écarte pour laisser voir sa surbrillance ; sa fiche attendue. */
    async cliquerObjet(id, secondes) {
        const ecran = id != null && await page.evaluate(id => window.__visionneuse.ecranElement(id), id);
        if (!ecran) throw new Error(`objet ${id} : introuvable ou caché à l'écran`);
        await outils.cliquerSur({ ecran }, secondes);
        await page.waitForFunction(id => window.__visionneuse.choisi() === id && document.querySelector('#choix h3'),
                                   { timeout: 10000, polling: 100 }, id);
        await outils.curseurVers({ x: ecran.x + fmt.police * 2.5, y: ecran.y + fmt.police * 2 }, 0.5);
    },
    /** Le cartouche des bornes : stations, points de charge, et les classes de puissance. */
    async legendeBornes() {
        const b = await couche('bornes');
        const classes = [[0, 22, '#34d399', 'jusqu’à 22 kW'], [22, 149, '#f59e0b', '23 à 149 kW'], [149, Infinity, '#a855f7', '150 kW et plus']];
        return `<b>${b.stations.length} stations</b> · ${b.nombre_points} points de charge`
            + classes.map(([de, a, c, nom]) => {
                const n = b.stations.filter(s => s.puissance_max != null && s.puissance_max > de && s.puissance_max <= a).length;
                return n ? `<br><span style="color:${c}">●</span> ${nom} : ${n}` : '';
            }).join('');
    },
    /** La station à montrer : la plus puissante à moins de 350 m du point. */
    async stationAMontrer() {
        const b = await couche('bornes');
        const l = lieuCourant, kx = 111320 * Math.cos(l.lat * RAD);
        const pres = b.stations.filter(s => Math.hypot((s.lon - l.lon) * kx, (s.lat - l.lat) * 111320) < 350);
        const s = (pres.length ? pres : b.stations)[0];
        console.log(`    station : ${s.nom}, ${s.operateur}, ${s.puissance_max} kW`);
        return { lon: s.lon, lat: s.lat, hauteur: 0 };
    },
    /** Où la pastille d'une station se voit à l'écran : au-dessus de son pied, là où un
     *  rayon de la caméra la touche. */
    async pastille(st) {
        return page.evaluate(st => {
            const d = window.__demo;
            let sprite = null;
            d.scene.traverse(o => {
                if (o.isSprite && o.userData.borne && Math.abs(o.userData.borne.lon - st.lon) < 1e-9
                    && Math.abs(o.userData.borne.lat - st.lat) < 1e-9) sprite = o;
            });
            if (!sprite) throw new Error('pastille introuvable');
            sprite.updateMatrixWorld();
            const r = d.renderer.domElement.getBoundingClientRect();
            const v = sprite.position.clone().project(d.camera);
            const x = r.left + (v.x + 1) / 2 * r.width, y = r.top + (1 - v.y) / 2 * r.height;
            const rayon = new d.THREE.Raycaster();
            for (let dy = 2; dy < 90; dy += 3) {
                rayon.setFromCamera(new d.THREE.Vector2(v.x, v.y + 2 * dy / r.height), d.camera);
                if (rayon.intersectObject(sprite).length) return { x, y: y - dy - 6 };
            }
            return { x, y: y - 18 };
        }, st);
    },
};

/** Un point de la scène, ou un élément de la page, en pixels de la page. */
async function ecranDe(c) {
    if (c.ecran) return c.ecran;
    if (c.x != null) return { x: c.x, y: c.y };
    if (c.selecteur) {
        return page.$eval(c.selecteur, e => {
            const r = e.getBoundingClientRect();
            return { x: r.left + Math.min(r.width / 2, 60), y: r.top + r.height / 2 };
        });
    }
    return page.evaluate(p => {
        const d = window.__demo;
        const v = new d.THREE.Vector3((p.lon - d.LON0) * d.M_PAR_DEGRE_LON, d.ySol(p.lon, p.lat) + (p.hauteur || 0),
                                      -(p.lat - d.LAT0) * d.M_PAR_DEGRE_LAT);
        v.project(d.camera);
        const r = d.renderer.domElement.getBoundingClientRect();
        return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    }, c);
}
async function montrerCurseur(p) {
    curseur = p;
    await page.evaluate(p => {
        const e = document.getElementById('demo-curseur');
        e.style.opacity = p ? 1 : 0;
        if (p) { e.style.left = p.x + 'px'; e.style.top = p.y + 'px'; }
    }, p);
}
/** L'onde du clic, de 0 à 1 ; `null` l'efface. */
async function onde(t) {
    await page.evaluate((p, t) => {
        const e = document.getElementById('demo-onde');
        if (t == null || !p) { e.style.opacity = 0; return; }
        e.style.left = p.x + 'px'; e.style.top = p.y + 'px';
        e.style.opacity = String(Math.max(0, 0.95 * (1 - t)));
        e.style.transform = `scale(${0.4 + 1.1 * t})`;
    }, curseur, t);
}

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
const nom = path.join(SORTIE, `demo-${NOM_FILM}`);
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
