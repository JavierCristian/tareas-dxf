/*
 * Divisiones y uniones de elementos del plano.
 *
 * El DXF original nunca se toca: cada operacion queda guardada en el proyecto
 * como una "edicion" que consume elementos de origen y produce elementos
 * derivados. Al abrir el proyecto se vuelve a leer el DXF y se aplican las
 * ediciones en orden, de modo que todo es reversible.
 */

import { newId } from './db.js';

/* ---------------------------- geometria base ---------------------------- */

export function bboxOf(pts) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
        if (pts[i] < minX) minX = pts[i];
        if (pts[i] > maxX) maxX = pts[i];
        if (pts[i + 1] < minY) minY = pts[i + 1];
        if (pts[i + 1] > maxY) maxY = pts[i + 1];
    }
    return [minX, minY, maxX, maxY];
}

/** Distancia acumulada hasta cada vertice. */
export function cumulative(pts) {
    const acc = [0];
    for (let i = 0; i + 3 < pts.length; i += 2) {
        acc.push(acc[acc.length - 1] + Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]));
    }
    return acc;
}

export function pathLength(pts) {
    const acc = cumulative(pts);
    return acc[acc.length - 1] || 0;
}

/** Punto a una distancia dada desde el inicio del recorrido. */
export function pointAt(pts, along) {
    const acc = cumulative(pts);
    const total = acc[acc.length - 1] || 0;
    const target = Math.max(0, Math.min(total, along));
    for (let v = 0; v + 1 < acc.length; v++) {
        const segment = acc[v + 1] - acc[v];
        if (target <= acc[v + 1] || v === acc.length - 2) {
            const t = segment ? (target - acc[v]) / segment : 0;
            const i = v * 2;
            return {
                x: pts[i] + (pts[i + 2] - pts[i]) * t,
                y: pts[i + 1] + (pts[i + 3] - pts[i + 1]) * t
            };
        }
    }
    return { x: pts[0], y: pts[1] };
}

/**
 * Proyecta un punto sobre el recorrido.
 * @returns {{along:number, distance:number, x:number, y:number}}
 */
export function projectOnPath(pts, x, y) {
    const acc = cumulative(pts);
    let best = { along: 0, distance: Infinity, x: pts[0], y: pts[1] };
    for (let v = 0; v + 1 < acc.length; v++) {
        const i = v * 2;
        const x1 = pts[i];
        const y1 = pts[i + 1];
        const dx = pts[i + 2] - x1;
        const dy = pts[i + 3] - y1;
        const lengthSq = dx * dx + dy * dy;
        let t = lengthSq ? ((x - x1) * dx + (y - y1) * dy) / lengthSq : 0;
        t = Math.max(0, Math.min(1, t));
        const px = x1 + t * dx;
        const py = y1 + t * dy;
        const distance = Math.hypot(x - px, y - py);
        if (distance < best.distance) {
            best = { along: acc[v] + t * Math.sqrt(lengthSq), distance, x: px, y: py };
        }
    }
    return best;
}

/** Trozo del recorrido entre dos distancias (from <= to). */
export function sliceRange(pts, from, to) {
    const acc = cumulative(pts);
    const total = acc[acc.length - 1] || 0;
    const a = Math.max(0, Math.min(total, from));
    const b = Math.max(a, Math.min(total, to));
    const start = pointAt(pts, a);
    const out = [start.x, start.y];
    for (let v = 0; v + 1 < acc.length; v++) {
        const at = acc[v + 1];
        if (at > a && at < b) out.push(pts[v * 2 + 2], pts[v * 2 + 3]);
    }
    const end = pointAt(pts, b);
    out.push(end.x, end.y);
    return dedupe(out);
}

/** Quita vertices repetidos consecutivos (aparecen al cortar sobre un vertice). */
function dedupe(pts) {
    const out = [pts[0], pts[1]];
    for (let i = 2; i + 1 < pts.length; i += 2) {
        const n = out.length;
        if (Math.abs(pts[i] - out[n - 2]) < 1e-12 && Math.abs(pts[i + 1] - out[n - 1]) < 1e-12) continue;
        out.push(pts[i], pts[i + 1]);
    }
    return out;
}

/* ------------------------------ divisiones ------------------------------ */

export const MIN_PART_RATIO = 0.005; // un corte no puede dejar un trozo menor al 0,5%

export function canSplit(shape) {
    if (!shape) return false;
    if (shape.kind === 'point' || shape.kind === 'text') return false;
    return pathLength(shape.pts) > 0;
}

/**
 * Corta un elemento abierto en las distancias indicadas.
 * @returns {Array<{pts:number[], closed:boolean}>}
 */
export function splitOpen(shape, alongs) {
    const total = pathLength(shape.pts);
    const cuts = [...new Set(alongs.map((a) => Math.max(0, Math.min(total, a))))].sort((a, b) => a - b);
    const bounds = [0, ...cuts, total];
    const parts = [];
    for (let i = 0; i + 1 < bounds.length; i++) {
        if (bounds[i + 1] - bounds[i] < total * 1e-9) continue;
        parts.push({ pts: sliceRange(shape.pts, bounds[i], bounds[i + 1]), closed: false });
    }
    return parts;
}

/**
 * Corta un elemento cerrado con una cuerda entre dos puntos de su contorno.
 * Devuelve las dos mitades, cada una cerrada.
 */
export function splitClosed(shape, alongA, alongB) {
    const total = pathLength(shape.pts);
    let a = Math.max(0, Math.min(total, alongA));
    let b = Math.max(0, Math.min(total, alongB));
    if (a > b) [a, b] = [b, a];

    const front = sliceRange(shape.pts, a, b);
    const backTail = sliceRange(shape.pts, b, total);
    const backHead = sliceRange(shape.pts, 0, a);
    // El contorno cerrado ya repite el primer punto al final, por eso se
    // empalma quitando el vertice duplicado de la union.
    const back = dedupe([...backTail, ...backHead.slice(2)]);

    return [
        { pts: closeRing(front), closed: true },
        { pts: closeRing(back), closed: true }
    ];
}

function closeRing(pts) {
    const n = pts.length;
    if (n < 4) return pts;
    if (Math.abs(pts[0] - pts[n - 2]) < 1e-12 && Math.abs(pts[1] - pts[n - 1]) < 1e-12) return pts;
    return [...pts, pts[0], pts[1]];
}

/** Reparte el recorrido en n trozos iguales. */
export function equalCuts(shape, n) {
    const total = pathLength(shape.pts);
    const cuts = [];
    for (let i = 1; i < n; i++) cuts.push((total * i) / n);
    return cuts;
}

/* -------------------------------- uniones ------------------------------- */

function endsOf(pts) {
    return {
        start: [pts[0], pts[1]],
        end: [pts[pts.length - 2], pts[pts.length - 1]]
    };
}

function near(a, b, tol) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol;
}

function reverse(pts) {
    const out = [];
    for (let i = pts.length - 2; i >= 0; i -= 2) out.push(pts[i], pts[i + 1]);
    return out;
}

/**
 * Encadena varios elementos abiertos en un unico recorrido.
 * @returns {{pts:number[], closed:boolean, gap:number}|{error:string}}
 */
export function chain(shapes, tol) {
    if (shapes.length < 2) return { error: 'Selecciona al menos dos elementos.' };
    if (shapes.some((s) => s.kind === 'point' || s.kind === 'text')) {
        return { error: 'Los puntos y textos no se pueden unir.' };
    }
    if (shapes.some((s) => s.closed)) {
        return { error: 'Los elementos cerrados (circulos, areas) no se pueden unir.' };
    }
    const layers = new Set(shapes.map((s) => s.layer));
    if (layers.size > 1) return { error: 'Los elementos deben estar en la misma capa.' };

    const pending = shapes.slice(1).map((s) => ({ shape: s, pts: s.pts.slice() }));
    let current = shapes[0].pts.slice();
    let gap = 0;

    while (pending.length) {
        const ends = endsOf(current);
        let hit = -1;
        let mode = '';
        for (let i = 0; i < pending.length; i++) {
            const e = endsOf(pending[i].pts);
            if (near(ends.end, e.start, tol)) { hit = i; mode = 'append'; break; }
            if (near(ends.end, e.end, tol)) { hit = i; mode = 'append-rev'; break; }
            if (near(ends.start, e.end, tol)) { hit = i; mode = 'prepend'; break; }
            if (near(ends.start, e.start, tol)) { hit = i; mode = 'prepend-rev'; break; }
        }
        if (hit < 0) {
            return { error: 'Los elementos no se tocan por sus extremos. Acerca los extremos o une de a pares.' };
        }
        const piece = pending.splice(hit, 1)[0];
        let pts = piece.pts;
        if (mode === 'append-rev' || mode === 'prepend-rev') pts = reverse(pts);

        if (mode.startsWith('append')) {
            const e = endsOf(current).end;
            gap = Math.max(gap, Math.hypot(pts[0] - e[0], pts[1] - e[1]));
            current = [...current, ...pts.slice(2)]; // el extremo comun se escribe una sola vez
        } else {
            const s = endsOf(current).start;
            const tail = endsOf(pts).end;
            gap = Math.max(gap, Math.hypot(tail[0] - s[0], tail[1] - s[1]));
            current = [...pts.slice(0, pts.length - 2), ...current];
        }
    }

    const ends = endsOf(current);
    const closed = near(ends.start, ends.end, tol) && current.length > 6;
    return { pts: dedupe(current), closed, gap };
}

/** Tolerancia por defecto para unir: proporcional al tamano del dibujo. */
export function joinTolerance(bounds) {
    if (!bounds) return 1e-6;
    const diagonal = Math.hypot(bounds[2] - bounds[0], bounds[3] - bounds[1]);
    return Math.max(diagonal * 1e-4, 1e-9);
}

/* ------------------------- ediciones del proyecto ------------------------ */

/** Una parte abierta de dos vertices sigue siendo una linea; el resto, polilinea. */
function partKind(part) {
    if (part.closed) return 'polyline';
    return part.pts.length === 4 ? 'line' : 'polyline';
}

export function makeEdit(op, sources, parts, extra = {}) {
    const stamp = Math.random().toString(36).slice(2, 6);
    return {
        id: newId('ed'),
        op,                                   // 'division' | 'union'
        from: sources.map((s) => s.id),
        parts: parts.map((part, i) => ({
            id: `${sources[0].id}~${i + 1}~${stamp}`,
            kind: partKind(part),
            layer: part.layer || sources[0].layer,
            closed: !!part.closed,
            pts: part.pts.map((v) => Math.round(v * 1e6) / 1e6)
        })),
        createdAt: Date.now(),
        ...extra
    };
}

/** Reconstruye la figura derivada tomando el estilo del elemento de origen. */
function hydrate(part, source, edit) {
    return {
        id: part.id,
        kind: part.kind,
        layer: part.layer,
        closed: part.closed,
        pts: part.pts,
        bbox: bboxOf(part.pts),
        colorIndex: source.colorIndex,
        trueColor: source.trueColor,
        entityType: source.entityType,
        derived: true,
        editId: edit.id,
        editOp: edit.op,
        sourceIds: edit.from
    };
}

/**
 * Aplica las ediciones guardadas sobre las figuras leidas del DXF.
 * Las ediciones cuyo origen ya no existe se ignoran sin romper el resto.
 */
export function applyEdits(shapes, edits = []) {
    if (!edits || !edits.length) return { shapes, applied: [], skipped: [] };
    const map = new Map(shapes.map((s) => [s.id, s]));
    const applied = [];
    const skipped = [];

    for (const edit of edits) {
        const sources = edit.from.map((id) => map.get(id));
        if (sources.some((s) => !s)) {
            skipped.push(edit.id);
            continue;
        }
        for (const id of edit.from) map.delete(id);
        for (const part of edit.parts) map.set(part.id, hydrate(part, sources[0], edit));
        applied.push(edit.id);
    }
    return { shapes: [...map.values()], applied, skipped };
}

/** Quita una edicion y, en cascada, las que dependian de sus partes. */
export function removeEdit(edits, editId) {
    const doomedEdits = new Set([editId]);
    const doomedParts = new Set();
    const seed = edits.find((e) => e.id === editId);
    if (!seed) return { edits, removed: [] };
    for (const part of seed.parts) doomedParts.add(part.id);

    let changed = true;
    while (changed) {
        changed = false;
        for (const edit of edits) {
            if (doomedEdits.has(edit.id)) continue;
            if (edit.from.some((id) => doomedParts.has(id))) {
                doomedEdits.add(edit.id);
                for (const part of edit.parts) doomedParts.add(part.id);
                changed = true;
            }
        }
    }
    return {
        edits: edits.filter((e) => !doomedEdits.has(e.id)),
        removed: [...doomedEdits]
    };
}

/** Ediciones que produjeron una figura concreta. */
export function editOfShape(edits, shapeId) {
    return edits.find((edit) => edit.parts.some((part) => part.id === shapeId)) || null;
}
