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
        due: '',
        elements: [],   // [{id, kind, layer, x, y}]
        resources: [],  // ids de personal y maquinaria asignados
        progress: 0,    // avance declarado 0-100
        anchor: null,   // {x, y} usado para el marcador en el plano
        createdAt: now,
        updatedAt: now,
        ...patch
    };
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
        const isDone = !!ref.done;
        total.count++;
        if (isDone) done.count++;
        if (!m) continue;

        if (shape.closed && m.area) {
            total.area += m.area;
            if (isDone) done.area += m.area;
        } else {
            total.length += m.length;
            if (isDone) done.length += m.length;
        }
        // El volumen solo existe si el tramo tiene seccion definida.
        const width = Number(ref.width);
        const depth = Number(ref.depth);
        if (width > 0 && depth > 0) {
            const volume = m.length * metersPerUnit * width * depth;
            total.volume += volume;
            if (isDone) done.volume += volume;
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
        done: false,     // tramo ejecutado
        doneAt: null,    // fecha (YYYY-MM-DD) en que se marco
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

export function tasksToCsv(tasks, { shapesById = new Map(), resources = [], metersPerUnit = 1 } = {}) {
    const names = new Map(resources.map((r) => [r.id, r.name]));
    const header = [
        'id', 'titulo', 'estado', 'prioridad', 'avance_%',
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
export function elementsToCsv(tasks, shapesById, metersPerUnit = 1) {
    const header = ['tarea', 'tramo_id', 'tipo', 'capa', 'longitud', 'ancho_m', 'profundidad_m', 'volumen_m3', 'hecho', 'fecha'];
    const rows = [];
    for (const task of tasks) {
        for (const ref of task.elements) {
            const shape = shapesById.get(ref.id);
            const m = shape ? measure(shape) : null;
            const length = m ? m.length : 0;
            const width = Number(ref.width) || 0;
            const depth = Number(ref.depth) || 0;
            rows.push([
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

export function projectToJson(project, tasks, { includeDxf = false, resources = [], places = [] } = {}) {
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
