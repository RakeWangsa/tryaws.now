-- WP5-T4: the scheduler purges old rate-limit windows as worker_rw. It may read the window start and
-- delete rows; it still cannot read the scope key (an HMAC of an address or a number), insert or update.
GRANT SELECT (window_start) ON rate_limits TO worker_rw;
--> statement-breakpoint
GRANT DELETE ON rate_limits TO worker_rw;
