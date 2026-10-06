/*
 * Actividades: el nivel de arriba de la obra (excavacion, tendido, tapado...).
 * Cada actividad agrupa sus tareas, que son los tramos en que se ejecuta.
 *
 * Aqui viven tambien los campos del programa maestro: el rendimiento con que
 * se calculan los dias de cada tramo, los frentes de trabajo y las actividades
 * antecesoras.
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
        rate: { unit: 'ml', value: 0 },  // rendimiento: cuanto se avanza por dia
        crews: 1,            // frentes: cuantos tramos se atacan a la vez
        duration: null,      // dias por tramo si no hay rendimiento (compatibilidad)
        predecessors: [],    // ids de actividades previas (programa maestro)
        linksAuto: true,     // false = sus antecesoras las maneja el usuario
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
        rate: raw.rate && typeof raw.rate === 'object' ? { ...base.rate, ...raw.rate } : base.rate,
        crews: Number(raw.crews) >= 1 ? Math.round(Number(raw.crews)) : 1,
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
    return moveTo(sorted, index, index + delta);
}

/** Lleva una actividad a una posicion concreta de la lista (arrastre). */
export function reorderTo(activities, id, target) {
    const sorted = [...activities].sort((a, b) => (a.order || 0) - (b.order || 0));
    return moveTo(sorted, sorted.findIndex((a) => a.id === id), target);
}

function moveTo(sorted, index, target) {
    if (index < 0 || target < 0 || target >= sorted.length || index === target) return null;
    const [moved] = sorted.splice(index, 1);
    sorted.splice(target, 0, moved);
    sorted.forEach((activity, i) => { activity.order = i; });
    return sorted;
}

/** Desfase que ya tenia declarado con esa antecesora, para no perderlo. */
function lagOf(activity, id) {
    const found = (activity.predecessors || []).find((p) => (typeof p === 'string' ? p : p.id) === id);
    return found && typeof found !== 'string' ? Number(found.lag) || 0 : 0;
}

/**
 * Reescribe la secuencia del programa siguiendo el orden de la lista: cada
 * actividad espera a la que tiene justo encima. Es lo que hace que mover una
 * actividad cambie la obra de verdad y no solo la fila que se ve.
 *
 * Las actividades que el usuario enlazo a mano (linksAuto === false) conservan
 * sus antecesoras. Asi una cadena paralela —los cruces, que se hacen junto a la
 * zanja y no la esperan— sobrevive a cualquier reordenamiento.
 */
export function relinkChain(activities) {
    const sorted = [...activities].sort((a, b) => (a.order || 0) - (b.order || 0));
    const now = Date.now();
    sorted.forEach((activity, index) => {
        if (activity.linksAuto === false) return;
        const before = sorted[index - 1];
        activity.predecessors = before ? [{ id: before.id, lag: lagOf(activity, before.id) }] : [];
        activity.updatedAt = now;
    });
    return sorted;
}
