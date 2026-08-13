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
export function taskQuantity(task, shapesById) {
    let length = 0;
    let area = 0;
    for (const ref of task.elements) {
        const shape = shapesById.get(ref.id);
        if (!shape) continue;
        const m = measure(shape);
        if (!m) continue;
        if (shape.closed && m.area) area += m.area;
        else length += m.length;
    }
    return { length, area };
}

/**
 * Avance del conjunto, ponderado por la cantidad de cada tarea.
 * Es lo que hace util dividir un elemento: cada trozo aporta su longitud real.
 */
export function progressSummary(tasks, shapesById) {
    let lengthTotal = 0;
    let lengthDone = 0;
    let areaTotal = 0;
    let areaDone = 0;
    let simple = 0;
    for (const task of tasks) {
        const quantity = taskQuantity(task, shapesById);
        const ratio = taskProgress(task) / 100;
        lengthTotal += quantity.length;
        lengthDone += quantity.length * ratio;
        areaTotal += quantity.area;
        areaDone += quantity.area * ratio;
        simple += ratio;
    }
    return {
        length: { total: lengthTotal, done: lengthDone, pct: lengthTotal ? (lengthDone / lengthTotal) * 100 : null },
        area: { total: areaTotal, done: areaDone, pct: areaTotal ? (areaDone / areaTotal) * 100 : null },
        tasks: { count: tasks.length, pct: tasks.length ? (simple / tasks.length) * 100 : 0 }
    };
}

export function elementRef(shape, anchor) {
    return {
        id: shape.id,
        kind: shape.kind,
        layer: shape.layer,
        x: anchor ? anchor.x : shape.pts[0],
        y: anchor ? anchor.y : shape.pts[1]
    };
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

export function tasksToCsv(tasks, { shapesById = new Map(), resources = [] } = {}) {
    const names = new Map(resources.map((r) => [r.id, r.name]));
    const header = [
        'id', 'titulo', 'estado', 'prioridad', 'avance_%', 'longitud', 'area',
        'personal_y_maquinaria', 'responsable', 'vencimiento', 'capas', 'elementos',
        'x', 'y', 'descripcion', 'creada', 'actualizada'
    ];
    const rows = tasks.map((task) => {
        const anchor = taskAnchor(task) || { x: '', y: '' };
        const quantity = taskQuantity(task, shapesById);
        return [
            task.id,
            task.title,
            statusOf(task.status).label,
            priorityOf(task.priority).label,
            taskProgress(task),
            round(quantity.length),
            round(quantity.area),
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
    return '﻿' + [header.join(';'), ...rows].join('\r\n');
}

export function projectToJson(project, tasks, { includeDxf = false, resources = [] } = {}) {
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
