-- Local development seed, loaded by docker-compose on the FIRST start of an
-- empty Postgres volume (after schema.sql). Fixed, well-known credentials
-- so the smoke test and merchant-mock work out of the box.
--
-- NEVER load this outside local development: these keys are public, they
-- are committed to the repository.
INSERT INTO merchants (name, email, api_key, webhook_url, webhook_secret)
VALUES
    ('Test Merchant', 'merchant@test.com',
     'dev_test_key_merchant_1',
     'http://merchant-mock:4000/webhook',
     'dev_webhook_secret_merchant_1'),
    ('Second Merchant', 'second@test.com',
     'dev_test_key_merchant_2',
     'http://merchant-mock:4000/webhook',
     'dev_webhook_secret_merchant_2')
ON CONFLICT (email) DO NOTHING;
