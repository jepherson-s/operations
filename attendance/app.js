import {
  openProvisioningPackage,
  createProvisioningPackage,
  verifyEmployeePin
} from "../shared/core.js";
import { createAttendanceStore } from "./store.js";

const get = id => document.getElementById(id);
const store = createAttendanceStore();
const dateFormat = new Intl.DateTimeFormat("it-IT", {
  day: "2-digit", month: "2-digit", year: "numeric",
  hour: "2-digit", minute: "2-digit"
});

let state = null;
let pendingSetup = null;
let adminPinSession = null;
let adminTimer = null;
let busy = false;

function message(id, value = "", kind = "") {
  const element = get(id);
  element.textContent = value;
  element.className = `message${kind ? ` ${kind}` : ""}`;
}

function screen(id) {
  for (const element of document.querySelectorAll(".screen")) {
    element.hidden = element.id !== id;
  }
  get("adminOpen").hidden = id !== "clockScreen";
  get("adminBack").hidden = id !== "adminScreen";
  window.scrollTo(0, 0);
}

function validState(data) {
  return data?.schemaVersion === 1 &&
    data.center === "attendance" &&
    typeof data.originId === "string" &&
    typeof data.device?.id === "string" &&
    typeof data.device?.name === "string" &&
    Array.isArray(data.employees) &&
    Array.isArray(data.punches) &&
    Array.isArray(data.imports) &&
    Boolean(data.adminChallenge);
}

function security(kind) {
  if (!state.security) state.security = {};
  if (!state.security[kind]) {
    state.security[kind] = { failures: 0, lockedUntil: 0 };
  }
  return state.security[kind];
}

function checkLock(kind) {
  const guard = security(kind);
  if (guard.lockedUntil > Date.now()) {
    const seconds = Math.ceil((guard.lockedUntil - Date.now()) / 1000);
    throw new Error(`riprova tra ${seconds} secondi`);
  }
}

async function failPin(kind) {
  const guard = security(kind);
  guard.failures += 1;
  if (guard.failures >= 5) {
    guard.failures = 0;
    guard.lockedUntil = Date.now() + 60000;
  }
  await store.save(state);
  throw new Error(guard.lockedUntil > Date.now()
    ? "troppi tentativi: attendi 60 secondi"
    : "pin non riconosciuto");
}

async function clearPinFailures(kind) {
  const guard = security(kind);
  if (!guard.failures && !guard.lockedUntil) return;
  guard.failures = 0;
  guard.lockedUntil = 0;
  await store.save(state);
}

async function readJsonFile(file) {
  if (!file || file.size > 5 * 1024 * 1024) {
    throw new Error("seleziona un json valido (massimo 5 mb)");
  }
  let result;
  try {
    result = JSON.parse(await file.text());
  } catch (error) {
    throw new Error("json non leggibile");
  }
  return result;
}

function refreshClock() {
  get("deviceName").textContent = state.device.name;
  get("employeeCount").textContent = `${state.employees.length} dipendenti`;
  get("pinClock").value = "";
  get("pinClock").focus();
}

function currentTime() {
  return dateFormat.format(new Date());
}

function closeAdmin() {
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
}

function refreshAdminTimeout() {
  clearTimeout(adminTimer);
  adminTimer = setTimeout(closeAdmin, 120000);
}

function renderAdmin() {
  get("adminDeviceName").textContent = state.device.name;
  get("adminDeviceId").textContent = state.device.id;
  get("adminEmployeeCount").textContent = String(state.employees.length);
  get("adminPunchCount").textContent = String(state.punches.length);

  const names = new Map(state.employees.map(employee => [
    employee.id,
    `${employee.firstName} ${employee.lastName}`
  ]));

  const list = get("punchList");
  list.replaceChildren();

  for (const punch of state.punches.slice(-20).reverse()) {
    const row = document.createElement("div");
    row.className = "log-row";
    const person = document.createElement("strong");
    person.textContent = names.get(punch.employeeId) || "dipendente non trovato";
    const details = document.createElement("span");
    details.textContent = `${punch.type === "in" ? "entrata" : "uscita"} · ${dateFormat.format(new Date(punch.at))}`;
    row.append(person, details);
    list.append(row);
  }

  if (!state.punches.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "nessuna timbratura";
    list.append(empty);
  }
}

/* primo avvio */

get("setupForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  const button = get("setupContinue");
  button.disabled = true;
  message("setupMessage");

  try {
    const pin = get("setupPin").value;
    const json = await readJsonFile(get("setupJson").files[0]);
    const config = await openProvisioningPackage(json, pin);

    if (!config.employees.length) {
      throw new Error("il json non contiene dipendenti attivi");
    }

    pendingSetup = { config, pin };
    get("setupImport").hidden = true;
    get("setupDevice").hidden = false;
    get("setupCount").textContent = `${config.employees.length} dipendenti pronti`;
    get("setupPin").value = "";
    get("deviceInput").focus();
  } catch (error) {
    message("setupMessage", error.message, "error");
  } finally {
    busy = false;
    button.disabled = false;
  }
});

get("deviceForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !pendingSetup) return;
  busy = true;
  get("activateButton").disabled = true;
  message("setupMessage");

  try {
    const name = get("deviceInput").value.trim();
    if (!name || name.length > 80) throw new Error("inserisci il nome dispositivo");

    const { config, pin } = pendingSetup;
    const now = new Date().toISOString();

    const challenge = await createProvisioningPackage({
      schemaVersion: 1,
      kind: "center-provisioning",
      sourceCenter: "core",
      targetCenter: "attendance",
      originId: config.originId,
      exportId: crypto.randomUUID(),
      issuedAt: now,
      employees: []
    }, pin);

    const newState = {
      schemaVersion: 1,
      center: "attendance",
      originId: config.originId,
      device: { id: crypto.randomUUID(), name, createdAt: now },
      adminChallenge: challenge,
      employees: structuredClone(config.employees),
      punches: [],
      imports: [{
        exportId: config.exportId,
        at: now,
        added: config.employees.length,
        skipped: 0,
        conflicts: 0
      }],
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
    busy = false;
    get("activateButton").disabled = false;
  }
});

get("setupBack").addEventListener("click", () => {
  pendingSetup = null;
  get("setupImport").hidden = false;
  get("setupDevice").hidden = true;
  message("setupMessage");
});

/* timbrature */

get("pinClock").addEventListener("input", event => {
  event.target.value = event.target.value.replace(/\D/g, "").slice(0, 4);
});

for (const button of document.querySelectorAll("[data-digit]")) {
  button.addEventListener("click", () => {
    const input = get("pinClock");
    if (input.value.length < 4) input.value += button.dataset.digit;
  });
}

get("erasePin").addEventListener("click", () => {
  get("pinClock").value = get("pinClock").value.slice(0, -1);
});

get("clearPin").addEventListener("click", () => {
  get("pinClock").value = "";
});

get("clockForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !state) return;
  busy = true;
  get("clockButton").disabled = true;
  message("clockMessage");

  try {
    checkLock("employee");
    const pin = get("pinClock").value;
    if (!/^[0-9]{4}$/.test(pin)) throw new Error("inserisci 4 cifre");

    let found = null;
    for (const employee of state.employees) {
      if (employee.active && await verifyEmployeePin(pin, employee.pinVerifier)) {
        found = employee;
        break;
      }
    }

    if (!found) await failPin("employee");
    await clearPinFailures("employee");

    const previous = [...state.punches].reverse()
      .find(punch => punch.employeeId === found.id);

    const type = previous?.type === "in" ? "out" : "in";
    const at = new Date().toISOString();

    state.punches.push({
      id: crypto.randomUUID(),
      employeeId: found.id,
      deviceId: state.device.id,
      type,
      at
    });

    await store.save(state);
    get("pinClock").value = "";
    message(
      "clockMessage",
      `${found.firstName} · ${type === "in" ? "entrata" : "uscita"} ${currentTime()} · ${type === "in" ? "buon lavoro!" : "buon riposo!"}`,
      "success"
    );
  } catch (error) {
    get("pinClock").value = "";
    message("clockMessage", error.message, "error");
  } finally {
    busy = false;
    get("clockButton").disabled = false;
  }
});

/* amministrazione */

get("adminOpen").addEventListener("click", () => {
  screen("adminScreen");
  get("adminGate").hidden = false;
  get("adminPanel").hidden = true;
  get("adminLogin").reset();
  message("adminMessage");
  get("adminPin").focus();
});

get("adminBack").addEventListener("click", closeAdmin);
get("adminExit").addEventListener("click", closeAdmin);

get("adminLogin").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  busy = true;
  get("adminLoginButton").disabled = true;
  message("adminMessage");

  try {
    checkLock("admin");
    const pin = get("adminPin").value;
    let valid = false;

    try {
      const proof = await openProvisioningPackage(state.adminChallenge, pin);
      valid = proof.originId === state.originId;
    } catch (error) {
      valid = false;
    }

    if (!valid) await failPin("admin");
    await clearPinFailures("admin");

    adminPinSession = pin;
    get("adminLogin").reset();
    get("adminGate").hidden = true;
    get("adminPanel").hidden = false;
    renderAdmin();
    refreshAdminTimeout();
  } catch (error) {
    message("adminMessage", error.message, "error");
  } finally {
    busy = false;
    get("adminLoginButton").disabled = false;
  }
});

get("importForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || !adminPinSession) return;
  busy = true;
  get("importButton").disabled = true;
  message("importMessage");

  try {
    const json = await readJsonFile(get("importJson").files[0]);
    const incoming = await openProvisioningPackage(json, adminPinSession);

    if (incoming.originId !== state.originId) {
      throw new Error("configurazione proveniente da un altro core");
    }

    if (state.imports.some(item => item.exportId === incoming.exportId)) {
      message("importMessage", "json già importato", "success");
      return;
    }

    const currentById = new Map(state.employees.map(employee => [employee.id, employee]));
    const names = new Set(state.employees.map(employee =>
      `${employee.firstName} ${employee.lastName}`.trim().toLocaleLowerCase("it")
    ));
    const added = [];
    const conflicts = [];
    let skipped = 0;

    for (const employee of incoming.employees) {
      const existing = currentById.get(employee.id);
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(employee)) {
          skipped += 1;
        } else {
          conflicts.push(`${employee.firstName} ${employee.lastName}`);
        }
        continue;
      }

      const name = `${employee.firstName} ${employee.lastName}`.trim().toLocaleLowerCase("it");
      if (names.has(name)) {
        conflicts.push(`${employee.firstName} ${employee.lastName}`);
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

    const summary = `${added.length} aggiunti · ${skipped} già presenti · ${conflicts.length} conflitti`;
    message("importMessage", conflicts.length
      ? `${summary}. non modificati: ${conflicts.join(", ")}`
      : summary, conflicts.length ? "error" : "success");
  } catch (error) {
    message("importMessage", error.message, "error");
  } finally {
    busy = false;
    get("importButton").disabled = false;
  }
});

/* tema */

const themeButtons = document.querySelectorAll("[data-theme]");
const colorPreference = matchMedia("(prefers-color-scheme: dark)");

function applyTheme(theme) {
  const selected = ["light", "dark", "auto"].includes(theme) ? theme : "auto";
  document.documentElement.dataset.theme = selected === "auto" ? "" : selected;
  for (const button of themeButtons) {
    button.classList.toggle("active", button.dataset.theme === selected);
    button.setAttribute("aria-pressed", String(button.dataset.theme === selected));
  }
  const dark = selected === "dark" || (selected === "auto" && colorPreference.matches);
  document.querySelector('meta[name="theme-color"]')
    .setAttribute("content", dark ? "#111113" : "#f5f5f7");
  try { localStorage.setItem("attendance-theme", selected); } catch (error) { /* facoltativo */ }
}

let storedTheme = "auto";
try { storedTheme = localStorage.getItem("attendance-theme") || "auto"; } catch (error) { /* facoltativo */ }
applyTheme(storedTheme);
for (const button of themeButtons) {
  button.addEventListener("click", () => applyTheme(button.dataset.theme));
}
colorPreference.addEventListener?.("change", () => {
  if (!document.documentElement.dataset.theme) applyTheme("auto");
});

/* offline */

async function checkOfflineCache(worker) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 3000);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(event.data?.ready === true);
    };
    worker.postMessage({ type: "cache-check" }, [channel.port2]);
  });
}

async function registerOffline() {
  if (!("serviceWorker" in navigator)) {
    get("offlineText").textContent = "offline non supportato";
    return;
  }
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    const registration = await navigator.serviceWorker.ready;
    const ready = await checkOfflineCache(registration.active);
    get("offlineStatus").classList.toggle("ready", ready);
    get("offlineText").textContent = ready ? "disponibile offline" : "cache da verificare";
  } catch (error) {
    get("offlineText").textContent = "offline non disponibile";
  }
}

/* avvio */

async function start() {
  message("bootMessage");
  try {
    state = await store.load();
    if (state && !validState(state)) throw new Error("archivio non compatibile");
    if (state) {
      screen("clockScreen");
      refreshClock();
    } else {
      screen("setupScreen");
      get("setupImport").hidden = false;
      get("setupDevice").hidden = true;
    }
  } catch (error) {
    get("bootMessage").textContent = error.message;
    screen("errorScreen");
  }
}

start();
registerOffline();
