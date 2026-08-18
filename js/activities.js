/*
 * Actividades: el nivel de arriba de la obra (excavacion, tendido, tapado...).
 * Cada actividad agrupa sus tareas, que son los tramos en que se ejecuta.
 *
 * Aqui viven tambien los campos que usara el programa maestro (duracion y
 * antecesores); por ahora se guardan sin calcular fechas con ellos.
 */

import { newId } from './db.js';
import { taskQuantity, taskProgress, tracksElements } from './tasks.js';

/** Colores sugeridos, para distinguir actividades de un vistazo. */
export const ACTIVITY_COLORS = [
    '#38bdf8', '#f59e0b', '#a855f7', '#f472b6', '#14b8a6', '#facc15', '#fb7185', '#4ade80'
];

export function createActivity(projectId, patch = {}) {
    const now = Date.now();
    return {
        id: newId('act'),
        projectId,
        name: '',
        order: 0,
        color: ACTIVITY_COLORS[0],
        duration: null,      // dias (programa maestro)
        predecessors: [],    // ids de actividades previas (programa maestro)
        collapsed: false,
        createdAt: now,
        updatedAt: now,
        ...patch
    };
}

export function normalizeActivity(raw, projectId) {
    const base = createActivity(projectId);
    if (!raw || typeof raw !== 'object') return base;
    return {
        ...base,
        ...raw,
        id: raw.id || base.id,
        projectId,
        name: String(raw.name || '').slice(0, 120),
        predecessors: Array.isArray(raw.predecessors) ? raw.predecessors : []
    };
}

export function activityOf(task, activities) {
    return activities.find((activity) => activity.id === task.activityId) || null;
}

export function tasksOf(activityId, tasks) {
    return tasks.filter((task) => task.activityId === activityId);
}

/** Tareas que todavia no pertenecen a ninguna actividad. */
export function looseTasks(tasks, activities) {
    const known = new Set(activities.map((a) => a.id));
    return tasks.filter((task) => !task.activityId || !known.has(task.activityId));
}

/**
 * Avance de una actividad completa: se suman las cantidades de todas sus
 * tareas, de modo que un tramo largo pesa mas que uno corto.
 */
export function activityProgress(activityId, tasks, shapesById, metersPerUnit = 1) {
    const own = tasksOf(activityId, tasks);
    const total = { length: 0, volume: 0, count: 0 };
    const done = { length: 0, volume: 0, count: 0 };
    let simple = 0;

    for (const task of own) {
        const quantity = taskQuantity(task, shapesById, metersPerUnit);
        total.length += quantity.length;
        total.volume += quantity.volume;
        total.count += quantity.count;
        if (tracksElements(task)) {
            done.length += quantity.done.length;
            done.volume += quantity.done.volume;
            done.count += quantity.done.count;
        } else {
            const ratio = taskProgress(task) / 100;
            done.length += quantity.length * ratio;
            done.volume += quantity.volume * ratio;
        }
        simple += taskProgress(task) / 100;
    }

    const pct = total.length
        ? (done.length / total.length) * 100
        : (own.length ? (simple / own.length) * 100 : 0);

    return { tasks: own.length, total, done, pct };
}

/** Siguiente numero de tramo, para nombrar "Excavacion tramo 3" sin pensarlo. */
export function nextTaskName(activity, tasks) {
    const own = tasksOf(activity.id, tasks);
    const base = activity.name || 'Tarea';
    let highest = 0;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}\\s+tramo\\s+(\\d+)$`, 'i');
    for (const task of own) {
        const match = pattern.exec((task.title || '').trim());
        if (match) highest = Math.max(highest, Number(match[1]));
    }
    // Si ya hay tramos numerados se sigue la serie; si no, se cuenta desde las
    // tareas existentes para no repetir un numero.
    return `${base} tramo ${(highest || own.length) + 1}`;
}

/** Reordena las actividades tras mover una arriba o abajo. */
export function reorder(activities, id, delta) {
    const sorted = [...activities].sort((a, b) => (a.order || 0) - (b.order || 0));
    const index = sorted.findIndex((a) => a.id === id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= sorted.length) return null;
    const [moved] = sorted.splice(index, 1);
    sorted.splice(target, 0, moved);
    sorted.forEach((activity, i) => { activity.order = i; });
    return sorted;
}
