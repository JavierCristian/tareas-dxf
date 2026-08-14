/*
 * Linea de tiempo: reconstruye el estado de la obra en una fecha cualquiera.
 *
 * No guarda nada nuevo. El historial sale de las fechas que ya se registran:
 * la fecha en que se marco cada tramo, el inicio y termino planificado de cada
 * tarea, y el periodo de cada punto de recursos.
 */

import { measure } from './scene.js';
import { taskQuantity, taskProgress, tracksElements } from './tasks.js';

export const DAY = 86400000;

export function todayISO() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function isoToDate(iso) {
    return new Date(`${iso}T00:00:00`);
}

export function addDays(iso, days) {
    const date = isoToDate(iso);
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
}

export function daysBetween(fromIso, toIso) {
    return Math.round((isoToDate(toIso) - isoToDate(fromIso)) / DAY);
}

export function formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
}

/**
 * Ventana de tiempo del proyecto: abarca lo ejecutado, lo planificado y hoy.
 * @returns {{from:string, to:string, days:number}|null}
 */
export function projectRange(tasks, places) {
    const dates = [];
    for (const task of tasks) {
        if (task.start) dates.push(task.start);
        if (task.due) dates.push(task.due);
        for (const ref of task.elements || []) {
            if (ref.doneAt) dates.push(ref.doneAt);
        }
    }
    for (const place of places || []) {
        if (place.from) dates.push(place.from);
        if (place.to) dates.push(place.to);
    }
    if (!dates.length) return null;

    dates.push(todayISO());
    dates.sort();
    const from = dates[0];
    const to = dates[dates.length - 1];
    return { from, to, days: Math.max(0, daysBetween(from, to)) };
}

/* ------------------------------ por tarea ------------------------------- */

/**
 * Avance planificado a una fecha, repartido linealmente entre inicio y termino.
 * Sin fechas planificadas devuelve null: no hay contra que comparar.
 */
export function plannedRatio(task, date) {
    if (!task.start || !task.due) return null;
    if (date < task.start) return 0;
    if (date >= task.due) return 1;
    const total = daysBetween(task.start, task.due);
    if (total <= 0) return 1;
    return Math.max(0, Math.min(1, daysBetween(task.start, date) / total));
}

/**
 * Estado de una tarea en una fecha: que tramos estaban ejecutados, cuanto
 * representaban y como iba frente al plan.
 */
export function taskStateAt(task, shapesById, date, metersPerUnit = 1) {
    const total = { length: 0, area: 0, volume: 0, count: 0 };
    const done = { length: 0, area: 0, volume: 0, count: 0 };
    const doneIds = new Set();

    for (const ref of task.elements || []) {
        const shape = shapesById.get(ref.id);
        if (!shape) continue;
        const m = measure(shape);
        total.count++;
        const executed = !!ref.done && !!ref.doneAt && ref.doneAt <= date;
        if (executed) {
            done.count++;
            doneIds.add(ref.id);
        }
        if (!m) continue;

        const isArea = shape.closed && m.area;
        if (isArea) {
            total.area += m.area;
            if (executed) done.area += m.area;
        } else {
            total.length += m.length;
            if (executed) done.length += m.length;
        }
        const width = Number(ref.width);
        const depth = Number(ref.depth);
        if (width > 0 && depth > 0) {
            const volume = m.length * metersPerUnit * width * depth;
            total.volume += volume;
            if (executed) done.volume += volume;
        }
    }

    let real;
    if (tracksElements(task) && total.count) {
        if (total.length > 0) real = done.length / total.length;
        else if (total.area > 0) real = done.area / total.area;
        else real = done.count / total.count;
    } else {
        // Sin tramos marcados no hay historial: solo se conoce el estado actual.
        real = date >= todayISO() ? taskProgress(task) / 100 : null;
    }

    const planned = plannedRatio(task, date);
    return {
        total,
        done,
        doneIds,
        real,
        planned,
        // Atrasada: el plan pide mas de lo que hay ejecutado a esa fecha.
        late: planned !== null && real !== null && planned - real > 0.001,
        started: !!task.start && date >= task.start,
        shouldBeDone: !!task.due && date >= task.due
    };
}

/** Estado del proyecto completo en una fecha. */
export function projectStateAt(tasks, shapesById, date, metersPerUnit = 1) {
    const total = { length: 0, volume: 0, count: 0 };
    const done = { length: 0, volume: 0, count: 0 };
    let plannedLength = 0;
    let lateTasks = 0;
    const perTask = new Map();

    for (const task of tasks) {
        const state = taskStateAt(task, shapesById, date, metersPerUnit);
        perTask.set(task.id, state);
        total.length += state.total.length;
        total.volume += state.total.volume;
        total.count += state.total.count;
        done.length += state.done.length;
        done.volume += state.done.volume;
        done.count += state.done.count;
        if (state.planned !== null) plannedLength += state.total.length * state.planned;
        if (state.late) lateTasks++;
    }

    return {
        date,
        total,
        done,
        perTask,
        lateTasks,
        realPct: total.length ? (done.length / total.length) * 100 : null,
        plannedPct: total.length ? (plannedLength / total.length) * 100 : null
    };
}

/* ------------------------------- la curva -------------------------------- */

/**
 * Serie de avance acumulado, real y planificado, a lo largo de la ventana.
 * Se muestrea en pasos para que la curva sea barata de dibujar en un movil.
 */
export function progressCurve(tasks, shapesById, range, metersPerUnit = 1, maxPoints = 120) {
    if (!range) return [];
    const step = Math.max(1, Math.ceil((range.days + 1) / maxPoints));
    const points = [];
    for (let day = 0; day <= range.days; day += step) {
        const date = addDays(range.from, day);
        const state = projectStateAt(tasks, shapesById, date, metersPerUnit);
        points.push({
            date,
            real: state.realPct === null ? 0 : state.realPct,
            planned: state.plannedPct === null ? null : state.plannedPct
        });
    }
    const last = addDays(range.from, range.days);
    if (!points.length || points[points.length - 1].date !== last) {
        const state = projectStateAt(tasks, shapesById, last, metersPerUnit);
        points.push({
            date: last,
            real: state.realPct === null ? 0 : state.realPct,
            planned: state.plannedPct === null ? null : state.plannedPct
        });
    }
    return points;
}
