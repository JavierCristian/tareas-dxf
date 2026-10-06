/*
 * Recursos de obra: personal y maquinaria asignables a las tareas.
 *
 * Cada recurso lleva ademas los datos con que se controla un proyecto: cuanto
 * rinde por hora, cuanto combustible gasta y cuanto cuesta la hora. Con eso, y
 * con los dias que el programa le asigna a cada tramo, salen el consumo y el
 * costo de la obra sin llevar otra planilla aparte.
 */

import { newId } from './db.js';
import { parseCsv, normalizeHeader, toNumber, toBoolean } from './csv.js';

export const RESOURCE_TYPES = [
    { id: 'persona', label: 'Personal', plural: 'Personal', icon: '👷', color: '#38bdf8' },
    { id: 'maquina', label: 'Maquinaria', plural: 'Maquinaria', icon: '🚜', color: '#f59e0b' },
    // Lo que sostiene la obra sin producir: instalacion de faenas, banos,
    // estaciones de sombra, comedores, bodegas. No abren frentes de trabajo,
    // pero cuestan todos los dias que estan y tienen que alcanzar para la gente.
    { id: 'instalacion', label: 'Instalaciones', plural: 'Instalaciones', icon: '🚻', color: '#4ade80' }
];

/** Como se cobra un recurso. La maquinaria por hora; un bano, por dia o por mes. */
export const COST_UNITS = [
    { id: 'hora', label: 'Por hora', short: '/h', perDay: (resource) => hoursPerDayOf(resource) },
    { id: 'dia', label: 'Por dia', short: '/dia', perDay: () => 1 },
    { id: 'mes', label: 'Por mes', short: '/mes', perDay: () => 1 / 30 }
];

export function costUnitOf(resource) {
    const raw = resource && resource.costUnit;
    const found = COST_UNITS.find((u) => u.id === raw);
    if (found) return found;
    // Una instalacion que no dice nada se cobra por dia, que es lo habitual.
    return COST_UNITS.find((u) => u.id === (resource && resource.type === 'instalacion' ? 'dia' : 'hora'));
}

/** Lo que cuesta un recurso en un dia de obra, sea como sea que se cobre. */
export function dailyCostOf(resource) {
    const unit = costUnitOf(resource);
    return positive(resource && resource.cost) * unit.perDay(resource);
}

/** Cuantas unidades hay de este recurso: tres banos quimicos son uno con 3. */
export function countOf(resource) {
    const value = Number(resource && resource.quantity);
    return Number.isFinite(value) && value >= 1 ? Math.round(value) : 1;
}

/** A cuanta gente atiende cada unidad, para saber si alcanza. */
export function servesOf(resource) {
    const value = Number(resource && resource.serves);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

/** Etiquetas del campo "cargo" segun el tipo, solo para orientar al usuario. */
export const ROLE_HINTS = {
    persona: 'Ej: maestro albanil, jefe de terreno, ayudante',
    maquina: 'Ej: retroexcavadora CAT 320, camion tolva',
    instalacion: 'Ej: servicios higienicos, proteccion UV, instalacion de faenas'
};

export const CODE_HINTS = {
    persona: 'RUT o numero interno',
    maquina: 'Patente o numero de equipo',
    instalacion: 'Numero de contrato o de arriendo'
};

export function typeOf(id) {
    return RESOURCE_TYPES.find((t) => t.id === id) || RESOURCE_TYPES[0];
}

/** Unidades en que puede venir el rendimiento de un equipo, por hora. */
export const RESOURCE_RATE_UNITS = [
    { id: '', label: 'sin rendimiento', unit: '' },
    { id: 'm3', label: 'm³ por hora', unit: 'm³' },
    { id: 'ml', label: 'metros por hora', unit: 'm' },
    { id: 'ml_fase', label: 'metros de conductor por hora', unit: 'm' },
    { id: 'un', label: 'unidades por hora', unit: 'u' }
];

export function rateUnitLabel(id) {
    return (RESOURCE_RATE_UNITS.find((u) => u.id === id) || RESOURCE_RATE_UNITS[0]).unit;
}

/** Jornada por omision cuando el recurso no la declara. */
export const DEFAULT_HOURS_PER_DAY = 8;

export function hoursPerDayOf(resource) {
    const value = Number(resource && resource.hoursPerDay);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_HOURS_PER_DAY;
}

/** Rendimiento diario de un equipo: lo que rinde en una hora por su jornada. */
export function dailyRateOf(resource) {
    const value = Number(resource && resource.rate && resource.rate.value);
    const unit = resource && resource.rate ? resource.rate.unit : '';
    if (!unit || !Number.isFinite(value) || value <= 0) return null;
    return { unit, perHour: value, perDay: value * hoursPerDayOf(resource) };
}

function positive(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

/**
 * Lo que cuesta y consume un grupo de recursos durante los dias indicados.
 * El personal no gasta combustible; la maquinaria si.
 */
export function spendOf(resources, days) {
    const total = { cost: 0, fuel: 0, hours: 0 };
    if (!(days > 0)) return total;
    for (const resource of resources) {
        const units = countOf(resource);
        // Las instalaciones no trabajan horas: estan, y por estar se pagan.
        if (resource.type !== 'instalacion') {
            const hours = hoursPerDayOf(resource) * days * units;
            total.hours += hours;
            total.fuel += positive(resource.fuel) * hours;
        }
        total.cost += dailyCostOf(resource) * days * units;
    }
    return total;
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
        rate: { unit: '', value: 0 },  // rendimiento por hora del equipo
        hoursPerDay: null,             // jornada; sin dato se asumen 8
        fuel: 0,                       // litros de combustible por hora
        cost: 0,                       // costo por hora
        brand: '',                     // marca
        quantity: 1,   // cuantas unidades hay: tres banos quimicos son uno con 3
        serves: 0,     // a cuanta gente atiende cada unidad, si corresponde
        costUnit: '',  // hora, dia o mes; vacio, lo que toque segun el tipo
        hourmeter: null,               // horometro o kilometraje actual
        nextService: null,             // proxima mantencion, en horas
        from: '',      // desde cuando esta en obra (YYYY-MM-DD); vacio, desde el inicio
        to: '',        // hasta cuando; vacio, hasta el final
        operator: '',  // id del operador que la maneja, en la maquinaria
        shift: '',     // turno: dia, noche o mixto
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
        active: raw.active !== false,
        rate: raw.rate && typeof raw.rate === 'object' ? { ...base.rate, ...raw.rate } : base.rate
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

/** Numero con coma decimal, como lo espera una planilla en espanol. */
function csvNumber(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || number === 0) return '';
    return String(number).replace('.', ',');
}

/* Columnas del CSV de recursos. El mismo orden sirve para exportar y para
   importar, de modo que el archivo exportado se puede editar y volver a subir. */
export const RESOURCE_COLUMNS = [
    'tipo', 'nombre', 'cargo', 'identificador', 'marca', 'cuadrilla', 'telefono',
    'cantidad', 'atiende', 'rendimiento_hora', 'unidad_rendimiento', 'horas_jornada',
    'turno', 'desde', 'hasta', 'operador',
    'combustible_l_hora', 'costo_hora', 'unidad_costo',
    'horometro', 'proxima_mantencion_h', 'estado', 'notas'
];

/** Turnos que se reconocen al leer la planilla. */
export const SHIFTS = [
    { id: '', label: 'Sin turno' },
    { id: 'dia', label: 'Dia' },
    { id: 'noche', label: 'Noche' },
    { id: 'mixto', label: 'Mixto' }
];

export function shiftLabel(id) {
    return (SHIFTS.find((s) => s.id === (id || '')) || SHIFTS[0]).label;
}

/**
 * Ventana en que un recurso esta en obra. Vacia por un lado significa "desde
 * siempre" o "hasta el final", que es lo normal en la mayoria.
 */
export function windowOf(resource) {
    return { from: (resource && resource.from) || '', to: (resource && resource.to) || '' };
}

/**
 * Ventana efectiva de una maquina: no basta con que este en obra, tambien tiene
 * que estar su operador. Se cruzan las dos.
 */
export function crewWindow(resource, resources = []) {
    const own = windowOf(resource);
    const operator = resource && resource.operator
        ? resources.find((r) => r.id === resource.operator)
        : null;
    if (!operator) return own;
    const his = windowOf(operator);
    return {
        from: own.from > his.from ? own.from : his.from,
        // Sin fecha de termino manda la del otro; con las dos, la mas temprana.
        to: !own.to ? his.to : (!his.to ? own.to : (own.to < his.to ? own.to : his.to))
    };
}

/** El operador sale por nombre, que es lo que se puede escribir en la planilla. */
function operatorName(resource, resources) {
    if (!resource || !resource.operator) return '';
    const found = resources.find((r) => r.id === resource.operator);
    return found ? found.name : '';
}

export function resourcesToCsv(resources, tasks) {
    const load = workload(resources, tasks);
    const header = ['id', ...RESOURCE_COLUMNS, 'tareas', 'tareas_abiertas'];
    const rows = resources.map((resource) => {
        const entry = load.get(resource.id) || { total: 0, open: 0 };
        const rate = resource.rate || {};
        return [
            resource.id,
            typeOf(resource.type).label,
            resource.name,
            resource.role,
            resource.code,
            resource.brand,
            resource.group,
            resource.phone,
            countOf(resource),
            csvNumber(resource.serves),
            csvNumber(rate.value),
            rate.unit || '',
            csvNumber(resource.hoursPerDay),
            shiftLabel(resource.shift),
            resource.from || '',
            resource.to || '',
            operatorName(resource, resources),
            csvNumber(resource.fuel),
            csvNumber(resource.cost),
            costUnitOf(resource).label,
            csvNumber(resource.hourmeter),
            csvNumber(resource.nextService),
            resource.active ? 'Activo' : 'Inactivo',
            resource.notes,
            entry.total,
            entry.open
        ].map(csvCell).join(';');
    });
    return '\ufeff' + [header.join(';'), ...rows].join('\r\n');
}

/** Planilla vacia con una fila de ejemplo, para que el formato quede claro. */
export function resourcesCsvTemplate() {
    // tipo;nombre;cargo;identificador;marca;cuadrilla;telefono;rendimiento_hora;
    // unidad_rendimiento;horas_jornada;turno;desde;hasta;operador;
    // combustible_l_hora;costo_hora;horometro;proxima_mantencion_h;estado;notas
    const ejemplos = [
        ['Maquinaria', 'Retroexcavadora CAT 320', 'Excavacion de zanja', 'PP-1234', 'Caterpillar', '', '',
            '1', '', '60', 'm3', '9', 'Dia', '2026-10-12', '', 'Juan Perez',
            '18', '45000', 'Por hora', '4820', '5000', 'Activo', ''],
        ['Maquinaria', 'Cargador frontal 950', 'Carguio', 'RR-5678', 'Caterpillar', '', '',
            '1', '', '80', 'm3', '9', 'Noche', '2026-11-03', '2027-02-28', 'Pedro Soto',
            '22', '52000', 'Por hora', '3100', '3500', 'Activo', 'Llega en noviembre'],
        ['Personal', 'Juan Perez', 'Operador', '12.345.678-9', '', '', '+56 9 1234 5678',
            '1', '', '', '', '9', 'Dia', '', '', '',
            '', '12000', 'Por hora', '', '', 'Activo', ''],
        ['Personal', 'Pedro Soto', 'Operador', '13.456.789-0', '', '', '',
            '1', '', '', '', '9', 'Noche', '2026-11-03', '', '',
            '', '12000', 'Por hora', '', '', 'Activo', ''],
        ['Personal', 'Luis Rojas', 'Maestro electrico', '14.567.890-1', '', 'Cuadrilla 1', '',
            '1', '', '', '', '9', 'Dia', '', '', '',
            '', '9500', 'Por hora', '', '', 'Activo', ''],
        ['Instalaciones', 'Bano quimico', 'Servicios higienicos', '', '', '', '',
            '4', '10', '', '', '', '', '2026-10-12', '', '',
            '', '180000', 'Por mes', '', '', 'Activo', 'Retiro semanal'],
        ['Instalaciones', 'Estacion de sombra e hidratacion', 'Proteccion UV', '', '', '', '',
            '3', '25', '', '', '', '', '2026-10-12', '', '',
            '', '12000', 'Por dia', '', '', 'Activo', ''],
        ['Instalaciones', 'Container comedor', 'Instalacion de faenas', '', '', '', '',
            '1', '40', '', '', '', '', '2026-10-12', '', '',
            '', '450000', 'Por mes', '', '', 'Activo', '']
    ];
    const filas = ejemplos.map((fila) => fila.map(csvCell).join(';'));
    return '\ufeff' + [RESOURCE_COLUMNS.join(';'), ...filas].join('\r\n');
}


/* ------------------------------ importar CSV ------------------------------ */

/*
 * Nombres que puede traer cada columna. Se aceptan variantes porque la planilla
 * la arma cada obra a su manera; lo unico obligatorio es el nombre del recurso.
 */
const COLUMN_ALIASES = {
    id: ['id', 'codigo_interno'],
    type: ['tipo', 'type', 'clase', 'categoria'],
    quantity: ['cantidad', 'unidades', 'cant', 'numero', 'qty'],
    serves: ['atiende', 'atiende_personas', 'capacidad', 'personas', 'dotacion'],
    costUnit: ['unidad_costo', 'costo_unidad', 'cobro', 'periodo_costo'],
    name: ['nombre', 'name', 'recurso', 'equipo'],
    role: ['cargo', 'modelo', 'role', 'funcion', 'especialidad'],
    code: ['identificador', 'patente', 'rut', 'code', 'numero_interno', 'interno'],
    brand: ['marca', 'brand', 'fabricante'],
    group: ['cuadrilla', 'empresa', 'grupo', 'subcontrato', 'group'],
    phone: ['telefono', 'fono', 'phone', 'celular'],
    rateValue: ['rendimiento_hora', 'rendimiento', 'rendimiento_h', 'produccion_hora', 'rend_hora'],
    rateUnit: ['unidad_rendimiento', 'unidad', 'unidad_rend', 'medida'],
    hoursPerDay: ['horas_jornada', 'horas_dia', 'jornada', 'horas_por_dia'],
    shift: ['turno', 'shift', 'jornada_turno', 'horario'],
    from: ['desde', 'fecha_desde', 'inicio', 'entrada', 'disponible_desde', 'llegada'],
    to: ['hasta', 'fecha_hasta', 'termino', 'salida', 'disponible_hasta', 'retiro'],
    operator: ['operador', 'operario', 'conductor', 'chofer', 'maquinista', 'a_cargo'],
    fuel: ['combustible_l_hora', 'combustible', 'combustible_hora', 'litros_hora', 'consumo'],
    cost: ['costo_hora', 'costo', 'valor_hora', 'tarifa_hora', 'precio_hora'],
    hourmeter: ['horometro', 'horometro_actual', 'kilometraje', 'horas_acumuladas'],
    nextService: ['proxima_mantencion_h', 'proxima_mantencion', 'mantencion', 'proximo_servicio'],
    active: ['estado', 'activo', 'vigente', 'status'],
    notes: ['notas', 'observaciones', 'comentarios', 'nota']
};

function pick(row, field) {
    for (const alias of COLUMN_ALIASES[field] || []) {
        if (row[alias] !== undefined && row[alias] !== '') return row[alias];
    }
    return '';
}

/** Como se cobra, escrito como venga: /h, por dia, mensual, arriendo mes... */
function readCostUnit(value) {
    const text = normalizeHeader(value);
    if (!text) return '';
    if (text.includes('mes') || text.startsWith('m')) return 'mes';
    if (text.includes('dia') || text.startsWith('d')) return 'dia';
    if (text.includes('hora') || text.startsWith('h')) return 'hora';
    return '';
}

/** Turno escrito como venga: Dia, DIURNO, noche, D, N... */
function readShift(value) {
    const text = normalizeHeader(value);
    if (!text) return '';
    if (text.startsWith('d')) return 'dia';
    if (text.startsWith('n')) return 'noche';
    if (text.startsWith('m') || text.startsWith('r')) return 'mixto';
    return '';
}

/**
 * Fecha escrita como se escribe en Chile. Se aceptan 2026-10-12, 12-10-2026 y
 * 12/10/2026, y el año de dos cifras se entiende como 20xx.
 */
export function readDate(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(text);
    if (iso) return `${iso[1]}-${pad(iso[2])}-${pad(iso[3])}`;
    const local = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(text);
    if (local) {
        const year = local[3].length === 2 ? `20${local[3]}` : local[3];
        return `${year}-${pad(local[2])}-${pad(local[1])}`;
    }
    return '';
}

function pad(value) {
    return String(Number(value)).padStart(2, '0');
}

/** Tipo de recurso escrito de cualquier forma razonable. */
function readType(value) {
    const text = normalizeHeader(value);
    if (!text) return 'persona';
    if (['maquina', 'maquinaria', 'equipo', 'equipos', 'machine', 'vehiculo'].includes(text)) return 'maquina';
    if (['instalacion', 'instalaciones', 'faena', 'faenas', 'bano', 'banos', 'servicio',
        'servicios', 'infraestructura'].includes(text)) return 'instalacion';
    return 'persona';
}

/** Unidad de rendimiento escrita como venga (m3, M3/H, metros, unidades...). */
function readRateUnit(value) {
    const text = normalizeHeader(value);
    if (!text) return '';
    if (text.startsWith('m3') || text.includes('metro_cubico') || text.includes('cubico')) return 'm3';
    if (text.startsWith('ml_fase') || text.includes('conductor') || text.includes('fase')) return 'ml_fase';
    if (text.startsWith('ml') || text.startsWith('m') || text.includes('metro') || text.includes('lineal')) return 'ml';
    if (text.startsWith('un') || text.includes('unidad')) return 'un';
    return '';
}

/**
 * Convierte una planilla en recursos. Las filas que traen un id conocido, o un
 * identificador (patente, RUT) que ya existe, actualizan al recurso en vez de
 * duplicarlo: asi se puede exportar, editar en Excel y volver a subir.
 *
 * @returns {{created: Array, updated: Array, skipped: number, columns: Array}}
 */
export function resourcesFromCsv(text, projectId, existing = []) {
    const { columns, rows } = parseCsv(text);
    const byId = new Map(existing.map((r) => [r.id, r]));
    const byCode = new Map();
    const byName = new Map();
    for (const resource of existing) {
        if (resource.code) byCode.set(normalizeHeader(resource.code), resource);
        byName.set(`${resource.type}|${normalizeHeader(resource.name)}`, resource);
    }

    const created = [];
    const updated = [];
    const pending = [];   // operadores escritos por nombre, a resolver al final
    let skipped = 0;

    for (const row of rows) {
        const name = String(pick(row, 'name') || '').trim();
        if (!name) { skipped++; continue; }

        const type = readType(pick(row, 'type'));
        const code = String(pick(row, 'code') || '').trim();
        const target = byId.get(pick(row, 'id'))
            || (code ? byCode.get(normalizeHeader(code)) : null)
            || byName.get(`${type}|${normalizeHeader(name)}`)
            || null;

        const rateValue = toNumber(pick(row, 'rateValue'));
        const rateUnit = readRateUnit(pick(row, 'rateUnit'));
        const patch = {
            type,
            name: name.slice(0, 120),
            role: String(pick(row, 'role') || '').slice(0, 80),
            code: code.slice(0, 40),
            brand: String(pick(row, 'brand') || '').slice(0, 80),
            group: String(pick(row, 'group') || '').slice(0, 80),
            phone: String(pick(row, 'phone') || '').slice(0, 40),
            hoursPerDay: toNumber(pick(row, 'hoursPerDay')),
            quantity: toNumber(pick(row, 'quantity')) || 1,
            serves: toNumber(pick(row, 'serves')) || 0,
            costUnit: readCostUnit(pick(row, 'costUnit')),
            shift: readShift(pick(row, 'shift')),
            from: readDate(pick(row, 'from')),
            to: readDate(pick(row, 'to')),
            fuel: toNumber(pick(row, 'fuel')) || 0,
            cost: toNumber(pick(row, 'cost')) || 0,
            hourmeter: toNumber(pick(row, 'hourmeter')),
            nextService: toNumber(pick(row, 'nextService')),
            active: toBoolean(pick(row, 'active'), true),
            notes: String(pick(row, 'notes') || '').slice(0, 1000),
            // Si viene el rendimiento sin unidad se asumen m3, que es lo comun
            // en maquinaria de movimiento de tierra.
            rate: {
                unit: rateUnit || (rateValue > 0 ? 'm3' : ''),
                value: rateValue > 0 ? rateValue : 0
            },
            updatedAt: Date.now()
        };

        let saved;
        if (target) {
            Object.assign(target, patch);
            updated.push(target);
            saved = target;
        } else {
            saved = createResource(projectId, patch);
            created.push(saved);
            byName.set(`${type}|${normalizeHeader(name)}`, saved);
            if (saved.code) byCode.set(normalizeHeader(saved.code), saved);
        }

        const operator = String(pick(row, 'operator') || '').trim();
        if (operator) pending.push({ resource: saved, operator });
    }

    // El operador se resuelve al final porque puede venir mas abajo en la misma
    // planilla: se busca por nombre y, si no, por RUT o numero interno.
    const unknown = [];
    if (pending.length) {
        const people = new Map();
        for (const resource of [...existing, ...created]) {
            if (resource.type !== 'persona') continue;
            people.set(normalizeHeader(resource.name), resource);
            if (resource.code) people.set(normalizeHeader(resource.code), resource);
        }
        for (const { resource, operator } of pending) {
            const found = people.get(normalizeHeader(operator));
            if (found) {
                resource.operator = found.id;
                if (!updated.includes(resource) && !created.includes(resource)) updated.push(resource);
            } else unknown.push(operator);
        }
    }

    return { created, updated, skipped, columns, unknown };
}
