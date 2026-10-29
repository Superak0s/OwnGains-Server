UPDATE metrics_events SET data = JSON_REPLACE(data, '$.user', NULL, '$.trainer', NULL) WHERE kind IN (0, 1, 2);
