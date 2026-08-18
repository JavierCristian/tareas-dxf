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
    performance, elementsToCsv
} from './tasks.js';
import {
    RESOURCE_TYPES, ROLE_HINTS, CODE_HINTS, typeOf, createResource, normalizeResource,
    workload, resourcesToCsv
} from './resources.js';
import {
    createPlace, normalizePlace, placeIcon, placeColor, placeTitle, placesOf, placesAt, placesToCsv
} from './places.js';
import {
    ACTIVITY_COLORS, createActivity, normalizeActivity, tasksOf, looseTasks,
    activityProgress, nextTaskName, reorder
} from './activities.js';
import {
    projectRange, projectStateAt, taskStateAt, progressCurve, addDays, daysBetween,
    formatDate, todayISO as todayDate
} from './timeline.js';
import {
    applyEdits, makeEdit, removeEdit, editOfShape, canSplit, splitOpen, splitClosed,
    equalCuts, projectOnPath, pathLength, chain, joinTolerance, MIN_PART_RATIO
} from './edits.js';

/* Version visible de la aplicacion. Debe ir a la par del CACHE de sw.js:
   asi se puede comprobar de un vistazo que version esta corriendo. */
export const APP_VERSION = '8';

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
    selection: [],          // ids de figuras
    multi: false,
    filters: { text: '', status: 'todas', layer: 'todas', resource: 'todas' },
    draft: null,            // tarea en edicion
    resourceDraft: null,    // recurso en edicion
    placeDraft: null,       // ubicacion en edicion
    activityDraft: null,    // actividad en edicion
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
    renderSelectionCard();
    renderElementPanel();
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
    if (activity && state.activeActivity === activity.id) item.classList.add('on');

    const progress = activity
        ? activityProgress(activity.id, state.tasks, state.shapesById, state.unitScale)
        : null;

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

    // Tocar la cabecera resalta toda la actividad en el plano.
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

        actions.append(add, edit, up, down);
        item.append(actions);
    }
    return item;
}

function renderTaskItem(task, index) {
    const status = statusOf(task.status);
    const item = document.createElement('li');
    item.className = 'task-item';
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

    const timeState = date ? projectStateAt(state.tasks, state.shapesById, date, state.unitScale) : null;
    tasks.forEach((task, index) => {
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
            label: String(index + 1),
            active: state.draft ? state.draft.id === task.id : false
        });
    });
    viewer.setMarkers(markers);
}

const DONE_COLOR = '#22c55e';
const PENDING_COLOR = '#ef4444';

/**
 * Resalta los tramos de una tarea: verde los ejecutados, el color del estado
 * los pendientes. Con la linea de tiempo abierta manda la fecha del cursor.
 */
function applyTaskHighlight(task) {
    if (timelineActive() || state.activeActivity) return;
    if (!task || !task.elements.length) return clearTaskHighlight();
    const map = new Map();
    for (const ref of task.elements) {
        if (!state.shapesById.has(ref.id)) continue;
        map.set(ref.id, ref.done ? DONE_COLOR : PENDING_COLOR);
    }
    // El resto del plano se apaga para que se lea solo esta actividad.
    viewer.setTaskHighlight(map, true);
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
            const mark = document.createElement('button');
            mark.className = 'mark-done' + (ref.done ? ' on' : '');
            mark.textContent = ref.done ? '✓ Hecho' : 'Marcar hecho';
            mark.title = ref.done && ref.doneAt ? `Ejecutado el ${ref.doneAt}` : 'Marcar este tramo como ejecutado';
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
    ref.done = !ref.done;
    ref.doneAt = ref.done ? (ref.doneAt || todayDate()) : null;
    task.progress = Math.round(progressFromElements(task, state.shapesById));
    if (task.progress === 100 && task.status !== 'completada') task.status = 'completada';
    else if (task.progress < 100 && task.status === 'completada') task.status = 'en_curso';
    task.updatedAt = Date.now();

    await saveTask(task);
    applyTaskHighlight(task);
    refreshActivityHighlight();
    renderTasks();
    renderElementPanel();
    toast(ref.done ? `Tramo marcado como hecho (${task.progress}% de la tarea).` : 'Tramo marcado como pendiente.');
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
    const map = new Map();
    for (const task of tasksOf(activityId, state.tasks)) {
        for (const ref of task.elements) {
            if (!state.shapesById.has(ref.id)) continue;
            map.set(ref.id, ref.done ? DONE_COLOR : PENDING_COLOR);
        }
    }
    if (!map.size) toast('Esta actividad todavia no tiene tramos en el plano.');
    viewer.setTaskHighlight(map, true);
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

async function moveActivity(id, delta) {
    const sorted = reorder(state.activities, id, delta);
    if (!sorted) return;
    state.activities = sorted;
    await saveActivities(sorted);
    renderTasks();
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
        toast('Actividad eliminada.');
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

    if (!Number.isFinite(meters) || meters <= 0) {
        box.innerHTML = `Longitud del tramo: ${formatNumber(total)}${units}.`;
        return;
    }
    // Los metros van en metros reales; el plano puede estar en otras unidades.
    const along = meters / state.unitScale;
    if (along >= total * (1 - MIN_PART_RATIO)) {
        box.innerHTML = `El tramo completo (<b>${formatNumber(total)}${units}</b>) queda ejecutado. No se divide.`;
        return;
    }
    const rest = total - along;
    box.innerHTML = `Se corta a los ${formatNumber(along)}${units}: `
        + `<b>${formatNumber(along)}${units} ejecutados</b> y `
        + `<i>${formatNumber(rest)}${units} pendientes</i>.`;
}

async function submitAdvance() {
    const advance = state.advance;
    if (!advance) return;
    const { shape, fromStart } = advance;
    const meters = Number($('#advance-meters').value);
    if (!Number.isFinite(meters) || meters <= 0) return toast('Escribe cuantos metros se ejecutaron.');

    const date = $('#advance-date').value || todayDate();
    const taskId = $('#advance-task').value;
    const total = pathLength(shape.pts);
    const along = meters / state.unitScale;
    closeAdvanceModal();

    // Avance que cubre el tramo entero: no hay nada que dividir.
    if (along >= total * (1 - MIN_PART_RATIO)) {
        return markRefDone(taskId, shape.id, date);
    }
    if (along <= total * MIN_PART_RATIO) {
        return toast('El metraje es demasiado pequeno para este tramo.');
    }

    const cut = fromStart ? along : total - along;
    const parts = splitOpen(shape, [cut]);
    if (parts.length < 2) return toast('No se pudo dividir el tramo.');

    const edit = makeEdit('division', [shape], parts);
    // La parte ejecutada es la del extremo desde el que se midio.
    const executedId = (fromStart ? edit.parts[0] : edit.parts[edit.parts.length - 1]).id;
    await commitEdit(edit, `Avance de ${formatNumber(along)} registrado.`);
    await markRefDone(taskId, executedId, date);
}

/** Marca un tramo como ejecutado dentro de una actividad y guarda. */
async function markRefDone(taskId, shapeId, date) {
    const task = state.tasks.find((t) => t.id === taskId);
    if (!task) return;
    const ref = task.elements.find((e) => e.id === shapeId);
    if (!ref) return toast('El tramo quedo fuera de la actividad.');

    ref.done = true;
    ref.doneAt = date;
    task.progress = Math.round(progressFromElements(task, state.shapesById));
    if (task.progress === 100 && task.status !== 'completada') task.status = 'completada';
    else if (task.progress < 100 && task.status === 'completada') task.status = 'en_curso';
    task.updatedAt = Date.now();

    await saveTask(task);
    setSelection([]);
    applyTaskHighlight(task);
    refreshActivityHighlight();
    renderTasks();
    renderElementPanel();
    // En pantalla chica el panel tapa el plano: se cierra para ver el resultado.
    if (window.matchMedia('(max-width: 900px)').matches) togglePanel(false);
    toast(`${task.title || 'Actividad'}: ${task.progress}% ejecutado.`);
}

function wireAdvance() {
    $('#btn-advance-flip').addEventListener('click', () => {
        if (!state.advance) return;
        state.advance.fromStart = !state.advance.fromStart;
        renderAdvanceOrigin();
    });
    $('#advance-meters').addEventListener('input', renderAdvancePreview);
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
    const range = projectRange(state.tasks, state.places);
    if (!range) {
        return toast('Todavia no hay fechas: marca tramos o pon inicio y termino a una tarea.');
    }
    const today = todayDate();
    const date = today < range.from ? range.from : (today > range.to ? range.to : today);
    state.timeline = { ...range, date, playing: false, timer: null };

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
    const state_ = projectStateAt(state.tasks, state.shapesById, date, state.unitScale);

    $('#timeline-date').textContent = formatDate(date) + (date === todayDate() ? ' · hoy' : '');

    // Todos los tramos de todas las tareas, segun estaban a esa fecha.
    const highlight = new Map();
    for (const task of state.tasks) {
        const taskState = state_.perTask.get(task.id);
        for (const ref of task.elements) {
            if (!state.shapesById.has(ref.id)) continue;
            highlight.set(ref.id, taskState.doneIds.has(ref.id) ? DONE_COLOR : PENDING_COLOR);
        }
    }
    viewer.setTaskHighlight(highlight, true);
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

    const points = progressCurve(state.tasks, state.shapesById, timeline, state.unitScale);
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
/* Recursos: personal y maquinaria                                     */
/* ------------------------------------------------------------------ */

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
    $('#filter-resource').addEventListener('change', (e) => {
        state.filters.resource = e.target.value;
        renderTasks();
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

        const check = document.createElement('label');
        check.className = 'element-check';
        check.title = 'Marcar el tramo como ejecutado';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = !!element.done;
        input.addEventListener('change', () => {
            element.done = input.checked;
            element.doneAt = input.checked ? (element.doneAt || todayDate()) : null;
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
        if (element.done) {
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

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (state.pick) return endPick(null);
        // Se cierra siempre el dialogo que esta encima.
        if (!$('#resource-modal').classList.contains('hidden')) return closeResourceModal();
        if (!$('#split-modal').classList.contains('hidden')) return closeSplitModal();
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
