// Run this once to turn a plain-text password into a bcrypt hash for your .env file.
// Usage:  node hash-password.js "YourStrongPassword123!"

const bcrypt = require("bcryptjs");

const plainPassword = process.argv[2];

if (!plainPassword) {
  console.error("Usage: node hash-password.js \"YourPassword\"");
  process.exit(1);
}

const saltRounds = 12;
const hash = bcrypt.hashSync(plainPassword, saltRounds);

console.log("\nPaste this into your .env file as ACCOUNT_PASSWORD_HASH:\n");
console.log(hash);
console.log("");
