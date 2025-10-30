// server.js
// -----------------------------
// Transactional Banking API
// Experiment 6.3 — rollback capability (single-file)
// -----------------------------
require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';
const JWT_EXPIRES_IN = '1h';

// -----------------------------
// Open DB
// -----------------------------
const db = new sqlite3.Database('./bank_tx.db', (err) => {
  if (err) return console.error('DB open error', err);
  console.log('Opened bank_tx.db');
});

// Promisified helpers
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this); // caller can use lastID, changes
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}
function execAsync(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// -----------------------------
// Initialize schema + demo users
// -----------------------------
async function initDb() {
  // Use serialize to avoid concurrency during init
  db.serialize(async () => {
    try {
      await execAsync(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          balance REAL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,        -- 'deposit', 'withdraw', 'transfer'
          from_user INTEGER,         -- nullable
          to_user INTEGER,           -- nullable
          amount REAL NOT NULL,
          status TEXT NOT NULL,      -- 'committed' or 'rolledback'
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          note TEXT,
          FOREIGN KEY(from_user) REFERENCES users(id),
          FOREIGN KEY(to_user) REFERENCES users(id)
        );
      `);

      // create demo users if not exist
      const aliceHash = await bcrypt.hash('password123', 10);
      const bobHash = await bcrypt.hash('hunter2', 10);

      await runAsync(
        `INSERT OR IGNORE INTO users (id, username, password, balance) VALUES (1, 'alice', ?, 1000)`,
        [aliceHash]
      );
      await runAsync(
        `INSERT OR IGNORE INTO users (id, username, password, balance) VALUES (2, 'bob', ?, 500)`,
        [bobHash]
      );

      console.log('DB initialized (users + transactions)');
    } catch (err) {
      console.error('DB init error', err);
    }
  });
}
initDb().catch(console.error);

// -----------------------------
// Auth utils (JWT)
// -----------------------------
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'Missing Authorization header' });
  const parts = auth.split(' ');
  if (parts.length !== 2) return res.status(401).json({ error: 'Invalid Authorization header' });
  const token = parts[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

// -----------------------------
// DB helpers
// -----------------------------
async function findUserByUsername(username) {
  return getAsync('SELECT * FROM users WHERE username = ?', [username]);
}
async function findUserById(id) {
  return getAsync('SELECT * FROM users WHERE id = ?', [id]);
}
async function updateBalance(id, newBalance) {
  return runAsync('UPDATE users SET balance = ? WHERE id = ?', [newBalance, id]);
}
async function insertTransactionRecord(tx) {
  // tx: { type, from_user, to_user, amount, status, note }
  const res = await runAsync(
    `INSERT INTO transactions (type, from_user, to_user, amount, status, note) VALUES (?, ?, ?, ?, ?, ?)`,
    [tx.type, tx.from_user || null, tx.to_user || null, tx.amount, tx.status, tx.note || null]
  );
  return res.lastID;
}

// -----------------------------
// AUTH ROUTES
// -----------------------------
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'username & password required' });

    const existing = await findUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'username taken' });

    const hashed = await bcrypt.hash(password, 10);
    const result = await runAsync('INSERT INTO users (username, password, balance) VALUES (?, ?, ?)', [
      username,
      hashed,
      0,
    ]);
    const user = { id: result.lastID, username, balance: 0 };
    const token = signToken(user);
    res.json({ token, user });
  } catch (err) {
    console.error('register error', err);
    res.status(500).json({ error: 'server error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await findUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const token = signToken(user);
    res.json({ token, user: { id: user.id, username: user.username, balance: user.balance } });
  } catch (err) {
    console.error('login error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// -----------------------------
// Simple (non-transactional) endpoints for convenience
// -----------------------------
app.get('/api/balance', authMiddleware, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ balance: user.balance });
  } catch (err) {
    console.error('balance error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// -----------------------------
// TRANSACTIONAL TRANSFER ENDPOINT
// Uses explicit BEGIN/COMMIT/ROLLBACK to ensure atomicity.
// -----------------------------
/*
  POST /api/transfer
  body: { toUsername: string, amount: number }
  Requires auth.
*/
app.post('/api/transfer', authMiddleware, async (req, res) => {
  const fromUserId = req.user.id;
  const { toUsername, amount } = req.body;

  if (!toUsername || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  // We'll manually manage transaction using exec/ run sequence.
  // Steps:
  // 1. BEGIN TRANSACTION
  // 2. SELECT balances for both users (FOR UPDATE not available - SQLite uses DB lock)
  // 3. Check sufficient funds
  // 4. UPDATE balances
  // 5. INSERT transaction history with status 'committed'
  // 6. COMMIT
  // On any error -> ROLLBACK and insert transaction with status 'rolledback' (optional)

  try {
    const toUser = await findUserByUsername(toUsername);
    if (!toUser) return res.status(404).json({ error: 'Recipient not found' });

    // Start transaction
    await execAsync('BEGIN TRANSACTION;');

    // Re-read users inside transaction to ensure consistent balances
    const fromUser = await getAsync('SELECT * FROM users WHERE id = ?', [fromUserId]);
    const freshToUser = await getAsync('SELECT * FROM users WHERE id = ?', [toUser.id]);

    if (!fromUser) {
      await execAsync('ROLLBACK;');
      return res.status(404).json({ error: 'Sender not found' });
    }
    if (fromUser.balance < amount) {
      // rollback and record a rolledback transaction row
      await insertTransactionRecord({
        type: 'transfer',
        from_user: fromUserId,
        to_user: toUser.id,
        amount,
        status: 'rolledback',
        note: 'insufficient funds'
      });
      await execAsync('ROLLBACK;');
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const newFromBal = Number(fromUser.balance) - Number(amount);
    const newToBal = Number(freshToUser.balance) + Number(amount);

    // Update balances
    await runAsync('UPDATE users SET balance = ? WHERE id = ?', [newFromBal, fromUser.id]);
    await runAsync('UPDATE users SET balance = ? WHERE id = ?', [newToBal, freshToUser.id]);

    // record transaction as committed
    await insertTransactionRecord({
      type: 'transfer',
      from_user: fromUser.id,
      to_user: freshToUser.id,
      amount,
      status: 'committed',
      note: `transfer ${amount} from ${fromUser.username} to ${freshToUser.username}`
    });

    // commit
    await execAsync('COMMIT;');

    res.json({ fromBalance: newFromBal, toBalance: newToBal });
  } catch (err) {
    console.error('transfer error, attempting rollback', err);
    try {
      await execAsync('ROLLBACK;');
      // record rollback transaction (best-effort)
      try {
        await insertTransactionRecord({
          type: 'transfer',
          from_user: fromUserId,
          to_user: null,
          amount: amount,
          status: 'rolledback',
          note: `error: ${err.message}`
        });
      } catch (recErr) {
        console.error('failed to insert rollback record', recErr);
      }
    } catch (rbErr) {
      console.error('rollback failed', rbErr);
    }
    res.status(500).json({ error: 'Transfer failed, rolled back' });
  }
});

// -----------------------------
// DEMONSTRATION: Transfer with simulated failure
// Endpoint to show rollback in case of mid-transaction failure.
// POST /api/transfer-fail
// body: { toUsername, amount }
// This endpoint will purposely throw after debiting sender (before crediting recipient) to show rollback.
// -----------------------------
app.post('/api/transfer-fail', authMiddleware, async (req, res) => {
  const fromUserId = req.user.id;
  const { toUsername, amount } = req.body;

  if (!toUsername || !amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Invalid input' });
  }

  try {
    const toUser = await findUserByUsername(toUsername);
    if (!toUser) return res.status(404).json({ error: 'Recipient not found' });

    await execAsync('BEGIN TRANSACTION;');

    const fromUser = await getAsync('SELECT * FROM users WHERE id = ?', [fromUserId]);
    if (!fromUser) {
      await execAsync('ROLLBACK;');
      return res.status(404).json({ error: 'Sender not found' });
    }
    if (fromUser.balance < amount) {
      await insertTransactionRecord({
        type: 'transfer',
        from_user: fromUserId,
        to_user: toUser.id,
        amount,
        status: 'rolledback',
        note: 'insufficient funds (fail demo)'
      });
      await execAsync('ROLLBACK;');
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const newFromBal = Number(fromUser.balance) - Number(amount);
    await runAsync('UPDATE users SET balance = ? WHERE id = ?', [newFromBal, fromUser.id]);

    // insert a partially-completed transaction record (status pending) - optional
    await runAsync(`INSERT INTO transactions (type, from_user, to_user, amount, status, note)
                    VALUES (?, ?, ?, ?, ?, ?)`,
      ['transfer', fromUser.id, toUser.id, amount, 'rolledback', 'simulated failure mid-transaction']);

    // Simulate crash/failure
    throw new Error('Simulated mid-transaction failure — testing rollback');

    // commit (never reached)
    // await execAsync('COMMIT;');

  } catch (err) {
    console.error('simulated transfer error -> rolling back', err.message);
    try {
      await execAsync('ROLLBACK;');
    } catch (rbErr) {
      console.error('rollback error', rbErr);
    }
    return res.status(500).json({ error: 'Simulated failure occurred — transaction rolled back' });
  }
});

// -----------------------------
// DEPOSIT / WITHDRAW — done inside transactions too (example)
// POST /api/deposit-tx { amount }
// POST /api/withdraw-tx { amount }
// -----------------------------
app.post('/api/deposit-tx', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const { amount } = req.body;
  if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    await execAsync('BEGIN TRANSACTION;');

    const user = await getAsync('SELECT * FROM users WHERE id = ?', [uid]);
    if (!user) {
      await execAsync('ROLLBACK;');
      return res.status(404).json({ error: 'User not found' });
    }

    const newBal = Number(user.balance) + Number(amount);
    await runAsync('UPDATE users SET balance = ? WHERE id = ?', [newBal, uid]);

    await insertTransactionRecord({
      type: 'deposit',
      from_user: null,
      to_user: uid,
      amount,
      status: 'committed',
      note: 'deposit via deposit-tx'
    });

    await execAsync('COMMIT;');
    res.json({ balance: newBal });
  } catch (err) {
    console.error('deposit-tx error', err);
    try { await execAsync('ROLLBACK;'); } catch (e) { console.error('rollback failed', e); }
    res.status(500).json({ error: 'Deposit failed, rolled back' });
  }
});

app.post('/api/withdraw-tx', authMiddleware, async (req, res) => {
  const uid = req.user.id;
  const { amount } = req.body;
  if (!amount || isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });

  try {
    await execAsync('BEGIN TRANSACTION;');

    const user = await getAsync('SELECT * FROM users WHERE id = ?', [uid]);
    if (!user) {
      await execAsync('ROLLBACK;');
      return res.status(404).json({ error: 'User not found' });
    }
    if (user.balance < amount) {
      await insertTransactionRecord({
        type: 'withdraw',
        from_user: uid,
        to_user: null,
        amount,
        status: 'rolledback',
        note: 'insufficient funds for withdraw'
      });
      await execAsync('ROLLBACK;');
      return res.status(400).json({ error: 'Insufficient funds' });
    }

    const newBal = Number(user.balance) - Number(amount);
    await runAsync('UPDATE users SET balance = ? WHERE id = ?', [newBal, uid]);
    await insertTransactionRecord({
      type: 'withdraw',
      from_user: uid,
      to_user: null,
      amount,
      status: 'committed',
      note: 'withdraw via withdraw-tx'
    });

    await execAsync('COMMIT;');
    res.json({ balance: newBal });
  } catch (err) {
    console.error('withdraw-tx error', err);
    try { await execAsync('ROLLBACK;'); } catch (e) { console.error('rollback failed', e); }
    res.status(500).json({ error: 'Withdraw failed, rolled back' });
  }
});

// -----------------------------
// Endpoint: list transactions (admin/user view)
// GET /api/transactions?userId=
// -----------------------------
app.get('/api/transactions', authMiddleware, async (req, res) => {
  // optional query param userId to filter; by default show all (simple demo)
  const userId = req.query.userId;
  try {
    if (userId) {
      const rows = await allAsync(
        `SELECT t.*, u1.username as from_username, u2.username as to_username
         FROM transactions t
         LEFT JOIN users u1 ON t.from_user = u1.id
         LEFT JOIN users u2 ON t.to_user = u2.id
         WHERE t.from_user = ? OR t.to_user = ?
         ORDER BY t.created_at DESC`,
        [userId, userId]
      );
      return res.json(rows);
    } else {
      const rows = await allAsync(
        `SELECT t.*, u1.username as from_username, u2.username as to_username
         FROM transactions t
         LEFT JOIN users u1 ON t.from_user = u1.id
         LEFT JOIN users u2 ON t.to_user = u2.id
         ORDER BY t.created_at DESC`
      );
      return res.json(rows);
    }
  } catch (err) {
    console.error('transactions list error', err);
    res.status(500).json({ error: 'server error' });
  }
});

// -----------------------------
// Quick admin/users listing (convenience)
// GET /api/users
// -----------------------------
app.get('/api/users', async (req, res) => {
  try {
    const users = await allAsync('SELECT id, username, balance FROM users');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

// -----------------------------
// Root + start server
// -----------------------------
app.get('/', (req, res) => res.send('Transactional Banking API (with rollback) running.'));
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
