/*
 * Tareas DXF — aplicacion principal.
 * Importa un DXF, permite elegir capas y registrar tareas sobre los elementos
 * del plano. Todo el estado vive en el dispositivo.
 */

import { readDxf, KIND_LABELS, growBounds } from './dxf.js';
import { Viewer, formatNumber } from './viewer.js';
import { anchorOf, measure } from './scene.js';
import {
    saveProject, getProject, listProjects, deleteProject,
    saveTask, saveTasks, listTasks, deleteTask, newId, storageMode,
    saveResource, saveResources, listResources, deleteResource,
    savePlace, savePlaces, listPlaces, deletePlace
} from './db.js';
import {
    STATUSES, PRIORITIES, statusOf, priorityOf, createTask, elementRef, taskAnchor,
    isOverdue, filterTasks, summarize, tasksToCsv, projectToJson, download,
    taskProgress, taskQuantity, progressSummary
} from './tasks.js';
import {
    RESOURCE_TYPES, ROLE_HINTS, CODE_HINTS, typeOf, createResource, normalizeResource,
    workload, resourcesToCsv
} from './resources.js';
import {
    createPlace, normalizePlace, placeIcon, placeColor, placeTitle, placesOf, placesToCsv
} from './places.js';
import {
    applyEdits, makeEdit, removeEdit, editOfShape, canSplit, splitOpen, splitClosed,
    equalCuts, projectOnPath, pathLength, chain, joinTolerance, MIN_PART_RATIO
} from './edits.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
    project: null,
    allShapes: [],          // tal como vienen del DXF
    editedShapes: [],       // despues de aplicar divisiones y uniones
    shapes: [],             // ademas, filtradas por capas importadas
    shapesById: new Map(),
    sceneBounds: null,
    layers: new Map(),      // nombre -> {name, color, visible, imported, count, kinds}
    tasks: [],
    resources: [],
    places: [],
    selection: [],          // ids de figuras
    multi: false,
    filters: { text: '', status: 'todas', layer: 'todas', resource: 'todas' },
    draft: null,            // tarea en edicion
    resourceDraft: null,    // recurso en edicion
    placeDraft: null,       // ubicacion en edicion
    splitTarget: null,      // figura que se esta dividiendo
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
    wireSplitModal();

    refreshRecent();
    registerServiceWorker();

    // Acceso desde la consola del navegador para diagnosticar en obra.
    window.tareasDxf = { state, get viewer() { return viewer; } };
}

function fillSelect(select, options, allValue, allLabel) {
    select.innerHTML = '';
    if (allValue) select.append(new Option(allLabel, allValue));
    for (const option of options) select.append(new Option(option.label, option.id));
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    navigator.serviceWorker.register('sw.js').catch(() => { /* sin modo offline */ });
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
        loadIntoApp(project, scene, [], [], []);
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
        hideLoading();
        loadIntoApp(project, scene, tasks, resources, places);
    } catch (error) {
        hideLoading();
        console.error(error);
        alert('No se pudo abrir el proyecto.\n\n' + (error.message || error));
    }
}

function loadIntoApp(project, scene, tasks, resources = [], places = []) {
    state.project = project;
    if (!Array.isArray(project.edits)) project.edits = [];
    state.allShapes = scene.shapes;
    state.tasks = tasks;
    state.resources = resources;
    state.places = places;
    state.selection = [];
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

    if (state.pick) {
        const shape = viewer.pickAt(local.x, local.y);
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
            const best = nearestPart(parts, ref);
            if (best && !seen.has(best.id)) {
                next.push(elementRef(best, keepNear(best, ref)));
                seen.add(best.id);
            }
        }
        task.elements = next;
        task.updatedAt = Date.now();
        touched.push(task);
    }
    return touched;
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

function nearestPart(parts, ref) {
    let best = null;
    let bestDistance = Infinity;
    for (const part of parts) {
        const distance = projectOnPath(part.pts, ref.x, ref.y).distance;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = part;
        }
    }
    return best;
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

    // Las tareas que apuntaban a partes eliminadas vuelven al elemento original.
    const candidates = [...restored].map((id) => state.shapesById.get(id)).filter(Boolean);
    const touched = [];
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
            const shape = nearestPart(candidates, ref);
            if (shape && !seen.has(shape.id)) {
                next.push(elementRef(shape, keepNear(shape, ref)));
                seen.add(shape.id);
            }
        }
        if (changed) {
            task.elements = next;
            task.updatedAt = Date.now();
            touched.push(task);
        }
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

function startPick(message, { allowPoint = false, onlyPoint = false } = {}) {
    return new Promise((resolve) => {
        state.pick = { resolve, allowPoint, onlyPoint };
        $('#pick-text').textContent = message;
        $('#pick-banner').classList.remove('hidden');
        togglePanel(false);
    });
}

function endPick(result) {
    const pick = state.pick;
    state.pick = null;
    $('#pick-banner').classList.add('hidden');
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
        const csv = tasksToCsv(state.tasks, { shapesById: state.shapesById, resources: state.resources });
        download(`${state.project.name}-tareas.csv`, csv, 'text/csv;charset=utf-8');
    });
    $('#btn-export-json').addEventListener('click', () => {
        const json = projectToJson(state.project, state.tasks, {
            includeDxf: true,
            resources: state.resources,
            places: state.places
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

    const summary = progressSummary(state.tasks, state.shapesById);
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

    if (!visible.length) {
        list.innerHTML = state.tasks.length
            ? '<li class="empty">Ninguna tarea coincide con el filtro.</li>'
            : '<li class="empty">Sin tareas. Toca un elemento del plano y usa "+ Tarea".</li>';
    }

    visible.forEach((task, index) => {
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
        item.querySelector('strong').textContent = `${index + 1}. ${task.title || '(sin titulo)'}`;
        const meta = item.querySelector('.task-meta');
        meta.append(tag(status.label), tag(`Prioridad ${priorityOf(task.priority).label.toLowerCase()}`));
        const layers = [...new Set(task.elements.map((e) => e.layer))];
        if (layers.length) meta.append(tag(layers.join(', ')));
        if (task.elements.length) meta.append(tag(`${task.elements.length} elemento(s)`));
        if (task.assignee) meta.append(tag(task.assignee));
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
        list.append(item);
    });

    renderMarkers(visible);
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
    for (const place of state.places) {
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
    tasks.forEach((task, index) => {
        const anchor = taskAnchor(task);
        if (!anchor) return;
        markers.push({
            id: task.id,
            x: anchor.x,
            y: anchor.y,
            color: statusOf(task.status).color,
            label: String(index + 1),
            active: state.draft ? state.draft.id === task.id : false
        });
    });
    viewer.setMarkers(markers);
}

function focusTask(task) {
    const anchor = taskAnchor(task);
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

function startNewTask(extra = {}) {
    const elements = state.selection
        .map((id) => state.shapesById.get(id))
        .filter(Boolean)
        .map((shape) => elementRef(shape, anchorOf(shape)));
    const task = createTask(state.project.id, { elements, ...extra });
    openTaskModal(task, true);
}

function openTaskModal(task, isNew = false) {
    state.draft = JSON.parse(JSON.stringify(task));
    state.draft.isNew = isNew;
    $('#task-modal-title').textContent = isNew ? 'Nueva tarea' : 'Editar tarea';
    $('#task-title').value = task.title || '';
    $('#task-status').value = task.status;
    $('#task-priority').value = task.priority;
    $('#task-assignee').value = task.assignee || '';
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
}

function setProgressInputs(value) {
    $('#task-progress').value = String(value);
    $('#task-progress-range').value = String(value);
    renderTaskQuantity();
}

/** Muestra cuanta obra representa la tarea, que es la base del avance real. */
function renderTaskQuantity() {
    const label = $('#task-quantity');
    if (!state.draft) return;
    const quantity = taskQuantity(state.draft, state.shapesById);
    const units = state.project.units === 'sin unidad' ? '' : ` ${state.project.units}`;
    const parts = [];
    if (quantity.length) parts.push(`longitud ${formatNumber(quantity.length)}${units}`);
    if (quantity.area) parts.push(`area ${formatNumber(quantity.area)}${units}²`);
    label.textContent = parts.length
        ? `Cantidad vinculada: ${parts.join(' · ')}. El avance se pondera con esta cantidad.`
        : 'Sin elementos vinculados: la tarea solo cuenta por unidad.';
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

function renderLinkedElements() {
    const list = $('#linked-list');
    list.innerHTML = '';
    const elements = state.draft.elements;
    if (!elements.length) {
        const anchor = state.draft.anchor;
        list.innerHTML = anchor
            ? `<li class="linked-item"><span class="grow">Punto libre ${formatNumber(anchor.x)} , ${formatNumber(anchor.y)}</span></li>`
            : '<li class="empty">Sin elementos. La tarea quedara sin ubicacion en el plano.</li>';
        return;
    }
    elements.forEach((element, index) => {
        const item = document.createElement('li');
        item.className = 'linked-item';
        const label = document.createElement('span');
        label.className = 'grow';
        label.textContent = `${KIND_LABELS[element.kind] || element.kind} · ${element.layer}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.title = 'Quitar';
        remove.textContent = '✕';
        remove.addEventListener('click', () => {
            state.draft.elements.splice(index, 1);
            renderLinkedElements();
            renderTaskQuantity();
        });
        item.append(label, remove);
        list.append(item);
    });
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
        draft.due = $('#task-due').value;
        draft.description = $('#task-description').value.trim();
        const progress = Number($('#task-progress').value);
        draft.progress = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
        if (draft.status === 'completada') draft.progress = 100;
        if (!draft.title) return;

        const isNew = draft.isNew;
        delete draft.isNew;
        draft.projectId = state.project.id;
        await saveTask(draft);
        const index = state.tasks.findIndex((t) => t.id === draft.id);
        if (index >= 0) state.tasks[index] = draft; else state.tasks.push(draft);
        closeTaskModal();
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

    $('#btn-add-element').addEventListener('click', async () => {
        const draft = state.draft;
        $('#task-modal').classList.add('hidden');
        const result = await startPick('Toca el elemento que quieres vincular', { allowPoint: true });
        if (result && result.shape) {
            const shape = result.shape;
            if (!draft.elements.some((e) => e.id === shape.id)) {
                draft.elements.push(elementRef(shape, anchorOf(shape)));
            }
        } else if (result && result.point) {
            draft.anchor = { x: result.point.x, y: result.point.y };
        }
        $('#task-modal').classList.remove('hidden');
        renderLinkedElements();
        renderTaskQuantity();
    });
}

function wireModals() {
    for (const button of $$('#task-modal [data-close]')) button.addEventListener('click', closeTaskModal);
    $('#task-modal').addEventListener('click', (e) => { if (e.target.id === 'task-modal') closeTaskModal(); });

    for (const button of $$('#resource-modal [data-close]')) button.addEventListener('click', closeResourceModal);
    $('#resource-modal').addEventListener('click', (e) => { if (e.target.id === 'resource-modal') closeResourceModal(); });

    for (const button of $$('#place-modal [data-close]')) button.addEventListener('click', closePlaceModal);
    $('#place-modal').addEventListener('click', (e) => { if (e.target.id === 'place-modal') closePlaceModal(); });

    for (const button of $$('#split-modal [data-close]')) button.addEventListener('click', closeSplitModal);
    $('#split-modal').addEventListener('click', (e) => { if (e.target.id === 'split-modal') closeSplitModal(); });

    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (state.pick) return endPick(null);
        // Se cierra siempre el dialogo que esta encima.
        if (!$('#resource-modal').classList.contains('hidden')) return closeResourceModal();
        if (!$('#split-modal').classList.contains('hidden')) return closeSplitModal();
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

        // Se reasignan los identificadores para poder restaurar la misma copia
        // varias veces sin que un proyecto le pise los datos al anterior.
        const rebind = (projectId) => {
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
