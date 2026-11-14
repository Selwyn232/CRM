'use strict';
// API-routes voor de onboarding van gezinnen en kinderen (veldmedewerker → beoordeling → gezin + kinderen).

const path = require('node:path');
const { AppError } = require('./services');
const { makeService } = require('./onboarding');
const S = require('./services');

const id = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new AppError(400, 'Ongeldig id');
  return n;
};

function buildOnboardingRoutes({ db, uploadDir, guards, publicBase }) {
  const { field, staff } = guards;
  // Privémap naast de openbare uploads (op Render: /var/data/private). Nooit via /uploads bereikbaar.
  const privateDir = process.env.CRM_PRIVATE || path.join(path.dirname(path.resolve(uploadDir)), 'private');
  const O = makeService({ db, uploadDir, privateDir });
  const STATUSES = ['concept', 'ingediend', 'aanvulling_nodig', 'goedgekeurd', 'afgekeurd'];

  return [
    ['GET', '/api/onboarding', (ctx) => O.list(ctx.user, STATUSES.includes(ctx.query.status) ? ctx.query.status : null), field],
    ['POST', '/api/onboarding', (ctx) => O.create(ctx.user, ctx.body.data), field],
    ['GET', '/api/onboarding/config', () => {
      const { FILE_KINDS, ID_TYPES, CONSENT_TEXT } = require('./onboarding');
      return { veriff: require('./idcheck').isEnabled(), file_kinds: FILE_KINDS, id_types: ID_TYPES, consent_text: CONSENT_TEXT };
    }, field],
    ['GET', '/api/onboarding/files/:fid', (ctx) => O.readFile(id(ctx.params.fid), ctx.user), field],
    ['GET', '/api/onboarding/:id', (ctx) => O.get(id(ctx.params.id), ctx.user), field],
    ['PUT', '/api/onboarding/:id', (ctx) => O.save(id(ctx.params.id), ctx.user, ctx.body), field],
    ['DELETE', '/api/onboarding/:id', (ctx) => O.remove(id(ctx.params.id), ctx.user), field],
    ['POST', '/api/onboarding/:id/files', (ctx) => O.addFile(id(ctx.params.id), ctx.user, ctx.body), field],
    ['DELETE', '/api/onboarding/:id/files/:fid', (ctx) => O.deleteFile(id(ctx.params.id), id(ctx.params.fid), ctx.user), field],
    ['POST', '/api/onboarding/:id/veriff', (ctx) => O.startVeriff(id(ctx.params.id), ctx.user,
      `${publicBase(ctx)}/admin#/onboarding/${id(ctx.params.id)}`), field],
    ['POST', '/api/onboarding/:id/submit', (ctx) => O.submit(id(ctx.params.id), ctx.user), field],
    ['POST', '/api/onboarding/:id/review', (ctx) => O.review(id(ctx.params.id), ctx.user, ctx.body), staff],

    // Veriff stuurt de uitslag (decision webhook). Alleen met geldige HMAC-handtekening.
    ['POST', '/api/webhooks/veriff', (ctx) => {
      const V = require('./idcheck');
      if (!V.verifySignature(ctx.body.__raw, ctx.req.headers['x-hmac-signature'])) {
        S.audit(db, 'veriff', 'webhook_geweigerd', 'onboarding', null, 'ongeldige handtekening');
        throw new AppError(401, 'Ongeldige handtekening');
      }
      O.veriffDecision(ctx.body);
      return { ok: true };
    }],
  ];
}

module.exports = { buildOnboardingRoutes };
