'use strict';
function createPaymentRoutes({ loadReview = require('./qbo-payment-service').loadPaymentReview } = {}) {
  return async function handleQboPaymentRoute({ req, res, url, handleApi, requirePermission }) {
    if (!url.pathname.startsWith('/api/automation/qbo-payments')) return false;
    await handleApi(res, async () => {
      await requirePermission(req, 'automation.read');
      if (url.pathname !== '/api/automation/qbo-payments/review') throw Object.assign(new Error('Payment route not found.'), { statusCode: 404 });
      if (req.method !== 'GET') throw Object.assign(new Error('Payments are read-only in this milestone.'), { statusCode: 405 });
      try { return await loadReview({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), limit: url.searchParams.get('limit') }); }
      catch (error) {
        if ([400, 409].includes(error.statusCode)) throw error;
        // Connection errors can contain private infrastructure identifiers.
        throw Object.assign(new Error('Payment comparison is unavailable. Verify the source database, app database and protected QuickBooks connection on the service host.'), { statusCode: 503 });
      }
    });
    return true;
  };
}
module.exports = { createPaymentRoutes, handleQboPaymentRoute: createPaymentRoutes() };
