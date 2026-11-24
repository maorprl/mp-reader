const origins = new Set(['https://mp-reader.vercel.app', 'https://reader.mpreader.invalid']);
const fields = new Set(['location', 'bookmarks', 'highlights']);
const bookPattern = /^[a-f0-9]{64}$/;
const chunkSize = 384000;
const maxBookSize = 25 * 1024 * 1024;

async function catalog(request, db, library, path, reply) {
  const {book, index, data, title, size} = await request.json();
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS sync_catalog (library TEXT, book TEXT, title TEXT, size INTEGER, PRIMARY KEY(library,book))'),
    db.prepare('CREATE TABLE IF NOT EXISTS sync_chunks (library TEXT, book TEXT, idx INTEGER, data TEXT, PRIMARY KEY(library,book,idx))'),
  ]);
  if (path === '/catalog') {
    const {results} = await db.prepare('SELECT book,title,size FROM sync_catalog WHERE library=?').bind(library).all();
    return reply({books: results});
  }
  if (typeof book !== 'string' || !bookPattern.test(book)) return reply({error:'book'},400);
  if (path === '/publish') {
    if (typeof title !== 'string' || !title.trim() || title.length > 300 ||
        !Number.isSafeInteger(size) || size < 1 || size > maxBookSize) return reply({error:'metadata'},400);
    const count = Math.ceil(size / chunkSize);
    const result = await db.prepare(
      'INSERT OR IGNORE INTO sync_catalog SELECT ?,?,?,? WHERE (SELECT count(*) FROM sync_chunks WHERE library=? AND book=? AND idx>=0 AND idx<? AND length(data)=CASE WHEN idx=? THEN ? ELSE ? END)=?'
    ).bind(library,book,title,size,library,book,count,count-1,4*Math.ceil((size-(count-1)*chunkSize)/3),chunkSize*4/3,count).run();
    return result.meta.changes || await db.prepare('SELECT 1 FROM sync_catalog WHERE library=? AND book=?').bind(library,book).first()
      ? reply({ok:true}) : reply({error:'incomplete'},409);
  }
  if (!Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(maxBookSize/chunkSize)) return reply({error:'index'},400);
  if (path === '/upload') {
    if (typeof data !== 'string' || !data.length || data.length > chunkSize*4/3 ||
        data.length % 4 || /[^A-Za-z0-9+/=]/.test(data)) return reply({error:'chunk'},400);
    await db.prepare('INSERT OR IGNORE INTO sync_chunks SELECT ?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM sync_catalog WHERE library=? AND book=?)')
      .bind(library,book,index,data,library,book).run();
    return reply({ok:true});
  }
  const row = await db.prepare('SELECT c.data FROM sync_chunks c JOIN sync_catalog b USING(library,book) WHERE c.library=? AND c.book=? AND c.idx=?').bind(library,book,index).first();
  return row ? reply(row) : reply({error:'missing'},404);
}

const secretPattern = /^[a-f0-9]{32}$/;

function secret() {
  return crypto.randomUUID().replaceAll('-', '');
}

async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function initialize(db) {
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS sync_devices (token TEXT PRIMARY KEY, library TEXT NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS sync_fields (library TEXT NOT NULL, book TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY(library, book, field))'),
  ]);
}

function ensureRecoveryTable(db) {
  return db.prepare('CREATE TABLE IF NOT EXISTS sync_recovery (library TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL)').run();
}

function sameDigest(left, right) {
  let mismatch = 0;
  for (let index = 0; index < left.length; index++) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function configuredLibrary(db, selected) {
  await db.prepare('CREATE TABLE IF NOT EXISTS sync_catalog (library TEXT, book TEXT, title TEXT, size INTEGER, PRIMARY KEY(library,book))').run();
  const libraries = 'SELECT library FROM sync_devices UNION SELECT library FROM sync_fields UNION SELECT library FROM sync_catalog UNION SELECT library FROM sync_recovery';
  if (selected) {
    return db.prepare('SELECT library FROM (' + libraries + ') WHERE library=?').bind(selected).first();
  }
  await db.prepare('CREATE TABLE IF NOT EXISTS sync_primary_library (slot INTEGER PRIMARY KEY, library TEXT NOT NULL)').run();
  const primary = db.prepare('SELECT library FROM sync_primary_library WHERE slot=1');
  const saved = await primary.first();
  if (saved) return saved;

  const {results} = await db.prepare(
    'SELECT library FROM (SELECT library FROM sync_catalog UNION SELECT library FROM sync_fields UNION SELECT library FROM sync_recovery) LIMIT 2'
  ).all();
  if (results.length > 1) return null;
  const empty = results.length ? [] : (await db.prepare(libraries + ' LIMIT 2').all()).results;
  const library = results[0]?.library ?? (empty.length === 1 ? empty[0].library : secret());
  await db.prepare('INSERT OR IGNORE INTO sync_primary_library VALUES (1,?)').bind(library).run();
  return primary.first();
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const headers = {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      Vary: 'Origin',
    };
    if (origins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (value, status = 200) => Response.json(value, {status, headers});
    if (origin && !origins.has(origin)) return reply({error: 'origin'}, 403);
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers});
    const path = new URL(request.url).pathname;
    try {
      if (request.method === 'GET' && path === '/') {
        const result = await env.DB.prepare('SELECT 1 AS ok').first();
        return reply({databaseConnected: result.ok === 1, syncVersion: 8});
      }
      if (request.method !== 'POST') return reply({error: 'method'}, 405);

      const db = env.DB;
      if (path === '/recover') {
        const {code} = await request.json();
        if (typeof code !== 'string' || !code || code.length > 256) return reply({error:'code'},400);
        await initialize(db);
        await ensureRecoveryTable(db);
        const hash = await digest(code);
        let entry;
        const configured = env.LIBRARY_PASSWORD?.trim().replaceAll('-', '').toLowerCase();
        if (configured && sameDigest(hash, await digest(configured))) {
          entry = await configuredLibrary(db, env.LIBRARY_ID);
          if (!entry) return reply({error:'library selection required'},409);
        } else if (secretPattern.test(code)) {
          entry = await db.prepare('SELECT library FROM sync_recovery WHERE code=?').bind(hash).first();
        }
        if (!entry) return reply({error:'invalid recovery code'},404);
        const token = secret();
        await db.prepare('INSERT INTO sync_devices VALUES (?,?)').bind(await digest(token),entry.library).run();
        return reply({token},201);
      }
      const token = request.headers.get('Authorization')?.replace(/^Bearer /, '');
      if (!token || !secretPattern.test(token)) return reply({error: 'auth'}, 401);
      const device = await db.prepare('SELECT library FROM sync_devices WHERE token = ?').bind(await digest(token)).first();
      if (!device) return reply({error: 'auth'}, 401);
      const {library} = device;
      if (['/catalog', '/upload', '/publish', '/download'].includes(path)) {
        return await catalog(request, db, library, path, reply);
      }
      if (path !== '/book') return reply({error: 'route'}, 404);
      if (Number(request.headers.get('Content-Length')) > 500000) return reply({error: 'size'}, 413);
      const raw = await request.text();
      if (raw.length > 500000) return reply({error: 'size'}, 413);
      const {book, changes = {}} = JSON.parse(raw);
      if (typeof book !== 'string' || !/^[a-f0-9]{64}$/.test(book) ||
          !changes || typeof changes !== 'object' || Array.isArray(changes)) return reply({error: 'input'}, 400);

      const statements = [];
      for (const [field, entry] of Object.entries(changes)) {
        if (!fields.has(field) || !entry || !Object.hasOwn(entry, 'value') ||
            !Number.isSafeInteger(entry.base) || entry.base < 0) return reply({error: 'field'}, 400);
        statements.push(db.prepare(
          'INSERT INTO sync_fields SELECT ?, ?, ?, ?, 1 WHERE ? = 0 OR EXISTS (SELECT 1 FROM sync_fields WHERE library = ? AND book = ? AND field = ?) ' +
          'ON CONFLICT(library, book, field) DO UPDATE SET value = excluded.value, rev = sync_fields.rev + 1 WHERE sync_fields.rev = ?'
        ).bind(library, book, field, JSON.stringify(entry.value), entry.base, library, book, field, entry.base));
      }
      statements.push(db.prepare('SELECT field, value, rev FROM sync_fields WHERE library = ? AND book = ?').bind(library, book));
      const results = await db.batch(statements);
      return reply({fields: Object.fromEntries(results.pop().results.map(row => [
        row.field, {value: JSON.parse(row.value), rev: row.rev},
      ]))});
    } catch (error) {
      console.error(error instanceof Error ? error.name : 'SyncError');
      return reply({error: 'sync unavailable'}, 500);
    }
  },
};
