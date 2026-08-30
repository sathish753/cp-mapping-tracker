const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ---- default seed data (used only the very first time the app runs) ----
function seedData() {
  return {
    users: [
      { id: 'u1', username: 'admin', password: bcrypt.hashSync('admin123', 12), role: 'admin', displayName: 'Administrator' },
      { id: 'u2', username: 'om1', password: bcrypt.hashSync('om123', 12), role: 'om', displayName: 'OM User' },
      { id: 'u3', username: 'tl1', password: bcrypt.hashSync('tl123', 12), role: 'tl', displayName: 'TL User' }
    ],
    records: [],
    auditLog: [],
    nextSno: 1
  };
}

// ---- load / init ----
function load() {
  if (!fs.existsSync(DB_FILE)) {
    const initial = seedData();
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(DB_FILE, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('DB file corrupt, reinitializing with seed data.', e);
    const initial = seedData();
    fs.writeFileSync(DB_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
}

let state = load();

// simple write queue so concurrent requests never interleave writes
let writeChain = Promise.resolve();
function persist() {
  writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    fs.writeFile(DB_FILE, JSON.stringify(state, null, 2), (err) => {
      if (err) return reject(err);
      resolve();
    });
  }));
  return writeChain;
}

module.exports = {
  get state() { return state; },
  persist,
  genId(prefix) {
    return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
};
