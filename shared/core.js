const storeName = "vault";
const recordKey = "main";
const iterations = 350000;
const employeeIterations = 180000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = "";

  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + 8192)
    );
  }

  return btoa(binary);
}

function fromBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function importPinMaterial(pin) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveKey", "deriveBits"]
  );
}

async function deriveKey(pin, salt) {
  const material = await importPinMaterial(pin);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    material,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

async function derivePinHash(pin, salt) {
  const material = await importPinMaterial(pin);

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: employeeIterations,
      hash: "SHA-256"
    },
    material,
    256
  );

  return new Uint8Array(bits);
}

function validateEmployeePin(pin) {
  if (!/^[0-9]{4}$/.test(pin)) {
    throw new Error(
      "il pin dipendente deve avere 4 cifre"
    );
  }
}

export async function createEmployeePinVerifier(pin) {
  validateEmployeePin(pin);

  const salt = crypto.getRandomValues(
    new Uint8Array(16)
  );

  const hash = await derivePinHash(pin, salt);

  return {
    version: 1,
    algorithm: "pbkdf2-sha256",
    rounds: employeeIterations,
    salt: toBase64(salt),
    hash: toBase64(hash)
  };
}

export async function verifyEmployeePin(pin, verifier) {
  if (!/^[0-9]{4}$/.test(pin)) {
    return false;
  }

  if (
    !verifier ||
    verifier.version !== 1 ||
    verifier.algorithm !== "pbkdf2-sha256" ||
    verifier.rounds !== employeeIterations
  ) {
    throw new Error(
      "verificatore pin non compatibile"
    );
  }

  const salt = fromBase64(verifier.salt);
  const expected = fromBase64(verifier.hash);

  if (salt.length !== 16 || expected.length !== 32) {
    throw new Error(
      "verificatore pin non valido"
    );
  }

  const actual = await derivePinHash(pin, salt);

  let difference = 0;

  for (let i = 0; i < actual.length; i++) {
    difference |= actual[i] ^ expected[i];
  }

  return difference === 0;
}

async function encryptData(data, key) {
  const iv = crypto.getRandomValues(
    new Uint8Array(12)
  );

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    encoder.encode(JSON.stringify(data))
  );

  return {
    iv: toBase64(iv),
    encrypted: toBase64(
      new Uint8Array(encrypted)
    )
  };
}

async function decryptData(record, key) {
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(record.iv)
    },
    key,
    fromBase64(record.encrypted)
  );

  return JSON.parse(
    decoder.decode(decrypted)
  );
}

export function createLocalVault(
  databaseName,
  centerId
) {
  if (
    !globalThis.crypto?.subtle ||
    !globalThis.indexedDB
  ) {
    throw new Error(
      "archiviazione sicura non supportata"
    );
  }

  let databasePromise = null;
  let sessionKey = null;
  let sessionData = null;
  let sessionRecord = null;

  function openDatabase() {
    if (databasePromise) {
      return databasePromise;
    }

    databasePromise = new Promise(
      (resolve, reject) => {
        const request = indexedDB.open(
          databaseName,
          1
        );

        request.onupgradeneeded = () => {
          const database = request.result;

          if (
            !database.objectStoreNames.contains(
              storeName
            )
          ) {
            database.createObjectStore(
              storeName
            );
          }
        };

        request.onsuccess = () => {
          const database = request.result;

          database.onversionchange = () => {
            database.close();
            databasePromise = null;
          };

          resolve(database);
        };

        request.onerror = () => {
          databasePromise = null;

          reject(
            request.error ||
            new Error("database non disponibile")
          );
        };
      }
    );

    return databasePromise;
  }

  async function readRecord() {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        storeName,
        "readonly"
      );

      const request = transaction
        .objectStore(storeName)
        .get(recordKey);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        reject(
          request.error ||
          new Error("lettura non riuscita")
        );
      };
    });
  }

  async function createRecord(record) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        storeName,
        "readwrite"
      );

      transaction.objectStore(storeName).add(
        record,
        recordKey
      );

      transaction.oncomplete = () => resolve();

      transaction.onerror = () => reject(
        transaction.error ||
        new Error("creazione non riuscita")
      );

      transaction.onabort = () => reject(
        transaction.error ||
        new Error("creazione annullata")
      );
    });
  }

  async function replaceRecord(
    previousRecord,
    nextRecord
  ) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        storeName,
        "readwrite"
      );

      const store = transaction.objectStore(
        storeName
      );

      let conflict = false;

      const request = store.get(recordKey);

      request.onsuccess = () => {
        const current = request.result;

        const unchanged =
          current &&
          current.version === previousRecord.version &&
          current.rounds === previousRecord.rounds &&
          current.salt === previousRecord.salt &&
          current.iv === previousRecord.iv &&
          current.encrypted === previousRecord.encrypted;

        if (!unchanged) {
          conflict = true;
          transaction.abort();
          return;
        }

        store.put(nextRecord, recordKey);
      };

      transaction.oncomplete = () => resolve();

      transaction.onabort = () => {
        reject(
          new Error(
            conflict
              ? "archivio modificato: blocca e riapri"
              : "salvataggio annullato"
          )
        );
      };

      transaction.onerror = () => reject(
        transaction.error ||
        new Error("salvataggio non riuscito")
      );
    });
  }

  function validateRecord(record) {
    if (
      !record ||
      record.version !== 1 ||
      record.rounds !== iterations
    ) {
      throw new Error(
        "versione archivio non compatibile"
      );
    }
  }

  function validateData(data) {
    if (
      !data ||
      data.schemaVersion !== 1 ||
      data.center !== centerId
    ) {
      throw new Error(
        "archivio non compatibile"
      );
    }
  }

  async function decodeRecord(record, pin) {
    validateRecord(record);

    const salt = fromBase64(record.salt);
    const key = await deriveKey(pin, salt);

    let data;

    try {
      data = await decryptData(record, key);
    } catch (error) {
      throw new Error(
        "pin non corretto o archivio danneggiato"
      );
    }

    validateData(data);

    return { key, data };
  }

  async function makeRecord(data, pin) {
    const salt = crypto.getRandomValues(
      new Uint8Array(16)
    );

    const key = await deriveKey(pin, salt);
    const encrypted = await encryptData(data, key);

    return {
      key,
      record: {
        version: 1,
        rounds: iterations,
        salt: toBase64(salt),
        ...encrypted
      }
    };
  }

  function setSession(key, data, record) {
    sessionKey = key;
    sessionData = structuredClone(data);
    sessionRecord = structuredClone(record);
  }

  async function hasData() {
    return Boolean(await readRecord());
  }

  async function create(pin) {
    if (!/^[0-9]{6}$/.test(pin)) {
      throw new Error(
        "il pin admin deve contenere 6 cifre"
      );
    }

    if (await hasData()) {
      throw new Error(
        "configurazione già presente"
      );
    }

    const data = {
      schemaVersion: 1,
      center: centerId,
      createdAt: new Date().toISOString(),
      employees: [],
      devices: [],
      settings: {}
    };

    const result = await makeRecord(data, pin);

    await createRecord(result.record);

    setSession(
      result.key,
      data,
      result.record
    );

    return structuredClone(data);
  }

  async function unlock(pin) {
    if (
      !/^(?:[0-9]{6}|[0-9]{10,12})$/.test(pin)
    ) {
      throw new Error(
        "formato pin non valido"
      );
    }

    const record = await readRecord();

    if (!record) {
      throw new Error(
        "configurazione non presente"
      );
    }

    const result = await decodeRecord(
      record,
      pin
    );

    setSession(
      result.key,
      result.data,
      record
    );

    return structuredClone(result.data);
  }

  function read() {
    if (!sessionKey || !sessionData) {
      throw new Error(
        "archivio bloccato"
      );
    }

    return structuredClone(sessionData);
  }

  async function save(data) {
    if (!sessionKey || !sessionRecord) {
      throw new Error(
        "archivio bloccato"
      );
    }

    validateData(data);

    const encrypted = await encryptData(
      data,
      sessionKey
    );

    const nextRecord = {
      ...sessionRecord,
      ...encrypted
    };

    await replaceRecord(
      sessionRecord,
      nextRecord
    );

    setSession(
      sessionKey,
      data,
      nextRecord
    );
  }

  async function changePin(oldPin, newPin) {
    if (!sessionKey || !sessionRecord) {
      throw new Error(
        "archivio bloccato"
      );
    }

    if (
      !/^(?:[0-9]{6}|[0-9]{10,12})$/.test(oldPin) ||
      !/^[0-9]{6}$/.test(newPin)
    ) {
      throw new Error(
        "formato pin non valido"
      );
    }

    if (oldPin === newPin) {
      throw new Error(
        "scegli un pin diverso"
      );
    }

    const previousRecord = await readRecord();

    if (!previousRecord) {
      throw new Error(
        "archivio non disponibile"
      );
    }

    const previous = await decodeRecord(
      previousRecord,
      oldPin
    );

    const next = await makeRecord(
      previous.data,
      newPin
    );

    await replaceRecord(
      previousRecord,
      next.record
    );

    setSession(
      next.key,
      previous.data,
      next.record
    );

    return true;
  }

  function lock() {
    sessionKey = null;
    sessionData = null;
    sessionRecord = null;
  }

  return {
    hasData,
    create,
    unlock,
    read,
    save,
    changePin,
    lock
  };
}
