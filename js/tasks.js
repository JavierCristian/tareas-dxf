/*
 * Modelo de tareas asociadas a elementos del dibujo, filtros y exportacion.
 */

import { newId } from './db.js';

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
        anchor: null,   // {x, y} usado para el marcador en el plano
        createdAt: now,
        updatedAt: now,
        ...patch
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
        if (text) {
            const haystack = [task.title, task.description, task.assignee, ...task.elements.map((e) => e.layer)]
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

export function tasksToCsv(tasks) {
    const header = ['id', 'titulo', 'estado', 'prioridad', 'responsable', 'vencimiento', 'capas', 'elementos', 'x', 'y', 'descripcion', 'creada', 'actualizada'];
    const rows = tasks.map((task) => {
        const anchor = taskAnchor(task) || { x: '', y: '' };
        return [
            task.id,
            task.title,
            statusOf(task.status).label,
            priorityOf(task.priority).label,
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

export function projectToJson(project, tasks, { includeDxf = false } = {}) {
    return JSON.stringify({
        formato: 'dxf-tareas',
        version: 1,
        exportado: new Date().toISOString(),
        proyecto: {
            id: project.id,
            nombre: project.name,
            archivo: project.fileName,
            unidades: project.units,
            capas: project.layers,
            creado: project.createdAt,
            actualizado: project.updatedAt,
            dxf: includeDxf ? project.dxfText : undefined
        },
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
