function requestLogger(req, res, next) {
  const start = Date.now();

  // status code isn't known until the response is actually sent, so we
  // log on 'finish' rather than here — next() runs immediately either way
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
  });

  next();
}

module.exports = requestLogger;


// this is to log each and every process (state) to terminal and how much time it took . 