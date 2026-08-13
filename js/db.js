/*
 * Almacenamiento local (IndexedDB) de proyectos y tareas.
 * Si IndexedDB no esta disponible (por ejemplo navegacion privada antigua)
 * se cae a localStorage, guardando todo menos el DXF original.
 */

const DB_NAME = 'dxf-tareas';
const DB_VERSION = 2;
const STORE_PROJECTS = 'projects';
const STORE_TASKS = 'tasks';
const STORE_RESOURCES = 'resources';
const LS_KEY = 'dxf-tareas:fallback';

let dbPromise = null;

function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) return reject(new Error('sin indexedDB'));
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
                db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(STORE_TASKS)) {
                const store = db.createObjectStore(STORE_TASKS, { keyPath: 'id' });
                store.createIndex('projectId', 'projectId', { unique: false });
            }
            // v2: recursos (personal y maquinaria) por proyecto.
            if (!db.objectStoreNames.contains(STORE_RESOURCES)) {
                const store = db.createObjectStore(STORE_RESOURCES, { keyPath: 'id' });
                store.createIndex('projectId', 'projectId', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('no se pudo abrir la base'));
        request.onblocked = () => reject(new Error('base bloqueada por otra pestana'));
    }).catch((error) => {
        dbPromise = null;
        throw error;
    });
    return dbPromise;
}

function tx(db, stores, mode, run) {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction(stores, mode);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error || new Error('transaccion cancelada'));
        run(transaction);
    });
}

function req(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/* ------------------------- respaldo localStorage ------------------------- */

function readFallback() {
    let data;
    try {
        data = JSON.parse(localStorage.getItem(LS_KEY) || '{}');
    } catch {
        data = {};
    }
    if (!Array.isArray(data.projects)) data.projects = [];
    if (!Array.isArray(data.tasks)) data.tasks = [];
    if (!Array.isArray(data.resources)) data.resources = [];
    return data;
}

function writeFallback(data) {
    try {
        localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch {
        /* sin espacio: se ignora */
    }
}

let useFallback = false;

async function withDb(action, fallbackAction) {
    if (useFallback) return fallbackAction();
    try {
        const db = await openDb();
        return await action(db);
    } catch (error) {
        console.warn('IndexedDB no disponible, se usa localStorage:', error);
        useFallback = true;
        return fallbackAction();
    }
}

export function storageMode() {
    return useFallback ? 'localStorage' : 'IndexedDB';
}

/* ------------------------------ proyectos ------------------------------- */

export async function saveProject(project) {
    project.updatedAt = Date.now();
    return withDb(
        (db) => tx(db, [STORE_PROJECTS], 'readwrite', (t) => t.objectStore(STORE_PROJECTS).put(project)),
        () => {
            const data = readFallback();
            const light = { ...project, dxfText: undefined };
            const i = data.projects.findIndex((p) => p.id === project.id);
            if (i >= 0) data.projects[i] = light; else data.projects.push(light);
            writeFallback(data);
        }
    );
}

export async function getProject(id) {
    return withDb(
        async (db) => {
            const t = db.transaction([STORE_PROJECTS], 'readonly');
            return req(t.objectStore(STORE_PROJECTS).get(id));
        },
        () => readFallback().projects.find((p) => p.id === id) || null
    );
}

export async function listProjects() {
    const projects = await withDb(
        async (db) => {
            const t = db.transaction([STORE_PROJECTS], 'readonly');
            return req(t.objectStore(STORE_PROJECTS).getAll());
        },
        () => readFallback().projects
    );
    return (projects || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export async function deleteProject(id) {
    const tasks = await listTasks(id);
    await Promise.all(tasks.map((task) => deleteTask(task.id)));
    const resources = await listResources(id);
    await Promise.all(resources.map((resource) => deleteResource(resource.id)));
    return withDb(
        (db) => tx(db, [STORE_PROJECTS], 'readwrite', (t) => t.objectStore(STORE_PROJECTS).delete(id)),
        () => {
            const data = readFallback();
            data.projects = data.projects.filter((p) => p.id !== id);
            writeFallback(data);
        }
    );
}

/* -------------------------------- tareas -------------------------------- */

export async function saveTask(task) {
    task.updatedAt = Date.now();
    return withDb(
        (db) => tx(db, [STORE_TASKS], 'readwrite', (t) => t.objectStore(STORE_TASKS).put(task)),
        () => {
            const data = readFallback();
            const i = data.tasks.findIndex((x) => x.id === task.id);
            if (i >= 0) data.tasks[i] = task; else data.tasks.push(task);
            writeFallback(data);
        }
    );
}

export async function saveTasks(tasks) {
    for (const task of tasks) await saveTask(task);
}

export async function listTasks(projectId) {
    const tasks = await withDb(
        async (db) => {
            const t = db.transaction([STORE_TASKS], 'readonly');
            return req(t.objectStore(STORE_TASKS).index('projectId').getAll(projectId));
        },
        () => readFallback().tasks.filter((task) => task.projectId === projectId)
    );
    return (tasks || []).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function deleteTask(id) {
    return withDb(
        (db) => tx(db, [STORE_TASKS], 'readwrite', (t) => t.objectStore(STORE_TASKS).delete(id)),
        () => {
            const data = readFallback();
            data.tasks = data.tasks.filter((task) => task.id !== id);
            writeFallback(data);
        }
    );
}

/* ------------------------------- recursos ------------------------------- */

export async function saveResource(resource) {
    resource.updatedAt = Date.now();
    return withDb(
        (db) => tx(db, [STORE_RESOURCES], 'readwrite', (t) => t.objectStore(STORE_RESOURCES).put(resource)),
        () => {
            const data = readFallback();
            const i = data.resources.findIndex((r) => r.id === resource.id);
            if (i >= 0) data.resources[i] = resource; else data.resources.push(resource);
            writeFallback(data);
        }
    );
}

export async function saveResources(resources) {
    for (const resource of resources) await saveResource(resource);
}

export async function listResources(projectId) {
    const resources = await withDb(
        async (db) => {
            const t = db.transaction([STORE_RESOURCES], 'readonly');
            return req(t.objectStore(STORE_RESOURCES).index('projectId').getAll(projectId));
        },
        () => readFallback().resources.filter((resource) => resource.projectId === projectId)
    );
    return (resources || []).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es'));
}

export async function deleteResource(id) {
    return withDb(
        (db) => tx(db, [STORE_RESOURCES], 'readwrite', (t) => t.objectStore(STORE_RESOURCES).delete(id)),
        () => {
            const data = readFallback();
            data.resources = data.resources.filter((resource) => resource.id !== id);
            writeFallback(data);
        }
    );
}

export function newId(prefix = 'id') {
    const random = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
    return `${prefix}_${random.replace(/-/g, '').slice(0, 16)}`;
}
