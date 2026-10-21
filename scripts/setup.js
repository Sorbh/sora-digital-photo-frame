// Runs after `npm install` at the repo root: creates server/.env on first install.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const serverDir = path.join(__dirname, '..', 'server');
const envPath = path.join(serverDir, '.env');
const examplePath = path.join(serverDir, '.env.example');

if (fs.existsSync(envPath)) {
  console.log('server/.env already exists - leaving it unchanged.');
  process.exit(0);
}

const env = fs.readFileSync(examplePath, 'utf8').replace(
  /^SESSION_SECRET=.*$/m,
  `SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`
);
fs.writeFileSync(envPath, env);

console.log('\nCreated server/.env with a random SESSION_SECRET.');
console.log('IMPORTANT: edit ADMIN_PASSWORD in server/.env before exposing the frame on your network.');
console.log('Then run `npm start` and open http://localhost:3000\n');
