// -------------------------
// BANKING API with JWT AUTH
// -------------------------
require("dotenv").config();
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cors = require("cors");

// -------------------------
// CONFIG
// -------------------------
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const JWT_EXPIRES_IN = "1h";

// -------------------------
// DATABASE SETUP
// -------------------------
const db = new sqlite3.Database("./bank.db");

db.serialize(async () => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    balance REAL DEFAULT 0
  )`);

  // create demo users if not exist
  const hash1 = await bcrypt.hash("password123", 10);
  const hash2 = await bcrypt.hash("hunter2", 10);
  db.run(`INSERT OR IGNORE INTO users (id, username, password, balance)
          VALUES (1, 'alice', ?, 1000)`, [hash1]);
  db.run(`INSERT OR IGNORE INTO users (id, username, password, balance)
          VALUES (2, 'bob', ?, 500)`, [hash2]);
});

// -------------------------
// HELPER FUNCTIONS
// -------------------------
function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Missing token" });
  const token = authHeader.split(" ")[1];
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid token" });
    req.user = decoded; // {id, username}
    next();
  });
}

function findUserByUsername(username) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM users WHERE username = ?", [username], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function findUserById(id) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function updateBalance(id, newBalance) {
  return new Promise((resolve, reject) => {
    db.run("UPDATE users SET balance = ? WHERE id = ?", [newBalance, id], err => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// -------------------------
// AUTH ROUTES
// -------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: "Username and password required" });

    const existing = await findUserByUsername(username);
    if (existing) return res.status(409).json({ error: "Username already exists" });

    const hashed = await bcrypt.hash(password, 10);
    db.run(
      "INSERT INTO users (username, password, balance) VALUES (?, ?, ?)",
      [username, hashed, 0],
      function (err) {
        if (err) return res.status(500).json({ error: "DB error" });
        const user = { id: this.lastID, username, balance: 0 };
        const token = signToken(user);
        res.json({ token, user });
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await findUserByUsername(username);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Invalid credentials" });

    const token = signToken(user);
    res.json({
      token,
      user: { id: user.id, username: user.username, balance: user.balance },
    });
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// -------------------------
// BANKING ROUTES (protected)
// -------------------------
app.get("/api/balance", authMiddleware, async (req, res) => {
  const user = await findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ balance: user.balance });
});

app.post("/api/deposit", authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0)
    return res.status(400).json({ error: "Invalid amount" });

  const user = await findUserById(req.user.id);
  const newBalance = user.balance + Number(amount);
  await updateBalance(user.id, newBalance);
  res.json({ balance: newBalance });
});

app.post("/api/withdraw", authMiddleware, async (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0)
    return res.status(400).json({ error: "Invalid amount" });

  const user = await findUserById(req.user.id);
  if (user.balance < amount)
    return res.status(400).json({ error: "Insufficient funds" });

  const newBalance = user.balance - Number(amount);
  await updateBalance(user.id, newBalance);
  res.json({ balance: newBalance });
});

app.post("/api/transfer", authMiddleware, async (req, res) => {
  const { toUsername, amount } = req.body;
  if (!toUsername || !amount || amount <= 0)
    return res.status(400).json({ error: "Invalid input" });

  const fromUser = await findUserById(req.user.id);
  const toUser = await findUserByUsername(toUsername);
  if (!toUser) return res.status(404).json({ error: "Recipient not found" });
  if (fromUser.balance < amount)
    return res.status(400).json({ error: "Insufficient funds" });

  const newFromBal = fromUser.balance - Number(amount);
  const newToBal = toUser.balance + Number(amount);

  await updateBalance(fromUser.id, newFromBal);
  await updateBalance(toUser.id, newToBal);

  res.json({ fromBalance: newFromBal, toBalance: newToBal });
});

// -------------------------
// SERVER START
// -------------------------
app.get("/", (req, res) => res.send("JWT Banking API Running..."));
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
