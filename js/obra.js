/*
 * La obra: los datos que identifican el proyecto y la carpeta donde deja sus
 * archivos.
 *
 * Hasta ahora un proyecto nacia del DXF y se llamaba como el archivo. Una obra
 * es otra cosa: tiene mandante, contratista, codigo y fecha de inicio, y todo
 * eso aparece en el parte diario que se firma. Conviene preguntarlo una vez, al
 * empezar, y no ir descubriendolo despues.
 *
 * Sobre donde se guarda, hay que separar dos cosas que se confunden:
 *
 *   - La BASE DE DATOS de la obra vive siempre en el dispositivo (IndexedDB).
 *     Ahi estan el plano, las tareas, el avance y los recursos, y funciona sin
 *     conexion. Eso no cambia ni se elige.
 *   - La CARPETA DE OBRA es donde caen los archivos que uno quiere tener fuera:
 *     los partes diarios, los CSV, los respaldos. Esa si se elige.
 *
 * La carpeta solo se puede elegir donde el navegador lo permite. Chrome en
 * Windows y en Android dejan; Safari en iPad no implementa el selector de
 * carpetas, asi que ahi los archivos se descargan como siempre. No es una
 * limitacion de la aplicacion sino del navegador, y mas vale decirlo que
 * esconderlo.
 */

/** Carpetas que se crean dentro de la carpeta de obra. */
export const FOLDERS = {
    partes: 'Partes diarios',
    fotos: 'Fotografias',
    planos: 'Planos',
    datos: 'Planillas',
    respaldos: 'Respaldos'
};

export const CALENDARS_HINT = 'Los dias que se trabaja en obra; se usa para calcular el programa.';

/** Si este navegador deja elegir una carpeta del dispositivo. */
export function canPickFolder() {
    return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

/** Por que no se puede, dicho en una linea para la pantalla. */
export function folderUnavailableReason() {
    if (canPickFolder()) return '';
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return ios
        ? 'Safari en iPad y iPhone no deja elegir una carpeta. Los partes y las planillas se descargan a Archivos como hasta ahora.'
        : 'Este navegador no deja elegir una carpeta. Los partes y las planillas se descargan a la carpeta de descargas.';
}

/**
 * Los datos de la obra. Solo el nombre es obligatorio; el resto adorna el parte
 * diario y los informes, y se puede completar despues.
 */
export function createObra(patch = {}) {
    return {
        name: '',
        code: '',          // codigo o numero de contrato
        client: '',        // mandante
        contractor: '',    // contratista o empresa que ejecuta
        place: '',         // comuna, region
        manager: '',       // quien firma: administrador de obra
        start: '',         // fecha de inicio de la obra
        calendar: 'lun-vie',
        currency: 'CLP',
        logoClient: '',    // data URL, para el membrete del parte
        logoContractor: '',
        folderName: '',    // nombre de la carpeta elegida, solo para mostrarlo
        ...patch
    };
}

/** Los campos de la obra que trae un proyecto ya guardado. */
export function obraOf(project) {
    return createObra(project && project.obra ? project.obra : {});
}

/**
 * Pide al usuario una carpeta y arma dentro la estructura de la obra.
 * @returns {Promise<{handle, name}|null>} null si la cancelo.
 */
export async function pickFolder() {
    if (!canPickFolder()) return null;
    let handle;
    try {
        handle = await window.showDirectoryPicker({ id: 'obra', mode: 'readwrite' });
    } catch (error) {
        // El usuario cerro el dialogo: no es un error que haya que mostrar.
        if (error && error.name === 'AbortError') return null;
        throw error;
    }
    await ensureFolders(handle);
    return { handle, name: handle.name };
}

/** Crea las subcarpetas de la obra si no estan. */
export async function ensureFolders(handle) {
    for (const name of Object.values(FOLDERS)) {
        await handle.getDirectoryHandle(name, { create: true });
    }
}

/**
 * Permiso vigente sobre la carpeta. El navegador lo olvida entre sesiones y hay
 * que volver a pedirlo, pero sin dialogo de archivos: basta un gesto.
 */
export async function folderReady(handle, { ask = false } = {}) {
    if (!handle || typeof handle.queryPermission !== 'function') return false;
    const options = { mode: 'readwrite' };
    if (await handle.queryPermission(options) === 'granted') return true;
    if (!ask) return false;
    return await handle.requestPermission(options) === 'granted';
}

/**
 * Escribe un archivo dentro de una subcarpeta de la obra.
 * @returns {Promise<string>} la ruta escrita, para poder decirlo.
 */
export async function writeFile(handle, folder, fileName, contents, type = 'text/plain') {
    const dir = folder ? await handle.getDirectoryHandle(folder, { create: true }) : handle;
    const file = await dir.getFileHandle(fileName, { create: true });
    const stream = await file.createWritable();
    try {
        await stream.write(contents instanceof Blob ? contents : new Blob([contents], { type }));
    } finally {
        await stream.close();
    }
    return folder ? `${handle.name}/${folder}/${fileName}` : `${handle.name}/${fileName}`;
}

/** Subcarpeta por mes, para que los partes no se amontonen en una sola. */
export function monthFolder(date) {
    const iso = String(date || '').slice(0, 7);
    return /^\d{4}-\d{2}$/.test(iso) ? `${FOLDERS.partes}/${iso}` : FOLDERS.partes;
}

/** Un nombre de archivo que no pelee con ningun sistema de archivos. */
export function safeName(text, fallback = 'obra') {
    const clean = String(text || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9 ._-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return clean || fallback;
}

/** Lee una imagen como data URL, para el membrete del parte. */
export function readImage(file, maxSide = 420) {
    return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) return reject(new Error('No es una imagen.'));
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('No se pudo leer la imagen.'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('No se pudo abrir la imagen.'));
            img.onload = () => {
                // Se reduce antes de guardarla: un logo de 4000 px dentro de la
                // base de datos del telefono no le hace bien a nadie.
                const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                if (scale >= 1 && file.size < 120 * 1024) return resolve(reader.result);
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

/* --------------------------- respaldo automatico -------------------------- */

/*
 * El respaldo no es un boton que haya que acordarse de apretar. Cada vez que
 * algo cambia se programa uno, y se escribe cuando la mano se detiene: asi
 * registrar veinte tramos seguidos escribe un archivo, no veinte.
 *
 * Se guarda un archivo por dia, que se va sobrescribiendo. Queda un historial
 * con el que se puede volver a cualquier jornada sin llenar el disco: una obra
 * de medio año son unos 150 archivos de medio mega.
 */

/** Cuanto se espera, sin cambios, antes de escribir el respaldo. */
export const BACKUP_IDLE_MS = 45000;

/** Dias de respaldo que se conservan antes de ir borrando los mas viejos. */
export const BACKUP_KEEP_DAYS = 180;

/** Nombre del respaldo de un dia. El orden alfabetico es el cronologico. */
export function backupName(obraName, date) {
    return `${String(date).slice(0, 10)} ${safeName(obraName, 'obra')}.json`;
}

/**
 * Borra los respaldos que sobran, de los mas antiguos hacia adelante.
 * @returns {Promise<number>} cuantos se borraron.
 */
export async function pruneBackups(handle, keep = BACKUP_KEEP_DAYS) {
    const dir = await handle.getDirectoryHandle(FOLDERS.respaldos, { create: true });
    const names = [];
    for await (const [name, entry] of dir.entries()) {
        if (entry.kind === 'file' && /^\d{4}-\d{2}-\d{2} .+\.json$/.test(name)) names.push(name);
    }
    if (names.length <= keep) return 0;
    names.sort();
    const extra = names.slice(0, names.length - keep);
    for (const name of extra) await dir.removeEntry(name).catch(() => {});
    return extra.length;
}

/** Los respaldos que hay en la carpeta, del mas nuevo al mas viejo. */
export async function listBackups(handle) {
    const dir = await handle.getDirectoryHandle(FOLDERS.respaldos, { create: true });
    const rows = [];
    for await (const [name, entry] of dir.entries()) {
        if (entry.kind !== 'file' || !/\.json$/i.test(name)) continue;
        const file = await entry.getFile();
        rows.push({ name, size: file.size, at: file.lastModified });
    }
    return rows.sort((a, b) => b.name.localeCompare(a.name, 'es'));
}

/* ------------------------- espacio en el dispositivo ---------------------- */

/*
 * El navegador puede borrar la base de datos de un sitio cuando le falta
 * espacio. En una aplicacion de terreno eso es inaceptable: ahi vive el avance
 * del dia, que a veces es la unica copia. Pedir "almacenamiento persistente"
 * lo saca de la lista de lo descartable.
 *
 * Chrome lo concede solo si la aplicacion esta instalada o tiene uso suficiente;
 * Safari lo concede al instalarla en la pantalla de inicio. No se puede obligar,
 * asi que lo que corresponde es pedirlo y decir en que quedo.
 */
export async function askPersistence() {
    if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
        return { supported: false, persisted: false };
    }
    try {
        const already = typeof navigator.storage.persisted === 'function'
            ? await navigator.storage.persisted()
            : false;
        if (already) return { supported: true, persisted: true };
        return { supported: true, persisted: await navigator.storage.persist() };
    } catch (error) {
        return { supported: false, persisted: false };
    }
}

/** Cuanto ocupa la obra y cuanto deja el dispositivo. */
export async function storageUse() {
    if (!navigator.storage || typeof navigator.storage.estimate !== 'function') return null;
    try {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        return { usage, quota };
    } catch (error) {
        return null;
    }
}

/** Si la aplicacion se abrio instalada y no dentro del navegador. */
export function isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

/** Megas o gigas, lo que se lea mejor. */
export function formatBytes(bytes) {
    const mb = (bytes || 0) / (1024 * 1024);
    if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
    return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
