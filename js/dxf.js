/*
 * Lector de archivos DXF (ASCII) y constructor de escena 2D.
 *
 * No depende de librerias externas: recorre los pares codigo/valor del DXF,
 * arma las entidades y las convierte en primitivas listas para dibujar en
 * canvas (polilineas teseladas, puntos y textos).
 */

/* ------------------------------------------------------------------ */
/* Paleta ACI                                                          */
/* ------------------------------------------------------------------ */

const ACI_FIXED = {
    0: 0x000000, // BYBLOCK
    1: 0xff0000,
    2: 0xffff00,
    3: 0x00ff00,
    4: 0x00ffff,
    5: 0x0000ff,
    6: 0xff00ff,
    7: 0xffffff,
    8: 0x808080,
    9: 0xc0c0c0,
    250: 0x333333,
    251: 0x5b5b5b,
    252: 0x848484,
    253: 0xadadad,
    254: 0xd6d6d6,
    255: 0xffffff
};

// Los indices 10..249 de la paleta de AutoCAD siguen 24 tonos de 15 grados con
// 10 variantes de brillo/saturacion cada uno. Se reproduce esa progresion.
const ACI_SHADES = [
    [1.00, 1.00], [1.00, 0.50],
    [0.80, 1.00], [0.80, 0.50],
    [0.60, 1.00], [0.60, 0.50],
    [0.50, 1.00], [0.50, 0.50],
    [0.30, 1.00], [0.30, 0.50]
];

function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else { r = c; b = x; }
    return (Math.round((r + m) * 255) << 16) | (Math.round((g + m) * 255) << 8) | Math.round((b + m) * 255);
}

const ACI = (() => {
    const table = new Array(256).fill(0xffffff);
    for (const key of Object.keys(ACI_FIXED)) table[Number(key)] = ACI_FIXED[key];
    for (let i = 10; i <= 249; i++) {
        const group = Math.floor((i - 10) / 10);
        const shade = ACI_SHADES[(i - 10) % 10];
        table[i] = hsvToRgb((group * 15) % 360, shade[1], shade[0]);
    }
    return table;
})();

export function aciToHex(index) {
    const value = ACI[((index % 256) + 256) % 256];
    return '#' + value.toString(16).padStart(6, '0');
}

/* ------------------------------------------------------------------ */
/* Tokenizado                                                          */
/* ------------------------------------------------------------------ */

const BINARY_SENTINEL = 'AutoCAD Binary DXF';

function tokenize(text) {
    if (text.startsWith(BINARY_SENTINEL)) {
        throw new Error('El archivo esta en formato DXF binario. Guardalo como "DXF ASCII" desde tu programa de CAD.');
    }
    const lines = text.split(/\r\n|\r|\n/);
    const codes = new Int32Array(Math.ceil(lines.length / 2));
    const values = new Array(codes.length);
    let n = 0;
    let desync = 0;
    for (let i = 0; i + 1 < lines.length; i += 2) {
        const code = parseInt(lines[i], 10);
        if (Number.isNaN(code)) {
            // Linea impar/par desalineada: se intenta recuperar el ritmo.
            if (++desync > 32) throw new Error('El archivo no parece un DXF valido.');
            i -= 1;
            continue;
        }
        codes[n] = code;
        values[n] = lines[i + 1];
        n++;
    }
    if (n === 0) throw new Error('El archivo no parece un DXF valido.');
    return { codes, values, length: n };
}

/* ------------------------------------------------------------------ */
/* Parseo de secciones                                                 */
/* ------------------------------------------------------------------ */

const VERTEX_HOLDERS = new Set(['POLYLINE']);

/**
 * Convierte el DXF en {header, layers, blocks, entities}.
 * Cada entidad es {type, handle, groups:[[code, value], ...], vertices:[]}.
 */
export function parseDxf(text) {
    const { codes, values, length } = tokenize(text);
    const header = {};
    const layers = new Map();
    const blocks = new Map();
    const entities = [];

    let i = 0;
    while (i < length) {
        if (codes[i] === 0 && values[i] === 'SECTION') {
            i++;
            let name = '';
            while (i < length && codes[i] !== 0) {
                if (codes[i] === 2) name = values[i];
                i++;
            }
            if (name === 'HEADER') i = readHeader(codes, values, length, i, header);
            else if (name === 'TABLES') i = readTables(codes, values, length, i, layers);
            else if (name === 'BLOCKS') i = readBlocks(codes, values, length, i, blocks);
            else if (name === 'ENTITIES') i = readEntities(codes, values, length, i, entities, 'ENDSEC');
            else i = skipSection(codes, values, length, i);
        } else if (codes[i] === 0 && values[i] === 'EOF') {
            break;
        } else {
            i++;
        }
    }

    if (!layers.has('0')) {
        layers.set('0', { name: '0', color: 7, frozen: false, off: false, lineType: 'CONTINUOUS' });
    }
    return { header, layers, blocks, entities };
}

function skipSection(codes, values, length, i) {
    while (i < length && !(codes[i] === 0 && values[i] === 'ENDSEC')) i++;
    return i + 1;
}

function readHeader(codes, values, length, i, header) {
    let variable = null;
    while (i < length && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
        if (codes[i] === 9) {
            variable = values[i];
            header[variable] = {};
        } else if (variable) {
            header[variable][codes[i]] = values[i];
        }
        i++;
    }
    return i + 1;
}

function readTables(codes, values, length, i, layers) {
    let inLayerTable = false;
    let current = null;
    while (i < length && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
        const code = codes[i];
        const value = values[i];
        if (code === 0 && value === 'TABLE') {
            current = null;
            inLayerTable = false;
            // El nombre de la tabla viene en el grupo 2 inmediatamente despues.
            for (let j = i + 1; j < length && codes[j] !== 0; j++) {
                if (codes[j] === 2) { inLayerTable = values[j] === 'LAYER'; break; }
            }
        } else if (code === 0 && value === 'ENDTAB') {
            current = null;
            inLayerTable = false;
        } else if (code === 0 && value === 'LAYER' && inLayerTable) {
            current = { name: '', color: 7, frozen: false, off: false, lineType: 'CONTINUOUS' };
        } else if (current) {
            if (code === 2) {
                current.name = value;
                layers.set(value, current);
            } else if (code === 62) {
                const color = parseInt(value, 10) || 7;
                current.off = color < 0;
                current.color = Math.abs(color);
            } else if (code === 70) {
                current.frozen = (parseInt(value, 10) & 1) === 1;
            } else if (code === 6) {
                current.lineType = value;
            } else if (code === 420) {
                current.trueColor = parseInt(value, 10);
            }
        }
        i++;
    }
    return i + 1;
}

function readBlocks(codes, values, length, i, blocks) {
    while (i < length && !(codes[i] === 0 && values[i] === 'ENDSEC')) {
        if (codes[i] === 0 && values[i] === 'BLOCK') {
            const block = { name: '', base: [0, 0], entities: [] };
            i++;
            while (i < length && codes[i] !== 0) {
                if (codes[i] === 2) block.name = values[i];
                else if (codes[i] === 10) block.base[0] = Number(values[i]) || 0;
                else if (codes[i] === 20) block.base[1] = Number(values[i]) || 0;
                i++;
            }
            i = readEntities(codes, values, length, i, block.entities, 'ENDBLK');
            if (block.name) blocks.set(block.name, block);
        } else {
            i++;
        }
    }
    return i + 1;
}

function readEntities(codes, values, length, i, out, endMarker) {
    let entity = null;
    let holder = null; // POLYLINE en curso, recibe los VERTEX siguientes.

    const push = () => {
        if (!entity) return;
        if (holder && (entity.type === 'VERTEX')) holder.vertices.push(entity);
        else if (entity.type !== 'SEQEND') out.push(entity);
        entity = null;
    };

    while (i < length) {
        const code = codes[i];
        const value = values[i];
        if (code === 0) {
            if (value === endMarker || value === 'ENDSEC' || value === 'EOF') {
                push();
                return i + 1;
            }
            push();
            entity = { type: value, handle: '', groups: [], vertices: [] };
            if (VERTEX_HOLDERS.has(value)) holder = entity;
            else if (value === 'SEQEND') holder = null;
        } else if (entity) {
            if (code === 5 && !entity.handle) entity.handle = value;
            entity.groups.push([code, value]);
        }
        i++;
    }
    push();
    return i;
}

/* ------------------------------------------------------------------ */
/* Utilidades de grupos                                                */
/* ------------------------------------------------------------------ */

function group(entity, code, fallback = undefined) {
    for (const [c, v] of entity.groups) if (c === code) return v;
    return fallback;
}

function num(entity, code, fallback = 0) {
    const value = group(entity, code);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function int(entity, code, fallback = 0) {
    const value = group(entity, code);
    if (value === undefined) return fallback;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

/* ------------------------------------------------------------------ */
/* Matrices 2D                                                         */
/* ------------------------------------------------------------------ */

const IDENTITY = [1, 0, 0, 1, 0, 0];

function matMul(m, n) {
    // Aplica primero n y luego m.
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5]
    ];
}

function apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function matScale(m) {
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    return (sx + sy) / 2 || 1;
}

/* ------------------------------------------------------------------ */
/* Teselado de curvas                                                  */
/* ------------------------------------------------------------------ */

const ARC_STEP = Math.PI / 36; // 5 grados

function arcSegments(sweep) {
    return Math.max(2, Math.min(360, Math.ceil(Math.abs(sweep) / ARC_STEP)));
}

function pushArc(out, cx, cy, rx, ry, start, sweep, rotation = 0) {
    const steps = arcSegments(sweep);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    for (let i = 0; i <= steps; i++) {
        const a = start + (sweep * i) / steps;
        const x = rx * Math.cos(a);
        const y = ry * Math.sin(a);
        out.push(cx + x * cos - y * sin, cy + x * sin + y * cos);
    }
}

function pushBulge(out, x1, y1, x2, y2, bulge) {
    const theta = 4 * Math.atan(bulge);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const chord = Math.hypot(dx, dy);
    if (!chord || !Number.isFinite(theta) || Math.abs(theta) < 1e-9) {
        out.push(x2, y2);
        return;
    }
    const radius = chord / (2 * Math.sin(theta / 2));
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    // Normal izquierda del segmento; el centro queda del lado contrario al bulto.
    const nx = -dy / chord;
    const ny = dx / chord;
    const offset = radius * Math.cos(theta / 2);
    const cx = mx + nx * offset;
    const cy = my + ny * offset;
    const start = Math.atan2(y1 - cy, x1 - cx);
    const steps = arcSegments(theta);
    for (let i = 1; i <= steps; i++) {
        const a = start + (theta * i) / steps;
        out.push(cx + Math.abs(radius) * Math.cos(a), cy + Math.abs(radius) * Math.sin(a));
    }
}

function deBoor(degree, controls, knots, weights, t) {
    // Evaluacion NURBS estandar (algoritmo de De Boor con coordenadas homogeneas).
    let span = degree;
    while (span < controls.length - 1 && knots[span + 1] <= t) span++;
    const d = [];
    for (let j = 0; j <= degree; j++) {
        const idx = span - degree + j;
        const w = weights ? weights[idx] : 1;
        d.push([controls[idx][0] * w, controls[idx][1] * w, w]);
    }
    for (let r = 1; r <= degree; r++) {
        for (let j = degree; j >= r; j--) {
            const idx = span - degree + j;
            const den = knots[idx + degree - r + 1] - knots[idx];
            const alpha = den === 0 ? 0 : (t - knots[idx]) / den;
            for (let k = 0; k < 3; k++) {
                d[j][k] = (1 - alpha) * d[j - 1][k] + alpha * d[j][k];
            }
        }
    }
    const p = d[degree];
    return p[2] ? [p[0] / p[2], p[1] / p[2]] : [p[0], p[1]];
}

/* ------------------------------------------------------------------ */
/* Texto                                                               */
/* ------------------------------------------------------------------ */

export function cleanMText(raw) {
    if (!raw) return '';
    return raw
        .replace(/\\P/g, '\n')
        .replace(/\\S([^;]*);/g, (_, stack) => stack.replace(/[\^#]/g, '/')) // fracciones apiladas
        .replace(/\\[fF][^;]*;/g, '')   // fuente
        .replace(/\\p[^;]*;/g, '')      // propiedades de parrafo
        .replace(/\\[HWQATC][^;\\]*;/g, '') // altura, ancho, oblicuidad, tabulacion, color
        .replace(/\\[LlOoKkNX]/g, '')   // subrayado, tachado, saltos
        .replace(/\{|\}/g, '')
        .replace(/\\~/g, ' ')
        .replace(/%%[dD]/g, '°')
        .replace(/%%[pP]/g, '±')
        .replace(/%%[cC]/g, 'ø')
        .replace(/\\\\/g, '\\')
        .trim();
}

/* ------------------------------------------------------------------ */
/* Construccion de la escena                                           */
/* ------------------------------------------------------------------ */

export const KIND_LABELS = {
    point: 'Punto',
    line: 'Linea',
    polyline: 'Polilinea',
    circle: 'Circulo',
    arc: 'Arco',
    ellipse: 'Elipse',
    spline: 'Spline',
    text: 'Texto',
    solid: 'Solido',
    insert: 'Bloque'
};

const MAX_SHAPES = 400000;
const MAX_INSERT_DEPTH = 8;

class SceneBuilder {
    constructor(dxf) {
        this.dxf = dxf;
        this.shapes = [];
        this.truncated = false;
    }

    build() {
        for (const entity of this.dxf.entities) {
            this.entity(entity, IDENTITY, null, '');
        }
        return this.shapes;
    }

    add(shape) {
        if (this.shapes.length >= MAX_SHAPES) {
            this.truncated = true;
            return;
        }
        if (!shape.pts || shape.pts.length < 2) return;
        shape.bbox = bboxOf(shape.pts);
        this.shapes.push(shape);
    }

    /** Identificador estable: handle del DXF + ruta de bloques. */
    idFor(entity, path) {
        const base = entity.handle ? entity.handle : `s${this.shapes.length}`;
        return path ? `${path}/${base}` : base;
    }

    entity(entity, matrix, layerOverride, path, depth = 0) {
        const layer = layerOverride && (group(entity, 8) === '0' || !group(entity, 8))
            ? layerOverride
            : (group(entity, 8) || layerOverride || '0');
        const common = {
            id: this.idFor(entity, path),
            layer,
            colorIndex: int(entity, 62, 256),
            trueColor: entity.groups.some(([c]) => c === 420) ? int(entity, 420, -1) : -1,
            entityType: entity.type
        };

        switch (entity.type) {
            case 'POINT': return this.point(entity, matrix, common);
            case 'LINE': return this.line(entity, matrix, common);
            case 'LWPOLYLINE': return this.lwpolyline(entity, matrix, common);
            case 'POLYLINE': return this.polyline(entity, matrix, common);
            case 'CIRCLE': return this.circle(entity, matrix, common);
            case 'ARC': return this.arc(entity, matrix, common);
            case 'ELLIPSE': return this.ellipse(entity, matrix, common);
            case 'SPLINE': return this.spline(entity, matrix, common);
            case 'SOLID':
            case 'TRACE':
            case '3DFACE': return this.solid(entity, matrix, common);
            case 'TEXT':
            case 'ATTRIB': return this.text(entity, matrix, common, group(entity, 1) || '');
            case 'MTEXT': return this.mtext(entity, matrix, common);
            case 'INSERT': return this.insert(entity, matrix, common, path, depth);
            default: return undefined;
        }
    }

    /** Espejo de OCS cuando la extrusion apunta en -Z. */
    ocs(entity, matrix) {
        const z = num(entity, 230, 1);
        if (z < 0) return matMul(matrix, [-1, 0, 0, 1, 0, 0]);
        return matrix;
    }

    point(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const [x, y] = apply(m, num(entity, 10), num(entity, 20));
        this.add({ ...common, kind: 'point', pts: [x, y], closed: false });
    }

    line(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const a = apply(m, num(entity, 10), num(entity, 20));
        const b = apply(m, num(entity, 11), num(entity, 21));
        this.add({ ...common, kind: 'line', pts: [a[0], a[1], b[0], b[1]], closed: false });
    }

    lwpolyline(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const raw = [];
        let current = null;
        for (const [code, value] of entity.groups) {
            if (code === 10) {
                if (current) raw.push(current);
                current = { x: Number(value) || 0, y: 0, bulge: 0 };
            } else if (code === 20 && current) {
                current.y = Number(value) || 0;
            } else if (code === 42 && current) {
                current.bulge = Number(value) || 0;
            }
        }
        if (current) raw.push(current);
        if (raw.length < 2) {
            if (raw.length === 1) {
                const [x, y] = apply(m, raw[0].x, raw[0].y);
                this.add({ ...common, kind: 'point', pts: [x, y], closed: false });
            }
            return;
        }
        const closed = (int(entity, 70, 0) & 1) === 1;
        const pts = this.tessellateVertices(raw, closed, m);
        this.add({ ...common, kind: 'polyline', pts, closed });
    }

    polyline(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const raw = entity.vertices
            .filter((v) => (int(v, 70, 0) & 16) === 0) // descarta vertices de malla
            .map((v) => ({ x: num(v, 10), y: num(v, 20), bulge: num(v, 42, 0) }));
        if (raw.length < 2) return;
        const closed = (int(entity, 70, 0) & 1) === 1;
        const pts = this.tessellateVertices(raw, closed, m);
        this.add({ ...common, kind: 'polyline', pts, closed });
    }

    tessellateVertices(raw, closed, m) {
        const pts = [];
        const first = apply(m, raw[0].x, raw[0].y);
        pts.push(first[0], first[1]);
        const total = closed ? raw.length : raw.length - 1;
        for (let i = 0; i < total; i++) {
            const a = raw[i];
            const b = raw[(i + 1) % raw.length];
            const pa = apply(m, a.x, a.y);
            const pb = apply(m, b.x, b.y);
            if (a.bulge) pushBulge(pts, pa[0], pa[1], pb[0], pb[1], a.bulge);
            else pts.push(pb[0], pb[1]);
        }
        return pts;
    }

    circle(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const r = num(entity, 40);
        if (r <= 0) return;
        const pts = [];
        pushArc(pts, num(entity, 10), num(entity, 20), r, r, 0, Math.PI * 2);
        this.add({ ...common, kind: 'circle', pts: transformFlat(pts, m), closed: true, radius: r * matScale(m) });
    }

    arc(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const r = num(entity, 40);
        if (r <= 0) return;
        const start = (num(entity, 50) * Math.PI) / 180;
        let end = (num(entity, 51) * Math.PI) / 180;
        while (end < start) end += Math.PI * 2;
        const pts = [];
        pushArc(pts, num(entity, 10), num(entity, 20), r, r, start, end - start);
        this.add({ ...common, kind: 'arc', pts: transformFlat(pts, m), closed: false });
    }

    ellipse(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const cx = num(entity, 10);
        const cy = num(entity, 20);
        const mx = num(entity, 11);
        const my = num(entity, 21);
        const ratio = num(entity, 40, 1);
        const start = num(entity, 41, 0);
        let end = num(entity, 42, Math.PI * 2);
        while (end <= start) end += Math.PI * 2;
        const major = Math.hypot(mx, my);
        if (major <= 0) return;
        const pts = [];
        pushArc(pts, cx, cy, major, major * ratio, start, end - start, Math.atan2(my, mx));
        this.add({ ...common, kind: 'ellipse', pts: transformFlat(pts, m), closed: Math.abs(end - start - Math.PI * 2) < 1e-6 });
    }

    spline(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const controls = [];
        const fit = [];
        const knots = [];
        const weights = [];
        let pending = null;
        for (const [code, value] of entity.groups) {
            const n = Number(value) || 0;
            if (code === 10) pending = { target: controls, x: n };
            else if (code === 11) pending = { target: fit, x: n };
            else if (code === 20 && pending) { pending.target.push([pending.x, n]); pending = null; }
            else if (code === 21 && pending) { pending.target.push([pending.x, n]); pending = null; }
            else if (code === 40) knots.push(n);
            else if (code === 41) weights.push(n);
        }
        const degree = int(entity, 71, 3);
        let pts = [];
        if (controls.length > degree && knots.length >= controls.length + degree + 1) {
            const t0 = knots[degree];
            const t1 = knots[controls.length];
            const steps = Math.max(16, Math.min(400, controls.length * 12));
            for (let i = 0; i <= steps; i++) {
                const t = t0 + ((t1 - t0) * i) / steps;
                const p = deBoor(degree, controls, knots, weights.length === controls.length ? weights : null, Math.min(t, t1 - 1e-9));
                pts.push(p[0], p[1]);
            }
        } else {
            const source = fit.length >= 2 ? fit : controls;
            for (const p of source) pts.push(p[0], p[1]);
        }
        if (pts.length < 4) return;
        this.add({ ...common, kind: 'spline', pts: transformFlat(pts, m), closed: (int(entity, 70, 0) & 1) === 1 });
    }

    solid(entity, matrix, common) {
        const m = this.ocs(entity, matrix);
        const corners = [];
        for (const [cx, cy] of [[10, 20], [11, 21], [13, 23], [12, 22]]) {
            const value = group(entity, cx);
            if (value === undefined) continue;
            corners.push(apply(m, Number(value) || 0, num(entity, cy)));
        }
        const pts = [];
        for (const c of corners) pts.push(c[0], c[1]);
        if (pts.length >= 6) {
            pts.push(pts[0], pts[1]);
            this.add({ ...common, kind: 'solid', pts, closed: true, filled: true });
        }
    }

    text(entity, matrix, common, raw) {
        const value = cleanMText(raw);
        if (!value) return;
        const m = this.ocs(entity, matrix);
        const align = int(entity, 72, 0);
        const vertical = int(entity, 73, 0);
        const useAlt = (align !== 0 || vertical !== 0) && group(entity, 11) !== undefined;
        const [x, y] = apply(m, useAlt ? num(entity, 11) : num(entity, 10), useAlt ? num(entity, 21) : num(entity, 20));
        this.add({
            ...common,
            kind: 'text',
            pts: [x, y],
            text: value,
            height: Math.max(num(entity, 40, 1), 1e-6) * matScale(m),
            rotation: (num(entity, 50, 0) * Math.PI) / 180,
            align
        });
    }

    mtext(entity, matrix, common) {
        let raw = '';
        for (const [code, value] of entity.groups) {
            if (code === 3) raw += value;
            else if (code === 1) raw += value;
        }
        const value = cleanMText(raw);
        if (!value) return;
        const m = this.ocs(entity, matrix);
        const [x, y] = apply(m, num(entity, 10), num(entity, 20));
        let rotation = (num(entity, 50, 0) * Math.PI) / 180;
        if (group(entity, 11) !== undefined) rotation = Math.atan2(num(entity, 21), num(entity, 11, 1));
        this.add({
            ...common,
            kind: 'text',
            pts: [x, y],
            text: value,
            height: Math.max(num(entity, 40, 1), 1e-6) * matScale(m),
            rotation,
            align: 0,
            attachment: int(entity, 71, 1)
        });
    }

    insert(entity, matrix, common, path, depth) {
        if (depth >= MAX_INSERT_DEPTH) return;
        const name = group(entity, 2);
        const block = name ? this.dxf.blocks.get(name) : null;
        if (!block) return;
        const m = this.ocs(entity, matrix);
        const sx = num(entity, 41, 1) || 1;
        const sy = num(entity, 42, 1) || 1;
        const rotation = (num(entity, 50, 0) * Math.PI) / 180;
        const cols = Math.max(1, int(entity, 70, 1));
        const rows = Math.max(1, int(entity, 71, 1));
        const colSpacing = num(entity, 44, 0);
        const rowSpacing = num(entity, 45, 0);
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        const layer = common.layer;
        const basePath = path ? `${path}/${entity.handle || 'i'}` : (entity.handle || 'i');

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const ox = num(entity, 10) + c * colSpacing;
                const oy = num(entity, 20) + r * rowSpacing;
                const local = matMul(
                    [cos, sin, -sin, cos, ox, oy],
                    [sx, 0, 0, sy, -block.base[0] * sx, -block.base[1] * sy]
                );
                const full = matMul(m, local);
                const cellPath = rows * cols > 1 ? `${basePath}:${r}x${c}` : basePath;
                for (const child of block.entities) {
                    this.entity(child, full, layer, cellPath, depth + 1);
                    if (this.truncated) return;
                }
            }
        }
    }
}

function transformFlat(pts, m) {
    if (m === IDENTITY) return pts;
    const out = new Array(pts.length);
    for (let i = 0; i < pts.length; i += 2) {
        out[i] = m[0] * pts[i] + m[2] * pts[i + 1] + m[4];
        out[i + 1] = m[1] * pts[i] + m[3] * pts[i + 1] + m[5];
    }
    return out;
}

function bboxOf(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
        const x = pts[i];
        const y = pts[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return [minX, minY, maxX, maxY];
}

const UNIT_NAMES = {
    0: 'sin unidad', 1: 'pulgadas', 2: 'pies', 4: 'mm', 5: 'cm', 6: 'm', 7: 'km', 9: 'micras', 10: 'yardas'
};

/** Metros que vale una unidad del dibujo, para poder cubicar en m³. */
const UNIT_TO_METERS = {
    'sin unidad': 1, pulgadas: 0.0254, pies: 0.3048, mm: 0.001,
    cm: 0.01, m: 1, km: 1000, micras: 1e-6, yardas: 0.9144
};

/**
 * Factor a metros. Si el DXF no declara unidades se asume que ya viene en
 * metros, que es lo habitual en planos de obra civil.
 */
export function metersPerUnit(units) {
    const factor = UNIT_TO_METERS[units];
    return Number.isFinite(factor) ? factor : 1;
}

/**
 * Lee un DXF completo y devuelve la escena lista para dibujar.
 * @param {string} text contenido del archivo
 * @returns {{shapes:Array, layers:Array, bounds:Array, units:string, truncated:boolean}}
 */
export function readDxf(text) {
    const dxf = parseDxf(text);
    const builder = new SceneBuilder(dxf);
    const shapes = builder.build();

    const layerInfo = new Map();
    for (const [name, layer] of dxf.layers) {
        layerInfo.set(name, {
            name,
            color: layer.trueColor !== undefined ? '#' + (layer.trueColor & 0xffffff).toString(16).padStart(6, '0') : aciToHex(layer.color),
            count: 0,
            kinds: {}
        });
    }
    let bounds = null;
    for (const shape of shapes) {
        let info = layerInfo.get(shape.layer);
        if (!info) {
            info = { name: shape.layer, color: aciToHex(7), count: 0, kinds: {} };
            layerInfo.set(shape.layer, info);
        }
        info.count++;
        info.kinds[shape.kind] = (info.kinds[shape.kind] || 0) + 1;
        bounds = growBounds(bounds, shape.bbox);
    }

    const layers = [...layerInfo.values()]
        .filter((l) => l.count > 0)
        .sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));

    const insunits = dxf.header.$INSUNITS ? parseInt(dxf.header.$INSUNITS[70], 10) : 0;

    return {
        shapes,
        layers,
        bounds: bounds || [0, 0, 100, 100],
        units: UNIT_NAMES[insunits] || 'sin unidad',
        truncated: builder.truncated
    };
}

export function growBounds(bounds, box) {
    if (!box || !Number.isFinite(box[0])) return bounds;
    if (!bounds) return [box[0], box[1], box[2], box[3]];
    return [
        Math.min(bounds[0], box[0]),
        Math.min(bounds[1], box[1]),
        Math.max(bounds[2], box[2]),
        Math.max(bounds[3], box[3])
    ];
}
