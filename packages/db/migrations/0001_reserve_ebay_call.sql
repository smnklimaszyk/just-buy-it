-- Quota windows of one resource never overlap (ADR 0007). drizzle-kit cannot express EXCLUDE,
-- so the constraint lives here and the snapshot never knows about it.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
--> statement-breakpoint
ALTER TABLE app.ebay_quota_window
  ADD CONSTRAINT ebay_quota_window_no_overlap
  EXCLUDE USING gist (resource WITH =, tstzrange(window_start, window_end, '[)') WITH &&);
--> statement-breakpoint
-- Reserves one eBay call in the window that contains p_now and returns 'ok', or 'pool' when fewer
-- than p_min_left units would remain. Run it as one autocommit statement so the row lock is short.
CREATE FUNCTION app.reserve_ebay_call(
  p_resource text, p_class text, p_purpose text, p_min_left integer, p_now timestamptz
) RETURNS text
LANGUAGE plpgsql VOLATILE
SET search_path = ''
AS $$
DECLARE
  v_start    timestamptz;
  v_prev_end timestamptz;
  v_limit    integer;
  v_rows     integer;
BEGIN
  IF p_class IS NULL OR p_class NOT IN ('alert-path', 'standard') THEN
    RAISE EXCEPTION 'reserve_ebay_call: unknown class %', p_class;
  END IF;
  IF p_min_left IS NULL OR p_min_left < 0 THEN
    RAISE EXCEPTION 'reserve_ebay_call: min_left must be 0 or more';
  END IF;
  IF p_now IS NULL OR p_resource IS NULL OR p_purpose IS NULL THEN
    RAISE EXCEPTION 'reserve_ebay_call: resource, purpose and now are required';
  END IF;
  IF abs(extract(epoch FROM p_now - now())) > 300 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'EB001',
      MESSAGE = format('reserve_ebay_call: p_now %s is more than 300 s from the database clock', p_now);
  END IF;

  SELECT w.window_start INTO v_start
    FROM app.ebay_quota_window w
   WHERE w.resource = p_resource AND w.window_start <= p_now AND p_now < w.window_end
   ORDER BY w.window_start DESC
   LIMIT 1;

  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM app.ebay_quota_window w
                WHERE w.resource = p_resource AND w.window_start > p_now) THEN
      RAISE EXCEPTION 'reserve_ebay_call: % is before the newest quota window', p_now;
    END IF;
    SELECT w.window_end, w.limit_total INTO v_prev_end, v_limit
      FROM app.ebay_quota_window w
     WHERE w.resource = p_resource
     ORDER BY w.window_start DESC LIMIT 1;
    IF FOUND THEN
      v_start := v_prev_end
        + (floor(extract(epoch FROM p_now - v_prev_end) / 86400))::integer * interval '24 hours';
    ELSE
      v_start := date_trunc('day', p_now, 'UTC');
      v_limit := 5000;
    END IF;
    -- No conflict target: absorbs both the PK and the exclusion constraint when another caller won.
    INSERT INTO app.ebay_quota_window (resource, window_start, window_end, limit_total)
    VALUES (p_resource, v_start, v_start + interval '24 hours', v_limit)
    ON CONFLICT DO NOTHING;

    SELECT w.window_start INTO v_start
      FROM app.ebay_quota_window w
     WHERE w.resource = p_resource AND w.window_start <= p_now AND p_now < w.window_end
     ORDER BY w.window_start DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reserve_ebay_call: no quota window contains %', p_now;
    END IF;
  END IF;

  UPDATE app.ebay_quota_window w
     SET used            = w.used + 1,
         used_alert_path = w.used_alert_path + CASE WHEN p_class = 'alert-path' THEN 1 ELSE 0 END,
         used_standard   = w.used_standard   + CASE WHEN p_class = 'standard'   THEN 1 ELSE 0 END,
         updated_at      = now()
   WHERE w.resource = p_resource AND w.window_start = v_start
     AND w.limit_total - w.used - w.ebay_offset - 1 >= p_min_left;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN 'pool';
  END IF;

  INSERT INTO app.api_usage_hourly AS u (hour_utc, resource, purpose, calls)
  VALUES (date_trunc('hour', p_now, 'UTC'), p_resource, p_purpose, 1)
  ON CONFLICT (hour_utc, resource, purpose) DO UPDATE SET calls = u.calls + 1;
  RETURN 'ok';
END;
$$;
