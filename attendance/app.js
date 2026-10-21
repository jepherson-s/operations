
import {
  openProvisioningPackage,
  createProvisioningPackage,
  verifyEmployeePin
} from "../shared/core.js";

import { createAttendanceStore } from "./store.js";

const appVersion = "1.5";
const cacheName = "attendance-shell-v9";

const get = id => document.getElementById(id);
const store = createAttendanceStore();

const dateFormat = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

const themeModes = ["light", "auto", "dark"];
const themeSymbols = {
  light: "☀",
  auto: "◐",
  dark: "☾"
};
const themeNames = {
  light: "Chiaro",
  auto: "Automatico",
  dark: "Scuro"
};

let state = null;
let pendingSetup = null;
let adminPinSession = null;
let adminTimer = null;
let clockPin = "";
let clockTimer = null;
let busy = false;
let appReady = false;
let lastInteractionAt = Date.now();
let themeMode = "auto";

let checkingUpdates = false;
let pendingUpdate = null;
let applyingUpdate = false;
let updateTimer = null;

/* interfaccia */

function message(id, value = "", kind = "") {
  const element = get(id);
  element.textContent = value;
  element.className = kind
    ? `message ${kind}`
    : "message";
}

function screen(id) {
  document.querySelectorAll(".screen").forEach(element => {
    element.hidden = element.id !== id;
  });

  get("adminOpen").hidden = id !== "clockScreen";
  get("adminBack").hidden = id !== "adminScreen";
  window.scrollTo(0, 0);
}

function setBusy(value) {
  busy = value;
  document.querySelectorAll(".key").forEach(button => {
    button.disabled = value;
  });
}

/* pin dipendente */

function renderClockPin() {
  get("pinDisplay").setAttribute(
    "aria-label",
    `PIN: ${clockPin.length} cifre su 4`
  );

  get("pinDisplay")
    .querySelectorAll(".pin-dot")
    .forEach((dot, index) => {
      dot.classList.toggle(
        "filled",
        index < clockPin.length
      );
    });
}

function cancelClockTimer() {
  if (clockTimer !== null) clearTimeout(clockTimer);
  clockTimer = null;
}

function resetClockPin() {
  cancelClockTimer();
  clockPin = "";
  renderClockPin();
}

function addClockDigit(digit) {
  if (
    busy ||
    get("clockScreen").hidden ||
    clockPin.length >= 4 ||
    !/^[0-9]$/.test(digit)
  ) return;

  lastInteractionAt = Date.now();

  if (!clockPin.length) message("clockMessage");

  clockPin += digit;
  renderClockPin();

  if (clockPin.length !== 4) return;

  const enteredPin = clockPin;
  cancelClockTimer();

  clockTimer = setTimeout(() => {
    clockTimer = null;

    if (
      !busy &&
      !get("clockScreen").hidden &&
      clockPin === enteredPin
    ) {
      void registerPunch(enteredPin);
    }
  }, 120);
}

function eraseClockDigit() {
  if (busy) return;

  lastInteractionAt = Date.now();
  cancelClockTimer();
  clockPin = clockPin.slice(0, -1);
  renderClockPin();
}

function refreshClock() {
  get("deviceName").textContent = state.device.name;
  resetClockPin();
  message("clockMessage");
}

/* archivio */

function validState(data) {
  return (
    data?.schemaVersion === 1 &&
    data.center === "attendance" &&
    typeof data.originId === "string" &&
    typeof data.device?.id === "string" &&
    typeof data.device?.name === "string" &&
    Array.isArray(data.employees) &&
    Array.isArray(data.punches) &&
    Array.isArray(data.imports) &&
    Boolean(data.adminChallenge)
  );
}

/* sicurezza */

function security(kind) {
  return state.security?.[kind] || {
    failures: 0,
    lockedUntil: 0
  };
}

function checkLock(kind) {
  const guard = security(kind);

  if (guard.lockedUntil > Date.now()) {
    const seconds = Math.ceil(
      (guard.lockedUntil - Date.now()) / 1000
    );
    throw new Error(`Riprova tra ${seconds} secondi`);
  }
}

async function updateSecurity(kind, success) {
  const next = structuredClone(state);

  if (!next.security) next.security = {};

  const guard = next.security[kind] || {
    failures: 0,
    lockedUntil: 0
  };

  if (success) {
    if (!guard.failures && !guard.lockedUntil) return;

    guard.failures = 0;
    guard.lockedUntil = 0;
  } else {
    guard.failures += 1;

    if (guard.failures >= 5) {
      guard.failures = 0;
      guard.lockedUntil = Date.now() + 60000;
    }
  }

  next.security[kind] = guard;
  await store.save(next);
  state = next;

  if (!success) {
    throw new Error(
      guard.lockedUntil > Date.now()
        ? "Troppi tentativi. Attendi 60 secondi."
        : "PIN non riconosciuto"
    );
  }
}

/* lettura json */

async function readJsonFile(file) {
  if (!file || file.size > 5 * 1024 * 1024) {
    throw new Error(
      "Seleziona un JSON valido (massimo 5 MB)"
    );
  }

  try {
    return JSON.parse(await file.text());
  } catch {
    throw new Error("JSON non leggibile");
  }
}

/* configurazione iniziale */

get("setupForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;

  setBusy(true);
  const button = get("setupContinue");
  button.disabled = true;
  message("setupMessage");

  try {
    const pin = get("setupPin").value;
    const json = await readJsonFile(
      get("setupJson").files[0]
    );
    const config = await openProvisioningPackage(
      json,
      pin
    );

    if (!config.employees.length) {
      throw new Error(
        "Il JSON non contiene dipendenti attivi"
      );
    }

    pendingSetup = { config, pin };
    get("setupImport").hidden = true;
    get("setupDevice").hidden = false;
    get("setupCount").textContent =
      "Configurazione pronta";
    get("setupPin").value = "";
    get("deviceInput").focus();

  } catch (error) {
    message("setupMessage", error.message, "error");
  } finally {
    setBusy(false);
    button.disabled = false;
  }
});

get("deviceForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !pendingSetup) return;

  setBusy(true);
  const button = get("activateButton");
  button.disabled = true;
  message("setupMessage");

  try {
    const name = get("deviceInput").value.trim();

    if (!name || name.length > 80) {
      throw new Error("Inserisci il nome dispositivo");
    }

    const { config, pin } = pendingSetup;
    const now = new Date().toISOString();

    const challenge = await createProvisioningPackage(
      {
        schemaVersion: 1,
        kind: "center-provisioning",
        sourceCenter: "core",
        targetCenter: "attendance",
        originId: config.originId,
        exportId: crypto.randomUUID(),
        issuedAt: now,
        employees: []
      },
      pin
    );

    const newState = {
      schemaVersion: 1,
      center: "attendance",
      originId: config.originId,
      device: {
        id: crypto.randomUUID(),
        name,
        createdAt: now
      },
      adminChallenge: challenge,
      employees: structuredClone(config.employees),
      punches: [],
      imports: [
        {
          exportId: config.exportId,
          at: now,
          added: config.employees.length,
          skipped: 0,
          conflicts: 0
        }
      ],
      security: {
        employee: { failures: 0, lockedUntil: 0 },
        admin: { failures: 0, lockedUntil: 0 }
      }
    };

    await store.initialize(newState);
    state = newState;
    pendingSetup = null;
    get("deviceForm").reset();

    if (navigator.storage?.persist) {
      navigator.storage.persist().catch(() => {});
    }

    screen("clockScreen");
    refreshClock();

  } catch (error) {
    message("setupMessage", error.message, "error");
  } finally {
    setBusy(false);
    button.disabled = false;
  }
});

get("setupBack").addEventListener("click", () => {
  if (busy) return;

  pendingSetup = null;
  get("setupImport").hidden = false;
  get("setupDevice").hidden = true;
  message("setupMessage");
});

/* tastierino */

document.querySelectorAll("[data-digit]").forEach(button => {
  button.addEventListener("click", () => {
    addClockDigit(button.dataset.digit);
  });
});

get("erasePin").addEventListener(
  "click",
  eraseClockDigit
);

get("clearPin").addEventListener("click", () => {
  if (busy) return;

  lastInteractionAt = Date.now();
  resetClockPin();
});

/* tastiera fisica */

document.addEventListener("keydown", event => {
  if (
    get("clockScreen").hidden ||
    busy ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  ) return;

  const target = event.target;

  if (
    target instanceof HTMLElement &&
    (
      target.matches("input, textarea, select") ||
      target.isContentEditable
    )
  ) return;

  if (/^[0-9]$/.test(event.key)) {
    event.preventDefault();
    addClockDigit(event.key);

  } else if (event.key === "Backspace") {
    event.preventDefault();
    eraseClockDigit();

  } else if (event.key === "Escape") {
    event.preventDefault();
    lastInteractionAt = Date.now();
    resetClockPin();
  }
});

/* timbratura automatica */

async function registerPunch(pin) {
  if (busy || !state) return;

  setBusy(true);
  cancelClockTimer();

  try {
    checkLock("employee");

    if (!/^[0-9]{4}$/.test(pin)) {
      throw new Error("Inserisci un PIN di 4 cifre");
    }

    let found = null;

    for (const employee of state.employees) {
      if (
        employee.active &&
        await verifyEmployeePin(
          pin,
          employee.pinVerifier
        )
      ) {
        found = employee;
        break;
      }
    }

    if (!found) {
      await updateSecurity("employee", false);
    }

    await updateSecurity("employee", true);

    const previous = [...state.punches]
      .reverse()
      .find(punch => punch.employeeId === found.id);

    const type = previous?.type === "in"
      ? "out"
      : "in";

    const at = new Date().toISOString();
    const next = structuredClone(state);

    next.punches.push({
      id: crypto.randomUUID(),
      employeeId: found.id,
      deviceId: state.device.id,
      type,
      at
    });

    await store.save(next);
    state = next;

    message(
      "clockMessage",
      `${found.firstName} · ` +
      `${type === "in" ? "Entrata" : "Uscita"} · ` +
      `${dateFormat.format(new Date(at))} · ` +
      `${type === "in" ? "Buon lavoro!" : "Buon riposo!"}`,
      "success"
    );

  } catch (error) {
    message("clockMessage", error.message, "error");
  } finally {
    resetClockPin();
    lastInteractionAt = Date.now();
    setBusy(false);
  }
}

/* amministrazione */

function closeAdmin() {
  if (busy) return;

  clearTimeout(adminTimer);
  adminTimer = null;
  adminPinSession = null;

  get("adminLogin").reset();
  get("importForm").reset();
  get("adminGate").hidden = false;
  get("adminPanel").hidden = true;

  message("adminMessage");
  message("importMessage");

  if (state) {
    screen("clockScreen");
    refreshClock();
  }

  lastInteractionAt = Date.now();
}

function refreshAdminTimeout() {
  clearTimeout(adminTimer);

  adminTimer = setTimeout(() => {
    if (busy) {
      refreshAdminTimeout();
      return;
    }
    closeAdmin();
  }, 120000);
}

function renderAdmin() {
  get("adminDeviceName").textContent =
    state.device.name;

  get("adminDeviceId").textContent =
    state.device.id;

  get("adminPunchCount").textContent =
    String(state.punches.length);

  const names = new Map(
    state.employees.map(employee => [
      employee.id,
      `${employee.firstName} ${employee.lastName}`
    ])
  );

  const list = get("punchList");
  list.replaceChildren();

  for (const punch of state.punches.slice(-20).reverse()) {
    const row = document.createElement("div");
    row.className = "log-row";

    const person = document.createElement("strong");
    person.textContent =
      names.get(punch.employeeId) ||
      "Dipendente non trovato";

    const details = document.createElement("span");
    details.textContent =
      `${punch.type === "in" ? "Entrata" : "Uscita"} · ` +
      dateFormat.format(new Date(punch.at));

    row.append(person, details);
    list.append(row);
  }

  if (!state.punches.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "Nessuna timbratura";
    list.append(empty);
  }
}

get("adminOpen").addEventListener("click", () => {
  if (busy) return;

  lastInteractionAt = Date.now();
  screen("adminScreen");

  get("adminGate").hidden = false;
  get("adminPanel").hidden = true;
  get("adminLogin").reset();
  message("adminMessage");
  get("adminPin").focus();
});

get("adminBack").addEventListener(
  "click",
  closeAdmin
);

get("adminExit").addEventListener(
  "click",
  closeAdmin
);

get("adminLogin").addEventListener(
  "submit",
  async event => {
    event.preventDefault();
    if (busy) return;

    setBusy(true);

    const button = get("adminLoginButton");
    button.disabled = true;
    message("adminMessage");

    try {
      checkLock("admin");

      const pin = get("adminPin").value;
      let valid = false;

      try {
        const proof = await openProvisioningPackage(
          state.adminChallenge,
          pin
        );
        valid = proof.originId === state.originId;
      } catch {
        valid = false;
      }

      if (!valid) {
        await updateSecurity("admin", false);
      }

      await updateSecurity("admin", true);
      adminPinSession = pin;
      get("adminLogin").reset();

      get("adminGate").hidden = true;
      get("adminPanel").hidden = false;

      renderAdmin();
      refreshAdminTimeout();

    } catch (error) {
      message("adminMessage", error.message, "error");
    } finally {
      setBusy(false);
      button.disabled = false;
    }
  }
);

/* importazione dipendenti */

get("importForm").addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    if (busy || !adminPinSession) return;

    setBusy(true);
    const button = get("importButton");
    button.disabled = true;
    message("importMessage");

    try {
      const json = await readJsonFile(
        get("importJson").files[0]
      );
      const incoming = await openProvisioningPackage(
        json,
        adminPinSession
      );

      if (incoming.originId !== state.originId) {
        throw new Error(
          "Configurazione di un altro Core Center"
        );
      }

      if (
        state.imports.some(
          item => item.exportId === incoming.exportId
        )
      ) {
        message(
          "importMessage",
          "JSON già importato",
          "success"
        );
        return;
      }

      const currentById = new Map(
        state.employees.map(employee => [
          employee.id,
          employee
        ])
      );

      const names = new Set(
        state.employees.map(employee =>
          `${employee.firstName} ${employee.lastName}`
            .trim()
            .toLocaleLowerCase("it")
        )
      );

      const added = [];
      const conflicts = [];
      let skipped = 0;

      for (const employee of incoming.employees) {
        const existing = currentById.get(employee.id);

        if (existing) {
          if (
            JSON.stringify(existing) ===
            JSON.stringify(employee)
          ) {
            skipped += 1;
          } else {
            conflicts.push(
              `${employee.firstName} ${employee.lastName}`
            );
          }
          continue;
        }

        const name =
          `${employee.firstName} ${employee.lastName}`
            .trim()
            .toLocaleLowerCase("it");

        if (names.has(name)) {
          conflicts.push(
            `${employee.firstName} ${employee.lastName}`
          );
          continue;
        }

        names.add(name);
        added.push(structuredClone(employee));
      }

      const next = structuredClone(state);
      next.employees.push(...added);

      next.imports.push({
        exportId: incoming.exportId,
        at: new Date().toISOString(),
        added: added.length,
        skipped,
        conflicts: conflicts.length
      });

      await store.save(next);
      state = next;

      get("importForm").reset();
      renderAdmin();
      refreshAdminTimeout();

      const summary =
        `${added.length} aggiunti · ` +
        `${skipped} già presenti · ` +
        `${conflicts.length} conflitti`;

      message(
        "importMessage",
        conflicts.length
          ? `${summary}. Non modificati: ${conflicts.join(", ")}`
          : summary,
        conflicts.length ? "error" : "success"
      );

    } catch (error) {
      message("importMessage", error.message, "error");
    } finally {
      setBusy(false);
      button.disabled = false;
    }
  }
);

/* tema unico */

const colorPreference = matchMedia(
  "(prefers-color-scheme: dark)"
);

function applyTheme(mode) {
  themeMode = themeModes.includes(mode)
    ? mode
    : "auto";

  document.documentElement.dataset.theme =
    themeMode === "auto" ? "" : themeMode;

  const button = get("themeToggle");
  button.textContent = themeSymbols[themeMode];
  button.setAttribute(
    "aria-label",
    `Tema ${themeNames[themeMode]}. Tocca per cambiare`
  );
  button.title = `Tema ${themeNames[themeMode]}`;

  const dark =
    themeMode === "dark" ||
    (
      themeMode === "auto" &&
      colorPreference.matches
    );

  document
    .querySelector('meta[name="theme-color"]')
    .setAttribute(
      "content",
      dark ? "#111113" : "#f5f5f7"
    );

  try {
    localStorage.setItem(
      "attendance-theme",
      themeMode
    );
  } catch {
    // preferenza facoltativa
  }
}

let storedTheme = "auto";

try {
  storedTheme =
    localStorage.getItem("attendance-theme") ||
    "auto";
} catch {
  storedTheme = "auto";
}

applyTheme(storedTheme);

get("themeToggle").addEventListener("click", () => {
  const next =
    (themeModes.indexOf(themeMode) + 1) %
    themeModes.length;

  applyTheme(themeModes[next]);
});

colorPreference.addEventListener?.("change", () => {
  if (themeMode === "auto") applyTheme("auto");
});

/* supporto offline */

function setOfflineStatus(ready, value) {
  get("offlineStatus").classList.toggle(
    "ready",
    ready
  );
  get("offlineText").textContent = value;
}

function delay(milliseconds) {
  return new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });
}

function withTimeout(promise, milliseconds, reason) {
  let timer;

  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(
          reason || "Tempo di attesa superato"
        ));
      }, milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}

function workerInfo(worker, type = "app-status") {
  if (!worker) return Promise.resolve(null);

  return new Promise(resolve => {
    const channel = new MessageChannel();
    let finished = false;

    const finish = data => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      channel.port1.close();
      channel.port2.close();
      resolve(data);
    };

    const timer = setTimeout(() => finish(null), 4500);

    channel.port1.onmessage = event => {
      finish(event.data);
    };

    try {
      worker.postMessage(
        { type },
        [channel.port2]
      );
    } catch {
      finish(null);
    }
  });
}

async function getRegistration() {
  if (!("serviceWorker" in navigator)) return null;

  // recupera sempre la registrazione corrente
  // per evitare riferimenti scaduti
  return withTimeout(
    navigator.serviceWorker.getRegistration("./"),
    7000,
    "Registrazione offline non disponibile"
  );
}

async function registerWorker() {
  return withTimeout(
    navigator.serviceWorker.register("./sw.js", {
      scope: "./",
      updateViaCache: "none"
    }),
    15000,
    "Registrazione offline troppo lenta"
  );
}

async function refreshOfflineStatus() {
  if (
    !("serviceWorker" in navigator) ||
    !("caches" in window)
  ) {
    setOfflineStatus(false, "Offline non supportato");
    return false;
  }

  try {
    const current = await getRegistration();

    if (!current?.active) {
      setOfflineStatus(
        false,
        current?.installing
          ? "Preparazione offline..."
          : "Offline non pronto"
      );
      return false;
    }

    const info = await workerInfo(current.active);

    const ready =
      info?.ready === true &&
      info.appVersion === appVersion &&
      info.cacheName === cacheName;

    setOfflineStatus(
      ready,
      ready
        ? "Disponibile offline"
        : info?.ready
          ? "Versione offline da aggiornare"
          : "Offline non pronto"
    );

    return ready;

  } catch (error) {
    console.warn("stato offline:", error);
    setOfflineStatus(
      false,
      "Verifica offline non riuscita"
    );
    return false;
  }
}

async function prepareOffline() {
  if (!("serviceWorker" in navigator)) {
    setOfflineStatus(false, "Offline non supportato");
    return;
  }

  try {
    let current = await getRegistration();

    if (!current && navigator.onLine) {
      current = await registerWorker();
    }

    if (
      current &&
      !current.active &&
      current.installing
    ) {
      setOfflineStatus(false, "Preparazione offline...");

      await withTimeout(
        navigator.serviceWorker.ready,
        12000,
        "Preparazione offline troppo lenta"
      );
    }

  } catch (error) {
    console.warn("preparazione offline:", error);
  }

  await refreshOfflineStatus();
}

/* aggiornamenti manuali */

function canApplyUpdate() {
  const clockReady =
    !get("clockScreen").hidden &&
    clockPin.length === 0 &&
    clockTimer === null;

  const setupReady =
    !get("setupScreen").hidden &&
    !get("setupPin").value &&
    !get("deviceInput").value &&
    !get("setupJson").files.length;

  const errorReady = !get("errorScreen").hidden;

  return (
    appReady &&
    !busy &&
    !pendingSetup &&
    !adminPinSession &&
    get("adminScreen").hidden &&
    (clockReady || setupReady || errorReady) &&
    !document.hidden &&
    Date.now() - lastInteractionAt >= 1500
  );
}

function clearUpdateTimer() {
  if (updateTimer !== null) {
    clearInterval(updateTimer);
  }
  updateTimer = null;
}

function queueSafeUpdate(worker, version) {
  pendingUpdate = {
    worker: worker || null,
    version
  };

  message(
    "updateMessage",
    "Aggiornamento pronto. Attendo la fine delle operazioni."
  );

  clearUpdateTimer();

  updateTimer = setInterval(() => {
    if (canApplyUpdate() && !applyingUpdate) {
      void applyUpdate();
    }
  }, 400);

  if (canApplyUpdate()) void applyUpdate();
}

async function applyUpdate() {
  if (
    applyingUpdate ||
    !pendingUpdate ||
    !canApplyUpdate()
  ) return;

  applyingUpdate = true;
  clearUpdateTimer();

  const button = get("checkUpdateButton");
  button.disabled = true;

  message(
    "updateMessage",
    "Installazione aggiornamento..."
  );

  try {
    const { worker, version } = pendingUpdate;

    if (worker) {
      worker.postMessage({
        type: "activate-update"
      });

      let activated = false;

      for (let attempt = 0; attempt < 65; attempt++) {
        const current = await getRegistration();

        if (
          current?.active &&
          worker.state === "activated"
        ) {
          const info = await workerInfo(current.active);

          if (info?.ready && info.appVersion === version) {
            activated = true;
            break;
          }
        }

        await delay(350);
      }

      if (!activated) {
        throw new Error(
          "Attivazione aggiornamento non riuscita"
        );
      }
    }

    // il browser ricarica questa stessa finestra
    // senza cancellare indexeddb o altri dati
    location.reload();

  } catch (error) {
    applyingUpdate = false;
    pendingUpdate = null;
    button.disabled = false;

    message(
      "updateMessage",
      `${error.message}. Riprova il controllo.`,
      "error"
    );
  }
}

async function remoteVersion() {
  const url = new URL("./sw.js", location.href);

  url.searchParams.set(
    "manual-update",
    String(Date.now())
  );

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 18000);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        "Server aggiornamenti non disponibile"
      );
    }

    const source = await response.text();

    const match = source.match(
      /const appVersion\s*=\s*["']([0-9.]+)["']/
    );

    if (!match) {
      throw new Error(
        "Versione online non leggibile"
      );
    }

    return match[1];

  } finally {
    clearTimeout(timer);
  }
}

async function waitForVersion(version) {
  const deadline = Date.now() + 28000;

  while (Date.now() < deadline) {
    const current = await getRegistration();

    if (current?.waiting) {
      const info = await workerInfo(current.waiting);

      if (
        info?.ready &&
        info.appVersion === version
      ) {
        return {
          worker: current.waiting,
          active: false
        };
      }
    }

    if (current?.active) {
      const info = await workerInfo(current.active);

      if (
        info?.ready &&
        info.appVersion === version
      ) {
        return {
          worker: current.active,
          active: true
        };
      }
    }

    if (current?.installing?.state === "redundant") {
      throw new Error(
        "Installazione non riuscita"
      );
    }

    await delay(400);
  }

  return null;
}

async function checkForUpdates() {
  if (
    checkingUpdates ||
    applyingUpdate ||
    pendingUpdate
  ) return;

  checkingUpdates = true;

  const button = get("checkUpdateButton");
  button.disabled = true;

  message(
    "updateMessage",
    "Controllo aggiornamenti..."
  );

  try {
    if (!navigator.onLine) {
      throw new Error("Connessione non disponibile");
    }

    if (!("serviceWorker" in navigator)) {
      throw new Error(
        "Aggiornamenti non supportati"
      );
    }

    let current = await getRegistration();

    if (!current) {
      current = await registerWorker();
    }

    const version = await remoteVersion();

    // prima verifica se la nuova versione
    // è già installata ma ancora in attesa
    const waitingInfo = await workerInfo(
      current.waiting
    );

    if (
      waitingInfo?.ready &&
      waitingInfo.appVersion === version
    ) {
      queueSafeUpdate(current.waiting, version);
      return;
    }

    const activeInfo = await workerInfo(
      current.active
    );

    if (
      activeInfo?.appVersion === version &&
      activeInfo.ready
    ) {
      if (
        version !== appVersion ||
        !navigator.serviceWorker.controller
      ) {
        queueSafeUpdate(null, version);
      } else {
        message(
          "updateMessage",
          "L'app è aggiornata",
          "success"
        );
      }
      return;
    }

    if (
      version === appVersion &&
      activeInfo?.appVersion === appVersion &&
      !activeInfo.ready
    ) {
      message(
        "updateMessage",
        "Ripristino file offline..."
      );

      const repaired = await workerInfo(
        current.active,
        "repair-shell"
      );

      if (!repaired?.ready) {
        throw new Error(
          "File offline non ripristinati"
        );
      }

      await refreshOfflineStatus();

      message(
        "updateMessage",
        "L'app è aggiornata",
        "success"
      );
      return;
    }

    message(
      "updateMessage",
      version === appVersion
        ? "Preparazione offline..."
        : `Versione ${version} disponibile. Download...`
    );

    // il worker esistente potrebbe essere
    // una registrazione ormai non valida
    try {
      if (current.active || current.waiting || current.installing) {
        await withTimeout(
          current.update(),
          20000,
          "Controllo aggiornamenti troppo lento"
        );
      } else {
        await registerWorker();
      }

    } catch (error) {
      const fresh = await getRegistration();

      if (!fresh) {
        await registerWorker();
      } else if (
        !fresh.installing &&
        !fresh.waiting
      ) {
        throw error;
      }
    }

    const result = await waitForVersion(version);

    if (!result) {
      throw new Error(
        "Installazione non completata. Riprova."
      );
    }

    if (result.active) {
      if (
        version !== appVersion ||
        !navigator.serviceWorker.controller
      ) {
        queueSafeUpdate(null, version);
      } else {
        message(
          "updateMessage",
          "L'app è aggiornata",
          "success"
        );
      }
    } else {
      queueSafeUpdate(result.worker, version);
    }

  } catch (error) {
    message(
      "updateMessage",
      error.name === "AbortError"
        ? "Connessione troppo lenta. Riprova."
        : error.message,
      "error"
    );

  } finally {
    checkingUpdates = false;

    if (!pendingUpdate && !applyingUpdate) {
      button.disabled = false;
    }

    void refreshOfflineStatus();
  }
}

get("checkUpdateButton").addEventListener(
  "click",
  () => {
    lastInteractionAt = Date.now();
    void checkForUpdates();
  }
);

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => {
      // verifica esclusivamente la cache locale
      void refreshOfflineStatus();
    }
  );
}

/* avvio */

async function start() {
  message("bootMessage");

  try {
    state = await store.load();

    if (state && !validState(state)) {
      throw new Error(
        "Archivio non compatibile"
      );
    }

    if (state) {
      screen("clockScreen");
      refreshClock();

    } else {
      screen("setupScreen");
      get("setupImport").hidden = false;
      get("setupDevice").hidden = true;
    }

  } catch (error) {
    get("bootMessage").textContent =
      error.message;
    screen("errorScreen");

  } finally {
    appReady = true;
  }
}

renderClockPin();
void start();
void prepareOffline();
