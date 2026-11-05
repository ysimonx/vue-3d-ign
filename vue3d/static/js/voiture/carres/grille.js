// La grille des carrés de 500 m.

// Les carrés de 500 m de la grille Lambert-93 (vue3d/carres.py), chacun avec
// l'état de ses bâtiments, de ses arbres, de ses limitations et de sa
// signalisation ; le graphe des routes et l'affichage les retrouvent par leur
// position.
export const CARRE_M = 500;
// Les versions des carrés (carres.CARRES_VERSION, VEGETATION_VERSION,
// vitesses.VITESSES_VERSION, signalisation.SIGNALISATION_VERSION), dans leur
// adresse : le navigateur garde un carré une semaine.
export const CARRES_VERSION = 3, VEGETATION_VERSION = 2;
export const VITESSES_VERSION = 1;
export const SIGNALISATION_VERSION = 1;
export const carres = new Map();

export function carre(i, j) {
    const cle = `${i},${j}`;
    let c = carres.get(cle);
    if (!c) {
        c = { i, j, cle, etat: 'neuf', donnees: null, mesh: null, voulu: 0, reessai: 0, priorite: Infinity,
              altiPretes: false, nbBatiments: 0,
              veg: { etat: 'neuf', donnees: null, mesh: null, voulu: 0, reessai: 0, priorite: Infinity,
                     altiPretes: false },
              vit: { etat: 'neuf', reessai: 0 }, sig: { etat: 'neuf', reessai: 0 } };
        carres.set(cle, c);
    }
    return c;
}
export const carreDe = (x, y) => carres.get(`${Math.floor(x / CARRE_M)},${Math.floor(y / CARRE_M)}`);
