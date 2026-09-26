const express = require('express');
const auth = require('../middleware/auth');
const {
  createPaymentHandler,
  processPaymentHandler,
  getPaymentHandler,
  listPaymentsHandler,
} = require('../controllers/paymentController');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(auth); // every route below requires a valid merchant api key

// A non-UUID :id can't match any payment, so it's a 404 -- and catching it
// here stops Postgres from throwing "invalid input syntax for type uuid",
// which would otherwise surface as a 500.
router.param('id', (req, res, next, id) => {
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'Payment not found' });
  next();
});

router.post('/', createPaymentHandler);
router.post('/:id/process', processPaymentHandler);
router.get('/:id', getPaymentHandler);
router.get('/', listPaymentsHandler);

module.exports = router;
