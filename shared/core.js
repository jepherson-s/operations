const storeName = "vault";
const recordKey = "main";
const iterations = 350000;

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

async function deriveKey(pin, salt, rounds) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: rounds,
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

async function encryptData(data, key) {
  const iv = crypto.getRandomValues(
    new Uint8Array(12)
  );

  const encoded = encoder.encode(
    JSON.stringify(data)
  );

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv
    },
    key,
    encoded
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
  if (!crypto?.subtle || !indexedDB) {
    throw new Error(
      "archiviazione sicura non supportata"
    );
  }

  let databasePromise = null;
  let sessionKey = null;
  let sessionSalt = null;
  let sessionData = null;

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

  async function writeRecord(record, createOnly) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(
        storeName,
        "readwrite"
      );

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        reject(
          transaction.error ||
          new Error("salvataggio non riuscito")
        );
      };

      transaction.onabort = () => {
        reject(
          transaction.error ||
          new Error("salvataggio annullato")
        );
      };

      const store = transaction.objectStore(
        storeName
      );

      if (createOnly) {
        store.add(record, recordKey);
      } else {
        store.put(record, recordKey);
      }
    });
  }

  function validatePin(pin) {
    if (!/^[0-9]{10,12}$/.test(pin)) {
      throw new Error(
        "il pin deve contenere da 10 a 12 cifre"
      );
    }
  }

  function validateData(data) {
    if (
      data.schemaVersion !== 1 ||
      data.center !== centerId
    ) {
      throw new Error(
        "archivio non compatibile"
      );
    }
  }

  async function hasData() {
    return Boolean(await readRecord());
  }

  async function create(pin) {
    validatePin(pin);

    if (await hasData()) {
      throw new Error(
        "configurazione già presente"
      );
    }

    const salt = crypto.getRandomValues(
      new Uint8Array(16)
    );

    const key = await deriveKey(
      pin,
      salt,
      iterations
    );

    const data = {
      schemaVersion: 1,
      center: centerId,
      createdAt: new Date().toISOString(),
      employees: [],
      devices: [],
      settings: {}
    };

    const encrypted = await encryptData(
      data,
      key
    );

    await writeRecord(
      {
        version: 1,
        rounds: iterations,
        salt: toBase64(salt),
        ...encrypted
      },
      true
    );

    sessionKey = key;
    sessionSalt = salt;
    sessionData = data;

    return structuredClone(data);
  }

  async function unlock(pin) {
    validatePin(pin);

    const record = await readRecord();

    if (!record) {
      throw new Error(
        "configurazione non presente"
      );
    }

    if (
      record.version !== 1 ||
      !Number.isInteger(record.rounds) ||
      record.rounds !== iterations
    ) {
      throw new Error(
        "versione archivio non compatibile"
      );
    }

    const salt = fromBase64(record.salt);

    const key = await deriveKey(
      pin,
      salt,
      record.rounds
    );

    let data;

    try {
      data = await decryptData(
        record,
        key
      );
    } catch (error) {
      throw new Error(
        "pin non corretto o archivio danneggiato"
      );
    }

    validateData(data);

    sessionKey = key;
    sessionSalt = salt;
    sessionData = data;

    return structuredClone(data);
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
    if (!sessionKey || !sessionSalt) {
      throw new Error(
        "archivio bloccato"
      );
    }

    validateData(data);

    const encrypted = await encryptData(
      data,
      sessionKey
    );

    await writeRecord(
      {
        version: 1,
        rounds: iterations,
        salt: toBase64(sessionSalt),
        ...encrypted
      },
      false
    );

    sessionData = structuredClone(data);
  }

  function lock() {
    sessionKey = null;
    sessionSalt = null;
    sessionData = null;
  }

  return {
    hasData,
    create,
    unlock,
    read,
    save,
    lock
  };
}
