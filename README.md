# Taller Opulenzza

Pizarra de trabajos del taller: alta de piezas, seguimiento de estado (Pendiente → En proceso → Listo)
y una vista de pantalla completa pensada para el TV del taller.

Es una web estática (sin build ni servidor propio) que guarda los datos en `data.json` dentro de este
mismo repositorio, usando la API de GitHub.

## Cómo se usa

1. Abre la app sin parámetros y completa el formulario de configuración: usuario/repositorio, token de
   GitHub y PIN.
2. La app crea `data.json` y te da el link definitivo, con la forma `.../index.html?repo=usuario/repo`.
3. Abre ese link en cada dispositivo (TV, celular, computadora). Cada uno pide **una vez** el token y el
   PIN, y los guarda en su propio `localStorage`.
4. Añade `#pantalla` al final del link para que un dispositivo arranque directo en la vista de TV.

## Token de GitHub

- Usa un token **fine-grained** limitado a este único repositorio, con permiso
  `Contents: Read and write` y con fecha de expiración.
- El token **no viaja en el link**: se guarda solo en el dispositivo que lo escribió.
- Para rotarlo: revoca el token viejo en GitHub, borra el `localStorage` del dispositivo (o entra en modo
  incógnito) y vuelve a introducir el nuevo.
- Los links del formato antiguo (`?taller=...`, que sí llevaban el token) siguen funcionando: la app
  guarda el token en el dispositivo y limpia la URL. Aun así, **cualquier token que haya viajado en un
  link debe considerarse comprometido y revocarse**.

## El link del taller

Publicada en GitHub Pages (`https://<usuario>.github.io/<repo>/`), la app deduce el repositorio de la
propia URL, así que el link no necesita parámetros. Fuera de Pages, o para apuntar a otro repositorio,
se usa `?repo=usuario/repo`. Para volver a la pantalla de configuración inicial, añade `?setup=1`.

## Sobre el PIN

El PIN es un candado de conveniencia contra usos accidentales del dispositivo del taller: se valida en el
navegador, así que no es una medida de seguridad real. Se guarda hasheado (SHA-256 con sal) en
`data.json`; los PIN antiguos guardados en texto plano se migran automáticamente en el siguiente acceso
correcto. Para cambiarlo, usa la pestaña **Cambiar PIN** (pide el PIN actual). Los dispositivos que ya
entraron siguen dentro: el PIN nuevo se pide la próxima vez que uno tenga que desbloquearse.

## Estructura

| Archivo      | Contenido                                      |
| ------------ | ---------------------------------------------- |
| `index.html` | Marcado de las vistas                          |
| `styles.css` | Estilos                                        |
| `app.js`     | Lógica: sincronización con GitHub, vistas, PIN |
| `data.json`  | Datos de producción (PIN hasheado + trabajos)  |

## Desarrollo

```bash
npm install        # solo herramientas de lint/formato
npm run lint       # ESLint
npm run format     # Prettier
python3 -m http.server 8000   # servir la app en local
```

No hay paso de build: lo que está en el repositorio es lo que se publica.

## Limitaciones conocidas

- Cada cambio genera un commit en este repositorio; el historial crece rápido.
- Los dispositivos refrescan cada 20 s (en pausa cuando la pestaña está oculta) para no agotar el límite
  de peticiones de la API de GitHub.
- Si dos dispositivos guardan a la vez, el segundo reintenta hasta 3 veces sobre los datos frescos; si
  aun así falla, avisa en pantalla en lugar de perder el trabajo en silencio.
- Para un uso más intensivo conviene mover el almacenamiento a un backend real (Cloudflare Worker con el
  token del lado servidor, o Supabase).
