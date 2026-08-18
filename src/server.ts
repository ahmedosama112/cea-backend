import fs from 'fs';
import { app } from './app';
import { env } from './config/env';
import { prisma } from './config/prisma';

fs.mkdirSync(env.uploadDir, { recursive: true });

const server = app.listen(env.port, () => {
  console.log(`CEA API listening on port ${env.port} [${env.nodeEnv}]`);
});

async function shutdown(signal: string) {
  console.log(`${signal} received — shutting down gracefully`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
