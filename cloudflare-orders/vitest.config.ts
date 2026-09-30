import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          DZBUILD_CLIENT_ID: 'dzapp_0123456789abcdef0123',
          DZBUILD_CLIENT_SECRET: 'dzas_' + 'c'.repeat(48),
          DZBUILD_SIGNING_SECRET: 'a'.repeat(64),
          TELEGRAM_BOT_TOKEN: '123456789:test-token',
          TELEGRAM_CHAT_ID: '4242',
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
