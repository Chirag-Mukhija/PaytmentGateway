const express = require('express');
const auth = require('../middleware/auth');
const {
  createPaymentHandler,
  processPaymentHandler,
  getPaymentHandler,
  listPaymentsHandler,
} = require('../controllers/paymentController');

const router = express.Router();

router.use(auth); // every route below requires a valid merchant api key

router.post('/', createPaymentHandler);
router.post('/:id/process', processPaymentHandler);
router.get('/:id', getPaymentHandler);
router.get('/', listPaymentsHandler);

module.exports = router;
