/*
 * Partes de avance: lo que un supervisor reporta desde su dispositivo y lo que
 * el administrador junta en la obra.
 *
 * El problema que resuelve: cada dispositivo tiene su propia base y nadie ve lo
 * del otro. Un parte es un archivo chico —solo el avance, no la obra entera—
 * que viaja como sea (WhatsApp, correo, o una carpeta compartida cuando la
 * haya) y que al llegar se funde con lo que ya hay.
 *
 * Por que fundir es seguro:
 *
 *   El avance solo crece. Los metros hechos no se deshacen, asi que juntar dos
 *   partes es unir intervalos y nunca hay que preguntar cual gana. Si dos
 *   supervisores avanzaron en el mismo tramo, los metros se suman en vez de
 *   competir, y el solape se recorta en favor del dia mas temprano para no
 *   inventar avance que no hubo.
 *
 * Lo que un parte NO lleva: el plano, las actividades ni los tramos. Esos los
 * define el administrador y viajan al reves. Un parte que hable de un tramo que
 * aqui no existe se informa en vez de inventarlo, porque significa que los dos
 * lados tienen obras distintas.
 */

import { normalizeSpans, refSpans } from './tasks.js';
import { measure } from './scene.js';

export const PART_KIND = 'parte-tareas-dxf';
export const PART_VERSION = 1;

const WHO_KEY = 'dxf-tareas:quien';

/* ----------------------------- quien reporta ------------------------------ */

/*
 * Quien usa este dispositivo es del dispositivo, no de la obra: el mismo
 * supervisor lleva dos obras con el mismo iPad. Por eso va en localStorage y
 * no dentro del proyecto.
 */

export function whoAmI() {
    try {
        return localStorage.getItem(WHO_KEY) || '';
    } catch (error) {
        return '';
    }
}

export function setWhoAmI(name) {
    const clean = String(name || '').trim().slice(0, 80);
    try {
        if (clean) localStorage.setItem(WHO_KEY, clean);
        else localStorage.removeItem(WHO_KEY);
    } catch (error) {
        // En navegacion privada no se puede guardar; se sigue sin firma.
    }
    return clean;
}

/* ------------------------------ armar el parte ---------------------------- */

/** Largo de un elemento del plano, que es contra lo que se miden los spans. */
function totalOf(ref, shapesById, metersPerUnit) {
    const shape = shapesById.get(ref.id);
    const m = shape ? measure(shape) : null;
    return m && m.length ? m.length * metersPerUnit : 0;
}

/**
 * El parte de un rango de fechas: solo los tramos con avance en esas fechas, y
 * de cada uno solo los spans de esos dias.
 *
 * @returns {{kind, version, obra, autor, desde, hasta, generado, avances}}
 */
export function buildPart(project, tasks, { from = '', to = '', author = '', shapesById = new Map(), metersPerUnit = 1 } = {}) {
    const desde = from || '';
    const hasta = to || from || '';
    const avances = [];

    for (const task of tasks) {
        for (const ref of task.elements || []) {
            const total = totalOf(ref, shapesById, metersPerUnit);
            if (!total) continue;
            const own = refSpans(ref, total).filter((span) => {
                if (!span.date) return false;
                if (desde && span.date < desde) return false;
                if (hasta && span.date > hasta) return false;
                return true;
            });
            if (!own.length) continue;
            avances.push({
                tarea: task.id,
                titulo: task.title || '',
                elemento: ref.id,
                capa: ref.layer || '',
                estado: task.status || '',
                spans: own.map((span) => ({
                    from: round(span.from),
                    to: round(span.to),
                    date: span.date,
                    by: span.by || author || null
                }))
            });
        }
    }

    return {
        kind: PART_KIND,
        version: PART_VERSION,
        obra: { id: project.id, nombre: project.name || '' },
        autor: author || '',
        desde,
        hasta,
        generado: new Date().toISOString(),
        avances
    };
}

function round(value) {
    return Math.round((Number(value) || 0) * 1000) / 1000;
}

/** Metros que lleva un parte, para poder anunciarlo antes de fundirlo. */
export function partMeters(part) {
    let total = 0;
    for (const row of (part && part.avances) || []) {
        for (const span of row.spans || []) total += Math.max(0, span.to - span.from);
    }
    return total;
}

/** Quienes firman el parte. Normalmente uno, pero puede venir consolidado. */
export function partAuthors(part) {
    const names = new Set();
    for (const row of (part && part.avances) || []) {
        for (const span of row.spans || []) if (span.by) names.add(span.by);
    }
    if (!names.size && part && part.autor) names.add(part.autor);
    return [...names].sort((a, b) => a.localeCompare(b, 'es'));
}

/** Lee y valida un parte. Lanza con un motivo legible si no lo es. */
export function readPart(text) {
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new Error('El archivo no es un parte: no se pudo leer.');
    }
    if (!data || data.kind !== PART_KIND) {
        throw new Error('Ese archivo no es un parte de avance. Si es una copia completa de la obra, usa "Restaurar copia".');
    }
    if (Number(data.version) > PART_VERSION) {
        throw new Error('El parte viene de una version mas nueva de la aplicacion. Actualiza antes de abrirlo.');
    }
    if (!Array.isArray(data.avances)) throw new Error('El parte no trae avances.');
    return data;
}

/* -------------------------------- fundir ---------------------------------- */

/**
 * Funde un parte con las tareas de la obra.
 *
 * No escribe nada: devuelve que tareas cambiaron y cuanto, para que quien
 * llama decida si guardar. Asi se puede mostrar antes lo que va a pasar.
 *
 * @returns {{changed, meters, tasks, missing, otherObra, authors, days}}
 */
export function mergePart(part, tasks, { shapesById = new Map(), metersPerUnit = 1, projectId = '' } = {}) {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    /*
     * El calce no puede ser por el id del tramo. Al restaurar la obra en otro
     * dispositivo los identificadores se reasignan, de modo que los del iPad
     * del supervisor no son los del administrador. Lo que si es igual en todos
     * lados es el elemento del plano: su id es el handle del DXF, que viene en
     * el archivo. Con el titulo del tramo —que dice la actividad— el par queda
     * unico, y el id del tramo sirve solo de atajo cuando coincide.
     */
    const byPlace = new Map();
    for (const task of tasks) {
        for (const ref of task.elements || []) {
            byPlace.set(`${task.title}|${ref.id}`, { task, ref });
        }
    }
    const find = (row) => {
        const hit = byPlace.get(`${row.titulo}|${row.elemento}`);
        if (hit) return hit;
        const task = byId.get(row.tarea);
        const ref = task && (task.elements || []).find((e) => e.id === row.elemento);
        return ref ? { task, ref } : null;
    };

    const changed = new Map();
    const missing = [];
    let meters = 0;
    // Metros que el parte trae pero que aqui ya estaban. Es informacion util:
    // dos supervisores en el mismo tramo miden los dos desde cero, porque
    // ninguno ve lo del otro, y conviene saber que se reporto dos veces.
    let known = 0;

    for (const row of part.avances || []) {
        const hit = find(row);
        if (!hit) {
            missing.push(row.titulo || row.tarea);
            continue;
        }
        const { task, ref } = hit;
        const total = totalOf(ref, shapesById, metersPerUnit);
        if (!total) continue;

        const before = refSpans(ref, total);
        const after = normalizeSpans([...before, ...(row.spans || [])], total);
        const gained = length(after) - length(before);
        const traia = length(row.spans || []);
        if (traia - gained > 1e-6) known += traia - gained;
        // Un parte que ya se habia cargado no suma nada y no ensucia el conteo.
        if (gained <= 1e-6) continue;

        ref.spans = after;
        meters += gained;
        changed.set(task.id, (changed.get(task.id) || 0) + gained);
        // El estado solo avanza: un parte no puede reabrir lo que aqui ya cerro.
        if (row.estado === 'completada' && task.status !== 'completada') task.status = 'completada';
        else if (row.estado === 'en_curso' && task.status === 'pendiente') task.status = 'en_curso';
        task.updatedAt = Date.now();
    }

    const days = [...new Set((part.avances || [])
        .flatMap((row) => (row.spans || []).map((s) => s.date))
        .filter(Boolean))].sort();

    return {
        changed: changed.size,
        meters,
        known,
        tasks: [...changed.entries()].map(([id, m]) => ({ id, title: (byId.get(id) || {}).title || id, meters: m })),
        missing,
        otherObra: !!projectId && part.obra && part.obra.id !== projectId,
        authors: partAuthors(part),
        days
    };
}

function length(spans) {
    return (spans || []).reduce((sum, span) => sum + Math.max(0, span.to - span.from), 0);
}

/** Nombre del archivo de un parte. */
export function partFileName(part) {
    const autor = String(part.autor || 'parte').replace(/[^A-Za-z0-9 ._-]/g, ' ').trim() || 'parte';
    const dia = part.hasta || part.desde || new Date().toISOString().slice(0, 10);
    return `${dia} ${autor}.parte.json`;
}
