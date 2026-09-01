/*
 * Superposicion de trazas: decide si dos tramos van "por el mismo lugar".
 *
 * Hace falta porque en un parque los circuitos se dibujan cada uno en su
 * capa (MT-C1, MT-C2...) mientras la zanja va en la suya, dibujada una sola
 * vez. Son polilineas distintas del plano aunque fisicamente compartan la
 * misma zanja, asi que no basta con comparar identificadores de elemento:
 * hay que mirar la geometria.
 *
 * El metodo es simple a proposito: se muestrea una traza cada cierto paso y
 * se cuenta que parte de esos puntos cae a menos de la tolerancia de la otra.
 * No necesita ser exacto, solo distinguir "van juntas" de "se cruzan".
 */

/** Como maximo se toman estos puntos por traza: basta para una proporcion. */
const MAX_SAMPLES = 80;

/** Trazas (arreglos de puntos) de los elementos de un tramo. */
export function pathsOf(task, shapesById) {
    const paths = [];
    for (const ref of task.elements || []) {
        const shape = shapesById.get(ref.id);
        if (shape && shape.pts && shape.pts.length >= 4) paths.push(shape.pts);
    }
    return paths;
}

/** Caja que envuelve varias trazas, agrandada por el margen dado. */
export function boundsOf(paths, pad = 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pts of paths) {
        for (let i = 0; i + 1 < pts.length; i += 2) {
            if (pts[i] < minX) minX = pts[i];
            if (pts[i] > maxX) maxX = pts[i];
            if (pts[i + 1] < minY) minY = pts[i + 1];
            if (pts[i + 1] > maxY) maxY = pts[i + 1];
        }
    }
    if (minX === Infinity) return null;
    return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

function boxesApart(a, b) {
    return !a || !b || a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1];
}

/** Largo total de un conjunto de trazas. */
export function totalLength(paths) {
    let total = 0;
    for (const pts of paths) {
        for (let i = 0; i + 3 < pts.length; i += 2) {
            total += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
        }
    }
    return total;
}

/** Distancia de un punto al segmento dado. */
function distanceToSegment(x, y, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    let t = 0;
    if (len2 > 0) t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
    return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** Distancia minima de un punto a cualquiera de las trazas. */
export function distanceToPaths(paths, x, y) {
    let best = Infinity;
    for (const pts of paths) {
        for (let i = 0; i + 3 < pts.length; i += 2) {
            const d = distanceToSegment(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
            if (d < best) best = d;
            if (best === 0) return 0;
        }
    }
    return best;
}

/**
 * Puntos repartidos a lo largo de las trazas, con el largo que representa
 * cada uno. Se cachean por tramo porque el calculo del programa los pide
 * muchas veces.
 */
export function samplePaths(paths, step) {
    const out = [];
    const size = Math.max(step, 1e-6);
    for (const pts of paths) {
        for (let i = 0; i + 3 < pts.length; i += 2) {
            const x1 = pts[i];
            const y1 = pts[i + 1];
            const dx = pts[i + 2] - x1;
            const dy = pts[i + 3] - y1;
            const seg = Math.hypot(dx, dy);
            if (seg <= 0) continue;
            const count = Math.max(1, Math.ceil(seg / size));
            const share = seg / count;
            for (let k = 0; k < count; k++) {
                const t = (k + 0.5) / count;
                out.push(x1 + dx * t, y1 + dy * t, share);
            }
        }
    }
    return out;
}

/** Paso de muestreo: fino como la tolerancia, sin pasarse de puntos. */
export function stepFor(paths, tolerance) {
    const length = totalLength(paths);
    return Math.max(tolerance / 2, length / MAX_SAMPLES, 1e-6);
}

/**
 * Cuanto de A corre pegado a B.
 * @returns {{ratio:number, meters:number, length:number}} respecto de A
 */
export function overlapOf(pathsA, pathsB, tolerance) {
    const empty = { ratio: 0, meters: 0, length: 0 };
    if (!pathsA.length || !pathsB.length) return empty;
    if (boxesApart(boundsOf(pathsA, tolerance), boundsOf(pathsB))) return empty;

    const samples = samplePaths(pathsA, stepFor(pathsA, tolerance));
    let near = 0;
    let length = 0;
    for (let i = 0; i + 2 < samples.length; i += 3) {
        const share = samples[i + 2];
        length += share;
        if (distanceToPaths(pathsB, samples[i], samples[i + 1]) <= tolerance) near += share;
    }
    return { ratio: length > 0 ? near / length : 0, meters: near, length };
}

/**
 * Dos tramos van por el mismo lugar. Se mira en los dos sentidos porque una
 * zanja larga puede contener varios tendidos cortos y al reves.
 *
 * @returns {{shares:boolean, ratio:number, meters:number}}
 */
export function pathsShareRoute(pathsA, pathsB, tolerance, minRatio = 0.5) {
    const a = overlapOf(pathsA, pathsB, tolerance);
    if (!a.length) return { shares: false, ratio: 0, meters: 0 };
    const b = overlapOf(pathsB, pathsA, tolerance);
    const ratio = Math.max(a.ratio, b.ratio);
    return { shares: ratio >= minRatio, ratio, meters: Math.max(a.meters, b.meters) };
}
