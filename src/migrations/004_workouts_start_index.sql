ALTER TABLE workouts
  ADD KEY idx_w_start_user (start_time, user_id);
