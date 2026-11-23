import {localLibrary} from './sync.js';
const DB_NAME='mp-reader'; const STORE='books';
function connect(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB_NAME,1);request.onupgradeneeded=()=>request.result.createObjectStore(STORE,{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});}
async function useStore(mode,action){const db=await connect();return new Promise((resolve,reject)=>{const transaction=db.transaction(STORE,mode);const request=action(transaction.objectStore(STORE));request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);transaction.oncomplete=()=>db.close();transaction.onerror=()=>reject(transaction.error);});}
const scopeOf = book => book.localLibrary ?? 'legacy';
export async function allBooks() {
  const scope = localLibrary();
  if (!scope) return [];
  const books = await useStore('readonly', store => store.getAll());
  return books.filter(book => scopeOf(book) === scope).map(book => ({...book, localLibrary: scope}));
}
export async function getBook(id) {
  const scope = localLibrary();
  if (!scope) return;
  const book = await useStore('readonly', store => store.get(id));
  if (book && scopeOf(book) === scope && localLibrary() === scope) return {...book, localLibrary: scope};
}
export async function saveBook(book) {
  const scope = localLibrary();
  if (!scope) throw new Error('No connected library');
  book.localLibrary ??= scope;
  if (book.localLibrary !== scope) throw new Error('Library changed');
  return useStore('readwrite', store => store.put(book));
}
export const removeBook=id=>useStore('readwrite',s=>s.delete(id));
