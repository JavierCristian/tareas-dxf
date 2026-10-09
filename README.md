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
   cargo, cuadrilla, identificador, telefono, rendimiento por hora, consumo de
   combustible y costo por hora. Se cargan de a uno o desde una planilla CSV
   (ver mas abajo).
7. **Reparte los recursos sobre el plano** con puntos que indican quien esta
   trabajando en cada frente (ver mas abajo).
8. **Muestra las tareas sobre el plano** como marcadores numerados con el color
   del estado, y las filtra por texto, estado, capa y recurso.
9. **Calcula el avance ponderado** por longitud y por area, no solo por numero
   de tareas.
10. **Programa la obra tramo a tramo**: la duracion sale del rendimiento de
    cada actividad y de la cantidad que el plano ya conoce, y cada tramo espera
    solo al tramo de su misma ubicacion, aunque esten en capas distintas
    (ver mas abajo).
11. **Carga tramos desde una capa** completa, de una vez, en lugar de ir
    elemento por elemento.
12. **Arma la obra entera desde el plano** cuando el DXF viene clasificado por
    tipo de zanja y por circuito: crea las actividades encadenadas y todos sus
    tramos, cada uno con su nombre de terreno y su seccion, y avisa si alguna
    zanja se queda corta para los circuitos que pasan por ella (ver mas abajo).
13. **Emite el parte diario** de la obra: lo ejecutado ese dia, lo programado
    para el siguiente, el rendimiento real, la curva de avance y el plano,
    listo para imprimir o enviar (ver mas abajo).
14. **Guarda todo en el dispositivo** (IndexedDB) y permite exportar tareas,
    recursos y ubicaciones a CSV, o una copia completa en `.json` que incluye el
    plano.

## Empezar una obra

Una obra no nace de un archivo. Antes del plano se pregunta lo que despues
aparece en todo lo que se firma: **nombre, codigo o contrato, ubicacion,
mandante, contratista, administrador de obra, fecha de inicio, calendario y
moneda**, mas los **logos** del mandante y del contratista para el membrete del
parte diario. Solo el nombre es obligatorio; el resto se puede completar
despues.

La fecha de inicio y el calendario entran directo al programa maestro, asi que
al llegar al plano ya esta todo puesto.

### Donde se guarda cada cosa

Son dos cosas distintas y conviene no confundirlas:

- **La obra** —el plano, las actividades, los tramos, el avance con la fecha de
  cada parte, los recursos y las instalaciones— vive siempre **en el
  dispositivo**, en IndexedDB, y funciona sin conexion. Eso no se elige.
- **La carpeta de obra** es donde caen los archivos que uno quiere tener fuera.
  Esa si se elige, y dentro se crean solas: `Partes diarios` (con una subcarpeta
  por mes), `Fotografias`, `Planos`, `Planillas` y `Respaldos`.

Desde ahi, el parte diario, los CSV de tareas, tramos, recursos y ubicaciones y
la copia `.json` se escriben en la carpeta en vez de descargarse, y la
aplicacion dice donde quedo cada uno.

### El espacio del dispositivo

El navegador puede borrar los datos de un sitio cuando le falta espacio, y en
terreno la base del dispositivo es a veces la unica copia del dia. La aplicacion
pide **almacenamiento persistente**, que la saca de lo descartable, y la pestana
*Capas* dice en que quedo y cuanto espacio ocupa la obra.

No se puede obligar: Chrome lo concede con el uso o al instalarla, y Safari al
agregarla a la pantalla de inicio. Por eso la pantalla lo dice en vez de darlo
por hecho, y recuerda que el respaldo diario en la carpeta es la red de abajo.

### Respaldo automatico

El respaldo no es un boton que haya que acordarse de apretar. Cada cambio
—registrar avance, mover un tramo, cargar recursos— programa uno, y se escribe
cuando la mano se detiene: registrar veinte tramos seguidos deja un archivo y no
veinte. Al dejar la pestana se escribe lo que estuviera pendiente, para que
cerrar el navegador no se lleve la jornada.

Se guarda **un archivo por dia**, que se va sobrescribiendo, en `Respaldos`:

```
Respaldos/2026-10-09 Parque Llanos del Viento.json
Respaldos/2026-10-10 Parque Llanos del Viento.json
```

Cada uno es la obra completa, con el plano adentro, asi que se puede volver a
cualquier jornada con *Restaurar copia* y un solo archivo. Son unos 700 KB por
dia y se conservan 180; los mas viejos se van borrando solos. El plano se copia
ademas a `Planos` la primera vez, para abrirlo en AutoCAD sin ir a buscarlo.

La pestana *Capas* muestra la carpeta y cuando fue el ultimo respaldo, y deja
elegir la carpeta de una obra que se creo sin ella.

**La carpeta solo se puede elegir donde el navegador lo permite**: Chrome en
Windows y en Android, si; Safari en iPad y iPhone no implementa el selector de
carpetas, asi que ahi los archivos se descargan a *Archivos* como siempre. Es
una limitacion del navegador, no de la aplicacion, y la pantalla lo dice en vez
de esconderlo. Si la carpeta se mueve o se revoca el permiso, el archivo no se
pierde: se descarga y se avisa.

## Armar la obra desde el plano

Cargar a mano los tramos de un parque eolico son varios cientos de tareas. Si
el DXF viene clasificado con la convencion de abajo, al importarlo se abre un
asistente que arma la obra completa de una vez. Tambien se vuelve a abrir con
**Armar desde el plano**, en la pestana *Tareas*.

### Como nombrar las capas en AutoCAD

| Capa | Que es |
| --- | --- |
| `ZANJA-TA` `ZANJA-TB` `ZANJA-TC` | tipo de zanja |
| `CRUCE-TA` `CRUCE-TB` `CRUCE-TC` | cruce de camino, entubado y hormigonado |
| `MT-C01-WTG10-WTG09` | circuito de media tension, por tramo |
| `FO-C01-WTG10-WTG09` | fibra optica, mismo patron (opcional) |

El tipo lleva su seccion y las triadas que admite:

| Tipo | Ancho × profundidad | Triadas |
| --- | --- | --- |
| TA | 0,60 × 1,10 m | 1 |
| TB | 0,80 × 1,10 m | 2 |
| TC | 1,30 × 1,10 m | 3 |

Un cruce conserva el ancho y baja 20 cm mas: `CRUCE-TB` es 0,80 × 1,30 m. Las
secciones se pueden corregir en el propio asistente antes de crear, y el
volumen se recalcula al tiro.

Las capas que no siguen el patron no estorban: quedan dibujadas como
referencia y el asistente las lista aparte.

### Que crea

Las partidas de una red de media tension subterranea, cada una con su unidad de
rendimiento y su alcance, y los tramos que le corresponden.

### La unidad de trabajo: la corrida

Una partida de zanja no se mide donde se ejecuta. Son dos cosas distintas:

- **La pieza**: cada polilinea de zanja, de un solo tipo. Es lo que se cubica y
  se paga, porque los m³ de TA no son los de TC.
- **La corrida**: el trecho continuo del mismo recorrido entre dos cruces,
  aunque por dentro cambie de tipo. Es lo que se tiende de una pasada.

Lo que corta una corrida es el **cruce de camino**, no el cambio de tipo: el
cobre no se detiene donde la zanja pasa de 0,60 a 0,80, se detiene donde hay que
esperar que el cruce quede entubado. El plano ya lo dice solo, porque la zanja
se dibuja interrumpida en cada cruce y el cruce rellena el hueco.

Por eso la excavacion y el tapado van **por pieza**, separados por tipo, y el
tendido de cobre y la cama de arena van **por corrida**, sin separar. Sobre un
parque de 20 aerogeneradores, 46 piezas de zanja dan 31 corridas: el recorrido
`WTG09-SSEE` es una sola corrida de 3.316 m que junta sus 6 piezas de TA, TB y
TC, y el `WTG03-SSEE`, que lleva tres cruces, queda partido en cuatro.

De ahi sale sola la regla de terreno: **el cobre de una corrida espera a toda la
excavacion que lleva debajo**, los seis pedazos, sin importar de que tipo sean.
Si se empieza a excavar en el WTG18 hay que llegar al otro extremo de la corrida
para empezar a tender. Y el **cable de potencia espera ademas los ductos de los
cruces que atraviesa**, porque hasta que el cruce no esta entubado no se pasan
los cables al otro lado: en este parque, 11 de los 20 tramos de cable esperan a
algun cruce.

Dentro de una corrida se puede cortar igual y empalmar con soldadura
exotermica. Eso lo decide quien dirige la obra, no el plano, y se hace dividiendo
el elemento en la pestana *Elemento*.

**Las de pieza se crean una por tipo.** Excavar en TA (0,60 × 1,10) y en TC
(1,30 × 1,10) no es la misma partida: mueven distinta tierra por metro, llevan
distinto rendimiento y se pagan aparte. Asi salen *Excavacion TA*, *Excavacion
TB* y *Excavacion TC*, cada una con una sola seccion y su propia cubicacion. En
el asistente hay una casilla para no separarlas, si se prefiere una sola.

La cadena se arma dentro de cada tipo —la cama de arena en TA espera a la
excavacion en TA— y las que van por circuito, que cruzan los tres tipos,
esperan a todas; despues el enlace por ubicacion decide tramo a tramo cual les
toca. Sobre un parque de 20 aerogeneradores salen 20 actividades y 254 tramos.

Las partidas propuestas:

| Actividad | Sobre | Se mide en | Va despues de |
| --- | --- | --- | --- |
| Excavacion | zanjas | m³/dia | — |
| Tendido de cobre | zanjas | ml/dia | Excavacion |
| Cama de arena | zanjas | ml/dia | Tendido de cobre |
| Cable de potencia | circuitos MT | ml de conductor/dia | Cama de arena |
| Fibra optica | circuitos | ml/dia | Cable de potencia |
| Tapado y compactacion | zanjas | m³/dia | Fibra optica |
| Excavacion de cruce | cruces | m³/dia | — |
| Ductos y hormigonado | cruces | ml/dia | Excavacion de cruce |
| Relleno y reposicion | cruces | ml/dia | Ductos y hormigonado |

Los cruces son una cadena aparte, que corre en paralelo a la zanja. Las
actividades que no se controlen se destacan y la cadena se cierra sola: sin
cama de arena, el cable de potencia pasa a colgar del tendido de cobre.

Esta es solo la propuesta de partida: la secuencia se cambia arrastrando (ver
mas abajo).

**La malla de puesta a tierra va una por zanja**, asi que el tendido de cobre
se mide sobre las capas de zanja y no se repite por circuito. **La fibra va una
por tramo de circuito**: usa sus capas `FO-` si estan dibujadas y, si no, sigue
el mismo recorrido del circuito de MT.

Cada tramo de zanja se llama como el recorrido que lo cruza, numerado en el
orden en que se encuentra saliendo de la maquina: `Excavacion TB WTG09-SSEE 3`
es el tercer trecho desde el aerogenerador hacia la subestacion, que es como se
habla en terreno. **Y se listan en ese mismo orden**, recorrido por recorrido,
no en el del archivo DXF, que no es ningun orden. Los tramos de zanja llevan ademas su ancho y profundidad, de
modo que el programa ya sabe cuantos m³ son.

### La verificacion de triadas

Antes de crear nada, el asistente recorre cada zanja midiendo cuantos circuitos
pasan de verdad por ella y lo contrasta con las triadas que su tipo admite. Si
alguna se queda corta a lo largo de un trecho continuo, lo dice con los metros
y los circuitos involucrados:

> `ZANJA-TC, 1056 m: declara 3 triada(s) y pasan 5 circuitos (C06, C07, C08,
> C09, C10) a lo largo de 1056 m.`

Suele ser un tipo de zanja mal asignado o un circuito mal trazado, y es la
unica forma de verlo antes de que alguien excave. Tambien avisa de las zanjas
con seccion holgada, que llevan menos circuitos de los que su tipo admite. Se
puede armar la obra igual y corregir el plano despues.

Con un parque de 20 aerogeneradores el asistente crea 9 actividades y 246
tramos: 20.093 m de zanja, 68.500 m³ y 35.993 m de media tension.

## La secuencia de la obra

El orden de la lista **es** la secuencia del programa: cada actividad espera a
la que tiene justo encima. Para cambiarla se arrastra por el asa (⠿), con el
dedo o con el mouse, en la pestana *Tareas* o en *Programa*; las fechas se
recalculan al soltar. Los botones ↑ ↓ hacen lo mismo de a un paso.

No todas las obras son una sola cadena. Una actividad cuyas antecesoras se
marcan a mano, con las casillas *"Va despues de"*, queda fuera del
encadenamiento automatico y conserva lo que se le haya puesto, por mucho que se
reordene la lista. Asi los cruces de camino siguen corriendo en paralelo a la
zanja en lugar de esperarla. Esas actividades se muestran como *"Va despues de
(a mano)"* y ofrecen un enlace para volver a seguir el orden de la lista.

El desfase en dias de cada enlace tambien se conserva: un tapado que empieza
tres dias despues del tendido lo sigue haciendo aunque cambie de posicion.

### El orden de los tramos dentro de una actividad

Dentro de cada actividad, los tramos se arrastran igual, y ese orden es **en
que orden se ejecutan**: es la forma de decir "partimos por este sector y
despues por el otro". Se puede hacer desde la lista de tramos de la actividad,
en *Tareas*, o desde el programa.

Entre tramos que ya pueden partir, el programa toma siempre el que este mas
arriba. En la excavacion, que no espera a nadie, todos pueden partir el primer
dia y ese orden manda entero. Mas abajo en la cadena se hereda solo, porque
cada tramo espera al suyo: si la zanja se excavo por un sector, el tendido de
ese sector es el que queda libre primero.

Lo que no hace es dejar una cuadrilla parada. Si el siguiente de la lista
todavia espera a su antecesor y hay otro listo, se toma ese: el orden es una
preferencia, no una cola rigida.

### Los frentes salen de la maquinaria

El orden dice por donde se empieza; los **frentes** dicen en cuantas partes a
la vez. Reordenar nunca acorta la obra: las maquinas si.

Los frentes de una actividad no se escriben a mano, salen de la maquinaria y el
personal que se le asigne, en *Programa → Rendimientos*. La regla es que **un
frente es una cuadrilla**: los recursos que comparten el campo *cuadrilla*
trabajan juntos y valen por uno, y el que no la trae —una excavadora suelta— es
un frente por si mismo.

| Asignado a la actividad | Frentes |
| --- | --- |
| 3 excavadoras sin cuadrilla | 3 |
| 3 excavadoras, todas "Cuadrilla A" | 1 |
| 4 personas repartidas en "Cuadrilla A" y "Cuadrilla B" | 2 |

Mientras no se le asigne nada, los frentes se siguen escribiendo a mano. En
cuanto hay recursos asignados, el campo se bloquea: no sirve declarar tres
frentes teniendo una sola maquina en la obra.

Sobre un parque de 20 aerogeneradores, pasar de una excavadora a tres acorta la
obra de 227 a 196 dias trabajados; sumando dos cuadrillas al tendido y a la cama
de arena, a 175.

### Choques de agenda

Una maquina no puede estar en dos frentes a la vez. Si queda asignada a dos
actividades cuyas fechas se pisan, el programa lo dice con nombre y fechas:

> `Retro Komatsu esta en "Excavacion" y en "Excavacion de cruce" del 12/10 al
> 21/10.`

Sin ese aviso el programa sale optimista y nadie lo nota hasta el dia que hay
que mandar la maquina a dos partes.

## Actividades y sus tramos

La obra se organiza en dos niveles, como se lleva en terreno:

- **Actividades**: excavacion, tendido, tapado… Son las partidas secuenciales.
- **Tramos**: dentro de cada actividad, "Excavacion tramo 1", "tramo 2"…, cada
  uno vinculado a los elementos del plano que le corresponden.

En la pestana *Tareas*, el boton **+ Actividad** crea la partida y cada grupo
muestra su avance sumado: *"Excavacion · 4 tramo(s) · 5,00 de 10,0 · 50%"*,
ponderado por la longitud real de cada tramo. El boton **+ Tramo de
Excavacion** abre una tarea ya numerada y lista para elegir sus elementos.

**Tocando el nombre de la actividad, todo el plano muestra su avance**: verde lo
ejecutado, rojo lo pendiente, y el resto del dibujo atenuado. Es la vista para
responder "como va la excavacion" de un vistazo. *Ver todo el plano* la quita.

Con una actividad seleccionada, cualquier tarea nueva entra en ella y se numera
sola. Las actividades se ordenan con ↑ ↓, y al eliminar una sus tramos no se
borran: quedan sin actividad.

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
- **En el plano**: al seleccionar una tarea sus tramos se resaltan en **verde lo
  ejecutado y rojo lo pendiente**, y el resto del plano se apaga para que se lea
  solo esa actividad. Tocando un tramo, la pestana *Elemento* ofrece **Marcar
  hecho** para registrarlo parado frente a la obra.

### Avance por metraje

La forma natural de registrar en terreno es por metros. Tocando un tramo y
usando **Registrar avance**:

1. Se mide desde el extremo mas cercano al punto que tocaste (un boton invierte
   el extremo, y una marca azul en el plano muestra desde donde se cuenta).
2. Escribes los metros ejecutados y la fecha.
3. Esos metros quedan anotados **sobre el mismo elemento**, sin partirlo, y el
   avance de la actividad se recalcula.

**El avance no divide el dibujo.** Sobre la misma zanja conviven la excavacion,
el tendido y el tapado, y cada actividad lleva sus propios metros: la excavacion
puede ir en el metro 35 y el tendido en el 20 sin estorbarse. En el plano, cada
actividad pinta en verde solo la parte que ella ejecuto.

Los avances sucesivos **continuan donde quedo** el anterior por ese extremo, y
se fusionan solos. Si los metros superan lo que falta, el tramo queda completo.

Dividir y unir elementos sigue existiendo como herramienta aparte (panel
*Elemento*), util para separar frentes o responsabilidades, pero ya no hace
falta para registrar avance.

## Programa maestro

La pestaña *Programa* calcula las fechas de la obra como cualquier software de
planificacion, con dos diferencias que vienen de como se ejecuta realmente una
obra lineal.

### Como conviene organizar el plano

En una obra electrica varios circuitos comparten la misma zanja, y eso se
refleja en las capas del DXF:

```
ZANJA        el eje de cada zanja, dibujado UNA vez aunque pasen tres
             circuitos. De aqui cuelgan excavacion, cama de arena y tapado,
             con el ancho y la profundidad reales de esa zanja
MT-C1        recorrido del circuito 1. De aqui cuelga su cable de potencia
MT-C2        ídem circuito 2
CAMARAS      camaras y empalmes, para las partidas que se miden por unidad
```

Conviene ademas **cortar las polilineas en cada aerogenerador**: la
granularidad del dibujo es la granularidad de los tramos. Si el circuito
completo es una sola polilinea, queda un solo tramo; cortado en cada maquina,
cada trecho tiene su fecha y su avance. Si el plano ya viene con polilineas
largas, se pueden cortar dentro de la aplicacion (ver *Divisiones y uniones*).

Con ese esquema, el boton **+ Desde capa…** de cada actividad crea de una vez
un tramo por cada elemento de la capa elegida, ya numerados y con la seccion de
zanja aplicada a todos. Cargar un circuito completo son tres toques, y los
elementos que ya estaban en un tramo de esa actividad no se repiten.

### 1. El enlace es entre tramos, no entre actividades

Si la excavacion entre WTG18 y WTG12 termino, el tendido de ese trecho puede
partir aunque el resto del parque siga excavandose. No hay que esperar a que
termine toda la excavacion.

Eso no se configura tramo por tramo: se declara una sola vez que **"Cable de
potencia va despues de Excavacion"** y la aplicacion baja ese enlace a cada par
de tramos que **van por el mismo lugar**. No hace falta que sean el mismo
elemento del plano: la excavacion vive en la capa `ZANJA` y el circuito en
`MT-C1`, son polilineas distintas, y aun asi se reconocen porque sus trazas
corren pegadas. El enlace sale solo:

```
Excavacion WTG18-WTG12   17/08 → 20/08
Tendido    WTG18-WTG12   21/08 → 24/08   ← parte al terminar SU excavacion
Excavacion WTG12-WTG07   21/08 → 24/08   ← mientras tanto sigue la excavacion
```

Cada tramo muestra de que otros tramos depende. Cuando la obra no sigue al
dibujo, el boton **✎ A mano** congela esa lista y deja agregar o quitar
antecesores puntuales; **↺ Automatico** vuelve a deducirlos del plano.

Cuanto de cerca tienen que correr dos trazas para considerarse la misma zanja
se ajusta arriba, en **"Zanja compartida: tramos a menos de N m van por el mismo
lugar"** (2 m por omision). Al cambiarlo se avisa cuantos enlaces quedaron, para
poder calibrarlo contra el plano real.

Si un tramo tiene actividad antecesora pero ningun tramo vecino que la cumpla,
se avisa arriba ("sin antecesor en su ubicacion") en vez de dejarlo partir sin
que nadie lo note.

### Doble conteo en zanjas compartidas

Cada actividad declara si se ejecuta **una vez por zanja** (excavacion, cama,
tapado: la zanja se abre una sola vez aunque lleve tres circuitos) o **una vez
por circuito** (cable de potencia, fibra: se repite por cada uno). Se deduce de
como se mide la actividad y se puede cambiar en *Rendimientos*.

Con eso, la aplicacion avisa cuando dos tramos de una actividad "por zanja"
pisan los mismos metros — el error tipico de cargar la excavacion una vez por
circuito, que triplica los m³ — y ofrece eliminar el sobrante. Que dos circuitos
compartan zanja en una actividad "por circuito" no genera ningun aviso, porque
ahi efectivamente se tienden dos cables.

### 2. Los dias no se escriben: salen del rendimiento

En la sub-pestaña *Rendimientos*, cada actividad define **cuanto avanza por
dia** y en que unidad se mide:

| Unidad | Para que | De donde sale la cantidad |
| --- | --- | --- |
| m³ por dia | Excavaciones | largo × ancho × profundidad del tramo |
| metros lineales por dia | Tendidos simples, tapados, señalizacion | largo del tramo |
| metros de conductor por dia | Cable de potencia | largo × ternas del tramo × 3 fases (R, S, T) |
| unidades por dia | Camaras, fundaciones, postes | cuenta de elementos del tramo |

Con 120 m³/dia, una zanja de 600 m con seccion de 0,6 × 1,2 son 432 m³ y por lo
tanto 4 dias; la de 300 m son 2 dias. Las ternas de cada tramo se indican en su
ficha (el troncal lleva mas que el ramal) y el campo aparece solo cuando la
actividad se mide en metros de conductor. Un tramo puede fijar su duracion a
mano si hace falta, y esa manda sobre el calculo.

### 3. Frentes de trabajo

Cada actividad indica **cuantos tramos puede atacar a la vez**. Con una sola
retroexcavadora los tramos van uno tras otro; con dos, avanzan en paralelo y la
obra se acorta sola. El programa reparte los tramos entre los frentes atendiendo
primero al que ya puede partir, y muestra a que frente le toco cada uno.

### Lo que sale de todo eso

- **Fechas** de cada tramo y de cada actividad (de la primera a la ultima).
- **Holgura**: cuantos dias puede atrasarse un tramo sin mover el fin de obra.
- **Ruta critica**: los tramos sin holgura, marcados **CRITICA**, contando
  tambien los enlaces que impone compartir cuadrilla.
- Una **barra** por tramo y por actividad con su lugar en el programa, rellena
  con lo realmente ejecutado en terreno.
- Aviso si los antecesores quedan en circulo: esos tramos quedan sin fechar en
  vez de calcular cualquier cosa.

Arriba se fija el **inicio de obra** y que dias se trabaja (todos, lunes a
sabado, o lunes a viernes).

Estas fechas alimentan la linea de tiempo: un tramo sin fechas propias usa las
de su programa, de modo que la curva de avance planificado sale del programa
maestro. Ademas, al registrar avance en un tramo cuyo antecesor todavia no
termina, se avisa en pantalla ("Ojo: Excavacion WTG18-WTG12 va en 0%"). Es solo
un aviso: en terreno a veces se adelanta a proposito.

## Parte diario

El boton **📄** sobre el plano arma el informe de un dia. Se elige la fecha
arriba y la hoja se rehace sola. Trae:

- **Cuatro cifras de cabecera**: avance de obra, lo ejecutado ese dia, el
  termino programado y el **termino proyectado** al ritmo real, con los dias de
  atraso o adelanto.
- **El plano** con lo ejecutado en verde y lo pendiente en rojo a esa fecha,
  dibujado en claro para que se imprima bien.
- **La curva de avance**: lo programado punteado, lo real en verde hasta el dia
  del parte, y una marca en esa fecha.
- **Ejecutado el dia**: que tramo, cuantos metros y cuanta cantidad en la unidad
  de su actividad (m³, metros de conductor…).
- **Programado para el dia siguiente**: los tramos que el programa pone en
  ejecucion, marcando cual *arranca*, cual *sigue en curso* y cual *termina*.
- **Rendimiento real contra el programado** por actividad, lo que queda por
  ejecutar y en que fecha terminaria cada una a ese ritmo.
- **Recursos en obra** ese dia, con sus horas, combustible y costo.

Dos botones: **Imprimir / PDF**, que en el iPad sale por *Compartir → Imprimir*,
y **Descargar**, que guarda un `.html` con todo dentro —el plano y la curva
quedan como imagenes— que se abre en cualquier navegador y se puede mandar por
correo sin que el otro necesite la aplicacion.

El rendimiento real es lo ejecutado repartido entre los dias en que **hubo**
avance, no entre los dias del calendario: un equipo que trabajo tres dias de
los cinco de la semana no aparece rindiendo menos por los dias que no estuvo.

## Linea de tiempo

El boton 🕑 sobre el plano abre un cursor de fechas que reconstruye la obra en
cualquier dia, sin pedir ningun dato adicional: usa las fechas que ya se
registran (cuando se marco cada tramo, el inicio y termino planificado de cada
tarea o el de su actividad en el programa, y el periodo de cada punto de
recursos).

Al mover el cursor:

- Los tramos ejecutados **hasta esa fecha** se pintan en verde y los pendientes
  en el color del estado de su tarea. Se muestran todas las tareas a la vez.
- El personal y la maquinaria aparecen, se mueven o desaparecen segun el
  *desde / hasta* de cada punto.
- Una lectura resume el dia: ejecutado, planificado, diferencia en puntos,
  volumen, tramos y tareas atrasadas.
- La curva compara **avance real** (linea verde) con **avance planificado**
  (linea punteada), con una marca en la fecha del cursor.

Los botones permiten avanzar dia a dia, volver a *Hoy* o reproducir la obra
completa. Lo planificado se reparte linealmente entre el inicio y el termino de
cada tarea. Las tareas sin tramos marcados no tienen historial: se muestran solo
con su plan.

## Recursos: rendimiento, combustible y costo

Una obra tiene tres clases de recurso, y las tres van **en la misma planilla**,
separadas por la columna `tipo`:

| Tipo | Que es | Abre frentes |
| --- | --- | --- |
| **Personal** | Maestros, ayudantes, operadores, jefatura | Si, por cuadrilla |
| **Maquinaria** | Retroexcavadoras, cargadores, camiones | Si, una por maquina |
| **Instalaciones** | Instalacion de faenas, banos quimicos, estaciones de sombra, comedores, bodegas | No |

Las instalaciones no producen nada y no abren frentes —un bano quimico no
excava— pero **cuestan todos los dias que estan** y **tienen que alcanzar para
la gente**. Por eso llevan dos datos que los demas no usan: cuantas unidades
hay y a cuanta gente atiende cada una.

Cada recurso guarda, ademas de sus datos de contacto, lo que hace falta para
controlar la obra:

| Dato | Para que sirve |
| --- | --- |
| Rendimiento por hora (m³, m, unidades) | Cuanto produce el equipo en una hora |
| Horas por jornada | Convierte ese rendimiento en produccion diaria |
| Combustible (L por hora) | Consumo estimado de la obra |
| Costo por hora | Costo de la obra, por tramo y por actividad |
| Marca, horometro, proxima mantencion | Control del equipo; avisa cuando faltan menos de 250 h |
| Desde / hasta | Estadia en obra: una maquina que llega en noviembre no abre frente en octubre |
| Turno | Dia, noche o mixto |
| Operador | Quien maneja la maquina; el frente existe mientras esten los dos |
| Cantidad | Cuantas unidades hay: cuatro banos son una ficha con 4 |
| Atiende a | A cuanta gente sirve cada unidad |
| Cobrado por hora, por dia o por mes | Una retro se cobra por hora; un bano, por mes |

Una retroexcavadora de 60 m³/h con jornada de 9 h rinde 540 m³ al dia, cuesta
$405.000 la jornada y consume 166,5 L. El dialogo muestra esa traduccion
mientras se escriben los datos.

Con los recursos asignados a cada tramo y los dias que le da el programa, la
pestaña *Programa* muestra el **costo y el combustible** de cada tramo, de cada
actividad y de la obra completa, sin llevar otra planilla aparte.

### Cargar recursos desde una planilla

El boton **Importar CSV** de la pestaña *Recursos* lee una planilla de Excel.
**Plantilla CSV** descarga un archivo de ejemplo con las columnas reconocidas:

```
tipo;nombre;cargo;identificador;marca;cuadrilla;telefono;rendimiento_hora;
unidad_rendimiento;horas_jornada;turno;desde;hasta;operador;
combustible_l_hora;costo_hora;horometro;proxima_mantencion_h;estado;notas
```

| Columna | Que lleva | Se acepta tambien |
| --- | --- | --- |
| `tipo` | Maquinaria, Personal o Instalaciones | clase, categoria |
| `nombre` | **La unica obligatoria** | recurso, equipo |
| `cargo` | Cargo de la persona o modelo de la maquina | modelo, funcion, especialidad |
| `identificador` | RUT, patente o numero interno | patente, rut, interno |
| `marca` | Fabricante | brand |
| `cuadrilla` | **Define los frentes**: los que la comparten son uno | empresa, grupo, subcontrato |
| `telefono` | | fono, celular |
| `cantidad` | Cuantas unidades hay de esta ficha | unidades, cant |
| `atiende` | A cuanta gente sirve cada unidad | capacidad, personas, dotacion |
| `rendimiento_hora` | Produccion por hora del equipo | rendimiento, produccion_hora |
| `unidad_rendimiento` | m3, m, un | unidad, medida |
| `horas_jornada` | Sin dato se asumen 8 | horas_dia, jornada |
| `turno` | Dia, Noche o Mixto | shift, horario |
| `desde` | Cuando entra a la obra | inicio, entrada, llegada |
| `hasta` | Cuando se retira | termino, salida, retiro |
| `operador` | Nombre o RUT de quien maneja la maquina | operario, conductor, maquinista |
| `combustible_l_hora` | Litros por hora | combustible, consumo |
| `costo_hora` | El valor, sea por hora, dia o mes | valor_hora, tarifa_hora |
| `unidad_costo` | Por hora, Por dia o Por mes | cobro, periodo_costo |
| `horometro` | Horas o kilometraje actual | kilometraje |
| `proxima_mantencion_h` | En horas de horometro | mantencion, proximo_servicio |
| `estado` | Activo o Inactivo | activo, vigente |
| `notas` | | observaciones, comentarios |

De todas, **solo "nombre" es obligatoria** y el orden no importa. Lee separador
punto y coma, coma o tabulacion, y entiende los numeros como los escribe una
planilla en espanol: `45.000` son cuarenta y cinco mil y `18,5` son dieciocho
coma cinco. Las fechas se escriben como se escriben aca: `12-10-2026`,
`12/10/2026` o `2026-10-12`, las tres sirven.

El **operador se escribe por su nombre o su RUT**, no por un codigo interno, y
puede ir en cualquier fila de la misma planilla: se resuelve al terminar de
leerla, asi que da lo mismo si la persona aparece despues que su maquina. Dejar
`desde` y `hasta` en blanco significa que el recurso esta toda la obra, que es
lo normal en la mayoria.

Las filas cuyo identificador o nombre ya existe **actualizan** al recurso en vez
de duplicarlo, de modo que se puede exportar con *Exportar CSV*, corregir en
Excel y volver a subir.

### Estadia, turnos y operadores en el programa

La estadia no es un dato de archivo: **el frente no existe antes de que llegue
su gente**. Una excavadora con `desde` en noviembre no toma tramos en octubre,
y si tiene operador asignado la ventana es la interseccion de las dos, porque
el frente necesita a los dos. Sobre el parque, con tres retros y una que entra
el 3 de noviembre, esa tercera toma 10 tramos mientras las otras dos toman 18
cada una.

Lo que se sale de la estadia se avisa, no se esconde:

> `"Excavacion WTG13-SSEE 3" termina el 01/11, despues de que Retro CAT A se va
> de la obra el 30/10.`

> `Retro Komatsu no tiene operador y esta en "Excavacion".`

Una maquina sin operador **sigue contando como frente**: falta un dato, no es
razon para rehacerle el plan a nadie. Pero se dice.

El turno se guarda y se muestra, y por ahora no cambia las fechas: el
rendimiento de la actividad lo pone el usuario en m³ o metros por dia, asi que
un segundo turno se refleja subiendo ese numero, no partiendo el frente en dos.

### Instalaciones de faena

Una instalacion se carga como cualquier otro recurso, con `tipo` = Instalaciones.
Lo que cambia es que **no abre frentes** —asignarle un bano a la excavacion no
le suma una cuadrilla— y que **se cobra por estar**, no por trabajar:

```
Instalaciones;Bano quimico;Servicios higienicos;;;4;10;;;;;12-10-2026;;;;180000;Por mes;Activo
Instalaciones;Estacion de sombra;Proteccion UV;;;3;25;;;;;12-10-2026;;;;12000;Por dia;Activo
Instalaciones;Container comedor;Instalacion de faenas;;;1;40;;;;;12-10-2026;;;;450000;Por mes;Activo
```

Su costo entra al total de la obra por los dias corridos que esta en obra —su
estadia, o la obra entera si no la declara— y se muestra aparte en el resumen
del programa, porque es gasto de faena y no de ningun tramo.

Y con **atiende** se contrasta contra la dotacion: se busca el dia de mas gente
en obra, contando a los operadores de cada maquina aunque solo figuren colgando
de ella, y se compara con lo instalado.

> `Bano quimico: 1 para 3 personas, y el 13/10 hay 5 en obra. Faltan 1.`

El numero de personas por unidad lo pone el usuario: la aplicacion no decide
cuantos banos exige la norma, solo avisa cuando lo declarado no alcanza.

## Recursos repartidos en el plano

En la pestana *Recursos*, ademas del listado de personal y maquinaria, se
pueden crear **puntos** sobre el plano:

- **+ Punto en el plano** pide tocar un lugar y abre el punto para nombrarlo
  (por ejemplo "Frente norte"), fijar su periodo *desde / hasta* y elegir quien
  esta ahi. Si el recurso todavia no
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
css/report.css          hoja clara del parte diario, en pantalla y al imprimir
js/dxf.js               lector DXF y armado de la escena
js/scene.js             indice espacial, seleccion y medidas
js/viewer.js            lienzo, camara y gestos
js/db.js                almacenamiento local (IndexedDB / localStorage)
js/tasks.js             modelo de tareas, tramos, avance, cubicacion y exportacion
js/resources.js         personal y maquinaria: rendimiento, combustible y costo
js/csv.js               lectura de planillas CSV (separadores y coma decimal)
js/places.js            puntos del plano donde se ubican los recursos
js/edits.js             geometria de divisiones y uniones
js/timeline.js          estado de la obra en una fecha y curva de avance
js/activities.js        actividades que agrupan las tareas y su avance
js/schedule.js          programa maestro: rendimientos, fechas por tramo y ruta critica
js/overlap.js           que tramos van por el mismo lugar (zanjas compartidas)
js/report.js            parte diario: lo del dia, rendimiento real y proyeccion
js/parque.js            esquema de capas de obra electrica y armado de la obra
js/obra.js              datos de la obra y la carpeta donde deja sus archivos
js/app.js               union de todo y logica de pantalla
sw.js                   service worker (uso sin conexion)
manifest.webmanifest    instalacion como aplicacion
```

## Datos y privacidad

Los planos y las tareas no salen del dispositivo: se guardan en IndexedDB del
navegador. Borrar los datos del sitio elimina los proyectos, por lo que conviene
exportar la copia `.json` cuando el trabajo sea importante.
