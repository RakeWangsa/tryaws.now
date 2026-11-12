-- WPA-P1: prices are managed by an admin from the pricing panel, not by one migration for each change.
-- The base cost of a catalog row that no AWS API fills (the `disk` anchor of 0008, a price per GB) is
-- changed by an admin with a reason, through adminRepos.priceBook.setBaseCost: the repository allows
-- the families that the catalog sync never writes, and the write is audited (actor, reason, IP, target,
-- before and after). admin_rw gets the one column and nothing else of the table: it still cannot
-- insert a catalog row, deactivate one, or change the AWS facts of a synced row on its own. The margin
-- and the commission of a family live in `settings` (rows `price_book.<family>`), which admin_rw
-- already writes, and which web_rw and worker_rw already read, so they need no grant.
GRANT UPDATE (aws_price_usd) ON catalog_products TO admin_rw;
