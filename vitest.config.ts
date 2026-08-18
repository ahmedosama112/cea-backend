import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // الاختبارات بتشارك قاعدة بيانات واحدة (cea_test) — تشغيل تسلسلي بالكامل لتجنب التداخل
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
