/*
 * Modelo de tareas asociadas a elementos del dibujo, filtros y exportacion.
 */

import { newId } from './db.js';
import { measure } from './scene.js';

export const STATUSES = [
    { id: 'pendiente', label: 'Pendiente', color: '#f59e0b' },
    { id: 'en_curso', label: 'En curso', color: '#3b82f6' },
    { id: 'revision', label: 'En revision', color: '#a855f7' },
    { id: 'completada', label: 'Completada', color: '#22c55e' },
    { id: 'bloqueada', label: 'Bloqueada', color: '#ef4444' }
];

export const PRIORITIES = [
    { id: 'baja', label: 'Baja', color: '#94a3b8' },
    { id: 'media', label: 'Media', color: '#f59e0b' },
    { id: 'alta', label: 'Alta', color: '#ef4444' }
];

export function statusOf(id) {
    return STATUSES.find((s) => s.id === id) || STATUSES[0];
}

export function priorityOf(id) {
    return PRIORITIES.find((p) => p.id === id) || PRIORITIES[1];
}

export function createTask(projectId, patch = {}) {
    const now = Date.now();
    return {
        id: newId('task'),
        projectId,
        title: '',
        description: '',
        status: 'pendiente',
        priority: 'media',
        assignee: '',
        start: '',      // inicio planificado (YYYY-MM-DD)
        due: '',        // termino planificado
        activityId: null,  // actividad a la que pertenece (excavacion, tendido...)
        duration: null,    // dias fijos; si no, salen del rendimiento
        ternas: 1,         // ternas o triadas del tramo (cable de potencia)
        predecessors: [],  // tramos previos, cuando se enlazan a mano
        linksAuto: true,   // false = el usuario maneja los antecesores de este tramo
        elements: [],   // [{id, kind, layer, x, y}]
        resources: [],  // ids de personal y maquinaria asignados
        progress: 0,    // avance declarado 0-100
        anchor: null,   // {x, y} usado para el marcador en el plano
        createdAt: now,
        updatedAt: now,
        ...patch
    };
}

/* --------------------- avance parcial dentro de un tramo ----------------- */

/*
 * Varias actividades comparten el mismo elemento del plano (se excava, se
 * tiende y se tapa la misma zanja) y cada una avanza a su ritmo. Por eso el
 * avance no divide la geometria: cada tarea guarda sobre el elemento los
 * metros que lleva ejecutados, medidos desde el inicio de la polilinea.
 */

/** Ordena, recorta al largo real y fusiona los tramos que se solapan. */
export function normalizeSpans(spans, total) {
    const clean = (spans || [])
        .map((span) => ({
            from: Math.max(0, Math.min(total, Number(span.from) || 0)),
            to: Math.max(0, Math.min(total, Number(span.to) || 0)),
            date: span.date || null
        }))
        .filter((span) => span.to - span.from > 1e-9)
        .sort((a, b) => a.from - b.from);

    const merged = [];
    for (const span of clean) {
        const last = merged[merged.length - 1];
        if (last && span.from <= last.to + 1e-9) {
            last.to = Math.max(last.to, span.to);
            // Se conserva la fecha mas reciente del tramo fusionado.
            if (span.date && (!last.date || span.date > last.date)) last.date = span.date;
        } else {
            merged.push({ ...span });
        }
    }
    return merged;
}

export function spansLength(spans) {
    return (spans || []).reduce((sum, span) => sum + Math.max(0, span.to - span.from), 0);
}

/** Agrega un tramo ejecutado y devuelve los tramos ya fusionados. */
export function addSpan(ref, from, to, date, total) {
    const previous = refSpans(ref, total);
    return normalizeSpans([...previous, { from, to, date }], total);
}

/**
 * Tramos ejecutados de una referencia. Las tareas anteriores a esta forma de
 * registrar solo tienen el interruptor `done`: se leen como el tramo entero.
 */
export function refSpans(ref, total) {
    if (ref.spans && ref.spans.length) return normalizeSpans(ref.spans, total);
    return ref.done ? [{ from: 0, to: total, date: ref.doneAt || null }] : [];
}

/** Longitud ejecutada de una referencia. */
export function refDoneLength(ref, total) {
    return spansLength(refSpans(ref, total));
}

/** Metros ejecutados hasta una fecha, para reconstruir el pasado. */
export function refDoneLengthAt(ref, total, date) {
    const spans = refSpans(ref, total).filter((span) => !span.date || span.date <= date);
    return spansLength(spans);
}

/** Un tramo esta completo cuando lo ejecutado cubre practicamente todo. */
export function isRefDone(ref, total) {
    if (!total) return !!ref.done;
    return refDoneLength(ref, total) >= total - Math.max(total * 1e-6, 1e-9);
}

/** Ultima fecha con avance en ese tramo. */
export function refLastDate(ref) {
    const dates = [(ref.spans || []).map((s) => s.date), ref.doneAt].flat().filter(Boolean);
    return dates.sort().pop() || null;
}

/* -------------------------------- avance -------------------------------- */

/** Avance efectivo: una tarea completada cuenta 100 aunque no se haya escrito. */
export function taskProgress(task) {
    if (task.status === 'completada') return 100;
    const value = Number(task.progress);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

/** Cantidad de obra que representa una tarea, segun los elementos vinculados. */
export function taskQuantity(task, shapesById, metersPerUnit = 1) {
    const total = { length: 0, area: 0, volume: 0, count: 0 };
    const done = { length: 0, area: 0, volume: 0, count: 0 };

    for (const ref of task.elements) {
        const shape = shapesById.get(ref.id);
        if (!shape) continue;
        const m = measure(shape);
        total.count++;
        if (!m) {
            if (ref.done) done.count++;
            continue;
        }

        if (shape.closed && m.area) {
            // Las areas se siguen marcando enteras: no tienen "metros".
            total.area += m.area;
            if (ref.done) { done.area += m.area; done.count++; }
        } else {
            const executed = refDoneLength(ref, m.length);
            total.length += m.length;
            done.length += executed;
            if (isRefDone(ref, m.length)) done.count++;
        }
        // El volumen solo existe si el tramo tiene seccion definida.
        const width = Number(ref.width);
        const depth = Number(ref.depth);
        if (width > 0 && depth > 0 && m.length) {
            const perUnit = metersPerUnit * width * depth;
            total.volume += m.length * perUnit;
            done.volume += refDoneLength(ref, m.length) * perUnit;
        }
    }
    return { ...total, done };
}

/** Avance calculado a partir de los tramos marcados, ponderado por su medida. */
export function progressFromElements(task, shapesById) {
    const quantity = taskQuantity(task, shapesById);
    if (quantity.length > 0) return (quantity.done.length / quantity.length) * 100;
    if (quantity.area > 0) return (quantity.done.area / quantity.area) * 100;
    if (quantity.count > 0) return (quantity.done.count / quantity.count) * 100;
    return 0;
}

/**
 * Rendimiento medido sobre los dias en que hubo avance registrado: los dias
 * parados por lluvia o falta de frente no castigan el numero.
 */
export function performance(task, shapesById, metersPerUnit = 1) {
    const days = new Set();
    for (const ref of task.elements) {
        if (ref.done && ref.doneAt) days.add(ref.doneAt);
    }
    const quantity = taskQuantity(task, shapesById, metersPerUnit);
    const dayCount = days.size;
    if (!dayCount) return { days: 0, perDay: 0, volumePerDay: 0, remaining: quantity.length, daysLeft: null };

    const perDay = quantity.done.length / dayCount;
    const remaining = quantity.length - quantity.done.length;
    return {
        days: dayCount,
        perDay,
        volumePerDay: quantity.done.volume / dayCount,
        remaining,
        daysLeft: perDay > 0 ? Math.ceil(remaining / perDay) : null,
        lastDay: [...days].sort().pop()
    };
}

/**
 * Avance del conjunto, ponderado por la cantidad de cada tarea.
 * Es lo que hace util dividir un elemento: cada trozo aporta su longitud real.
 */
export function progressSummary(tasks, shapesById, metersPerUnit = 1) {
    const total = { length: 0, area: 0, volume: 0, count: 0 };
    const done = { length: 0, area: 0, volume: 0, count: 0 };
    let simple = 0;

    for (const task of tasks) {
        const quantity = taskQuantity(task, shapesById, metersPerUnit);
        const ratio = taskProgress(task) / 100;
        total.length += quantity.length;
        total.area += quantity.area;
        total.volume += quantity.volume;
        total.count += quantity.count;

        if (tracksElements(task)) {
            // Con tramos marcados la cantidad ejecutada es exacta, no estimada.
            done.length += quantity.done.length;
            done.area += quantity.done.area;
            done.volume += quantity.done.volume;
            done.count += quantity.done.count;
        } else {
            done.length += quantity.length * ratio;
            done.area += quantity.area * ratio;
            done.volume += quantity.volume * ratio;
        }
        simple += ratio;
    }

    return {
        length: { total: total.length, done: done.length, pct: total.length ? (done.length / total.length) * 100 : null },
        area: { total: total.area, done: done.area, pct: total.area ? (done.area / total.area) * 100 : null },
        volume: { total: total.volume, done: done.volume, pct: total.volume ? (done.volume / total.volume) * 100 : null },
        elements: { total: total.count, done: done.count },
        tasks: { count: tasks.length, pct: tasks.length ? (simple / tasks.length) * 100 : 0 }
    };
}

export function elementRef(shape, anchor) {
    return {
        id: shape.id,
        kind: shape.kind,
        layer: shape.layer,
        x: anchor ? anchor.x : shape.pts[0],
        y: anchor ? anchor.y : shape.pts[1],
        done: false,     // tramo ejecutado por completo
        doneAt: null,    // fecha (YYYY-MM-DD) en que se marco
        spans: [],       // tramos ejecutados: [{from, to, date}] en unidades del plano
        width: null,     // ancho de excavacion, en metros
        depth: null      // profundidad de excavacion, en metros
    };
}

/**
 * Una tarea lleva su avance por tramos cuando sus elementos tienen el campo
 * `done`. Las tareas creadas antes de esta funcion conservan el porcentaje
 * escrito a mano hasta que se marque el primer tramo.
 */
export function tracksElements(task) {
    return (task.elements || []).some((element) => 'done' in element);
}

export function taskAnchor(task) {
    if (task.anchor) return task.anchor;
    if (task.elements.length) {
        const sum = task.elements.reduce((acc, e) => ({ x: acc.x + e.x, y: acc.y + e.y }), { x: 0, y: 0 });
        return { x: sum.x / task.elements.length, y: sum.y / task.elements.length };
    }
    return null;
}

export function isOverdue(task) {
    if (!task.due || task.status === 'completada') return false;
    const due = new Date(task.due + 'T23:59:59');
    return Number.isFinite(due.getTime()) && due.getTime() < Date.now();
}

export function filterTasks(tasks, filters = {}) {
    const text = (filters.text || '').trim().toLowerCase();
    return tasks.filter((task) => {
        if (filters.status && filters.status !== 'todas' && task.status !== filters.status) return false;
        if (filters.priority && filters.priority !== 'todas' && task.priority !== filters.priority) return false;
        if (filters.layer && filters.layer !== 'todas' && !task.elements.some((e) => e.layer === filters.layer)) return false;
        if (filters.resource && filters.resource !== 'todas' && !(task.resources || []).includes(filters.resource)) return false;
        if (text) {
            const names = filters.resourceNames
                ? (task.resources || []).map((id) => filters.resourceNames.get(id) || '')
                : [];
            const haystack = [task.title, task.description, task.assignee, ...names, ...task.elements.map((e) => e.layer)]
                .join(' ')
                .toLowerCase();
            if (!haystack.includes(text)) return false;
        }
        return true;
    });
}

export function summarize(tasks) {
    const counts = Object.fromEntries(STATUSES.map((s) => [s.id, 0]));
    let overdue = 0;
    for (const task of tasks) {
        counts[task.status] = (counts[task.status] || 0) + 1;
        if (isOverdue(task)) overdue++;
    }
    return { total: tasks.length, counts, overdue };
}

/* ------------------------------ exportacion ------------------------------ */

function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function round(value, decimals = 2) {
    if (!Number.isFinite(value) || value === 0) return '';
    const factor = 10 ** decimals;
    return String(Math.round(value * factor) / factor).replace('.', ',');
}

export function tasksToCsv(tasks, { shapesById = new Map(), resources = [], activities = [], metersPerUnit = 1 } = {}) {
    const names = new Map(resources.map((r) => [r.id, r.name]));
    const activityNames = new Map(activities.map((a) => [a.id, a.name]));
    const header = [
        'id', 'actividad', 'titulo', 'estado', 'prioridad', 'avance_%',
        'tramos', 'tramos_hechos', 'longitud', 'longitud_hecha', 'area', 'volumen_m3', 'volumen_hecho_m3',
        'rendimiento_por_dia', 'dias_con_avance', 'dias_restantes',
        'personal_y_maquinaria', 'responsable', 'vencimiento', 'capas', 'elementos',
        'x', 'y', 'descripcion', 'creada', 'actualizada'
    ];
    const rows = tasks.map((task) => {
        const anchor = taskAnchor(task) || { x: '', y: '' };
        const quantity = taskQuantity(task, shapesById, metersPerUnit);
        const rate = performance(task, shapesById, metersPerUnit);
        return [
            task.id,
            activityNames.get(task.activityId) || '',
            task.title,
            statusOf(task.status).label,
            priorityOf(task.priority).label,
            taskProgress(task),
            quantity.count || '',
            quantity.done.count || '',
            round(quantity.length),
            round(quantity.done.length),
            round(quantity.area),
            round(quantity.volume),
            round(quantity.done.volume),
            round(rate.perDay),
            rate.days || '',
            rate.daysLeft === null ? '' : rate.daysLeft,
            (task.resources || []).map((id) => names.get(id) || id).join(' | '),
            task.assignee,
            task.due,
            [...new Set(task.elements.map((e) => e.layer))].join(' | '),
            task.elements.map((e) => e.id).join(' | '),
            anchor.x,
            anchor.y,
            task.description,
            new Date(task.createdAt).toISOString(),
            new Date(task.updatedAt).toISOString()
        ].map(csvCell).join(';');
    });
    return '\ufeff' + [header.join(';'), ...rows].join('\r\n');
}

/** Detalle tramo a tramo, para revisar o cubicar fuera de la aplicacion. */
export function elementsToCsv(tasks, shapesById, metersPerUnit = 1, activities = []) {
    const activityNames = new Map(activities.map((a) => [a.id, a.name]));
    const header = ['actividad', 'tarea', 'tramo_id', 'tipo', 'capa', 'longitud', 'ancho_m', 'profundidad_m', 'volumen_m3', 'hecho', 'fecha'];
    const rows = [];
    for (const task of tasks) {
        for (const ref of task.elements) {
            const shape = shapesById.get(ref.id);
            const m = shape ? measure(shape) : null;
            const length = m ? m.length : 0;
            const width = Number(ref.width) || 0;
            const depth = Number(ref.depth) || 0;
            rows.push([
                activityNames.get(task.activityId) || '',
                task.title,
                ref.id,
                ref.kind,
                ref.layer,
                round(length),
                round(width),
                round(depth),
                width && depth ? round(length * metersPerUnit * width * depth) : '',
                ref.done ? 'Si' : 'No',
                ref.doneAt || ''
            ].map(csvCell).join(';'));
        }
    }
    return '\ufeff' + [header.join(';'), ...rows].join('\r\n');
}

export function projectToJson(project, tasks, { includeDxf = false, resources = [], places = [], activities = [] } = {}) {
    return JSON.stringify({
        formato: 'dxf-tareas',
        version: 2,
        exportado: new Date().toISOString(),
        proyecto: {
            id: project.id,
            nombre: project.name,
            archivo: project.fileName,
            unidades: project.units,
            capas: project.layers,
            ediciones: project.edits || [],
            creado: project.createdAt,
            actualizado: project.updatedAt,
            dxf: includeDxf ? project.dxfText : undefined
        },
        actividades: activities,
        recursos: resources,
        ubicaciones: places,
        tareas: tasks
    }, null, 2);
}

export function download(filename, content, type = 'text/plain;charset=utf-8') {
    const blob = content instanceof Blob ? content : new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
