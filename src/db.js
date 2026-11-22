const DB_NAME='mp-reader'; const STORE='books';
function connect(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function useStore(mode,action){const db=await connect();return new Promise((resolve,reject)=>{const transaction=db.transaction(STORE,mode);const request=action(transaction.objectStore(STORE));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);transaction.oncomplete=()=>db.close();transaction.onerror=()=>reject(transaction.error);});}
export const allBooks=()=>useStore('readonly',s=>s.getAll());
export const getBook=id=>useStore('readonly',s=>s.get(id));
export const saveBook=book=>useStore('readwrite',s=>s.put(book));
export const removeBook=id=>useStore('readwrite',s=>s.delete(id));
