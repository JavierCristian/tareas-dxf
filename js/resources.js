/*
 * Recursos de obra: personal y maquinaria asignables a las tareas.
 */

import { newId } from './db.js';

export const RESOURCE_TYPES = [
    { id: 'persona', label: 'Personal', plural: 'Personal', icon: '👷', color: '#38bdf8' },
    { id: 'maquina', label: 'Maquinaria', plural: 'Maquinaria', icon: '🚜', color: '#f59e0b' }
];

/** Etiquetas del campo "cargo" segun el tipo, solo para orientar al usuario. */
export const ROLE_HINTS = {
    persona: 'Ej: maestro albanil, jefe de terreno, ayudante',
    maquina: 'Ej: retroexcavadora CAT 320, camion tolva'
};

export const CODE_HINTS = {
    persona: 'RUT o numero interno',
    maquina: 'Patente o numero de equipo'
};

export function typeOf(id) {
    return RESOURCE_TYPES.find((t) => t.id === id) || RESOURCE_TYPES[0];
}

export function createResource(projectId, patch = {}) {
    const now = Date.now();
    return {
        id: newId('rec'),
        projectId,
        type: 'persona',
        name: '',
        role: '',      // cargo o modelo
        code: '',      // RUT, patente o numero interno
        group: '',     // cuadrilla, empresa o subcontrato
        phone: '',
        active: true,
        notes: '',
        createdAt: now,
        updatedAt: now,
        ...patch
    };
}

/** Normaliza un recurso venido de una copia .json de otra version. */
export function normalizeResource(raw, projectId) {
    const base = createResource(projectId);
    if (!raw || typeof raw !== 'object') return base;
    return {
        ...base,
        ...raw,
        id: raw.id || base.id,
        projectId,
        type: typeOf(raw.type).id,
        name: String(raw.name || '').slice(0, 120),
        active: raw.active !== false
    };
}

export function resourceLabel(resource) {
    if (!resource) return '';
    return resource.role ? `${resource.name} · ${resource.role}` : resource.name;
}

/** Tareas de cada recurso, separando las que siguen abiertas. */
export function workload(resources, tasks) {
    const byId = new Map(resources.map((r) => [r.id, { resource: r, total: 0, open: 0, tasks: [] }]));
    for (const task of tasks) {
        for (const id of task.resources || []) {
            const entry = byId.get(id);
            if (!entry) continue;
            entry.total++;
            entry.tasks.push(task);
            if (task.status !== 'completada') entry.open++;
        }
    }
    return byId;
}

/** Recursos citados por una tarea que ya no existen en el proyecto. */
export function missingResources(task, resources) {
    const known = new Set(resources.map((r) => r.id));
    return (task.resources || []).filter((id) => !known.has(id));
}

function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function resourcesToCsv(resources, tasks) {
    const load = workload(resources, tasks);
    const header = ['id', 'tipo', 'nombre', 'cargo', 'identificador', 'cuadrilla', 'telefono', 'estado', 'tareas', 'tareas_abiertas', 'notas'];
    const rows = resources.map((resource) => {
        const entry = load.get(resource.id) || { total: 0, open: 0 };
        return [
            resource.id,
            typeOf(resource.type).label,
            resource.name,
            resource.role,
            resource.code,
            resource.group,
            resource.phone,
            resource.active ? 'Activo' : 'Inactivo',
            entry.total,
            entry.open,
            resource.notes
        ].map(csvCell).join(';');
    });
    return '﻿' + [header.join(';'), ...rows].join('\r\n');
}
