/*
 * Asistencia diaria: quien estuvo, cuantas horas, y que maquina quedo parada.
 *
 * Es lo que en el informe a mandante ocupa dos paginas —la lista de personal
 * con su puesto y la de horas con su acumulado— y hoy se escribe a mano dos
 * veces, con el riesgo de que no coincidan.
 *
 * El modelo es deliberadamente simple: un registro por persona o maquina y por
 * dia. Las horas acumuladas no se guardan, se suman: un acumulado guardado se
 * desincroniza en cuanto se corrige un dia anterior, y corregir un dia anterior
 * es lo normal.
 *
 * Las tarifas no viven aqui. El puesto tiene un valor asociado pero eso es del
 * modulo de costos, que es aparte y no viaja a los dispositivos de terreno.
 */

import { newId } from './db.js';
import { hoursPerDayOf } from './resources.js';

/** En que estado estuvo alguien ese dia. Solo "turno" suma horas. */
export const ATTENDANCE = [
    { id: 'turno', label: 'En turno', hours: true, color: '#22c55e' },
    { id: 'libre', label: 'Descanso', hours: false, color: '#64748b' },
    { id: 'ausente', label: 'Ausente', hours: false, color: '#ef4444' },
    { id: 'licencia', label: 'Licencia', hours: false, color: '#f59e0b' },
    { id: 'traslado', label: 'En traslado', hours: false, color: '#38bdf8' }
];

/** Y en que estado estuvo una maquina. */
export const MACHINE_STATES = [
    { id: 'operativa', label: 'Operativa', ok: true, color: '#22c55e' },
    { id: 'no_usada', label: 'No usada', ok: false, color: '#64748b' },
    { id: 'falla', label: 'Falla mecanica', ok: false, color: '#ef4444' },
    { id: 'mantencion', label: 'En mantencion', ok: false, color: '#f59e0b' },
    { id: 'desmovilizada', label: 'Desmovilizada', ok: false, color: '#475569' }
];

export function attendanceOf(id) {
    return ATTENDANCE.find((s) => s.id === id) || ATTENDANCE[0];
}

export function machineStateOf(id) {
    return MACHINE_STATES.find((s) => s.id === id) || MACHINE_STATES[0];
}

export function createEntry(projectId, patch = {}) {
    const now = Date.now();
    return {
        id: newId('asis'),
        projectId,
        resourceId: '',
        date: '',          // YYYY-MM-DD
        status: 'turno',   // de ATTENDANCE o de MACHINE_STATES segun el tipo
        hours: 0,          // horas trabajadas ese dia; 0 en maquinaria
        note: '',          // la "observacion" del informe
        by: '',            // quien paso la lista
        createdAt: now,
        updatedAt: now,
        ...patch
    };
}

/* --------------------------- la lista del dia ----------------------------- */

/**
 * La hoja de un dia: cada recurso activo con lo que ya se registro, o con su
 * jornada estandar propuesta si todavia no se pasa lista.
 *
 * Se propone en vez de dejar en blanco porque lo normal es que todos esten:
 * pasar lista es marcar las excepciones, no escribir veintidos veces el mismo
 * numero.
 */
export function sheetFor(resources, entries, date) {
    const byResource = new Map();
    for (const entry of entries) {
        if (entry.date === date) byResource.set(entry.resourceId, entry);
    }
    return resources
        .filter((resource) => resource.active !== false && onSite(resource, date))
        .map((resource) => {
            const entry = byResource.get(resource.id) || null;
            const machine = resource.type !== 'persona';
            return {
                resource,
                entry,
                saved: !!entry,
                status: entry ? entry.status : (machine ? 'operativa' : 'turno'),
                hours: entry ? entry.hours : (machine ? 0 : hoursPerDayOf(resource)),
                note: entry ? entry.note : ''
            };
        });
}

/** Si el recurso estaba en obra esa fecha, segun su estadia declarada. */
export function onSite(resource, date) {
    if (!date) return true;
    if (resource.from && date < resource.from) return false;
    if (resource.to && date > resource.to) return false;
    return true;
}

/* ------------------------------- acumulados ------------------------------- */

/**
 * Horas de una persona: las del dia, las de antes y el total.
 * Se suman siempre, nunca se guardan: corregir un dia viejo tiene que arrastrar.
 */
export function hoursOf(resourceId, entries, date) {
    let today = 0;
    let before = 0;
    for (const entry of entries) {
        if (entry.resourceId !== resourceId) continue;
        // Solo cuentan los estados de personal: un "operativa" de maquina no es
        // una jornada, y attendanceOf devuelve "en turno" para lo que no conoce.
        if (!ATTENDANCE.some((a) => a.id === entry.status)) continue;
        if (!attendanceOf(entry.status).hours) continue;
        const value = Number(entry.hours) || 0;
        if (entry.date === date) today += value;
        else if (entry.date < date) before += value;
    }
    return { today, before, total: before + today };
}

/** Resumen del dia: cuantos estuvieron, cuantas horas y que quedo parado. */
export function daySummary(resources, entries, date) {
    const rows = sheetFor(resources, entries, date);
    const people = rows.filter((r) => r.resource.type === 'persona');
    const machines = rows.filter((r) => r.resource.type === 'maquina');

    const working = people.filter((r) => attendanceOf(r.status).hours);
    const hours = working.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
    const direct = working.filter((r) => isDirect(r.resource)).length;

    const ok = machines.filter((r) => machineStateOf(r.status).ok);
    const down = machines.filter((r) => !machineStateOf(r.status).ok);

    return {
        date,
        people: people.length,
        working: working.length,
        absent: people.length - working.length,
        direct,
        indirect: working.length - direct,
        hours,
        machines: machines.length,
        operating: ok.length,
        idle: down.length,
        idleRows: down,
        saved: rows.filter((r) => r.saved).length,
        rows
    };
}

/**
 * Mano de obra directa o indirecta. Es una division contractual, no una
 * propiedad del oficio: la decide el usuario y se guarda en el recurso.
 */
export function isDirect(resource) {
    if (resource && typeof resource.direct === 'boolean') return resource.direct;
    // Sin declarar, el personal de terreno se asume directo y el de oficina no.
    const role = String((resource && resource.role) || '').toLowerCase();
    return !/oficina|administrat|logistic|prevenc|site manager|gerent|jefe de proyecto/.test(role);
}

/* --------------------------------- salida --------------------------------- */

/** La planilla de horas tal como la pide el informe. */
export function hoursToCsv(resources, entries, date) {
    const header = ['n', 'nombre', 'directo_indirecto', 'puesto', 'estatus',
        'horas_dia', 'horas_anterior', 'horas_acumuladas', 'observacion'];
    const rows = sheetFor(resources, entries, date)
        .filter((row) => row.resource.type === 'persona')
        .map((row, i) => {
            const h = hoursOf(row.resource.id, entries, date);
            return [
                i + 1,
                row.resource.name,
                isDirect(row.resource) ? 'DIRECTOS' : 'INDIRECTOS',
                row.resource.role || '',
                attendanceOf(row.status).label.toUpperCase(),
                csvNumber(row.saved ? h.today : row.hours),
                csvNumber(h.before),
                csvNumber(h.before + (row.saved ? h.today : row.hours)),
                row.note || ''
            ].map(cell).join(';');
        });
    return '﻿' + [header.join(';'), ...rows].join('\r\n');
}

function csvNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n === 0) return '0';
    return String(n).replace('.', ',');
}

function cell(value) {
    const text = String(value === null || value === undefined ? '' : value);
    return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
