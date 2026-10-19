const databaseName = "operations-attendance";
const recordKey = "main";

export function createAttendanceStore() {
  let databasePromise = null;
  let activeKey = null;
  let activeRevision = 0;

  function database() {
    if (databasePromise) return databasePromise;

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("state")) {
          db.createObjectStore("state");
        }
        if (!db.objectStoreNames.contains("keys")) {
          db.createObjectStore("keys");
        }
      };

      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          databasePromise = null;
        };
        resolve(db);
      };

      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error("database non disponibile"));
      };
    });

    return databasePromise;
  }

  async function get(storeName) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, "readonly")
        .objectStore(storeName).get(recordKey);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("lettura non riuscita"));
    });
  }

  async function encrypt(data, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      new TextEncoder().encode(JSON.stringify(data))
    );
    return { iv, encrypted };
  }

  async function load() {
    const record = await get("state");
    const key = await get("keys");

    if (!record && !key) return null;
    if (!record || !key || record.version !== 1) {
      throw new Error("archivio locale incompleto");
    }

    let data;
    try {
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: record.iv },
        key,
        record.encrypted
      );
      data = JSON.parse(new TextDecoder().decode(decrypted));
    } catch (error) {
      throw new Error("archivio locale non leggibile");
    }

    activeKey = key;
    activeRevision = record.revision;
    return data;
  }

  async function initialize(data) {
    const db = await database();
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    const encrypted = await encrypt(data, key);

    await new Promise((resolve, reject) => {
      const transaction = db.transaction(["state", "keys"], "readwrite");
      transaction.objectStore("keys").add(key, recordKey);
      transaction.objectStore("state").add({
        version: 1,
        revision: 1,
        ...encrypted
      }, recordKey);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error("dispositivo già configurato o salvataggio non riuscito"));
      transaction.onerror = () => reject(transaction.error || new Error("salvataggio non riuscito"));
    });

    activeKey = key;
    activeRevision = 1;
  }

  async function save(data) {
    if (!activeKey || !activeRevision) {
      throw new Error("archivio non inizializzato");
    }

    const encrypted = await encrypt(data, activeKey);
    const expectedRevision = activeRevision;
    const nextRevision = expectedRevision + 1;
    const db = await database();

    await new Promise((resolve, reject) => {
      const transaction = db.transaction("state", "readwrite");
      const store = transaction.objectStore("state");
      let conflict = false;
      const request = store.get(recordKey);

      request.onsuccess = () => {
        if (request.result?.revision !== expectedRevision) {
          conflict = true;
          transaction.abort();
          return;
        }
        store.put({ version: 1, revision: nextRevision, ...encrypted }, recordKey);
      };

      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error(
        conflict
          ? "archivio modificato in un'altra scheda: riapri l'app"
          : "salvataggio non riuscito"
      ));
      transaction.onerror = () => reject(transaction.error || new Error("salvataggio non riuscito"));
    });

    activeRevision = nextRevision;
  }

  return { load, initialize, save };
}
