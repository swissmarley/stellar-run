import './styles.css';
import { App } from './app.ts';

const app = new App();
// Read-only introspection plus a kill switch for automated tests and the bench (no gameplay effect otherwise).
(window as unknown as { __stellar: unknown }).__stellar = app.debugApi();

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    /* offline support is optional */
  });
}
