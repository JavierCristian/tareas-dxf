/*
 * Parte diario de obra.
 *
 * Arma el informe de un dia con lo que la aplicacion ya sabe: que metros se
 * ejecutaron ese dia (las fechas de cada tramo ejecutado), que toca al dia
 * siguiente segun el programa, a que ritmo se viene avanzando de verdad y,
 * con ese ritmo, cuando terminaria la obra.
 *
 * Todo son funciones puras sobre el estado: no tocan la pantalla, para poder
 * comprobarlas fuera del navegador.
 */

import { measure } from './scene.js';
import { refSpans, refDoneLengthAt, taskProgress } from './tasks.js';
import { tasksOf, activityProgress } from './activities.js';
import {
    rateOf, rateUnitOf, crewsOf, ternasOf, PHASES_PER_TERNA,
    calendarOf, nextWorkday, addWorkdays, workdaysBetween
} from './schedule.js';
import { addDays, formatDate } from './timeline.js';
import { spendOf } from './resources.js';

/* --------------------------- cantidades del dia --------------------------- */

/** Metros de un tramo ejecutados exactamente en esa fecha. */
export function metersOnDate(ref, total, date) {
    let meters = 0;
    for (const span of refSpans(ref, total)) {
        if (span.date === date) meters += Math.max(0, span.to - span.from);
    }
    return meters;
}

/**
 * Cantidad de obra de un tramo en la unidad de su actividad, contando solo los
 * metros indicados. Sirve igual para lo ejecutado en un dia que para el total.
 */
function amountFor(task, activity, shapesById, metersPerUnit, lengthOf) {
    const unit = rateOf(activity).unit;
    let value = 0;
    for (const ref of task.elements || []) {
        const shape = shapesById.get(ref.id);
        if (!shape) continue;
        const m = measure(shape);
        if (!m) continue;
        const length = lengthOf(ref, m.length);
        if (!(length > 0)) continue;

        if (unit === 'm3') {
            const width = Number(ref.width);
            const depth = Number(ref.depth);
            if (width > 0 && depth > 0) value += length * metersPerUnit * width * depth;
        } else if (unit === 'ml') {
            value += length * metersPerUnit;
        } else if (unit === 'ml_fase') {
            value += length * metersPerUnit * ternasOf(task) * PHASES_PER_TERNA;
        } else if (unit === 'un') {
            // Por unidades solo cuenta el elemento terminado.
            if (length >= m.length - 1e-9) value += 1;
        }
    }
    return value;
}

/** Cantidad ejecutada por un tramo en una fecha concreta. */
export function amountOnDate(task, activity, shapesById, metersPerUnit, date) {
    return amountFor(task, activity, shapesById, metersPerUnit,
        (ref, total) => metersOnDate(ref, total, date));
}

/** Cantidad ejecutada por un tramo hasta una fecha, acumulada. */
export function amountUpTo(task, activity, shapesById, metersPerUnit, date) {
    return amountFor(task, activity, shapesById, metersPerUnit,
        (ref, total) => refDoneLengthAt(ref, total, date));
}

/** Cantidad total del tramo, este o no ejecutada. */
export function amountTotal(task, activity, shapesById, metersPerUnit) {
    return amountFor(task, activity, shapesById, metersPerUnit, (ref, total) => total);
}

/* ------------------------------ lo del dia ------------------------------- */

/** Tramos con avance registrado en esa fecha. */
export function executedOn(context, date) {
    const { activities, tasks, shapesById, metersPerUnit } = context;
    const rows = [];
    for (const task of tasks) {
        const activity = activities.find((a) => a.id === task.activityId) || null;
        if (!activity) continue;
        let meters = 0;
        for (const ref of task.elements || []) {
            const shape = shapesById.get(ref.id);
            const m = shape ? measure(shape) : null;
            if (m) meters += metersOnDate(ref, m.length, date);
        }
        if (meters <= 0) continue;
        rows.push({
            task,
            activity,
            meters: meters * metersPerUnit,
            amount: amountOnDate(task, activity, shapesById, metersPerUnit, date),
            unit: rateUnitOf(rateOf(activity).unit).unit,
            progress: taskProgress(task)
        });
    }
    return rows.sort((a, b) => a.activity.name.localeCompare(b.activity.name, 'es'));
}

/**
 * Tramos que el programa pone en ejecucion en una fecha. Se distingue el que
 * arranca ese dia del que viene corriendo, que es lo que se mira en terreno.
 */
export function scheduledOn(context, date) {
    const { activities, tasks, schedule } = context;
    const rows = [];
    for (const task of tasks) {
        const entry = schedule.tasks.get(task.id);
        if (!entry || !entry.start || entry.start > date || entry.end < date) continue;
        const activity = activities.find((a) => a.id === task.activityId) || null;
        rows.push({
            task,
            activity,
            entry,
            starts: entry.start === date,
            ends: entry.end === date,
            progress: taskProgress(task)
        });
    }
    return rows.sort((a, b) => (a.starts === b.starts ? 0 : (a.starts ? -1 : 1)));
}

/* -------------------------- rendimiento real ----------------------------- */

/**
 * Ritmo real de una actividad: lo ejecutado hasta la fecha repartido en los
 * dias en que hubo avance. Se compara con el rendimiento programado, que es el
 * de la actividad por sus frentes.
 */
export function realRate(context, activity, date) {
    const { tasks, shapesById, metersPerUnit } = context;
    const own = tasksOf(activity.id, tasks);
    const unit = rateUnitOf(rateOf(activity).unit);
    const days = new Set();
    let done = 0;
    let total = 0;

    for (const task of own) {
        total += amountTotal(task, activity, shapesById, metersPerUnit);
        done += amountUpTo(task, activity, shapesById, metersPerUnit, date);
        for (const ref of task.elements || []) {
            const shape = shapesById.get(ref.id);
            const m = shape ? measure(shape) : null;
            if (!m) continue;
            for (const span of refSpans(ref, m.length)) {
                if (span.date && span.date <= date) days.add(span.date);
            }
        }
    }

    const worked = days.size;
    const perDay = worked > 0 ? done / worked : 0;
    const planned = rateOf(activity).value * crewsOf(activity);
    return {
        activity,
        unit: unit.unit,
        days: worked,
        done,
        total,
        remaining: Math.max(0, total - done),
        perDay,
        planned,
        // Cuanto del ritmo programado se esta cumpliendo: 1 es ir a la par.
        ratio: planned > 0 && perDay > 0 ? perDay / planned : null,
        lastDay: [...days].sort().pop() || null
    };
}

/**
 * Fecha de termino proyectada de una actividad si sigue al ritmo real, y su
 * diferencia con la que dice el programa.
 */
export function forecastOf(context, activity, date) {
    const { schedule, calendar } = context;
    const rate = realRate(context, activity, date);
    const planned = schedule.activities.get(activity.id) || {};
    const cal = calendarOf(calendar);

    if (!rate.remaining) {
        return { ...rate, done: rate.done, finished: true, end: rate.lastDay, plannedEnd: planned.end || null, late: 0 };
    }
    if (!(rate.perDay > 0)) {
        return { ...rate, finished: false, end: null, plannedEnd: planned.end || null, late: null };
    }
    const daysLeft = Math.ceil(rate.remaining / rate.perDay);
    const end = addWorkdays(nextWorkday(addDays(date, 1), cal), daysLeft - 1, cal);
    const plannedEnd = planned.end || null;
    const late = plannedEnd
        ? (end > plannedEnd ? workdaysBetween(plannedEnd, end, cal) - 1 : -(workdaysBetween(end, plannedEnd, cal) - 1))
        : null;
    return { ...rate, finished: false, daysLeft, end, plannedEnd, late };
}

/* ------------------------------ el informe ------------------------------- */

/** Recursos que estuvieron en los tramos con avance ese dia. */
function resourcesOn(context, executed) {
    const { resources } = context;
    const byId = new Map(resources.map((r) => [r.id, r]));
    const used = new Map();
    for (const row of executed) {
        for (const id of row.task.resources || []) {
            const resource = byId.get(id);
            if (!resource) continue;
            if (!used.has(id)) used.set(id, { resource, tasks: [] });
            used.get(id).tasks.push(row.task);
        }
    }
    const rows = [...used.values()];
    const spend = spendOf(rows.map((r) => r.resource), 1);
    return { rows, spend };
}

/**
 * Parte diario completo.
 *
 * @param {Object} context {project, activities, tasks, resources, shapesById,
 *                          metersPerUnit, schedule, calendar}
 * @param {string} date fecha del informe (YYYY-MM-DD)
 */
export function dayReport(context, date) {
    const { project, activities, tasks, shapesById, metersPerUnit, schedule, calendar } = context;
    const cal = calendarOf(calendar);
    const next = nextWorkday(addDays(date, 1), cal);

    const executed = executedOn(context, date);
    const tomorrow = scheduledOn(context, next);
    const rates = activities
        .filter((activity) => tasksOf(activity.id, tasks).length)
        .map((activity) => forecastOf(context, activity, date));

    // Avance acumulado de la obra, ponderado por la longitud de cada tramo.
    let total = 0;
    let done = 0;
    for (const task of tasks) {
        for (const ref of task.elements || []) {
            const shape = shapesById.get(ref.id);
            const m = shape ? measure(shape) : null;
            if (!m || !m.length) continue;
            total += m.length;
            done += refDoneLengthAt(ref, m.length, date);
        }
    }

    // Termino proyectado de la obra: el mas tardio de sus actividades.
    let projected = null;
    for (const rate of rates) {
        if (rate.end && (!projected || rate.end > projected)) projected = rate.end;
    }
    const plannedEnd = schedule.to || null;
    const late = projected && plannedEnd
        ? (projected > plannedEnd ? workdaysBetween(plannedEnd, projected, cal) - 1
            : -(workdaysBetween(projected, plannedEnd, cal) - 1))
        : null;

    return {
        project,
        date,
        dateLabel: formatDate(date),
        nextDate: next,
        nextLabel: formatDate(next),
        executed,
        tomorrow,
        rates,
        resources: resourcesOn(context, executed),
        progress: {
            total: total * metersPerUnit,
            done: done * metersPerUnit,
            pct: total > 0 ? (done / total) * 100 : 0
        },
        activityProgress: activities.map((activity) => ({
            activity,
            ...activityProgress(activity.id, tasks, shapesById, metersPerUnit)
        })),
        forecast: { end: projected, plannedEnd, late },
        schedule
    };
}
