/*
 * Reconocimiento del esquema de capas de una obra electrica.
 *
 * Cuando el plano viene clasificado con una convencion —tipos de zanja por un
 * lado y circuitos por tramo por el otro— se puede armar la obra completa al
 * importar: las actividades, todos los tramos con su nombre y su seccion, y
 * la verificacion de que la zanja alcanza para los circuitos que pasan.
 *
 * La convencion que se reconoce:
 *
 *   ZANJA-TA / ZANJA-TB / ZANJA-TC     tipos de zanja
 *   CRUCE-TA / CRUCE-TB / CRUCE-TC     cruces de camino, misma seccion mas honda
 *   MT-C01-WTG10-WTG09                 circuito 01, tramo entre dos nodos
 *   FO-C01-WTG10-WTG09                 fibra, mismo patron
 *
 * El tipo de zanja declara cuantas triadas lleva, y eso es lo que permite
 * contrastar el dibujo contra si mismo.
 */

import { measure } from './scene.js';
import { distanceToPaths, samplePaths } from './overlap.js';
import { projectOnPath } from './edits.js';

/* --------------------------- tipos de zanja ------------------------------ */

/** Seccion y triadas de cada tipo. La profundidad del cruce suma su recargo. */
export const TRENCH_TYPES = {
    TA: { width: 0.60, depth: 1.10, triadas: 1 },
    TB: { width: 0.80, depth: 1.10, triadas: 2 },
    TC: { width: 1.30, depth: 1.10, triadas: 3 }
};

/** Un cruce de camino conserva el ancho y gana profundidad. */
export const CROSSING_EXTRA_DEPTH = 0.20;

const ZANJA_RE = /^(ZANJA|CRUCE)[-_ ]?(T[A-Z])$/i;
const CIRCUIT_RE = /^(MT|FO|BT)[-_ ]?(C\d+)[-_ ](.+)$/i;

/** Seccion que corresponde a una capa de zanja o cruce. */
export function sectionOf(familia, tipo) {
    const base = TRENCH_TYPES[tipo];
    if (!base) return null;
    const depth = familia === 'CRUCE' ? base.depth + CROSSING_EXTRA_DEPTH : base.depth;
    return { width: base.width, depth, triadas: base.triadas };
}

/**
 * Clasifica las capas importadas segun la convencion.
 * @returns {{trenches, circuits, others, recognised}}
 */
export function classifyLayers(layerNames) {
    const trenches = [];
    const circuits = new Map();
    const others = [];

    for (const name of layerNames) {
        const zanja = ZANJA_RE.exec(name.trim());
        if (zanja) {
            const familia = zanja[1].toUpperCase();
            const tipo = zanja[2].toUpperCase();
            const section = sectionOf(familia, tipo);
            if (section) {
                trenches.push({ layer: name, familia, tipo, ...section });
                continue;
            }
        }
        const circuito = CIRCUIT_RE.exec(name.trim());
        if (circuito) {
            const familia = circuito[1].toUpperCase();
            const codigo = circuito[2].toUpperCase();
            // El resto es "ORIGEN-DESTINO"; se parte por el ultimo guion que
            // deje dos mitades, porque los nodos no llevan guiones.
            const resto = circuito[3].trim();
            const partes = resto.split(/[-_]/);
            const tramo = partes.length >= 2
                ? { from: partes.slice(0, -1).join('-'), to: partes[partes.length - 1] }
                : { from: resto, to: '' };
            if (!circuits.has(codigo)) circuits.set(codigo, { codigo, familia, layers: [] });
            circuits.get(codigo).layers.push({ layer: name, familia, ...tramo, nombre: resto });
            continue;
        }
        others.push(name);
    }

    trenches.sort((a, b) => a.layer.localeCompare(b.layer, 'es'));
    return {
        trenches,
        circuits: [...circuits.values()].sort((a, b) => a.codigo.localeCompare(b.codigo, 'es')),
        others,
        recognised: trenches.length > 0 || circuits.size > 0
    };
}

/* ------------------------- medidas de las capas --------------------------- */

function lengthOf(shape) {
    const m = measure(shape);
    return m && m.length ? m.length : 0;
}

/** Resumen por capa: cuantos elementos, cuantos metros y cuanto volumen. */
export function summarize(classification, shapes, metersPerUnit = 1) {
    const byLayer = new Map();
    for (const shape of shapes) {
        if (!byLayer.has(shape.layer)) byLayer.set(shape.layer, []);
        byLayer.get(shape.layer).push(shape);
    }

    const trenches = classification.trenches.map((t) => {
        const own = byLayer.get(t.layer) || [];
        const meters = own.reduce((sum, s) => sum + lengthOf(s), 0) * metersPerUnit;
        return { ...t, count: own.length, meters, volume: meters * t.width * t.depth };
    });

    const circuits = classification.circuits.map((c) => {
        const layers = c.layers.map((l) => {
            const own = byLayer.get(l.layer) || [];
            return { ...l, count: own.length, meters: own.reduce((sum, s) => sum + lengthOf(s), 0) * metersPerUnit };
        });
        return { ...c, layers, meters: layers.reduce((sum, l) => sum + l.meters, 0), empty: layers.every((l) => !l.count) };
    });

    return {
        trenches,
        circuits,
        trenchMeters: trenches.reduce((s, t) => s + t.meters, 0),
        trenchVolume: trenches.reduce((s, t) => s + t.volume, 0),
        circuitMeters: circuits.reduce((s, c) => s + c.meters, 0)
    };
}

/* --------------------------- verificar triadas ---------------------------- */

/**
 * Contrasta cuantas triadas declara cada zanja contra cuantos circuitos pasan
 * realmente por ella, midiendo el perfil a lo largo del tramo.
 *
 * El exceso se exige continuo: dos circuitos que solo se cruzan comparten unos
 * pocos metros y eso no es un problema de seccion.
 */
export function verifyTriadas(classification, shapes, options = {}) {
    const {
        tolerance = 2,
        metersPerUnit = 1,
        step = 5,
        minRun = 25
    } = options;
    const tol = tolerance / metersPerUnit;
    const stepUnits = step / metersPerUnit;
    const minRunUnits = minRun / metersPerUnit;

    const trenchLayers = new Map(classification.trenches.map((t) => [t.layer, t]));
    const circuitOf = new Map();
    for (const circuito of classification.circuits) {
        for (const l of circuito.layers) circuitOf.set(l.layer, circuito.codigo);
    }
    const cables = shapes.filter((s) => circuitOf.has(s.layer) && s.pts && s.pts.length >= 4);

    const tight = [];
    const loose = [];
    for (const shape of shapes) {
        const trench = trenchLayers.get(shape.layer);
        if (!trench || !shape.pts || shape.pts.length < 4) continue;

        const samples = samplePaths([shape.pts], stepUnits);
        const seen = new Set();
        let run = 0;
        let worstRun = 0;
        let peak = 0;
        for (let i = 0; i + 2 < samples.length; i += 3) {
            const here = new Set();
            for (const cable of cables) {
                if (distanceToPaths([cable.pts], samples[i], samples[i + 1]) <= tol) here.add(circuitOf.get(cable.layer));
            }
            for (const c of here) seen.add(c);
            if (here.size > peak) peak = here.size;
            if (here.size > trench.triadas) {
                run += samples[i + 2];
                if (run > worstRun) worstRun = run;
            } else run = 0;
        }

        const meters = lengthOf(shape) * metersPerUnit;
        const row = {
            id: shape.id,
            layer: shape.layer,
            tipo: trench.tipo,
            meters,
            declared: trench.triadas,
            peak,
            excess: worstRun * metersPerUnit,
            circuits: [...seen].sort()
        };
        if (worstRun >= minRunUnits) tight.push(row);
        else if (peak < trench.triadas && peak > 0) loose.push(row);
    }

    tight.sort((a, b) => b.excess - a.excess);
    return {
        tight,
        loose,
        looseMeters: loose.reduce((s, r) => s + r.meters, 0),
        checked: shapes.filter((s) => trenchLayers.has(s.layer)).length,
        circuits: classification.circuits.length
    };
}

/* --------------------- nombrar los tramos de zanja ------------------------ */

/**
 * A cada polilinea de zanja le pone el nombre del tramo de circuito que mas la
 * recorre: la zanja bajo "MT-C01-WTG10-WTG09" pasa a llamarse "WTG10-WTG09".
 *
 * Cuando varias polilineas caen bajo el mismo recorrido —lo normal, porque la
 * ruta cambia de tipo de zanja a lo largo del camino— se numeran en el orden
 * en que aparecen recorriendo el circuito desde su origen. Asi "WTG09-SSEE 3"
 * es el tercer trecho saliendo de la maquina, que es como se habla en terreno.
 */
export function nameTrenches(classification, shapes, options = {}) {
    const { tolerance = 2, metersPerUnit = 1, step = 5, minShare = 0.4 } = options;
    const tol = tolerance / metersPerUnit;
    const stepUnits = step / metersPerUnit;

    const trenchLayers = new Map(classification.trenches.map((t) => [t.layer, t]));
    const tramoOf = new Map();
    for (const circuito of classification.circuits) {
        for (const l of circuito.layers) tramoOf.set(l.layer, { codigo: circuito.codigo, nombre: `${l.from}-${l.to}` });
    }
    const cables = shapes.filter((s) => tramoOf.has(s.layer) && s.pts && s.pts.length >= 4);
    const cablesByName = new Map();
    for (const cable of cables) {
        const nombre = tramoOf.get(cable.layer).nombre;
        if (!cablesByName.has(nombre)) cablesByName.set(nombre, []);
        cablesByName.get(nombre).push(cable);
    }

    // Primera pasada: a que recorrido pertenece cada zanja y en que punto de el.
    const rows = [];
    for (const shape of shapes) {
        if (!trenchLayers.has(shape.layer) || !shape.pts || shape.pts.length < 4) continue;

        const samples = samplePaths([shape.pts], stepUnits);
        const score = new Map();
        let total = 0;
        for (let i = 0; i + 2 < samples.length; i += 3) {
            total += samples[i + 2];
            for (const cable of cables) {
                if (distanceToPaths([cable.pts], samples[i], samples[i + 1]) > tol) continue;
                const tramo = tramoOf.get(cable.layer).nombre;
                score.set(tramo, (score.get(tramo) || 0) + samples[i + 2]);
            }
        }

        let best = null;
        let bestShare = 0;
        for (const [tramo, meters] of score) {
            const share = total > 0 ? meters / total : 0;
            if (share > bestShare) { best = tramo; bestShare = share; }
        }

        const route = best && bestShare >= minShare ? best : null;
        rows.push({ shape, route, along: route ? alongRoute(shape, cablesByName.get(route)) : 0 });
    }

    // Segunda pasada: numerar cada recorrido siguiendo su propio sentido.
    const names = new Map();
    const grupos = new Map();
    for (const row of rows) {
        const clave = row.route || row.shape.layer;
        if (!grupos.has(clave)) grupos.set(clave, []);
        grupos.get(clave).push(row);
    }
    for (const [clave, grupo] of grupos) {
        grupo.sort((a, b) => a.along - b.along);
        grupo.forEach((row, i) => {
            names.set(row.shape.id, grupo.length > 1 ? `${clave} ${i + 1}` : clave);
        });
    }
    return names;
}

/** Distancia a la que queda una zanja a lo largo del recorrido de su circuito. */
function alongRoute(shape, cables) {
    if (!cables || !cables.length) return 0;
    const pts = shape.pts;
    const mid = Math.floor(pts.length / 4) * 2;
    const x = pts[mid];
    const y = pts[mid + 1];
    let best = { along: 0, distance: Infinity };
    let offset = 0;
    for (const cable of cables) {
        const hit = projectOnPath(cable.pts, x, y);
        if (hit.distance < best.distance) best = { along: offset + hit.along, distance: hit.distance };
        offset += 1e6;   // mantiene el orden entre polilineas de un mismo recorrido
    }
    return best.along;
}

/* ------------------------ actividades propuestas -------------------------- */

/**
 * Actividades tipo de una red de media tension subterranea. Cada una dice
 * sobre que capas se ejecuta y como se mide; el usuario las ajusta antes de
 * crearlas.
 */
export const SUGGESTED_ACTIVITIES = [
    { key: 'exc', name: 'Excavacion', target: 'zanja', unit: 'm3', scope: 'zanja', after: [] },
    // La malla de puesta a tierra va al fondo de la zanja, antes de la cama.
    { key: 'pt', name: 'Tendido de cobre', target: 'zanja', unit: 'ml', scope: 'zanja', after: ['exc'] },
    { key: 'cama', name: 'Cama de arena', target: 'zanja', unit: 'ml', scope: 'zanja', after: ['pt'] },
    { key: 'pot', name: 'Cable de potencia', target: 'circuito', familias: ['MT'], unit: 'ml_fase', scope: 'circuito', after: ['cama'] },
    // La fibra va una por tramo de circuito. Si se dibujo aparte va por sus
    // capas FO; si no, sigue el mismo recorrido que el circuito de MT.
    { key: 'fo', name: 'Fibra optica', target: 'circuito', familias: ['FO', 'MT'], unit: 'ml', scope: 'circuito', after: ['pot'] },
    { key: 'tapa', name: 'Tapado y compactacion', target: 'zanja', unit: 'm3', scope: 'zanja', after: ['fo'] },
    // Los cruces son una cadena aparte: se hacen en paralelo a la zanja, asi
    // que el primero se ancla a mano para que reordenar no lo encadene a ella.
    { key: 'exc_cruce', name: 'Excavacion de cruce', target: 'cruce', unit: 'm3', scope: 'zanja', after: [], anchor: true },
    { key: 'ducto', name: 'Ductos y hormigonado', target: 'cruce', unit: 'ml', scope: 'zanja', after: ['exc_cruce'] },
    { key: 'repo', name: 'Relleno y reposicion', target: 'cruce', unit: 'ml', scope: 'zanja', after: ['ducto'] }
];

/** Capas sobre las que se ejecuta una actividad propuesta. */
export function layersFor(suggestion, classification) {
    if (suggestion.target === 'circuito') {
        const all = classification.circuits.flatMap((c) => c.layers);
        if (!suggestion.familias) return all.map((l) => l.layer);
        // Se toma la primera familia que este dibujada: la fibra usa sus
        // propias capas si existen, y si no se apoya en el trazado del circuito.
        for (const familia of suggestion.familias) {
            const own = all.filter((l) => l.familia === familia);
            if (own.length) return own.map((l) => l.layer);
        }
        return [];
    }
    const familia = suggestion.target === 'cruce' ? 'CRUCE' : 'ZANJA';
    return classification.trenches.filter((t) => t.familia === familia).map((t) => t.layer);
}
