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
4. **Registra tareas** asociadas a tantos elementos del plano como haga falta
   (puntos, lineas, polilineas, circulos, arcos, textos, bloques) o a un punto
   libre. Cada tarea tiene titulo, estado, prioridad, responsable, vencimiento,
   personal y maquinaria asignados, descripcion y sus tramos (ver mas abajo).
5. **Divide y une elementos del plano** para que una actividad corresponda al
   tramo real ejecutado (ver mas abajo).
6. **Lleva el registro de recursos**: personal y maquinaria de la obra, con
   cargo, cuadrilla, identificador y telefono, asignables a cada tarea.
7. **Reparte los recursos sobre el plano** con puntos que indican quien esta
   trabajando en cada frente (ver mas abajo).
8. **Muestra las tareas sobre el plano** como marcadores numerados con el color
   del estado, y las filtra por texto, estado, capa y recurso.
9. **Calcula el avance ponderado** por longitud y por area, no solo por numero
   de tareas.
10. **Guarda todo en el dispositivo** (IndexedDB) y permite exportar tareas,
    recursos y ubicaciones a CSV, o una copia completa en `.json` que incluye el
    plano.

## Tareas por tramos

Una excavacion o un tendido rara vez son un solo elemento del dibujo. Una tarea
agrupa **todos los tramos que se le asignen**, y cada tramo lleva sus propios
datos:

- **Agregar tramos**: el boton *+ Del plano* aparta el formulario y deja el
  plano libre; se van tocando los tramos uno a uno y un contador muestra
  cuantos llevas. Volver a tocar un tramo ya agregado lo quita. Se cierra con
  *Listo*.
- **Avance sin estimar**: cada tramo se marca como ejecutado y el porcentaje de
  la tarea sale ponderado por la longitud real de cada uno, no por el numero de
  tramos. La barra manual solo queda para tareas sin tramos. Si un tramo esta a
  medias, se divide (ver *Divisiones y uniones*) y se marca la parte hecha.
- **Cubicacion**: cada tramo admite ancho y profundidad, y la tarea calcula
  m³ = longitud × ancho × profundidad. El boton *aplicar la seccion del primero
  a todos* evita escribir la misma seccion doce veces. La longitud se convierte
  a metros segun las unidades declaradas en el DXF.
- **Rendimiento**: al marcar un tramo se guarda la fecha. Con eso se calculan
  metros y m³ por dia sobre los dias en que hubo avance —los dias parados no
  castigan el numero— y se estima cuantos dias faltan.
- **En el plano**: al seleccionar una tarea sus tramos se resaltan, en verde los
  ejecutados y en el color del estado los pendientes. Ademas, tocando un tramo
  del plano aparece en la pestana *Elemento* un boton **Marcar hecho**, para
  registrar el avance parado frente a la obra.

## Recursos repartidos en el plano

En la pestana *Recursos*, ademas del listado de personal y maquinaria, se
pueden crear **puntos** sobre el plano:

- **+ Punto en el plano** pide tocar un lugar y abre el punto para nombrarlo
  (por ejemplo "Frente norte") y elegir quien esta ahi. Si el recurso todavia no
  existe, el boton *+ Recurso* lo crea y lo deja asignado a ese punto.
- El boton **📍** de cada ficha ubica ese recurso directamente, o centra la
  vista en su punto si ya estaba ubicado.
- En el plano cada punto se dibuja como una placa cuadrada con el icono del
  recurso (👷 personal, 🚜 maquinaria) y su color, distinta de los marcadores
  redondos de tareas. Si hay varios recursos en el mismo punto, una insignia
  indica cuantos.
- Tocar la placa abre el punto para cambiar quien esta ahi, moverlo a otro lugar
  o eliminarlo.

Un punto puede existir sin recursos (una posicion prevista) y recibirlos
despues; y un mismo recurso puede estar en mas de un punto.

## Divisiones y uniones

Un plano rara vez viene dibujado en los tramos en que se ejecuta la obra: un
muro puede ser una sola polilinea de 50 m aunque se hormigone en tres etapas.
Por eso los elementos se pueden partir y reagrupar:

- **Dividir** (panel *Elemento* → *Dividir*): tocando el punto de corte en el
  plano, en N partes iguales, o a una distancia exacta del inicio. Cada trozo
  queda como un elemento independiente, con su propia longitud y sus propias
  tareas.
- **Dividir un area**: en figuras cerradas se tocan dos puntos del contorno y la
  superficie se parte con la linea recta entre ambos. Las dos mitades siguen
  siendo areas cerradas y conservan su superficie.
- **Unir** (seleccion multiple con ⧉ → *Unir*): varios elementos abiertos de la
  misma capa que se tocan por sus extremos se convierten en un solo recorrido.
- **Deshacer**: cualquier division o union se revierte desde el mismo panel. Si
  encima de ella se hicieron otras, se avisa antes de deshacerlas en cascada.

El archivo DXF original **no se modifica**. Cada operacion se guarda en el
proyecto como una edicion que se vuelve a aplicar al abrirlo, y las tareas se
reasignan solas al trozo que les corresponde.

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
  las tareas siguen apuntando al mismo elemento al reabrir el proyecto. Los
  trozos creados al dividir usan ese handle mas un sufijo (`A1B~1~xxxx`).
- Las uniones solo alcanzan a elementos abiertos de la misma capa cuyos extremos
  coincidan (con una tolerancia proporcional al tamano del plano). Los circulos
  y las areas cerradas no se unen.

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
js/tasks.js             modelo de tareas, tramos, avance, cubicacion y exportacion
js/resources.js         modelo de personal y maquinaria
js/places.js            puntos del plano donde se ubican los recursos
js/edits.js             geometria de divisiones y uniones
js/app.js               union de todo y logica de pantalla
sw.js                   service worker (uso sin conexion)
manifest.webmanifest    instalacion como aplicacion
```

## Datos y privacidad

Los planos y las tareas no salen del dispositivo: se guardan en IndexedDB del
navegador. Borrar los datos del sitio elimina los proyectos, por lo que conviene
exportar la copia `.json` cuando el trabajo sea importante.
