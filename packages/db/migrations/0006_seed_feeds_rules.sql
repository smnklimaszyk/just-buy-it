-- Starting values of sections 3.2 and 3.3. Feeds start paused: the RAM and PC category IDs are
-- checked in live step L3, and `ops feeds resume` starts each feed. Later changes go through
-- `ops feeds set` and `ops rules set`, which write audit_event; this seed never overwrites them.
INSERT INTO app.feed (id, enabled, category_id, q, price_ceiling_cents, condition_ids, day_interval_s, night_interval_s, overflow_pages_per_day)
VALUES
  ('gpu', false, '27386', '(3090,4090,rtx3090,rtx4090)', 240000, '{1500,2500,3000}', 120, 600, 20),
  ('ram', false, '170083', '(ddr4,ddr5)', 120000, '{1500,2500,3000}', 120, 600, 20),
  ('pc', false, '179', '(4090,rtx4090)', 360000, '{1500,2500,3000}', 120, 600, 20)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO app.segment_rule (segment, feed_id, rule_kind, max_landed_cents, floor_cents, max_cents_per_gb, min_cents_per_gb, min_total_gb, sweep_q, candidate_cap_per_day, enabled, rule_version)
VALUES
  ('gpu_3090', 'gpu', 'per_item', 52000, 26000, NULL, NULL, NULL, '(3090,rtx3090)', 150, true, 1),
  ('gpu_3090ti', 'gpu', 'per_item', 60000, 30000, NULL, NULL, NULL, '3090', 150, true, 1),
  ('gpu_4090', 'gpu', 'per_item', 128000, 64000, NULL, NULL, NULL, '(4090,rtx4090)', 150, true, 1),
  ('ram_ddr4', 'ram', 'per_gb', NULL, NULL, 320, 160, 32, 'ddr4', 150, true, 1),
  ('ram_ddr5', 'ram', 'per_gb', NULL, NULL, 560, 280, 32, 'ddr5', 150, true, 1),
  ('pc_4090', 'pc', 'per_item', 192000, 96000, NULL, NULL, NULL, '(4090,rtx4090)', 150, true, 1)
ON CONFLICT (segment) DO NOTHING;
