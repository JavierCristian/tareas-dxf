/*
 * Lectura de planillas CSV.
 *
 * Pensado para archivos que salen de Excel en espanol: separador punto y coma,
 * coma decimal, BOM al principio y saltos de linea de Windows. Tambien lee los
 * que usan coma o tabulacion como separador, porque eso depende de la maquina
 * en que se guardo la planilla.
 */

/** Separador mas probable, mirando la primera linea util. */
export function detectDelimiter(text) {
    const line = text.split(/\r?\n/).find((row) => row.trim().length) || '';
    let best = ';';
    let bestCount = 0;
    for (const candidate of [';', ',', '\t', '|']) {
        // Se cuentan solo los separadores fuera de comillas.
        let count = 0;
        let quoted = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') quoted = !quoted;
            else if (!quoted && ch === candidate) count++;
        }
        if (count > bestCount) {
            best = candidate;
            bestCount = count;
        }
    }
    return best;
}

/** Filas de un CSV, respetando comillas y saltos de linea dentro de un campo. */
export function parseRows(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else quoted = false;
            } else field += ch;
            continue;
        }
        if (ch === '"') { quoted = true; continue; }
        if (ch === delimiter) { row.push(field); field = ''; continue; }
        if (ch === '\r') continue;
        if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
        field += ch;
    }
    row.push(field);
    rows.push(row);

    // Se descartan las lineas vacias del final del archivo.
    return rows.filter((cells) => cells.some((cell) => cell.trim().length));
}

/** Nombre de columna comparable: sin BOM, sin tildes, sin espacios sobrantes. */
export function normalizeHeader(name) {
    return String(name || '')
        .replace(/^﻿/, '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/**
 * Lee un CSV con encabezado.
 * @returns {{columns: string[], rows: Array<Object>}} cada fila indexada por
 *          el nombre normalizado de su columna.
 */
export function parseCsv(text) {
    const clean = String(text || '').replace(/^﻿/, '');
    if (!clean.trim()) return { columns: [], rows: [] };
    const delimiter = detectDelimiter(clean);
    const raw = parseRows(clean, delimiter);
    if (!raw.length) return { columns: [], rows: [] };

    const columns = raw[0].map(normalizeHeader);
    const rows = [];
    for (let i = 1; i < raw.length; i++) {
        const cells = raw[i];
        const row = {};
        for (let c = 0; c < columns.length; c++) {
            if (!columns[c]) continue;
            row[columns[c]] = (cells[c] === undefined ? '' : cells[c]).trim();
        }
        rows.push(row);
    }
    return { columns, rows };
}

/**
 * Numero escrito en cualquiera de las formas que aparecen en una planilla:
 * "1.234,56" (espanol), "1234.56" (ingles), "60", "18,5 L". Devuelve null si
 * la celda no trae un numero.
 */
export function toNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let text = String(value === null || value === undefined ? '' : value).trim();
    if (!text) return null;
    // Se descarta cualquier unidad escrita al lado del numero.
    text = text.replace(/[^0-9.,+-]/g, '');
    if (!text || !/[0-9]/.test(text)) return null;

    const dot = text.lastIndexOf('.');
    const comma = text.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) {
        // Manda el que aparece mas a la derecha: ese es el decimal.
        const decimal = dot > comma ? '.' : ',';
        const thousands = decimal === '.' ? ',' : '.';
        text = text.split(thousands).join('');
        if (decimal === ',') text = text.replace(',', '.');
    } else if (comma >= 0) {
        text = text.replace(',', '.');
    } else if (dot >= 0 && /^\d{1,3}(\.\d{3})+$/.test(text)) {
        // "1.234" es mil doscientos treinta y cuatro, no 1,234.
        text = text.split('.').join('');
    }

    const number = Number(text);
    return Number.isFinite(number) ? number : null;
}

/** Interpreta un si/no escrito de las formas habituales. */
export function toBoolean(value, fallback = true) {
    const text = normalizeHeader(value);
    if (!text) return fallback;
    if (['si', 'activo', 'activa', 'true', '1', 'x', 'vigente', 'operativa', 'operativo'].includes(text)) return true;
    if (['no', 'inactivo', 'inactiva', 'false', '0', 'baja', 'fuera_de_servicio'].includes(text)) return false;
    return fallback;
}
