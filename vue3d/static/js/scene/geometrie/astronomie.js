// La position du soleil dans le ciel, à un instant et en un lieu : celle des
// ombres (interface/soleil) et celle de l'année type (couches/solaire).

const RAD = Math.PI / 180;

/**
 * Azimut (0 = nord, sens horaire) et hauteur du soleil, en degrés.
 *
 * Algorithme NOAA (Astronomical Almanac). Précision de l'ordre du centième de
 * degré, très au-delà de ce qu'exige un rendu.
 */
export function positionSoleil(instant, lat, lon) {
    const jj = instant.getTime() / 86400000 + 2440587.5;     // jour julien
    const t = (jj - 2451545) / 36525;                         // siècles juliens

    const L0 = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
    const M = 357.52911 + t * (35999.05029 - 0.0001537 * t);
    const e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
    const centre = Math.sin(M * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t))
                 + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * t)
                 + Math.sin(3 * M * RAD) * 0.000289;
    const omega = 125.04 - 1934.136 * t;
    const lambda = L0 + centre - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const eps0 = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
    const declinaison = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) / RAD;

    // Équation du temps, en minutes : l'écart entre midi solaire et midi horloge.
    const y = Math.tan(eps / 2 * RAD) ** 2;
    const eqTemps = 4 / RAD * (
        y * Math.sin(2 * L0 * RAD)
        - 2 * e * Math.sin(M * RAD)
        + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
        - 0.5 * y * y * Math.sin(4 * L0 * RAD)
        - 1.25 * e * e * Math.sin(2 * M * RAD));

    const minutesUTC = instant.getUTCHours() * 60 + instant.getUTCMinutes()
                     + instant.getUTCSeconds() / 60;
    const solaire = (minutesUTC + eqTemps + 4 * lon + 1440) % 1440;
    const angleHoraire = solaire / 4 - 180;                   // degrés, 0 à midi vrai

    const cosZ = Math.sin(lat * RAD) * Math.sin(declinaison * RAD)
               + Math.cos(lat * RAD) * Math.cos(declinaison * RAD) * Math.cos(angleHoraire * RAD);
    const zenith = Math.acos(Math.min(1, Math.max(-1, cosZ))) / RAD;
    const hauteur = 90 - zenith;

    let azimut;
    const den = Math.cos(lat * RAD) * Math.sin(zenith * RAD);
    if (Math.abs(den) < 1e-9) {
        azimut = 180;                                          // soleil au zénith
    } else {
        const q = (Math.sin(lat * RAD) * Math.cos(zenith * RAD) - Math.sin(declinaison * RAD)) / den;
        const a = Math.acos(Math.min(1, Math.max(-1, q))) / RAD;
        // Convention NOAA. Le complément à 540 le matin et l'ajout de 180
        // l'après-midi ne sont pas interchangeables avec un simple 360 - a :
        // celui-ci intervertit les saisons (lever au sud-est en juin).
        azimut = angleHoraire > 0 ? (a + 180) % 360 : (540 - a) % 360;
    }
    return { azimut, hauteur };
}
