/*
 * Programa maestro: calcula las fechas de cada actividad a partir de su
 * duracion y de sus antecesores, al modo de cualquier software de
 * planificacion (metodo de la ruta critica).
 *
 * Vinculos fin-inicio con desfase: una actividad empieza cuando terminan todas
 * sus antecesoras, mas los dias de desfase que se le indiquen. El desfase puede
 * ser negativo para solaparlas.
 */

import { isoToDate, addDays, daysBetween, todayISO } from './timeline.js';

/** Calendarios disponibles: que dias se trabaja. */
export const CALENDARS = [
    { id: 'todos', label: 'Todos los dias', works: () => true },
    { id: 'lun-sab', label: 'Lunes a sabado', works: (day) => day !== 0 },
    { id: 'lun-vie', label: 'Lunes a viernes', works: (day) => day !== 0 && day !== 6 }
];

export function calendarOf(id) {
    return CALENDARS.find((c) => c.id === id) || CALENDARS[0];
}

/** Primer dia laboral desde una fecha (incluida). */
export function nextWorkday(iso, calendar) {
    let date = iso;
    for (let guard = 0; guard < 14; guard++) {
        if (calendar.works(isoToDate(date).getDay())) return date;
        date = addDays(date, 1);
    }
    return date;
}

/**
 * Suma dias laborales. Con n = 0 devuelve el mismo dia; con n = 1, el
 * siguiente dia laboral.
 */
export function addWorkdays(iso, n, calendar) {
    let date = nextWorkday(iso, calendar);
    let left = n;
    while (left > 0) {
        date = nextWorkday(addDays(date, 1), calendar);
        left--;
    }
    return date;
}

/** Dias laborales entre dos fechas, contando ambas. */
export function workdaysBetween(fromIso, toIso, calendar) {
    if (toIso < fromIso) return 0;
    let count = 0;
    let date = fromIso;
    const total = daysBetween(fromIso, toIso);
    for (let i = 0; i <= total; i++) {
        if (calendar.works(isoToDate(date).getDay())) count++;
        date = addDays(date, 1);
    }
    return count;
}

/* --------------------------- orden y ciclos ----------------------------- */

/** Antecesores normalizados: acepta ids sueltos o {id, lag}. */
export function predecessorsOf(activity) {
    return (activity.predecessors || []).map((entry) =>
        typeof entry === 'string' ? { id: entry, lag: 0 } : { id: entry.id, lag: Number(entry.lag) || 0 }
    );
}

/**
 * Orden topologico. Devuelve tambien las actividades que quedaron en un ciclo,
 * que es el error tipico al encadenar mal un programa.
 */
export function topoOrder(activities) {
    const byId = new Map(activities.map((a) => [a.id, a]));
    const pending = new Map();
    const followers = new Map();

    for (const activity of activities) {
        const links = predecessorsOf(activity).filter((p) => byId.has(p.id) && p.id !== activity.id);
        pending.set(activity.id, links.length);
        for (const link of links) {
            if (!followers.has(link.id)) followers.set(link.id, []);
            followers.get(link.id).push(activity.id);
        }
    }

    const queue = activities.filter((a) => pending.get(a.id) === 0).map((a) => a.id);
    const order = [];
    while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const next of followers.get(id) || []) {
            pending.set(next, pending.get(next) - 1);
            if (pending.get(next) === 0) queue.push(next);
        }
    }

    const cycle = activities.filter((a) => !order.includes(a.id)).map((a) => a.id);
    return { order, cycle };
}

/* ------------------------------ el calculo ------------------------------- */

const DEFAULT_DURATION = 1;

function durationOf(activity) {
    const value = Number(activity.duration);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : DEFAULT_DURATION;
}

/**
 * Calcula el programa completo.
 *
 * @param {Array} activities actividades con duracion y antecesores
 * @param {Object} options {start: fecha de inicio del proyecto, calendar: id}
 * @returns {{plan: Map, cycle: Array, from: string, to: string}}
 *          plan: id -> {start, end, lateStart, lateEnd, float, critical, duration}
 */
export function computeSchedule(activities, { start, calendar = 'todos' } = {}) {
    const cal = calendarOf(calendar);
    const projectStart = nextWorkday(start || todayISO(), cal);
    const byId = new Map(activities.map((a) => [a.id, a]));
    const { order, cycle } = topoOrder(activities);
    const plan = new Map();

    // Ida: cada actividad empieza cuando han terminado todas sus antecesoras.
    for (const id of order) {
        const activity = byId.get(id);
        const duration = durationOf(activity);
        let begin = projectStart;

        for (const link of predecessorsOf(activity)) {
            const before = plan.get(link.id);
            if (!before) continue;
            // El dia siguiente al termino de la antecesora, mas el desfase.
            const candidate = addWorkdays(before.end, 1 + link.lag, cal);
            if (candidate > begin) begin = candidate;
        }
        if (activity.fixedStart && activity.fixedStart > begin) {
            begin = nextWorkday(activity.fixedStart, cal);
        }
        begin = nextWorkday(begin, cal);
        plan.set(id, {
            start: begin,
            end: addWorkdays(begin, duration - 1, cal),
            duration
        });
    }

    // Las actividades en ciclo no se pueden fechar: se marcan aparte.
    for (const id of cycle) {
        const activity = byId.get(id);
        plan.set(id, {
            start: projectStart,
            end: addWorkdays(projectStart, durationOf(activity) - 1, cal),
            duration: durationOf(activity),
            broken: true
        });
    }

    // Fin del proyecto: la ultima fecha de termino.
    let projectEnd = projectStart;
    for (const entry of plan.values()) if (entry.end > projectEnd) projectEnd = entry.end;

    // Vuelta: la fecha mas tardia en que cada actividad puede terminar sin
    // atrasar el proyecto. De ahi salen la holgura y la ruta critica.
    const followers = new Map();
    for (const activity of activities) {
        for (const link of predecessorsOf(activity)) {
            if (!byId.has(link.id)) continue;
            if (!followers.has(link.id)) followers.set(link.id, []);
            followers.get(link.id).push({ id: activity.id, lag: link.lag });
        }
    }

    for (const id of [...order].reverse()) {
        const entry = plan.get(id);
        if (!entry) continue;
        let lateEnd = projectEnd;
        for (const next of followers.get(id) || []) {
            const after = plan.get(next.id);
            if (!after || after.lateStart === undefined) continue;
            const limit = addWorkdays(after.lateStart, -(1 + next.lag), cal);
            if (limit < lateEnd) lateEnd = limit;
        }
        entry.lateEnd = lateEnd;
        entry.lateStart = addWorkdays(lateEnd, -(entry.duration - 1), cal);
        entry.float = workdaysBetween(entry.start, entry.lateStart, cal) - 1;
        entry.critical = entry.float <= 0;
    }

    for (const id of cycle) {
        const entry = plan.get(id);
        entry.lateStart = entry.start;
        entry.lateEnd = entry.end;
        entry.float = 0;
        entry.critical = false;
    }

    return { plan, cycle, from: projectStart, to: projectEnd };
}

/** Retrocede dias laborales (addWorkdays no admite negativos). */
function addWorkdaysBack(iso, n, calendar) {
    let date = iso;
    let left = n;
    while (left > 0) {
        date = addDays(date, -1);
        while (!calendar.works(isoToDate(date).getDay())) date = addDays(date, -1);
        left--;
    }
    return date;
}

/**
 * Fechas efectivas de una tarea: las suyas si las tiene, si no las de su
 * actividad segun el programa. Asi el cursor y la curva usan el plan real.
 */
export function taskDates(task, activityPlan) {
    if (task.start || task.due) return { start: task.start, due: task.due };
    const entry = task.activityId ? activityPlan.get(task.activityId) : null;
    return entry ? { start: entry.start, due: entry.end } : { start: '', due: '' };
}

/** Actividades cuyo antecesor todavia no termina, para avisar en terreno. */
export function unfinishedPredecessors(activity, activities, progressOf) {
    const byId = new Map(activities.map((a) => [a.id, a]));
    const pending = [];
    for (const link of predecessorsOf(activity)) {
        const before = byId.get(link.id);
        if (!before) continue;
        const pct = progressOf(before.id);
        if (pct < 99.9) pending.push({ activity: before, pct });
    }
    return pending;
}
