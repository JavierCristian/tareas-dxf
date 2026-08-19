/*
 * Programa maestro. Calcula las fechas de la obra al modo de cualquier software
 * de planificacion (ruta critica), pero con dos diferencias que vienen de como
 * se ejecuta realmente una obra lineal:
 *
 * 1. El calculo es POR TRAMO, no por actividad. Si la excavacion entre WTG18 y
 *    WTG12 termino, el tendido de ese trecho puede partir aunque el resto del
 *    parque siga excavandose. El enlace entre actividades ("el tendido va
 *    despues de la excavacion") se baja automaticamente a cada par de tramos
 *    que comparten los mismos elementos del plano.
 *
 * 2. La duracion no se escribe: sale del RENDIMIENTO de la actividad y de la
 *    cantidad de obra del tramo, que el plano ya conoce (m3 de excavacion,
 *    metros de tendido, metros de conductor, unidades).
 *
 * Ademas, cada actividad tiene un numero de FRENTES: cuantos tramos puede
 * atacar a la vez. Con dos retroexcavadoras solo avanzan dos tramos en
 * paralelo y el resto espera turno.
 */

import { isoToDate, addDays, daysBetween, todayISO } from './timeline.js';
import { taskQuantity } from './tasks.js';

/* --------------------------- dias de trabajo ----------------------------- */

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

/** Ultimo dia laboral hasta una fecha (incluida). */
export function prevWorkday(iso, calendar) {
    let date = iso;
    for (let guard = 0; guard < 14; guard++) {
        if (calendar.works(isoToDate(date).getDay())) return date;
        date = addDays(date, -1);
    }
    return date;
}

/**
 * Suma dias laborales. Con n = 0 devuelve el mismo dia; con n = 1, el
 * siguiente dia laboral. Con n negativo retrocede, que es lo que necesita la
 * vuelta del calculo (holguras y ruta critica).
 */
export function addWorkdays(iso, n, calendar) {
    if (n < 0) {
        let date = prevWorkday(iso, calendar);
        let left = -n;
        while (left > 0) {
            date = prevWorkday(addDays(date, -1), calendar);
            left--;
        }
        return date;
    }
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
    if (!fromIso || !toIso || toIso < fromIso) return 0;
    let count = 0;
    let date = fromIso;
    const total = daysBetween(fromIso, toIso);
    for (let i = 0; i <= total; i++) {
        if (calendar.works(isoToDate(date).getDay())) count++;
        date = addDays(date, 1);
    }
    return count;
}

/* ---------------------------- rendimientos ------------------------------- */

/** Fases de un circuito trifasico: R, S y T. */
export const PHASES_PER_TERNA = 3;

/**
 * Unidades en que se puede medir el rendimiento de una actividad. La cantidad
 * de cada tramo sale del plano, no se escribe a mano.
 */
export const RATE_UNITS = [
    {
        id: 'm3',
        label: 'm³ por dia',
        unit: 'm³',
        what: 'Excavaciones',
        hint: 'Largo del tramo por el ancho y la profundidad de su seccion.'
    },
    {
        id: 'ml',
        label: 'metros lineales por dia',
        unit: 'm',
        what: 'Tendidos simples, tapados, señalizacion',
        hint: 'El largo del tramo en el plano.'
    },
    {
        id: 'ml_fase',
        label: 'metros de conductor por dia',
        unit: 'm',
        what: 'Cable de potencia',
        hint: 'Largo por el numero de ternas del tramo y por 3 fases (R, S, T).'
    },
    {
        id: 'un',
        label: 'unidades por dia',
        unit: 'u',
        what: 'Camaras, fundaciones, postes',
        hint: 'Cuenta de elementos del tramo.'
    }
];

export function rateUnitOf(id) {
    return RATE_UNITS.find((u) => u.id === id) || RATE_UNITS[1];
}

/** Rendimiento de una actividad, normalizado. */
export function rateOf(activity) {
    const raw = (activity && activity.rate) || {};
    const value = Number(raw.value);
    return {
        unit: rateUnitOf(raw.unit).id,
        value: Number.isFinite(value) && value > 0 ? value : 0
    };
}

/** Frentes de trabajo: cuantos tramos de la actividad avanzan a la vez. */
export function crewsOf(activity) {
    const value = Number(activity && activity.crews);
    return Number.isFinite(value) && value >= 1 ? Math.round(value) : 1;
}

/** Ternas (o triadas) que lleva un tramo. Solo pesa en el cable de potencia. */
export function ternasOf(task) {
    const value = Number(task && task.ternas);
    return Number.isFinite(value) && value > 0 ? value : 1;
}

/**
 * Cantidad de obra de un tramo, en la unidad del rendimiento de su actividad.
 * @returns {{value:number, unit:string, label:string}}
 */
export function taskAmount(task, activity, shapesById, metersPerUnit = 1) {
    const unit = rateOf(activity).unit;
    const quantity = taskQuantity(task, shapesById, metersPerUnit);
    const meters = quantity.length * metersPerUnit;
    let value = 0;

    if (unit === 'm3') value = quantity.volume;
    else if (unit === 'ml') value = meters;
    else if (unit === 'ml_fase') value = meters * ternasOf(task) * PHASES_PER_TERNA;
    else if (unit === 'un') value = quantity.count;

    return { value, unit, label: rateUnitOf(unit).unit };
}

/**
 * Duracion de un tramo en dias trabajados. Manda la duracion escrita a mano si
 * la hay; si no, la cantidad dividida por el rendimiento. Nunca menos de un dia.
 */
export function taskDuration(task, activity, shapesById, metersPerUnit = 1) {
    const manual = Number(task && task.duration);
    if (Number.isFinite(manual) && manual > 0) {
        return { days: Math.round(manual), manual: true, amount: null };
    }
    const rate = rateOf(activity);
    const amount = taskAmount(task, activity, shapesById, metersPerUnit);
    if (rate.value > 0 && amount.value > 0) {
        return { days: Math.max(1, Math.ceil(amount.value / rate.value)), manual: false, amount };
    }
    // Sin rendimiento util queda la duracion de la actividad, y si no, un dia.
    const fallback = Number(activity && activity.duration);
    return {
        days: Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback) : 1,
        manual: false,
        amount,
        assumed: true
    };
}

/* ------------------------- antecesores por tramo -------------------------- */

/** Antecesores normalizados: acepta ids sueltos o {id, lag}. */
export function predecessorsOf(item) {
    return (item && item.predecessors || []).map((entry) =>
        typeof entry === 'string' ? { id: entry, lag: 0 } : { id: entry.id, lag: Number(entry.lag) || 0 }
    );
}

/**
 * Antecesores de un tramo deducidos de la geometria: los tramos de las
 * actividades antecesoras que pisan alguno de sus mismos elementos del plano.
 * Es lo que hace que "Tendido WTG18-WTG12" espere solo a "Excavacion
 * WTG18-WTG12" y no a todo el parque.
 */
export function autoPredecessors(task, activities, tasks) {
    const activity = activities.find((a) => a.id === task.activityId);
    if (!activity) return [];
    const mine = new Set((task.elements || []).map((ref) => ref.id));
    if (!mine.size) return [];

    const links = [];
    for (const before of predecessorsOf(activity)) {
        for (const other of tasks) {
            if (other.id === task.id || other.activityId !== before.id) continue;
            const shares = (other.elements || []).some((ref) => mine.has(ref.id));
            if (shares) links.push({ id: other.id, lag: before.lag, auto: true });
        }
    }
    return links;
}

/**
 * Antecesores efectivos de un tramo: los automaticos, salvo que el usuario haya
 * tomado el control de ese tramo (linksAuto === false), en cuyo caso manda su
 * propia lista.
 */
export function taskLinks(task, activities, tasks) {
    if (task.linksAuto === false) {
        return predecessorsOf(task).map((link) => ({ ...link, auto: false }));
    }
    return autoPredecessors(task, activities, tasks);
}

/** Actividades cuyo enlace no encontro ningun tramo vecino, para avisarlo. */
function orphanOf(task, activities, tasks) {
    if (task.linksAuto === false) return false;
    const activity = activities.find((a) => a.id === task.activityId);
    if (!activity) return false;
    const declared = predecessorsOf(activity).filter((link) =>
        tasks.some((other) => other.activityId === link.id));
    if (!declared.length) return false;
    return autoPredecessors(task, activities, tasks).length === 0;
}

/* ------------------------------ orden y ciclos ---------------------------- */

/**
 * Orden topologico sobre cualquier grafo {id, links}. Devuelve tambien los
 * nodos que quedaron en un ciclo, que es el error tipico al encadenar mal.
 */
export function topoOrder(nodes, linksOf) {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pending = new Map();
    const followers = new Map();

    for (const node of nodes) {
        const links = linksOf(node).filter((l) => byId.has(l.id) && l.id !== node.id);
        pending.set(node.id, links.length);
        for (const link of links) {
            if (!followers.has(link.id)) followers.set(link.id, []);
            followers.get(link.id).push(node.id);
        }
    }

    const queue = nodes.filter((n) => pending.get(n.id) === 0).map((n) => n.id);
    const order = [];
    while (queue.length) {
        const id = queue.shift();
        order.push(id);
        for (const next of followers.get(id) || []) {
            pending.set(next, pending.get(next) - 1);
            if (pending.get(next) === 0) queue.push(next);
        }
    }

    const seen = new Set(order);
    return { order, cycle: nodes.filter((n) => !seen.has(n.id)).map((n) => n.id) };
}

/* -------------------------------- el calculo ------------------------------ */

/**
 * Calcula el programa completo, tramo a tramo.
 *
 * @param {Array} activities
 * @param {Array} tasks
 * @param {Object} options {start, calendar, shapesById, metersPerUnit}
 * @returns {{tasks: Map, activities: Map, cycle: Array, from, to, orphans: Array}}
 */
export function computeSchedule(activities, tasks, options = {}) {
    const { start, calendar = 'todos', shapesById = new Map(), metersPerUnit = 1 } = options;
    const cal = calendarOf(calendar);
    const projectStart = nextWorkday(start || todayISO(), cal);
    const activityById = new Map(activities.map((a) => [a.id, a]));

    // Solo entran al programa los tramos que pertenecen a una actividad: son
    // los unicos con rendimiento y con quien encadenarse.
    const nodes = tasks.filter((task) => activityById.has(task.activityId));
    const linkCache = new Map();
    const linksOf = (task) => {
        if (!linkCache.has(task.id)) linkCache.set(task.id, taskLinks(task, activities, tasks));
        return linkCache.get(task.id);
    };

    const { order, cycle } = topoOrder(nodes, linksOf);
    const nodeById = new Map(nodes.map((t) => [t.id, t]));
    const cycleSet = new Set(cycle);
    const plan = new Map();
    const orphans = [];

    for (const task of nodes) {
        const activity = activityById.get(task.activityId);
        const duration = taskDuration(task, activity, shapesById, metersPerUnit);
        plan.set(task.id, {
            activityId: task.activityId,
            duration: duration.days,
            manual: duration.manual,
            assumed: !!duration.assumed,
            amount: duration.amount,
            links: linksOf(task),
            broken: cycleSet.has(task.id)
        });
        if (orphanOf(task, activities, tasks)) orphans.push(task.id);
    }

    /*
     * Reparto por frentes. Cada actividad ataca tantos tramos a la vez como
     * frentes tenga; el resto espera turno. En cada vuelta se atiende al tramo
     * que YA puede partir antes, con las fechas reales de sus antecesores, no
     * con las teoricas: si la excavacion de un trecho termino primero, es ese
     * trecho el que se lleva la cuadrilla de tendido.
     */
    const rank = new Map(order.map((id, i) => [id, i]));
    const crewsByActivity = new Map();
    const remaining = new Set(order);

    /** Fecha en que el tramo podria partir segun sus antecesores ya fechados. */
    const readyDate = (task) => {
        let begin = projectStart;
        for (const link of plan.get(task.id).links) {
            const before = plan.get(link.id);
            if (!before || !before.end) continue;
            const candidate = addWorkdays(before.end, 1 + link.lag, cal);
            if (candidate > begin) begin = candidate;
        }
        if (task.start && task.start > begin) begin = task.start;
        return nextWorkday(begin, cal);
    };

    while (remaining.size) {
        let chosen = null;
        let chosenDate = null;
        for (const id of remaining) {
            // Todavia le falta algun antecesor por programar.
            if (plan.get(id).links.some((link) => remaining.has(link.id))) continue;
            const when = readyDate(nodeById.get(id));
            if (!chosen || when < chosenDate || (when === chosenDate && rank.get(id) < rank.get(chosen))) {
                chosen = id;
                chosenDate = when;
            }
        }
        if (!chosen) break;   // no deberia ocurrir: los ciclos ya salieron aparte

        const task = nodeById.get(chosen);
        const entry = plan.get(chosen);
        const activity = activityById.get(task.activityId);
        if (!crewsByActivity.has(activity.id)) {
            crewsByActivity.set(activity.id, new Array(crewsOf(activity)).fill(null));
        }
        // El frente que se desocupa antes toma el tramo.
        const crews = crewsByActivity.get(activity.id);
        let pick = 0;
        for (let i = 1; i < crews.length; i++) {
            if ((crews[i] || '') < (crews[pick] || '')) pick = i;
        }
        const free = crews[pick];
        const begin = free && free > chosenDate ? free : chosenDate;

        entry.start = nextWorkday(begin, cal);
        entry.end = addWorkdays(entry.start, entry.duration - 1, cal);
        entry.crew = pick + 1;
        entry.crews = crews.length;
        crews[pick] = addWorkdays(entry.end, 1, cal);
        remaining.delete(chosen);
    }

    // Los tramos en ciclo no se pueden fechar: se dejan al inicio, marcados.
    for (const id of cycle) {
        const entry = plan.get(id);
        entry.start = projectStart;
        entry.end = addWorkdays(projectStart, entry.duration - 1, cal);
        entry.crew = 1;
    }

    let projectEnd = projectStart;
    for (const entry of plan.values()) if (entry.end && entry.end > projectEnd) projectEnd = entry.end;

    /* Vuelta: la fecha mas tardia en que cada tramo puede terminar sin atrasar
       la obra. Se cuentan tanto los enlaces declarados como los que impone el
       frente (el tramo que va detras en la misma cuadrilla). */
    const followers = new Map();
    const addFollower = (fromId, toId, lag) => {
        if (!plan.has(fromId) || !plan.has(toId)) return;
        if (!followers.has(fromId)) followers.set(fromId, []);
        followers.get(fromId).push({ id: toId, lag });
    };
    for (const [id, entry] of plan) {
        for (const link of entry.links) addFollower(link.id, id, link.lag);
    }
    // Enlaces de frente: dentro de una actividad, el orden en que quedo cada
    // cuadrilla tambien encadena los tramos.
    const byCrew = new Map();
    for (const [id, entry] of plan) {
        const key = `${entry.activityId}#${entry.crew}`;
        if (!byCrew.has(key)) byCrew.set(key, []);
        byCrew.get(key).push(id);
    }
    for (const ids of byCrew.values()) {
        ids.sort((a, b) => (plan.get(a).start < plan.get(b).start ? -1 : 1));
        for (let i = 1; i < ids.length; i++) addFollower(ids[i - 1], ids[i], 0);
    }

    const backward = [...plan.keys()].sort((a, b) => (plan.get(a).end < plan.get(b).end ? 1 : -1));
    for (const id of backward) {
        const entry = plan.get(id);
        let lateEnd = projectEnd;
        for (const next of followers.get(id) || []) {
            const after = plan.get(next.id);
            if (!after || after.lateStart === undefined) continue;
            const limit = addWorkdays(after.lateStart, -(1 + next.lag), cal);
            if (limit < lateEnd) lateEnd = limit;
        }
        entry.lateEnd = lateEnd;
        entry.lateStart = addWorkdays(lateEnd, -(entry.duration - 1), cal);
        entry.float = Math.max(0, workdaysBetween(entry.start, entry.lateStart, cal) - 1);
        entry.critical = entry.float <= 0 && !entry.broken;
    }

    /* Resumen por actividad: de la primera fecha de sus tramos a la ultima. */
    const byActivity = new Map();
    for (const activity of activities) {
        const own = nodes.filter((task) => task.activityId === activity.id);
        const entries = own.map((task) => plan.get(task.id)).filter(Boolean);
        if (!entries.length) {
            byActivity.set(activity.id, { tasks: 0, empty: true, crews: crewsOf(activity) });
            continue;
        }
        let first = entries[0].start;
        let last = entries[0].end;
        let float = Infinity;
        let critical = false;
        let amount = 0;
        for (const entry of entries) {
            if (entry.start < first) first = entry.start;
            if (entry.end > last) last = entry.end;
            float = Math.min(float, entry.float === undefined ? 0 : entry.float);
            if (entry.critical) critical = true;
            if (entry.amount) amount += entry.amount.value;
        }
        byActivity.set(activity.id, {
            tasks: entries.length,
            start: first,
            end: last,
            days: workdaysBetween(first, last, cal),
            float: float === Infinity ? 0 : float,
            critical,
            amount,
            unit: rateUnitOf(rateOf(activity).unit).unit,
            crews: crewsOf(activity),
            broken: entries.some((e) => e.broken)
        });
    }

    return {
        tasks: plan,
        activities: byActivity,
        cycle,
        orphans,
        from: projectStart,
        to: projectEnd
    };
}

/**
 * Fechas efectivas de un tramo: las suyas si las escribio el usuario, si no las
 * que le toca por programa. Asi el cursor y la curva usan el plan real.
 */
export function taskDates(task, schedule) {
    if (task.start && task.due) return { start: task.start, due: task.due };
    const entry = schedule && schedule.tasks ? schedule.tasks.get(task.id) : null;
    if (!entry || !entry.start) return { start: task.start || '', due: task.due || '' };
    return { start: task.start || entry.start, due: task.due || entry.end };
}

/**
 * Tramos antecesores que todavia no terminan, para avisar en terreno cuando se
 * registra avance antes de tiempo. Es un aviso, no un impedimento.
 */
export function unfinishedPredecessors(task, activities, tasks, progressOf) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const pending = [];
    for (const link of taskLinks(task, activities, tasks)) {
        const before = byId.get(link.id);
        if (!before) continue;
        const pct = progressOf(before);
        if (pct < 99.9) pending.push({ task: before, pct });
    }
    return pending;
}
