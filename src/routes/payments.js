const express = require('express');
const auth = require('../middleware/auth');
const {
  createPaymentHandler,
  getPaymentHandler,
  listPaymentsHandler,
} = require('../controllers/paymentController');

const router = express.Router();

router.use(auth); // every route below requires a valid merchant api key
// this auth middleware checks x-api-key for valid merchant or not 
router.post('/', createPaymentHandler);
router.get('/:id', getPaymentHandler);
router.get('/', listPaymentsHandler);

module.exports = router;
