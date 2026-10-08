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
