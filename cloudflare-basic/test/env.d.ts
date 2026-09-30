declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
  }
  interface GlobalProps {
    mainModule: typeof import('../src/index');
  }
}
