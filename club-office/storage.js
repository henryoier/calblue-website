const DB_NAME = "calblue-club-office-v1";
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("vault");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Browser storage is unavailable. Try a normal browser window."));
  });
}
export async function readVault() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("vault", "readonly");
    const request = tx.objectStore("vault").get("current");
    tx.oncomplete = () => { db.close(); resolve(request.result || null); };
    tx.onerror = () => { db.close(); reject(new Error("Unable to read the local vault.")); };
  });
}
// Compare-and-swap prevents a second tab silently overwriting newer work.
export async function writeVault(envelope, expectedRevision) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("vault", "readwrite");
    const store = tx.objectStore("vault");
    const request = store.get("current");
    let conflict = false;
    const revision = crypto.randomUUID();
    request.onsuccess = () => {
      if ((request.result?.revision || null) !== expectedRevision) { conflict = true; tx.abort(); return; }
      store.put({ revision, envelope }, "current");
    };
    tx.oncomplete = () => { db.close(); resolve(revision); };
    tx.onabort = tx.onerror = () => { db.close(); reject(new Error(conflict ? "Another tab changed this vault. Lock and unlock to load its changes, then retry." : "Save failed. Browser storage may be full. Your last saved vault is unchanged.")); };
  });
}
