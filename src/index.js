// entry point — loads env vars before anything else touches process.env
require('dotenv').config();

const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Payment gateway listening on port ${PORT}`);
});
