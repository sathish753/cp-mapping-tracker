const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3001;

// don't advertise the framework to anyone probing the server
app.disable('x-powered-by');
// needed so `cookie.secure` works correctly if this ever runs behind a
// reverse proxy (nginx/Caddy) terminating HTTPS, per the README's deploy notes
app.set('trust proxy', 1);

app.use(express.json());

// baseline security headers (no new dependency — helmet isn't installable
// without npm registry access in some environments, so these are set by hand)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY'); // this app has destructive admin actions — never allow framing
  res.setHeader('Referrer-Policy', 'no-referrer');
  // fonts.googleapis.com/gstatic.com are the only third-party resources this
  // app loads (Google Fonts in index.html); 'unsafe-inline' on style-src is
  // needed because the UI uses inline style="" attributes throughout —
  // tightening that would mean refactoring every inline style into CSS
  // classes, which is out of scope here, but script-src stays locked to
  // 'self' since no inline/remote scripts are used.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self'; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src https://fonts.gstatic.com; " +
    "img-src 'self' data:; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none'"
  );
  next();
});

// Express 4 does NOT automatically catch a rejected promise thrown inside an
// async route handler — an unhandled rejection there can crash the whole
// process on a single bad request (e.g. a disk-write failure mid-save).
// Wrapping every async handler in this forwards any rejection to the error
// middleware below instead of taking the server down.
function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'cp-tracker-local-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ---------- simple in-memory login rate limiter ----------
// no new dependency (express-rate-limit isn't installable here) — a small
// sliding window per IP is enough to blunt naive brute-force/credential
// stuffing against /api/login. Not a substitute for a real WAF at scale.
const loginAttempts = new Map(); // ip -> [timestamps]
const LOGIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const LOGIN_MAX_ATTEMPTS = 10;
function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter(t => now - t < LOGIN_WINDOW_MS);
  if (attempts.length >= LOGIN_MAX_ATTEMPTS) {
    return res.status(429).json({ error: 'Too many login attempts. Please wait a few minutes and try again.' });
  }
  attempts.push(now);
  loginAttempts.set(ip, attempts);
  next();
}

// ---------- table field definitions ----------
const ALL_FIELDS = [
  'employeeName', 'employeeId', 'block', 'workstation', 'shift',
  'cpName', 'processName', 'clientName', 'tlName', 'omName'
];

// fields tracked specifically for the "interchange" dashboard
const TRACKED_FIELDS = ['cpName', 'employeeName', 'employeeId'];

// which fields each role may edit on an existing record
// OM: everything except Block, Workstation, OM Name, CP Name (those stay admin-only)
// TL: Employee Name, Employee ID, Process Name, Client Name
const EDIT_PERMISSIONS = {
  admin: ALL_FIELDS,
  om: ALL_FIELDS.filter(f => !['block', 'workstation', 'omName', 'cpName'].includes(f)),
  tl: ['employeeName', 'employeeId', 'processName', 'clientName']
};

// fields that must not collide with another record.
// Employee ID is globally unique (one person, one active seat).
// CP Name is unique *per shift* — the same physical CP can be reused across
// different shifts by a different employee/OM, but never twice in the same shift.
const UNIQUE_FIELDS = ['employeeId', 'cpName'];

function fieldLabel(f) {
  const labels = {
    employeeName: 'Employee Name', employeeId: 'Employee ID', block: 'Block',
    workstation: 'Workstation Number', shift: 'Shift', cpName: 'CP Name', processName: 'Process Name',
    clientName: 'Client Name', tlName: 'TL Name', omName: 'OM Name'
  };
  return labels[f] || f;
}

// checks employeeId / cpName aren't already live on another record.
// excludeId lets an update check against every *other* record.
// shiftContext scopes the CP Name check to a specific shift; ignored for employeeId.
function findDuplicate(field, value, excludeId, shiftContext) {
  if (!UNIQUE_FIELDS.includes(field)) return null;
  const v = (value || '').toString().trim().toLowerCase();
  if (!v) return null;

  if (field === 'cpName') {
    // scoped to shift: same CP name is fine on two records as long as their
    // Shift values differ (e.g. "Morning" vs "Night"). Records that both
    // leave Shift blank are treated as the same scope, so uniqueness stays
    // fully global for anyone not using the shift field at all.
    const shiftVal = (shiftContext || '').toString().trim().toLowerCase();
    return db.state.records.find(r => r.id !== excludeId
      && (r.cpName || '').toLowerCase() === v
      && (r.shift || '').toString().trim().toLowerCase() === shiftVal) || null;
  }

  return db.state.records.find(r => r.id !== excludeId && (r[field] || '').toLowerCase() === v) || null;
}

// a login "owns" a record when its Display Name matches the OM Name (for
// om role) or TL Name (for tl role) on that record, case/whitespace-insensitive.
// Admins own everything. Anyone without a matching role owns nothing.
function isOwner(record, user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const mine = (user.displayName || '').trim().toLowerCase();
  if (!mine) return false;
  if (user.role === 'om') return (record.omName || '').trim().toLowerCase() === mine;
  if (user.role === 'tl') return (record.tlName || '').trim().toLowerCase() === mine;
  return false;
}

// ---------- auth helpers ----------
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this' });
    }
    next();
  };
}

// parses a 'from'/'to' query value into epoch milliseconds, or null if
// blank/invalid. Accepts anything Date.parse understands — in practice the
// front end sends full ISO datetimes (from a <input type="datetime-local">
// converted to the person's local time), so "23 Aug, 5:30 PM" to "24 Aug,
// 5:30 AM" becomes an exact instant-to-instant range, not a calendar-day or
// recurring-session bucket.
function parseRangeBound(value) {
  const v = (value || '').toString().trim();
  if (!v) return null;
  const ms = Date.parse(v);
  return isNaN(ms) ? null : ms;
}

// ================= AUTH ROUTES =================
app.post('/api/login', loginRateLimit, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const user = db.state.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  // regenerate the session on every successful login so a session ID that
  // existed before authentication (possibly known to an attacker) can never
  // become a valid authenticated session — prevents session fixation
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: 'Could not start session' });
    req.session.user = { id: user.id, username: user.username, role: user.role, displayName: user.displayName };
    res.json({ user: req.session.user });
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', (req, res) => {
  res.json({ user: req.session.user || null });
});

// every record ID ever tied to a given Employee ID — live records plus any
// found through the audit log (snapshots / employeeId field changes) so it
// survives a record being deleted and recreated for the same person
function recordIdsForEmployeeId(employeeId) {
  const idLower = (employeeId || '').trim().toLowerCase();
  const ids = new Set();
  if (!idLower) return ids;

  db.state.records.forEach(r => {
    if ((r.employeeId || '').trim().toLowerCase() === idLower) ids.add(r.id);
  });

  db.state.auditLog.forEach(l => {
    const snapshotMatch = l.snapshot && (l.snapshot.employeeId || '').trim().toLowerCase() === idLower;
    const fieldChangeMatch = l.field === 'employeeId' &&
      ((l.oldValue || '').trim().toLowerCase() === idLower || (l.newValue || '').trim().toLowerCase() === idLower);
    if (snapshotMatch || fieldChangeMatch) ids.add(l.recordId);
  });

  return ids;
}

// how many times this employee's identity (Employee ID) has been written
// onto a DIFFERENT seat-record than the one before. A "move" here is done by
// typing the Employee Name/ID onto a new record and clearing it off the old
// one — NOT by editing Block/Workstation in place on a single record — so
// this tracks assignments of the Employee ID field across every record ID
// ever tied to it, using each assignment's snapshot to know which seat it
// landed on.
function moveHistoryForEmployeeId(employeeId) {
  const idLower = (employeeId || '').trim().toLowerCase();
  if (!idLower) return [];
  const ids = recordIdsForEmployeeId(employeeId);
  if (ids.size === 0) return [];

  // every time this Employee ID was written onto a record, oldest first.
  // The first one is just their starting seat; everything after is a move.
  const assignments = db.state.auditLog
    .filter(l => ids.has(l.recordId) && l.field === 'employeeId' && (l.newValue || '').trim().toLowerCase() === idLower)
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const seatOf = log => {
    const s = log.snapshot || {};
    return `${s.block || '—'} / ${s.workstation || '—'}`;
  };

  const moves = [];
  for (let i = 1; i < assignments.length; i++) {
    moves.push({
      sno: assignments[i].sno,
      oldValue: seatOf(assignments[i - 1]),
      newValue: seatOf(assignments[i]),
      changedBy: assignments[i].changedBy,
      changedByRole: assignments[i].changedByRole,
      timestamp: assignments[i].timestamp
    });
  }
  return moves;
}

function moveCountForEmployeeId(employeeId) {
  return moveHistoryForEmployeeId(employeeId).length;
}

// ================= RECORDS =================

// list all records (all logged-in roles can view everything), each annotated
// with how many times that employee has ever moved to a different seat
app.get('/api/records', requireAuth, (req, res) => {
  const records = db.state.records.map(r => ({
    ...r,
    moveCount: r.employeeId ? moveCountForEmployeeId(r.employeeId) : 0
  }));
  res.json({ records, editableFields: EDIT_PERMISSIONS[req.session.user.role] });
});

// create a record - admin only
app.post('/api/records', requireRole('admin'), asyncRoute(async (req, res) => {
  const body = req.body || {};
  const shiftVal = (body.shift || '').toString().trim();

  for (const field of UNIQUE_FIELDS) {
    const dupe = findDuplicate(field, body[field], null, field === 'cpName' ? shiftVal : undefined);
    if (dupe) {
      const shiftNote = field === 'cpName' && shiftVal ? ` in ${shiftVal}` : '';
      return res.status(409).json({
        error: `${fieldLabel(field)} "${(body[field] || '').trim()}" is already mapped to S.No ${dupe.sno}${shiftNote} (Workstation ${dupe.workstation || '—'}). Edit that record instead of creating a duplicate.`
      });
    }
  }

  const record = { id: db.genId('rec'), sno: db.state.nextSno++ };
  ALL_FIELDS.forEach(f => { record[f] = (body[f] || '').toString().trim(); });
  record.createdAt = new Date().toISOString();
  record.updatedAt = record.createdAt;
  db.state.records.push(record);

  // log the initial assignment so a brand-new record shows up in the audit
  // trail and the employee CP-swap history immediately, not only on later edits
  const snapshot = {};
  ALL_FIELDS.forEach(f => { snapshot[f] = record[f]; });

  TRACKED_FIELDS.forEach(field => {
    if (!record[field]) return; // nothing to log if it was left blank
    db.state.auditLog.push({
      id: db.genId('log'),
      recordId: record.id,
      sno: record.sno,
      field,
      fieldLabel: fieldLabel(field),
      tracked: true,
      oldValue: '',
      newValue: record[field],
      snapshot,
      changedBy: req.session.user.username,
      changedByRole: req.session.user.role,
      timestamp: record.createdAt
    });
  });

  if (record.block || record.workstation) {
    db.state.auditLog.push({
      id: db.genId('log'),
      recordId: record.id,
      sno: record.sno,
      field: 'seat',
      fieldLabel: 'Block / Workstation',
      tracked: true,
      oldValue: '— / —',
      newValue: `${record.block || '—'} / ${record.workstation || '—'}`,
      employeeName: record.employeeName,
      employeeId: record.employeeId,
      snapshot,
      changedBy: req.session.user.username,
      changedByRole: req.session.user.role,
      timestamp: record.createdAt
    });
  }

  // a brand-new record that already carries a full employee mapping counts
  // as one mapping event too, same as later filling in a previously blank
  // one — both are "this seat became mapped" moments. (If the 'seat' entry
  // above also fired at this same timestamp, dateWiseTl event counting
  // dedupes them into a single event, so this never double-counts.)
  if (isMapped(record)) {
    db.state.auditLog.push({
      id: db.genId('log'),
      recordId: record.id,
      sno: record.sno,
      field: 'mapped',
      fieldLabel: 'Mapped',
      tracked: true,
      oldValue: '',
      newValue: `${record.employeeName} / ${record.employeeId}`,
      snapshot,
      changedBy: req.session.user.username,
      changedByRole: req.session.user.role,
      timestamp: record.createdAt
    });
  }

  await db.persist();
  res.status(201).json({ record });
}));

// update a record - field-level permission enforced server side
app.put('/api/records/:id', requireAuth, asyncRoute(async (req, res) => {
  const record = db.state.records.find(r => r.id === req.params.id);
  if (!record) return res.status(404).json({ error: 'Record not found' });

  const role = req.session.user.role;
  if (role !== 'admin' && !isOwner(record, req.session.user)) {
    return res.status(403).json({ error: 'You can only edit records assigned to you.' });
  }
  const allowedFields = EDIT_PERMISSIONS[role] || [];
  const body = req.body || {};
  const changes = [];
  const wasMapped = isMapped(record); // captured before any mutation below
  const priorEmployeeId = record.employeeId;

  // validate uniqueness first, before mutating anything, so a bad request
  // never leaves the record half-updated.
  // Employee ID stays a simple global check. CP Name is checked against the
  // *resulting* Shift value, since editing Shift alone can create a collision
  // even if CP Name itself isn't part of this request.
  if (body.employeeId !== undefined && allowedFields.includes('employeeId')) {
    const newEmployeeId = (body.employeeId || '').toString().trim();
    if (newEmployeeId !== (record.employeeId || '')) {
      const dupe = findDuplicate('employeeId', newEmployeeId, record.id);
      if (dupe) {
        return res.status(409).json({
          error: `Employee ID "${newEmployeeId}" is already mapped to S.No ${dupe.sno} (Workstation ${dupe.workstation || '—'}). Free it from that record first.`
        });
      }
    }
  }

  const cpNameTouched = body.cpName !== undefined && allowedFields.includes('cpName');
  const shiftTouched = body.shift !== undefined && allowedFields.includes('shift');
  if (cpNameTouched || shiftTouched) {
    const finalCpName = cpNameTouched ? (body.cpName || '').toString().trim() : (record.cpName || '');
    const finalShift = shiftTouched ? (body.shift || '').toString().trim() : (record.shift || '');
    const changedFromCurrent = finalCpName !== (record.cpName || '') || finalShift !== (record.shift || '');
    if (finalCpName && changedFromCurrent) {
      const dupe = findDuplicate('cpName', finalCpName, record.id, finalShift);
      if (dupe) {
        const shiftNote = finalShift ? ` in ${finalShift}` : '';
        return res.status(409).json({
          error: `CP Name "${finalCpName}" is already mapped to S.No ${dupe.sno}${shiftNote} (Workstation ${dupe.workstation || '—'}). Free it from that record first.`
        });
      }
    }
  }

  Object.keys(body).forEach(field => {
    if (!ALL_FIELDS.includes(field)) return; // ignore unknown fields
    if (!allowedFields.includes(field)) return; // silently ignore fields this role can't touch
    const newValue = (body[field] || '').toString().trim();
    const oldValue = record[field] || '';
    if (newValue !== oldValue) {
      changes.push({ field, oldValue, newValue });
      record[field] = newValue;
    }
  });

  if (changes.length === 0) {
    return res.json({ record, changed: false });
  }

  record.updatedAt = new Date().toISOString();
  const now = record.updatedAt; // single timestamp reused below so entries from this one save share it

  // full 10-field snapshot of the record right after this update — lets the
  // dashboard show complete context around any single field change
  const snapshot = {};
  ALL_FIELDS.forEach(f => { snapshot[f] = record[f]; });

  changes.forEach(c => {
    if (c.field === 'block' || c.field === 'workstation') return; // captured together in the combined "seat" entry below
    db.state.auditLog.push({
      id: db.genId('log'),
      recordId: record.id,
      sno: record.sno,
      field: c.field,
      fieldLabel: fieldLabel(c.field),
      tracked: TRACKED_FIELDS.includes(c.field),
      oldValue: c.oldValue,
      newValue: c.newValue,
      snapshot,
      changedBy: req.session.user.username,
      changedByRole: role,
      timestamp: now
    });
  });

  // combined Block/Workstation reassignment entry — the audit trail tracks
  // "from block,workstation to block,workstation" as a single move, not two
  // separate field diffs
  const blockChange = changes.find(c => c.field === 'block');
  const wsChange = changes.find(c => c.field === 'workstation');
  if (blockChange || wsChange) {
    const oldBlock = blockChange ? blockChange.oldValue : record.block;
    const oldWorkstation = wsChange ? wsChange.oldValue : record.workstation;
    const newBlock = record.block;
    const newWorkstation = record.workstation;
    db.state.auditLog.push({
      id: db.genId('log'),
      recordId: record.id,
      sno: record.sno,
      field: 'seat',
      fieldLabel: 'Block / Workstation',
      tracked: true,
      oldValue: `${oldBlock || '—'} / ${oldWorkstation || '—'}`,
      newValue: `${newBlock || '—'} / ${newWorkstation || '—'}`,
      employeeName: snapshot.employeeName,
      employeeId: snapshot.employeeId,
      snapshot,
      changedBy: req.session.user.username,
      changedByRole: role,
      timestamp: now
    });
  }

  // this edit turned a previously-blank seat into a mapped one (Employee
  // Name + ID both now filled in, where at least one was blank before) —
  // counts as one mapping event, same as a seat move. If a seat move also
  // happened in this same save, both entries share `now`, so the date-wise
  // event counter (which dedupes by recordId+timestamp) still counts this
  // save as a single event rather than two.
  if (!wasMapped && isMapped(record)) {
    db.state.auditLog.push({
      id: db.genId('log'),
      recordId: record.id,
      sno: record.sno,
      field: 'mapped',
      fieldLabel: 'Mapped',
      tracked: true,
      oldValue: '',
      newValue: `${record.employeeName} / ${record.employeeId}`,
      snapshot,
      changedBy: req.session.user.username,
      changedByRole: role,
      timestamp: now
    });
  }

  // Employee ID itself was swapped out for a different one while the seat
  // stayed mapped the whole time (not a blank<->filled transition — those
  // are handled above). Employee ID is the unique key here, so changing it
  // is effectively assigning a different mapping to this seat, and counts
  // as a mapping event even if Employee Name wasn't touched. A plain name
  // correction with the SAME Employee ID still does not trigger this (or
  // any other entry), so it stays uncounted as intended.
  if (wasMapped && isMapped(record) && priorEmployeeId !== record.employeeId) {
    db.state.auditLog.push({
      id: db.genId('log'),
      recordId: record.id,
      sno: record.sno,
      field: 'idChanged',
      fieldLabel: 'Employee ID changed',
      tracked: true,
      oldValue: priorEmployeeId,
      newValue: record.employeeId,
      snapshot,
      changedBy: req.session.user.username,
      changedByRole: role,
      timestamp: now
    });
  }

  await db.persist();
  res.json({ record, changed: true });
}));

// delete a record - admin only
app.delete('/api/records/:id', requireRole('admin'), asyncRoute(async (req, res) => {
  const idx = db.state.records.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Record not found' });
  const [removed] = db.state.records.splice(idx, 1);
  db.state.auditLog.push({
    id: db.genId('log'),
    recordId: removed.id,
    sno: removed.sno,
    field: '__deleted__',
    fieldLabel: 'Record Deleted',
    tracked: false,
    oldValue: `${removed.employeeName} / ${removed.cpName}`,
    newValue: '',
    changedBy: req.session.user.username,
    changedByRole: 'admin',
    timestamp: new Date().toISOString()
  });
  await db.persist();
  res.json({ ok: true });
}));

// ================= AUDIT / DASHBOARD =================
app.get('/api/audit', requireRole('admin'), (req, res) => {
  const { field, sno, limit } = req.query;
  let logs = [...db.state.auditLog].reverse();
  if (field) logs = logs.filter(l => l.field === field);
  if (sno) logs = logs.filter(l => String(l.sno) === String(sno));
  if (limit) logs = logs.slice(0, parseInt(limit, 10));
  res.json({ logs });
});

// search the CP-swap history for a specific employee (by name or employee ID).
// Returns every record that ever matched the query, each with its full
// 10-field current state plus a chronological CP-name interchange trail
// (every entry carrying the complete 10-field snapshot from that moment).
app.get('/api/audit/employee', requireRole('admin'), (req, res) => {
  const q = (req.query.query || '').toString().trim().toLowerCase();
  if (!q) return res.json({ matches: [] });

  // 1) records whose CURRENT name/ID matches
  const matchedIds = new Set(
    db.state.records
      .filter(r => (r.employeeName || '').toLowerCase().includes(q) || (r.employeeId || '').toLowerCase().includes(q))
      .map(r => r.id)
  );

  // 2) also catch records where the name/ID matched at some point in the past
  // (e.g. searching an old ID before it was corrected, or a seat that has since
  // been reassigned to someone else)
  db.state.auditLog.forEach(l => {
    if ((l.field === 'employeeName' || l.field === 'employeeId')) {
      if ((l.oldValue || '').toLowerCase().includes(q) || (l.newValue || '').toLowerCase().includes(q)) {
        matchedIds.add(l.recordId);
      }
    }
  });

  const matches = [...matchedIds].map(recordId => {
    const currentRecord = db.state.records.find(r => r.id === recordId) || null;
    const recordLogs = db.state.auditLog
      .filter(l => l.recordId === recordId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const cpHistory = recordLogs
      .filter(l => l.field === 'cpName')
      .map(l => ({
        oldValue: l.oldValue,
        newValue: l.newValue,
        changedBy: l.changedBy,
        changedByRole: l.changedByRole,
        timestamp: l.timestamp,
        snapshot: l.snapshot || null
      }));

    const fullHistory = recordLogs.map(l => ({
      field: l.field,
      fieldLabel: l.fieldLabel,
      oldValue: l.oldValue,
      newValue: l.newValue,
      changedBy: l.changedBy,
      changedByRole: l.changedByRole,
      timestamp: l.timestamp,
      snapshot: l.snapshot || null
    }));

    return {
      recordId,
      sno: currentRecord ? currentRecord.sno : (recordLogs[0] ? recordLogs[0].sno : null),
      deleted: !currentRecord,
      currentRecord,
      cpHistory,
      fullHistory
    };
  }).sort((a, b) => (a.sno || 0) - (b.sno || 0));

  res.json({ matches });
});

// a record counts as "mapped" only when BOTH Employee Name and Employee ID
// are filled in — a workstation/CP with either left blank is an open slot
function isMapped(r) {
  return !!(r.employeeName && r.employeeName.trim()) && !!(r.employeeId && r.employeeId.trim());
}

// how many times a given record has ever been mapped to a CP — counts the
// initial assignment plus every later swap, from the audit log
function cpMappingCount(recordId) {
  return db.state.auditLog.filter(l => l.field === 'cpName' && l.recordId === recordId).length;
}

// same as above, but scoped to the current calendar month only
function cpMappingCountThisMonth(recordId) {
  const ym = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  return db.state.auditLog.filter(l => l.field === 'cpName' && l.recordId === recordId && l.timestamp.slice(0, 7) === ym).length;
}

// summary stats (total / mapped / unmapped / breakdown by shift & block)
// for an arbitrary slice of records — shared by the personal allocation view
function buildAllocationSummary(records) {
  const mapped = records.filter(isMapped).length;
  const byShift = {};
  const byBlock = {};
  records.forEach(r => {
    const sh = (r.shift || '').trim() || 'Unspecified';
    byShift[sh] = (byShift[sh] || 0) + 1;
    const bl = (r.block || '').trim() || 'Unspecified';
    byBlock[bl] = (byBlock[bl] || 0) + 1;
  });
  return {
    total: records.length,
    mapped,
    unmapped: records.length - mapped,
    byShift: Object.entries(byShift).map(([shift, count]) => ({ shift, count })).sort((a, b) => b.count - a.count),
    byBlock: Object.entries(byBlock).map(([block, count]) => ({ block, count })).sort((a, b) => b.count - a.count)
  };
}

// every login's personal dashboard: the workstations currently allocated to
// them (OM Name / TL Name matching their Display Name), or everything for admin
app.get('/api/my-allocations', requireAuth, (req, res) => {
  const user = req.session.user;
  const mine = user.role === 'admin' ? db.state.records : db.state.records.filter(r => isOwner(r, user));
  res.json({
    scopeName: user.role === 'admin' ? null : user.displayName,
    records: mine,
    summary: buildAllocationSummary(mine)
  });
});

// overall mapped vs unmapped counts, plus the list of OM names and employees
// currently in use (for the dashboard's select dropdowns)
app.get('/api/dashboard/mapping', requireRole('admin'), (req, res) => {
  const records = db.state.records;
  const mapped = records.filter(isMapped).length;
  const unmapped = records.length - mapped;

  const omNames = [...new Set(
    records.map(r => (r.omName || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const tlNames = [...new Set(
    records.map(r => (r.tlName || '').trim()).filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));

  const seenEmployees = new Map();
  records.filter(isMapped).forEach(r => {
    const key = r.employeeId.trim().toLowerCase();
    if (!seenEmployees.has(key)) seenEmployees.set(key, { employeeId: r.employeeId, employeeName: r.employeeName });
  });
  const employees = [...seenEmployees.values()].sort((a, b) => a.employeeName.localeCompare(b.employeeName));

  res.json({ overall: { mapped, unmapped, total: records.length }, omNames, tlNames, employees });
});

// pulls real "mapping-activity events" out of the audit log: a seat move
// (Block and/or Workstation reassigned), a seat going from unmapped to
// mapped, or the Employee ID on an already-mapped seat being swapped for a
// different one (ID is the unique key, so that's a real reassignment even
// if the seat itself didn't move). Each is logged as a dedicated entry
// ('seat' / 'mapped' / 'idChanged') at the moment it happens, carrying a
// full snapshot of the record at that instant. A pure Employee Name
// correction with the same Employee ID never produces any of these, so it's
// correctly left out — and clearing a mapping back to blank is likewise not
// counted here (the individual Employee Name / Employee ID edits from that
// clear are still logged in the audit trail as normal field changes, just
// not rolled into this mapping-event count). Entries sharing the same
// recordId+timestamp came from one save (e.g. a seat move that
// simultaneously swapped in a different Employee ID) and are deduped down
// to a single event so one save never counts as more than one.
function extractMappingEvents() {
  const seen = new Set();
  const events = [];
  const MAPPING_EVENT_FIELDS = new Set(['seat', 'mapped', 'idChanged']);
  db.state.auditLog.forEach(l => {
    if (!MAPPING_EVENT_FIELDS.has(l.field)) return;
    const key = l.recordId + '|' + l.timestamp;
    if (seen.has(key)) return;
    seen.add(key);
    const snap = l.snapshot || {};
    events.push({
      timestamp: l.timestamp,
      date: (l.timestamp || '').slice(0, 10) || 'Unknown',
      om: (snap.omName || '').trim() || 'Unassigned',
      tl: (snap.tlName || '').trim() || 'Unassigned'
    });
  });
  return events;
}

// groups mapping events by the calendar date they happened on and, within
// each date, by TL Name — used to show "how many mappings landed on each
// date, split out by which TL they belong to" on the OM/TL detail
// dashboards. Dates come back newest-first; the TL list (sorted, stable) is
// returned separately so the UI can assign each TL a consistent colour
// across the chart, legend and table.
function dateWiseTlBreakdown(events) {
  const byDate = new Map(); // date -> Map(tlName -> count)
  const tlSet = new Set();

  events.forEach(e => {
    tlSet.add(e.tl);
    if (!byDate.has(e.date)) byDate.set(e.date, new Map());
    const tlMap = byDate.get(e.date);
    tlMap.set(e.tl, (tlMap.get(e.tl) || 0) + 1);
  });

  const tlNames = [...tlSet].sort((a, b) => {
    if (a === 'Unassigned') return 1;
    if (b === 'Unassigned') return -1;
    return a.localeCompare(b);
  });

  const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a)); // newest first
  const dateWise = dates.map(date => {
    const tlMap = byDate.get(date);
    const tls = tlNames
      .filter(tl => tlMap.has(tl))
      .map(tl => ({ tlName: tl, count: tlMap.get(tl) }));
    const total = tls.reduce((s, t) => s + t.count, 0);
    return { date, tls, total };
  });

  return { dateWise, tlNames };
}

// natural sort for Block names so "A, A1, A2, A10, B, D1" order the way a
// person would expect, instead of pure string order putting "A10" before "A2"
function naturalBlockCompare(a, b) {
  const parse = s => {
    const m = (s || '').match(/^([^\d]*)(\d*)$/);
    return { prefix: (m ? m[1] : s || '').toLowerCase(), num: m && m[2] ? parseInt(m[2], 10) : -1 };
  };
  const pa = parse(a), pb = parse(b);
  if (pa.prefix !== pb.prefix) return pa.prefix.localeCompare(pb.prefix);
  return pa.num - pb.num;
}

// builds the read-only "Quick View" report: every OM, each OM's TLs, and
// within each TL every Block that has at least one record, with how many of
// that block's records are currently mapped vs not mapped. Recomputed fresh
// from the live records on every request, so it always reflects the latest
// state — nothing here is stored or editable.
function buildQuickView() {
  const records = db.state.records;
  const omMap = new Map(); // om -> Map(tl -> Map(block -> {mapped, notMapped}))

  records.forEach(r => {
    const om = (r.omName || '').trim() || 'Unassigned';
    const tl = (r.tlName || '').trim() || 'Unassigned';
    const block = (r.block || '').trim() || 'Unassigned';

    if (!omMap.has(om)) omMap.set(om, new Map());
    const tlMap = omMap.get(om);
    if (!tlMap.has(tl)) tlMap.set(tl, new Map());
    const blockMap = tlMap.get(tl);
    if (!blockMap.has(block)) blockMap.set(block, { mapped: 0, notMapped: 0 });

    const counts = blockMap.get(block);
    if (isMapped(r)) counts.mapped++; else counts.notMapped++;
  });

  const omNames = [...omMap.keys()].sort((a, b) => a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b));

  return omNames.map(om => {
    const tlMap = omMap.get(om);
    const tlNames = [...tlMap.keys()].sort((a, b) => a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b));
    const tls = tlNames.map(tl => {
      const blockMap = tlMap.get(tl);
      const blockNames = [...blockMap.keys()].sort(naturalBlockCompare);
      const blocks = blockNames.map(block => {
        const c = blockMap.get(block);
        return { block, mapped: c.mapped, notMapped: c.notMapped };
      });
      return { tlName: tl, blocks };
    });
    return { omName: om, tls };
  });
}

// read-only snapshot for the Quick View panel — admin only, GET, no writes.
app.get('/api/dashboard/quick-view', requireRole('admin'), (req, res) => {
  res.json({ generatedAt: new Date().toISOString(), oms: buildQuickView() });
});


// record lists so the admin can see exactly who/which seats are unmapped —
// plus, per mapped employee, how many times they've ever been mapped to a CP
// (all-time) and how many of those happened in the current calendar month,
// so the two can be shown separately per employee name
app.get('/api/dashboard/om-mapping', requireRole('admin'), (req, res) => {
  const om = (req.query.om || '').toString().trim();
  if (!om) return res.status(400).json({ error: 'om is required' });

  const omRecords = db.state.records.filter(r => (r.omName || '').trim().toLowerCase() === om.toLowerCase());
  const mappedRecords = omRecords.filter(isMapped);
  const unmappedRecords = omRecords.filter(r => !isMapped(r));

  const employeeCounts = mappedRecords
    .map(r => ({
      employeeName: r.employeeName,
      employeeId: r.employeeId,
      sno: r.sno,
      countAllTime: cpMappingCount(r.id),
      countThisMonth: cpMappingCountThisMonth(r.id)
    }))
    .sort((a, b) => b.countAllTime - a.countAllTime || a.employeeName.localeCompare(b.employeeName));

  const totals = employeeCounts.reduce((acc, e) => {
    acc.allTime += e.countAllTime;
    acc.thisMonth += e.countThisMonth;
    return acc;
  }, { allTime: 0, thisMonth: 0 });

  // optional exact date+time range filter — 'from'/'to' are full datetimes
  // (e.g. an ISO string like "2026-08-23T17:30"), so "23 Aug 5:30 PM to
  // 24 Aug 5:30 AM" filters to that exact instant-to-instant window rather
  // than a calendar day
  const fromMs = parseRangeBound(req.query.from);
  const toMs = parseRangeBound(req.query.to);
  let omEvents = extractMappingEvents().filter(e => e.om.toLowerCase() === om.toLowerCase());
  if (fromMs !== null) omEvents = omEvents.filter(e => Date.parse(e.timestamp) >= fromMs);
  if (toMs !== null) omEvents = omEvents.filter(e => Date.parse(e.timestamp) <= toMs);
  const { dateWise, tlNames } = dateWiseTlBreakdown(omEvents);

  res.json({
    om,
    mapped: mappedRecords.length,
    unmapped: unmappedRecords.length,
    total: omRecords.length,
    mappedRecords,
    unmappedRecords,
    employeeCounts,
    totals,
    dateWiseTl: dateWise,
    tlNames
  });
});

// same as above, scoped to one specific TL instead of OM
app.get('/api/dashboard/tl-mapping', requireRole('admin'), (req, res) => {
  const tl = (req.query.tl || '').toString().trim();
  if (!tl) return res.status(400).json({ error: 'tl is required' });

  const tlRecords = db.state.records.filter(r => (r.tlName || '').trim().toLowerCase() === tl.toLowerCase());
  const mappedRecords = tlRecords.filter(isMapped);
  const unmappedRecords = tlRecords.filter(r => !isMapped(r));

  const employeeCounts = mappedRecords
    .map(r => ({
      employeeName: r.employeeName,
      employeeId: r.employeeId,
      sno: r.sno,
      countAllTime: cpMappingCount(r.id),
      countThisMonth: cpMappingCountThisMonth(r.id)
    }))
    .sort((a, b) => b.countAllTime - a.countAllTime || a.employeeName.localeCompare(b.employeeName));

  const totals = employeeCounts.reduce((acc, e) => {
    acc.allTime += e.countAllTime;
    acc.thisMonth += e.countThisMonth;
    return acc;
  }, { allTime: 0, thisMonth: 0 });

  res.json({
    tl,
    mapped: mappedRecords.length,
    unmapped: unmappedRecords.length,
    total: tlRecords.length,
    mappedRecords,
    unmappedRecords,
    employeeCounts,
    totals
  });
});

// how many times ONE specific employee has ever moved to a different seat
// (Block / Workstation), chosen from the "employees" dropdown above. An
// employee can pass through more than one record over time (e.g. a record
// gets deleted and a fresh one created for the same person) — so this pulls
// together EVERY record ID that has ever carried this Employee ID, live or
// since-deleted, using both the current records list and the audit log's
// snapshots, then counts seat-move entries across all of them combined.
app.get('/api/dashboard/employee-mapping', requireRole('admin'), (req, res) => {
  const employeeId = (req.query.employeeId || '').toString().trim();
  if (!employeeId) return res.status(400).json({ error: 'employeeId is required' });

  const recordIds = recordIdsForEmployeeId(employeeId);
  if (recordIds.size === 0) return res.json({ employeeId, employeeName: '', count: 0, history: [] });

  let employeeName = '';
  db.state.records.forEach(r => { if (recordIds.has(r.id) && !employeeName) employeeName = r.employeeName; });
  if (!employeeName) {
    const snap = db.state.auditLog.find(l => recordIds.has(l.recordId) && l.snapshot && l.snapshot.employeeName);
    if (snap) employeeName = snap.snapshot.employeeName;
  }

  const history = moveHistoryForEmployeeId(employeeId);

  res.json({ employeeId, employeeName, count: history.length, history });
});

app.get('/api/dashboard/summary', requireRole('admin'), (req, res) => {
  const logs = db.state.auditLog;

  // optional exact date+time range filter — 'from'/'to' are full datetimes,
  // e.g. "23 Aug 5:30 PM" to "24 Aug 5:30 AM" — filtered as an exact
  // instant-to-instant window. When provided, the tracked-change count and
  // the "interchanges by field" breakdown below are scoped to that window;
  // "changes today" and the OM leaderboard always stay live/current.
  const fromMs = parseRangeBound(req.query.from);
  const toMs = parseRangeBound(req.query.to);
  const rangeActive = fromMs !== null || toMs !== null;
  const rangedLogs = rangeActive
    ? logs.filter(l => {
        const t = Date.parse(l.timestamp);
        if (fromMs !== null && t < fromMs) return false;
        if (toMs !== null && t > toMs) return false;
        return true;
      })
    : logs;

  const trackedLogs = rangedLogs.filter(l => l.tracked);
  const counts = { cpName: 0, employeeName: 0, employeeId: 0, seat: 0 };
  trackedLogs.forEach(l => { if (counts[l.field] !== undefined) counts[l.field]++; });

  const today = new Date().toISOString().slice(0, 10);
  const changesToday = logs.filter(l => (l.timestamp || '').slice(0, 10) === today).length;

  // top 5 OMs by how many CP / workstation records currently sit under them
  const omCounts = {};
  db.state.records.forEach(r => {
    const om = (r.omName || '').trim();
    if (!om) return;
    omCounts[om] = (omCounts[om] || 0) + 1;
  });
  const topOMs = Object.entries(omCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([omName, count]) => ({ omName, count }));

  res.json({
    totalRecords: db.state.records.length,
    totalChanges: logs.length,
    trackedChanges: trackedLogs.length,
    changesToday,
    countsByField: counts,
    topOMs,
    rangeActive
  });
});

// ================= USER MANAGEMENT (admin only) =================
app.get('/api/users', requireRole('admin'), (req, res) => {
  res.json({ users: db.state.users.map(u => ({ id: u.id, username: u.username, role: u.role, displayName: u.displayName })) });
});

app.post('/api/users', requireRole('admin'), asyncRoute(async (req, res) => {
  const { username, password, role, displayName } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: 'username, password and role are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!['admin', 'om', 'tl'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (db.state.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  const user = { id: db.genId('u'), username, password: bcrypt.hashSync(password, 12), role, displayName: displayName || username };
  db.state.users.push(user);
  await db.persist();
  res.status(201).json({ user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName } });
}));

app.delete('/api/users/:id', requireRole('admin'), asyncRoute(async (req, res) => {
  if (req.session.user.id === req.params.id) return res.status(400).json({ error: "You can't delete your own account while logged in" });
  const idx = db.state.users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'User not found' });
  db.state.users.splice(idx, 1);
  await db.persist();
  res.json({ ok: true });
}));

// fallback to index.html for the SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// centralized error handler — must be registered last, after every route.
// Catches anything asyncRoute() forwards, plus any synchronous throw Express
// catches on its own. Always logs full detail server-side but only ever
// sends a generic message to the client, regardless of NODE_ENV — this app
// never relied on NODE_ENV=production being set for that, since nothing
// enforces it actually gets set at deploy time.
app.use((err, req, res, next) => {
  console.error('Unhandled error on', req.method, req.path, err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

// last-resort safety nets: log and keep the process alive rather than
// crashing the whole server over one bad request or a stray rejected
// promise that wasn't inside an Express route at all.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

app.listen(PORT, () => {
  console.log(`CP Tracker running at http://localhost:${PORT}`);
});
