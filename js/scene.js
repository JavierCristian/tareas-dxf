/*
 * Indice espacial y utilidades de seleccion sobre las primitivas de la escena.
 * Permite dibujar solo lo visible y tocar/clicar un elemento con tolerancia.
 */

const MAX_CELLS_PER_SHAPE = 400;

export class SpatialIndex {
    constructor(shapes, bounds) {
        this.shapes = shapes;
        this.bounds = bounds;
        const width = Math.max(bounds[2] - bounds[0], 1e-9);
        const height = Math.max(bounds[3] - bounds[1], 1e-9);
        this.cols = Math.max(1, Math.min(160, Math.round(Math.sqrt(shapes.length) / 2) || 1));
        this.rows = this.cols;
        this.cellW = width / this.cols;
        this.cellH = height / this.rows;
        this.cells = new Map();
        this.oversized = [];

        for (let i = 0; i < shapes.length; i++) {
            const box = shapes[i].bbox;
            const c0 = this.colOf(box[0]);
            const c1 = this.colOf(box[2]);
            const r0 = this.rowOf(box[1]);
            const r1 = this.rowOf(box[3]);
            if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_SHAPE) {
                this.oversized.push(i);
                continue;
            }
            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    const key = r * this.cols + c;
                    let bucket = this.cells.get(key);
                    if (!bucket) this.cells.set(key, (bucket = []));
                    bucket.push(i);
                }
            }
        }
    }

    colOf(x) {
        return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.bounds[0]) / this.cellW)));
    }

    rowOf(y) {
        return Math.max(0, Math.min(this.rows - 1, Math.floor((y - this.bounds[1]) / this.cellH)));
    }

    /** Indices de figuras cuyo bbox puede intersectar la caja dada. */
    query(box, out = new Set()) {
        for (const i of this.oversized) out.add(i);
        const c0 = this.colOf(box[0]);
        const c1 = this.colOf(box[2]);
        const r0 = this.rowOf(box[1]);
        const r1 = this.rowOf(box[3]);
        for (let r = r0; r <= r1; r++) {
            for (let c = c0; c <= c1; c++) {
                const bucket = this.cells.get(r * this.cols + c);
                if (!bucket) continue;
                for (const i of bucket) out.add(i);
            }
        }
        return out;
    }
}

function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    let t = lengthSq ? ((px - x1) * dx + (py - y1) * dy) / lengthSq : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/** Distancia en unidades del dibujo entre un punto y una figura. */
export function distanceToShape(shape, x, y) {
    const pts = shape.pts;
    if (shape.kind === 'point' || shape.kind === 'text') {
        return Math.hypot(x - pts[0], y - pts[1]);
    }
    let best = Infinity;
    for (let i = 0; i + 3 < pts.length; i += 2) {
        const d = distanceToSegment(x, y, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]);
        if (d < best) best = d;
        if (best === 0) break;
    }
    return best;
}

/**
 * Devuelve la figura mas cercana al punto dado dentro de la tolerancia.
 * @param {Array} shapes primitivas
 * @param {SpatialIndex} index
 * @param {number} x coordenada del dibujo
 * @param {number} y coordenada del dibujo
 * @param {number} tolerance radio de busqueda en unidades del dibujo
 * @param {(shape:Object)=>boolean} accept filtro (capas visibles, por ejemplo)
 */
export function pickShape(shapes, index, x, y, tolerance, accept) {
    const box = [x - tolerance, y - tolerance, x + tolerance, y + tolerance];
    let best = null;
    let bestDistance = tolerance;
    for (const i of index.query(box)) {
        const shape = shapes[i];
        if (accept && !accept(shape)) continue;
        const bbox = shape.bbox;
        if (bbox[0] - tolerance > x || bbox[2] + tolerance < x) continue;
        if (bbox[1] - tolerance > y || bbox[3] + tolerance < y) continue;
        const d = distanceToShape(shape, x, y);
        // Puntos y textos ganan a las lineas cuando estan igual de cerca.
        const weight = shape.kind === 'point' || shape.kind === 'text' ? d * 0.6 : d;
        if (weight <= bestDistance) {
            bestDistance = weight;
            best = shape;
        }
    }
    return best;
}

/** Punto representativo de una figura (para anclar tareas y centrar la vista). */
export function anchorOf(shape) {
    if (!shape) return null;
    if (shape.kind === 'point' || shape.kind === 'text') return { x: shape.pts[0], y: shape.pts[1] };
    if (shape.kind === 'circle' || shape.kind === 'ellipse' || shape.closed) {
        return { x: (shape.bbox[0] + shape.bbox[2]) / 2, y: (shape.bbox[1] + shape.bbox[3]) / 2 };
    }
    // Punto medio del recorrido de la polilinea.
    const pts = shape.pts;
    let total = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) total += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    let target = total / 2;
    for (let i = 0; i + 3 < pts.length; i += 2) {
        const d = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
        if (target <= d || d === 0) {
            const t = d ? target / d : 0;
            return { x: pts[i] + (pts[i + 2] - pts[i]) * t, y: pts[i + 1] + (pts[i + 3] - pts[i + 1]) * t };
        }
        target -= d;
    }
    return { x: pts[0], y: pts[1] };
}

/** Longitud (lineas/polilineas) o area aproximada (figuras cerradas). */
export function measure(shape) {
    const pts = shape.pts;
    if (shape.kind === 'point' || shape.kind === 'text') return null;
    let length = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
        length += Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
    }
    if (!shape.closed) return { length };
    let area = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
        area += pts[i] * pts[i + 3] - pts[i + 2] * pts[i + 1];
    }
    return { length, area: Math.abs(area) / 2 };
}
