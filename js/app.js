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
    saveTask, saveTasks, listTasks, deleteTask, newId, storageMode
} from './db.js';
import {
    STATUSES, PRIORITIES, statusOf, priorityOf, createTask, elementRef, taskAnchor,
    isOverdue, filterTasks, summarize, tasksToCsv, projectToJson, download
} from './tasks.js';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
    project: null,
    allShapes: [],
    shapes: [],
    shapesById: new Map(),
    sceneBounds: null,
    layers: new Map(),      // nombre -> {name, color, visible, imported, count, kinds}
    tasks: [],
    selection: [],          // ids de figuras
    multi: false,
    filters: { text: '', status: 'todas', layer: 'todas' },
    draft: null,            // tarea en edicion
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

    wireWelcome();
    wireTopbar();
    wirePanel();
    wireModals();
    wireTaskForm();

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
            view: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        await saveProject(project);
        if (scene.truncated) {
            toast('El plano es muy grande: se cargo una parte de las entidades.');
        }
        loadIntoApp(project, scene, []);
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
        hideLoading();
        loadIntoApp(project, scene, tasks);
    } catch (error) {
        hideLoading();
        console.error(error);
        alert('No se pudo abrir el proyecto.\n\n' + (error.message || error));
    }
}

function loadIntoApp(project, scene, tasks) {
    state.project = project;
    state.allShapes = scene.shapes;
    state.tasks = tasks;
    state.selection = [];
    state.filters = { text: '', status: 'todas', layer: 'todas' };
    $('#filter-text').value = '';
    $('#filter-status').value = 'todas';

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
    const imported = new Set([...state.layers.values()].filter((l) => l.imported).map((l) => l.name));
    state.shapes = state.allShapes.filter((shape) => imported.has(shape.layer));
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
    $('#project-meta').textContent =
        `${state.shapes.length} elementos · ${imported}/${state.layers.size} capas · ${state.project.units}`;
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
        if (state.pick.allowPoint && !shape) return endPick({ point: world });
        if (!shape) return toast('No hay ningun elemento en ese punto.');
        return endPick({ shape });
    }

    const marker = viewer.pickMarkerAt(local.x, local.y);
    if (marker) {
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
/* Modo "elegir del plano"                                             */
/* ------------------------------------------------------------------ */

function startPick(message, { allowPoint = false } = {}) {
    return new Promise((resolve) => {
        state.pick = { resolve, allowPoint };
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
        download(`${state.project.name}-tareas.csv`, tasksToCsv(state.tasks), 'text/csv;charset=utf-8');
    });
    $('#btn-export-json').addEventListener('click', () => {
        download(`${state.project.name}.json`, projectToJson(state.project, state.tasks, { includeDxf: true }), 'application/json');
        toast('Copia generada (incluye el plano).');
    });
}

function renderAll() {
    renderLayers();
    renderLayerFilter();
    renderTasks();
    renderSelectionCard();
    renderElementPanel();
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
    const visible = filterTasks(state.tasks, state.filters);
    list.innerHTML = '';

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
        if (task.due) meta.append(tag(`Vence ${task.due}`, isOverdue(task)));

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

function renderMarkers(tasks) {
    const markers = [];
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
            ['Origen', shape.entityType],
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
    const action = document.createElement('button');
    action.className = 'btn primary';
    action.textContent = 'Nueva tarea con esta seleccion';
    action.addEventListener('click', () => startNewTask());
    container.append(action);
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
    renderLinkedElements();
    $('#task-modal').classList.remove('hidden');
    setTimeout(() => $('#task-title').focus(), 50);
}

function closeTaskModal() {
    $('#task-modal').classList.add('hidden');
    state.draft = null;
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
        });
        item.append(label, remove);
        list.append(item);
    });
}

function wireTaskForm() {
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
        if (!draft.title) return;

        const isNew = draft.isNew;
        delete draft.isNew;
        draft.projectId = state.project.id;
        await saveTask(draft);
        const index = state.tasks.findIndex((t) => t.id === draft.id);
        if (index >= 0) state.tasks[index] = draft; else state.tasks.push(draft);
        closeTaskModal();
        renderTasks();
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
    });
}

function wireModals() {
    for (const button of $$('#task-modal [data-close]')) button.addEventListener('click', closeTaskModal);
    $('#task-modal').addEventListener('click', (e) => { if (e.target.id === 'task-modal') closeTaskModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (state.pick) return endPick(null);
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

        if (!source.dxf) {
            const existing = source.id ? await getProject(source.id) : null;
            if (!existing) throw new Error('La copia no incluye el plano DXF. Importa primero el archivo DXF y vuelve a intentar.');
            for (const task of tasks) task.projectId = existing.id;
            await saveTasks(tasks);
            hideLoading();
            toast('Tareas restauradas en el proyecto existente.');
            return refreshRecent();
        }

        const project = {
            id: newId('proy'),
            name: source.nombre || 'Proyecto restaurado',
            fileName: source.archivo || '',
            units: source.unidades || '',
            dxfText: source.dxf,
            layers: source.capas || [],
            view: null,
            createdAt: source.creado || Date.now(),
            updatedAt: Date.now()
        };
        await saveProject(project);
        for (const task of tasks) {
            task.projectId = project.id;
            task.id = task.id || newId('task');
        }
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
