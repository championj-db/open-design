import type { AuthSessionResponse } from '@open-design/contracts';
import type { Express } from 'express';

import type { DaemonAuthMode } from '../databricks/auth-mode.js';
import { databricksRequestContext } from '../databricks/request-context.js';

// `GET /api/auth/session` — who the daemon says the caller is. The web shell
// reads it to show the signed-in Databricks user in place of the Cloud
// sign-in entry points; `od auth whoami` prints the same payload.
export function registerAuthSessionRoutes(app: Express, { authMode }: { authMode: DaemonAuthMode }): void {
  app.get('/api/auth/session', (req, res) => {
    const body: AuthSessionResponse = {
      provider: authMode,
      user: authMode === 'databricks' ? (databricksRequestContext(req)?.user ?? null) : null,
    };
    // Per-caller answer: never let a shared cache hand one user's identity to another.
    res.setHeader('Cache-Control', 'no-store');
    res.json(body);
  });
}
