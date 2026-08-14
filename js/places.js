/*
 * Ubicaciones: puntos del plano donde esta trabajando el personal o la
 * maquinaria. Un punto puede existir solo (una posicion prevista) y recibir
 * despues los recursos que le corresponden.
 */

import { newId } from './db.js';
import { typeOf } from './resources.js';

export function createPlace(projectId, patch = {}) {
    const now = Date.now();
    return {
        id: newId('ubi'),
        projectId,
        label: '',
        x: 0,
        y: 0,
        resources: [],  // ids de personal y maquinaria en ese punto
        from: '',       // desde cuando estan ahi (YYYY-MM-DD)
        to: '',         // hasta cuando; vacio = siguen ahi
        note: '',
        createdAt: now,
        updatedAt: now,
        ...patch
    };
}

/** Normaliza una ubicacion venida de una copia .json. */
export function normalizePlace(raw, projectId) {
    const base = createPlace(projectId);
    if (!raw || typeof raw !== 'object') return base;
    return {
        ...base,
        ...raw,
        id: raw.id || base.id,
        projectId,
        x: Number(raw.x) || 0,
        y: Number(raw.y) || 0,
        label: String(raw.label || '').slice(0, 120),
        resources: Array.isArray(raw.resources) ? raw.resources : []
    };
}

/** Icono del punto: el del recurso que tiene, o un pin si esta vacio. */
export function placeIcon(place, resources) {
    const first = (place.resources || [])
        .map((id) => resources.find((r) => r.id === id))
        .find(Boolean);
    return first ? typeOf(first.type).icon : '📍';
}

export function placeColor(place, resources) {
    const first = (place.resources || [])
        .map((id) => resources.find((r) => r.id === id))
        .find(Boolean);
    return first ? typeOf(first.type).color : '#94a3b8';
}

/** Nombre visible: la etiqueta escrita o los recursos que hay en el punto. */
export function placeTitle(place, resources) {
    if (place.label) return place.label;
    const names = (place.resources || [])
        .map((id) => resources.find((r) => r.id === id))
        .filter(Boolean)
        .map((r) => r.name);
    return names.length ? names.join(', ') : 'Punto sin asignar';
}

/** Ubicaciones vigentes en una fecha dada. Sin fechas, el punto vale siempre. */
export function placesAt(places, date) {
    return places.filter((place) => {
        if (place.from && date < place.from) return false;
        if (place.to && date > place.to) return false;
        return true;
    });
}

/** Ubicaciones donde aparece un recurso. */
export function placesOf(resourceId, places) {
    return places.filter((place) => (place.resources || []).includes(resourceId));
}

function csvCell(value) {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function placesToCsv(places, resources) {
    const names = new Map(resources.map((r) => [r.id, r.name]));
    const header = ['id', 'punto', 'x', 'y', 'personal_y_maquinaria', 'desde', 'hasta', 'nota', 'creado'];
    const rows = places.map((place) => [
        place.id,
        placeTitle(place, resources),
        place.x,
        place.y,
        (place.resources || []).map((id) => names.get(id) || id).join(' | '),
        place.from,
        place.to,
        place.note,
        new Date(place.createdAt).toISOString()
    ].map(csvCell).join(';'));
    return '﻿' + [header.join(';'), ...rows].join('\r\n');
}
