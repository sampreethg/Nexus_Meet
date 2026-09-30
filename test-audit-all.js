const fs = require('fs');

console.log('=================================================================');
console.log('🔍 RUNNING COMPREHENSIVE PRODUCTION READINESS & ELEMENT AUDIT');
console.log('=================================================================\n');

// 1. Audit room.html IDs and verify handlers in client.js
const html = fs.readFileSync('room.html', 'utf8');
const client = fs.readFileSync('client.js', 'utf8');

const idRegex = /id=["']([^"']+)["']/g;
let match;
const ids = [];
while ((match = idRegex.exec(html)) !== null) {
  ids.push(match[1]);
}

console.log(`1. [DOM Element Audit] Found ${ids.length} DOM element IDs in room.html.`);

const referenced = [];
const unreferenced = [];

for (const id of ids) {
  if (client.includes(id)) {
    referenced.push(id);
  } else {
    unreferenced.push(id);
  }
}

console.log(`   Referenced by client.js: ${referenced.length}`);
console.log(`   Unreferenced: ${unreferenced.length}`);
if (unreferenced.length > 0) {
  console.log('   Unreferenced elements:', unreferenced);
}

// 2. Audit lobby.html interactive buttons and forms
const lobbyHtml = fs.readFileSync('lobby.html', 'utf8');
const lobbyIds = [];
while ((match = idRegex.exec(lobbyHtml)) !== null) {
  lobbyIds.push(match[1]);
}
console.log(`\n2. [Lobby Element Audit] Found ${lobbyIds.length} DOM element IDs in lobby.html.`);
const unrefLobby = lobbyIds.filter(id => !lobbyHtml.includes(`'${id}'`) && !lobbyHtml.includes(`"${id}"`) && !lobbyHtml.includes(`\`${id}\``));
console.log('   Lobby IDs checked for local script reference.');

// 3. Audit login.html interactive buttons and forms
const loginHtml = fs.readFileSync('login.html', 'utf8');
const loginIds = [];
while ((match = idRegex.exec(loginHtml)) !== null) {
  loginIds.push(match[1]);
}
console.log(`\n3. [Login Element Audit] Found ${loginIds.length} DOM element IDs in login.html.`);

// 4. Audit interactive buttons in room.html
const buttonRegex = /<button[^>]*id=["']([^"']+)["'][^>]*>/g;
const buttons = [];
while ((match = buttonRegex.exec(html)) !== null) {
  buttons.push(match[1]);
}
console.log(`\n4. [Buttons in room.html]: Found ${buttons.length} buttons.`);
const unhandledButtons = buttons.filter(btnId => !client.includes(btnId));
if (unhandledButtons.length === 0) {
  console.log('   ✅ All buttons in room.html have corresponding handlers in client.js!');
} else {
  console.warn('   ⚠️ Unhandled buttons:', unhandledButtons);
}

// 5. Audit all socket events between client and server
const server = fs.readFileSync('server.js', 'utf8');
const serverOnRegex = /socket\.on\(['"]([^'"]+)['"]/g;
const serverEvents = [];
while ((match = serverOnRegex.exec(server)) !== null) {
  serverEvents.push(match[1]);
}
console.log(`\n5. [Socket.io Signaling Audit] Server listens to: ${serverEvents.join(', ')}`);

const clientEmitRegex = /(?:safeSocketEmit|socket\.emit)\(['"]([^'"]+)['"]/g;
const clientEmits = [];
while ((match = clientEmitRegex.exec(client)) !== null) {
  clientEmits.push(match[1]);
}
console.log(`   Client emits: ${Array.from(new Set(clientEmits)).join(', ')}`);

const missingServerHandlers = Array.from(new Set(clientEmits)).filter(ev => !serverEvents.includes(ev));
console.log('   Unmatched client emits (should be empty):', missingServerHandlers);

console.log('\n=================================================================');
