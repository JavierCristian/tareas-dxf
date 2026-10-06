/*
 * Tareas DXF — aplicacion principal.
 * Importa un DXF, permite elegir capas y registrar tareas sobre los elementos
 * del plano. Todo el estado vive en el dispositivo.
 */

import { readDxf, KIND_LABELS, growBounds, metersPerUnit } from './dxf.js';
import { Viewer, formatNumber } from './viewer.js';
import { anchorOf, measure } from './scene.js';
import {
    saveProject, getProject, listProjects, deleteProject,
    saveTask, saveTasks, listTasks, deleteTask, newId, storageMode,
    saveResource, saveResources, listResources, deleteResource,
    savePlace, savePlaces, listPlaces, deletePlace,
    saveActivity, saveActivities, listActivities, deleteActivity
} from './db.js';
import {
    STATUSES, PRIORITIES, statusOf, priorityOf, createTask, elementRef, taskAnchor,
    isOverdue, filterTasks, summarize, tasksToCsv, projectToJson, download,
    taskProgress, taskQuantity, progressSummary, tracksElements, progressFromElements,
    performance, elementsToCsv, refSpans, refDoneLength, refDoneLengthAt, isRefDone,
    normalizeSpans, addSpan, spansLength, refLastDate
} from './tasks.js';
import {
    RESOURCE_TYPES, ROLE_HINTS, CODE_HINTS, typeOf, createResource, normalizeResource,
    workload, resourcesToCsv, resourcesCsvTemplate, resourcesFromCsv,
    RESOURCE_RATE_UNITS, rateUnitLabel, dailyRateOf, hoursPerDayOf, spendOf,
    SHIFTS, shiftLabel
} from './resources.js';
import {
    createPlace, normalizePlace, placeIcon, placeColor, placeTitle, placesOf, placesAt, placesToCsv
} from './places.js';
import {
    ACTIVITY_COLORS, createActivity, normalizeActivity, tasksOf, looseTasks,
    activityProgress, nextTaskName, reorder, reorderTo, relinkChain,
    reorderTasks, numberTasks
} from './activities.js';
import {
    projectRange, projectStateAt, taskStateAt, progressCurve, addDays, daysBetween,
    formatDate, todayISO as todayDate
} from './timeline.js';
import {
    CALENDARS, calendarOf, computeSchedule, workdaysBetween, taskDates, taskLinks,
    unfinishedPredecessors, RATE_UNITS, rateUnitOf, rateOf, crewsOf, frontsOf, ternasOf, taskAmount,
    ACTIVITY_SCOPES, scopeOf, neighbourhood, DEFAULT_SHARE_TOLERANCE
} from './schedule.js';
import {
    applyEdits, makeEdit, removeEdit, editOfShape, canSplit, splitOpen, splitClosed,
    equalCuts, projectOnPath, pathLength, sliceRange, chain, joinTolerance, MIN_PART_RATIO
} from './edits.js';
import { dayReport } from './report.js';
import {
    classifyLayers, summarize as summarizeScheme, verifyTriadas, nameTrenches,
    SUGGESTED_ACTIVITIES, layersFor
} from './parque.js';

/* Version visible de la aplicacion. Debe ir a la par del CACHE de sw.js:
   asi se puede comprobar de un vistazo que version esta corriendo. */
export const APP_VERSION = '20';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
    project: null,
    allShapes: [],          // tal como vienen del DXF
    editedShapes: [],       // despues de aplicar divisiones y uniones
    shapes: [],             // ademas, filtradas por capas importadas
    shapesById: new Map(),
    sceneBounds: null,
    unitScale: 1,           // metros que vale una unidad del plano
    layers: new Map(),      // nombre -> {name, color, visible, imported, count, kinds}
    tasks: [],
    resources: [],
    places: [],
    activities: [],
    activeActivity: null,   // actividad resaltada en el plano
    schedule: null,         // ultimo programa calculado (tramo a tramo)
    scheduleClosed: new Set(), // actividades plegadas en la pestaña Programa
    reportDate: null,       // fecha del parte diario que se esta mirando
    selection: [],          // ids de figuras
    multi: false,
    filters: { text: '', status: 'todas', layer: 'todas', resource: 'todas' },
    draft: null,            // tarea en edicion
    resourceDraft: null,    // recurso en edicion
    placeDraft: null,       // ubicacion en edicion
    activityDraft: null,    // actividad en edicion
    bulkDraft: null,        // carga de tramos desde una capa
    wizard: null,           // asistente que arma la obra desde las capas
    timeline: null,         // {from, to, days, date, playing, timer} cuando el cursor esta activo
    splitTarget: null,      // figura que se esta dividiendo
    advance: null,          // {shape, fromStart, tasks} al registrar avance
    lastTap: null,          // ultimo punto tocado en el plano
    pick: null,             // {onPick, message}
    saveViewTimer: null
};

let viewer = null;

/* ------------------------------------------------------------------ */
/* Arranque                                                            */
/* ------------------------------------------------------------------ */

function init() {
    viewer = new Viewer($('#canvas'), {
        onTap: handleTap,
        onLongPress: handleLongPress,
        onCamera: scheduleViewSave
    });

    fillSelect($('#task-status'), STATUSES);
    fillSelect($('#task-priority'), PRIORITIES);
    fillSelect($('#filter-status'), STATUSES, 'todas', 'Todos los estados');
    fillSelect($('#resource-type'), RESOURCE_TYPES);
    fillSelect($('#resource-rate-unit'), RESOURCE_RATE_UNITS);
    fillSelect($('#schedule-calendar'), CALENDARS);

    wireWelcome();
    wireTopbar();
    wirePanel();
    wireModals();
    wireTaskForm();
    wireResources();
    wirePlaces();
    wireTimeline();
    wireAdvance();
    wireActivities();
    wireSchedule();
    wireBulk();
    wireWizard();
    wireSortable();
    wireReport();
    wireSplitModal();

    refreshRecent();
    registerServiceWorker();
    $('#btn-update-now').addEventListener('click', () => location.reload());
    $('#btn-update-later').addEventListener('click', () => $('#update-banner').classList.add('hidden'));

    // Acceso desde la consola del navegador para diagnosticar en obra.
    window.tareasDxf = { version: APP_VERSION, state, get viewer() { return viewer; }, setTimelineDate };
    const badge = $('#app-version');
    if (badge) badge.textContent = APP_VERSION;
}

function fillSelect(select, options, allValue, allLabel) {
    select.innerHTML = '';
    if (allValue) select.append(new Option(allLabel, allValue));
    for (const option of options) select.append(new Option(option.label, option.id));
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('sw.js').then((registration) => {
        // Si llega una version nueva, se avisa en vez de dejarla esperando en
        // silencio: es la causa tipica de "no me aparece lo nuevo".
        registration.addEventListener('updatefound', () => {
            const fresh = registration.installing;
            if (!fresh) return;
            fresh.addEventListener('statechange', () => {
                if (fresh.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdateBanner();
                }
            });
        });
        // Busca actualizaciones al abrir y cada media hora si queda abierta.
        registration.update();
        setInterval(() => registration.update(), 30 * 60 * 1000);
    }).catch(() => { /* sin modo sin conexion */ });
}

function showUpdateBanner() {
    const banner = $('#update-banner');
    if (!banner || !banner.classList.contains('hidden')) return;
    banner.classList.remove('hidden');
}

/* ------------------------------------------------------------------ */
/* Pantalla inicial                                                    */
/* ------------------------------------------------------------------ */

function wireWelcome() {
    const dropzone = $('#dropzone');
    const input = $('#file-input');

    // En iOS/iPadOS el filtro por extension deja los .dxf en gris dentro de
    // la app Archivos, asi que ahi se acepta cualquier archivo.
    const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isApple) input.removeAttribute('accept');

    dropzone.addEventListener('click', () => input.click());
    dropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', () => {
        if (input.files && input.files[0]) importDxfFile(input.files[0]);
        input.value = '';
    });

    for (const type of ['dragenter', 'dragover']) {
        dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.add('hover'); });
    }
    for (const type of ['dragleave', 'drop']) {
        dropzone.addEventListener(type, (e) => { e.preventDefault(); dropzone.classList.remove('hover'); });
    }
    dropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer && e.dataTransfer.files[0];
        if (file) importDxfFile(file);
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    const importInput = $('#import-input');
    $('#btn-import-project').addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', () => {
        if (importInput.files && importInput.files[0]) importBackup(importInput.files[0]);
        importInput.value = '';
    });
}

async function refreshRecent() {
    const list = $('#recent-list');
    const projects = await listProjects();
    $('#storage-mode').textContent = storageMode();
    list.innerHTML = '';
    if (!projects.length) {
        list.innerHTML = '<li class="empty">Todavia no hay proyectos en este dispositivo.</li>';
        return;
    }
    for (const project of projects) {
        const tasks = await listTasks(project.id);
        const pending = tasks.filter((t) => t.status !== 'completada').length;
        const item = document.createElement('li');
        item.className = 'project';
        item.innerHTML = `
            <div class="project-main">
                <strong></strong>
                <span></span>
            </div>
            <button class="btn small" data-open>Abrir</button>
            <button class="icon-btn" data-delete title="Eliminar" aria-label="Eliminar">🗑</button>`;
        item.querySelector('strong').textContent = project.name;
        item.querySelector('span').textContent =
            `${tasks.length} tarea(s) · ${pending} pendiente(s) · ${new Date(project.updatedAt).toLocaleDateString('es')}`;
        item.querySelector('[data-open]').addEventListener('click', () => openProject(project.id));
        item.querySelector('[data-delete]').addEventListener('click', async () => {
            if (!confirm(`¿Eliminar "${project.name}" y sus tareas de este dispositivo?`)) return;
            await deleteProject(project.id);
            refreshRecent();
        });
        item.querySelector('.project-main').addEventListener('click', () => openProject(project.id));
        list.append(item);
    }
}

/* ------------------------------------------------------------------ */
/* Importar DXF                                                        */
/* ------------------------------------------------------------------ */

async function readFileText(file) {
    if (file.text) return file.text();
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file);
    });
}

async function importDxfFile(file) {
    if (!/\.dxf$/i.test(file.name) && file.type !== 'application/dxf') {
        if (!confirm('El archivo no termina en .dxf. ¿Intentar abrirlo igual?')) return;
    }
    showLoading('Leyendo archivo…');
    try {
        const text = await readFileText(file);
        await nextFrame();
        showLoading('Interpretando el plano…');
        await nextFrame();
        const scene = readDxf(text);
        hideLoading();
        if (!scene.shapes.length) {
            alert('El archivo no contiene entidades dibujables que la aplicacion sepa leer.');
            return;
        }
        const chosen = await askLayers(scene.layers, new Set(scene.layers.map((l) => l.name)), 'Capas del archivo');
        if (!chosen) return;

        const project = {
            id: newId('proy'),
            name: file.name.replace(/\.dxf$/i, ''),
            fileName: file.name,
            units: scene.units,
            dxfText: text,
            layers: scene.layers.map((layer) => ({
                name: layer.name,
                color: layer.color,
                visible: true,
                imported: chosen.has(layer.name)
            })),
            edits: [],
            view: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await saveProject(project);
        if (scene.truncated) {
            toast('El plano es muy grande: se cargo una parte de las entidades.');
        }
        loadIntoApp(project, scene, [], [], [], []);
        // Si el plano viene clasificado, se ofrece armar la obra de una vez
        // en lugar de dejar al usuario crear 250 tramos a mano.
        if (schemeOf()) openWizard();
    } catch (error) {
        hideLoading();
        console.error(error);
        alert('No se pudo leer el archivo.\n\n' + (error.message || error));
    }
}

async function openProject(id) {
    showLoading('Abriendo proyecto…');
    try {
        const project = await getProject(id);
        if (!project) throw new Error('El proyecto ya no existe.');
        if (!project.dxfText) throw new Error('Este proyecto no tiene el plano guardado. Vuelve a importar el DXF.');
        await nextFrame();
        const scene = readDxf(project.dxfText);
        const tasks = await listTasks(id);
        const resources = await listResources(id);
        const places = await listPlaces(id);
        const activities = await listActivities(id);
        hideLoading();
        loadIntoApp(project, scene, tasks, resources, places, activities);
    } catch (error) {
        hideLoading();
        console.error(error);
        alert('No se pudo abrir el proyecto.\n\n' + (error.message || error));
    }
}

function loadIntoApp(project, scene, tasks, resources = [], places = [], activities = []) {
    state.project = project;
    if (!Array.isArray(project.edits)) project.edits = [];
    state.allShapes = scene.shapes;
    state.unitScale = metersPerUnit(scene.units);
    state.tasks = tasks;
    state.resources = resources;
    state.places = places;
    state.activities = activities;
    state.activeActivity = null;
    state.schedule = null;
    // Los tramos llevan el orden en que se ejecutan; los proyectos de antes no
    // lo traen, asi que se numeran como estan para poder reordenarlos.
    for (const activity of activities) numberTasks(activity.id, tasks);
    // El programa se ve entero; solo en obras muy grandes arranca plegado.
    state.scheduleClosed = new Set(tasks.length > 60 ? activities.map((a) => a.id) : []);
    state.selection = [];
    stopTimeline();
    state.filters = { text: '', status: 'todas', layer: 'todas', resource: 'todas' };
    $('#filter-text').value = '';
    $('#filter-status').value = 'todas';
    $('#resource-search').value = '';

    const saved = new Map((project.layers || []).map((l) => [l.name, l]));
    state.layers = new Map();
    for (const layer of scene.layers) {
        const config = saved.get(layer.name);
        state.layers.set(layer.name, {
            name: layer.name,
            count: layer.count,
            kinds: layer.kinds,
            color: (config && config.color) || layer.color,
            visible: config ? config.visible !== false : true,
            imported: config ? config.imported !== false : true
        });
    }
    // Capas guardadas que ya no existen en el archivo se descartan solas.
    project.units = scene.units;

    $('#welcome').classList.add('hidden');
    $('#app').classList.remove('hidden');
    $('#project-name').textContent = project.name;

    applyLayers({ fit: true });
    renderAll();
}

/* ------------------------------------------------------------------ */
/* Capas                                                               */
/* ------------------------------------------------------------------ */

function applyLayers({ fit = false } = {}) {
    // Las divisiones y uniones se aplican sobre el DXF recien leido, antes de
    // filtrar por capas, para que las figuras derivadas hereden su capa.
    const edited = applyEdits(state.allShapes, state.project.edits || []);
    state.editedShapes = edited.shapes;
    if (edited.skipped.length) {
        console.warn('Ediciones ignoradas (falta su elemento de origen):', edited.skipped);
    }

    const imported = new Set([...state.layers.values()].filter((l) => l.imported).map((l) => l.name));
    state.shapes = state.editedShapes.filter((shape) => imported.has(shape.layer));
    state.shapesById = new Map(state.shapes.map((shape) => [shape.id, shape]));

    let bounds = null;
    for (const shape of state.shapes) bounds = growBounds(bounds, shape.bbox);
    state.sceneBounds = bounds || [0, 0, 100, 100];

    viewer.setScene(state.shapes, state.sceneBounds);
    viewer.setLayerState(new Map([...state.layers].map(([name, layer]) => [name, { visible: layer.visible, color: layer.color }])));

    state.selection = state.selection.filter((id) => state.shapesById.has(id));
    viewer.setSelection(state.selection);

    if (fit) {
        const view = state.project && state.project.view;
        if (view && Number.isFinite(view.scale)) viewer.centerOn(view.x, view.y, view.scale);
        else viewer.zoomToFit(state.sceneBounds);
    }
    updateProjectMeta();
}

function updateProjectMeta() {
    const imported = [...state.layers.values()].filter((l) => l.imported).length;
    const edits = (state.project.edits || []).length;
    $('#project-meta').textContent =
        `${state.shapes.length} elementos · ${imported}/${state.layers.size} capas · ${state.project.units}`
        + (edits ? ` · ${edits} division(es)/union(es)` : '');
}

async function persistLayers() {
    if (!state.project) return;
    state.project.layers = [...state.layers.values()].map((layer) => ({
        name: layer.name,
        color: layer.color,
        visible: layer.visible,
        imported: layer.imported
    }));
    await saveProject(state.project);
}

function renderLayers() {
    const list = $('#layer-list');
    list.innerHTML = '';
    const layers = [...state.layers.values()].filter((layer) => layer.imported);
    if (!layers.length) {
        list.innerHTML = '<li class="empty">No hay capas importadas. Usa "Importar capas…".</li>';
        return;
    }
    for (const layer of layers) {
        const item = document.createElement('li');
        item.className = 'layer-item';
        item.innerHTML = `
            <button class="eye" title="Ver / ocultar" aria-label="Ver u ocultar capa"></button>
            <div class="name"><strong></strong><span></span></div>
            <input type="color" title="Color de la capa">`;
        const eye = item.querySelector('.eye');
        eye.textContent = layer.visible ? '👁' : '🚫';
        eye.classList.toggle('on', layer.visible);
        item.querySelector('strong').textContent = layer.name;
        item.querySelector('span').textContent = describeKinds(layer);
        const color = item.querySelector('input[type="color"]');
        color.value = normalizeHex(layer.color);

        eye.addEventListener('click', async () => {
            layer.visible = !layer.visible;
            viewer.setLayerState(new Map([...state.layers].map(([name, l]) => [name, { visible: l.visible, color: l.color }])));
            renderLayers();
            await persistLayers();
        });
        color.addEventListener('change', async () => {
            layer.color = color.value;
            viewer.setLayerState(new Map([...state.layers].map(([name, l]) => [name, { visible: l.visible, color: l.color }])));
            await persistLayers();
        });
        list.append(item);
    }
}

function describeKinds(layer) {
    const parts = Object.entries(layer.kinds || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([kind, count]) => `${count} ${KIND_LABELS[kind] || kind}`);
    return parts.join(' · ') || `${layer.count} elementos`;
}

function normalizeHex(color) {
    return /^#[0-9a-f]{6}$/i.test(color) ? color : '#d7dee8';
}

/** Dialogo de seleccion de capas. Devuelve un Set con los nombres elegidos. */
function askLayers(layers, preselected, title) {
    return new Promise((resolve) => {
        const modal = $('#layers-modal');
        const list = $('#layers-modal-list');
        const search = $('#layers-modal-search');
        const counter = $('#layers-modal-count');
        const selected = new Set(preselected);
        $('#layers-modal-title').textContent = title;
        search.value = '';

        const updateCounter = () => {
            const shapes = layers.filter((l) => selected.has(l.name)).reduce((sum, l) => sum + l.count, 0);
            counter.textContent = `${selected.size} de ${layers.length} capas · ${shapes} elementos`;
            $('#layers-modal-accept').disabled = selected.size === 0;
        };

        const draw = () => {
            const query = search.value.trim().toLowerCase();
            list.innerHTML = '';
            const filtered = layers.filter((l) => !query || l.name.toLowerCase().includes(query));
            if (!filtered.length) {
                list.innerHTML = '<li class="empty">Ninguna capa coincide.</li>';
            }
            for (const layer of filtered) {
                const item = document.createElement('li');
                item.className = 'layer-pick';
                item.innerHTML = `
                    <input type="checkbox">
                    <span class="swatch"></span>
                    <label class="name"><strong></strong><span></span></label>`;
                const checkbox = item.querySelector('input');
                checkbox.checked = selected.has(layer.name);
                item.querySelector('.swatch').style.background = layer.color;
                item.querySelector('strong').textContent = layer.name;
                item.querySelector('.name span').textContent = describeKinds(layer);
                const toggle = () => {
                    checkbox.checked = !checkbox.checked;
                    if (checkbox.checked) selected.add(layer.name); else selected.delete(layer.name);
                    updateCounter();
                };
                checkbox.addEventListener('change', () => {
                    if (checkbox.checked) selected.add(layer.name); else selected.delete(layer.name);
                    updateCounter();
                });
                item.addEventListener('click', (e) => { if (e.target !== checkbox) toggle(); });
                list.append(item);
            }
            updateCounter();
        };

        const close = (result) => {
            modal.classList.add('hidden');
            search.removeEventListener('input', draw);
            $('#layers-modal-all').removeEventListener('click', selectAll);
            $('#layers-modal-none').removeEventListener('click', selectNone);
            $('#layers-modal-accept').removeEventListener('click', accept);
            modal.removeEventListener('click', backdrop);
            for (const button of modal.querySelectorAll('[data-close]')) button.removeEventListener('click', cancel);
            resolve(result);
        };
        const selectAll = () => { for (const l of layers) selected.add(l.name); draw(); };
        const selectNone = () => { selected.clear(); draw(); };
        const accept = () => close(selected);
        const cancel = () => close(null);
        const backdrop = (e) => { if (e.target === modal) cancel(); };

        search.addEventListener('input', draw);
        $('#layers-modal-all').addEventListener('click', selectAll);
        $('#layers-modal-none').addEventListener('click', selectNone);
        $('#layers-modal-accept').addEventListener('click', accept);
        modal.addEventListener('click', backdrop);
        for (const button of modal.querySelectorAll('[data-close]')) button.addEventListener('click', cancel);

        modal.classList.remove('hidden');
        draw();
    });
}

/* ------------------------------------------------------------------ */
/* Barra superior y herramientas                                       */
/* ------------------------------------------------------------------ */

function wireTopbar() {
    $('#btn-home').addEventListener('click', async () => {
        await persistLayers();
        state.project = null;
        $('#app').classList.add('hidden');
        $('#welcome').classList.remove('hidden');
        refreshRecent();
    });
    $('#btn-zoom-fit').addEventListener('click', () => viewer.zoomToFit(state.sceneBounds));
    $('#btn-zoom-in').addEventListener('click', () => viewer.zoomBy(1.4));
    $('#btn-zoom-out').addEventListener('click', () => viewer.zoomBy(1 / 1.4));
    $('#btn-new-task').addEventListener('click', () => startNewTask());
    $('#btn-multi').addEventListener('click', () => {
        state.multi = !state.multi;
        $('#btn-multi').classList.toggle('active', state.multi);
        toast(state.multi ? 'Seleccion multiple activada' : 'Seleccion multiple desactivada');
    });
    $('#btn-toggle-panel').addEventListener('click', () => togglePanel());
    $('#btn-cancel-pick').addEventListener('click', () => endPick(null));
    $('#btn-task-from-selection').addEventListener('click', () => startNewTask());
    $('#btn-clear-selection').addEventListener('click', () => setSelection([]));
}

function togglePanel(force) {
    const panel = $('#panel');
    const open = force === undefined ? !panel.classList.contains('open') : force;
    panel.classList.toggle('open', open);
    $('#app').classList.toggle('panel-open', open);
}

/* ------------------------------------------------------------------ */
/* Interaccion con el plano                                            */
/* ------------------------------------------------------------------ */

function handleTap(local, event) {
    const world = viewer.screenToWorld(local.x, local.y);
    state.lastTap = world;

    if (state.pick) {
        const shape = viewer.pickAt(local.x, local.y);
        // En modo continuo cada toque suma o quita, y el modo sigue activo.
        if (state.pick.multi) {
            if (!shape) return toast('No hay ningun elemento en ese punto.');
            state.pick.onEach(shape);
            return;
        }
        if (state.pick.onlyPoint) return endPick({ point: world, shape });
        if (state.pick.allowPoint && !shape) return endPick({ point: world });
        if (!shape) return toast('No hay ningun elemento en ese punto.');
        return endPick({ shape, point: world });
    }

    const marker = viewer.pickMarkerAt(local.x, local.y);
    if (marker) {
        if (marker.kind === 'place') {
            const place = state.places.find((p) => p.id === marker.id);
            if (place) return openPlaceModal(place, false);
        }
        const task = state.tasks.find((t) => t.id === marker.id);
        if (task) return openTaskModal(task);
    }

    const shape = viewer.pickAt(local.x, local.y);
    if (!shape) {
        if (!state.multi) setSelection([]);
        return;
    }
    const additive = state.multi || (event && (event.shiftKey || event.ctrlKey || event.metaKey));
    if (additive) {
        const next = state.selection.includes(shape.id)
            ? state.selection.filter((id) => id !== shape.id)
            : [...state.selection, shape.id];
        setSelection(next);
    } else {
        setSelection([shape.id]);
    }
}

function handleLongPress(local) {
    if (state.pick) return;
    const world = viewer.screenToWorld(local.x, local.y);
    const shape = viewer.pickAt(local.x, local.y);
    if (shape) {
        setSelection(state.selection.includes(shape.id) ? state.selection : [...state.selection, shape.id]);
        startNewTask();
    } else {
        // Punto libre: la tarea se ancla ahi, sin arrastrar la seleccion previa.
        setSelection([]);
        startNewTask({ anchor: { x: world.x, y: world.y } });
    }
}

function setSelection(ids) {
    state.selection = ids;
    viewer.setSelection(ids);
    renderSelectionCard();
    renderElementPanel();
}

function renderSelectionCard() {
    const card = $('#selection-card');
    if (!state.selection.length) {
        card.classList.add('hidden');
        return;
    }
    card.classList.remove('hidden');
    if (state.selection.length === 1) {
        const shape = state.shapesById.get(state.selection[0]);
        $('#selection-title').textContent = shape ? (KIND_LABELS[shape.kind] || shape.kind) : 'Elemento';
        $('#selection-meta').textContent = shape ? `Capa ${shape.layer} · ${describeMeasure(shape)}` : '';
    } else {
        $('#selection-title').textContent = `${state.selection.length} elementos`;
        const layers = new Set(state.selection.map((id) => (state.shapesById.get(id) || {}).layer));
        $('#selection-meta').textContent = `Capas: ${[...layers].filter(Boolean).join(', ')}`;
    }
}

function describeMeasure(shape) {
    const m = measure(shape);
    if (!m) return `x ${formatNumber(shape.pts[0])} · y ${formatNumber(shape.pts[1])}`;
    if (m.area !== undefined) return `perimetro ${formatNumber(m.length)} · area ${formatNumber(m.area)}`;
    return `longitud ${formatNumber(m.length)}`;
}

/* ------------------------------------------------------------------ */
/* Geometria: divisiones y uniones                                     */
/* ------------------------------------------------------------------ */

/**
 * Guarda una edicion, rehace la escena y reengancha las tareas que apuntaban
 * a los elementos consumidos.
 */
async function commitEdit(edit, message) {
    // Se guarda como estaban los tramos afectados para poder deshacer sin
    // inventar: al revertir se reponen tal cual estaban, con su fecha y estado.
    const gone = new Set(edit.from);
    edit.taskRefs = state.tasks
        .filter((task) => task.elements.some((ref) => gone.has(ref.id)))
        .map((task) => ({
            taskId: task.id,
            refs: task.elements.filter((ref) => gone.has(ref.id)).map((ref) => ({ ...ref }))
        }));

    state.project.edits = [...(state.project.edits || []), edit];
    applyLayers();
    const touched = remapTasks(edit);
    await saveProject(state.project);
    if (touched.length) await saveTasks(touched);

    const created = edit.parts.map((part) => part.id).filter((id) => state.shapesById.has(id));
    setSelection(created);
    renderAll();
    const note = touched.length ? ` ${touched.length} tarea(s) reasignada(s).` : '';
    toast(message + note);
}

/** Reasigna las tareas de los elementos consumidos a la parte mas cercana. */
function remapTasks(edit) {
    const parts = edit.parts.map((part) => state.shapesById.get(part.id)).filter(Boolean);
    if (!parts.length) return [];
    const gone = new Set(edit.from);
    const touched = [];

    for (const task of state.tasks) {
        if (!task.elements.some((ref) => gone.has(ref.id))) continue;
        const next = [];
        const seen = new Set();
        for (const ref of task.elements) {
            if (!gone.has(ref.id)) {
                if (!seen.has(ref.id)) { next.push(ref); seen.add(ref.id); }
                continue;
            }
            // La actividad cubria todo el elemento, asi que se queda con todos
            // los trozos que lo reemplazan: si no, perderia longitud al dividir.
            for (const part of parts) {
                if (seen.has(part.id)) continue;
                next.push(inheritRef(part, ref));
                seen.add(part.id);
            }
        }
        task.elements = next;
        task.updatedAt = Date.now();
        touched.push(task);
    }
    return touched;
}

/**
 * Nuevo tramo con los datos del que reemplaza: si estaba ejecutado y con
 * seccion definida, sus partes tambien lo estan.
 */
function inheritRef(shape, ref) {
    return {
        ...elementRef(shape, keepNear(shape, ref)),
        done: !!ref.done,
        doneAt: ref.done ? ref.doneAt : null,
        width: ref.width ?? null,
        depth: ref.depth ?? null
    };
}

/**
 * Mantiene la tarea donde estaba: se ancla al punto de la nueva figura mas
 * cercano al anterior, en vez de saltar al centro. Asi, al unir y volver a
 * separar, cada tarea regresa al trozo que le corresponde.
 */
function keepNear(shape, ref) {
    const projection = projectOnPath(shape.pts, ref.x, ref.y);
    return { x: projection.x, y: projection.y };
}


function openSplitModal(shape) {
    state.splitTarget = shape;
    const total = pathLength(shape.pts);
    const closed = !!shape.closed;
    $('#split-info').textContent =
        `${KIND_LABELS[shape.kind] || shape.kind} · capa ${shape.layer} · ${describeMeasure(shape)}`;
    $('#split-units').textContent = state.project.units === 'sin unidad' ? '' : state.project.units;
    $('#split-distance').value = (total / 2).toFixed(2);
    $('#split-distance').max = String(total);
    $('#btn-split-pick').textContent = closed
        ? 'Tocar dos puntos del contorno'
        : 'Tocar el punto de corte en el plano';
    $('#split-pick-hint').textContent = closed
        ? 'El area se parte con una linea recta entre los dos puntos que toques.'
        : 'El corte cae sobre el punto del elemento mas cercano al toque.';
    // En figuras cerradas solo tiene sentido cortar el area con una linea:
    // repartir el perimetro dejaria trozos sueltos sin superficie.
    // (Se usa la clase y no el atributo hidden porque .split-option fija display.)
    $('#split-equal-block').classList.toggle('hidden', closed);
    $('#split-distance-block').classList.toggle('hidden', closed);
    $('#split-modal').classList.remove('hidden');
}

function closeSplitModal() {
    $('#split-modal').classList.add('hidden');
}

/** Comprueba que ningun trozo quede reducido a nada. */
function validCuts(shape, cuts) {
    const total = pathLength(shape.pts);
    const minimum = total * MIN_PART_RATIO;
    const bounds = [0, ...cuts.slice().sort((a, b) => a - b), total];
    for (let i = 0; i + 1 < bounds.length; i++) {
        if (bounds[i + 1] - bounds[i] < minimum) return false;
    }
    return true;
}

async function splitOpenShape(shape, cuts) {
    if (!validCuts(shape, cuts)) {
        toast('El corte queda demasiado cerca de un extremo.');
        return;
    }
    const parts = splitOpen(shape, cuts);
    if (parts.length < 2) return toast('No se pudo dividir el elemento.');
    await commitEdit(makeEdit('division', [shape], parts), `Dividido en ${parts.length} partes.`);
}

async function splitClosedShape(shape, alongA, alongB) {
    const total = pathLength(shape.pts);
    if (Math.abs(alongA - alongB) < total * MIN_PART_RATIO) {
        toast('Los dos puntos estan demasiado juntos.');
        return;
    }
    const parts = splitClosed(shape, alongA, alongB);
    await commitEdit(makeEdit('division', [shape], parts), 'Area dividida en dos.');
}

async function splitByPicking(shape) {
    closeSplitModal();
    if (shape.closed) {
        const first = await startPick('Toca el primer punto del contorno', { onlyPoint: true });
        if (!first) return;
        const a = projectOnPath(shape.pts, first.point.x, first.point.y);
        const second = await startPick('Ahora toca el segundo punto del contorno', { onlyPoint: true });
        if (!second) return;
        const b = projectOnPath(shape.pts, second.point.x, second.point.y);
        await splitClosedShape(shape, a.along, b.along);
        return;
    }
    const result = await startPick('Toca el punto de corte sobre el elemento', { onlyPoint: true });
    if (!result) return;
    const cut = projectOnPath(shape.pts, result.point.x, result.point.y);
    await splitOpenShape(shape, [cut.along]);
}

async function mergeSelection() {
    const shapes = state.selection.map((id) => state.shapesById.get(id)).filter(Boolean);
    const result = chain(shapes, joinTolerance(state.sceneBounds));
    if (result.error) return toast(result.error);
    const parts = [{ pts: result.pts, closed: result.closed }];
    const closedNote = result.closed ? ' El recorrido quedo cerrado.' : '';
    await commitEdit(makeEdit('union', shapes, parts), `${shapes.length} elementos unidos.${closedNote}`);
}

async function undoEdit(editId) {
    const before = state.project.edits || [];
    const { edits, removed } = removeEdit(before, editId);
    if (removed.length > 1 && !confirm(
        `Sobre este elemento hay ${removed.length - 1} edicion(es) posterior(es) que tambien se deshacen. ¿Continuar?`
    )) return;

    // Elementos que vuelven a existir al deshacer: los origenes de lo eliminado.
    const restored = new Set();
    for (const edit of before) {
        if (removed.includes(edit.id)) for (const id of edit.from) restored.add(id);
    }

    state.project.edits = edits;
    applyLayers();

    // Las tareas que apuntaban a partes eliminadas vuelven a su estado previo.
    const touched = [];
    const undone = before.filter((edit) => removed.includes(edit.id)).reverse();
    for (const edit of undone) {
        const partIds = new Set(edit.parts.map((part) => part.id));
        for (const snapshot of edit.taskRefs || []) {
            const task = state.tasks.find((t) => t.id === snapshot.taskId);
            if (!task) continue;
            const kept = task.elements.filter((ref) => !partIds.has(ref.id));
            for (const ref of snapshot.refs) {
                if (!state.shapesById.has(ref.id)) continue;
                if (!kept.some((r) => r.id === ref.id)) kept.push({ ...ref });
            }
            task.elements = kept;
            task.updatedAt = Date.now();
            if (!touched.includes(task)) touched.push(task);
        }
    }

    // Ediciones antiguas, sin ese registro: se reparte entre lo restaurado.
    const candidates = [...restored].map((id) => state.shapesById.get(id)).filter(Boolean);
    for (const task of state.tasks) {
        const next = [];
        const seen = new Set();
        let changed = false;
        for (const ref of task.elements) {
            if (state.shapesById.has(ref.id)) {
                if (!seen.has(ref.id)) { next.push(ref); seen.add(ref.id); }
                continue;
            }
            changed = true;
            for (const shape of candidates) {
                if (seen.has(shape.id)) continue;
                next.push(inheritRef(shape, ref));
                seen.add(shape.id);
            }
        }
        if (changed) {
            task.elements = next;
            task.updatedAt = Date.now();
            if (!touched.includes(task)) touched.push(task);
        }
    }

    // El avance se recalcula: puede haber cambiado la longitud ejecutada.
    for (const task of touched) {
        if (tracksElements(task)) task.progress = Math.round(progressFromElements(task, state.shapesById));
    }

    await saveProject(state.project);
    if (touched.length) await saveTasks(touched);
    setSelection([]);
    renderAll();
    toast(removed.length > 1 ? `${removed.length} ediciones deshechas.` : 'Edicion deshecha.');
}

function wireSplitModal() {
    $('#btn-split-pick').addEventListener('click', () => {
        const shape = state.splitTarget;
        if (shape) splitByPicking(shape);
    });
    $('#btn-split-equal').addEventListener('click', async () => {
        const shape = state.splitTarget;
        if (!shape) return;
        const parts = Math.round(Number($('#split-parts').value));
        if (!Number.isFinite(parts) || parts < 2) return toast('Indica cuantas partes (2 o mas).');
        closeSplitModal();
        await splitOpenShape(shape, equalCuts(shape, parts));
    });
    $('#btn-split-distance').addEventListener('click', async () => {
        const shape = state.splitTarget;
        if (!shape) return;
        const distance = Number($('#split-distance').value);
        if (!Number.isFinite(distance) || distance <= 0) return toast('Indica una distancia valida.');
        closeSplitModal();
        await splitOpenShape(shape, [distance]);
    });
}

/* ------------------------------------------------------------------ */
/* Modo "elegir del plano"                                             */
/* ------------------------------------------------------------------ */

function startPick(message, { allowPoint = false, onlyPoint = false, multi = false, onEach = null } = {}) {
    return new Promise((resolve) => {
        state.pick = { resolve, allowPoint, onlyPoint, multi, onEach };
        $('#pick-text').textContent = message;
        $('#btn-cancel-pick').textContent = multi ? 'Listo' : 'Cancelar';
        $('#pick-banner').classList.remove('hidden');
        togglePanel(false);
    });
}

function endPick(result) {
    const pick = state.pick;
    state.pick = null;
    $('#pick-banner').classList.add('hidden');
    $('#btn-cancel-pick').textContent = 'Cancelar';
    if (pick) pick.resolve(result);
}

/* ------------------------------------------------------------------ */
/* Panel: pestanas, tareas, elemento                                   */
/* ------------------------------------------------------------------ */

function wirePanel() {
    for (const tab of $$('.tab')) {
        tab.addEventListener('click', () => {
            for (const other of $$('.tab')) other.classList.toggle('active', other === tab);
            for (const panel of $$('.tab-panel')) panel.classList.toggle('active', panel.dataset.panel === tab.dataset.tab);
            if (tab.dataset.tab === 'programa') renderSchedule();
        });
    }
    $('#panel-handle').addEventListener('click', () => togglePanel(false));

    $('#filter-text').addEventListener('input', (e) => { state.filters.text = e.target.value; renderTasks(); });
    $('#filter-status').addEventListener('change', (e) => { state.filters.status = e.target.value; renderTasks(); });
    $('#filter-layer').addEventListener('change', (e) => { state.filters.layer = e.target.value; renderTasks(); });

    $('#btn-layers-all').addEventListener('click', async () => {
        for (const layer of state.layers.values()) if (layer.imported) layer.visible = true;
        applyLayers(); renderLayers(); await persistLayers();
    });
    $('#btn-layers-none').addEventListener('click', async () => {
        for (const layer of state.layers.values()) if (layer.imported) layer.visible = false;
        applyLayers(); renderLayers(); await persistLayers();
    });
    $('#btn-layers-import').addEventListener('click', async () => {
        const layers = [...state.layers.values()];
        const chosen = await askLayers(layers, new Set(layers.filter((l) => l.imported).map((l) => l.name)), 'Capas del archivo');
        if (!chosen) return;
        for (const layer of state.layers.values()) layer.imported = chosen.has(layer.name);
        applyLayers();
        renderAll();
        await persistLayers();
    });

    $('#btn-export-csv').addEventListener('click', () => {
        if (!state.tasks.length) return toast('No hay tareas para exportar.');
        const csv = tasksToCsv(state.tasks, {
            shapesById: state.shapesById,
            resources: state.resources,
            activities: state.activities,
            metersPerUnit: state.unitScale
        });
        download(`${state.project.name}-tareas.csv`, csv, 'text/csv;charset=utf-8');
    });
    $('#btn-export-elements').addEventListener('click', () => {
        const withElements = state.tasks.filter((task) => task.elements.length);
        if (!withElements.length) return toast('Ninguna tarea tiene tramos vinculados.');
        download(
            `${state.project.name}-tramos.csv`,
            elementsToCsv(withElements, state.shapesById, state.unitScale, state.activities),
            'text/csv;charset=utf-8'
        );
    });
    $('#btn-export-json').addEventListener('click', () => {
        const json = projectToJson(state.project, state.tasks, {
            includeDxf: true,
            resources: state.resources,
            places: state.places,
            activities: state.activities
        });
        download(`${state.project.name}.json`, json, 'application/json');
        toast('Copia generada (incluye plano, recursos, ubicaciones y divisiones).');
    });
}

function renderAll() {
    renderLayers();
    renderLayerFilter();
    renderResourceFilter();
    renderResources();
    renderPlaces();
    renderTasks();
    renderSchedule();
    renderSelectionCard();
    renderElementPanel();
    renderWizardButton();
}

/**
 * Avance del proyecto ponderado por cantidad de obra. Sin divisiones, un muro
 * de 50 m es una sola tarea; dividido, cada trozo pesa lo que realmente mide.
 */
function renderProgress() {
    const box = $('#progress-summary');
    box.innerHTML = '';
    if (!state.tasks.length) return;

    const summary = progressSummary(state.tasks, state.shapesById, state.unitScale);
    const units = state.project.units === 'sin unidad' ? '' : ` ${state.project.units}`;

    const rows = [];
    if (summary.length.pct !== null) {
        rows.push({
            label: 'Avance por longitud',
            pct: summary.length.pct,
            detail: `${formatNumber(summary.length.done)} de ${formatNumber(summary.length.total)}${units} vinculados a tareas`
        });
    }
    if (summary.area.pct !== null) {
        rows.push({
            label: 'Avance por area',
            pct: summary.area.pct,
            detail: `${formatNumber(summary.area.done)} de ${formatNumber(summary.area.total)}${units}² vinculados a tareas`
        });
    }
    if (summary.volume.pct !== null) {
        rows.push({
            label: 'Avance por volumen',
            pct: summary.volume.pct,
            detail: `${formatNumber(summary.volume.done)} de ${formatNumber(summary.volume.total)} m³ excavados`
        });
    }
    if (summary.elements.total) {
        rows.push({
            label: 'Tramos ejecutados',
            pct: (summary.elements.done / summary.elements.total) * 100,
            detail: `${summary.elements.done} de ${summary.elements.total} tramos`
        });
    }
    if (!rows.length) {
        rows.push({
            label: 'Avance por tareas',
            pct: summary.tasks.pct,
            detail: `${summary.tasks.count} tarea(s)`
        });
    }

    for (const row of rows) {
        const line = document.createElement('div');
        line.className = 'progress-line';
        line.innerHTML = `
            <div class="progress-head"><span></span><strong></strong></div>
            <div class="progress-bar"><span></span></div>
            <small class="muted"></small>`;
        line.querySelector('span').textContent = row.label;
        line.querySelector('strong').textContent = `${Math.round(row.pct)}%`;
        line.querySelector('.progress-bar span').style.width = `${Math.max(0, Math.min(100, row.pct))}%`;
        line.querySelector('small').textContent = row.detail;
        box.append(line);
    }
}

function renderLayerFilter() {
    const select = $('#filter-layer');
    const current = state.filters.layer;
    select.innerHTML = '';
    select.append(new Option('Todas las capas', 'todas'));
    for (const layer of state.layers.values()) {
        if (layer.imported) select.append(new Option(layer.name, layer.name));
    }
    select.value = [...select.options].some((o) => o.value === current) ? current : 'todas';
    state.filters.layer = select.value;
}

function renderTasks() {
    const list = $('#task-list');
    const resourceNames = new Map(state.resources.map((r) => [r.id, `${r.name} ${r.role || ''}`]));
    const visible = filterTasks(state.tasks, { ...state.filters, resourceNames });
    const visibleIds = new Set(visible.map((task) => task.id));
    list.innerHTML = '';
    renderProgress();

    const stats = summarize(state.tasks);
    const summary = $('#task-summary');
    summary.innerHTML = '';
    summary.append(chip(`${stats.total} tareas`, null));
    for (const status of STATUSES) {
        if (!stats.counts[status.id]) continue;
        summary.append(chip(`${stats.counts[status.id]} ${status.label.toLowerCase()}`, status.color));
    }
    if (stats.overdue) summary.append(chip(`${stats.overdue} vencidas`, '#ef4444'));
    if (!state.activeActivity && visible.length > MARKER_LIMIT) {
        summary.append(chip('toca una actividad para verla en el plano', null));
    }
    $('#btn-clear-activity').hidden = !state.activeActivity;

    if (!state.tasks.length && !state.activities.length) {
        list.innerHTML = '<li class="empty">Crea una actividad (excavacion, tendido…) y ve agregando sus tramos.</li>';
        renderMarkers(visible);
        return;
    }

    // Las tareas se agrupan bajo su actividad; al final, las que no tienen.
    const groups = state.activities.map((activity) => ({
        activity,
        tasks: tasksOf(activity.id, state.tasks)
    }));
    const loose = looseTasks(state.tasks, state.activities);
    if (loose.length) groups.push({ activity: null, tasks: loose });

    let counter = 0;
    for (const group of groups) {
        const shown = group.tasks.filter((task) => visibleIds.has(task.id));
        if (!shown.length && group.tasks.length && !state.activities.length) continue;
        list.append(renderActivityGroup(group, shown, () => ++counter));
    }

    if (!visible.length && state.tasks.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'Ninguna tarea coincide con el filtro.';
        list.append(empty);
    }

    renderMarkers(visible);
}

/** Cabecera de actividad con su avance, mas sus tramos. */
function renderActivityGroup(group, shown, nextNumber) {
    const { activity } = group;
    const item = document.createElement('li');
    item.className = 'activity-group';
    if (activity) item.dataset.id = activity.id;
    if (activity && state.activeActivity === activity.id) item.classList.add('on');

    const progress = activity
        ? activityProgress(activity.id, state.tasks, state.shapesById, state.unitScale)
        : null;

    if (activity && state.activities.length > 1) {
        item.classList.add('has-drag');
        item.append(dragHandle('Arrastra para cambiar la secuencia de la obra'));
    }

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'activity-head';
    const collapsed = activity ? !!activity.collapsed : false;
    head.innerHTML = `
        <span class="activity-caret"></span>
        <span>
            <span class="activity-name"><span class="activity-dot"></span><strong></strong></span>
            <div class="activity-sub"></div>
        </span>
        <span class="activity-pct"></span>`;
    head.querySelector('.activity-caret').textContent = collapsed ? '▶' : '▼';
    head.querySelector('.activity-dot').style.background = activity ? activity.color : '#64748b';
    head.querySelector('strong').textContent = activity ? activity.name : 'Sin actividad';

    const units = state.project.units === 'sin unidad' ? '' : ` ${state.project.units}`;
    const sub = [];
    sub.push(`${group.tasks.length} tramo(s)`);
    if (progress && progress.total.length) {
        sub.push(`${formatNumber(progress.done.length)} de ${formatNumber(progress.total.length)}${units}`);
    }
    if (progress && progress.total.volume) sub.push(`${formatNumber(progress.done.volume)} m³`);
    head.querySelector('.activity-sub').textContent = sub.join(' · ');
    head.querySelector('.activity-pct').textContent = progress ? `${Math.round(progress.pct)}%` : '';

    // Tocar la cabecera resalta toda la actividad en el plano; el triangulo
    // despliega sus tramos, que es la unica forma de volver a abrirla cuando la
    // obra llego plegada por tener cientos de tramos.
    const caret = head.querySelector('.activity-caret');
    caret.title = collapsed ? 'Ver sus tramos' : 'Plegar';
    caret.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleCollapse(activity);
    });
    head.addEventListener('click', () => {
        if (!activity) return toggleCollapse(null);
        selectActivity(state.activeActivity === activity.id ? null : activity.id);
    });
    item.append(head);

    if (progress && progress.total.length) {
        const bar = document.createElement('div');
        bar.className = 'activity-bar';
        const fill = document.createElement('span');
        fill.style.width = `${Math.max(0, Math.min(100, progress.pct))}%`;
        bar.append(fill);
        item.append(bar);
    }

    if (collapsed) return item;

    const tasks = document.createElement('ul');
    tasks.className = 'activity-tasks';
    for (const task of shown) tasks.append(renderTaskItem(task, nextNumber()));
    if (!shown.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = activity ? 'Sin tramos todavia.' : '';
        tasks.append(empty);
    }
    item.append(tasks);

    if (activity) {
        const actions = document.createElement('div');
        actions.className = 'activity-actions';

        const add = document.createElement('button');
        add.className = 'ghost small';
        add.textContent = `+ Tramo de ${activity.name}`;
        add.addEventListener('click', (e) => { e.stopPropagation(); startTaskInActivity(activity); });

        const bulk = document.createElement('button');
        bulk.className = 'ghost small';
        bulk.textContent = '+ Desde capa…';
        bulk.title = 'Crear un tramo por cada elemento de una capa';
        bulk.addEventListener('click', (e) => { e.stopPropagation(); openBulkModal(activity); });

        const edit = document.createElement('button');
        edit.className = 'ghost small';
        edit.textContent = 'Editar';
        edit.addEventListener('click', (e) => { e.stopPropagation(); openActivityModal(activity, false); });

        const up = document.createElement('button');
        up.className = 'ghost small';
        up.textContent = '↑';
        up.title = 'Subir';
        up.addEventListener('click', (e) => { e.stopPropagation(); moveActivity(activity.id, -1); });

        const down = document.createElement('button');
        down.className = 'ghost small';
        down.textContent = '↓';
        down.title = 'Bajar';
        down.addEventListener('click', (e) => { e.stopPropagation(); moveActivity(activity.id, 1); });

        actions.append(add, bulk, edit, up, down);
        item.append(actions);
    }
    return item;
}

function renderTaskItem(task, index) {
    const status = statusOf(task.status);
    const item = document.createElement('li');
    item.className = 'task-item';
    item.dataset.id = task.id;
    item.style.setProperty('--status', status.color);
    item.innerHTML = `
        <div class="task-color"></div>
        <div class="task-main">
            <strong></strong>
            <div class="task-meta"></div>
        </div>
        <div class="task-actions">
            <button data-focus title="Ver en el plano" aria-label="Ver en el plano">◎</button>
            <button data-edit title="Editar" aria-label="Editar">✎</button>
        </div>`;
    // El orden de los tramos es el orden en que se ejecutan: se puede arrastrar
    // para empezar por un sector y seguir por otro.
    if (task.activityId) {
        item.querySelector('.task-actions').append(dragHandle('Arrastra para cambiar en que orden se ejecuta', true));
    }
    item.querySelector('strong').textContent = `${index}. ${task.title || '(sin titulo)'}`;
    const meta = item.querySelector('.task-meta');
    meta.append(tag(status.label));
    const layers = [...new Set(task.elements.map((e) => e.layer))];
    if (layers.length) meta.append(tag(layers.join(', ')));
    if (task.elements.length) meta.append(tag(`${task.elements.length} tramo(s)`));
    for (const id of task.resources || []) {
        const resource = resourceById(id);
        if (resource) meta.append(tag(`${typeOf(resource.type).icon} ${resource.name}`));
    }
    if (task.due) meta.append(tag(`Vence ${task.due}`, isOverdue(task)));

    const progress = taskProgress(task);
    if (progress > 0) {
        const bar = document.createElement('div');
        bar.className = 'task-progress';
        const fill = document.createElement('span');
        fill.style.width = `${progress}%`;
        fill.style.background = status.color;
        const value = document.createElement('em');
        value.textContent = `${progress}%`;
        bar.append(fill, value);
        item.querySelector('.task-main').append(bar);
    }

    item.querySelector('[data-focus]').addEventListener('click', (e) => { e.stopPropagation(); focusTask(task); });
    item.querySelector('[data-edit]').addEventListener('click', (e) => { e.stopPropagation(); openTaskModal(task); });
    item.addEventListener('click', () => focusTask(task));
    return item;
}

function chip(text, color) {
    const element = document.createElement('span');
    element.className = 'chip';
    if (color) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.background = color;
        element.append(dot);
    }
    element.append(document.createTextNode(text));
    return element;
}

function tag(text, danger = false) {
    const element = document.createElement('span');
    element.className = danger ? 'tag overdue' : 'tag';
    element.textContent = text;
    return element;
}

/** A partir de aqui los globos de tarea estorban mas de lo que ayudan. */
const MARKER_LIMIT = 60;

/**
 * Tramos que llevan globo en el plano.
 *
 * Una obra armada desde el plano tiene cientos de tramos, y varias actividades
 * recorren la misma zanja: dibujarlos todos tapa el dibujo con una pila de
 * globos superpuestos. Al elegir una actividad se ven los suyos; mientras
 * tanto, el plano se deja limpio y el avance se lee por el color.
 */
function markersFor(tasks) {
    if (state.activeActivity) return tasks.filter((task) => task.activityId === state.activeActivity);
    return tasks.length > MARKER_LIMIT ? [] : tasks;
}

function refreshMarkers() {
    renderMarkers(filterTasks(state.tasks, { ...state.filters, resourceNames: new Map() }));
}

function renderMarkers(tasks) {
    const markers = [];
    const date = timelineActive() ? state.timeline.date : null;

    // Con el cursor activo solo se ven los puntos vigentes a esa fecha.
    const places = date ? placesAt(state.places, date) : state.places;
    for (const place of places) {
        const count = (place.resources || []).length;
        markers.push({
            id: place.id,
            kind: 'place',
            x: place.x,
            y: place.y,
            color: placeColor(place, state.resources),
            label: placeIcon(place, state.resources),
            badge: count > 1 ? String(count) : '',
            active: state.placeDraft ? state.placeDraft.id === place.id : false
        });
    }

    // Una obra armada desde el plano tiene cientos de tramos, y varias
    // actividades recorren la misma zanja: dibujarlos todos tapa el dibujo con
    // una pila de globos. Mientras no se elija una actividad, el plano se deja
    // limpio y el avance se lee por el color de la geometria.
    const shown = markersFor(tasks);
    // El numero del globo es el que lleva la tarea en la lista, aunque se
    // dibuje solo una parte: si no, el 3 del plano no seria el 3 del panel.
    const numbers = new Map(tasks.map((task, index) => [task.id, index + 1]));

    const timeState = date ? projectStateAt(state.tasks, state.shapesById, date, state.unitScale) : null;
    shown.forEach((task) => {
        const anchor = taskAnchor(task);
        if (!anchor) return;
        let color = statusOf(task.status).color;
        if (timeState) {
            // El color refleja como estaba la tarea ese dia, no como esta hoy.
            const at = timeState.perTask.get(task.id);
            const real = at && at.real !== null ? at.real : 0;
            if (real >= 1) color = statusOf('completada').color;
            else if (real > 0) color = statusOf('en_curso').color;
            else if (at && at.late) color = statusOf('bloqueada').color;
            else color = statusOf('pendiente').color;
        }
        markers.push({
            id: task.id,
            x: anchor.x,
            y: anchor.y,
            color,
            label: String(numbers.get(task.id) || ''),
            active: state.draft ? state.draft.id === task.id : false
        });
    });
    viewer.setMarkers(markers);
}

const DONE_COLOR = '#22c55e';
const PENDING_COLOR = '#ef4444';

/**
 * Trozos de linea a pintar para una tarea: verde lo ejecutado y rojo lo
 * pendiente. Un mismo elemento puede llevar solo unos metros hechos, y cada
 * actividad tiene los suyos, asi que se recorta la polilinea segun haga falta.
 */
function overlaysForTask(task, date = null) {
    const out = [];
    for (const ref of task.elements || []) {
        const shape = state.shapesById.get(ref.id);
        if (!shape) continue;
        const m = measure(shape);

        // Areas y puntos no tienen metros: van enteros.
        if (!m || (shape.closed && m.area)) {
            const done = ref.done && (!date || (ref.doneAt && ref.doneAt <= date));
            out.push({ pts: shape.pts, color: done ? DONE_COLOR : PENDING_COLOR });
            continue;
        }

        const total = m.length;
        let spans = refSpans(ref, total);
        if (date) spans = normalizeSpans(spans.filter((s) => !s.date || s.date <= date), total);
        if (!spans.length) {
            out.push({ pts: shape.pts, color: PENDING_COLOR });
            continue;
        }
        let cursor = 0;
        for (const span of spans) {
            if (span.from > cursor + 1e-9) {
                out.push({ pts: sliceRange(shape.pts, cursor, span.from), color: PENDING_COLOR });
            }
            out.push({ pts: sliceRange(shape.pts, span.from, span.to), color: DONE_COLOR });
            cursor = span.to;
        }
        if (cursor < total - 1e-9) {
            out.push({ pts: sliceRange(shape.pts, cursor, total), color: PENDING_COLOR });
        }
    }
    return out;
}

/**
 * Resalta los tramos de una tarea: verde los ejecutados, el color del estado
 * los pendientes. Con la linea de tiempo abierta manda la fecha del cursor.
 */
function applyTaskHighlight(task) {
    if (timelineActive() || state.activeActivity) return;
    if (!task || !task.elements.length) return clearTaskHighlight();
    // El resto del plano se apaga para que se lea solo esta actividad.
    viewer.setTaskHighlight(overlaysForTask(task), true);
}

function clearTaskHighlight() {
    if (timelineActive()) return;
    viewer.setTaskHighlight(null);
}

function focusTask(task) {
    const anchor = taskAnchor(task);
    applyTaskHighlight(task);
    const ids = task.elements.map((e) => e.id).filter((id) => state.shapesById.has(id));
    if (ids.length) {
        setSelection(ids);
        const shape = state.shapesById.get(ids[0]);
        viewer.focusShape(shape);
    } else if (anchor) {
        setSelection([]);
        viewer.centerOn(anchor.x, anchor.y);
    }
    if (window.matchMedia('(max-width: 900px)').matches) togglePanel(false);
}

function renderElementPanel() {
    const container = $('#element-detail');
    container.innerHTML = '';
    if (!state.selection.length) {
        container.innerHTML = '<p class="empty">Toca un elemento del plano para ver sus datos y sus tareas.</p>';
        return;
    }
    for (const id of state.selection.slice(0, 12)) {
        const shape = state.shapesById.get(id);
        if (!shape) continue;
        const anchor = anchorOf(shape);
        const block = document.createElement('div');
        const dl = document.createElement('dl');
        const rows = [
            ['Tipo', KIND_LABELS[shape.kind] || shape.kind],
            ['Capa', shape.layer],
            ['Origen', shape.derived
                ? (shape.editOp === 'union' ? 'Union de elementos' : 'Division de un elemento')
                : shape.entityType],
            ['Posicion', `${formatNumber(anchor.x)} , ${formatNumber(anchor.y)}`],
            ['Medida', describeMeasure(shape)],
            ['Id', shape.id]
        ];
        for (const [label, value] of rows) {
            const dt = document.createElement('dt');
            dt.textContent = label;
            const dd = document.createElement('dd');
            dd.textContent = value;
            dl.append(dt, dd);
        }
        block.append(dl);

        const related = state.tasks.filter((task) => task.elements.some((e) => e.id === id));
        const heading = document.createElement('strong');
        heading.textContent = related.length ? `Tareas de este elemento (${related.length})` : 'Sin tareas asociadas';
        block.append(heading);
        const ul = document.createElement('ul');
        ul.className = 'task-mini-list';
        for (const task of related) {
            const li = document.createElement('li');
            const button = document.createElement('button');
            button.className = 'task-mini';
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.style.background = statusOf(task.status).color;
            button.append(dot, document.createTextNode(task.title || '(sin titulo)'));
            button.addEventListener('click', () => openTaskModal(task));
            li.append(button);

            // Marcar el tramo estando frente a el, sin abrir la tarea.
            const ref = task.elements.find((e) => e.id === id);
            const totalLength = shape.closed ? 0 : pathLength(shape.pts);
            const executed = totalLength ? refDoneLength(ref, totalLength) : 0;
            const complete = totalLength ? isRefDone(ref, totalLength) : !!ref.done;
            const partial = executed > 0 && !complete;

            const mark = document.createElement('button');
            mark.className = 'mark-done' + (complete ? ' on' : partial ? ' partial' : '');
            mark.textContent = complete
                ? '✓ Hecho'
                : partial ? `${formatNumber(executed)} hechos` : 'Marcar hecho';
            mark.title = complete
                ? `Ejecutado el ${refLastDate(ref) || ''}`
                : partial ? 'Toca para completar el tramo' : 'Marcar este tramo como ejecutado';
            mark.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleElementDone(task, id);
            });
            li.append(mark);
            ul.append(li);
        }
        block.append(ul);
        container.append(block);
    }

    container.append(geometryActions());

    const action = document.createElement('button');
    action.className = 'btn primary';
    action.textContent = 'Nueva tarea con esta seleccion';
    action.addEventListener('click', () => startNewTask());
    container.append(action);
}

/** Marca o desmarca un tramo de una tarea y guarda de inmediato. */
async function toggleElementDone(task, elementId) {
    const ref = task.elements.find((e) => e.id === elementId);
    if (!ref) return;
    const shape = state.shapesById.get(elementId);
    const total = shape ? pathLength(shape.pts) : 0;
    const wasDone = total > 0 ? isRefDone(ref, total) : !!ref.done;

    if (wasDone) {
        ref.done = false;
        ref.doneAt = null;
        ref.spans = [];
    } else {
        ref.done = true;
        ref.doneAt = ref.doneAt || todayDate();
        if (total > 0) ref.spans = normalizeSpans([{ from: 0, to: total, date: ref.doneAt }], total);
    }
    await saveAdvancedTask(task, wasDone ? 'Tramo pendiente.' : 'Tramo completo.');
}


/** Botonera de division / union para la seleccion actual. */
function geometryActions() {
    const box = document.createElement('div');
    box.className = 'geometry-actions';

    const title = document.createElement('strong');
    title.textContent = 'Geometria';
    box.append(title);

    const shapes = state.selection.map((id) => state.shapesById.get(id)).filter(Boolean);
    const buttons = document.createElement('div');
    buttons.className = 'geometry-buttons';

    if (shapes.length === 1) {
        const shape = shapes[0];
        // Registrar avance solo tiene sentido en tramos lineales.
        if (canSplit(shape) && !shape.closed) {
            const advance = document.createElement('button');
            advance.className = 'btn small primary';
            advance.textContent = 'Registrar avance…';
            advance.addEventListener('click', () => openAdvanceModal(shape));
            buttons.append(advance);
        }
        if (canSplit(shape)) {
            const split = document.createElement('button');
            split.className = 'btn small';
            split.textContent = shape.closed ? 'Dividir el area…' : 'Dividir…';
            split.addEventListener('click', () => openSplitModal(shape));
            buttons.append(split);
        }
    } else if (shapes.length >= 2) {
        const merge = document.createElement('button');
        merge.className = 'btn small';
        merge.textContent = `Unir ${shapes.length} elementos`;
        merge.addEventListener('click', () => mergeSelection());
        buttons.append(merge);
    }

    // Deshacer alcanza a cualquier elemento derivado que este seleccionado.
    const derived = shapes.filter((shape) => shape.derived);
    if (derived.length) {
        const undo = document.createElement('button');
        undo.className = 'btn small';
        undo.textContent = derived[0].editOp === 'union' ? 'Deshacer la union' : 'Deshacer la division';
        undo.addEventListener('click', () => undoEdit(derived[0].editId));
        buttons.append(undo);
    }

    if (!buttons.childElementCount) {
        const hint = document.createElement('p');
        hint.className = 'muted';
        hint.textContent = shapes.length > 1
            ? 'Selecciona elementos de la misma capa que se toquen por sus extremos para unirlos.'
            : 'Este elemento no se puede dividir.';
        box.append(hint);
        return box;
    }

    box.append(buttons);
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = shapes.length === 1 && !shapes[0].closed
        ? 'Al dividir, cada trozo queda como un elemento independiente con su propia longitud y sus propias tareas.'
        : 'Las divisiones y uniones no modifican el archivo DXF: se guardan en el proyecto y se pueden deshacer.';
    box.append(hint);
    return box;
}




/* ------------------------------------------------------------------ */
/* Actividades: el nivel de arriba (excavacion, tendido, tapado...)    */
/* ------------------------------------------------------------------ */

/**
 * Al seleccionar una actividad, todo el plano muestra su avance: verde lo
 * ejecutado y rojo lo pendiente, sumando todos los tramos de todas sus tareas.
 */
function selectActivity(activityId) {
    state.activeActivity = activityId;
    if (!activityId) {
        clearTaskHighlight();
        renderTasks();
        return;
    }
    const overlays = [];
    for (const task of tasksOf(activityId, state.tasks)) overlays.push(...overlaysForTask(task));
    if (!overlays.length) toast('Esta actividad todavia no tiene tramos en el plano.');
    viewer.setTaskHighlight(overlays, true);
    renderTasks();
}

/** Vuelve a resaltar la actividad activa tras cualquier cambio. */
function refreshActivityHighlight() {
    if (state.activeActivity) selectActivity(state.activeActivity);
}

function toggleCollapse(activity) {
    if (!activity) return;
    activity.collapsed = !activity.collapsed;
    saveActivity(activity);
    renderTasks();
}

function openActivityModal(activity, isNew = false) {
    state.activityDraft = { ...activity, isNew };
    $('#activity-modal-title').textContent = isNew ? 'Nueva actividad' : 'Editar actividad';
    $('#activity-name').value = activity.name || '';
    $('#btn-delete-activity').hidden = isNew;
    renderActivityColors();
    $('#activity-modal').classList.remove('hidden');
    setTimeout(() => $('#activity-name').focus(), 50);
}

function closeActivityModal() {
    $('#activity-modal').classList.add('hidden');
    state.activityDraft = null;
}

function renderActivityColors() {
    const box = $('#activity-colors');
    box.innerHTML = '';
    for (const color of ACTIVITY_COLORS) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'color-chip' + (state.activityDraft.color === color ? ' on' : '');
        chip.style.background = color;
        chip.setAttribute('aria-label', `Color ${color}`);
        chip.addEventListener('click', () => {
            state.activityDraft.color = color;
            renderActivityColors();
        });
        box.append(chip);
    }
}

/** Nueva tarea dentro de una actividad, ya numerada y lista para vincular. */
function startTaskInActivity(activity) {
    // Empieza vacia a proposito: el tramo se elige tocandolo, no se hereda de
    // lo que hubiera seleccionado (tras dividir, por ejemplo, quedan varios).
    startNewTask({
        activityId: activity.id,
        title: nextTaskName(activity, state.tasks)
    }, { ignoreSelection: true });
}

/* ------------------------------------------------------------------ */
/* Tramos desde una capa: carga en bloque                              */
/* ------------------------------------------------------------------ */

/**
 * Con los circuitos en capas propias (MT-C1, MT-C2...) y la zanja en la suya,
 * cargar un circuito completo es tomar su capa y hacer un tramo por cada
 * polilinea. Eso es lo que hace este dialogo.
 */
function openBulkModal(activity) {
    state.bulkDraft = { activityId: activity.id };
    renderBulkActivities(activity.id);
    renderBulkLayers();
    $('#bulk-prefix').value = activity.name;
    $('#bulk-width').value = '';
    $('#bulk-depth').value = '';
    $('#bulk-ternas').value = '1';
    renderBulkPreview();
    $('#bulk-modal').classList.remove('hidden');
}

function closeBulkModal() {
    $('#bulk-modal').classList.add('hidden');
    state.bulkDraft = null;
}

function renderBulkActivities(current) {
    const select = $('#bulk-activity');
    select.innerHTML = '';
    for (const activity of state.activities) select.append(new Option(activity.name, activity.id));
    select.value = current;
}

/** Capas importadas, con cuantos elementos utiles tiene cada una. */
function renderBulkLayers() {
    const select = $('#bulk-layer');
    const previous = select.value;
    select.innerHTML = '';
    for (const layer of state.layers.values()) {
        if (!layer.imported) continue;
        const count = bulkShapesOf(layer.name).length;
        if (!count) continue;
        select.append(new Option(`${layer.name} (${count})`, layer.name));
    }
    if (!select.options.length) select.append(new Option('No hay capas con elementos', ''));
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}

/** Elementos de una capa que pueden ser un tramo (los que tienen recorrido). */
function bulkShapesOf(layerName) {
    return state.shapes.filter((shape) => shape.layer === layerName && measure(shape));
}

function renderBulkPreview() {
    const box = $('#bulk-preview');
    const layerName = $('#bulk-layer').value;
    const activity = activityById($('#bulk-activity').value);
    const shapes = bulkShapesOf(layerName);
    $('#bulk-ternas-row').hidden = !activity || rateOf(activity).unit !== 'ml_fase';

    if (!shapes.length) {
        box.textContent = 'Esa capa no tiene elementos con recorrido.';
        return;
    }
    // Los que ya estan en un tramo de esta actividad no se repiten.
    const taken = new Set();
    for (const task of tasksOf(activity ? activity.id : '', state.tasks)) {
        for (const ref of task.elements || []) taken.add(ref.id);
    }
    const nuevos = shapes.filter((shape) => !taken.has(shape.id));
    let length = 0;
    for (const shape of nuevos) length += (measure(shape).length || 0) * state.unitScale;

    box.textContent = nuevos.length
        ? `Se crearan ${nuevos.length} tramo(s) con ${formatNumber(length)} m en total`
          + (shapes.length !== nuevos.length ? ` (${shapes.length - nuevos.length} ya estaban cargados).` : '.')
        : 'Todos los elementos de esa capa ya estan en un tramo de esta actividad.';
}

async function submitBulk() {
    const activity = activityById($('#bulk-activity').value);
    const layerName = $('#bulk-layer').value;
    if (!activity || !layerName) return;

    const taken = new Set();
    for (const task of tasksOf(activity.id, state.tasks)) {
        for (const ref of task.elements || []) taken.add(ref.id);
    }
    const shapes = bulkShapesOf(layerName).filter((shape) => !taken.has(shape.id));
    if (!shapes.length) return toast('No hay elementos nuevos que cargar en esa capa.');

    const width = Number($('#bulk-width').value) || null;
    const depth = Number($('#bulk-depth').value) || null;
    const ternas = Math.max(1, Math.round(Number($('#bulk-ternas').value) || 1));
    const prefix = $('#bulk-prefix').value.trim() || activity.name;

    // Se numeran siguiendo lo que ya exista, en el orden en que vienen del plano.
    let number = nextBulkNumber(prefix);
    let order = tasksOf(activity.id, state.tasks).length;
    const created = [];
    for (const shape of shapes) {
        const ref = elementRef(shape, anchorOf(shape));
        if (width) ref.width = width;
        if (depth) ref.depth = depth;
        const task = createTask(state.project.id, {
            activityId: activity.id,
            order: order++,
            title: `${prefix} ${number}`,
            status: 'pendiente',
            ternas,
            elements: [ref]
        });
        created.push(task);
        number++;
    }

    await saveTasks(created);
    state.tasks.push(...created);
    closeBulkModal();
    renderTasks();
    renderSchedule();
    toast(`${created.length} tramo(s) creados desde la capa ${layerName}.`);
}

/** Siguiente numero libre para una serie "Prefijo N". */
function nextBulkNumber(prefix) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`^${escaped}\\s+(\\d+)$`, 'i');
    let highest = 0;
    for (const task of state.tasks) {
        const match = pattern.exec((task.title || '').trim());
        if (match) highest = Math.max(highest, Number(match[1]));
    }
    return highest + 1;
}

function wireBulk() {
    $('#bulk-activity').addEventListener('change', () => {
        const activity = activityById($('#bulk-activity').value);
        if (activity) $('#bulk-prefix').value = activity.name;
        renderBulkPreview();
    });
    $('#bulk-layer').addEventListener('change', renderBulkPreview);
    $('#bulk-form').addEventListener('submit', (e) => {
        e.preventDefault();
        submitBulk();
    });
}

/* ------------------------------------------------------------------ */
/* Asistente: armar la obra desde las capas del plano                  */
/* ------------------------------------------------------------------ */

/**
 * Clasificacion de las capas importadas segun la convencion de obra, o null
 * si este plano no la sigue. Se recalcula cada vez porque el usuario puede
 * cambiar las capas importadas desde la pestaña Capas.
 */
function schemeOf() {
    const names = [...state.layers.values()].filter((l) => l.imported).map((l) => l.name);
    const classification = classifyLayers(names);
    if (!classification.recognised) return null;
    if (!classification.trenches.length && classification.circuits.length < 2) return null;
    return classification;
}

/** El boton de armar solo tiene sentido si el plano viene clasificado. */
function renderWizardButton() {
    const button = $('#btn-wizard');
    if (!button) return;
    button.hidden = !schemeOf();
}

/**
 * Cuando el plano viene clasificado con la convencion de obra electrica
 * —tipos de zanja por un lado y circuitos por tramo por el otro— se ofrece
 * armar la obra completa de una vez: las actividades, todos los tramos con su
 * nombre y su seccion, y la verificacion de que la zanja alcanza para los
 * circuitos que pasan por ella.
 */
function openWizard() {
    const classification = schemeOf();
    if (!classification) return;
    state.wizard = {
        classification,
        // Las secciones vienen del tipo de zanja, pero se pueden corregir.
        sections: Object.fromEntries(classification.trenches.map((t) => [t.layer, { width: t.width, depth: t.depth }])),
        chosen: new Set(SUGGESTED_ACTIVITIES.map((a) => a.key))
    };
    renderWizard();
    $('#wizard-modal').classList.remove('hidden');
}

function closeWizard() {
    $('#wizard-modal').classList.add('hidden');
    state.wizard = null;
}

/** La clasificacion con las secciones que haya escrito el usuario. */
function wizardScheme() {
    const wizard = state.wizard;
    const classification = {
        ...wizard.classification,
        trenches: wizard.classification.trenches.map((t) => ({ ...t, ...wizard.sections[t.layer] }))
    };
    return { classification, summary: summarizeScheme(classification, state.shapes, state.unitScale) };
}

/** Cuantos tramos generaria una actividad propuesta. */
function wizardTaskCount(suggestion, classification) {
    const layers = new Set(layersFor(suggestion, classification));
    if (!layers.size) return 0;
    if (suggestion.target === 'circuito') {
        // La capa es el tramo: un cable de potencia por tramo de circuito.
        return [...layers].filter((name) => state.shapes.some((s) => s.layer === name && measure(s))).length;
    }
    return state.shapes.filter((s) => layers.has(s.layer) && measure(s)).length;
}

function renderWizard() {
    const wizard = state.wizard;
    if (!wizard) return;
    const { classification, summary } = wizardScheme();
    const units = state.project.units === 'sin unidad' ? 'm' : state.project.units;

    $('#wizard-intro').textContent = 'Este plano viene clasificado por tipo de zanja y por circuito, '
        + 'asi que puedo crear las actividades y todos sus tramos de una vez, cada uno con su nombre '
        + 'y su seccion. Revisa lo que encontre antes de crear.';

    /* --- Tipos de zanja, con su seccion editable --- */
    const box = $('#wizard-trenches');
    box.innerHTML = '';
    for (const trench of summary.trenches) {
        const row = document.createElement('div');
        row.className = 'wizard-row';
        row.innerHTML = '<span><strong></strong><small></small></span>'
            + '<input type="number" class="w-width" min="0.1" step="0.05" aria-label="Ancho">'
            + '<span class="times">×</span>'
            + '<input type="number" class="w-depth" min="0.1" step="0.05" aria-label="Profundidad">';
        row.querySelector('strong').textContent = trench.layer;
        row.querySelector('small').textContent =
            `${trench.count} tramo(s) · ${formatNumber(trench.meters)} ${units} · `
            + `${formatNumber(trench.volume)} m³ · ${trench.triadas} triada(s)`;

        const width = row.querySelector('.w-width');
        const depth = row.querySelector('.w-depth');
        width.value = String(trench.width);
        depth.value = String(trench.depth);
        const update = () => {
            wizard.sections[trench.layer] = {
                width: Number(width.value) || trench.width,
                depth: Number(depth.value) || trench.depth
            };
            renderWizard();
        };
        width.addEventListener('change', update);
        depth.addEventListener('change', update);
        box.append(row);
    }

    /* --- Circuitos --- */
    const circuits = $('#wizard-circuits');
    circuits.innerHTML = '';
    for (const circuito of summary.circuits) {
        const chip = document.createElement('span');
        chip.className = 'wizard-chip' + (circuito.empty ? ' empty' : '');
        chip.innerHTML = '<b></b><span></span>';
        chip.querySelector('b').textContent = `${circuito.familia}-${circuito.codigo}`;
        chip.querySelector('span').textContent = circuito.empty
            ? 'sin dibujo'
            : `${formatNumber(circuito.meters)} ${units}`;
        chip.title = circuito.layers.map((l) => `${l.from}-${l.to}`).join(' · ');
        circuits.append(chip);
    }
    $('#wizard-circuit-count').textContent = summary.circuits.length
        ? `${summary.circuits.length} · ${formatNumber(summary.circuitMeters)} ${units}`
        : 'ninguno';

    /* --- Actividades propuestas --- */
    const acts = $('#wizard-activities');
    acts.innerHTML = '';
    let total = 0;
    for (const suggestion of SUGGESTED_ACTIVITIES) {
        const count = wizardTaskCount(suggestion, classification);
        // Lo que el plano no dibuja no se ofrece: sin cruces no hay hormigonado.
        if (!count) { wizard.chosen.delete(suggestion.key); continue; }
        if (wizard.chosen.has(suggestion.key)) total += count;

        const row = document.createElement('label');
        row.className = 'wizard-act';
        row.innerHTML = '<input type="checkbox">'
            + '<span class="grow"><strong></strong><small></small></span>'
            + '<span class="count"></span>';
        const check = row.querySelector('input');
        check.checked = wizard.chosen.has(suggestion.key);
        check.addEventListener('change', () => {
            if (check.checked) wizard.chosen.add(suggestion.key);
            else wizard.chosen.delete(suggestion.key);
            renderWizard();
        });
        row.querySelector('strong').textContent = suggestion.name;
        row.querySelector('small').textContent = `se mide en ${rateUnitOf(suggestion.unit).label}`
            + (suggestion.scope === 'circuito' ? ' · se repite por circuito' : ' · una vez por zanja');
        row.querySelector('.count').textContent = `${count} tramos`;
        acts.append(row);
    }

    /* --- Verificacion: la zanja alcanza para los circuitos que pasan --- */
    renderWizardCheck(classification, units);

    /* --- Capas que quedan fuera --- */
    $('#wizard-skipped').textContent = classification.others.length
        ? `Fuera de la convencion, quedan solo como referencia: ${classification.others.join(', ')}.`
        : '';

    const create = $('#btn-wizard-create');
    create.textContent = total
        ? `Crear ${wizard.chosen.size} actividades y ${total} tramos`
        : 'Crear la obra';
    create.disabled = !total;
}

/**
 * Contrasta cuantas triadas declara cada zanja contra cuantos circuitos pasan
 * de verdad por ella. Es la unica comprobacion que puede delatar un error de
 * trazado antes de que alguien excave.
 */
function renderWizardCheck(classification, units) {
    const box = $('#wizard-check');
    box.innerHTML = '';
    if (!classification.circuits.length || !classification.trenches.length) return;

    const verification = verifyTriadas(classification, state.shapes, { metersPerUnit: state.unitScale });
    state.wizard.verification = verification;

    const panel = document.createElement('div');
    panel.className = 'wizard-check ' + (verification.tight.length ? 'bad' : 'good');
    const title = document.createElement('strong');
    if (verification.tight.length) {
        title.textContent = verification.tight.length === 1
            ? 'Hay una zanja donde la seccion no alcanza'
            : `Hay ${verification.tight.length} zanjas donde la seccion no alcanza`;
        panel.append(title);
        const list = document.createElement('ul');
        for (const row of verification.tight) {
            const item = document.createElement('li');
            item.textContent = `${row.layer}, ${formatNumber(row.meters)} ${units}: declara `
                + `${row.declared} triada(s) y pasan ${row.peak} circuitos `
                + `(${row.circuits.join(', ')}) a lo largo de ${formatNumber(row.excess)} ${units}.`;
            list.append(item);
        }
        panel.append(list);
        const hint = document.createElement('small');
        hint.textContent = 'Puede ser un tipo de zanja mal asignado o un circuito mal trazado. '
            + 'Se puede armar la obra igual y corregir el plano despues.';
        panel.append(hint);
    } else {
        title.textContent = `Las secciones alcanzan: ${verification.checked} zanjas contrastadas `
            + `contra ${verification.circuits} circuitos.`;
        panel.append(title);
    }
    if (verification.loose.length) {
        const loose = document.createElement('small');
        loose.textContent = `${verification.loose.length} zanja(s) con seccion holgada `
            + `(${formatNumber(verification.looseMeters)} ${units}): llevan menos circuitos de los que su tipo admite.`;
        panel.append(loose);
    }
    box.append(panel);
}

/**
 * Crea las actividades elegidas y sus tramos. Los de zanja salen de cada
 * polilinea, con su seccion y el nombre del recorrido que la cruza; los de
 * circuito salen de cada capa de circuito, que ya es un tramo por si misma.
 */
async function runWizard() {
    const wizard = state.wizard;
    if (!wizard) return;
    const { classification } = wizardScheme();
    const chosen = SUGGESTED_ACTIVITIES.filter((s) => wizard.chosen.has(s.key));
    if (!chosen.length) return;

    showLoading('Armando la obra…');
    await nextFrame();
    try {
        const used = state.activities.length;
        const activities = [];
        const byKey = new Map();
        chosen.forEach((suggestion, index) => {
            const activity = createActivity(state.project.id, {
                name: suggestion.name,
                order: used + index,
                color: ACTIVITY_COLORS[(used + index) % ACTIVITY_COLORS.length],
                rate: { unit: suggestion.unit, value: 0 },
                scope: suggestion.scope,
                crews: 1,
                // Las que abren una cadena se anclan a mano: los cruces corren
                // en paralelo a la zanja y reordenar no debe encadenarlos a ella.
                linksAuto: !suggestion.anchor
            });
            byKey.set(suggestion.key, activity);
            activities.push(activity);
        });

        // Encadenar las actividades saltando las que no se crearon: si no se
        // controla la cama de arena, el cobre pasa a colgar de la excavacion.
        for (const suggestion of chosen) {
            const links = [];
            for (const key of suggestion.after) {
                let current = key;
                let guard = 0;
                while (current && !byKey.has(current) && guard++ < SUGGESTED_ACTIVITIES.length) {
                    const previous = SUGGESTED_ACTIVITIES.find((s) => s.key === current);
                    current = previous && previous.after.length ? previous.after[0] : null;
                }
                if (current && byKey.has(current)) links.push({ id: byKey.get(current).id, lag: 0 });
            }
            byKey.get(suggestion.key).predecessors = links;
        }

        await nextFrame();
        showLoading('Nombrando los tramos…');
        await nextFrame();
        const trenchNames = nameTrenches(classification, state.shapes, { metersPerUnit: state.unitScale });
        const sectionByLayer = new Map(classification.trenches.map((t) => [t.layer, t]));
        const tramoOf = new Map();
        for (const circuito of classification.circuits) {
            for (const l of circuito.layers) tramoOf.set(l.layer, { circuito, tramo: `${l.from}-${l.to}` });
        }

        const tasks = [];
        for (const suggestion of chosen) {
            const activity = byKey.get(suggestion.key);
            const layers = new Set(layersFor(suggestion, classification));
            // Arrancan en el orden en que vienen del plano; desde ahi se
            // reordenan arrastrando, para empezar por el sector que convenga.
            let order = 0;

            if (suggestion.target === 'circuito') {
                for (const name of layers) {
                    const own = state.shapes.filter((s) => s.layer === name && measure(s));
                    if (!own.length) continue;
                    const info = tramoOf.get(name);
                    tasks.push(createTask(state.project.id, {
                        activityId: activity.id,
                        order: order++,
                        title: `${suggestion.name} ${info.circuito.codigo} ${info.tramo}`,
                        // Un circuito es una terna de fases R, S, T.
                        ternas: 1,
                        elements: own.map((shape) => elementRef(shape, anchorOf(shape)))
                    }));
                }
                continue;
            }

            for (const shape of state.shapes) {
                if (!layers.has(shape.layer) || !measure(shape)) continue;
                const ref = elementRef(shape, anchorOf(shape));
                const section = sectionByLayer.get(shape.layer);
                if (section) {
                    ref.width = section.width;
                    ref.depth = section.depth;
                }
                tasks.push(createTask(state.project.id, {
                    activityId: activity.id,
                    order: order++,
                    title: `${suggestion.name} ${trenchNames.get(shape.id) || shape.layer}`,
                    elements: [ref]
                }));
            }
        }

        await nextFrame();
        showLoading('Guardando…');
        await nextFrame();
        // Con cientos de tramos la lista se vuelve un rollo de diez mil pixeles,
        // imposible de recorrer y de reordenar: se entrega plegada.
        if (state.tasks.length + tasks.length > 60) {
            for (const activity of activities) {
                activity.collapsed = true;
                state.scheduleClosed.add(activity.id);
            }
        }
        await saveActivities(activities);
        await saveTasks(tasks);
        state.activities.push(...activities);
        state.activities.sort((a, b) => (a.order || 0) - (b.order || 0));
        state.tasks.push(...tasks);
        state.schedule = null;

        hideLoading();
        closeWizard();
        renderAll();
        toast(`${activities.length} actividades y ${tasks.length} tramos creados. `
            + 'Ponles rendimiento en Programa → Rendimientos para que calcule las fechas.');
    } catch (error) {
        hideLoading();
        console.error(error);
        alert('No se pudo armar la obra.\n\n' + (error.message || error));
    }
}

function wireWizard() {
    $('#btn-wizard').addEventListener('click', openWizard);
    $('#wizard-form').addEventListener('submit', (e) => {
        e.preventDefault();
        runWizard();
    });
}

/* ------------------------------------------------------------------ */
/* Orden de las actividades: la secuencia de la obra                   */
/* ------------------------------------------------------------------ */

/**
 * Arrastrar para reordenar, con el dedo o con el mouse.
 *
 * La lista se reacomoda en vivo bajo el dedo y al soltar se avisa con la
 * posicion final. Solo arranca desde el asa, para que el resto de la fila siga
 * respondiendo a los toques y el panel se pueda desplazar normalmente.
 */
function makeSortable(root, kinds) {
    let drag = null;

    // Los hermanos son los de su misma lista, no los de todo el panel: dentro de
    // una actividad se reordenan sus tramos, sin salirse de ella.
    const siblings = (item, selector) =>
        [...item.parentElement.children].filter((node) => node.matches(selector));

    const move = (e) => {
        if (!drag || e.pointerId !== drag.pointerId) return;
        e.preventDefault();

        // Se intercambia con el vecino cuyo centro ya quedo pasado.
        for (const other of siblings(drag.item, drag.selector)) {
            if (other === drag.item) continue;
            const box = other.getBoundingClientRect();
            const middle = box.top + box.height / 2;
            const below = drag.item.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING;
            if (below && e.clientY > middle) other.after(drag.item);
            else if (!below && e.clientY < middle) other.before(drag.item);
        }
        autoScroll(root, e.clientY);
    };

    const end = (e) => {
        if (!drag || (e && e.pointerId !== drag.pointerId)) return;
        const { item, id, from, selector, onDrop } = drag;
        drag = null;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        item.classList.remove('dragging');
        root.classList.remove('sorting');
        const to = siblings(item, selector).indexOf(item);
        // Aunque no haya cambiado de sitio hay que avisar: la lista quedo
        // movida a mano y solo volver a dibujarla la deja igual al modelo.
        onDrop(id, to >= 0 ? to : from);
    };

    root.addEventListener('pointerdown', (e) => {
        const handle = e.target.closest('[data-drag]');
        if (!handle || !root.contains(handle) || e.button > 0) return;

        // El primero que calce manda, asi que la lista viene de lo mas anidado a
        // lo menos: el asa de un tramo no debe mover la actividad entera.
        let kind = null;
        let item = null;
        for (const candidate of kinds) {
            const found = handle.closest(candidate.item);
            if (found && root.contains(found) && found.dataset.id) {
                kind = candidate;
                item = found;
                break;
            }
        }
        if (!item) return;

        e.preventDefault();
        drag = {
            item,
            id: item.dataset.id,
            selector: kind.item,
            onDrop: kind.onDrop,
            from: siblings(item, kind.item).indexOf(item),
            pointerId: e.pointerId
        };
        item.classList.add('dragging');
        root.classList.add('sorting');
        // Se escucha en la ventana y no en la lista: al mover la fila dentro del
        // DOM el navegador suelta la captura del puntero, y entonces el dedo
        // puede levantarse sobre cualquier otra cosa —o fuera de la pantalla—
        // sin que la lista llegue a enterarse de que hay que guardar.
        window.addEventListener('pointermove', move, { passive: false });
        window.addEventListener('pointerup', end);
        window.addEventListener('pointercancel', end);
    });
}

/** Acerca el borde: arrastrar hasta arriba o abajo desplaza la lista. */
function autoScroll(list, y) {
    const box = (list.closest('.panel-scroll') || list).getBoundingClientRect();
    const scroller = list.closest('.panel-scroll') || list;
    const margin = 48;
    if (y < box.top + margin) scroller.scrollTop -= 12;
    else if (y > box.bottom - margin) scroller.scrollTop += 12;
}

/** Asa de arrastre. En una fila con botones va en linea; si no, flotando. */
function dragHandle(title, inline = false) {
    const handle = document.createElement('span');
    handle.className = 'drag-handle' + (inline ? ' inline' : '');
    handle.dataset.drag = '';
    handle.textContent = '⠿';
    handle.title = title;
    handle.setAttribute('aria-hidden', 'true');
    return handle;
}

function wireSortable() {
    // De lo mas anidado a lo menos: primero el tramo, despues su actividad.
    makeSortable($('#task-list'), [
        { item: '.task-item', onDrop: dropTask },
        { item: '.activity-group', onDrop: dropActivity }
    ]);
    makeSortable($('#schedule-list'), [
        { item: '.tramo-row', onDrop: dropTask },
        { item: '.schedule-row', onDrop: dropActivity }
    ]);
}

/**
 * Cambia el orden en que se ataca un tramo dentro de su actividad. Es lo que
 * permite decir "esta semana partimos por este sector y despues por el otro":
 * entre tramos que pueden empezar el mismo dia, el programa sigue este orden.
 */
async function dropTask(id, target) {
    const task = taskById(id);
    if (!task || !task.activityId) return renderAll();
    const sorted = reorderTasks(task.activityId, state.tasks, id, target);
    if (sorted) await saveTasks(sorted);
    state.schedule = null;
    renderTasks();
    renderSchedule();
}

async function moveActivity(id, delta) {
    await applyOrder(reorder(state.activities, id, delta));
}

async function dropActivity(id, target) {
    await applyOrder(reorderTo(state.activities, id, target));
}

/**
 * Guarda un nuevo orden. Mover una actividad mueve la obra: la cadena se
 * reescribe para que cada una espere a la que quedo encima.
 */
async function applyOrder(sorted) {
    if (sorted) {
        state.activities = relinkChain(sorted);
        await saveActivities(state.activities);
    }
    // Se redibuja siempre, incluso si no hubo cambio: el arrastre movio las
    // filas a mano y hay que dejarlas como las tiene el modelo.
    renderTasks();
    renderSchedule();
}

function wireActivities() {
    $('#btn-new-activity').addEventListener('click', () => {
        const used = state.activities.length;
        openActivityModal(createActivity(state.project.id, {
            order: used,
            color: ACTIVITY_COLORS[used % ACTIVITY_COLORS.length]
        }), true);
    });

    $('#btn-clear-activity').addEventListener('click', () => selectActivity(null));

    $('#btn-toggle-filters').addEventListener('click', () => {
        const filters = $('#task-filters');
        const shown = filters.classList.toggle('hidden');
        $('#btn-toggle-filters').classList.toggle('on', !shown);
    });

    $('#activity-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const draft = state.activityDraft;
        if (!draft) return;
        draft.name = $('#activity-name').value.trim();
        if (!draft.name) return;

        const isNew = draft.isNew;
        delete draft.isNew;
        draft.projectId = state.project.id;
        await saveActivity(draft);
        const index = state.activities.findIndex((a) => a.id === draft.id);
        if (index >= 0) state.activities[index] = draft; else state.activities.push(draft);
        state.activities.sort((a, b) => (a.order || 0) - (b.order || 0));

        closeActivityModal();
        renderTasks();
        renderSchedule();
        toast(isNew ? `Actividad "${draft.name}" creada.` : 'Actividad actualizada.');
    });

    $('#btn-delete-activity').addEventListener('click', async () => {
        const draft = state.activityDraft;
        if (!draft) return;
        const own = tasksOf(draft.id, state.tasks);
        const warning = own.length
            ? `Esta actividad tiene ${own.length} tramo(s). Las tareas no se borran: quedaran sin actividad. ¿Eliminar?`
            : '¿Eliminar esta actividad?';
        if (!confirm(warning)) return;

        await deleteActivity(draft.id);
        state.activities = state.activities.filter((a) => a.id !== draft.id);
        // Nadie puede quedar enlazado a una actividad que ya no existe.
        const relinked = [];
        for (const activity of state.activities) {
            const links = (activity.predecessors || []).filter((p) => (typeof p === 'string' ? p : p.id) !== draft.id);
            if (links.length !== (activity.predecessors || []).length) {
                activity.predecessors = links;
                relinked.push(activity);
            }
        }
        if (relinked.length) await saveActivities(relinked);
        const touched = [];
        for (const task of own) {
            task.activityId = null;
            task.updatedAt = Date.now();
            touched.push(task);
        }
        if (touched.length) await saveTasks(touched);
        if (state.activeActivity === draft.id) selectActivity(null);

        closeActivityModal();
        renderTasks();
        renderSchedule();
        toast('Actividad eliminada.');
    });
}

/* ------------------------------------------------------------------ */
/* Programa maestro: rendimientos, antecesores por tramo y ruta critica */
/* ------------------------------------------------------------------ */

function scheduleCalendarId() {
    return (state.project && state.project.workdays) || 'todos';
}

/**
 * Metros dentro de los cuales dos tramos se consideran "en el mismo lugar".
 * Con los circuitos en capas propias y la zanja en la suya, es lo que permite
 * que el tendido reconozca su excavacion aunque sean polilineas distintas.
 */
function shareTolerance() {
    const value = Number(state.project && state.project.shareTolerance);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SHARE_TOLERANCE;
}

/**
 * Recalcula el programa completo. Es tramo a tramo: cada uno toma sus dias del
 * rendimiento de su actividad y espera solo a los tramos de su misma ubicacion.
 */
function schedulePlan() {
    if (!state.project) {
        return {
            tasks: new Map(), activities: new Map(), cycle: [], orphans: [],
            duplicates: [], clashes: [], from: todayDate(), to: todayDate()
        };
    }
    state.schedule = computeSchedule(state.activities, state.tasks, {
        start: state.project.scheduleStart || '',
        calendar: scheduleCalendarId(),
        shapesById: state.shapesById,
        metersPerUnit: state.unitScale,
        shareTolerance: shareTolerance(),
        resources: state.resources
    });
    return state.schedule;
}

/** Fecha corta (17/08) para las filas: el año ya va en el resumen. */
/** Monto con separador de miles, que es como se lee la plata en obra. */
function formatMoney(value) {
    if (!Number.isFinite(value)) return '-';
    return '$' + Math.round(value).toLocaleString('es-CL');
}

function shortDate(iso) {
    if (!iso) return '';
    const [, m, d] = iso.split('-');
    return `${d}/${m}`;
}

function activityById(id) {
    return state.activities.find((activity) => activity.id === id) || null;
}

function activityName(id) {
    const activity = activityById(id);
    return activity ? activity.name : '(actividad borrada)';
}

function taskById(id) {
    return state.tasks.find((task) => task.id === id) || null;
}

/** Antecesores de una actividad como {id, lag}, tolerando el formato antiguo. */
function activityLinks(activity) {
    return (activity.predecessors || []).map((entry) =>
        typeof entry === 'string' ? { id: entry, lag: 0 } : { id: entry.id, lag: Number(entry.lag) || 0 });
}

/** Guarda un cambio de actividad y refresca lo que dependa del programa. */
async function patchActivity(activity, patch) {
    Object.assign(activity, patch, { updatedAt: Date.now() });
    await saveActivity(activity);
    renderSchedule();
    renderTasks();
    if (timelineActive()) renderTimeline();
}

/** Guarda un cambio de tramo hecho desde el programa. */
async function patchTask(task, patch) {
    Object.assign(task, patch, { updatedAt: Date.now() });
    await saveTask(task);
    renderSchedule();
    if (timelineActive()) renderTimeline();
}

/**
 * Tareas con las fechas que les toca por programa. Las que tienen fecha propia
 * la conservan; las demas heredan las de su tramo calculado, para que el cursor
 * y la curva comparen contra el plan real.
 */
function scheduledTasks() {
    const schedule = schedulePlan();
    return state.tasks.map((task) => {
        const dates = taskDates(task, schedule);
        const start = dates.start || '';
        const due = dates.due || '';
        if (start === (task.start || '') && due === (task.due || '')) return task;
        return { ...task, start, due };
    });
}

/* ------------------------------- el programa ------------------------------ */

function renderSchedule() {
    if (!state.project || !$('#schedule-list')) return;
    const schedule = schedulePlan();
    renderProgram(schedule);
    renderRates(schedule);
}

function renderProgram(schedule) {
    const list = $('#schedule-list');
    const summary = $('#schedule-summary');
    const warning = $('#schedule-warning');

    $('#schedule-start').value = state.project.scheduleStart || schedule.from;
    $('#schedule-calendar').value = scheduleCalendarId();
    $('#schedule-tolerance').value = String(shareTolerance());

    const avisos = [];
    if (schedule.cycle.length) {
        avisos.push('Hay antecesores en circulo, asi que estos tramos quedan sin fechar: '
            + `${schedule.cycle.map((id) => (taskById(id) || {}).title || id).join(', ')}.`);
    }
    if (schedule.orphans.length) {
        const names = schedule.orphans.map((id) => (taskById(id) || {}).title || id);
        avisos.push(`Su actividad antecesora no pasa por aqui: ${names.join(', ')}. `
            + 'Se enlazaron a la actividad anterior de la cadena que si pasa, pero suele ser '
            + `una zanja sin su circuito dibujado. Sube la tolerancia si las trazas corren a mas de ${shareTolerance()} m, o enlazalos a mano.`);
    }
    // Una maquina no puede estar en dos frentes a la vez: si se le asigno a dos
    // actividades que se pisan, el programa sale optimista y nadie lo nota.
    for (const clash of (schedule.clashes || []).slice(0, 6)) {
        avisos.push(`${clash.resource.name} esta en "${clash.a.label}" y en "${clash.b.label}" `
            + `del ${shortDate(clash.from)} al ${shortDate(clash.to)}.`);
    }
    if ((schedule.clashes || []).length > 6) {
        avisos.push(`Y ${schedule.clashes.length - 6} choque(s) mas de agenda.`);
    }
    for (const row of (schedule.unmanned || []).slice(0, 4)) {
        avisos.push(`${row.resource.name} no tiene operador y esta en "${row.activity.name}".`);
    }
    for (const row of (schedule.late || []).slice(0, 4)) {
        const task = taskById(row.id);
        avisos.push(`"${task ? task.title : row.id}" termina el ${shortDate(row.end)}, `
            + `despues de que ${row.crew} se va de la obra el ${shortDate(row.leaves)}.`);
    }
    if ((schedule.late || []).length > 4) {
        avisos.push(`Y ${schedule.late.length - 4} tramo(s) mas quedan fuera de la estadia de su frente.`);
    }
    warning.hidden = !avisos.length;
    warning.textContent = avisos.join(' ');
    renderDuplicates(schedule);

    summary.innerHTML = '';
    list.innerHTML = '';
    if (!state.activities.length) {
        list.innerHTML = '<li class="empty">Crea las actividades en la pestaña Tareas '
            + '(excavacion, tendido, tapado…), dales rendimiento en Rendimientos y aqui saldran sus fechas.</li>';
        return;
    }

    const withTasks = state.activities.filter((a) => !(schedule.activities.get(a.id) || {}).empty);
    const days = workdaysBetween(schedule.from, schedule.to, calendarOf(scheduleCalendarId()));
    summary.append(chip(`${state.tasks.length} tramo(s)`, null));
    if (withTasks.length) {
        summary.append(chip(`${formatDate(schedule.from)} → ${formatDate(schedule.to)}`, '#2f81f7'));
        summary.append(chip(`${days} dias trabajados`, null));
    }
    const critical = state.activities.filter((a) => (schedule.activities.get(a.id) || {}).critical);
    if (critical.length) {
        summary.append(chip(`Ruta critica: ${critical.map((a) => a.name).join(' → ')}`, '#ef4444'));
    }

    // Costo y combustible de toda la obra, si los recursos los declaran.
    const obra = { cost: 0, fuel: 0 };
    for (const activity of state.activities) {
        const spend = activitySpend(activity.id, schedule);
        if (!spend) continue;
        obra.cost += spend.cost;
        obra.fuel += spend.fuel;
    }
    if (obra.cost > 0) summary.append(chip(`${formatMoney(obra.cost)} en recursos`, '#22c55e'));
    if (obra.fuel > 0) summary.append(chip(`${formatNumber(obra.fuel)} L de combustible`, '#f59e0b'));

    const span = Math.max(1, daysBetween(schedule.from, schedule.to) + 1);
    for (const activity of state.activities) {
        list.append(renderProgramActivity(activity, schedule, span));
    }
}

/**
 * Doble conteo: dos tramos de una actividad "una vez por zanja" que pisan los
 * mismos metros. Pasa cuando la zanja que llevan tres circuitos se carga una
 * vez por circuito, y entonces los m3 se cuentan de mas.
 */
function renderDuplicates(schedule) {
    const box = $('#schedule-duplicates');
    if (!box) return;
    const found = schedule.duplicates || [];
    box.innerHTML = '';
    box.hidden = !found.length;
    if (!found.length) return;

    const head = document.createElement('strong');
    head.textContent = found.length === 1
        ? 'Hay un trecho contado dos veces:'
        : `Hay ${found.length} trechos contados dos veces:`;
    box.append(head);

    for (const hit of found) {
        const line = document.createElement('div');
        line.className = 'duplicate-line';
        const text = document.createElement('span');
        const meters = hit.meters > 0 ? ` (${formatNumber(hit.meters * state.unitScale)} m)` : '';
        text.textContent = `${hit.activity.name}: "${hit.a.title}" y "${hit.b.title}" van por el mismo lugar${meters}.`;
        line.append(text);

        // Se ofrece borrar el segundo, que es el que suele sobrar.
        const drop = document.createElement('button');
        drop.type = 'button';
        drop.className = 'ghost small';
        drop.textContent = `Eliminar "${hit.b.title}"`;
        drop.addEventListener('click', () => removeDuplicate(hit.b));
        line.append(drop);
        box.append(line);
    }

    const hint = document.createElement('small');
    hint.className = 'muted';
    hint.textContent = 'La zanja se excava y se tapa una sola vez aunque pasen varios circuitos. '
        + 'Si la actividad si se repite por circuito, cambiale el alcance en Rendimientos.';
    box.append(hint);
}

async function removeDuplicate(task) {
    if (!confirm(`¿Eliminar el tramo "${task.title}"? Su avance registrado se pierde.`)) return;
    await deleteTask(task.id);
    state.tasks = state.tasks.filter((t) => t.id !== task.id);
    if (state.draft && state.draft.id === task.id) closeTaskModal();
    clearTaskHighlight();
    renderTasks();
    renderSchedule();
    renderElementPanel();
    toast('Tramo eliminado.');
}

/**
 * Lo que cuesta y consume un tramo: los dias que le da el programa por lo que
 * cobran y gastan por hora los recursos que tiene asignados.
 */
function tramoSpend(task, entry) {
    if (!entry || !entry.duration) return null;
    const assigned = (task.resources || []).map(resourceById).filter(Boolean);
    if (!assigned.length) return null;
    const spend = spendOf(assigned, entry.duration);
    return (spend.cost > 0 || spend.fuel > 0) ? spend : null;
}

/** Suma de costo y combustible de todos los tramos de una actividad. */
function activitySpend(activityId, schedule) {
    const total = { cost: 0, fuel: 0, hours: 0 };
    let any = false;
    for (const task of tasksOf(activityId, state.tasks)) {
        const spend = tramoSpend(task, schedule.tasks.get(task.id));
        if (!spend) continue;
        any = true;
        total.cost += spend.cost;
        total.fuel += spend.fuel;
        total.hours += spend.hours;
    }
    return any ? total : null;
}

/** Barra de un tramo del programa sobre la ventana completa de la obra. */
function ganttBar(entry, schedule, span, pct, critical) {
    const bar = document.createElement('div');
    bar.className = 'schedule-gantt';
    const fill = document.createElement('i');
    if (entry && entry.start) {
        const left = (daysBetween(schedule.from, entry.start) / span) * 100;
        const width = ((daysBetween(entry.start, entry.end) + 1) / span) * 100;
        fill.style.left = `${Math.max(0, Math.min(99, left))}%`;
        fill.style.width = `${Math.max(1.5, Math.min(100 - left, width))}%`;
        if (critical) fill.style.background = 'rgba(239, 68, 68, 0.45)';
        const done = document.createElement('span');
        done.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        fill.append(done);
    }
    bar.append(fill);
    return bar;
}

/** Cabecera de actividad en el programa, con sus tramos desplegables. */
function renderProgramActivity(activity, schedule, span) {
    const entry = schedule.activities.get(activity.id) || {};
    const row = document.createElement('li');
    row.className = 'schedule-row' + (entry.critical ? ' critical' : '');
    row.dataset.id = activity.id;
    if (state.activities.length > 1) {
        row.classList.add('has-drag');
        row.append(dragHandle('Arrastra para cambiar la secuencia'));
    }
    const open = !state.scheduleClosed.has(activity.id);

    const progress = activityProgress(activity.id, state.tasks, state.shapesById, state.unitScale);
    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'schedule-top';
    head.innerHTML = `
        <span class="activity-caret"></span>
        <span class="activity-dot"></span>
        <strong></strong>
        <span class="schedule-when"></span>`;
    head.querySelector('.activity-caret').textContent = open ? '▼' : '▶';
    head.querySelector('.activity-dot').style.background = activity.color;
    head.querySelector('strong').textContent = activity.name;
    head.querySelector('.schedule-when').textContent = entry.empty
        ? 'sin tramos'
        : `${shortDate(entry.start)} → ${shortDate(entry.end)}`;
    head.addEventListener('click', () => {
        if (open) state.scheduleClosed.add(activity.id); else state.scheduleClosed.delete(activity.id);
        renderSchedule();
    });
    row.append(head);

    if (!entry.empty) {
        row.append(ganttBar(entry, schedule, span, progress.pct, entry.critical));

        const meta = document.createElement('div');
        meta.className = 'schedule-dates';
        meta.append(tag(`${entry.days} dias`));
        meta.append(tag(`${entry.tasks} tramo(s)`));
        if (entry.amount > 0) meta.append(tag(`${formatNumber(entry.amount)} ${entry.unit}`));
        if (entry.crews > 1) meta.append(tag(`${entry.crews} frentes`));
        meta.append(tag(`${Math.round(progress.pct)}% ejecutado`));
        const spend = activitySpend(activity.id, schedule);
        if (spend && spend.cost > 0) meta.append(tag(formatMoney(spend.cost)));
        if (spend && spend.fuel > 0) meta.append(tag(`${formatNumber(spend.fuel)} L`));
        if (entry.critical) {
            const flag = document.createElement('span');
            flag.className = 'schedule-flag';
            flag.textContent = 'CRITICA';
            meta.append(flag);
        } else meta.append(tag(`holgura ${entry.float} dia(s)`));
        row.append(meta);
    }

    // Antecesoras: la regla general, que luego se baja tramo a tramo.
    const links = activityLinks(activity);
    const manual = activity.linksAuto === false;
    const box = document.createElement('div');
    box.className = 'schedule-links';
    const label = document.createElement('span');
    label.textContent = manual ? 'Va despues de (a mano):' : 'Va despues de:';
    label.title = manual
        ? 'Esta actividad no sigue el orden de la lista: la enlazaste tu.'
        : 'Sale del orden de la lista. Si marcas otra, pasa a ser manual.';
    box.append(label);
    for (const other of state.activities) {
        if (other.id === activity.id) continue;
        const current = links.find((link) => link.id === other.id);
        const chipEl = document.createElement('label');
        chipEl.className = 'schedule-link' + (current ? ' on' : '');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = !!current;
        const name = document.createElement('span');
        name.textContent = other.name;
        chipEl.append(check, name);
        check.addEventListener('change', () => {
            const next = links.filter((link) => link.id !== other.id);
            if (check.checked) next.push({ id: other.id, lag: 0 });
            // Tocar los enlaces es tomar el control: desde aqui, reordenar la
            // lista ya no los reescribe.
            patchActivity(activity, { predecessors: next, linksAuto: false });
        });
        if (current) {
            const lag = document.createElement('input');
            lag.type = 'number';
            lag.step = '1';
            lag.value = String(current.lag);
            lag.title = 'Dias de desfase: positivo espera, negativo solapa';
            lag.addEventListener('change', () => {
                const value = Math.round(Number(lag.value) || 0);
                patchActivity(activity, {
                    predecessors: links.map((link) => (link.id === other.id ? { id: link.id, lag: value } : link))
                });
            });
            chipEl.append(lag);
        }
        box.append(chipEl);
    }
    if (state.activities.length < 2) {
        const none = document.createElement('span');
        none.textContent = '— (es la unica actividad)';
        box.append(none);
    }
    if (manual) {
        const back = document.createElement('button');
        back.type = 'button';
        back.className = 'link-btn';
        back.textContent = 'seguir el orden de la lista';
        back.title = 'Vuelve a esperar a la actividad que tiene justo encima';
        back.addEventListener('click', async () => {
            activity.linksAuto = true;
            state.activities = relinkChain(state.activities);
            await saveActivities(state.activities);
            renderSchedule();
            renderTasks();
        });
        box.append(back);
    }
    row.append(box);

    if (!open) return row;

    const tramos = document.createElement('ul');
    tramos.className = 'tramo-list';
    // En el orden en que se ejecutan, que es el que se puede arrastrar. Antes
    // se ordenaban por fecha, pero esa fecha ya sale de este mismo orden.
    const own = tasksOf(activity.id, state.tasks);
    for (const task of own) tramos.append(renderProgramTask(task, activity, schedule, span));
    if (!own.length) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = 'Sin tramos todavia. Agregalos desde la pestaña Tareas.';
        tramos.append(empty);
    }
    row.append(tramos);
    return row;
}

/** Una fila de tramo: fechas propias, cantidad, frente y antecesores. */
function renderProgramTask(task, activity, schedule, span) {
    const entry = schedule.tasks.get(task.id);
    const row = document.createElement('li');
    row.className = 'tramo-row' + (entry && entry.critical ? ' critical' : '');
    row.dataset.id = task.id;
    row.append(dragHandle('Arrastra para cambiar en que orden se ejecuta'));

    const top = document.createElement('div');
    top.className = 'tramo-top';
    const title = document.createElement('strong');
    title.textContent = task.title || '(sin titulo)';
    const when = document.createElement('span');
    when.className = 'tramo-when';
    when.textContent = entry && entry.start ? `${shortDate(entry.start)} → ${shortDate(entry.end)}` : 'sin fechar';
    when.title = entry && entry.start ? `${formatDate(entry.start)} a ${formatDate(entry.end)}` : '';
    top.append(title, when);
    row.append(top);

    const progress = taskProgress(task);
    if (entry) {
        row.append(ganttBar(entry, schedule, span, progress, entry.critical));

        const meta = document.createElement('div');
        meta.className = 'tramo-meta';
        meta.append(tag(`${entry.duration} dia(s)${entry.manual ? ' fijos' : ''}`));
        if (entry.amount && entry.amount.value > 0) {
            meta.append(tag(`${formatNumber(entry.amount.value)} ${entry.amount.label}`));
        }
        if (entry.assumed) meta.append(tag('sin rendimiento', true));
        if (entry.crews > 1) meta.append(tag(`frente ${entry.crew}`));
        if (progress > 0) meta.append(tag(`${progress}% ejecutado`));
        const spend = tramoSpend(task, entry);
        if (spend && spend.cost > 0) meta.append(tag(formatMoney(spend.cost)));
        if (spend && spend.fuel > 0) meta.append(tag(`${formatNumber(spend.fuel)} L`));
        if (entry.broken) meta.append(tag('en circulo', true));
        else if (entry.critical) {
            const flag = document.createElement('span');
            flag.className = 'schedule-flag';
            flag.textContent = 'CRITICA';
            meta.append(flag);
        } else meta.append(tag(`holgura ${entry.float}`));
        row.append(meta);
    }

    row.append(renderTramoLinks(task, activity, entry));
    return row;
}

/**
 * Antecesores de un tramo. Por defecto salen solos de la geometria: los tramos
 * de la actividad previa que pisan los mismos elementos del plano. El boton
 * ✎ congela esa lista y deja editarla cuando la obra no sigue al dibujo.
 */
function renderTramoLinks(task, activity, entry) {
    const box = document.createElement('div');
    box.className = 'tramo-links';
    const manual = task.linksAuto === false;
    const links = entry ? entry.links : taskLinks(task, state.activities, state.tasks);

    const label = document.createElement('span');
    label.textContent = manual ? 'Despues de (a mano):' : 'Despues de:';
    box.append(label);

    if (!links.length) {
        const none = document.createElement('span');
        none.className = 'tramo-none';
        // Sin actividad antecesora es normal que no espere a nadie; con ella,
        // significa que no encontro su tramo vecino y hay que revisarlo.
        const primera = !activityLinks(activity).length;
        none.textContent = manual ? 'nada, parte libre'
            : (primera ? 'nada, es la primera actividad' : 'nada en su ubicacion');
        box.append(none);
    }

    for (const link of links) {
        const before = taskById(link.id);
        const chipEl = document.createElement('span');
        chipEl.className = 'schedule-link on';
        const name = document.createElement('span');
        name.textContent = before ? before.title : '(tramo borrado)';
        chipEl.append(name);
        if (link.lag) {
            const lagTag = document.createElement('span');
            lagTag.className = 'tramo-lag';
            lagTag.textContent = link.lag > 0 ? `+${link.lag}` : String(link.lag);
            chipEl.append(lagTag);
        }
        if (manual) {
            const drop = document.createElement('button');
            drop.type = 'button';
            drop.className = 'tramo-drop';
            drop.textContent = '✕';
            drop.title = 'Quitar este antecesor';
            drop.addEventListener('click', () => patchTask(task, {
                predecessors: links.filter((l) => l.id !== link.id).map((l) => ({ id: l.id, lag: l.lag }))
            }));
            chipEl.append(drop);
        }
        box.append(chipEl);
    }

    if (!manual) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'ghost small';
        edit.textContent = '✎ A mano';
        edit.title = 'Fijar los antecesores de este tramo';
        edit.addEventListener('click', () => patchTask(task, {
            linksAuto: false,
            predecessors: links.map((l) => ({ id: l.id, lag: l.lag }))
        }));
        box.append(edit);
        return box;
    }

    // En modo manual: un selector con todos los demas tramos, agrupados.
    const picker = document.createElement('select');
    picker.className = 'tramo-picker';
    picker.append(new Option('+ Agregar antecesor…', ''));
    const taken = new Set(links.map((l) => l.id));
    for (const other of state.activities) {
        const own = tasksOf(other.id, state.tasks).filter((t) => t.id !== task.id && !taken.has(t.id));
        if (!own.length) continue;
        const group = document.createElement('optgroup');
        group.label = other.name;
        for (const candidate of own) group.append(new Option(candidate.title || '(sin titulo)', candidate.id));
        picker.append(group);
    }
    picker.addEventListener('change', () => {
        if (!picker.value) return;
        patchTask(task, {
            predecessors: [...links.map((l) => ({ id: l.id, lag: l.lag })), { id: picker.value, lag: 0 }]
        });
    });
    box.append(picker);

    const auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'ghost small';
    auto.textContent = '↺ Automatico';
    auto.title = 'Volver a deducirlos del plano';
    auto.addEventListener('click', () => patchTask(task, { linksAuto: true, predecessors: [] }));
    box.append(auto);
    return box;
}

/* ------------------------------ rendimientos ------------------------------ */

function renderRates(schedule) {
    const list = $('#rate-list');
    if (!list) return;
    list.innerHTML = '';
    if (!state.activities.length) {
        list.innerHTML = '<li class="empty">Todavia no hay actividades. Crealas en la pestaña Tareas.</li>';
        return;
    }
    for (const activity of state.activities) list.append(renderRateRow(activity, schedule));
}

function renderRateRow(activity, schedule) {
    const rate = rateOf(activity);
    const unit = rateUnitOf(rate.unit);
    const entry = schedule.activities.get(activity.id) || {};

    const row = document.createElement('li');
    row.className = 'rate-row';
    row.innerHTML = `
        <div class="schedule-top">
            <span class="activity-dot"></span>
            <strong></strong>
        </div>
        <div class="rate-grid">
            <label>Se mide en
                <select class="rate-unit"></select>
            </label>
            <label>Rendimiento
                <span class="rate-input">
                    <input type="number" class="rate-value" min="0" step="any" placeholder="0">
                    <em></em>
                </span>
            </label>
            <label>Frentes
                <input type="number" class="rate-crews" min="1" step="1">
            </label>
            <label class="wide">En una zanja con varios circuitos se ejecuta
                <select class="rate-scope"></select>
            </label>
        </div>
        <div class="rate-crew">
            <div class="linked-head"><strong>Maquinaria y personal</strong><span class="rate-fronts muted"></span></div>
            <div class="picker rate-people"></div>
        </div>
        <small class="rate-result muted"></small>`;

    row.querySelector('.activity-dot').style.background = activity.color;
    row.querySelector('strong').textContent = activity.name;

    const unitSelect = row.querySelector('.rate-unit');
    for (const option of RATE_UNITS) unitSelect.append(new Option(option.label, option.id));
    unitSelect.value = rate.unit;
    unitSelect.addEventListener('change', () => {
        patchActivity(activity, { rate: { unit: unitSelect.value, value: rate.value } });
    });

    const value = row.querySelector('.rate-value');
    value.value = rate.value > 0 ? String(rate.value) : '';
    row.querySelector('.rate-input em').textContent = `${unit.unit}/dia`;
    value.addEventListener('change', () => {
        const next = Number(value.value);
        patchActivity(activity, {
            rate: { unit: rate.unit, value: Number.isFinite(next) && next > 0 ? next : 0 }
        });
    });

    /* Los frentes salen de los recursos asignados; el numero a mano queda solo
       para cuando todavia no se han cargado las maquinas. */
    const assigned = new Set(activity.resources || []);
    const fronts = frontsOf(activity, state.resources);
    const crews = row.querySelector('.rate-crews');
    crews.value = String(entry.crews || crewsOf(activity, state.resources));
    crews.disabled = fronts !== null;
    crews.title = fronts !== null
        ? 'Sale de la maquinaria y el personal asignados mas abajo'
        : 'Cuantos tramos se atacan a la vez. Asigna las maquinas y sale solo.';
    crews.addEventListener('change', () => {
        const next = Math.max(1, Math.round(Number(crews.value) || 1));
        patchActivity(activity, { crews: next });
    });

    const people = row.querySelector('.rate-people');
    const label = row.querySelector('.rate-fronts');
    if (!state.resources.length) {
        label.textContent = 'sin recursos cargados';
        people.innerHTML = '<span class="muted">Carga la maquinaria en Recursos y los frentes salen de ella.</span>';
    } else {
        label.textContent = fronts === null
            ? 'ninguno asignado'
            : `${fronts} frente(s) · ${assigned.size} asignado(s)`;
        // Lo asignado primero, y la maquinaria antes que el personal: si no, en
        // una obra con gente lo que esta marcado queda fuera de la caja.
        const ordenados = [...state.resources].sort((a, b) =>
            (assigned.has(b.id) ? 1 : 0) - (assigned.has(a.id) ? 1 : 0)
            || (b.type === 'maquina' ? 1 : 0) - (a.type === 'maquina' ? 1 : 0)
            || (a.name || '').localeCompare(b.name || '', 'es'));
        for (const resource of ordenados) {
            const chip = document.createElement('label');
            chip.className = 'picker-chip' + (assigned.has(resource.id) ? ' on' : '');
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.checked = assigned.has(resource.id);
            const name = document.createElement('span');
            name.textContent = `${typeOf(resource.type).icon} ${resource.name}`
                + (resource.group ? ` · ${resource.group}` : '');
            chip.append(check, name);
            check.addEventListener('change', () => {
                const next = new Set(assigned);
                if (check.checked) next.add(resource.id); else next.delete(resource.id);
                patchActivity(activity, { resources: [...next] });
            });
            people.append(chip);
        }
    }

    const scope = row.querySelector('.rate-scope');
    for (const option of ACTIVITY_SCOPES) scope.append(new Option(option.label, option.id));
    scope.value = scopeOf(activity);
    scope.title = (ACTIVITY_SCOPES.find((o) => o.id === scope.value) || {}).hint || '';
    scope.addEventListener('change', () => patchActivity(activity, { scope: scope.value }));

    const result = row.querySelector('.rate-result');
    if (entry.empty) {
        result.textContent = `${unit.what}: ${unit.hint} Todavia no hay tramos que medir.`;
    } else if (rate.value > 0) {
        result.textContent = `${formatNumber(entry.amount)} ${unit.unit} en ${entry.tasks} tramo(s)`
            + ` · ${entry.days} dias trabajados`
            + (entry.crews > 1 ? ` con ${entry.crews} frentes` : '');
    } else {
        result.textContent = 'Sin rendimiento: cada tramo se cuenta como un dia. '
            + `${unit.what}: ${unit.hint}`;
    }
    return row;
}

function wireSchedule() {
    for (const tab of $$('.sub-tab')) {
        tab.addEventListener('click', () => {
            for (const other of $$('.sub-tab')) other.classList.toggle('active', other === tab);
            for (const panel of $$('.sub-panel')) {
                panel.classList.toggle('active', panel.dataset.subpanel === tab.dataset.sub);
            }
            renderSchedule();
        });
    }
    $('#schedule-start').addEventListener('change', async (e) => {
        if (!state.project) return;
        state.project.scheduleStart = e.target.value || '';
        await saveProject(state.project);
        renderSchedule();
        if (timelineActive()) renderTimeline();
    });
    $('#schedule-calendar').addEventListener('change', async (e) => {
        if (!state.project) return;
        state.project.workdays = e.target.value;
        await saveProject(state.project);
        renderSchedule();
        if (timelineActive()) renderTimeline();
    });
    $('#schedule-tolerance').addEventListener('change', async (e) => {
        if (!state.project) return;
        const value = Number(e.target.value);
        state.project.shareTolerance = Number.isFinite(value) && value > 0 ? value : DEFAULT_SHARE_TOLERANCE;
        await saveProject(state.project);
        renderSchedule();
        const enlaces = [...state.schedule.tasks.values()].reduce((n, e2) => n + e2.links.length, 0);
        toast(`Tolerancia ${state.project.shareTolerance} m: ${enlaces} enlace(s) entre tramos.`);
        if (timelineActive()) renderTimeline();
    });
}

/* ------------------------------------------------------------------ */
/* Avance por metraje desde el plano                                   */
/* ------------------------------------------------------------------ */

/**
 * Registra avance sobre un tramo: divide la polilinea en el metraje indicado
 * y deja ejecutada la parte del extremo desde el que se mide. Es el gesto de
 * terreno: "por esta linea avanzamos 35 m mas".
 */
function openAdvanceModal(shape) {
    const tasks = state.tasks.filter((task) => task.elements.some((ref) => ref.id === shape.id));
    if (!tasks.length) {
        return toast('Este tramo no pertenece a ninguna actividad. Vinculalo primero a una tarea.');
    }
    // El extremo desde el que se mide es el mas cercano al ultimo toque.
    const pts = shape.pts;
    const start = { x: pts[0], y: pts[1] };
    const end = { x: pts[pts.length - 2], y: pts[pts.length - 1] };
    const tap = state.lastTap || start;
    const fromStart = Math.hypot(tap.x - start.x, tap.y - start.y) <= Math.hypot(tap.x - end.x, tap.y - end.y);

    state.advance = { shape, fromStart, tasks };
    const select = $('#advance-task');
    select.innerHTML = '';
    for (const task of tasks) select.append(new Option(task.title || '(sin titulo)', task.id));
    select.disabled = tasks.length === 1;

    $('#advance-info').textContent =
        `${KIND_LABELS[shape.kind] || shape.kind} · capa ${shape.layer} · ${describeMeasure(shape)}`;
    $('#advance-date').value = todayDate();
    $('#advance-meters').value = '';
    renderAdvanceOrigin();
    $('#advance-modal').classList.remove('hidden');
    setTimeout(() => $('#advance-meters').focus(), 50);
}

function closeAdvanceModal() {
    $('#advance-modal').classList.add('hidden');
    state.advance = null;
    viewer.setHighlightPoint(null);
}

/** Muestra desde que punto se mide y como quedaria la division. */
function renderAdvanceOrigin() {
    const advance = state.advance;
    if (!advance) return;
    const { shape, fromStart } = advance;
    const pts = shape.pts;
    const origin = fromStart
        ? { x: pts[0], y: pts[1] }
        : { x: pts[pts.length - 2], y: pts[pts.length - 1] };
    $('#advance-origin').textContent =
        `Midiendo desde el extremo ${formatNumber(origin.x)} , ${formatNumber(origin.y)}`;
    viewer.setHighlightPoint(origin);
    renderAdvancePreview();
}

function renderAdvancePreview() {
    const advance = state.advance;
    if (!advance) return;
    const total = pathLength(advance.shape.pts);
    const units = state.project.units === 'sin unidad' ? '' : ` ${state.project.units}`;
    const meters = Number($('#advance-meters').value);
    const box = $('#advance-preview');

    // Lo ya ejecutado por esta actividad sobre este mismo elemento.
    const task = state.tasks.find((t) => t.id === $('#advance-task').value);
    const ref = task ? task.elements.find((e) => e.id === advance.shape.id) : null;
    const already = ref ? refDoneLength(ref, total) : 0;
    const pending = Math.max(0, total - already);

    if (!Number.isFinite(meters) || meters <= 0) {
        box.innerHTML = already > 0
            ? `Este tramo mide ${formatNumber(total)}${units}. Esta actividad lleva `
              + `<b>${formatNumber(already)}${units}</b> y quedan <i>${formatNumber(pending)}${units}</i>.`
            : `Este tramo mide ${formatNumber(total)}${units} y no tiene avance en esta actividad.`;
        return;
    }
    const along = Math.min(pending, meters / state.unitScale);
    const after = already + along;
    if (after >= total - 1e-9) {
        box.innerHTML = `El tramo queda <b>completo</b> (${formatNumber(total)}${units}).`;
        return;
    }
    box.innerHTML = `Quedaria <b>${formatNumber(after)}${units} ejecutados</b> y `
        + `<i>${formatNumber(total - after)}${units} pendientes</i> en esta actividad.`;
}

async function submitAdvance() {
    const advance = state.advance;
    if (!advance) return;
    const { shape, fromStart } = advance;
    const meters = Number($('#advance-meters').value);
    if (!Number.isFinite(meters) || meters <= 0) return toast('Escribe cuantos metros se ejecutaron.');

    const date = $('#advance-date').value || todayDate();
    const task = state.tasks.find((t) => t.id === $('#advance-task').value);
    if (!task) return;
    const ref = task.elements.find((e) => e.id === shape.id);
    if (!ref) return toast('El tramo no pertenece a esa actividad.');

    const total = pathLength(shape.pts);
    const along = Math.min(total, meters / state.unitScale);
    closeAdvanceModal();

    // El avance NO divide la polilinea: se anota sobre el mismo elemento, para
    // que otra actividad pueda llevar los suyos sobre el mismo trazado. Se
    // acumula desde el extremo elegido, continuando lo que ya estaba hecho.
    const existing = refSpans(ref, total);
    let from;
    let to;
    if (fromStart) {
        from = continueFrom(existing, total, true);
        to = Math.min(total, from + along);
    } else {
        to = continueFrom(existing, total, false);
        from = Math.max(0, to - along);
    }

    ref.spans = addSpan(ref, from, to, date, total);
    ref.done = isRefDone(ref, total);
    ref.doneAt = ref.done ? (refLastDate(ref) || date) : null;
    await saveAdvancedTask(task, `Avance de ${formatNumber(along)} registrado.`, { closePanel: true });
}

/**
 * Desde donde continua el avance: el final de lo ya ejecutado cuando se mide
 * desde el inicio, o su comienzo cuando se mide desde el otro extremo.
 */
function continueFrom(spans, total, fromStart) {
    if (!spans.length) return fromStart ? 0 : total;
    // Lo ejecutado puede venir en varios trozos pegados, uno por dia: hay que
    // recorrer la racha completa para no volver a empezar en medio de ella.
    if (fromStart) {
        if (spans[0].from > 1e-9) return 0;
        let end = spans[0].to;
        for (let i = 1; i < spans.length; i++) {
            if (spans[i].from > end + 1e-9) break;
            end = Math.max(end, spans[i].to);
        }
        return end;
    }
    const last = spans[spans.length - 1];
    if (last.to < total - 1e-9) return total;
    let start = last.from;
    for (let i = spans.length - 2; i >= 0; i--) {
        if (spans[i].to < start - 1e-9) break;
        start = Math.min(start, spans[i].from);
    }
    return start;
}

/** Marca (o completa) el tramo entero dentro de una actividad. */
async function markRefDone(taskId, shapeId, date) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const ref = task.elements.find((e) => e.id === shapeId);
    if (!ref) return toast('El tramo quedo fuera de la actividad.');
    const shape = state.shapesById.get(shapeId);
    const total = shape ? pathLength(shape.pts) : 0;

    ref.done = true;
    ref.doneAt = date;
    if (total > 0) ref.spans = normalizeSpans([{ from: 0, to: total, date }], total);
    await saveAdvancedTask(task, 'Tramo completo.');
}

/** Guarda tras un avance y refresca plano, listas y avisos de secuencia. */
async function saveAdvancedTask(task, message, { closePanel = false } = {}) {
    task.progress = Math.round(progressFromElements(task, state.shapesById));
    if (task.progress >= 100 && task.status !== 'completada') task.status = 'completada';
    else if (task.progress < 100 && task.status === 'completada') task.status = 'en_curso';
    task.updatedAt = Date.now();

    await saveTask(task);
    // La seleccion se mantiene: el elemento sigue existiendo, ya no se divide.
    applyTaskHighlight(task);
    refreshActivityHighlight();
    renderTasks();
    renderElementPanel();
    renderSelectionCard();
    // Tras registrar desde el dialogo conviene ver el plano en pantalla chica.
    if (closePanel && window.matchMedia('(max-width: 900px)').matches) togglePanel(false);

    // Aviso de secuencia: se esta ejecutando algo cuya actividad previa no
    // termina. No se impide nada; en terreno a veces se adelanta a proposito.
    let notice = '';
    const pending = unfinishedPredecessors(task, state.activities, state.tasks,
        (before) => taskProgress(before));
    if (pending.length) {
        notice = ' Ojo: ' + pending
            .map((p) => `${p.task.title} va en ${Math.round(p.pct)}%`).join(', ') + '.';
    }
    renderSchedule();
    toast(`${message} ${task.title || 'Actividad'}: ${task.progress}%.${notice}`);
}

function wireAdvance() {
    $('#btn-advance-flip').addEventListener('click', () => {
        if (!state.advance) return;
        state.advance.fromStart = !state.advance.fromStart;
        renderAdvanceOrigin();
    });
    $('#advance-meters').addEventListener('input', renderAdvancePreview);
    $('#advance-task').addEventListener('change', renderAdvancePreview);
    $('#advance-form').addEventListener('submit', (e) => {
        e.preventDefault();
        submitAdvance();
    });
}

/* ------------------------------------------------------------------ */
/* Linea de tiempo: la obra vista en una fecha cualquiera              */
/* ------------------------------------------------------------------ */

const PLAY_MS = 260;

function timelineActive() {
    return !!state.timeline;
}

function openTimeline() {
    // Las tareas entran con las fechas del programa: asi la curva planificada
    // sale del programa maestro aunque el tramo no tenga fechas propias.
    const tasks = scheduledTasks();
    const range = projectRange(tasks, state.places);
    if (!range) {
        return toast('Todavia no hay fechas: marca tramos, dale duracion a las actividades o pon inicio y termino a una tarea.');
    }
    const today = todayDate();
    const date = today < range.from ? range.from : (today > range.to ? range.to : today);
    state.timeline = { ...range, date, playing: false, timer: null, tasks };

    const slider = $('#timeline-range');
    slider.min = '0';
    slider.max = String(range.days);
    slider.value = String(Math.max(0, daysBetween(range.from, date)));

    // La seleccion se dibuja encima del avance y lo taparia: el cursor es
    // un modo de lectura, no de edicion.
    setSelection([]);
    $('#timeline').classList.remove('hidden');
    $('#app').classList.add('timeline-open');
    $('#btn-timeline').classList.add('active');
    renderTimeline();
}

function stopTimeline() {
    if (!state.timeline) return;
    pauseTimeline();
    state.timeline = null;
    $('#timeline').classList.add('hidden');
    $('#app').classList.remove('timeline-open');
    $('#btn-timeline').classList.remove('active');
    clearTaskHighlight();
    renderTasks();
}

function setTimelineDate(date) {
    if (!state.timeline) return;
    const clamped = date < state.timeline.from ? state.timeline.from
        : (date > state.timeline.to ? state.timeline.to : date);
    state.timeline.date = clamped;
    $('#timeline-range').value = String(daysBetween(state.timeline.from, clamped));
    renderTimeline();
}

function stepTimeline(days) {
    if (!state.timeline) return;
    setTimelineDate(addDays(state.timeline.date, days));
}

function playTimeline() {
    if (!state.timeline || state.timeline.playing) return;
    // Al reproducir desde el final se vuelve al principio.
    if (state.timeline.date >= state.timeline.to) setTimelineDate(state.timeline.from);
    state.timeline.playing = true;
    $('#btn-timeline-play').textContent = '⏸';
    state.timeline.timer = setInterval(() => {
        if (!state.timeline) return;
        if (state.timeline.date >= state.timeline.to) return pauseTimeline();
        stepTimeline(1);
    }, PLAY_MS);
}

function pauseTimeline() {
    if (!state.timeline) return;
    clearInterval(state.timeline.timer);
    state.timeline.timer = null;
    state.timeline.playing = false;
    $('#btn-timeline-play').textContent = '▶';
}

/** Dibuja el plano, los marcadores y la curva para la fecha del cursor. */
function renderTimeline() {
    const timeline = state.timeline;
    if (!timeline) return;
    const date = timeline.date;
    timeline.tasks = scheduledTasks();
    const state_ = projectStateAt(timeline.tasks, state.shapesById, date, state.unitScale);

    $('#timeline-date').textContent = formatDate(date) + (date === todayDate() ? ' · hoy' : '');

    // Todos los tramos de todas las tareas, segun estaban a esa fecha.
    const overlays = [];
    for (const task of state.tasks) overlays.push(...overlaysForTask(task, date));
    viewer.setTaskHighlight(overlays, true);
    renderMarkers(filterTasks(state.tasks, { ...state.filters, resourceNames: new Map() }));

    const units = state.project.units === 'sin unidad' ? '' : ` ${state.project.units}`;
    const bits = [];
    if (state_.realPct !== null) {
        bits.push(`Ejecutado ${Math.round(state_.realPct)}% (${formatNumber(state_.done.length)}${units})`);
    }
    if (state_.plannedPct !== null) {
        const diff = state_.realPct - state_.plannedPct;
        const sign = diff >= 0 ? '+' : '−';
        bits.push(`plan ${Math.round(state_.plannedPct)}% (${sign}${Math.abs(Math.round(diff))} pts)`);
    }
    if (state_.done.volume) bits.push(`${formatNumber(state_.done.volume)} m³`);
    if (state_.done.count) bits.push(`${state_.done.count} de ${state_.total.count} tramos`);
    if (state_.lateTasks) bits.push(`${state_.lateTasks} tarea(s) atrasada(s)`);
    const activePlaces = placesAt(state.places, date).length;
    if (state.places.length) bits.push(`${activePlaces} punto(s) activo(s)`);
    $('#timeline-readout').textContent = bits.join(' · ');

    drawCurve();
}

/** Curva de avance acumulado: real contra planificado. */
function drawCurve() {
    const timeline = state.timeline;
    const canvas = $('#timeline-curve');
    if (!timeline || !canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = canvas.clientWidth || 320;
    const height = 64;
    if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const points = progressCurve(timeline.tasks || state.tasks, state.shapesById, timeline, state.unitScale);
    if (points.length < 2) return;

    const pad = 4;
    const x = (iso) => pad + (daysBetween(timeline.from, iso) / Math.max(1, timeline.days)) * (width - pad * 2);
    const y = (pct) => height - pad - (Math.max(0, Math.min(100, pct)) / 100) * (height - pad * 2);

    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    for (const pct of [0, 50, 100]) {
        ctx.beginPath();
        ctx.moveTo(pad, y(pct));
        ctx.lineTo(width - pad, y(pct));
        ctx.stroke();
    }

    // Planificado: linea punteada.
    if (points.some((p) => p.planned !== null)) {
        ctx.save();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#93a2b5';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        for (const point of points) {
            if (point.planned === null) continue;
            const px = x(point.date);
            const py = y(point.planned);
            if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
        }
        ctx.stroke();
        ctx.restore();
    }

    // Real: linea llena.
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    points.forEach((point, i) => {
        const px = x(point.date);
        const py = y(point.real);
        if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    });
    ctx.stroke();

    // Marca de la fecha del cursor.
    const cx = x(timeline.date);
    ctx.strokeStyle = '#2f81f7';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, pad);
    ctx.lineTo(cx, height - pad);
    ctx.stroke();
}

function wireTimeline() {
    $('#btn-timeline').addEventListener('click', () => {
        if (timelineActive()) stopTimeline(); else openTimeline();
    });
    $('#btn-timeline-close').addEventListener('click', stopTimeline);
    $('#btn-timeline-prev').addEventListener('click', () => { pauseTimeline(); stepTimeline(-1); });
    $('#btn-timeline-next').addEventListener('click', () => { pauseTimeline(); stepTimeline(1); });
    $('#btn-timeline-today').addEventListener('click', () => { pauseTimeline(); setTimelineDate(todayDate()); });
    $('#btn-timeline-play').addEventListener('click', () => {
        if (state.timeline && state.timeline.playing) pauseTimeline(); else playTimeline();
    });
    $('#timeline-range').addEventListener('input', (e) => {
        if (!state.timeline) return;
        pauseTimeline();
        setTimelineDate(addDays(state.timeline.from, Number(e.target.value)));
    });
    window.addEventListener('resize', () => { if (timelineActive()) drawCurve(); });
}

/* ------------------------------------------------------------------ */
/* Parte diario                                                        */
/* ------------------------------------------------------------------ */

let reportViewer = null;

/** Tema claro para el plano del informe: se imprime en papel blanco. */
const REPORT_THEME = {
    background: '#ffffff',
    grid: 'rgba(15, 23, 42, 0.07)',
    defaultStroke: '#334155',
    selection: '#ffcc33',
    hover: '#7fd1ff',
    text: '#475569'
};

function reportActive() {
    return !$('#report').classList.contains('hidden');
}

function openReport(date) {
    if (!state.project) return;
    state.reportDate = date || state.reportDate || todayDate();
    $('#report-date').value = state.reportDate;
    $('#report').classList.remove('hidden');
    $('#btn-report').classList.add('active');
    renderReport();
}

function closeReport() {
    $('#report').classList.add('hidden');
    $('#btn-report').classList.remove('active');
}

/** Numero con separador de miles y la cantidad justa de decimales. */
function reportNumber(value, unit) {
    if (!Number.isFinite(value)) return '—';
    const decimals = Math.abs(value) >= 100 ? 0 : (Math.abs(value) >= 10 ? 1 : 2);
    return value.toLocaleString('es-CL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
        + (unit ? ` ${unit}` : '');
}

function cell(text, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    return td;
}

/** Tabla con encabezado; las filas las pone quien llama. */
function reportTable(headers) {
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const header of headers) {
        const th = document.createElement('th');
        if (typeof header === 'object') {
            th.textContent = header.text;
            if (header.num) th.className = 'num';
        } else th.textContent = header;
        head.append(th);
    }
    const thead = document.createElement('thead');
    thead.append(head);
    const body = document.createElement('tbody');
    table.append(thead, body);
    return { table, body };
}

function section(sheet, title) {
    const h2 = document.createElement('h2');
    h2.textContent = title;
    sheet.append(h2);
    return h2;
}

function emptyLine(sheet, text) {
    const p = document.createElement('p');
    p.className = 'report-empty';
    p.textContent = text;
    sheet.append(p);
}

/** Arma el informe del dia elegido y lo escribe en la hoja. */
function renderReport() {
    const sheet = $('#report-sheet');
    if (!sheet || !state.project) return;
    const date = state.reportDate;
    const context = {
        project: state.project,
        activities: state.activities,
        tasks: state.tasks,
        resources: state.resources,
        shapesById: state.shapesById,
        metersPerUnit: state.unitScale,
        schedule: schedulePlan(),
        calendar: scheduleCalendarId()
    };
    const report = dayReport(context, date);
    const units = state.project.units === 'sin unidad' ? 'm' : state.project.units;
    sheet.innerHTML = '';

    /* --- Encabezado --- */
    const head = document.createElement('header');
    head.className = 'report-head';
    head.innerHTML = `
        <div class="grow">
            <h1></h1>
            <div class="report-sub"></div>
        </div>
        <div class="when"><span>Parte diario</span><strong></strong></div>`;
    head.querySelector('h1').textContent = state.project.name;
    head.querySelector('.report-sub').textContent =
        `${state.shapes.length} elementos · ${state.activities.length} actividades · ${state.tasks.length} tramos`;
    head.querySelector('.when strong').textContent = report.dateLabel;
    sheet.append(head);

    /* --- Tarjetas de resumen --- */
    const cards = document.createElement('div');
    cards.className = 'report-cards';
    const card = (label, value, detail, tone) => {
        const box = document.createElement('div');
        box.className = 'report-card' + (tone ? ` ${tone}` : '');
        box.innerHTML = '<span></span><strong></strong><small></small>';
        box.querySelector('span').textContent = label;
        box.querySelector('strong').textContent = value;
        box.querySelector('small').textContent = detail || '';
        cards.append(box);
    };

    const hoy = report.executed.reduce((sum, row) => sum + row.meters, 0);
    card('Avance de obra', `${Math.round(report.progress.pct)}%`,
        `${reportNumber(report.progress.done, units)} de ${reportNumber(report.progress.total, units)}`);
    card('Ejecutado el dia', reportNumber(hoy, units),
        report.executed.length ? `${report.executed.length} tramo(s)` : 'sin avance registrado');
    card('Termino programado', report.forecast.plannedEnd ? formatDate(report.forecast.plannedEnd) : '—',
        'segun el programa maestro');
    const late = report.forecast.late;
    card('Termino proyectado', report.forecast.end ? formatDate(report.forecast.end) : '—',
        late === null ? 'falta avance para proyectar'
            : (late > 0 ? `${late} dia(s) de atraso` : `${Math.abs(late)} dia(s) de adelanto`),
        late === null ? '' : (late > 0 ? 'bad' : 'good'));
    sheet.append(cards);

    /* --- Plano --- */
    section(sheet, 'Estado de la obra en el plano');
    const figure = document.createElement('figure');
    figure.className = 'report-figure';
    const canvas = document.createElement('canvas');
    canvas.className = 'report-map';
    canvas.id = 'report-map';
    figure.append(canvas);
    const legend = document.createElement('div');
    legend.className = 'report-legend';
    legend.innerHTML = `<span><i style="background:${DONE_COLOR}"></i>Ejecutado</span>`
        + `<span><i style="background:${PENDING_COLOR}"></i>Pendiente</span>`;
    figure.append(legend);
    sheet.append(figure);

    /* --- Curva S --- */
    section(sheet, 'Curva de avance');
    const curveFigure = document.createElement('figure');
    curveFigure.className = 'report-figure';
    const curve = document.createElement('canvas');
    curve.className = 'report-curve';
    curve.id = 'report-curve';
    curveFigure.append(curve);
    const curveLegend = document.createElement('div');
    curveLegend.className = 'report-legend';
    curveLegend.innerHTML = '<span><i style="background:#16a34a"></i>Avance real</span>'
        + '<span><i style="background:#94a3b8"></i>Avance programado</span>'
        + '<span><i style="background:#2563eb"></i>Fecha del parte</span>';
    curveFigure.append(curveLegend);
    sheet.append(curveFigure);

    /* --- Ejecutado el dia --- */
    section(sheet, `Ejecutado el ${report.dateLabel}`);
    if (!report.executed.length) {
        emptyLine(sheet, 'No se registro avance en esta fecha.');
    } else {
        const { table, body } = reportTable([
            'Actividad', 'Tramo',
            { text: `Avance (${units})`, num: true }, { text: 'Cantidad', num: true }, { text: 'Tramo al', num: true }
        ]);
        for (const row of report.executed) {
            const tr = document.createElement('tr');
            tr.append(
                cell(row.activity.name),
                cell(row.task.title || '(sin titulo)'),
                cell(reportNumber(row.meters), 'num'),
                cell(reportNumber(row.amount, row.unit), 'num'),
                cell(`${row.progress}%`, 'num')
            );
            body.append(tr);
        }
        sheet.append(table);
    }

    /* --- Programado para el dia siguiente --- */
    section(sheet, `Programado para el ${report.nextLabel}`);
    if (!report.tomorrow.length) {
        emptyLine(sheet, 'El programa no pone ningun tramo en ejecucion ese dia.');
    } else {
        const { table, body } = reportTable([
            'Actividad', 'Tramo', 'Estado', { text: 'Periodo programado', num: true }, { text: 'Avance', num: true }
        ]);
        for (const row of report.tomorrow) {
            const tr = document.createElement('tr');
            const flag = document.createElement('span');
            flag.className = 'report-flag ' + (row.starts ? 'on' : 'off');
            flag.textContent = row.starts ? 'ARRANCA' : (row.ends ? 'TERMINA' : 'EN CURSO');
            const estado = document.createElement('td');
            estado.append(flag);
            tr.append(
                cell(row.activity ? row.activity.name : ''),
                cell(row.task.title || '(sin titulo)'),
                estado,
                cell(`${formatDate(row.entry.start)} a ${formatDate(row.entry.end)}`, 'num'),
                cell(`${row.progress}%`, 'num')
            );
            body.append(tr);
        }
        sheet.append(table);
    }

    /* --- Rendimiento real y proyeccion --- */
    section(sheet, 'Rendimiento real y proyeccion');
    if (!report.rates.length) {
        emptyLine(sheet, 'Todavia no hay actividades con tramos.');
    } else {
        const { table, body } = reportTable([
            'Actividad',
            { text: 'Programado', num: true }, { text: 'Real', num: true }, { text: 'Cumple', num: true },
            { text: 'Pendiente', num: true }, { text: 'Termina', num: true }
        ]);
        for (const rate of report.rates) {
            const tr = document.createElement('tr');
            if (rate.late > 0) tr.className = 'late';
            const cumple = rate.ratio === null ? '—' : `${Math.round(rate.ratio * 100)}%`;
            let termina = '—';
            if (rate.finished) termina = 'terminada';
            else if (rate.end) {
                termina = formatDate(rate.end);
                if (rate.late > 0) termina += ` (+${rate.late} d)`;
                else if (rate.late < 0) termina += ` (−${Math.abs(rate.late)} d)`;
            }
            tr.append(
                cell(rate.activity.name),
                cell(rate.planned > 0 ? reportNumber(rate.planned, `${rate.unit}/dia`) : '—', 'num'),
                cell(rate.days ? reportNumber(rate.perDay, `${rate.unit}/dia`) : '—', 'num'),
                cell(cumple, 'num'),
                cell(reportNumber(rate.remaining, rate.unit), 'num'),
                cell(termina, 'num')
            );
            body.append(tr);
        }
        sheet.append(table);
        const note = document.createElement('p');
        note.className = 'report-sub';
        note.textContent = 'El rendimiento real es lo ejecutado repartido en los dias en que hubo avance. '
            + 'El programado incluye los frentes de cada actividad.';
        sheet.append(note);
    }

    /* --- Recursos en obra --- */
    section(sheet, 'Recursos en obra');
    if (!report.resources.rows.length) {
        emptyLine(sheet, 'Ningun recurso asignado a los tramos con avance de esta fecha.');
    } else {
        const { table, body } = reportTable([
            'Recurso', 'Cargo o modelo', 'Tramos',
            { text: 'Horas', num: true }, { text: 'Combustible', num: true }, { text: 'Costo', num: true }
        ]);
        for (const row of report.resources.rows) {
            const resource = row.resource;
            const spend = spendOf([resource], 1);
            const tr = document.createElement('tr');
            tr.append(
                cell(`${typeOf(resource.type).icon} ${resource.name}`),
                cell(resource.role || resource.brand || ''),
                cell(row.tasks.map((t) => t.title).join(', ')),
                cell(reportNumber(spend.hours, 'h'), 'num'),
                cell(spend.fuel > 0 ? reportNumber(spend.fuel, 'L') : '—', 'num'),
                cell(spend.cost > 0 ? formatMoney(spend.cost) : '—', 'num')
            );
            body.append(tr);
        }
        const total = document.createElement('tr');
        total.innerHTML = '<td colspan="3"><strong>Total del dia</strong></td>';
        total.append(
            cell(reportNumber(report.resources.spend.hours, 'h'), 'num'),
            cell(report.resources.spend.fuel > 0 ? reportNumber(report.resources.spend.fuel, 'L') : '—', 'num'),
            cell(report.resources.spend.cost > 0 ? formatMoney(report.resources.spend.cost) : '—', 'num')
        );
        body.append(total);
        sheet.append(table);
    }

    /* --- Pie --- */
    const foot = document.createElement('p');
    foot.className = 'report-foot';
    foot.textContent = `Emitido el ${formatDate(todayDate())} desde Tareas DXF ${APP_VERSION}. `
        + 'Las cantidades salen del plano y del avance registrado en terreno.';
    sheet.append(foot);

    drawReportMap(date);
    drawReportCurve(report);
}

/** Dibuja el plano del informe con el avance a esa fecha, en tema claro. */
function drawReportMap(date) {
    const canvas = $('#report-map');
    if (!canvas || !state.shapes.length) return;
    if (!reportViewer || reportViewer.canvas !== canvas) {
        reportViewer = new Viewer(canvas, {});
        reportViewer.theme = { ...reportViewer.theme, ...REPORT_THEME };
    }
    reportViewer.setScene(state.shapes, state.sceneBounds);
    reportViewer.setLayerState(new Map([...state.layers].map(([name, layer]) =>
        [name, { visible: layer.visible, color: layer.color }])));

    const overlays = [];
    for (const task of state.tasks) overlays.push(...overlaysForTask(task, date));
    reportViewer.setTaskHighlight(overlays, true);
    reportViewer.resize();
    reportViewer.zoomToFit(state.sceneBounds);
    reportViewer.render();
}

/**
 * Curva de avance acumulado, real contra programada, con una marca en la fecha
 * del parte. Es la misma informacion del cursor de tiempo, en grande.
 */
function drawReportCurve(report) {
    const canvas = $('#report-curve');
    if (!canvas) return;
    const tasks = scheduledTasks();
    const range = projectRange(tasks, state.places);
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = canvas.clientWidth || 760;
    const height = canvas.clientHeight || 220;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    if (!range) return;

    const points = progressCurve(tasks, state.shapesById, range, state.unitScale, 200);
    if (points.length < 2) return;

    const padLeft = 44;   // cabe "100%" sin recortarse
    const padRight = 12;
    const padTop = 12;
    const padBottom = 26;
    const x = (iso) => padLeft + (daysBetween(range.from, iso) / Math.max(1, range.days)) * (width - padLeft - padRight);
    const y = (pct) => height - padBottom - (Math.max(0, Math.min(100, pct)) / 100) * (height - padTop - padBottom);

    // Rejilla y porcentajes.
    ctx.strokeStyle = '#e2e8f0';
    ctx.fillStyle = '#64748b';
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const pct of [0, 25, 50, 75, 100]) {
        ctx.beginPath();
        ctx.moveTo(padLeft, y(pct));
        ctx.lineTo(width - padRight, y(pct));
        ctx.stroke();
        ctx.fillText(`${pct}%`, padLeft - 6, y(pct));
    }

    // Fechas en el eje: principio, fecha del parte y final.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const iso of [range.from, range.to]) {
        ctx.fillText(formatDate(iso), Math.max(padLeft + 24, Math.min(width - padRight - 24, x(iso))), height - padBottom + 7);
    }

    // Programado: linea punteada.
    if (points.some((p) => p.planned !== null)) {
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#94a3b8';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        let started = false;
        for (const point of points) {
            if (point.planned === null) continue;
            const px = x(point.date);
            const py = y(point.planned);
            if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
        }
        ctx.stroke();
        ctx.restore();
    }

    // Real: solo hasta la fecha del parte, que es lo que se sabe.
    ctx.strokeStyle = '#16a34a';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    let started = false;
    for (const point of points) {
        if (point.date > report.date) break;
        const px = x(point.date);
        const py = y(point.real);
        if (started) ctx.lineTo(px, py); else { ctx.moveTo(px, py); started = true; }
    }
    ctx.stroke();

    // Marca de la fecha del parte.
    if (report.date >= range.from && report.date <= range.to) {
        const cx = x(report.date);
        ctx.strokeStyle = '#2563eb';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, padTop);
        ctx.lineTo(cx, height - padBottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#2563eb';
        ctx.beginPath();
        ctx.arc(cx, y(report.progress.pct), 4, 0, Math.PI * 2);
        ctx.fill();
    }
}

/**
 * Guarda el informe como un .html que se abre en cualquier parte: los dos
 * lienzos se convierten en imagenes y los estilos van dentro del archivo.
 */
async function downloadReport() {
    const sheet = $('#report-sheet');
    if (!sheet) return;
    const clone = sheet.cloneNode(true);
    const originals = sheet.querySelectorAll('canvas');
    const copies = clone.querySelectorAll('canvas');
    for (let i = 0; i < copies.length; i++) {
        const image = document.createElement('img');
        image.src = originals[i].toDataURL('image/png');
        image.className = originals[i].className;
        copies[i].replaceWith(image);
    }

    let css = '';
    try {
        const response = await fetch('css/report.css');
        if (response.ok) css = await response.text();
    } catch (error) {
        console.warn('No se pudo incluir la hoja de estilos del informe:', error);
    }

    const title = `Parte diario ${state.project.name} ${state.reportDate}`;
    const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
body { margin: 0; padding: 16px; background: #f1f3f6; font: 13.5px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
${css}
</style></head>
<body>${clone.outerHTML}</body></html>`;

    download(`${state.project.name}-parte-${state.reportDate}.html`, html, 'text/html;charset=utf-8');
    toast('Informe descargado: se abre en cualquier navegador y se puede enviar por correo.');
}

function wireReport() {
    $('#btn-report').addEventListener('click', () => {
        if (reportActive()) closeReport(); else openReport();
    });
    $('#btn-report-close').addEventListener('click', closeReport);
    $('#btn-report-today').addEventListener('click', () => openReport(todayDate()));
    $('#report-date').addEventListener('change', (e) => {
        state.reportDate = e.target.value || todayDate();
        renderReport();
    });
    $('#btn-report-print').addEventListener('click', () => window.print());
    $('#btn-report-download').addEventListener('click', downloadReport);
    window.addEventListener('resize', () => { if (reportActive()) renderReport(); });
}

/* ------------------------------------------------------------------ */
/* Recursos: personal y maquinaria                                     */
/* ------------------------------------------------------------------ */

/**
 * Carga recursos desde una planilla. Las filas que traen un identificador o un
 * nombre ya conocido actualizan al recurso en vez de duplicarlo, de modo que se
 * puede exportar, corregir en Excel y volver a subir.
 */
async function importResourcesCsv(file) {
    let text;
    try {
        text = await readFileText(file);
    } catch (error) {
        console.error(error);
        return alert('No se pudo leer el archivo.\n\n' + (error.message || error));
    }

    let result;
    try {
        result = resourcesFromCsv(text, state.project.id, state.resources);
    } catch (error) {
        console.error(error);
        return alert('El archivo no parece una planilla de recursos.\n\n' + (error.message || error));
    }

    if (!result.created.length && !result.updated.length) {
        return alert('No se encontro ningun recurso en el archivo.\n\n'
            + 'Hace falta al menos una columna "nombre". Puedes bajar la plantilla '
            + 'con el boton "Plantilla CSV" para ver las columnas que se reconocen.\n\n'
            + `Columnas leidas: ${result.columns.join(', ') || '(ninguna)'}`);
    }

    const touched = [...result.created, ...result.updated];
    await saveResources(touched);
    for (const resource of result.created) state.resources.push(resource);
    state.resources.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));

    renderResources();
    renderResourceFilter();
    renderPlaces();
    renderTasks();
    renderSchedule();

    const bits = [];
    if (result.created.length) bits.push(`${result.created.length} agregado(s)`);
    if (result.updated.length) bits.push(`${result.updated.length} actualizado(s)`);
    if (result.skipped) bits.push(`${result.skipped} fila(s) sin nombre, omitida(s)`);
    toast(`Recursos: ${bits.join(', ')}.`);
}

function resourceById(id) {
    return state.resources.find((resource) => resource.id === id) || null;
}

function renderResources() {
    const list = $('#resource-list');
    const summary = $('#resource-summary');
    const search = $('#resource-search').value.trim().toLowerCase();
    const load = workload(state.resources, state.tasks);

    summary.innerHTML = '';
    for (const type of RESOURCE_TYPES) {
        const total = state.resources.filter((r) => r.type === type.id).length;
        if (total) summary.append(chip(`${total} ${type.plural.toLowerCase()}`, type.color));
    }
    const inactive = state.resources.filter((r) => !r.active).length;
    if (inactive) summary.append(chip(`${inactive} sin actividad`, '#94a3b8'));

    const visible = state.resources.filter((resource) => {
        if (!search) return true;
        return [resource.name, resource.role, resource.group, resource.code, resource.phone]
            .join(' ').toLowerCase().includes(search);
    });

    list.innerHTML = '';
    if (!visible.length) {
        list.innerHTML = state.resources.length
            ? '<li class="empty">Ningun recurso coincide con la busqueda.</li>'
            : '<li class="empty">Todavia no hay personal ni maquinaria. Usa los botones de arriba para agregarlos.</li>';
        return;
    }

    for (const resource of visible) {
        const type = typeOf(resource.type);
        const entry = load.get(resource.id) || { total: 0, open: 0 };
        const item = document.createElement('li');
        item.className = 'resource-item';
        if (!resource.active) item.classList.add('inactive');
        item.innerHTML = `
            <span class="resource-icon"></span>
            <div class="resource-main">
                <strong></strong>
                <div class="resource-meta"></div>
            </div>
            <div class="task-actions">
                <button data-place title="Ubicar en el plano" aria-label="Ubicar en el plano">📍</button>
                <button data-tasks title="Ver sus tareas" aria-label="Ver sus tareas">▤</button>
                <button data-edit title="Editar" aria-label="Editar">✎</button>
            </div>`;
        item.querySelector('.resource-icon').textContent = type.icon;
        item.querySelector('strong').textContent = resource.name;

        const meta = item.querySelector('.resource-meta');
        meta.append(tag(type.label));
        if (resource.role) meta.append(tag(resource.role));
        if (resource.group) meta.append(tag(resource.group));
        if (resource.code) meta.append(tag(resource.code));
        if (resource.phone) meta.append(tag(resource.phone));
        const daily = dailyRateOf(resource);
        if (daily) meta.append(tag(`${formatNumber(daily.perHour)} ${rateUnitLabel(daily.unit)}/h`));
        if (resource.fuel > 0) meta.append(tag(`${formatNumber(resource.fuel)} L/h`));
        if (resource.cost > 0) meta.append(tag(`${formatMoney(resource.cost)}/h`));
        if (resource.shift) meta.append(tag(`Turno ${shiftLabel(resource.shift).toLowerCase()}`));
        // La estadia solo se muestra cuando no es toda la obra.
        if (resource.from || resource.to) {
            meta.append(tag(resource.from && resource.to
                ? `${shortDate(resource.from)} → ${shortDate(resource.to)}`
                : (resource.from ? `Desde ${shortDate(resource.from)}` : `Hasta ${shortDate(resource.to)}`)));
        }
        if (resource.type === 'maquina') {
            const operator = state.resources.find((r) => r.id === resource.operator);
            meta.append(operator ? tag(`Opera ${operator.name}`) : tag('Sin operador', true));
        }
        // Mantencion a la vista cuando el horometro se acerca a la proxima.
        if (resource.hourmeter > 0 && resource.nextService > 0) {
            const left = resource.nextService - resource.hourmeter;
            if (left <= 0) meta.append(tag('Mantencion vencida', true));
            else if (left <= 250) meta.append(tag(`Mantencion en ${formatNumber(left)} h`, true));
        }
        if (!resource.active) meta.append(tag('Sin actividad'));
        meta.append(tag(entry.total ? `${entry.total} tarea(s) · ${entry.open} abierta(s)` : 'Sin tareas'));

        const located = placesOf(resource.id, state.places);
        if (located.length) {
            // Sin etiqueta se muestran las coordenadas: repetir su propio nombre no aporta.
            const where = located
                .map((place) => place.label || `${formatNumber(place.x)} , ${formatNumber(place.y)}`)
                .join(' · ');
            meta.append(tag(`📍 ${where}`));
        }

        // El boton 📍 lleva al punto si ya esta ubicado, o pide uno nuevo.
        item.querySelector('[data-place]').addEventListener('click', (e) => {
            e.stopPropagation();
            if (located.length) focusPlace(located[0]);
            else newPlaceAt([resource.id]);
        });
        item.querySelector('[data-edit]').addEventListener('click', (e) => {
            e.stopPropagation();
            openResourceModal(resource, false);
        });
        item.querySelector('[data-tasks]').addEventListener('click', (e) => {
            e.stopPropagation();
            state.filters.resource = resource.id;
            $('#filter-resource').value = resource.id;
            showTab('tareas');
            renderTasks();
        });
        item.addEventListener('click', () => openResourceModal(resource, false));
        list.append(item);
    }
}

function renderResourceFilter() {
    const select = $('#filter-resource');
    const current = state.filters.resource;
    select.innerHTML = '';
    select.append(new Option('Todo el personal y maquinaria', 'todas'));
    for (const type of RESOURCE_TYPES) {
        const group = state.resources.filter((r) => r.type === type.id);
        if (!group.length) continue;
        const optgroup = document.createElement('optgroup');
        optgroup.label = type.plural;
        for (const resource of group) optgroup.append(new Option(resource.name, resource.id));
        select.append(optgroup);
    }
    select.value = state.resources.some((r) => r.id === current) ? current : 'todas';
    state.filters.resource = select.value;
}

function showTab(name) {
    for (const tab of $$('.tab')) tab.classList.toggle('active', tab.dataset.tab === name);
    for (const panel of $$('.tab-panel')) panel.classList.toggle('active', panel.dataset.panel === name);
    togglePanel(true);
}

function updateResourceHints() {
    const type = $('#resource-type').value;
    $('#resource-role').placeholder = ROLE_HINTS[type] || '';
    $('#resource-code').placeholder = CODE_HINTS[type] || '';
    // El rendimiento, el combustible y la mantencion son cosa de maquinaria.
    const machine = type === 'maquina';
    $('#resource-rate-row').hidden = !machine;
    $('#resource-fuel-row').hidden = !machine;
    $('#resource-service-row').hidden = !machine;
    // Y el operador solo lo lleva una maquina.
    $('#resource-operator-label').hidden = !machine;
    renderResourceRateHint();
}

/** Traduce el rendimiento por hora a lo que rinde en una jornada. */
function renderResourceRateHint() {
    const box = $('#resource-rate-hint');
    if (!box) return;
    const value = Number($('#resource-rate').value);
    const unit = $('#resource-rate-unit').value;
    const hours = Number($('#resource-hours').value) || 8;
    const cost = Number($('#resource-cost').value) || 0;
    const fuel = Number($('#resource-fuel').value) || 0;

    const bits = [];
    if (value > 0 && unit) {
        bits.push(`${formatNumber(value * hours)} ${rateUnitLabel(unit)} por jornada de ${hours} h`);
    }
    if (cost > 0) bits.push(`${formatMoney(cost * hours)} por jornada`);
    if (fuel > 0) bits.push(`${formatNumber(fuel * hours)} L por jornada`);
    box.textContent = bits.length
        ? bits.join(' · ')
        : 'Con el rendimiento por hora y la jornada se calculan los dias de cada tramo y el gasto de la obra.';
}

function openResourceModal(resource, isNew = false) {
    state.resourceDraft = { ...resource, isNew };
    $('#resource-modal-title').textContent = isNew
        ? `Nuevo ${typeOf(resource.type).label.toLowerCase()}`
        : 'Editar recurso';
    $('#resource-type').value = resource.type;
    $('#resource-name').value = resource.name || '';
    $('#resource-role').value = resource.role || '';
    $('#resource-code').value = resource.code || '';
    $('#resource-group').value = resource.group || '';
    $('#resource-phone').value = resource.phone || '';
    $('#resource-active').checked = resource.active !== false;
    $('#resource-notes').value = resource.notes || '';
    const rate = resource.rate || {};
    $('#resource-rate').value = rate.value > 0 ? String(rate.value) : '';
    $('#resource-rate-unit').value = rate.unit || '';
    $('#resource-hours').value = resource.hoursPerDay > 0 ? String(resource.hoursPerDay) : '';
    $('#resource-cost').value = resource.cost > 0 ? String(resource.cost) : '';
    $('#resource-fuel').value = resource.fuel > 0 ? String(resource.fuel) : '';
    $('#resource-brand').value = resource.brand || '';
    $('#resource-hourmeter').value = resource.hourmeter > 0 ? String(resource.hourmeter) : '';
    $('#resource-service').value = resource.nextService > 0 ? String(resource.nextService) : '';
    $('#resource-from').value = resource.from || '';
    $('#resource-to').value = resource.to || '';

    const shift = $('#resource-shift');
    shift.innerHTML = '';
    for (const option of SHIFTS) shift.append(new Option(option.label, option.id));
    shift.value = resource.shift || '';

    // El operador se elige entre el personal de la obra; solo tiene sentido en
    // la maquinaria, asi que la fila aparece y desaparece con el tipo.
    const operator = $('#resource-operator');
    operator.innerHTML = '';
    operator.append(new Option('Sin operador', ''));
    for (const person of state.resources.filter((r) => r.type === 'persona' && r.id !== resource.id)) {
        operator.append(new Option(person.name + (person.shift ? ` · ${shiftLabel(person.shift)}` : ''), person.id));
    }
    operator.value = resource.operator || '';

    $('#btn-delete-resource').hidden = isNew;
    updateResourceHints();
    $('#resource-modal').classList.remove('hidden');
    setTimeout(() => $('#resource-name').focus(), 50);
}

function closeResourceModal() {
    $('#resource-modal').classList.add('hidden');
    state.resourceDraft = null;
    // Si se abrio desde una tarea o un punto, sus listas deben reflejar el cambio.
    if (state.draft) renderResourcePicker();
    if (state.placeDraft) renderPlacePicker();
}

function wireResources() {
    $('#btn-new-person').addEventListener('click', () =>
        openResourceModal(createResource(state.project.id, { type: 'persona' }), true));
    $('#btn-new-machine').addEventListener('click', () =>
        openResourceModal(createResource(state.project.id, { type: 'maquina' }), true));
    $('#resource-search').addEventListener('input', renderResources);
    $('#resource-type').addEventListener('change', updateResourceHints);
    for (const id of ['#resource-rate', '#resource-rate-unit', '#resource-hours', '#resource-cost', '#resource-fuel']) {
        $(id).addEventListener('input', renderResourceRateHint);
    }
    $('#filter-resource').addEventListener('change', (e) => {
        state.filters.resource = e.target.value;
        renderTasks();
    });

    $('#btn-csv-template').addEventListener('click', () => {
        download('plantilla-recursos.csv', resourcesCsvTemplate(), 'text/csv;charset=utf-8');
        toast('Plantilla descargada: llenala en Excel y subela con "Importar CSV".');
    });
    $('#btn-import-resources').addEventListener('click', () => $('#resource-csv-input').click());
    $('#resource-csv-input').addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (file) await importResourcesCsv(file);
    });

    $('#btn-export-resources').addEventListener('click', () => {
        if (!state.resources.length) return toast('No hay recursos para exportar.');
        download(
            `${state.project.name}-recursos.csv`,
            resourcesToCsv(state.resources, state.tasks),
            'text/csv;charset=utf-8'
        );
    });

    $('#btn-manage-resources').addEventListener('click', () =>
        openResourceModal(createResource(state.project.id, { type: 'persona' }), true));

    $('#resource-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const draft = state.resourceDraft;
        if (!draft) return;
        draft.type = $('#resource-type').value;
        draft.name = $('#resource-name').value.trim();
        draft.role = $('#resource-role').value.trim();
        draft.code = $('#resource-code').value.trim();
        draft.group = $('#resource-group').value.trim();
        draft.phone = $('#resource-phone').value.trim();
        draft.active = $('#resource-active').checked;
        draft.notes = $('#resource-notes').value.trim();
        const number = (id) => {
            const value = Number($(id).value);
            return Number.isFinite(value) && value > 0 ? value : null;
        };
        draft.rate = { unit: $('#resource-rate-unit').value, value: number('#resource-rate') || 0 };
        draft.hoursPerDay = number('#resource-hours');
        draft.cost = number('#resource-cost') || 0;
        draft.fuel = number('#resource-fuel') || 0;
        draft.brand = $('#resource-brand').value.trim();
        draft.hourmeter = number('#resource-hourmeter');
        draft.nextService = number('#resource-service');
        draft.from = $('#resource-from').value || '';
        draft.to = $('#resource-to').value || '';
        draft.shift = $('#resource-shift').value || '';
        draft.operator = draft.type === 'maquina' ? ($('#resource-operator').value || '') : '';
        if (!draft.name) return;

        const isNew = draft.isNew;
        delete draft.isNew;
        draft.projectId = state.project.id;
        await saveResource(draft);
        const index = state.resources.findIndex((r) => r.id === draft.id);
        if (index >= 0) state.resources[index] = draft; else state.resources.push(draft);
        state.resources.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));

        // Un recurso recien creado desde una tarea o un punto se asigna solo.
        if (isNew && state.draft && !state.draft.resources.includes(draft.id)) {
            state.draft.resources.push(draft.id);
        }
        if (isNew && state.placeDraft && !state.placeDraft.resources.includes(draft.id)) {
            state.placeDraft.resources.push(draft.id);
        }
        closeResourceModal();
        renderResources();
        renderResourceFilter();
        renderPlaces();
        renderTasks();
        renderSchedule();
        toast(isNew ? 'Recurso agregado.' : 'Recurso actualizado.');
    });

    $('#btn-delete-resource').addEventListener('click', async () => {
        const draft = state.resourceDraft;
        if (!draft) return;
        const load = workload(state.resources, state.tasks).get(draft.id);
        const used = load ? load.total : 0;
        const located = placesOf(draft.id, state.places).length;
        const parts = [];
        if (used) parts.push(`${used} tarea(s)`);
        if (located) parts.push(`${located} punto(s) del plano`);
        const warning = parts.length
            ? `Este recurso esta en ${parts.join(' y ')}. Se quitara de ahi. ¿Eliminar?`
            : '¿Eliminar este recurso?';
        if (!confirm(warning)) return;

        await deleteResource(draft.id);
        state.resources = state.resources.filter((r) => r.id !== draft.id);

        const touched = [];
        for (const task of state.tasks) {
            if (!(task.resources || []).includes(draft.id)) continue;
            task.resources = task.resources.filter((id) => id !== draft.id);
            task.updatedAt = Date.now();
            touched.push(task);
        }
        if (touched.length) await saveTasks(touched);

        const movedPlaces = [];
        for (const place of state.places) {
            if (!(place.resources || []).includes(draft.id)) continue;
            place.resources = place.resources.filter((id) => id !== draft.id);
            movedPlaces.push(place);
        }
        if (movedPlaces.length) await savePlaces(movedPlaces);

        if (state.draft) state.draft.resources = (state.draft.resources || []).filter((id) => id !== draft.id);
        if (state.placeDraft) state.placeDraft.resources = state.placeDraft.resources.filter((id) => id !== draft.id);
        if (state.filters.resource === draft.id) state.filters.resource = 'todas';

        closeResourceModal();
        renderResources();
        renderResourceFilter();
        renderPlaces();
        renderTasks();
        toast('Recurso eliminado.');
    });
}

/* ------------------------------------------------------------------ */
/* Ubicaciones: recursos repartidos en el plano                        */
/* ------------------------------------------------------------------ */

function renderPlaces() {
    const list = $('#place-list');
    const count = $('#place-count');
    list.innerHTML = '';
    count.textContent = state.places.length ? `${state.places.length} punto(s)` : '';

    if (!state.places.length) {
        list.innerHTML = '<li class="empty">Sin puntos. Usa "+ Punto en el plano" o el boton 📍 de cada recurso.</li>';
        return;
    }

    for (const place of state.places) {
        const item = document.createElement('li');
        item.className = 'resource-item';
        item.innerHTML = `
            <span class="resource-icon"></span>
            <div class="resource-main">
                <strong></strong>
                <div class="resource-meta"></div>
            </div>
            <div class="task-actions">
                <button data-focus title="Ver en el plano" aria-label="Ver en el plano">◎</button>
                <button data-edit title="Editar" aria-label="Editar">✎</button>
            </div>`;
        item.querySelector('.resource-icon').textContent = placeIcon(place, state.resources);
        item.querySelector('strong').textContent = placeTitle(place, state.resources);

        const meta = item.querySelector('.resource-meta');
        const names = (place.resources || []).map((id) => resourceById(id)).filter(Boolean);
        // Sin etiqueta propia el titulo ya son los recursos: no se repiten aqui.
        if (place.label) {
            for (const resource of names) meta.append(tag(`${typeOf(resource.type).icon} ${resource.name}`));
        }
        if (!names.length) meta.append(tag('Sin asignar'));
        meta.append(tag(`${formatNumber(place.x)} , ${formatNumber(place.y)}`));
        if (place.note) meta.append(tag(place.note.slice(0, 40)));

        item.querySelector('[data-focus]').addEventListener('click', (e) => {
            e.stopPropagation();
            focusPlace(place);
        });
        item.querySelector('[data-edit]').addEventListener('click', (e) => {
            e.stopPropagation();
            openPlaceModal(place, false);
        });
        item.addEventListener('click', () => openPlaceModal(place, false));
        list.append(item);
    }
}

function focusPlace(place) {
    viewer.centerOn(place.x, place.y);
    togglePanel(false);
}

/** Pide un punto en el plano y crea la ubicacion ahi. */
async function newPlaceAt(preselected = []) {
    const result = await startPick('Toca en el plano donde esta trabajando', { onlyPoint: true });
    if (!result) return;
    const place = createPlace(state.project.id, {
        x: result.point.x,
        y: result.point.y,
        resources: [...preselected]
    });
    openPlaceModal(place, true);
}

function openPlaceModal(place, isNew = false) {
    state.placeDraft = { ...place, resources: [...(place.resources || [])], isNew };
    $('#place-modal-title').textContent = isNew ? 'Nuevo punto' : 'Punto en el plano';
    $('#place-label').value = place.label || '';
    $('#place-from').value = place.from || '';
    $('#place-to').value = place.to || '';
    $('#place-note').value = place.note || '';
    $('#btn-delete-place').hidden = isNew;
    renderPlacePosition();
    renderPlacePicker();
    $('#place-modal').classList.remove('hidden');
    refreshMarkers();
    setTimeout(() => $('#place-label').focus(), 50);
}

function closePlaceModal() {
    $('#place-modal').classList.add('hidden');
    state.placeDraft = null;
    refreshMarkers();
}

function renderPlacePosition() {
    const draft = state.placeDraft;
    if (!draft) return;
    const units = state.project.units === 'sin unidad' ? '' : ` ${state.project.units}`;
    $('#place-position').textContent =
        `Posicion en el plano: ${formatNumber(draft.x)} , ${formatNumber(draft.y)}${units}`;
}

function renderPlacePicker() {
    const draft = state.placeDraft;
    if (!draft) return;
    renderPickerInto($('#place-resources'), draft.resources, (id, on) => {
        const list = new Set(draft.resources);
        if (on) list.add(id); else list.delete(id);
        draft.resources = [...list];
    });
}

function wirePlaces() {
    $('#btn-new-place').addEventListener('click', () => newPlaceAt());

    $('#btn-move-place').addEventListener('click', async () => {
        const draft = state.placeDraft;
        if (!draft) return;
        $('#place-modal').classList.add('hidden');
        const result = await startPick('Toca la nueva posicion del punto', { onlyPoint: true });
        if (result) {
            draft.x = result.point.x;
            draft.y = result.point.y;
        }
        $('#place-modal').classList.remove('hidden');
        renderPlacePosition();
    });

    // Crear el recurso desde aqui lo deja asignado a este punto.
    $('#btn-place-add-resource').addEventListener('click', () =>
        openResourceModal(createResource(state.project.id, { type: 'persona' }), true));

    $('#place-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const draft = state.placeDraft;
        if (!draft) return;
        draft.label = $('#place-label').value.trim();
        draft.from = $('#place-from').value;
        draft.to = $('#place-to').value;
        draft.note = $('#place-note').value.trim();

        const isNew = draft.isNew;
        delete draft.isNew;
        draft.projectId = state.project.id;
        await savePlace(draft);
        const index = state.places.findIndex((p) => p.id === draft.id);
        if (index >= 0) state.places[index] = draft; else state.places.push(draft);

        closePlaceModal();
        renderPlaces();
        renderResources();
        toast(isNew ? 'Punto agregado al plano.' : 'Punto actualizado.');
    });

    $('#btn-delete-place').addEventListener('click', async () => {
        const draft = state.placeDraft;
        if (!draft || !confirm('¿Quitar este punto del plano?')) return;
        await deletePlace(draft.id);
        state.places = state.places.filter((p) => p.id !== draft.id);
        closePlaceModal();
        renderPlaces();
        renderResources();
        toast('Punto eliminado.');
    });

    $('#btn-export-places').addEventListener('click', () => {
        if (!state.places.length) return toast('No hay ubicaciones para exportar.');
        download(
            `${state.project.name}-ubicaciones.csv`,
            placesToCsv(state.places, state.resources),
            'text/csv;charset=utf-8'
        );
    });
}

/* ------------------------------------------------------------------ */
/* Tareas: alta y edicion                                              */
/* ------------------------------------------------------------------ */

function startNewTask(extra = {}, { ignoreSelection = false } = {}) {
    // Con una actividad seleccionada, el tramo nuevo entra en ella y se numera.
    if (!extra.activityId && state.activeActivity) {
        const activity = state.activities.find((a) => a.id === state.activeActivity);
        if (activity) {
            extra = { activityId: activity.id, title: nextTaskName(activity, state.tasks), ...extra };
        }
    }
    const elements = ignoreSelection ? [] : state.selection
        .map((id) => state.shapesById.get(id))
        .filter(Boolean)
        .map((shape) => elementRef(shape, anchorOf(shape)));
    const task = createTask(state.project.id, { elements, ...extra });
    openTaskModal(task, true);
}

function openTaskModal(task, isNew = false) {
    state.draft = JSON.parse(JSON.stringify(task));
    applyTaskHighlight(state.draft);
    state.draft.isNew = isNew;
    $('#task-modal-title').textContent = isNew ? 'Nueva tarea' : 'Editar tarea';
    $('#task-title').value = task.title || '';
    $('#task-status').value = task.status;
    $('#task-priority').value = task.priority;
    $('#task-assignee').value = task.assignee || '';
    renderTaskActivitySelect(task.activityId);
    $('#task-start').value = task.start || '';
    $('#task-due').value = task.due || '';
    $('#task-duration').value = task.duration > 0 ? String(task.duration) : '';
    $('#task-ternas').value = String(ternasOf(task));
    renderTernasField();
    $('#task-description').value = task.description || '';
    $('#btn-delete-task').hidden = isNew;
    if (!Array.isArray(state.draft.resources)) state.draft.resources = [];
    setProgressInputs(taskProgress(task));
    renderLinkedElements();
    renderResourcePicker();
    $('#task-modal').classList.remove('hidden');
    setTimeout(() => $('#task-title').focus(), 50);
}

function closeTaskModal() {
    $('#task-modal').classList.add('hidden');
    state.draft = null;
    clearTaskHighlight();
}

/** Lista de actividades a las que puede pertenecer la tarea. */
/**
 * Las ternas solo pesan cuando la actividad se mide en metros de conductor:
 * el campo aparece solo entonces, con la cuenta a la vista.
 */
function renderTernasField() {
    const field = $('#task-ternas-field');
    if (!field) return;
    const activity = state.activities.find((a) => a.id === $('#task-activity').value);
    const unit = activity ? rateOf(activity).unit : '';
    field.hidden = unit !== 'ml_fase';
    if (field.hidden) return;
    const ternas = Math.max(1, Math.round(Number($('#task-ternas').value) || 1));
    const meters = measureOfTask(state.draft) * ternas * 3;
    $('#task-ternas-hint').textContent = meters > 0
        ? `${ternas} terna(s) x 3 fases = ${formatNumber(meters)} m de conductor.`
        : 'Cada terna son 3 conductores (R, S, T).';
}

/** Metros lineales de los tramos vinculados a una tarea. */
function measureOfTask(task) {
    if (!task) return 0;
    let total = 0;
    for (const ref of task.elements || []) {
        const shape = state.shapesById.get(ref.id);
        const m = shape ? measure(shape) : null;
        if (m && m.length) total += m.length * state.unitScale;
    }
    return total;
}

function renderTaskActivitySelect(current) {
    const select = $('#task-activity');
    select.innerHTML = '';
    select.append(new Option('Sin actividad', ''));
    for (const activity of state.activities) select.append(new Option(activity.name, activity.id));
    select.value = state.activities.some((a) => a.id === current) ? current : '';
}

function setProgressInputs(value) {
    $('#task-progress').value = String(value);
    $('#task-progress-range').value = String(value);
    renderTaskQuantity();
}

/**
 * Totales de la tarea y su avance. Con tramos vinculados el porcentaje no se
 * escribe: sale de los tramos marcados, ponderado por su longitud.
 */
function renderTaskQuantity() {
    if (!state.draft) return;
    const draft = state.draft;
    const quantity = taskQuantity(draft, state.shapesById, state.unitScale);
    const units = state.project.units === 'sin unidad' ? '' : ` ${state.project.units}`;
    const byElements = draft.elements.length > 0;

    // La barra manual solo queda para tareas sin tramos (un punto suelto).
    $('#progress-manual').hidden = byElements;
    $('#progress-computed').hidden = !byElements;

    const parts = [];
    if (quantity.count) parts.push(`${quantity.count} tramo(s)`);
    if (quantity.length) parts.push(`${formatNumber(quantity.length)}${units}`);
    if (quantity.area) parts.push(`${formatNumber(quantity.area)}${units}²`);
    if (quantity.volume) parts.push(`${formatNumber(quantity.volume)} m³`);
    $('#task-quantity').textContent = parts.length
        ? `Total: ${parts.join(' · ')}`
        : 'Sin tramos vinculados: la tarea cuenta por unidad.';

    if (!byElements) return;

    const pct = draft.status === 'completada' ? 100 : progressFromElements(draft, state.shapesById);
    $('#computed-bar').style.width = `${Math.max(0, Math.min(100, pct))}%`;
    $('#computed-pct').textContent = `${Math.round(pct)}%`;

    const done = [];
    done.push(`${quantity.done.count} de ${quantity.count} tramos`);
    if (quantity.length) done.push(`${formatNumber(quantity.done.length)} de ${formatNumber(quantity.length)}${units}`);
    if (quantity.volume) done.push(`${formatNumber(quantity.done.volume)} de ${formatNumber(quantity.volume)} m³`);
    $('#computed-detail').textContent = done.join(' · ');

    const rate = performance(draft, state.shapesById, state.unitScale);
    const rateBox = $('#task-performance');
    if (rate.days) {
        const bits = [`${formatNumber(rate.perDay)}${units}/dia en ${rate.days} dia(s) con avance`];
        if (rate.volumePerDay) bits.push(`${formatNumber(rate.volumePerDay)} m³/dia`);
        if (rate.daysLeft) bits.push(`faltan ${formatNumber(rate.remaining)}${units} ≈ ${rate.daysLeft} dia(s)`);
        rateBox.textContent = bits.join(' · ');
        rateBox.hidden = false;
    } else {
        rateBox.hidden = true;
    }
}

function renderResourcePicker() {
    if (!state.draft) return;
    renderPickerInto($('#task-resources'), state.draft.resources || [], (id, on) => {
        const list = new Set(state.draft.resources || []);
        if (on) list.add(id); else list.delete(id);
        state.draft.resources = [...list];
    });
}

/**
 * Lista de recursos marcables. La comparten el formulario de tarea y el de
 * ubicacion, que asignan personal y maquinaria de la misma manera.
 */
function renderPickerInto(box, selectedIds, onToggle) {
    box.innerHTML = '';
    const assigned = new Set(selectedIds);

    if (!state.resources.length) {
        const empty = document.createElement('p');
        empty.className = 'muted';
        empty.textContent = 'Todavia no hay personal ni maquinaria registrada. Usa el boton de arriba para agregar.';
        box.append(empty);
        return;
    }

    for (const type of RESOURCE_TYPES) {
        const group = state.resources.filter((r) => r.type === type.id);
        if (!group.length) continue;
        const heading = document.createElement('span');
        heading.className = 'picker-heading';
        heading.textContent = type.plural;
        box.append(heading);

        const row = document.createElement('div');
        row.className = 'picker-row';
        for (const resource of group) {
            const label = document.createElement('label');
            label.className = 'picker-chip';
            if (assigned.has(resource.id)) label.classList.add('on');
            if (!resource.active) label.classList.add('inactive');

            const input = document.createElement('input');
            input.type = 'checkbox';
            input.checked = assigned.has(resource.id);
            input.addEventListener('change', () => {
                onToggle(resource.id, input.checked);
                label.classList.toggle('on', input.checked);
            });

            const text = document.createElement('span');
            text.textContent = resource.role ? `${resource.name} · ${resource.role}` : resource.name;
            label.append(input, text);
            row.append(label);
        }
        box.append(row);
    }
}

function measureOf(ref) {
    const shape = state.shapesById.get(ref.id);
    return shape ? measure(shape) : null;
}

/**
 * Lista de tramos de la tarea: cada uno con su casilla de ejecutado, su medida
 * y su seccion de excavacion. De aqui sale el avance real de la tarea.
 */
function renderLinkedElements() {
    const list = $('#linked-list');
    list.innerHTML = '';
    const elements = state.draft.elements;
    $('#linked-count').textContent = elements.length ? `${elements.length} tramo(s)` : '';
    $('#btn-apply-section').hidden = elements.length < 2;

    if (!elements.length) {
        const anchor = state.draft.anchor;
        list.innerHTML = anchor
            ? `<li class="linked-item"><span class="grow">Punto libre ${formatNumber(anchor.x)} , ${formatNumber(anchor.y)}</span></li>`
            : '<li class="empty">Sin tramos. Usa "+ Del plano" para ir tocando los elementos de esta tarea.</li>';
        return;
    }

    const units = state.project.units === 'sin unidad' ? '' : ` ${state.project.units}`;

    elements.forEach((element, index) => {
        const item = document.createElement('li');
        item.className = 'linked-item element-row';
        if (element.done) item.classList.add('done');

        const shapeOf = state.shapesById.get(element.id);
        const totalOf = shapeOf && !shapeOf.closed ? pathLength(shapeOf.pts) : 0;
        const executedOf = totalOf ? refDoneLength(element, totalOf) : 0;
        const completeOf = totalOf ? isRefDone(element, totalOf) : !!element.done;

        const check = document.createElement('label');
        check.className = 'element-check';
        check.title = 'Marcar el tramo completo como ejecutado';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = completeOf;
        input.indeterminate = executedOf > 0 && !completeOf;
        input.addEventListener('change', () => {
            const date = element.doneAt || todayDate();
            element.done = input.checked;
            element.doneAt = input.checked ? date : null;
            element.spans = input.checked && totalOf
                ? normalizeSpans([{ from: 0, to: totalOf, date }], totalOf)
                : [];
            renderLinkedElements();
            renderTaskQuantity();
            applyTaskHighlight(state.draft);
        });
        check.append(input);

        const main = document.createElement('div');
        main.className = 'element-main';

        const title = document.createElement('span');
        title.className = 'element-title';
        const m = measureOf(element);
        const size = m ? ` · ${formatNumber(m.length)}${units}` : '';
        title.textContent = `${KIND_LABELS[element.kind] || element.kind} · ${element.layer}${size}`;
        main.append(title);

        // Avance parcial: cuantos metros de ese tramo lleva esta actividad.
        if (executedOf > 0 && !completeOf) {
            const partial = document.createElement('span');
            partial.className = 'element-partial';
            partial.textContent = `${formatNumber(executedOf)} de ${formatNumber(totalOf)}${units} ejecutados`;
            main.append(partial);
        }

        // Seccion: solo tiene sentido en tramos lineales.
        if (m && !m.area) {
            const section = document.createElement('div');
            section.className = 'element-section';
            const width = numberInput(element.width, 'ancho m', (value) => {
                element.width = value;
                renderLinkedElements();
                renderTaskQuantity();
            });
            const depth = numberInput(element.depth, 'prof m', (value) => {
                element.depth = value;
                renderLinkedElements();
                renderTaskQuantity();
            });
            const times = document.createElement('span');
            times.className = 'muted';
            times.textContent = '×';
            section.append(width, times, depth);

            if (element.width > 0 && element.depth > 0) {
                const volume = document.createElement('span');
                volume.className = 'element-volume';
                volume.textContent =
                    `= ${formatNumber(m.length * state.unitScale * element.width * element.depth)} m³`;
                section.append(volume);
            }
            main.append(section);
        }

        // La fecha se puede corregir: el lunes se registra lo del viernes.
        if (completeOf) {
            const when = document.createElement('label');
            when.className = 'element-date';
            const text = document.createElement('span');
            text.textContent = 'Ejecutado el';
            const date = document.createElement('input');
            date.type = 'date';
            date.value = element.doneAt || todayDate();
            date.addEventListener('change', () => {
                element.doneAt = date.value || todayDate();
                renderTaskQuantity();
            });
            when.append(text, date);
            main.append(when);
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'element-remove';
        remove.title = 'Quitar de la tarea';
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
            state.draft.elements.splice(index, 1);
            renderLinkedElements();
            renderTaskQuantity();
        });

        item.append(check, main, remove);
        list.append(item);
    });
}

function numberInput(value, placeholder, onChange) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.05';
    input.inputMode = 'decimal';
    input.placeholder = placeholder;
    input.value = value === null || value === undefined ? '' : String(value);
    input.addEventListener('change', () => {
        const parsed = Number(input.value);
        onChange(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
    });
    return input;
}

function wireTaskForm() {
    $('#task-activity').addEventListener('change', renderTernasField);
    $('#task-ternas').addEventListener('input', renderTernasField);

    // Barra y numero de avance van sincronizados.
    $('#task-progress-range').addEventListener('input', (e) => {
        $('#task-progress').value = e.target.value;
    });
    $('#task-progress').addEventListener('input', (e) => {
        const value = Math.max(0, Math.min(100, Number(e.target.value) || 0));
        $('#task-progress-range').value = String(value);
    });
    // Completar una tarea implica 100 %; abrirla de nuevo baja de 100.
    $('#task-status').addEventListener('change', (e) => {
        if (e.target.value === 'completada') setProgressInputs(100);
        else if (Number($('#task-progress').value) === 100) setProgressInputs(90);
    });

    $('#task-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const draft = state.draft;
        if (!draft) return;
        draft.title = $('#task-title').value.trim();
        draft.status = $('#task-status').value;
        draft.priority = $('#task-priority').value;
        draft.assignee = $('#task-assignee').value.trim();
        draft.activityId = $('#task-activity').value || null;
        draft.start = $('#task-start').value;
        draft.due = $('#task-due').value;
        const fixed = Number($('#task-duration').value);
        draft.duration = Number.isFinite(fixed) && fixed > 0 ? Math.round(fixed) : null;
        const ternas = Number($('#task-ternas').value);
        draft.ternas = Number.isFinite(ternas) && ternas > 0 ? Math.round(ternas) : 1;
        draft.description = $('#task-description').value.trim();
        const progress = Number($('#task-progress').value);
        draft.progress = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
        // Con tramos vinculados manda lo marcado en el plano, no el numero escrito.
        if (tracksElements(draft)) {
            draft.progress = Math.round(progressFromElements(draft, state.shapesById));
        }
        if (draft.status === 'completada') draft.progress = 100;
        if (!draft.title) return;

        const isNew = draft.isNew;
        delete draft.isNew;
        draft.projectId = state.project.id;
        await saveTask(draft);
        const index = state.tasks.findIndex((t) => t.id === draft.id);
        if (index >= 0) state.tasks[index] = draft; else state.tasks.push(draft);
        const saved = draft;
        closeTaskModal();
        setSelection([]);
        applyTaskHighlight(saved);
        refreshActivityHighlight();
        renderTasks();
        renderSchedule();
        renderResources();
        renderElementPanel();
        toast(isNew ? 'Tarea creada.' : 'Tarea actualizada.');
    });

    $('#btn-delete-task').addEventListener('click', async () => {
        const draft = state.draft;
        if (!draft || !confirm('¿Eliminar esta tarea?')) return;
        await deleteTask(draft.id);
        state.tasks = state.tasks.filter((t) => t.id !== draft.id);
        closeTaskModal();
        renderTasks();
        renderSchedule();
        renderResources();
        renderElementPanel();
        toast('Tarea eliminada.');
    });

    // Modo continuo: el formulario se aparta y se van tocando tramos.
    $('#btn-add-element').addEventListener('click', async () => {
        const draft = state.draft;
        $('#task-modal').classList.add('hidden');
        const banner = () => {
            $('#pick-text').textContent = `Toca los tramos de la tarea — agregados: ${draft.elements.length}`;
        };
        await startPick('Toca los tramos de la tarea — agregados: ' + draft.elements.length, {
            multi: true,
            onEach: (shape) => {
                const index = draft.elements.findIndex((e) => e.id === shape.id);
                // Volver a tocar un tramo ya agregado lo quita, por si te equivocas.
                if (index >= 0) draft.elements.splice(index, 1);
                else draft.elements.push(elementRef(shape, anchorOf(shape)));
                banner();
                viewer.setSelection(draft.elements.map((e) => e.id));
            }
        });
        setSelection([]);
        $('#task-modal').classList.remove('hidden');
        renderLinkedElements();
        renderTaskQuantity();
    });

    // Copiar la seccion del primer tramo al resto ahorra escribirla 12 veces.
    $('#btn-apply-section').addEventListener('click', () => {
        const elements = state.draft.elements;
        const first = elements[0];
        if (!first || !(first.width > 0) || !(first.depth > 0)) {
            return toast('Escribe primero el ancho y la profundidad del primer tramo.');
        }
        for (const element of elements) {
            element.width = first.width;
            element.depth = first.depth;
        }
        renderLinkedElements();
        renderTaskQuantity();
        toast(`Seccion aplicada a ${elements.length} tramos.`);
    });
}

function wireModals() {
    for (const button of $$('#task-modal [data-close]')) button.addEventListener('click', closeTaskModal);
    $('#task-modal').addEventListener('click', (e) => { if (e.target.id === 'task-modal') closeTaskModal(); });

    for (const button of $$('#resource-modal [data-close]')) button.addEventListener('click', closeResourceModal);
    $('#resource-modal').addEventListener('click', (e) => { if (e.target.id === 'resource-modal') closeResourceModal(); });

    for (const button of $$('#place-modal [data-close]')) button.addEventListener('click', closePlaceModal);
    $('#place-modal').addEventListener('click', (e) => { if (e.target.id === 'place-modal') closePlaceModal(); });

    for (const button of $$('#activity-modal [data-close]')) button.addEventListener('click', closeActivityModal);
    $('#activity-modal').addEventListener('click', (e) => { if (e.target.id === 'activity-modal') closeActivityModal(); });

    for (const button of $$('#advance-modal [data-close]')) button.addEventListener('click', closeAdvanceModal);
    $('#advance-modal').addEventListener('click', (e) => { if (e.target.id === 'advance-modal') closeAdvanceModal(); });

    for (const button of $$('#split-modal [data-close]')) button.addEventListener('click', closeSplitModal);
    $('#split-modal').addEventListener('click', (e) => { if (e.target.id === 'split-modal') closeSplitModal(); });

    for (const button of $$('#bulk-modal [data-close]')) button.addEventListener('click', closeBulkModal);
    $('#bulk-modal').addEventListener('click', (e) => { if (e.target.id === 'bulk-modal') closeBulkModal(); });

    for (const button of $$('#wizard-modal [data-close]')) button.addEventListener('click', closeWizard);
    $('#wizard-modal').addEventListener('click', (e) => { if (e.target.id === 'wizard-modal') closeWizard(); });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (state.pick) return endPick(null);
        // Se cierra siempre el dialogo que esta encima.
        if (!$('#resource-modal').classList.contains('hidden')) return closeResourceModal();
        if (!$('#split-modal').classList.contains('hidden')) return closeSplitModal();
        if (!$('#bulk-modal').classList.contains('hidden')) return closeBulkModal();
        if (!$('#wizard-modal').classList.contains('hidden')) return closeWizard();
        if (!$('#advance-modal').classList.contains('hidden')) return closeAdvanceModal();
        if (!$('#activity-modal').classList.contains('hidden')) return closeActivityModal();
        if (!$('#place-modal').classList.contains('hidden')) return closePlaceModal();
        if (!$('#task-modal').classList.contains('hidden')) return closeTaskModal();
        const layersModal = $('#layers-modal');
        if (!layersModal.classList.contains('hidden')) layersModal.querySelector('[data-close]').click();
    });
}

/* ------------------------------------------------------------------ */
/* Copia de seguridad                                                  */
/* ------------------------------------------------------------------ */

async function importBackup(file) {
    showLoading('Restaurando copia…');
    try {
        const data = JSON.parse(await readFileText(file));
        if (data.formato !== 'dxf-tareas') throw new Error('El archivo no es una copia de esta aplicacion.');
        const source = data.proyecto || {};
        const tasks = (data.tareas || []).map((task) => ({ ...task }));
        const resources = (data.recursos || []).map((resource) => ({ ...resource }));
        const places = (data.ubicaciones || []).map((place) => ({ ...place }));
        const activities = (data.actividades || []).map((activity) => ({ ...activity }));

        // Se reasignan los identificadores para poder restaurar la misma copia
        // varias veces sin que un proyecto le pise los datos al anterior.
        const rebind = (projectId) => {
            const actMap = new Map();
            for (const activity of activities) {
                const fresh = normalizeActivity(activity, projectId);
                fresh.id = newId('act');
                actMap.set(activity.id, fresh.id);
                Object.assign(activity, fresh);
            }
            const map = new Map();
            for (const resource of resources) {
                const fresh = normalizeResource(resource, projectId);
                fresh.id = newId('rec');
                map.set(resource.id, fresh.id);
                Object.assign(resource, fresh);
            }
            for (const task of tasks) {
                task.projectId = projectId;
                task.id = newId('task');
                task.resources = (task.resources || []).map((id) => map.get(id)).filter(Boolean);
                task.activityId = actMap.get(task.activityId) || null;
            }
            for (const place of places) {
                const fresh = normalizePlace(place, projectId);
                fresh.id = newId('ubi');
                fresh.resources = (place.resources || []).map((id) => map.get(id)).filter(Boolean);
                Object.assign(place, fresh);
            }
        };

        if (!source.dxf) {
            const existing = source.id ? await getProject(source.id) : null;
            if (!existing) throw new Error('La copia no incluye el plano DXF. Importa primero el archivo DXF y vuelve a intentar.');
            rebind(existing.id);
            await saveActivities(activities);
            await saveResources(resources);
            await savePlaces(places);
            await saveTasks(tasks);
            hideLoading();
            toast('Tareas, recursos y ubicaciones restaurados en el proyecto existente.');
            return refreshRecent();
        }

        const project = {
            id: newId('proy'),
            name: source.nombre || 'Proyecto restaurado',
            fileName: source.archivo || '',
            units: source.unidades || '',
            dxfText: source.dxf,
            layers: source.capas || [],
            edits: Array.isArray(source.ediciones) ? source.ediciones : [],
            view: null,
            createdAt: source.creado || Date.now(),
            updatedAt: Date.now()
        };
        await saveProject(project);
        rebind(project.id);
        await saveActivities(activities);
        await saveResources(resources);
        await savePlaces(places);
        await saveTasks(tasks);
        hideLoading();
        toast('Copia restaurada.');
        refreshRecent();
    } catch (error) {
        hideLoading();
        console.error(error);
        alert('No se pudo restaurar la copia.\n\n' + (error.message || error));
    }
}

/* ------------------------------------------------------------------ */
/* Utilidades                                                          */
/* ------------------------------------------------------------------ */

function scheduleViewSave(camera) {
    if (!state.project) return;
    state.project.view = { x: camera.x, y: camera.y, scale: camera.scale };
    clearTimeout(state.saveViewTimer);
    state.saveViewTimer = setTimeout(() => { saveProject(state.project); }, 1200);
}

function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function showLoading(text) {
    $('#loading-text').textContent = text;
    $('#loading').classList.remove('hidden');
}

function hideLoading() {
    $('#loading').classList.add('hidden');
}

let toastTimer = null;
function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.add('hidden'), 2600);
}

init();
