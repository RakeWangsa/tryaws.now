-- WPU-X5: the limit of the balance adjustments that ONE admin may make without a second approval, for market
-- BD. Owner decision 2026-11-14: the owner is the only admin, and self-approval is forbidden, so with no limit
-- no adjustment could ever complete. One finance or superadmin may credit or debit up to 10,000 BDT =
-- 1,000,000 paisa per wallet per 24 hours (the window of packages/db/repositories/admin/wallets.ts counts what
-- posted without a second admin); above that a second admin is still required. The value is a whole number
-- of paisa as JSON text (R4: no float), the shape limitOf reads. Inserted only where no row exists, so a value
-- an admin or a later process set is never overwritten (DO NOTHING). Where the market row does not exist yet
-- (a fresh database: the launch seed runs after the migrations) nothing is written here and the launch seed
-- adds the same row and audit row. The audit row (actor system, R10) is written only together with the
-- inserted setting, in the same statement, with the action and target of the admin setting writes
-- (`setting.set`, `setting`, `<market>:<key>`). The limit changes only by a reviewed migration until an admin
-- screen exists. Forward-only and idempotent.
WITH inserted AS (
  INSERT INTO settings (id, key, market, scope, scope_id, value, set_by, created_at)
  SELECT gen_random_uuid(), 'wallet.adjustment_limit_minor', m.code, 'market', NULL, '"1000000"'::jsonb, NULL, now()
  FROM markets m
  WHERE m.code = 'BD'
  ON CONFLICT ON CONSTRAINT settings_key_market_scope_scope_id_unique DO NOTHING
  RETURNING market, key, value
)
INSERT INTO audit_log (id, actor_type, actor_id, action, target_type, target_id, ip, user_agent, metadata)
SELECT gen_random_uuid(), 'system', NULL, 'setting.set', 'setting', i.market || ':' || i.key, NULL, NULL,
  jsonb_build_object(
    'reason', 'owner decision 2026-11-14: single-admin adjustment limit 10,000 BDT',
    'before', NULL,
    'after', jsonb_build_object('value', i.value),
    'source', 'migration 0029_wallet_adjustment_limit_bd'
  )
FROM inserted i;
