const { PrismaClient } = require('@prisma/client');

async function testConnection() {
  const url = 'postgresql://postgres:Hackathon%4020@db.tuofavwggkhvjpplmpsl.supabase.co:5432/postgres';
  const prisma = new PrismaClient({ datasources: { db: { url } } });

  console.log('Testing connection to Supabase PostgreSQL at db.tuofavwggkhvjpplmpsl.supabase.co...');
  try {
    await prisma.$connect();
    console.log('✅ PostgreSQL successfully connected via percent-encoded URI!');
    const usersCount = await prisma.user.count();
    console.log(`✅ Database query successful! Total registered users: ${usersCount}`);
    await prisma.$disconnect();
    return true;
  } catch (err) {
    console.error('❌ Database connection error:', err.message);
    try { await prisma.$disconnect(); } catch (_) {}
    return false;
  }
}

testConnection();
