# Tareas DXF

Aplicacion web para llevar tareas de terreno sobre un plano DXF. Funciona en
notebook, celular, tablet e iPad con el mismo codigo: es una pagina estatica,
sin servidor ni base de datos remota.

## Que hace

1. **Importa un archivo DXF** (formato ASCII) desde el dispositivo.
2. **Lista las capas** del archivo con la cantidad y el tipo de elementos de
   cada una, y deja elegir cuales importar. Se pueden agregar mas capas
   despues, desde la pestana *Capas*.
3. **Dibuja el plano** en un lienzo con desplazamiento, zoom (rueda, botones o
   pellizco) y seleccion por toque o clic.
4. **Registra tareas** asociadas a uno o varios elementos (puntos, lineas,
   polilineas, circulos, arcos, textos, bloques) o a un punto libre del plano.
   Cada tarea tiene titulo, estado, prioridad, responsable, vencimiento,
   descripcion y los elementos vinculados.
5. **Muestra las tareas sobre el plano** como marcadores numerados con el color
   del estado, y las filtra por texto, estado y capa.
6. **Guarda todo en el dispositivo** (IndexedDB) y permite exportar las tareas a
   CSV o una copia completa en `.json` que incluye el plano.

## Como se usa

- **Abrir la aplicacion:** `index.html` servido por HTTP (por ejemplo
  GitHub Pages). Abrirlo como archivo local `file://` deshabilita el modo sin
  conexion y los modulos de JavaScript.
- **Instalar en el dispositivo:** en Android/escritorio con Chrome, "Instalar
  aplicacion"; en iPhone/iPad con Safari, *Compartir → Agregar a inicio*. Queda
  disponible sin conexion.
- **Gestos:** un dedo arrastra, dos dedos hacen zoom, un toque selecciona, un
  toque largo crea una tarea en ese punto o elemento. Con mouse: rueda para
  zoom, arrastrar para mover, `Shift`/`Ctrl`+clic para sumar elementos a la
  seleccion (o el boton ⧉ para seleccion multiple en tactil).

## Formatos y limites

- DXF **ASCII** (el DXF binario no se lee; hay que exportarlo como "DXF ASCII").
- Entidades reconocidas: `POINT`, `LINE`, `LWPOLYLINE`, `POLYLINE`, `CIRCLE`,
  `ARC`, `ELLIPSE`, `SPLINE`, `SOLID`, `TRACE`, `3DFACE`, `TEXT`, `MTEXT`,
  `ATTRIB` e `INSERT` (los bloques se expanden, incluidas matrices de filas y
  columnas, hasta 8 niveles de anidacion).
- Se ignoran sombreados (`HATCH`), cotas (`DIMENSION`) y entidades 3D de malla.
- Referencia probada: un plano de 40.000 entidades (2,9 MB) se lee en ~0,3 s y
  se dibuja completo en ~50 ms en un equipo de escritorio.
- Los identificadores de los elementos vienen del *handle* del DXF, por lo que
  las tareas siguen apuntando al mismo elemento al reabrir el proyecto.

## Publicar en GitHub Pages

En *Settings → Pages* del repositorio, elegir la rama `main` y la carpeta `/`
(raiz). La aplicacion queda en `https://<usuario>.github.io/tareas-dxf/`.

## Estructura

```
index.html              pantalla inicial, visor, panel y dialogos
css/app.css             estilos (escritorio y tactil)
js/dxf.js               lector DXF y armado de la escena
js/scene.js             indice espacial, seleccion y medidas
js/viewer.js            lienzo, camara y gestos
js/db.js                almacenamiento local (IndexedDB / localStorage)
js/tasks.js             modelo de tareas, filtros y exportacion
js/app.js               union de todo y logica de pantalla
sw.js                   service worker (uso sin conexion)
manifest.webmanifest    instalacion como aplicacion
```

## Datos y privacidad

Los planos y las tareas no salen del dispositivo: se guardan en IndexedDB del
navegador. Borrar los datos del sitio elimina los proyectos, por lo que conviene
exportar la copia `.json` cuando el trabajo sea importante.
