/* Taller Opulenzza — pizarra de trabajos.
 *
 * Los datos viven en `data.json` dentro del repositorio de GitHub configurado.
 * El token nunca viaja en el link: se guarda en localStorage de cada dispositivo.
 */
(() => {
  'use strict';

  const DATA_PATH = 'data.json';
  const POLL_MS = 20000;
  const SAVE_RETRIES = 3;

  const $ = (id) => document.getElementById(id);

  const state = {
    repo: null,
    token: null,
    trabajos: [],
    pinHash: null,
    pinSalt: null,
    pinLegacy: null,
    sha: null,
    lastSync: null,
    error: null,
  };

  // ---------- utilidades ----------

  function esc(value) {
    return String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  function b64Encode(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p) => String.fromCharCode('0x' + p)));
  }

  function b64Decode(str) {
    return decodeURIComponent(
      atob(str)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
  }

  function randomSalt() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function hashPin(pin, salt) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + ':' + pin));
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function tiempoDesde(ts) {
    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return 'hace un momento';
    if (mins < 60) return `hace ${mins} min`;
    const horas = Math.floor(mins / 60);
    if (horas < 24) return `hace ${horas} h`;
    return `hace ${Math.floor(horas / 24)} d`;
  }

  function formatoFecha(fechaStr) {
    if (!fechaStr) return '';
    const [y, m, d] = fechaStr.split('-').map(Number);
    if (!y || !m || !d) return '';
    return new Date(y, m - 1, d).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  }

  function hoyISO() {
    const ahora = new Date();
    const offset = ahora.getTimezoneOffset() * 60000;
    return new Date(ahora.getTime() - offset).toISOString().slice(0, 10);
  }

  // ---------- configuración del dispositivo ----------

  const tokenKey = (repo) => `taller-token:${repo}`;
  const authKey = (repo) => `taller-auth:${repo}`;

  // En GitHub Pages (owner.github.io/repo/) el repo se deduce de la propia URL,
  // así que el link del taller no necesita parámetros.
  function repoDesdePages() {
    const owner = window.location.hostname.match(/^([\w-]+)\.github\.io$/)?.[1];
    const nombre = window.location.pathname.split('/').filter(Boolean)[0];
    return owner && nombre ? `${owner}/${nombre}` : null;
  }

  // Fuera de github.io (dominio propio) el repo se declara en el HTML.
  function repoDelMeta() {
    return document.querySelector('meta[name="taller-repo"]')?.content || null;
  }

  function repoPorDefecto() {
    return repoDesdePages() || repoDelMeta();
  }

  function leerConfigDeURL() {
    const params = new URLSearchParams(window.location.search);
    const repoParam = params.get('repo');
    if (repoParam) return { repo: repoParam, legacyToken: null };

    // Formato antiguo: ?taller=<base64 de {repo, token}>. El token viajaba en el
    // link, así que se migra a localStorage y se limpia la URL.
    const tallerParam = params.get('taller');
    if (!tallerParam) return { repo: repoPorDefecto(), legacyToken: null };
    try {
      const cfg = JSON.parse(b64Decode(decodeURIComponent(tallerParam)));
      return { repo: cfg.repo || null, legacyToken: cfg.token || null };
    } catch {
      return { repo: null, legacyToken: null };
    }
  }

  function linkDelTaller(repo) {
    const base = `${window.location.origin}${window.location.pathname}`;
    if (repo === repoPorDefecto()) return base;
    return `${base}?repo=${encodeURIComponent(repo)}`;
  }

  // ---------- acceso a GitHub ----------

  function ghUrl() {
    return `https://api.github.com/repos/${state.repo}/contents/${DATA_PATH}`;
  }

  function ghHeaders(extra) {
    return {
      Authorization: 'Bearer ' + state.token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  function mensajeDeError(res) {
    if (res.status === 401) return 'El token no es válido o expiró.';
    if (res.status === 404) return 'No se encontró el repositorio con ese token.';
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      return 'GitHub limitó las peticiones. Espera unos minutos.';
    }
    if (res.status === 409 || res.status === 412) {
      return 'Otro dispositivo está guardando al mismo tiempo. Vuelve a intentarlo.';
    }
    return `GitHub respondió ${res.status}. Vuelve a intentarlo en un momento.`;
  }

  /** Igual que `fetch`, pero convierte los fallos de red en un mensaje en español. */
  async function ghFetch(opciones) {
    try {
      return await fetch(ghUrl(), opciones);
    } catch {
      throw new Error('No hay conexión con GitHub. Revisa la red.');
    }
  }

  async function loadDatos() {
    const res = await ghFetch({ headers: ghHeaders(), cache: 'no-store' });
    if (res.status === 404) {
      state.trabajos = [];
      state.pinHash = null;
      state.pinSalt = null;
      state.pinLegacy = null;
      state.sha = null;
      state.lastSync = Date.now();
      return;
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error(mensajeDeError(res));

    const data = JSON.parse(b64Decode(json.content.replace(/\n/g, '')));
    state.sha = json.sha;
    state.trabajos = Array.isArray(data.trabajos) ? data.trabajos : [];
    state.pinHash = data.pinHash || null;
    state.pinSalt = data.pinSalt || null;
    state.pinLegacy = data.pin ? String(data.pin) : null;
    state.lastSync = Date.now();
  }

  async function putDatos(mensaje) {
    const contenido = { trabajos: state.trabajos };
    if (state.pinHash) {
      contenido.pinSalt = state.pinSalt;
      contenido.pinHash = state.pinHash;
    } else if (state.pinLegacy) {
      // Todavía sin migrar: conservar el PIN antiguo para no dejar fuera a nadie.
      contenido.pin = state.pinLegacy;
    }
    const body = {
      message: mensaje,
      content: b64Encode(JSON.stringify(contenido)),
    };
    if (state.sha) body.sha = state.sha;

    const res = await ghFetch({
      method: 'PUT',
      headers: ghHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (res.ok) {
      state.sha = json?.content?.sha ?? state.sha;
      state.lastSync = Date.now();
      return;
    }
    // 409/412: otro dispositivo escribió antes. Lo maneja `commit()`.
    const err = new Error(mensajeDeError(res));
    err.status = res.status;
    throw err;
  }

  /** Lee, aplica `mutar` sobre los datos frescos y guarda; reintenta si hay conflicto. */
  async function commit(mensaje, mutar) {
    for (let intento = 0; intento < SAVE_RETRIES; intento++) {
      await loadDatos();
      mutar(state);
      try {
        await putDatos(mensaje);
        setError(null);
        return;
      } catch (e) {
        const conflicto = e.status === 409 || e.status === 412;
        if (!conflicto || intento === SAVE_RETRIES - 1) throw e;
      }
    }
  }

  async function sincronizar() {
    try {
      await loadDatos();
      setError(null);
      return true;
    } catch (e) {
      setError(e.message);
      return false;
    }
  }

  // ---------- indicador de conexión ----------

  function setError(mensaje) {
    state.error = mensaje;
    for (const el of [$('conn-status'), $('conn-status-tv')]) {
      if (!el) continue;
      el.classList.toggle('visible', Boolean(mensaje));
      if (mensaje) {
        const desde = state.lastSync ? ` · últimos datos ${tiempoDesde(state.lastSync)}` : '';
        el.textContent = `${mensaje}${desde}`;
      }
    }
  }

  const toastTimers = {};

  function mostrarToast(texto, esError = false, id = 'toast') {
    const toast = $(id);
    toast.textContent = texto;
    toast.classList.toggle('error', esError);
    toast.classList.add('visible');
    clearTimeout(toastTimers[id]);
    toastTimers[id] = setTimeout(() => toast.classList.remove('visible'), 3500);
  }

  // ---------- navegación ----------

  const navButtons = document.querySelectorAll('nav button');

  function switchView(name) {
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $('view-' + name).classList.add('active');
    navButtons.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
    $('topnav').hidden = name === 'pantalla' || name === 'primeravez' || name === 'pin';
    if (name === 'gestionar') renderGestionar();
    if (name === 'pantalla') renderPantalla();
  }

  navButtons.forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

  $('salir-pantalla-btn').addEventListener('click', () => {
    history.replaceState(null, '', window.location.pathname + window.location.search);
    switchView('agregar');
  });

  // ---------- agregar ----------

  $('form-agregar').addEventListener('submit', async (event) => {
    event.preventDefault();
    const cliente = $('f-cliente').value.trim();
    const pieza = $('f-pieza').value.trim();
    if (!cliente || !pieza) {
      mostrarToast('Falta el cliente o la pieza.', true);
      return;
    }

    const nuevo = {
      id: crypto.randomUUID(),
      cliente,
      pieza,
      tipo: $('f-tipo').value,
      recibido: $('f-recibido').value.trim(),
      notas: $('f-notas').value.trim(),
      urgente: $('f-urgente').checked,
      estado: 'Pendiente',
      fechaEntrada: $('f-fecha').value || hoyISO(),
      creado: Date.now(),
    };

    const boton = $('btn-agregar');
    boton.disabled = true;
    boton.textContent = 'Guardando...';
    try {
      await commit('Agrega trabajo del taller', (s) => s.trabajos.push(nuevo));
      $('form-agregar').reset();
      $('f-fecha').value = hoyISO();
      mostrarToast('Trabajo agregado ✓');
    } catch (e) {
      setError(e.message);
      mostrarToast('No se pudo guardar: ' + e.message + ' El trabajo NO se agregó.', true);
    } finally {
      boton.disabled = false;
      boton.textContent = 'Agregar a la pizarra';
    }
  });

  // ---------- gestionar ----------

  async function renderGestionar() {
    await sincronizar();
    const list = $('manage-list');
    list.innerHTML = '';
    if (state.trabajos.length === 0) {
      list.innerHTML = '<div class="empty">No hay trabajos registrados todavía.</div>';
      return;
    }

    state.trabajos
      .slice()
      .sort((a, b) => b.creado - a.creado)
      .forEach((t) => {
        const row = document.createElement('div');
        row.className = 'manage-item';
        row.innerHTML = `
          <div class="info">
            <div class="cliente">${esc(t.cliente)} ${t.urgente ? '<span class="urgente-tag">Urgente</span>' : ''}</div>
            <div class="pieza">${esc(t.pieza)} — ${esc(t.tipo)}</div>
            <div class="meta">Entrada: ${esc(formatoFecha(t.fechaEntrada))} · ${esc(tiempoDesde(t.creado))}${
              t.recibido ? ' · recibió ' + esc(t.recibido) : ''
            }</div>
          </div>
          <select data-id="${esc(t.id)}" class="estado-select" aria-label="Estado de ${esc(t.cliente)}">
            <option ${t.estado === 'Pendiente' ? 'selected' : ''}>Pendiente</option>
            <option ${t.estado === 'En Proceso' ? 'selected' : ''}>En Proceso</option>
            <option ${t.estado === 'Listo' ? 'selected' : ''}>Listo</option>
          </select>
          <button type="button" class="del-btn" data-id="${esc(t.id)}">Entregado / Quitar</button>
        `;
        list.appendChild(row);
      });

    list.querySelectorAll('.estado-select').forEach((sel) => {
      sel.addEventListener('change', async (e) => {
        const id = e.target.dataset.id;
        const estado = e.target.value;
        sel.disabled = true;
        try {
          await commit('Actualiza estado del trabajo', (s) => {
            const t = s.trabajos.find((x) => x.id === id);
            if (t) t.estado = estado;
          });
        } catch (err) {
          setError(err.message);
        } finally {
          sel.disabled = false;
          renderGestionar();
        }
      });
    });

    list.querySelectorAll('.del-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        const boton = e.currentTarget;
        // Primer toque pide confirmación; el segundo borra.
        if (boton.dataset.confirmando !== '1') {
          boton.dataset.confirmando = '1';
          boton.textContent = '¿Seguro? Tocar de nuevo';
          setTimeout(() => {
            if (boton.isConnected) {
              boton.dataset.confirmando = '';
              boton.textContent = 'Entregado / Quitar';
            }
          }, 10000);
          return;
        }
        const id = boton.dataset.id;
        boton.disabled = true;
        try {
          await commit('Quita trabajo entregado', (s) => {
            s.trabajos = s.trabajos.filter((x) => x.id !== id);
          });
        } catch (err) {
          setError(err.message);
        } finally {
          renderGestionar();
        }
      });
    });
  }

  // ---------- pantalla TV ----------

  function cardHTML(t) {
    return `
      <div class="card">
        <div class="cliente">${esc(t.cliente)}</div>
        <div class="pieza">${esc(t.pieza)}</div>
        <div class="tipo">${esc(t.tipo)}</div>
        <div class="tiempo">Entrada: ${esc(formatoFecha(t.fechaEntrada))}</div>
        ${t.urgente ? '<div class="urg urgente-tag">Urgente</div>' : ''}
      </div>
    `;
  }

  async function renderPantalla() {
    await sincronizar();
    const cols = { Pendiente: 'col-pendiente', 'En Proceso': 'col-proceso', Listo: 'col-listo' };
    Object.values(cols).forEach((id) => ($(id).innerHTML = ''));
    state.trabajos
      .slice()
      .sort((a, b) => a.creado - b.creado)
      .forEach((t) => {
        const colId = cols[t.estado] || cols.Pendiente;
        $(colId).insertAdjacentHTML('beforeend', cardHTML(t));
      });
  }

  function tickClock() {
    const el = $('clock');
    if (el) {
      el.textContent = new Date().toLocaleString('es-ES', {
        weekday: 'long',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }

  // Refresco automático multi-dispositivo. Se pausa con la pestaña oculta para
  // no gastar el límite de peticiones de la API de GitHub.
  function refrescarVistaActiva() {
    if (document.hidden) return;
    const activa = document.querySelector('.view.active');
    if (!activa) return;
    // No repintar mientras alguien tiene un borrado a medio confirmar.
    if (document.querySelector('.del-btn[data-confirmando="1"]')) return;
    if (activa.id === 'view-pantalla') renderPantalla();
    if (activa.id === 'view-gestionar') renderGestionar();
  }

  // ---------- configuración inicial ----------

  $('pv-crear-btn').addEventListener('click', async () => {
    const pin = $('pv-pin-input').value.trim();
    const repo = $('pv-repo-input').value.trim();
    const token = $('pv-token-input').value.trim();
    if (!/^\d{4,6}$/.test(pin) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || token.length < 10) {
      $('pv-pin-error').classList.add('visible');
      return;
    }
    $('pv-pin-error').classList.remove('visible');
    $('pv-step-pin').hidden = true;
    $('pv-step-result').hidden = false;
    $('pv-status').textContent = 'Creando el almacenamiento...';

    state.repo = repo;
    state.token = token;
    try {
      await loadDatos();
      state.pinSalt = randomSalt();
      state.pinHash = await hashPin(pin, state.pinSalt);
      state.trabajos = state.trabajos || [];
      await putDatos('Crea almacenamiento del taller');

      localStorage.setItem(tokenKey(repo), token);
      localStorage.setItem(authKey(repo), 'ok');

      const link = linkDelTaller(repo);
      $('pv-status').textContent = 'Listo. Este es el link de tu taller:';
      $('pv-result').innerHTML = `
        <div class="url-box-pv">${esc(link)}</div>
        <button class="submit-btn" type="button" id="pv-continuar">Copiar y continuar</button>
        <p class="hint">
          Usa este mismo link en el TV, el celular y la computadora — todos verán los mismos trabajos.
          Cada dispositivo pedirá el token y el PIN la primera vez. El link ya no contiene el token.
        </p>
      `;
      $('pv-continuar').addEventListener('click', () => {
        navigator.clipboard.writeText(link).catch(() => {});
        window.location.href = link;
      });
    } catch (e) {
      $('pv-status').textContent = 'Hubo un error creando el almacenamiento: ' + e.message;
      $('pv-step-pin').hidden = false;
      $('pv-step-result').hidden = true;
      $('pv-pin-error').textContent = e.message;
      $('pv-pin-error').classList.add('visible');
    }
  });

  // ---------- desbloqueo ----------

  function pedirAcceso({ pedirToken }) {
    $('pin-token-wrap').hidden = !pedirToken;
    $('pin-sub').textContent = pedirToken
      ? 'Este dispositivo necesita el token y el PIN.'
      : 'Ingresa el PIN para continuar.';
    switchView('pin');

    const intentar = async () => {
      const boton = $('pin-btn');
      const error = $('pin-error');
      error.classList.remove('visible');

      if (pedirToken) {
        const token = $('pin-token-input').value.trim();
        if (token.length < 10) {
          error.textContent = 'Falta el token de GitHub.';
          error.classList.add('visible');
          return;
        }
        state.token = token;
        boton.disabled = true;
        const ok = await sincronizar();
        boton.disabled = false;
        if (!ok) {
          error.textContent = state.error;
          error.classList.add('visible');
          return;
        }
        localStorage.setItem(tokenKey(state.repo), token);
        $('pin-token-wrap').hidden = true;
        pedirToken = false;
      }

      const val = $('pin-input').value.trim();
      if (!(await pinCorrecto(val))) {
        error.textContent = 'PIN incorrecto.';
        error.classList.add('visible');
        $('pin-input').value = '';
        return;
      }

      // Migra un PIN guardado en texto plano a hash con sal.
      if (!state.pinHash) {
        try {
          const salt = randomSalt();
          const hash = await hashPin(val, salt);
          await commit('Guarda el PIN cifrado', (s) => {
            s.pinSalt = salt;
            s.pinHash = hash;
            s.pinLegacy = null;
          });
        } catch {
          /* no bloquea el acceso */
        }
      }

      localStorage.setItem(authKey(state.repo), 'ok');
      entrar();
    };

    if (!pedirAcceso.montado) {
      pedirAcceso.montado = true;
      $('pin-btn').addEventListener('click', intentar);
      $('pin-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') intentar();
      });
    }
  }

  // ---------- cambiar PIN ----------

  async function pinCorrecto(val) {
    if (state.pinHash) return (await hashPin(val, state.pinSalt || '')) === state.pinHash;
    return state.pinLegacy !== null && val === state.pinLegacy;
  }

  $('form-cambiar-pin').addEventListener('submit', async (event) => {
    event.preventDefault();
    const actual = $('cp-actual').value.trim();
    const nuevo = $('cp-nuevo').value.trim();
    const repetir = $('cp-repetir').value.trim();

    if (!/^\d{4,6}$/.test(nuevo)) {
      mostrarToast('El PIN nuevo debe tener entre 4 y 6 números.', true, 'cp-toast');
      return;
    }
    if (nuevo !== repetir) {
      mostrarToast('Los dos PIN nuevos no coinciden.', true, 'cp-toast');
      return;
    }

    const boton = $('cp-btn');
    boton.disabled = true;
    boton.textContent = 'Guardando...';
    try {
      await sincronizar();
      if (!(await pinCorrecto(actual))) {
        mostrarToast('El PIN actual no es correcto.', true, 'cp-toast');
        return;
      }
      const salt = randomSalt();
      const hash = await hashPin(nuevo, salt);
      await commit('Cambia el PIN del taller', (s) => {
        s.pinSalt = salt;
        s.pinHash = hash;
        s.pinLegacy = null;
      });
      $('form-cambiar-pin').reset();
      mostrarToast('PIN actualizado ✓', false, 'cp-toast');
    } catch (e) {
      setError(e.message);
      mostrarToast('No se pudo cambiar el PIN: ' + e.message, true, 'cp-toast');
    } finally {
      boton.disabled = false;
      boton.textContent = 'Guardar PIN nuevo';
    }
  });

  function entrar() {
    switchView(window.location.hash === '#pantalla' ? 'pantalla' : 'agregar');
  }

  // ---------- arranque ----------

  async function iniciar() {
    $('f-fecha').value = hoyISO();
    setInterval(tickClock, 30000);
    tickClock();
    setInterval(refrescarVistaActiva, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) refrescarVistaActiva();
    });

    const { repo, legacyToken } = leerConfigDeURL();
    const forzarSetup = new URLSearchParams(window.location.search).has('setup');
    if (!repo || forzarSetup) {
      switchView('primeravez');
      return;
    }
    state.repo = repo;

    if (legacyToken) {
      localStorage.setItem(tokenKey(repo), legacyToken);
      // Saca el token de la URL y del historial del navegador.
      history.replaceState(null, '', linkDelTaller(repo) + window.location.hash);
    }
    state.token = localStorage.getItem(tokenKey(repo));

    if (!state.token) {
      pedirAcceso({ pedirToken: true });
      return;
    }

    const ok = await sincronizar();
    if (!ok) {
      pedirAcceso({ pedirToken: true });
      return;
    }
    if (localStorage.getItem(authKey(repo)) === 'ok') {
      entrar();
    } else {
      pedirAcceso({ pedirToken: false });
    }
  }

  iniciar();
})();
