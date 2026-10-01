const { PrismaClient } = require('@prisma/client');

async function testLocalUsernames() {
  const users = ['sampreeth', 'postgres', 'root'];
  const passwords = ['sampreeth', 'Hackathon@20', 'postgres', 'password', ''];
  for (const u of users) {
    for (const pw of passwords) {
      const encPw = encodeURIComponent(pw);
      const url = `postgresql://${u}:${encPw}@127.0.0.1:5432/postgres`;
      const p = new PrismaClient({ datasources: { db: { url } } });
      try {
        await p.$connect();
        console.log(`✅ SUCCESS! Connected with user: ${u}, password: ${pw}`);
        await p.$disconnect();
        return;
      } catch (e) {
        // failed
        try { await p.$disconnect(); } catch (_) {}
      }
    }
  }
  console.log('No matching username/password found for local postgres.');
}

testLocalUsernames();
